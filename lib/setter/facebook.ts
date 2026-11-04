/**
 * The setter on the Facebook Page (Messenger). Reels cross-posted to Facebook
 * get comments OpenReply never sees: a "Comment to message" automation in Meta
 * Business Suite sends the first message with the link, and when the person
 * answers, the setter carries on from there. The automation's message reaches
 * us as an echo, and its link says which campaign the person came from.
 *
 * A conversation here belongs to the same connection as the Instagram ones
 * (bookings, leads and reports work the same) with channel "facebook". Its
 * pacing is separate: an Instagram block does not hold Facebook back, or the
 * other way around. Off unless FB_SETTER_ENABLED=true.
 */

export const FACEBOOK_CHANNEL = "facebook";

// Set in Redis by a worker running this, like SETTER_ECHOES_FLAG: the webhook
// only queues these jobs while a worker that knows them is there.
export const SETTER_FACEBOOK_FLAG = "setter:facebook";

export function facebookSetterEnabled(): boolean {
  return process.env.FB_SETTER_ENABLED === "true" && Boolean(process.env.FB_PAGE_TOKEN);
}

export function facebookAllowsUser(userId: string): boolean {
  const only = (process.env.FB_SETTER_ONLY_USERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return only.length === 0 || only.includes(userId);
}

/** The key the Page's sends are paced under (pacing.ts), apart from Instagram's. */
export function facebookPacingKey(pageId: string | undefined = process.env.FB_PAGE_ID): string {
  return `fb:${pageId ?? "page"}`;
}

export function firstUrl(text: string): string | null {
  return /https?:\/\/[^\s<>"]+/i.exec(text)?.[0].replace(/[.,;:!?)]+$/, "") ?? null;
}

/** The ways the same link can be stored: with and without the trailing slash. */
export function urlVariants(url: string): string[] {
  const bare = url.replace(/\/+$/, "");
  return [bare, `${bare}/`];
}

/**
 * Several campaigns can share a resource (a reel and its trials): the main
 * one, active first and then the newest.
 */
export function pickCampaign<T extends { name: string; isActive: boolean; createdAt: Date }>(campaigns: T[]): T | null {
  const rank = (c: T) => (c.isActive ? 0 : 2) + (/^\[/.test(c.name) ? 1 : 0);
  return (
    [...campaigns].sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  );
}
