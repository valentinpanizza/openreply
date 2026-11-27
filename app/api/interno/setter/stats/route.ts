import { NextRequest, NextResponse } from "next/server";
import { hubAccount } from "@/lib/hub/account";
import { hubError, hubGuard, NO_STORE } from "@/lib/hub/route";
import { hubSetterPanel, parseRange } from "@/lib/hub/stats";

export const dynamic = "force-dynamic";

/** The setter's numbers for the Hub's "Setter Valentin" (money included: the Hub splits it off). */
export async function GET(request: NextRequest) {
  const denied = hubGuard(request);
  if (denied) return denied;
  try {
    const account = await hubAccount();
    if (!account) return hubError("La cuenta del Hub no está conectada en OpenReply", 404);
    const panel = await hubSetterPanel(account.id, parseRange(request.nextUrl.searchParams.get("range")));
    return NextResponse.json(panel, { headers: NO_STORE });
  } catch (error) {
    return hubError(error, 500);
  }
}
