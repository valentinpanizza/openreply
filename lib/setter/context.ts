import { getRedisConnection } from "@/lib/queue/client";
import { getMediaCaption } from "@/lib/meta/client";
import type { InstagramContext } from "@/lib/instagram/provider";

/**
 * What the setter knows about a campaign's reel: its name and keywords, the
 * owner's own notes (Automation.setterContext), the reel's caption and the
 * text of the resource page the reel promised. Read once and cached for a few
 * hours, so a conversation does not fetch the page on every message.
 */

const CACHE_TTL_SECONDS = 6 * 3600;
const MAX_PAGE_CHARS = 5_000;

export interface ReelCampaign {
  id: string;
  name: string;
  keywords: string[];
  postId: string | null;
  setterContext: string | null;
  trackedLinks: { destinationUrl: string }[];
}

/** Readable text out of a resource page's HTML. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

async function resourcePage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!response.ok) return null;
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) return null;
    return pageText(await response.text()) || null;
  } catch {
    return null;
  }
}

async function reelCaption(campaign: ReelCampaign, context: InstagramContext | null): Promise<string | null> {
  if (!campaign.postId || context?.provider !== "META") return null;
  try {
    const media = await getMediaCaption(context.accessToken, campaign.postId);
    return media.caption?.trim() || null;
  } catch {
    return null;
  }
}

export async function reelContext(campaign: ReelCampaign, context: InstagramContext | null): Promise<string> {
  const redis = getRedisConnection();
  const key = `setter:ctx:${campaign.id}`;
  const cached = await redis.get(key).catch(() => null);
  if (cached) return cached;

  const resourceUrl = campaign.trackedLinks[0]?.destinationUrl ?? null;
  const [caption, page] = await Promise.all([
    reelCaption(campaign, context),
    resourceUrl ? resourcePage(resourceUrl) : Promise.resolve(null),
  ]);

  const parts = [
    `campaña: ${campaign.name}`,
    `palabras clave que comentan: ${campaign.keywords.join(", ") || "(cualquiera)"}`,
    campaign.setterContext?.trim() ? `notas del dueño sobre este reel:\n${campaign.setterContext.trim()}` : null,
    caption ? `descripción del reel:\n${caption}` : null,
    page ? `contenido del recurso que prometió el reel (lo que le vas a mandar):\n${page}` : null,
  ].filter(Boolean);
  const text = parts.join("\n\n");
  await redis.set(key, text, "EX", CACHE_TTL_SECONDS).catch(() => {});
  return text;
}
