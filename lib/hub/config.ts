/**
 * The NodeStudio Hub (hub.nodestudioai.com) shows this account's Instagram
 * inbox and the setter's numbers, and lets the owner write from there.
 *
 * - HUB_URL: where the Hub lives. Every DM and echo of the account is
 *   forwarded to `${HUB_URL}/api/webhooks/openreply`, signed with HUB_CLAVE.
 * - HUB_CLAVE: one long random secret shared with the Hub (OPENREPLY_CLAVE
 *   there). The Hub sends it as a Bearer token to /api/interno/*, and the
 *   forwarded events carry an HMAC-SHA256 of the body made with it.
 * - HUB_IG_ACCOUNT: the username of the account the Hub reads
 *   (valentinpanizza by default).
 *
 * With HUB_CLAVE unset (or shorter than 32 characters) nothing is forwarded
 * and every /api/interno route answers 503.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export function hubUrl(env: Env = process.env): string | null {
  const url = env.HUB_URL?.trim().replace(/\/+$/, "");
  return url && /^https?:\/\//.test(url) ? url : null;
}

export function hubKey(env: Env = process.env): string | null {
  const key = env.HUB_CLAVE?.trim();
  return key && key.length >= 32 ? key : null;
}

export function hubAccountUsername(env: Env = process.env): string {
  return (env.HUB_IG_ACCOUNT?.trim() || "valentinpanizza").replace(/^@/, "").toLowerCase();
}

export function hubForwardEnabled(env: Env = process.env): boolean {
  return Boolean(hubUrl(env) && hubKey(env));
}

/** `Authorization: Bearer <HUB_CLAVE>`, compared in constant time. */
export function isHubRequest(authorization: string | null | undefined, env: Env = process.env): boolean {
  const key = hubKey(env);
  if (!key || !authorization?.startsWith("Bearer ")) return false;
  const given = Buffer.from(authorization.slice(7).trim());
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The signature of a body sent to the Hub (`X-OpenReply-Firma`): HMAC-SHA256 in hex. */
export function signForHub(body: string, key: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}
