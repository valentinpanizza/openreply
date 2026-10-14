/**
 * Settings for the AI setter, all from the worker's environment. The setter is
 * off unless SETTER_ENABLED=true, and while SETTER_ONLY_USERS lists anyone it
 * only talks to them (a test account), everyone else keeps the usual flow.
 */

export function setterEnabled(): boolean {
  return process.env.SETTER_ENABLED === "true";
}

// Set in Redis by a worker running the setter, refreshed with its heartbeat.
// The webhook (on Vercel, which does not see the worker's environment) only
// queues echoes while it is there, so a worker that predates the setter never
// receives a job it does not know.
export const SETTER_ECHOES_FLAG = "setter:echoes";

// Instagram usernames (with or without @) or user ids, comma-separated.
export function setterAllowsUser(username: string | null | undefined, userId: string): boolean {
  const only = (process.env.SETTER_ONLY_USERS ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  if (only.length === 0) return true;
  return only.includes(userId.toLowerCase()) || Boolean(username && only.includes(username.toLowerCase()));
}

export function setterModel(): string {
  return process.env.SETTER_MODEL?.trim() || "claude-haiku-5-5";
}

// A second model that writes its own answer to every turn, stored next to the
// real one and never sent, to compare the two before choosing.
export function setterShadowModel(): string | null {
  return process.env.SETTER_SHADOW_MODEL?.trim() || null;
}

// Spend cap per day (owner's time zone), shadow included. Past it the setter
// hands its conversations to the owner instead of answering.
export function setterDailyBudgetUsd(): number {
  const value = Number(process.env.SETTER_DAILY_BUDGET_USD);
  return Number.isFinite(value) && value > 0 ? value : 0.5;
}

export function ownerTimeZone(): string {
  return process.env.SETTER_OWNER_TIMEZONE?.trim() || "America/Montevideo";
}

export function callMinutes(): number {
  const value = Number(process.env.SETTER_CALL_MINUTES);
  return Number.isFinite(value) && value >= 10 ? value : 30;
}

export const AUDIO_KEYS = ["presentacion", "pitch", "precio", "agendado"] as const;
export type AudioKey = (typeof AUDIO_KEYS)[number];

// SETTER_AUDIOS="presentacion=https://a.m4a|https://b.m4a;pitch=https://c.m4a"
// Several files per key: one is picked at random each time.
export function setterAudios(raw = process.env.SETTER_AUDIOS ?? ""): Partial<Record<AudioKey, string[]>> {
  const audios: Partial<Record<AudioKey, string[]>> = {};
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim() as AudioKey;
    if (!AUDIO_KEYS.includes(key)) continue;
    const urls = part
      .slice(at + 1)
      .split("|")
      .map((url) => url.trim())
      .filter((url) => /^https:\/\//.test(url));
    if (urls.length > 0) audios[key] = urls;
  }
  return audios;
}
