/**
 * Rate Limiter
 *
 * Redis-based rate limiter for Instagram private replies.
 *
 * The cap matches Meta's documented limit for this exact call: 750 private
 * replies per hour per Instagram professional account, for comments on posts
 * and reels. Exceeding it risks 429s and app-level restrictions, so the worker
 * requeues rather than pushing through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * Note this is a hard ceiling with no headroom. If Meta throttles before the
 * documented limit, or other calls on the same account share the bucket, lower
 * this value.
 */

import Redis from "ioredis";

const RATE_LIMIT_MAX = 750; // private replies per hour, per Meta's documented cap
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const REQUEUE_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REQUEUE_ATTEMPTS = 3;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

const RESERVE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if current >= max then
  return {0, current, 0}
end

local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 then
  redis.call("EXPIRE", KEYS[1], ttl)
end

return {1, next_count, max - next_count}
`;

function toScriptNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(
  count: number,
  requeueAttempt: number
): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }

  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Uses a Redis counter with a 1-hour TTL per account.
 * Key pattern: `rate:dm:{instagramAccountId}`
 *
 * @param instagramAccountId - The Instagram account ID to check
 * @param requeueAttempt - How many times this job has been requeued (0 = first attempt)
 * @returns Rate limit result with action recommendations
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const currentCount = await client.get(key);
  const count = currentCount ? parseInt(currentCount, 10) : 0;

  if (count >= RATE_LIMIT_MAX) {
    // Over the limit
    if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
      // Exceeded max requeue attempts — skip this DM
      return {
        allowed: false,
        currentCount: count,
        remainingDMs: 0,
        shouldRequeue: false,
        requeueDelayMs: 0,
        shouldSkip: true,
        reserved: false,
      };
    }

    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: REQUEUE_DELAY_MS,
      shouldSkip: false,
      reserved: false,
    };
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 * This is the worker-safe path; it prevents concurrent jobs from all passing
 * the rate-limit check before any of them increments the Redis counter.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    1,
    key,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW
  );
  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toScriptNumber(values[0]);
  const count = toScriptNumber(values[1]);
  const remaining = toScriptNumber(values[2]);

  if (allowedFlag !== 1) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/**
 * Release a DM slot previously taken by reserveDMSlot.
 *
 * reserveDMSlot increments the hourly counter before the send, so concurrent
 * jobs can't all pass the check at once. When that send then fails (closed
 * messaging window, expired token, rejected reply) the reserved slot is never
 * used and must be handed back. Otherwise a comment that never delivers a DM
 * still burns one slot per attempt, and BullMQ's retries burn several. On a
 * post with many failing sends the counter inflates past the real number of
 * DMs and legitimate replies get skipped as rate-limited until the TTL expires.
 *
 * DECR is atomic and preserves the key's TTL, so the hourly window still resets
 * when it originally would. A missing key (the window already rolled over)
 * would decrement to -1 with no expiry, so that case is clamped back to zero.
 */
export async function releaseDMSlot(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const next = await client.decr(key);
  if (next < 0) {
    await client.del(key);
    return 0;
  }
  return next;
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in workers.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const count = await client.get(key);
  return count ? parseInt(count, 10) : 0;
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  await client.del(key);
}

// ─── Pacing ────────────────────────────────────────────────────────────────────
//
// Spaces an account's private replies out to one every `intervalMs`, on top of
// the hourly cap above. Instagram throttled this account hard when a viral reel
// sent private replies in bursts, and a refused private reply is lost for good
// (the comment cannot take another), while a delayed one is not: a comment can
// take its private reply for 7 days. So a send that would come too soon is
// scheduled for its turn instead of attempted now.

// Hands out turns in order: the next free turn is max(now, last turn +
// interval). Returns -1 when that is further out than the maximum wait.
const RESERVE_PACE_SLOT_SCRIPT = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local max_wait = tonumber(ARGV[3])
local next_free = tonumber(redis.call("GET", KEYS[1]) or "0")
local slot = math.max(now, next_free)
if slot - now > max_wait then
  return -1
end
redis.call("SET", KEYS[1], string.format("%.0f", slot + interval), "PX", math.floor(max_wait + interval + 3600000))
return string.format("%.0f", slot)
`;

/**
 * Reserve this account's next private-reply turn. Returns when (epoch ms) the
 * send may go out — `now` if it is free — or null when the queue is already
 * longer than `maxWaitMs`.
 */
export async function reservePaceSlot(
  instagramAccountId: string,
  intervalMs: number,
  maxWaitMs: number,
  now: number = Date.now()
): Promise<number | null> {
  const result = await getRedis().eval(
    RESERVE_PACE_SLOT_SCRIPT,
    1,
    `pace:dm:${instagramAccountId}`,
    now,
    intervalMs,
    maxWaitMs
  );
  const slot = toScriptNumber(result);
  return slot < 0 ? null : slot;
}

// A comment waiting for its turn. Every reconciler sweep re-enqueues a comment
// that is not yet answered, and without this each copy would take another turn.
export async function markPaced(
  instagramAccountId: string,
  commentId: string,
  ttlMs: number
): Promise<void> {
  await getRedis().set(`paced:${instagramAccountId}:${commentId}`, "1", "PX", Math.ceil(ttlMs));
}

export async function isPaced(
  instagramAccountId: string,
  commentId: string
): Promise<boolean> {
  return (await getRedis().exists(`paced:${instagramAccountId}:${commentId}`)) === 1;
}

// ─── Breaker ───────────────────────────────────────────────────────────────────
//
// Stops private replies on its own when Instagram starts refusing them. After
// the account was flagged, Instagram refused first messages to strangers in
// waves that opened and closed for hours, and the worker kept sending into
// them: ~600 refusals in a day and a half, each one more of the very signal
// that keeps the account flagged. Pacing did not help — the refusals were not
// about volume. So the last `window` first attempts are kept, and once
// `threshold` of them were refused the breaker opens for `pauseMs`: comments
// get the paused public reply (ask for a DM) until it closes on its own.

// KEYS[1] recent outcomes ("1" refused, "0" sent), KEYS[2] the breaker.
// Returns the refusals counted when this call opened the breaker, else 0.
const RECORD_PRIVATE_REPLY_SCRIPT = `
local window = tonumber(ARGV[2])
redis.call("LPUSH", KEYS[1], ARGV[1])
redis.call("LTRIM", KEYS[1], 0, window - 1)
redis.call("PEXPIRE", KEYS[1], 604800000)
if ARGV[1] ~= "1" then
  return 0
end
local refused = 0
for _, outcome in ipairs(redis.call("LRANGE", KEYS[1], 0, -1)) do
  if outcome == "1" then
    refused = refused + 1
  end
end
if refused < tonumber(ARGV[3]) then
  return 0
end
-- Start clean once it closes: the refusals that opened it are spent.
redis.call("DEL", KEYS[1])
local opened = redis.call("SET", KEYS[2], ARGV[5], "PX", ARGV[4], "NX")
if opened then
  return refused
end
return 0
`;

/**
 * Record how a first private reply went. Returns the number of refusals that
 * opened the breaker when this call opened it, or 0.
 */
export async function recordPrivateReplyOutcome(
  instagramAccountId: string,
  refused: boolean,
  { window, threshold, pauseMs }: { window: number; threshold: number; pauseMs: number },
  now: number = Date.now()
): Promise<number> {
  const result = await getRedis().eval(
    RECORD_PRIVATE_REPLY_SCRIPT,
    2,
    `breaker:outcomes:${instagramAccountId}`,
    `breaker:open:${instagramAccountId}`,
    refused ? "1" : "0",
    window,
    threshold,
    Math.ceil(pauseMs),
    Math.ceil(now + pauseMs)
  );
  return toScriptNumber(result);
}

/** When the open breaker closes (epoch ms), or null when it is closed. */
export async function privateReplyBreakerUntil(
  instagramAccountId: string
): Promise<number | null> {
  const until = Number(await getRedis().get(`breaker:open:${instagramAccountId}`));
  return until > 0 ? until : null;
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };
