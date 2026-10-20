/**
 * Publishes the owner's finished carousels from a queue folder in OpenCloud,
 * one every few days, at a random time inside the daily window.
 *
 * Layout (CAROUSEL_FOLDER, default "Carruseles"): one subfolder per carousel,
 * published in name order, holding the slides (01.png, 02.png... or .jpg),
 * caption.txt and, when the carousel asks for a comment, carrusel.json:
 *
 *   Carruseles/Contenido/01.png ... 07.png
 *   Carruseles/Contenido/caption.txt
 *   Carruseles/Contenido/carrusel.json   {"campana": "Contenido"}
 *
 * "campana" is an OpenReply campaign made beforehand, paused and with no post:
 * once the carousel is out it is bound to it and switched on, what the owner
 * did by hand for the first one ("Herramientas Hype"). Its links have to answer
 * before anything goes out, so nobody gets a DM pointing at a page that is not
 * up yet; a carousel waiting on its page is skipped and reported, and the next
 * one goes instead. A carousel with no carrusel.json goes out on its own.
 *
 * Done folders get the owner's mark, "Z - " in front of the name, and are
 * skipped, as are names starting with "_" (a run that died mid-publish leaves
 * its folder as "_REVISAR <name>" for the owner to check). Nothing is ever
 * published twice: a run that dies after publishing is finished by the next.
 *
 * Off unless CAROUSEL_PUBLISH_ENABLED=true. Shares OpenCloud, the staging
 * bucket and the Instagram account with the trial publisher.
 */

import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getRedisConnection } from "@/lib/queue/client";
import {
  MetaApiError,
  createCarouselContainer,
  createCarouselItemContainer,
  getMediaContainerStatus,
  getMediaPermalink,
  getUserMedia,
  publishMediaContainer,
} from "@/lib/meta/client";
import { OpenCloudClient, type DavEntry } from "@/lib/trials/opencloud";
import { stageFile, type StagedFile } from "@/lib/trials/staging";
import { localDay, planDaySlots } from "@/lib/trials/publisher";
import { toJpeg } from "./jpeg";

const CAPTION_FILES = ["caption.txt", "texto.txt"];
const SETTINGS_FILE = "carrusel.json";
const DONE_RE = /^Z(\s*-\s*|\s+)/;
const DONE_PREFIX = "Z - ";
const REVIEW_PREFIX = "_REVISAR ";
const IMAGE_RE = /\.(png|jpe?g)$/i;
// Instagram's limits for a carousel made through the API.
const MIN_ITEMS = 2;
const MAX_CAPTION_LENGTH = 2200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CONTAINER_TIMEOUT_MS = 10 * 60_000;
const CONTAINER_POLL_MS = 5_000;

const LOCK_KEY = "carousel:lock";
const INFLIGHT_KEY = "carousel:inflight";
const NEXT_KEY = "carousel:next";
const PUBLISHED_KEY = "carousel:published";

export interface CarouselPublisherConfig {
  enabled: boolean;
  everyDays: number;
  startHour: number;
  endHour: number;
  timeZone: string;
  folder: string;
  maxItems: number;
  /** First day to publish on (YYYY-MM-DD); today when empty. */
  startDay: string | null;
  /** Minutes to hold back after any post on the account, ours or the owner's. */
  ownPostWaitMinutes: number;
}

export function carouselPublisherConfig(env: NodeJS.ProcessEnv = process.env): CarouselPublisherConfig {
  let [startHour, endHour] = (env.CAROUSEL_PUBLISH_HOURS ?? env.TRIAL_PUBLISH_HOURS ?? "11-21").split("-").map(Number);
  if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) [startHour, endHour] = [11, 21];
  const everyDays = Number(env.CAROUSEL_EVERY_DAYS ?? 3);
  const maxItems = Math.trunc(Number(env.CAROUSEL_MAX_ITEMS ?? 10));
  const ownPostWaitMinutes = Number(env.CAROUSEL_OWN_POST_WAIT_MINUTES ?? env.TRIAL_OWN_POST_WAIT_MINUTES ?? 90);
  const startDay = env.CAROUSEL_START_DAY?.trim();
  return {
    enabled: env.CAROUSEL_PUBLISH_ENABLED === "true",
    everyDays: everyDays > 0 ? everyDays : 3,
    startHour,
    endHour,
    timeZone: env.CAROUSEL_PUBLISH_TIMEZONE ?? env.TRIAL_PUBLISH_TIMEZONE ?? "America/Montevideo",
    folder: (env.CAROUSEL_FOLDER ?? "Carruseles").replace(/^\/+|\/+$/g, ""),
    maxItems: maxItems >= MIN_ITEMS ? maxItems : 10,
    startDay: startDay && /^\d{4}-\d{2}-\d{2}$/.test(startDay) ? startDay : null,
    ownPostWaitMinutes: ownPostWaitMinutes >= 0 ? ownPostWaitMinutes : 90,
  };
}

// ─── Schedule ───────────────────────────────────────────────────────────────────

/** The day `days` after `day` (both YYYY-MM-DD). */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** A random time inside the window of `day`. */
function slotOn(day: string, config: CarouselPublisherConfig, random?: () => number): string {
  return planDaySlots(day, { ...config, perDay: 1 }, random)[0];
}

/** When the next carousel is due; planned (and stored) the first time it is asked. */
async function nextDue(redis: Redis, now: Date, config: CarouselPublisherConfig): Promise<Date> {
  const stored = await redis.get(NEXT_KEY);
  if (stored) return new Date(stored);
  const today = localDay(now, config.timeZone);
  const first = slotOn(config.startDay && config.startDay > today ? config.startDay : today, config);
  await redis.set(NEXT_KEY, first);
  return new Date(first);
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
    if (!response.ok) console.log(`[Carousel publisher] ntfy ping failed: HTTP ${response.status}`);
  } catch (error) {
    console.log("[Carousel publisher] ntfy ping failed:", errorMessage(error));
  }
}

// The same problem is reported at most once a day.
async function warnOnce(redis: Redis, key: string, title: string, message: string) {
  console.log(`[Carousel publisher] ${title}: ${message}`);
  const fresh = await redis.set(`carousel:warned:${key}`, "1", "EX", 86400, "NX");
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
  images: DavEntry[];
  caption: string;
  campaign: { id: string; name: string } | null;
};

/** "Z - Hype" and "Z Hype" are done; "Zapier" is not. */
export function isDoneFolder(name: string): boolean {
  return DONE_RE.test(name);
}

/** carrusel.json of a folder: the campaign name, null without one, or an error string. */
async function readCampaignName(cloud: OpenCloudClient, folder: DavEntry): Promise<string | null | { error: string }> {
  const raw = (await cloud.readText(`${folder.path}/${SETTINGS_FILE}`))?.trim();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return typeof data.campana === "string" && data.campana.trim() ? data.campana.trim() : null;
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

/** The links of the campaign that do not answer 2xx (after redirects). */
async function brokenLinks(urls: string[]): Promise<string[]> {
  const broken: string[] = [];
  for (const url of urls) {
    const ok = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (!ok) broken.push(url);
  }
  return broken;
}

/**
 * The next carousel to publish: the first folder by name that is ready.
 * Folders that cannot go yet (no caption, too many slides, campaign missing
 * or already used, resource page down) are reported and skipped.
 */
async function pickCandidate(
  cloud: OpenCloudClient,
  redis: Redis,
  config: CarouselPublisherConfig,
  account: Account
): Promise<Candidate | null> {
  const folders = (await cloud.list(config.folder))
    .filter((entry) => entry.isDir && !entry.name.startsWith("_") && !isDoneFolder(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  for (const folder of folders) {
    if (await redis.hexists(PUBLISHED_KEY, folder.path)) continue;
    const images = (await cloud.list(folder.path))
      .filter((entry) => !entry.isDir && IMAGE_RE.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const warn = (key: string, title: string, message: string) =>
      warnOnce(redis, `${key}:${folder.name}`, `Carrusel "${folder.name}": ${title}`, message);

    if (images.length < MIN_ITEMS || images.length > config.maxItems) {
      await warn("count", `tiene ${images.length} imágenes`,
        `Instagram acepta de ${MIN_ITEMS} a ${config.maxItems} por API. Lo salteo.`);
      continue;
    }
    const heavy = images.find((image) => image.size > MAX_IMAGE_BYTES * 3);
    if (heavy) {
      await warn("size", "imagen muy pesada", `${heavy.name} pesa ${Math.round(heavy.size / 1024 / 1024)} MB.`);
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

    const campaignName = await readCampaignName(cloud, folder);
    if (campaignName && typeof campaignName === "object") {
      await warn("settings", `revisá ${SETTINGS_FILE}`, campaignName.error);
      continue;
    }
    let campaign: Candidate["campaign"] = null;
    if (campaignName) {
      const found = await prisma.automation.findFirst({
        where: { instagramAccountId: account.id, name: { equals: campaignName, mode: "insensitive" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, postId: true, trackedLinks: { select: { destinationUrl: true } } },
      });
      if (!found) {
        await warn("campaign", `no encuentro la campaña "${campaignName}"`,
          `Creala pausada y sin post en OpenReply, con ese nombre exacto.`);
        continue;
      }
      if (found.postId) {
        await warn("campaign-used", `la campaña "${found.name}" ya tiene un post`,
          `Tiene que estar sin post para atarla a este carrusel. Lo salteo.`);
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
    return { folder, images, caption, campaign };
  }
  return null;
}

// ─── Publishing ─────────────────────────────────────────────────────────────────

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
      throw new Error(`Instagram no pudo procesar el carrusel (${code}${status ? `: ${status}` : ""})`);
    }
    if (Date.now() > deadline) throw new Error("Instagram tardó más de 10 minutos en procesar el carrusel");
    await sleep(CONTAINER_POLL_MS);
  }
}

type InFlight = {
  folderPath: string;
  folderName: string;
  campaignId: string | null;
  campaignName: string | null;
  containerId?: string;
  mediaId?: string;
};

export type CarouselRunResult =
  | { status: "disabled" | "waiting" | "busy" | "empty" }
  | { status: "dry-run"; folder: string; images: string[]; campaign: string | null; caption: string; next: string }
  | { status: "published"; folder: string; campaign: string | null; permalink: string | null; next: string }
  | { status: "failed"; folder: string; error: string }
  | { status: "review"; folder: string };

/**
 * Bookkeeping once a carousel is out: mark the folder, switch its campaign on,
 * plan the next one, tell the owner. Safe to run again for the same carousel.
 */
async function finishPublished(
  cloud: OpenCloudClient,
  redis: Redis,
  accessToken: string,
  config: CarouselPublisherConfig,
  now: Date,
  state: InFlight & { mediaId: string }
): Promise<CarouselRunResult> {
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

  let left: number | null = null;
  try {
    left = await queuedCarousels(cloud, config);
  } catch {
    // Only for the message.
  }

  if (state.campaignId) {
    try {
      await prisma.automation.update({
        where: { id: state.campaignId },
        data: { isActive: true, postId: state.mediaId, postUrl: permalink, pendingNextReel: false, matchAnyPost: false },
      });
    } catch (error) {
      problems.push(`No pude activar la campaña "${state.campaignName}" (${errorMessage(error)}): atala a mano.`);
    }
  }

  await redis.del(INFLIGHT_KEY);
  await notify({
    title: `Carrusel publicado: ${state.folderName}`,
    message: [
      state.campaignName ? `Campaña "${state.campaignName}" activa` : "Sin campaña",
      left === 0
        ? "No quedan más en la cola: corré /carrusel-nuevo para armar uno desde los reels."
        : `El próximo: ${new Date(next).toLocaleString("es-UY", { timeZone: config.timeZone })}${left !== null ? ` (quedan ${left})` : ""}`,
      left === 1 ? "Queda uno solo: corré /carrusel-nuevo para que no se corte." : null,
      ...problems,
    ]
      .filter(Boolean)
      .join("\n"),
    tags: problems.length || (left !== null && left <= 1) ? ["warning"] : ["frame_with_picture"],
    ...(permalink ? { click: permalink } : {}),
  });
  return { status: "published", folder: state.folderPath, campaign: state.campaignName, permalink, next };
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
  config: CarouselPublisherConfig,
  now: Date
): Promise<CarouselRunResult | null> {
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
    title: `Carrusel: revisá "${state.folderName}"`,
    message: `Se cortó mientras se publicaba y no sé si salió. Lo renombré "${REVIEW_PREFIX}${state.folderName}": fijate en Instagram; si no está, sacale el prefijo.`,
    tags: ["warning"],
  });
  return { status: "review", folder: state.folderPath };
}

async function publishCandidate(
  cloud: OpenCloudClient,
  redis: Redis,
  config: CarouselPublisherConfig,
  account: Account,
  candidate: Candidate,
  now: Date,
  sleep: (ms: number) => Promise<void>
): Promise<CarouselRunResult> {
  const accessToken = decryptToken(account.accessToken);
  const state: InFlight = {
    folderPath: candidate.folder.path,
    folderName: candidate.folder.name,
    campaignId: candidate.campaign?.id ?? null,
    campaignName: candidate.campaign?.name ?? null,
  };
  const save = () => redis.set(INFLIGHT_KEY, JSON.stringify(state), "EX", 7 * 86400);
  await save();

  // Nothing is public on Instagram until media_publish: any failure up to it
  // is safe. The copies in the staging bucket are always removed.
  const staged: StagedFile[] = [];
  try {
    const children: string[] = [];
    for (const image of candidate.images) {
      const jpeg = await toJpeg(await cloud.download(image.path), image.name);
      if (jpeg.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`${image.name} pesa ${Math.round(jpeg.byteLength / 1024 / 1024)} MB en JPEG; Instagram acepta hasta 8 MB`);
      }
      const file = await stageFile(jpeg, { extension: "jpg", contentType: "image/jpeg" });
      staged.push(file);
      children.push((await createCarouselItemContainer(accessToken, account.instagramId, file.url)).id);
    }
    const container = await createCarouselContainer(accessToken, account.instagramId, {
      children,
      caption: candidate.caption,
    });
    state.containerId = container.id;
    await save();
    await waitForContainer(accessToken, container.id, sleep);
  } catch (error) {
    await redis.del(INFLIGHT_KEY);
    await notify({
      title: `Carrusel: no pude publicar "${candidate.folder.name}"`,
      message: `${errorMessage(error)}. Lo vuelvo a intentar en el próximo turno.`,
      tags: ["warning"],
    });
    return { status: "failed", folder: candidate.folder.path, error: errorMessage(error) };
  } finally {
    await Promise.all(staged.map((file) => file.remove()));
  }

  let mediaId: string;
  try {
    mediaId = await publishMediaContainer(accessToken, account.instagramId, state.containerId!);
  } catch (error) {
    // Meta answered with an error: it did not go out, the next tick retries.
    // No answer at all (network) leaves the in-flight record for the check.
    if (!(error instanceof MetaApiError)) throw error;
    await redis.del(INFLIGHT_KEY);
    await notify({
      title: `Carrusel: no pude publicar "${candidate.folder.name}"`,
      message: errorMessage(error),
      tags: ["warning"],
    });
    return { status: "failed", folder: candidate.folder.path, error: errorMessage(error) };
  }

  state.mediaId = mediaId;
  await save();
  return finishPublished(cloud, redis, accessToken, config, now, { ...state, mediaId });
}

async function findAccount(): Promise<Account | null> {
  const instagramId = (process.env.CAROUSEL_INSTAGRAM_ID ?? process.env.TRIAL_INSTAGRAM_ID)?.trim();
  return prisma.instagramAccount.findFirst({
    where: { provider: "META", ...(instagramId ? { instagramId } : {}) },
    orderBy: { connectedAt: "asc" },
    select: { id: true, workspaceId: true, instagramId: true, accessToken: true },
  });
}

/** True when the account published anything less than `ownPostWaitMinutes` ago. */
async function postedRecently(accessToken: string, now: Date, config: CarouselPublisherConfig): Promise<boolean> {
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
 * One tick. Publishes at most one carousel, when the next one is due.
 * `force` skips the switch and the schedule (a manual "publish the next one
 * now"); `dryRun` only reports what would go out.
 */
export async function runCarouselPublisher(
  options: { force?: boolean; dryRun?: boolean; now?: Date; sleep?: (ms: number) => Promise<void> } = {}
): Promise<CarouselRunResult> {
  const config = carouselPublisherConfig();
  if (!config.enabled && !options.force) return { status: "disabled" };
  const redis = getRedisConnection();
  const cloud = OpenCloudClient.fromEnv();
  if (!cloud) {
    await warnOnce(redis, "config", "Carrusel: falta configurar OpenCloud",
      "Faltan OPENCLOUD_URL, OPENCLOUD_USER u OPENCLOUD_TOKEN en el .env del worker.");
    return { status: "disabled" };
  }
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const due = await nextDue(redis, now, config);
  if (!options.force && !options.dryRun && due > now) return { status: "waiting" };

  const account = await findAccount();
  if (!account) {
    await warnOnce(redis, "account", "Carrusel: no hay cuenta de Instagram conectada", "Conectala en OpenReply.");
    return { status: "disabled" };
  }

  if (options.dryRun) {
    const candidate = await pickCandidate(cloud, redis, config, account);
    if (!candidate) return { status: "empty" };
    return {
      status: "dry-run",
      folder: candidate.folder.path,
      images: candidate.images.map((image) => image.name),
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
      await warnOnce(redis, `empty:${localDay(now, config.timeZone)}`, "Carrusel: la cola está vacía",
        `No hay carruseles listos en ${config.folder}. Es hora de armar más desde los reels.`);
      return { status: "empty" };
    }
    return await publishCandidate(cloud, redis, config, account, candidate, now, sleep);
  } catch (error) {
    // OpenCloud or Instagram unreachable, or a run cut mid-publish: still due,
    // the next tick tries again.
    await warnOnce(redis, `error:${localDay(now, config.timeZone)}`, "Carrusel: algo falló", errorMessage(error)).catch(() => undefined);
    throw error;
  } finally {
    if ((await redis.get(LOCK_KEY)) === lock) await redis.del(LOCK_KEY);
  }
}

/** How many carousels are still waiting in the queue. */
async function queuedCarousels(cloud: OpenCloudClient, config: CarouselPublisherConfig): Promise<number> {
  return (await cloud.list(config.folder)).filter(
    (entry) => entry.isDir && !entry.name.startsWith("_") && !isDoneFolder(entry.name)
  ).length;
}
