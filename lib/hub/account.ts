import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/context";
import { hubAccountUsername } from "./config";

export type HubAccount = {
  id: string;
  workspaceId: string;
  instagramId: string;
  username: string;
  provider: "META" | "ZERNIO";
  zernioAccountId: string | null;
  accessToken: string;
};

const CACHE_MS = 60_000;
let cached: { at: number; account: HubAccount | null } | null = null;

/** The connection of the account the Hub reads (HUB_IG_ACCOUNT), cached for a minute. */
export async function hubAccount(): Promise<HubAccount | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.account;
  const account = await prisma.instagramAccount.findFirst({
    where: { username: { equals: hubAccountUsername(), mode: "insensitive" } },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      workspaceId: true,
      instagramId: true,
      username: true,
      provider: true,
      zernioAccountId: true,
      accessToken: true,
    },
  });
  cached = { at: Date.now(), account };
  return account;
}

export class HubAccountError extends Error {}

/** The account's Instagram token. The Hub inbox only works with a direct Meta connection. */
export async function hubAccessToken(account: HubAccount | null): Promise<{ account: HubAccount; token: string }> {
  if (!account) throw new HubAccountError(`La cuenta @${hubAccountUsername()} no está conectada en OpenReply`);
  if (account.provider !== "META") throw new HubAccountError("El inbox del Hub necesita la cuenta conectada directo a Meta");
  const context = await createInstagramContext(account);
  if (context.provider !== "META") throw new HubAccountError("El inbox del Hub necesita la cuenta conectada directo a Meta");
  return { account, token: context.accessToken };
}
