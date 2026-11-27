import { NextResponse } from "next/server";
import { hubKey, isHubRequest } from "./config";

export const NO_STORE = { "Cache-Control": "no-store" };

/** For /api/interno/* routes: null when the Hub's key is right, otherwise the answer to give. */
export function hubGuard(request: Request): NextResponse | null {
  if (!hubKey()) {
    return NextResponse.json({ error: "HUB_CLAVE is not set" }, { status: 503, headers: NO_STORE });
  }
  if (!isHubRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  return null;
}

export function hubError(error: unknown, status = 502): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}
