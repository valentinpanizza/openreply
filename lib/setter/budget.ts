import { getRedisConnection } from "@/lib/queue/client";
import { ownerTimeZone, setterDailyBudgetUsd } from "./config";

// USD per million tokens. Cache writes cost 1.25x the input rate.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, usage: TokenUsage): number {
  // An unknown model is priced as the most expensive one, so the cap still holds.
  const price = PRICES[model] ?? PRICES["claude-opus-5-5"];
  return (
    (usage.input_tokens * price.input +
      (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25 +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      usage.output_tokens * price.output) /
    1_000_000
  );
}

function dayKey(now = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ownerTimeZone() }).format(now);
  return `setter:spend:${day}`;
}

export async function recordSpend(usd: number): Promise<void> {
  if (!(usd > 0)) return;
  const redis = getRedisConnection();
  const key = dayKey();
  await redis.incrbyfloat(key, usd);
  await redis.expire(key, 3 * 24 * 3600);
}

export async function spentToday(): Promise<number> {
  return Number((await getRedisConnection().get(dayKey())) ?? 0);
}

export async function budgetLeft(): Promise<boolean> {
  return (await spentToday()) < setterDailyBudgetUsd();
}
