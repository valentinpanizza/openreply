import { NextRequest, NextResponse } from "next/server";
import { hubAccessToken, hubAccount, HubAccountError } from "@/lib/hub/account";
import { conversationMessages } from "@/lib/hub/graph";
import { hubError, hubGuard, NO_STORE } from "@/lib/hub/route";

export const dynamic = "force-dynamic";

/** The latest messages of one conversation (Meta gives the last 20), newest first, as Meta returns them. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = hubGuard(request);
  if (denied) return denied;
  const { id } = await params;
  if (!/^[\w-]{1,200}$/.test(id)) return hubError("Conversación inválida", 400);
  try {
    const { token } = await hubAccessToken(await hubAccount());
    return NextResponse.json({ mensajes: await conversationMessages(token, id) }, { headers: NO_STORE });
  } catch (error) {
    return hubError(error, error instanceof HubAccountError ? 404 : 502);
  }
}
