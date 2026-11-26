/**
 * One gate for every message the account sends.
 *
 * Each feature paces itself (private replies, setter replies, follow-ups,
 * reminders, lead audios…), but they pace independently, and retries and
 * backlogs after an outage bypass the pacing: on 26/11 a backlog went out at
 * ~8 messages a minute and Instagram blocked the account. This gate sits right
 * before the HTTP call in the Meta client, so no code path can skip it:
 *
 * - at least SEND_MIN_GAP_SECONDS (45) between any two messages of the same
 *   account, plus a random 0–50% so the rhythm is never mechanical;
 * - at most SEND_MAX_PER_HOUR (60) messages in any rolling hour.
 *
 * The check and the reservation are one Redis script, so jobs running at the
 * same time (the worker runs 5) can never both pass. A send that has to wait
 * sleeps in place: it never fails, never burns a retry, and never re-runs the
 * work done before it (a usage reservation, a Claude call, a message already
 * sent in the same turn).
 *
 * If Redis cannot be reached the gate keeps waiting instead of letting the
 * message through, and gives up (throws) after SEND_GATE_MAX_WAIT_MINUTES.
 */

import Redis from "ioredis";

const HOUR_MS = 3_600_000;

// Returns 0 and records the send when allowed; otherwise the ms to wait.
const GATE_SCRIPT = `
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local member = ARGV[4]
local hour = 3600000

redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now - hour)

local wait = 0
local nextAt = tonumber(redis.call("GET", KEYS[1]) or "0")
if nextAt > now then wait = nextAt - now end

if cap > 0 and redis.call("ZCARD", KEYS[2]) >= cap then
  local oldest = redis.call("ZRANGE", KEYS[2], 0, 0, "WITHSCORES")
  local free = tonumber(oldest[2]) + hour - now
  if free > wait then wait = free end
end

if wait > 0 then return wait end

redis.call("SET", KEYS[1], now + gap, "PX", gap + 60000)
redis.call("ZADD", KEYS[2], now, member)
redis.call("PEXPIRE", KEYS[2], hour + 60000)
return 0
`;

export interface SendGateConfig {
  minGapMs: number;
  jitter: number; // extra gap, as a fraction of minGapMs (0.5 = up to +50%)
  maxPerHour: number; // 0 = no hourly cap
  maxWaitMs: number;
}

export function sendGateConfig(env: Record<string, string | undefined> = process.env): SendGateConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    // Floor of 20 s whatever the .env says: the point is that two messages can
    // never leave together.
    minGapMs: Math.max(20, num(env.SEND_MIN_GAP_SECONDS, 45)) * 1000,
    jitter: Math.min(2, num(env.SEND_GAP_JITTER, 0.5)),
    maxPerHour: num(env.SEND_MAX_PER_HOUR, 60),
    // On Vercel (a manual send from the dashboard) a request cannot sleep for
    // minutes: wait a little and otherwise fail, asking to retry.
    maxWaitMs: env.VERCEL
      ? 25_000
      : Math.max(1, num(env.SEND_GATE_MAX_WAIT_MINUTES, 180)) * 60_000,
  };
}

/** Which gap this send reserves: the floor plus a random extra. */
export function gapWithJitter(cfg: SendGateConfig, random = Math.random): number {
  return Math.round(cfg.minGapMs * (1 + cfg.jitter * random()));
}

export class SendGateTimeoutError extends Error {
  constructor(channel: string, waitedMs: number) {
    super(`Send gate for ${channel}: no slot after ${Math.round(waitedMs / 60000)} min`);
    this.name = "SendGateTimeoutError";
  }
}

export interface SendGateDeps {
  evalGate: (keys: [string, string], args: (string | number)[]) => Promise<number>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (msg: string) => void;
}

let redis: Redis | null = null;
function gateRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
    redis.on("error", () => {});
  }
  return redis;
}

const defaultDeps: SendGateDeps = {
  evalGate: async (keys, args) =>
    Number(await gateRedis().eval(GATE_SCRIPT, 2, ...keys, ...args.map(String))),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  log: (msg) => console.log(msg),
};

function gateDisabled(): boolean {
  // Unit tests exercise the Meta client with a mocked fetch and no Redis.
  return Boolean(process.env.VITEST) && process.env.SEND_GATE !== "on";
}

/**
 * Wait until this account may send one more message, and reserve it.
 * `channel` identifies the sending account, e.g. "ig:<igUserId>".
 */
export async function waitForSendSlot(
  channel: string,
  deps: SendGateDeps = defaultDeps,
  cfg: SendGateConfig = sendGateConfig()
): Promise<void> {
  if (deps === defaultDeps && gateDisabled()) return;

  const keys: [string, string] = [`sendgate:${channel}:next`, `sendgate:${channel}:hour`];
  const start = deps.now();
  let logged = false;

  for (;;) {
    let wait: number;
    try {
      const now = deps.now();
      wait = await deps.evalGate(keys, [
        now,
        gapWithJitter(cfg, deps.random),
        cfg.maxPerHour,
        `${now}:${Math.floor(deps.random() * 1e9)}`,
      ]);
    } catch (error) {
      // Fail closed: no Redis, no send.
      deps.log(`[SendGate] ${channel}: Redis error, waiting (${error instanceof Error ? error.message : error})`);
      wait = 5_000;
    }
    if (wait <= 0) return;

    if (deps.now() - start + wait > cfg.maxWaitMs) {
      throw new SendGateTimeoutError(channel, deps.now() - start);
    }
    if (!logged && wait > 60_000) {
      deps.log(`[SendGate] ${channel}: waiting ${Math.round(wait / 1000)} s for a send slot`);
      logged = true;
    }
    // Re-check at least every 30 s (and with a little noise so the 5 jobs
    // waiting do not all ask at the same instant).
    await deps.sleep(Math.min(wait, 30_000) + Math.floor(deps.random() * 500));
  }
}

export { GATE_SCRIPT, HOUR_MS };
