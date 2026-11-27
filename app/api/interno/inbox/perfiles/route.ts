import { NextRequest, NextResponse } from "next/server";
import { hubAccessToken, hubAccount, HubAccountError } from "@/lib/hub/account";
import { profiles } from "@/lib/hub/graph";
import { hubError, hubGuard, NO_STORE } from "@/lib/hub/route";

export const dynamic = "force-dynamic";

const MAX_IDS = 25;

/** Name, @, picture, followers and whether they follow the account, for up to 25 people (`ids`, comma separated). */
export async function GET(request: NextRequest) {
  const denied = hubGuard(request);
  if (denied) return denied;
  const ids = (request.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d{1,40}$/.test(id))
    .slice(0, MAX_IDS);
  if (!ids.length) return NextResponse.json({ perfiles: [] }, { headers: NO_STORE });
  try {
    const { token } = await hubAccessToken(await hubAccount());
    return NextResponse.json({ perfiles: await profiles(token, ids) }, { headers: NO_STORE });
  } catch (error) {
    return hubError(error, error instanceof HubAccountError ? 404 : 502);
  }
}
