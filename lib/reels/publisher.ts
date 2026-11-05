/**
 * Publishes the owner's finished reels to the feed from a queue folder in
 * OpenCloud, one a day, at a random time inside the daily window. Trial reels
 * only reach non-followers (lib/trials); these are ordinary posts.
 *
 * Layout (REEL_FOLDER, default "Animados"): one subfolder per reel, published in
 * name order, holding one .mp4, caption.txt and, optionally, reel.json:
 *
 *   Animados/1 LEGAL/LEGAL_animado.mp4
 *   Animados/1 LEGAL/caption.txt
 *   Animados/1 LEGAL/reel.json   {"campana": "Legal checklist", "portada_ms": 1300}
 *
 * "campana" is the existing OpenReply campaign of the reel this one recycles:
 * it is copied and bound to the new post as "[ANIM] <name>", the way trials
 * copy theirs, so the comments get the same answer and resource. Its links
 * have to answer before anything goes out; a reel waiting on its page is
 * skipped and reported, and the next one goes instead. "portada_ms" picks the
 * cover frame. A reel with no reel.json goes out with no campaign.
 *
 * Done folders get the owner's mark, "Z - " in front of the name, and are
 * skipped, as are names starting with "_" (a video Instagram refused leaves its
 * folder as "_ERROR <name>"; a run that died mid-publish, as "_REVISAR <name>").
 * Nothing is ever published twice: a run that dies after publishing is finished
 * by the next.
 *
 * Off unless REEL_PUBLISH_ENABLED=true. Shares OpenCloud, the staging bucket and
 * the Instagram account with the trial publisher.
 */

import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { duplicateCampaign } from "@/lib/campaigns/duplicate";
import { addDays, brokenLinks, isDoneFolder } from "@/lib/carousels/publisher";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getRedisConnection } from "@/lib/queue/client";
import {
  MetaApiError,
  createReelContainer,
  getMediaContainerStatus,
  getMediaPermalink,
  getUserMedia,
  publishMediaContainer,
} from "@/lib/meta/client";
import { OpenCloudClient, type DavEntry } from "@/lib/trials/opencloud";
import { localDay, planDaySlots } from "@/lib/trials/publisher";
import { stageVideo, type StagedVideo } from "@/lib/trials/staging";

const CAPTION_FILES = ["caption.txt", "texto.txt"];
const SETTINGS_FILE = "reel.json";
const DONE_PREFIX = "Z - ";
const REVIEW_PREFIX = "_REVISAR ";
const ERROR_PREFIX = "_ERROR ";
const CAMPAIGN_TAG = "ANIM";
const VIDEO_RE = /\.(mp4|mov)$/i;
const MAX_CAPTION_LENGTH = 2200;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const CONTAINER_TIMEOUT_MS = 15 * 60_000;
const CONTAINER_POLL_MS = 5_000;

const LOCK_KEY = "reel:lock";
const INFLIGHT_KEY = "reel:inflight";
const NEXT_KEY = "reel:next";
const PUBLISHED_KEY = "reel:published";

export interface ReelPublisherConfig {
  enabled: boolean;
  everyDays: number;
  startHour: number;
  endHour: number;
  timeZone: string;
  folder: string;
  /** First day to publish on (YYYY-MM-DD); today when empty. */
  startDay: string | null;
  /** Minutes to hold back after any post on the account, ours or the owner's. */
  ownPostWaitMinutes: number;
}

export function reelPublisherConfig(env: NodeJS.ProcessEnv = process.env): ReelPublisherConfig {
  let [startHour, endHour] = (env.REEL_PUBLISH_HOURS ?? "11-21").split("-").map(Number);
  if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) [startHour, endHour] = [11, 21];
  const everyDays = Number(env.REEL_EVERY_DAYS ?? 1);
  const ownPostWaitMinutes = Number(env.REEL_OWN_POST_WAIT_MINUTES ?? env.TRIAL_OWN_POST_WAIT_MINUTES ?? 90);
  const startDay = env.REEL_START_DAY?.trim();
  return {
    enabled: env.REEL_PUBLISH_ENABLED === "true",
    everyDays: everyDays > 0 ? everyDays : 1,
    startHour,
    endHour,
    timeZone: env.REEL_PUBLISH_TIMEZONE ?? env.TRIAL_PUBLISH_TIMEZONE ?? "America/Montevideo",
    folder: (env.REEL_FOLDER ?? "Animados").replace(/^\/+|\/+$/g, ""),
    startDay: startDay && /^\d{4}-\d{2}-\d{2}$/.test(startDay) ? startDay : null,
    ownPostWaitMinutes: ownPostWaitMinutes >= 0 ? ownPostWaitMinutes : 90,
  };
}

/** Campaign name for a copy: "[ANIM] Costo", then "[ANIM2] Costo" if it comes back. */
export function reelCampaignName(names: string[], base: string): string {
  const escaped = base.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\[${CAMPAIGN_TAG}(\\d*)\\]\\s*${escaped}$`, "i");
  let highest = 0;
  for (const name of names) {
    const match = name.trim().match(pattern);
    if (match) highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }
  return `[${CAMPAIGN_TAG}${highest ? highest + 1 : ""}] ${base.trim()}`;
}

function slotOn(day: string, config: ReelPublisherConfig): string {
  return planDaySlots(day, { ...config, perDay: 1 })[0];
}

/** When the next reel is due; planned (and stored) the first time it is asked. */
async function nextDue(redis: Redis, now: Date, config: ReelPublisherConfig): Promise<Date> {
  const stored = await redis.get(NEXT_KEY);
  if (stored) return new Date(stored);
  const today = localDay(now, config.timeZone);
  const first = slotOn(config.startDay && config.startDay > today ? config.startDay : today, config);
  await redis.set(NEXT_KEY, first);
  return new Date(first);
}

// A ping to the owner's phone (ntfy, NTFY_TOPIC). Never throws.
async function notify(body: { title: string; message: string; tags?: string[]; click?: string }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const response = await fetch(process.env.NTFY_URL ?? "https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.log(`[Reel publisher] ntfy ping failed: HTTP ${response.status}`);
  } catch (error) {
    console.log("[Reel publisher] ntfy ping failed:", errorMessage(error));
  }
}

// The same problem is reported at most once a day.
async function warnOnce(redis: Redis, key: string, title: string, message: string) {
  console.log(`[Reel publisher] ${title}: ${message}`);
  const fresh = await redis.set(`reel:warned:${key}`, "1", "EX", 86400, "NX");
  if (fresh) await notify({ title, message, tags: ["warning"] });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Account = {
  id: string;
  workspaceId: string;
  instagramId: string;
  accessToken: string;
};

type Candidate = {
  folder: DavEntry;
  video: DavEntry;
  caption: string;
  campaign: { id: string; name: string } | null;
  coverMs: number | undefined;
};

type Settings = { campaign: string | null; coverMs: number | undefined };

async function readSettings(cloud: OpenCloudClient, folder: DavEntry): Promise<Settings | { error: string }> {
  const raw = (await cloud.readText(`${folder.path}/${SETTINGS_FILE}`))?.trim();
  if (!raw) return { campaign: null, coverMs: undefined };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      campaign: typeof data.campana === "string" && data.campana.trim() ? data.campana.trim() : null,
      coverMs: typeof data.portada_ms === "number" && data.portada_ms >= 0 ? data.portada_ms : undefined,
    };
  } catch {
    return { error: `${SETTINGS_FILE} no es un JSON válido` };
  }
}

async function readCaption(cloud: OpenCloudClient, folder: DavEntry): Promise<string | null> {
  for (const name of CAPTION_FILES) {
    const text = (await cloud.readText(`${folder.path}/${name}`))?.trim();
    if (text) return text;
  }
  return null;
}

function queueFolders(entries: DavEntry[]): DavEntry[] {
  return entries
    .filter((entry) => entry.isDir && !entry.name.startsWith("_") && !isDoneFolder(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * The next reel to publish: the first folder by name that is ready. Folders
 * that cannot go yet (no video, no caption, campaign missing, resource page
 * down) are reported and skipped.
 */
async function pickCandidate(
  cloud: OpenCloudClient,
  redis: Redis,
  config: ReelPublisherConfig,
  account: Account
): Promise<Candidate | null> {
  for (const folder of queueFolders(await cloud.list(config.folder))) {
    if (await redis.hexists(PUBLISHED_KEY, folder.path)) continue;
    const warn = (key: string, title: string, message: string) =>
      warnOnce(redis, `${key}:${folder.name}`, `Reel "${folder.name}": ${title}`, message);

    const videos = (await cloud.list(folder.path)).filter((entry) => !entry.isDir && VIDEO_RE.test(entry.name));
    if (videos.length !== 1) {
      await warn("video", `tiene ${videos.length} videos`, `Tiene que haber uno solo en ${folder.path}. Lo salteo.`);
      continue;
    }
    if (videos[0].size > MAX_VIDEO_BYTES) {
      await warn("size", "video muy pesado", `Pesa ${Math.round(videos[0].size / 1024 / 1024)} MB; Instagram acepta hasta 300 MB.`);
      continue;
    }
    const caption = await readCaption(cloud, folder);
    if (!caption) {
      await warn("caption", "falta el texto", `Poné caption.txt con el texto en ${folder.path}.`);
      continue;
    }
    if (caption.length > MAX_CAPTION_LENGTH) {
      await warn("caption-long", "texto muy largo",
        `Instagram acepta hasta ${MAX_CAPTION_LENGTH} caracteres y tiene ${caption.length}.`);
      continue;
    }

    const settings = await readSettings(cloud, folder);
    if ("error" in settings) {
      await warn("settings", `revisá ${SETTINGS_FILE}`, settings.error);
      continue;
    }
    let campaign: Candidate["campaign"] = null;
    if (settings.campaign) {
      const found = await prisma.automation.findFirst({
        where: { instagramAccountId: account.id, name: { equals: settings.campaign, mode: "insensitive" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, trackedLinks: { select: { destinationUrl: true } } },
      });
      if (!found) {
        await warn("campaign", `no encuentro la campaña "${settings.campaign}"`,
          `Se copia de una campaña que ya existe: fijate el nombre en ${SETTINGS_FILE}.`);
        continue;
      }
      const broken = await brokenLinks(found.trackedLinks.map((link) => link.destinationUrl));
      if (broken.length) {
        await warn("link", "el recurso no está publicado",
          `${broken.join(", ")} no responde. No lo publico hasta que la página esté arriba.`);
        continue;
      }
      campaign = { id: found.id, name: found.name };
    }
    return { folder, video: videos[0], caption, campaign, coverMs: settings.coverMs };
  }
  return null;
}

class ContainerError extends Error {}

async function waitForContainer(
  accessToken: string,
  containerId: string,
  sleep: (ms: number) => Promise<void>
) {
  const deadline = Date.now() + CONTAINER_TIMEOUT_MS;
  for (;;) {
    const { status_code: code, status } = await getMediaContainerStatus(accessToken, containerId);
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new ContainerError(`Instagram no pudo procesar el video (${code}${status ? `: ${status}` : ""})`);
    }
    if (Date.now() > deadline) throw new Error("Instagram tardó más de 15 minutos en procesar el video");
    await sleep(CONTAINER_POLL_MS);
  }
}

type InFlight = {
  folderPath: string;
  folderName: string;
  campaignId: string | null;
  campaignName: string | null;
  workspaceId: string;
  instagramAccountId: string;
  containerId?: string;
  mediaId?: string;
};

export type ReelRunResult =
  | { status: "disabled" | "waiting" | "busy" | "empty" }
  | { status: "dry-run"; folder: string; video: string; campaign: string | null; caption: string; next: string }
  | { status: "published"; folder: string; campaign: string | null; permalink: string | null; next: string }
  | { status: "failed"; folder: string; error: string }
  | { status: "review"; folder: string };

/** The copy of the base campaign bound to the new post. Safe to run again. */
async function bindCampaign(state: InFlight & { mediaId: string }, permalink: string | null): Promise<string | null> {
  if (!state.campaignId || !state.campaignName) return null;
  const existing = await prisma.automation.findFirst({ where: { postId: state.mediaId } });
  if (existing) return existing.name;
  const copy = await duplicateCampaign({ automationId: state.campaignId, workspaceId: state.workspaceId });
  if (!copy) throw new Error(`la campaña "${state.campaignName}" ya no existe`);
  const names = await prisma.automation.findMany({
    where: { instagramAccountId: state.instagramAccountId },
    select: { name: true },
  });
  const name = reelCampaignName(names.map((n) => n.name), state.campaignName);
  await prisma.automation.update({
    where: { id: copy.id },
    data: { name, isActive: true, postId: state.mediaId, postUrl: permalink, pendingNextReel: false, matchAnyPost: false },
  });
  return name;
}

/**
 * Bookkeeping once a reel is out: mark the folder, bind the campaign, plan the
 * next one, tell the owner. Safe to run again for the same reel.
 */
async function finishPublished(
  cloud: OpenCloudClient,
  redis: Redis,
  accessToken: string,
  config: ReelPublisherConfig,
  now: Date,
  state: InFlight & { mediaId: string }
): Promise<ReelRunResult> {
  const problems: string[] = [];
  await redis.hset(PUBLISHED_KEY, state.folderPath, state.mediaId);
  const next = slotOn(addDays(localDay(now, config.timeZone), config.everyDays), config);
  await redis.set(NEXT_KEY, next);

  const permalink = await getMediaPermalink(accessToken, state.mediaId).catch(() => null);

  try {
    await cloud.rename(state.folderPath, `${DONE_PREFIX}${state.folderName}`);
  } catch (error) {
    problems.push(`No pude ponerle la Z (${errorMessage(error)}); no se va a repetir igual.`);
  }

  let campaign: string | null = null;
  try {
    campaign = await bindCampaign(state, permalink);
  } catch (error) {
    problems.push(`No pude armar la campaña (${errorMessage(error)}): hacela a mano.`);
  }

  let left: number | null = null;
  try {
    left = queueFolders(await cloud.list(config.folder)).length;
  } catch {
    // Only for the message.
  }

  await redis.del(INFLIGHT_KEY);
  await notify({
    title: `Reel publicado: ${state.folderName}`,
    message: [
      campaign ? `${campaign} activa` : "Sin campaña",
      left === 0
        ? "No quedan más en la cola: corré /reel-animado para armar más."
        : `El próximo: ${new Date(next).toLocaleString("es-UY", { timeZone: config.timeZone })}${left !== null ? ` (quedan ${left})` : ""}`,
      left === 1 ? "Queda uno solo: corré /reel-animado para que no se corte." : null,
      ...problems,
    ]
      .filter(Boolean)
      .join("\n"),
    tags: problems.length || (left !== null && left <= 1) ? ["warning"] : ["movie_camera"],
    ...(permalink ? { click: permalink } : {}),
  });
  return { status: "published", folder: state.folderPath, campaign, permalink, next };
}

/**
 * A previous run stopped half way. With the media id it went out and only the
 * bookkeeping is missing; with a container but no media id nobody knows
 * whether it went out, so the folder is parked for the owner to check.
 */
async function recoverInFlight(
  cloud: OpenCloudClient,
  redis: Redis,
  account: Account,
  config: ReelPublisherConfig,
  now: Date
): Promise<ReelRunResult | null> {
  const stored = await redis.get(INFLIGHT_KEY);
  if (!stored) return null;
  const state = JSON.parse(stored) as InFlight;

  if (state.mediaId) {
    return finishPublished(cloud, redis, decryptToken(account.accessToken), config, now, {
      ...state,
      mediaId: state.mediaId,
    });
  }
  await redis.del(INFLIGHT_KEY);
  if (!state.containerId) return null; // it stopped before anything reached Instagram
  await cloud.rename(state.folderPath, `${REVIEW_PREFIX}${state.folderName}`).catch(() => undefined);
  await notify({
    title: `Reel: revisá "${state.folderName}"`,
    message: `Se cortó mientras se publicaba y no sé si salió. Lo renombré "${REVIEW_PREFIX}${state.folderName}": fijate en Instagram; si no está, sacale el prefijo.`,
    tags: ["warning"],
  });
  return { status: "review", folder: state.folderPath };
}

async function publishCandidate(
  cloud: OpenCloudClient,
  redis: Redis,
  config: ReelPublisherConfig,
  account: Account,
  candidate: Candidate,
  now: Date,
  sleep: (ms: number) => Promise<void>
): Promise<ReelRunResult> {
  const accessToken = decryptToken(account.accessToken);
  const state: InFlight = {
    folderPath: candidate.folder.path,
    folderName: candidate.folder.name,
    campaignId: candidate.campaign?.id ?? null,
    campaignName: candidate.campaign?.name ?? null,
    workspaceId: account.workspaceId,
    instagramAccountId: account.id,
  };
  const save = () => redis.set(INFLIGHT_KEY, JSON.stringify(state), "EX", 7 * 86400);
  await save();

  // Nothing is public on Instagram until media_publish: any failure up to it
  // is safe. The copy in the staging bucket is always removed.
  let staged: StagedVideo | null = null;
  try {
    staged = await stageVideo(await cloud.download(candidate.video.path));
    const container = await createReelContainer(accessToken, account.instagramId, {
      videoUrl: staged.url,
      caption: candidate.caption,
      thumbOffsetMs: candidate.coverMs,
      shareToFeed: true,
    });
    state.containerId = container.id;
    await save();
    await waitForContainer(accessToken, container.id, sleep);
  } catch (error) {
    await redis.del(INFLIGHT_KEY);
    let where = " Lo vuelvo a intentar en el próximo turno.";
    if (error instanceof ContainerError) {
      // The same video would be refused again: out of the queue so the next one goes.
      await cloud.rename(candidate.folder.path, `${ERROR_PREFIX}${candidate.folder.name}`).catch(() => undefined);
      where = ` Lo renombré "${ERROR_PREFIX}${candidate.folder.name}".`;
    }
    await warnOnce(redis, `failed:${candidate.folder.name}:${localDay(now, config.timeZone)}`,
      `Reel: no pude publicar "${candidate.folder.name}"`, `${errorMessage(error)}.${where}`);
    return { status: "failed", folder: candidate.folder.path, error: errorMessage(error) };
  } finally {
    await staged?.remove();
  }

  let mediaId: string;
  try {
    mediaId = await publishMediaContainer(accessToken, account.instagramId, state.containerId!);
  } catch (error) {
    // Meta answered with an error: it did not go out, the next tick retries.
    // No answer at all (network) leaves the in-flight record for the check.
    if (!(error instanceof MetaApiError)) throw error;
    await redis.del(INFLIGHT_KEY);
    await warnOnce(redis, `failed:${candidate.folder.name}:${localDay(now, config.timeZone)}`,
      `Reel: no pude publicar "${candidate.folder.name}"`, errorMessage(error));
    return { status: "failed", folder: candidate.folder.path, error: errorMessage(error) };
  }

  state.mediaId = mediaId;
  await save();
  return finishPublished(cloud, redis, accessToken, config, now, { ...state, mediaId });
}

async function findAccount(): Promise<Account | null> {
  const instagramId = (process.env.REEL_INSTAGRAM_ID ?? process.env.TRIAL_INSTAGRAM_ID)?.trim();
  return prisma.instagramAccount.findFirst({
    where: { provider: "META", ...(instagramId ? { instagramId } : {}) },
    orderBy: { connectedAt: "asc" },
    select: { id: true, workspaceId: true, instagramId: true, accessToken: true },
  });
}

/** True when the account published anything less than `ownPostWaitMinutes` ago. */
async function postedRecently(accessToken: string, now: Date, config: ReelPublisherConfig): Promise<boolean> {
  if (config.ownPostWaitMinutes <= 0) return false;
  try {
    const media = await getUserMedia(decryptToken(accessToken), 5);
    return media.some((item) => {
      const at = Date.parse(item.timestamp ?? "");
      return Number.isFinite(at) && now.getTime() - at < config.ownPostWaitMinutes * 60_000;
    });
  } catch {
    return false;
  }
}

/**
 * One tick. Publishes at most one reel, when the next one is due. `force` skips
 * the switch and the schedule (a manual "publish the next one now"); `dryRun`
 * only reports what would go out.
 */
export async function runReelPublisher(
  options: { force?: boolean; dryRun?: boolean; now?: Date; sleep?: (ms: number) => Promise<void> } = {}
): Promise<ReelRunResult> {
  const config = reelPublisherConfig();
  if (!config.enabled && !options.force) return { status: "disabled" };
  const redis = getRedisConnection();
  const cloud = OpenCloudClient.fromEnv();
  if (!cloud) {
    await warnOnce(redis, "config", "Reel: falta configurar OpenCloud",
      "Faltan OPENCLOUD_URL, OPENCLOUD_USER u OPENCLOUD_TOKEN en el .env del worker.");
    return { status: "disabled" };
  }
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const due = await nextDue(redis, now, config);
  if (!options.force && !options.dryRun && due > now) return { status: "waiting" };

  const account = await findAccount();
  if (!account) {
    await warnOnce(redis, "account", "Reel: no hay cuenta de Instagram conectada", "Conectala en OpenReply.");
    return { status: "disabled" };
  }

  if (options.dryRun) {
    const candidate = await pickCandidate(cloud, redis, config, account);
    if (!candidate) return { status: "empty" };
    return {
      status: "dry-run",
      folder: candidate.folder.path,
      video: candidate.video.name,
      campaign: candidate.campaign?.name ?? null,
      caption: candidate.caption,
      next: due.toISOString(),
    };
  }

  if (!options.force && (await postedRecently(account.accessToken, now, config))) return { status: "waiting" };

  const lock = randomUUID();
  if (!(await redis.set(LOCK_KEY, lock, "EX", 3600, "NX"))) return { status: "busy" };
  try {
    const recovered = await recoverInFlight(cloud, redis, account, config, now);
    if (recovered) return recovered;

    const candidate = await pickCandidate(cloud, redis, config, account);
    if (!candidate) {
      await warnOnce(redis, `empty:${localDay(now, config.timeZone)}`, "Reel: la cola está vacía",
        `No hay reels listos en ${config.folder}. Corré /reel-animado para armar más.`);
      return { status: "empty" };
    }
    return await publishCandidate(cloud, redis, config, account, candidate, now, sleep);
  } catch (error) {
    // OpenCloud or Instagram unreachable, or a run cut mid-publish: still due,
    // the next tick tries again.
    await warnOnce(redis, `error:${localDay(now, config.timeZone)}`, "Reel: algo falló", errorMessage(error)).catch(() => undefined);
    throw error;
  } finally {
    if ((await redis.get(LOCK_KEY)) === lock) await redis.del(LOCK_KEY);
  }
}
