import { NextRequest, NextResponse } from "next/server";
import { hubAccessToken, hubAccount, HubAccountError } from "@/lib/hub/account";
import { listConversations } from "@/lib/hub/graph";
import { hubError, hubGuard, NO_STORE } from "@/lib/hub/route";

export const dynamic = "force-dynamic";

/** One page of the account's conversations, most recently updated first (`after` = cursor; `usuario` = one person). */
export async function GET(request: NextRequest) {
  const denied = hubGuard(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  try {
    const { account, token } = await hubAccessToken(await hubAccount());
    const page = await listConversations(token, account.instagramId, {
      after: params.get("after"),
      userId: params.get("usuario"),
      limit: Number(params.get("limite")) || 25,
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    return hubError(error, error instanceof HubAccountError ? 404 : 502);
  }
}
