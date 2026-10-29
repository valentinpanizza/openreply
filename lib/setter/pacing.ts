import { RateLimitError } from "@/lib/meta/client";
import { getRedisConnection } from "@/lib/queue/client";
import { ownerTimeZone } from "./config";

/**
 * Instagram caps how often an account can send messages (error 368, "we limit
 * how often you can..."): an action block that grows when the account keeps
 * trying. So when the setter runs into it, it stops sending for hours
 * (SETTER_RATE_LIMIT_PAUSE_MINUTES), never ending the pause at night, and the
 * answers waiting meanwhile go out afterwards, one at a time. Every answer
 * also keeps a distance from the previous one (SETTER_REPLY_SPACING_SECONDS),
 * never the same twice: a fixed beat is what a script looks like. It is
 * minutes, not seconds: at 20 s the backlog of a pause went out as ~90
 * messages in half an hour (26/10) and Instagram blocked the account again.
 * SETTER_HOLD_UNTIL (an ISO date) holds every send until then, by hand.
 */

// Instagram only takes a reply within 24 h of the person's last message.
const REPLY_WINDOW_MS = 22 * 3600_000;

// A pause that would end at night (owner's hours) ends in the morning instead.
const MORNING_HOUR = 8;

export function isRateLimited(error: unknown): boolean {
  return error instanceof RateLimitError;
}

export function rateLimitPauseMs(): number {
  const value = Number(process.env.SETTER_RATE_LIMIT_PAUSE_MINUTES);
  return (Number.isFinite(value) && value > 0 ? value : 360) * 60_000;
}

export function replySpacingMs(): number {
  const value = Number(process.env.SETTER_REPLY_SPACING_SECONDS);
  return (Number.isFinite(value) && value >= 0 ? value : 150) * 1000;
}

/** A time around `ms` (from 75% to 225% of it), different every call. */
export function jittered(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.75 + random() * 1.5));
}

export function holdUntil(): number {
  const value = Date.parse(process.env.SETTER_HOLD_UNTIL ?? "");
  return Number.isFinite(value) ? value : 0;
}

/** When a pause from `now` ends: about rateLimitPauseMs(), pushed past the night. */
export function pauseEnd(now: number, random: () => number = Math.random): number {
  const end = now + Math.round(rateLimitPauseMs() * (0.85 + random() * 0.3));
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: ownerTimeZone(), hour: "numeric", hourCycle: "h23" }).format(end)
  );
  if (hour >= MORNING_HOUR) return end;
  // Up to the morning hour, then some minutes more so it is not on the hour.
  return end + (MORNING_HOUR - hour) * 3600_000 + Math.round(random() * 45 * 60_000);
}

/** Whether an answer to a message received at `lastUserAt` can still go out. */
export function withinReplyWindow(lastUserAt: Date | null, now: number): boolean {
  return lastUserAt !== null && now - lastUserAt.getTime() < REPLY_WINDOW_MS;
}

const pauseKey = (instagramId: string) => `setter:paused:${instagramId}`;
const slotKey = (instagramId: string) => `setter:next:${instagramId}`;
const heldSlotKey = (conversationId: string) => `setter:slot:${conversationId}`;

/** Stops the setter's sends for this account. True if it was not paused already. */
export async function pauseSending(instagramId: string, now = Date.now()): Promise<boolean> {
  const end = pauseEnd(now);
  const fresh = await getRedisConnection().set(pauseKey(instagramId), String(end), "PX", end - now, "NX");
  return fresh === "OK";
}

export async function pausedUntil(instagramId: string): Promise<number> {
  const paused = Number(await getRedisConnection().get(pauseKey(instagramId))) || 0;
  return Math.max(paused, holdUntil());
}

/**
 * Takes the next free moment to send for this account (after the pause and
 * after the last one taken) and returns it. The caller sends then (now, when
 * it is now) and nobody else gets that moment.
 * With `conversationId`, a conversation that already holds a moment still
 * ahead keeps it: someone who writes again while waiting would otherwise go
 * to the back of the line and leave a hole where their old turn was (29/10:
 * after the 24 h pause, 52 such holes left the setter silent for 4 h).
 */
export async function reserveSlot(instagramId: string, now = Date.now(), conversationId?: string): Promise<number> {
  const result = await getRedisConnection().eval(
    `local paused = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
     local free = tonumber(redis.call('GET', KEYS[2]) or '0') or 0
     local now = tonumber(ARGV[1])
     local hold = tonumber(ARGV[3])
     if KEYS[3] ~= '' then
       local held = tonumber(redis.call('GET', KEYS[3]) or '0') or 0
       if held >= now and held >= paused and held >= hold then return tostring(held) end
     end
     local slot = math.max(now, paused, free, hold)
     local after = slot + tonumber(ARGV[2])
     redis.call('SET', KEYS[2], tostring(after), 'PX', after - now + 3600000)
     if KEYS[3] ~= '' then redis.call('SET', KEYS[3], tostring(slot), 'PX', slot - now + 3600000) end
     return tostring(slot)`,
    3,
    pauseKey(instagramId),
    slotKey(instagramId),
    conversationId ? heldSlotKey(conversationId) : "",
    String(now),
    String(jittered(replySpacingMs())),
    String(holdUntil())
  );
  return Number(result);
}
