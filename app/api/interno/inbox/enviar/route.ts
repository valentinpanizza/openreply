import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getHubSendQueue } from "@/lib/hub/queue";
import { hubError, hubGuard, NO_STORE } from "@/lib/hub/route";

export const dynamic = "force-dynamic";

const httpsUrl = z.string().url().max(2000).refine((url) => url.startsWith("https://"), "La URL tiene que ser https");

const Body = z.union([
  z.object({
    clave: z.string().min(8).max(200),
    usuario: z.string().regex(/^\d{1,40}$/),
    texto: z.string().trim().min(1).max(1000),
    etiqueta: z.boolean().default(false),
  }),
  z.object({
    clave: z.string().min(8).max(200),
    usuario: z.string().regex(/^\d{1,40}$/),
    adjunto: z.object({ tipo: z.enum(["image", "audio"]), url: httpsUrl }),
    etiqueta: z.boolean().default(false),
  }),
  z.object({
    clave: z.string().min(8).max(200),
    usuario: z.string().regex(/^\d{1,40}$/),
    reaccion: z.object({ mid: z.string().min(1).max(500), emoji: z.string().max(16).nullable() }),
  }),
]);

/**
 * A message (or a heart) written from the Hub. Only queued: the worker sends
 * it through the send gate and tells the Hub how it went
 * (POST /api/webhooks/openreply, tipo "envio" or "reaccion"). The same clave
 * queued twice is one job.
 */
export async function POST(request: NextRequest) {
  const denied = hubGuard(request);
  if (denied) return denied;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return hubError(parsed.error.issues[0]?.message ?? "Cuerpo inválido", 400);
  const body = parsed.data;
  const job =
    "reaccion" in body
      ? { kind: "reaction" as const, clave: body.clave, userId: body.usuario, mid: body.reaccion.mid, emoji: body.reaccion.emoji }
      : {
          kind: "message" as const,
          clave: body.clave,
          userId: body.usuario,
          tag: body.etiqueta,
          ...("texto" in body ? { text: body.texto } : { attachment: { type: body.adjunto.tipo, url: body.adjunto.url } }),
        };
  try {
    await getHubSendQueue().add("send", job, { jobId: `send_${Buffer.from(body.clave).toString("base64url")}` });
  } catch (error) {
    return hubError(error, 503);
  }
  return NextResponse.json({ encolado: true }, { status: 202, headers: NO_STORE });
}
