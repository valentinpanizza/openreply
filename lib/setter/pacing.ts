import { RateLimitError } from "@/lib/meta/client";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Instagram caps how often an account can send messages (error 368, "we limit
 * how often you can..."). Retrying right away keeps hitting the cap, so when
 * the setter runs into it, it stops sending for a while (SETTER_RATE_LIMIT_
 * PAUSE_MINUTES) and the answers waiting meanwhile go out afterwards, one at a
 * time. Every answer also keeps a little distance from the previous one
 * (SETTER_REPLY_SPACING_SECONDS), so a busy hour does not come out in bursts.
 */

// Instagram only takes a reply within 24 h of the person's last message.
const REPLY_WINDOW_MS = 22 * 3600_000;

export function isRateLimited(error: unknown): boolean {
  return error instanceof RateLimitError;
}

export function rateLimitPauseMs(): number {
  const value = Number(process.env.SETTER_RATE_LIMIT_PAUSE_MINUTES);
  return (Number.isFinite(value) && value > 0 ? value : 30) * 60_000;
}

export function replySpacingMs(): number {
  const value = Number(process.env.SETTER_REPLY_SPACING_SECONDS);
  return (Number.isFinite(value) && value >= 0 ? value : 20) * 1000;
}

/** Whether an answer to a message received at `lastUserAt` can still go out. */
export function withinReplyWindow(lastUserAt: Date | null, now: number): boolean {
  return lastUserAt !== null && now - lastUserAt.getTime() < REPLY_WINDOW_MS;
}

const pauseKey = (instagramId: string) => `setter:paused:${instagramId}`;
const slotKey = (instagramId: string) => `setter:next:${instagramId}`;

/** Stops the setter's sends for this account. True if it was not paused already. */
export async function pauseSending(instagramId: string, now = Date.now()): Promise<boolean> {
  const pause = rateLimitPauseMs();
  const fresh = await getRedisConnection().set(pauseKey(instagramId), String(now + pause), "PX", pause, "NX");
  return fresh === "OK";
}

export async function pausedUntil(instagramId: string): Promise<number> {
  return Number(await getRedisConnection().get(pauseKey(instagramId))) || 0;
}

/**
 * Takes the next free moment to send for this account (after the pause and
 * after the last one taken) and returns it. The caller sends then (now, when
 * it is now) and nobody else gets that moment.
 */
export async function reserveSlot(instagramId: string, now = Date.now()): Promise<number> {
  const result = await getRedisConnection().eval(
    `local paused = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
     local free = tonumber(redis.call('GET', KEYS[2]) or '0') or 0
     local now = tonumber(ARGV[1])
     local slot = math.max(now, paused, free)
     local after = slot + tonumber(ARGV[2])
     redis.call('SET', KEYS[2], tostring(after), 'PX', after - now + 3600000)
     return tostring(slot)`,
    2,
    pauseKey(instagramId),
    slotKey(instagramId),
    String(now),
    String(replySpacingMs())
  );
  return Number(result);
}
