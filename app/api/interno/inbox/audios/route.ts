import { NextRequest, NextResponse } from "next/server";
import { hubAudios } from "@/lib/hub/people";
import { hubGuard, NO_STORE } from "@/lib/hub/route";

export const dynamic = "force-dynamic";

/** The setter's recorded audios, to send them by hand from the Hub. */
export async function GET(request: NextRequest) {
  const denied = hubGuard(request);
  if (denied) return denied;
  return NextResponse.json({ audios: hubAudios() }, { headers: NO_STORE });
}
