import { NextRequest, NextResponse } from "next/server";
import { hubAccount } from "@/lib/hub/account";
import { setterPeople } from "@/lib/hub/people";
import { hubError, hubGuard, NO_STORE } from "@/lib/hub/route";

export const dynamic = "force-dynamic";

/** What the setter knows of each person: the ones that changed since `desde` (ms), or the ones in `ids`. */
export async function GET(request: NextRequest) {
  const denied = hubGuard(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  const desde = params.get("desde");
  const ids = (params.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  try {
    const account = await hubAccount();
    if (!account) return hubError("La cuenta del Hub no está conectada en OpenReply", 404);
    const since = desde && /^\d{1,15}$/.test(desde) ? Number(desde) : null;
    return NextResponse.json(await setterPeople(account.id, { since: ids.length ? null : since, ids }), { headers: NO_STORE });
  } catch (error) {
    return hubError(error, 500);
  }
}
