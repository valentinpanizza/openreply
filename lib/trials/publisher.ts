/**
 * Publishes trial reels from a queue folder in the owner's OpenCloud, a few a
 * day, at random times inside a daily window.
 *
 * Layout (TRIAL_FOLDER, default "Reels/Trial"): one subfolder per reel, holding
 * the variants (.mp4 / .mov), texto.txt with the caption and, optionally,
 * trial.json:
 *
 *   TRIAL/[TRIAL] JARVIS/texto.txt
 *   TRIAL/[TRIAL] JARVIS/trial.json   {"campana": "Jarvis2", "nombre": "Jarvis", "velocidad": 1.2}
 *   TRIAL/[TRIAL] JARVIS/normal_01.mp4
 *
 * The folder name (minus "[TRIAL]" / "[TRAIL]") is the OpenReply campaign the
 * trials reuse unless trial.json says "campana"; "nombre" is the name used in
 * "[TRIALn] <nombre>"; "velocidad" speeds the video up before it goes out.
 *
 * Each published variant gets its own campaign, a copy of that one named
 * "[TRIALn] <nombre>", active and bound to the new reel: what the owner did by
 * hand for every trial. The owner marks what he already uploaded with a "Z" in
 * front of the name, so the file is renamed "Zname.mp4" and, when no variant is
 * left, the folder "Z[TRIAL] name". Names starting with "Z" are skipped. A video Instagram
 * cannot process moves to "error/"; any other failure leaves it for the next
 * slot. Nothing is ever published twice: a run that dies after publishing is
 * finished by the next one, and one that died mid-publish parks its file in
 * "revisar/" for the owner to check.
 *
 * Off unless TRIAL_PUBLISH_ENABLED=true. Needs OPENCLOUD_URL, OPENCLOUD_USER
 * and OPENCLOUD_TOKEN, and an account connected with
 * instagram_business_content_publish.
 */

import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { duplicateCampaign } from "@/lib/campaigns/duplicate";
import { getRedisConnection } from "@/lib/queue/client";
import {
  MetaApiError,
  createReelContainer,
  getMediaContainerStatus,
  getUserMedia,
  getMediaPermalink,
  publishMediaContainer,
  type TrialGraduationStrategy,
} from "@/lib/meta/client";
import { OpenCloudClient, type DavEntry } from "./opencloud";
import { changeSpeed, parseSpeed } from "./speed";
import { stageVideo, type StagedVideo } from "./staging";

const CAPTION_FILE = "texto.txt";
const SETTINGS_FILE = "trial.json";
const DONE_PREFIX = "Z";
const ERROR_DIR = "error";
const REVIEW_DIR = "revisar";
const VIDEO_RE = /\.(mp4|mov)$/i;
// Instagram's limits for a reel.
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_CAPTION_LENGTH = 2200;
const CONTAINER_TIMEOUT_MS = 15 * 60_000;
const CONTAINER_POLL_MS = 10_000;

const LOCK_KEY = "trial:lock";
const INFLIGHT_KEY = "trial:inflight";
const LAST_KEY = "trial:last";
const PUBLISHED_KEY = "trial:published";
const slotsKey = (day: string) => `trial:slots:${day}`;
const lastFolderKey = (folder: string) => `trial:lastpub:${folder}`;

export interface TrialPublisherConfig {
  enabled: boolean;
  perDay: number;
  startHour: number;
  endHour: number;
  timeZone: string;
  graduation: TrialGraduationStrategy;
  folder: string;
  skipFolders: string[];
  thumbOffsetMs: number;
  minGapMinutes: number;
  /** Minutes to hold back after any reel on the account, ours or the owner's. */
  ownPostWaitMinutes: number;
}

export function trialPublisherConfig(env: NodeJS.ProcessEnv = process.env): TrialPublisherConfig {
  let [startHour, endHour] = (env.TRIAL_PUBLISH_HOURS ?? "11-21").split("-").map(Number);
  if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) [startHour, endHour] = [11, 21];
  const perDay = Math.trunc(Number(env.TRIAL_PUBLISH_PER_DAY ?? 2));
  const thumbOffsetMs = Number(env.TRIAL_THUMB_OFFSET_MS ?? 1000);
  const minGapMinutes = Number(env.TRIAL_MIN_GAP_MINUTES ?? 90);
  const ownPostWaitMinutes = Number(env.TRIAL_OWN_POST_WAIT_MINUTES ?? 90);
  return {
    enabled: env.TRIAL_PUBLISH_ENABLED === "true",
    perDay: perDay > 0 ? perDay : 2,
    startHour,
    endHour,
    timeZone: env.TRIAL_PUBLISH_TIMEZONE ?? "America/Montevideo",
    graduation: env.TRIAL_GRADUATION === "SS_PERFORMANCE" ? "SS_PERFORMANCE" : "MANUAL",
    folder: (env.TRIAL_FOLDER ?? "Reels/Trial").replace(/^\/+|\/+$/g, ""),
    // The variants open on a dark frame (trial.py), so the default cover is a
    // second in.
    skipFolders: (env.TRIAL_SKIP_FOLDERS ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
    thumbOffsetMs: thumbOffsetMs >= 0 ? thumbOffsetMs : 1000,
    minGapMinutes: minGapMinutes >= 0 ? minGapMinutes : 90,
    ownPostWaitMinutes: ownPostWaitMinutes >= 0 ? ownPostWaitMinutes : 90,
  };
}

// ─── Schedule ───────────────────────────────────────────────────────────────────

function zonedParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The calendar day in `timeZone`, as YYYY-MM-DD. */
export function localDay(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant that is `minutes` past midnight of `day` in `timeZone`. */
function localTime(day: string, minutes: number, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, date, 0, minutes);
  const p = zonedParts(new Date(guess), timeZone);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
  return new Date(guess - offset);
}

/**
 * The day's publishing times: the window split into one share per post, each
 * post at a random minute in the middle 80% of its share, so two never land
 * back to back and the hour changes from day to day.
 */
export function planDaySlots(
  day: string,
  config: Pick<TrialPublisherConfig, "perDay" | "startHour" | "endHour" | "timeZone">,
  random: () => number = Math.random
): string[] {
  const start = config.startHour * 60;
  const share = ((config.endHour - config.startHour) * 60) / config.perDay;
  return Array.from({ length: config.perDay }, (_, i) =>
    localTime(day, Math.round(start + share * (i + 0.1 + 0.8 * random())), config.timeZone).toISOString()
  );
}

type Slot = { at: string; done: boolean };

async function loadSlots(redis: Redis, day: string, config: TrialPublisherConfig): Promise<Slot[]> {
  const stored = await redis.get(slotsKey(day));
  if (stored) return JSON.parse(stored) as Slot[];
  const slots = planDaySlots(day, config).map((at) => ({ at, done: false }));
  await redis.set(slotsKey(day), JSON.stringify(slots), "EX", 3 * 86400);
  return slots;
}

async function markSlotDone(redis: Redis, day: string, index: number) {
  const stored = await redis.get(slotsKey(day));
  if (!stored) return;
  const slots = JSON.parse(stored) as Slot[];
  if (!slots[index]) return;
  slots[index].done = true;
  await redis.set(slotsKey(day), JSON.stringify(slots), "KEEPTTL");
}

// ─── Campaigns ──────────────────────────────────────────────────────────────────

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The next free number for "[TRIALn] <base>". Counts the names the owner gave
 * by hand too: "[TRIAL]" (the first), the "[TRAIL]" typo and a " copy" suffix.
 */
export function nextTrialNumber(names: string[], base: string): number {
  const pattern = new RegExp(
    `^\\[(?:TRIAL|TRAIL)(\\d*)\\]\\s*${escapeRegExp(base.trim())}(?:\\s+copy)?$`,
    "i"
  );
  let highest = 0;
  for (const name of names) {
    const match = name.trim().match(pattern);
    if (match) highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }
  return highest + 1;
}

async function findBaseCampaign(instagramAccountId: string, folderName: string) {
  return prisma.automation.findFirst({
    where: { instagramAccountId, name: { equals: folderName.trim(), mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * "Z[TRIAL] Sesión" -> done, "Sesión". Plain names ("Costo") are not done.
 * The typo "[TRAIL]" is accepted: the owner's folders have it.
 */
export function parseFolderName(name: string): { done: boolean; label: string } {
  const done = name.startsWith(`${DONE_PREFIX}[`);
  const bare = done ? name.slice(DONE_PREFIX.length) : name;
  return { done, label: bare.replace(/^\[(?:TRIAL|TRAIL)\d*\]\s*/i, "").trim() || bare };
}

interface FolderSettings {
  campaign?: string;
  trialName?: string;
  speed?: number;
}

/** trial.json of a folder; null when missing, an error string when unusable. */
async function readSettings(
  cloud: OpenCloudClient,
  folder: DavEntry
): Promise<FolderSettings | string> {
  const raw = (await cloud.readText(`${folder.path}/${SETTINGS_FILE}`))?.trim();
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const speed = data.velocidad === undefined ? undefined : parseSpeed(data.velocidad);
    if (speed === null) return `velocidad inválida (${String(data.velocidad)}); va de 0,5 a 2`;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    return { campaign: text(data.campana), trialName: text(data.nombre), speed };
  } catch {
    return `${SETTINGS_FILE} no es un JSON válido`;
  }
}

// ─── Notifications ──────────────────────────────────────────────────────────────

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
    if (!response.ok) console.log(`[Trial publisher] ntfy ping failed: HTTP ${response.status}`);
  } catch (error) {
    console.log("[Trial publisher] ntfy ping failed:", errorMessage(error));
  }
}

// The same problem is reported at most once a day.
async function warnOnce(redis: Redis, key: string, title: string, message: string) {
  console.log(`[Trial publisher] ${title}: ${message}`);
  const fresh = await redis.set(`trial:warned:${key}`, "1", "EX", 86400, "NX");
  if (fresh) await notify({ title, message, tags: ["warning"] });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Queue ──────────────────────────────────────────────────────────────────────

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
  campaign: { id: string; name: string };
  /** Name after "[TRIALn]" in the campaign made for the reel. */
  trialName: string;
  label: string;
  speed?: number;
};

const publishedId = (video: DavEntry) => `${video.path}|${video.size}`;

/**
 * The next variant to publish: from the folder that has gone longest without a
 * trial, its first video by name. Folders that cannot be published (no
 * caption, no campaign, campaign paused) are reported and skipped.
 */
async function pickCandidate(
  cloud: OpenCloudClient,
  redis: Redis,
  config: TrialPublisherConfig,
  account: Account
): Promise<Candidate | null> {
  const folders = (await cloud.list(config.folder)).filter(
    (entry) =>
      entry.isDir &&
      !entry.name.startsWith("_") &&
      !parseFolderName(entry.name).done &&
      !config.skipFolders.includes(parseFolderName(entry.name).label.toLowerCase())
  );
  const lastPublished = await Promise.all(
    folders.map(async (folder) => Number((await redis.get(lastFolderKey(parseFolderName(folder.name).label))) ?? 0))
  );
  const order = folders
    .map((folder, i) => ({ folder, last: lastPublished[i] }))
    .sort((a, b) => a.last - b.last || a.folder.name.localeCompare(b.folder.name));

  for (const { folder } of order) {
    const entries = await cloud.list(folder.path);
    const videos: DavEntry[] = [];
    for (const entry of entries) {
      if (entry.isDir || !VIDEO_RE.test(entry.name) || entry.name.startsWith(DONE_PREFIX)) continue;
      // A file whose bookkeeping failed after it went out stays put; skip it.
      if (await redis.hexists(PUBLISHED_KEY, publishedId(entry))) continue;
      videos.push(entry);
    }
    videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const video = videos[0];
    if (!video) continue;

    const { label } = parseFolderName(folder.name);
    const caption = (await cloud.readText(`${folder.path}/${CAPTION_FILE}`))?.trim();
    if (!caption) {
      await warnOnce(redis, `caption:${folder.name}`, `Trial: falta el texto de "${folder.name}"`,
        `Poné ${CAPTION_FILE} con el texto del reel en ${folder.path}.`);
      continue;
    }
    if (caption.length > MAX_CAPTION_LENGTH) {
      await warnOnce(redis, `caption-long:${folder.name}`, `Trial: texto muy largo en "${folder.name}"`,
        `Instagram acepta hasta ${MAX_CAPTION_LENGTH} caracteres y tiene ${caption.length}.`);
      continue;
    }
    if (video.size > MAX_VIDEO_BYTES) {
      await warnOnce(redis, `size:${video.path}`, `Trial: video muy pesado`,
        `${video.path} pesa ${Math.round(video.size / 1024 / 1024)} MB; Instagram acepta hasta 300 MB.`);
      continue;
    }
    const settings = await readSettings(cloud, folder);
    if (typeof settings === "string") {
      await warnOnce(redis, `settings:${folder.name}`, `Trial: revisá ${SETTINGS_FILE} de "${folder.name}"`, settings);
      continue;
    }
    const campaignName = settings.campaign ?? label;
    const campaign = await findBaseCampaign(account.id, campaignName);
    if (!campaign) {
      await warnOnce(redis, `campaign:${folder.name}`, `Trial: no encuentro la campaña "${campaignName}"`,
        `La carpeta tiene que llamarse como la campaña de OpenReply que se copia para cada trial, o decirlo en ${SETTINGS_FILE} ("campana").`);
      continue;
    }
    if (!campaign.isActive) {
      await warnOnce(redis, `paused:${folder.name}`, `Trial: la campaña "${campaign.name}" está pausada`,
        `No publico sus trials hasta que la actives.`);
      continue;
    }
    return {
      folder,
      video,
      caption,
      campaign: { id: campaign.id, name: campaign.name },
      trialName: settings.trialName ?? campaign.name,
      label,
      speed: settings.speed,
    };
  }
  return null;
}

// ─── Publishing ─────────────────────────────────────────────────────────────────

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
  path: string;
  size: number;
  folderPath: string;
  folderName: string;
  fileName: string;
  campaignId: string;
  baseName: string;
  workspaceId: string;
  instagramAccountId: string;
  containerId?: string;
  mediaId?: string;
};

export type TrialRunResult =
  | { status: "disabled" | "waiting" | "busy" | "empty" }
  | { status: "dry-run"; file: string; campaign: string; trialName: string; caption: string; speed?: number; slots?: string[] }
  | { status: "published"; file: string; campaign: string | null; permalink: string | null }
  | { status: "failed"; file: string; error: string }
  | { status: "review"; file: string };

/** "Z" on the video and, when it was the last one, on its folder. */
async function markDone(cloud: OpenCloudClient, state: InFlight) {
  await cloud.rename(state.path, `${DONE_PREFIX}${state.fileName}`);
  const left = (await cloud.list(state.folderPath)).filter(
    (entry) => !entry.isDir && VIDEO_RE.test(entry.name) && !entry.name.startsWith(DONE_PREFIX)
  );
  const folderName = state.folderPath.split("/").pop() ?? "";
  if (left.length === 0 && !folderName.startsWith(DONE_PREFIX)) {
    await cloud.rename(state.folderPath, `${DONE_PREFIX}${folderName}`);
  }
}

/**
 * Bookkeeping once a reel is out: move the file, create its campaign, tell the
 * owner. Safe to run again for the same reel.
 */
async function finishPublished(
  cloud: OpenCloudClient,
  redis: Redis,
  accessToken: string,
  state: InFlight & { mediaId: string }
): Promise<TrialRunResult> {
  const problems: string[] = [];
  await redis.hset(PUBLISHED_KEY, `${state.path}|${state.size}`, state.mediaId);
  await redis.set(LAST_KEY, new Date().toISOString());
  await redis.set(lastFolderKey(state.folderName), String(Date.now()));

  const permalink = await getMediaPermalink(accessToken, state.mediaId).catch(() => null);

  try {
    await markDone(cloud, state);
  } catch (error) {
    problems.push(`No pude ponerle la ${DONE_PREFIX} (${errorMessage(error)}); no se va a repetir igual.`);
  }

  let campaignName: string | null = null;
  try {
    const existing = await prisma.automation.findFirst({ where: { postId: state.mediaId } });
    if (existing) {
      campaignName = existing.name;
    } else {
      const copy = await duplicateCampaign({
        automationId: state.campaignId,
        workspaceId: state.workspaceId,
      });
      if (!copy) throw new Error(`la campaña "${state.baseName}" ya no existe`);
      const names = await prisma.automation.findMany({
        where: { instagramAccountId: state.instagramAccountId },
        select: { name: true },
      });
      campaignName = `[TRIAL${nextTrialNumber(names.map((n) => n.name), state.baseName)}] ${state.baseName}`;
      await prisma.automation.update({
        where: { id: copy.id },
        data: {
          name: campaignName,
          isActive: true,
          postId: state.mediaId,
          postUrl: permalink,
          pendingNextReel: false,
          matchAnyPost: false,
        },
      });
    }
  } catch (error) {
    problems.push(`No pude armar la campaña (${errorMessage(error)}): hacela a mano.`);
  }

  await redis.del(INFLIGHT_KEY);
  await notify({
    title: `Trial publicado: ${state.baseName}`,
    message: [campaignName ? `${campaignName} activa` : null, state.fileName, ...problems]
      .filter(Boolean)
      .join("\n"),
    tags: problems.length ? ["warning"] : ["movie_camera"],
    ...(permalink ? { click: permalink } : {}),
  });
  return { status: "published", file: state.path, campaign: campaignName, permalink };
}

/**
 * A previous run stopped half way. With the media id it went out and only the
 * bookkeeping is missing; with a container but no media id nobody knows
 * whether it went out, so the file is parked for the owner to check instead
 * of being published a second time.
 */
async function recoverInFlight(
  cloud: OpenCloudClient,
  redis: Redis,
  account: Account
): Promise<TrialRunResult | null> {
  const stored = await redis.get(INFLIGHT_KEY);
  if (!stored) return null;
  const state = JSON.parse(stored) as InFlight;

  if (state.mediaId) {
    return finishPublished(cloud, redis, decryptToken(account.accessToken), {
      ...state,
      mediaId: state.mediaId,
    });
  }
  if (!state.containerId) {
    // It stopped before anything reached Instagram.
    await redis.del(INFLIGHT_KEY);
    return null;
  }
  await cloud.moveInto(state.path, `${state.folderPath}/${REVIEW_DIR}`).catch(() => undefined);
  await redis.del(INFLIGHT_KEY);
  await notify({
    title: `Trial: revisá "${state.fileName}"`,
    message: `Se cortó mientras se publicaba y no sé si salió. Lo dejé en ${state.folderPath}/${REVIEW_DIR}/: fijate en Instagram; si no está, volvelo a la carpeta.`,
    tags: ["warning"],
  });
  return { status: "review", file: state.path };
}

async function publishCandidate(
  cloud: OpenCloudClient,
  redis: Redis,
  config: TrialPublisherConfig,
  account: Account,
  candidate: Candidate,
  sleep: (ms: number) => Promise<void>
): Promise<TrialRunResult> {
  const accessToken = decryptToken(account.accessToken);
  const state: InFlight = {
    path: candidate.video.path,
    size: candidate.video.size,
    folderPath: candidate.folder.path,
    folderName: candidate.label,
    fileName: candidate.video.name,
    campaignId: candidate.campaign.id,
    baseName: candidate.trialName,
    workspaceId: account.workspaceId,
    instagramAccountId: account.id,
  };
  const save = () => redis.set(INFLIGHT_KEY, JSON.stringify(state), "EX", 7 * 86400);
  await save();

  // Nothing is public on Instagram until media_publish: any failure up to it
  // is safe. The copy in the staging bucket is always removed.
  let staged: StagedVideo | null = null;
  try {
    let video = await cloud.download(candidate.video.path);
    if (candidate.speed && candidate.speed !== 1) {
      video = await changeSpeed(video, candidate.speed);
    }
    if (video.byteLength > MAX_VIDEO_BYTES) {
      throw new Error(`el video pesa ${Math.round(video.byteLength / 1024 / 1024)} MB; Instagram acepta hasta 300 MB`);
    }
    staged = await stageVideo(video);
    const container = await createReelContainer(accessToken, account.instagramId, {
      videoUrl: staged.url,
      caption: candidate.caption,
      thumbOffsetMs: config.thumbOffsetMs,
      trial: config.graduation,
    });
    state.containerId = container.id;
    await save();
    await waitForContainer(accessToken, container.id, sleep);
  } catch (error) {
    await redis.del(INFLIGHT_KEY);
    let where = "";
    if (error instanceof ContainerError) {
      await cloud.moveInto(candidate.video.path, `${candidate.folder.path}/${ERROR_DIR}`).catch(() => undefined);
      where = ` Lo moví a ${ERROR_DIR}/.`;
    }
    await notify({
      title: `Trial: no pude publicar "${candidate.video.name}"`,
      message: `${errorMessage(error)}.${where}`,
      tags: ["warning"],
    });
    return { status: "failed", file: candidate.video.path, error: errorMessage(error) };
  } finally {
    await staged?.remove();
  }

  let mediaId: string;
  try {
    mediaId = await publishMediaContainer(accessToken, account.instagramId, state.containerId!);
  } catch (error) {
    // Meta answered with an error: it did not go out, the next slot retries.
    // No answer at all (network) leaves the in-flight record for the check.
    if (!(error instanceof MetaApiError)) throw error;
    await redis.del(INFLIGHT_KEY);
    await notify({
      title: `Trial: no pude publicar "${candidate.video.name}"`,
      message: errorMessage(error),
      tags: ["warning"],
    });
    return { status: "failed", file: candidate.video.path, error: errorMessage(error) };
  }

  state.mediaId = mediaId;
  await save();
  return finishPublished(cloud, redis, accessToken, { ...state, mediaId });
}

async function findAccount(): Promise<Account | null> {
  const instagramId = process.env.TRIAL_INSTAGRAM_ID?.trim();
  return prisma.instagramAccount.findFirst({
    where: { provider: "META", ...(instagramId ? { instagramId } : {}) },
    orderBy: { connectedAt: "asc" },
    select: { id: true, workspaceId: true, instagramId: true, accessToken: true },
  });
}

/**
 * True when the account published something (the owner posting by hand shows
 * up here too) less than `ownPostWaitMinutes` ago. If Instagram cannot be
 * asked, do not hold the slot back.
 */
async function postedRecently(accessToken: string, now: Date, config: TrialPublisherConfig): Promise<boolean> {
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
 * One tick. Publishes at most one reel, when a slot of the day is due.
 * `force` skips the switch and the schedule (a manual "publish the next one
 * now"); `dryRun` only reports what would go out.
 */
export async function runTrialPublisher(
  options: {
    force?: boolean;
    dryRun?: boolean;
    now?: Date;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<TrialRunResult> {
  const config = trialPublisherConfig();
  if (!config.enabled && !options.force) return { status: "disabled" };
  const redis = getRedisConnection();
  const cloud = OpenCloudClient.fromEnv();
  if (!cloud) {
    await warnOnce(redis, "config", "Trial: falta configurar OpenCloud",
      "Faltan OPENCLOUD_URL, OPENCLOUD_USER u OPENCLOUD_TOKEN en el .env del worker.");
    return { status: "disabled" };
  }
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const day = localDay(now, config.timeZone);
  let slotIndex = -1;
  let slots: Slot[] = [];
  if (!options.force) {
    const hour = zonedParts(now, config.timeZone).hour;
    if (hour < config.startHour || hour >= config.endHour) return { status: "waiting" };
    slots = await loadSlots(redis, day, config);
    slotIndex = slots.findIndex((slot) => !slot.done && new Date(slot.at) <= now);
    if (slotIndex === -1) return { status: "waiting" };
    const last = await redis.get(LAST_KEY);
    if (last && now.getTime() - Date.parse(last) < config.minGapMinutes * 60_000) {
      return { status: "waiting" };
    }
  }

  const account = await findAccount();
  if (!account) {
    await warnOnce(redis, "account", "Trial: no hay cuenta de Instagram conectada", "Conectala en OpenReply.");
    return { status: "disabled" };
  }

  if (!options.force && (await postedRecently(account.accessToken, now, config))) {
    return { status: "waiting" };
  }

  if (options.dryRun) {
    const candidate = await pickCandidate(cloud, redis, config, account);
    if (!candidate) return { status: "empty" };
    const names = await prisma.automation.findMany({
      where: { instagramAccountId: account.id },
      select: { name: true },
    });
    return {
      status: "dry-run",
      file: candidate.video.path,
      campaign: candidate.campaign.name,
      trialName: `[TRIAL${nextTrialNumber(names.map((n) => n.name), candidate.trialName)}] ${candidate.trialName}`,
      caption: candidate.caption,
      ...(candidate.speed ? { speed: candidate.speed } : {}),
      slots: (await loadSlots(redis, day, config)).map((slot) => `${slot.at}${slot.done ? " (hecho)" : ""}`),
    };
  }

  const lock = randomUUID();
  if (!(await redis.set(LOCK_KEY, lock, "EX", 3600, "NX"))) return { status: "busy" };
  try {
    const finish = async (result: TrialRunResult) => {
      if (slotIndex !== -1) await markSlotDone(redis, day, slotIndex);
      return result;
    };

    const recovered = await recoverInFlight(cloud, redis, account);
    if (recovered) return finish(recovered);

    const candidate = await pickCandidate(cloud, redis, config, account);
    if (!candidate) {
      if (!options.force) {
        await warnOnce(redis, `empty:${day}`, "Trial: la cola está vacía",
          `No hay videos para publicar en ${config.folder}.`);
      }
      return finish({ status: "empty" });
    }
    return finish(await publishCandidate(cloud, redis, config, account, candidate, sleep));
  } catch (error) {
    // OpenCloud or Instagram unreachable, or a run cut mid-publish: the slot
    // stays due and the next tick tries again.
    await warnOnce(redis, `error:${day}`, "Trial: algo falló", errorMessage(error)).catch(() => undefined);
    throw error;
  } finally {
    if ((await redis.get(LOCK_KEY)) === lock) await redis.del(LOCK_KEY);
  }
}
