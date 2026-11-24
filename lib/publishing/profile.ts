/**
 * Which Instagram account the carousel and reel publishers work for.
 *
 * "owner" is the owner's own account, the one they always used. "agency" is a
 * second account (AGENCY_INSTAGRAM_USERNAME, default "nodestudio.ai") with its
 * own OpenCloud queue, its own schedule and its own Redis keys, so publishing
 * there never moves the owner's dates. Its settings are the same variables
 * with AGENCY_ in front (AGENCY_CAROUSEL_PUBLISH_ENABLED, AGENCY_REEL_FOLDER...),
 * and it never uses campaigns: nothing there answers comments or DMs.
 *
 * A run picks its profile with withProfile(); everything below reads it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db/client";

export type PublishProfile = "owner" | "agency";
type Env = Record<string, string | undefined>;

const store = new AsyncLocalStorage<PublishProfile>();

export function withProfile<T>(profile: PublishProfile, run: () => Promise<T>): Promise<T> {
  return store.run(profile, run);
}

export function currentProfile(): PublishProfile {
  return store.getStore() ?? "owner";
}

export function isAgency(): boolean {
  return currentProfile() === "agency";
}

/** The agency's Instagram username, lowercase, without @. */
export function agencyUsername(env: Env = process.env): string {
  return (env.AGENCY_INSTAGRAM_USERNAME ?? "nodestudio.ai").trim().replace(/^@/, "").toLowerCase();
}

/** Redis key for the current profile: "carousel:next" or "agency:carousel:next". */
export function profileKey(key: string): string {
  return isAgency() ? `agency:${key}` : key;
}

/** Put in front of every notification title, so the owner knows which account it is about. */
export function titlePrefix(): string {
  return isAgency() ? "Agencia · " : "";
}

/**
 * The publisher's settings for the current profile. The owner reads `env` as
 * it is; the agency reads only its AGENCY_ variables (without the prefix), so
 * none of the owner's settings leak in, plus `defaults` and the time zone.
 */
export function profileEnv(env: Env, defaults: Record<string, string> = {}): Env {
  if (!isAgency()) return env;
  const own: Env = { TRIAL_PUBLISH_TIMEZONE: env.TRIAL_PUBLISH_TIMEZONE, ...defaults };
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("AGENCY_") && value !== undefined) own[name.slice("AGENCY_".length)] = value;
  }
  return own;
}

export type PublishAccount = {
  id: string;
  workspaceId: string;
  instagramId: string;
  accessToken: string;
};

/**
 * The account to publish on. The agency's, by username; never anything else.
 * The owner's, by `instagramId` when set or else the first one connected, and
 * never the agency's even if it was connected first.
 */
export async function profileAccount(instagramId?: string | null): Promise<PublishAccount | null> {
  const select = { id: true, workspaceId: true, instagramId: true, accessToken: true } as const;
  const agency = agencyUsername();
  if (isAgency()) {
    return prisma.instagramAccount.findFirst({
      where: { provider: "META", username: { equals: agency, mode: "insensitive" } },
      select,
    });
  }
  return prisma.instagramAccount.findFirst({
    where: {
      provider: "META",
      ...(instagramId ? { instagramId } : {}),
      NOT: { username: { equals: agency, mode: "insensitive" } },
    },
    orderBy: { connectedAt: "asc" },
    select,
  });
}
