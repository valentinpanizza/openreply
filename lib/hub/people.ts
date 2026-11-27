/**
 * What the setter knows of each person, for the Hub's inbox: its tags (reached
 * the pitch, has a business, booked a call…) and the side panel.
 */

import { prisma } from "@/lib/db/client";
import { AUDIO_KEYS, setterAudios, type AudioKey } from "@/lib/setter/config";

export const PITCH_PHASES = ["pitch", "agendando", "agendado"];
const MAX_PEOPLE = 500;

export type HubPerson = {
  igsid: string;
  usuario: string | null;
  canal: string;
  estado: string;
  fase: string;
  fit: string | null;
  notas: string | null;
  campana: string | null;
  inicio: number;
  actualizado: number;
  recursoEn: number | null;
  agendadoEn: number | null;
  llamadaEn: number | null;
  pitch: boolean;
};

const ms = (at: Date | null | undefined) => (at ? at.getTime() : null);

/** The people whose conversation changed since `since` (ms), or the ones in `ids`. */
export async function setterPeople(
  connectionId: string,
  options: { since?: number | null; ids?: string[] }
): Promise<{ ahora: number; personas: HubPerson[] }> {
  const ahora = Date.now();
  const where = {
    instagramAccountId: connectionId,
    channel: "instagram",
    ...(options.ids?.length ? { userId: { in: options.ids.slice(0, MAX_PEOPLE) } } : {}),
    ...(options.since != null ? { updatedAt: { gte: new Date(options.since) } } : {}),
  };
  const rows = await prisma.setterConversation.findMany({ where, orderBy: { updatedAt: "asc" }, take: MAX_PEOPLE });
  const pitchAudios = rows.length
    ? await prisma.setterMessage.findMany({
        where: { conversationId: { in: rows.map((r) => r.id) }, role: "bot", kind: "audio", text: "[audio: pitch]" },
        select: { conversationId: true },
        distinct: ["conversationId"],
      })
    : [];
  const pitched = new Set(pitchAudios.map((m) => m.conversationId));
  const campaignIds = [...new Set(rows.map((r) => r.automationId).filter((id): id is string => Boolean(id)))];
  const campaigns = campaignIds.length
    ? await prisma.automation.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(campaigns.map((c) => [c.id, c.name]));
  return {
    ahora,
    personas: rows.map((r) => ({
      igsid: r.userId,
      usuario: r.username,
      canal: r.channel,
      estado: r.status,
      fase: r.phase,
      fit: r.fit,
      notas: r.notes,
      campana: r.automationId ? (names.get(r.automationId) ?? null) : null,
      inicio: r.createdAt.getTime(),
      actualizado: r.updatedAt.getTime(),
      recursoEn: ms(r.resourceSentAt),
      agendadoEn: ms(r.bookedAt),
      llamadaEn: ms(r.callAt),
      pitch: PITCH_PHASES.includes(r.phase) || Boolean(r.bookedAt) || pitched.has(r.id),
    })),
  };
}

const AUDIO_NAMES: Record<AudioKey, string> = {
  situacion: "Situación actual",
  obstaculo: "Obstáculo",
  pitch: "Pitch de agenda",
  precio: "Precio",
  agendado: "Llamada agendada",
};

/** The setter's recorded audios (SETTER_AUDIOS), to send them by hand from the Hub. */
export function hubAudios(raw?: string): { id: string; nombre: string; url: string }[] {
  const audios = setterAudios(raw);
  return AUDIO_KEYS.flatMap((key) => {
    const urls = audios[key] ?? [];
    return urls.map((url, i) => ({
      id: urls.length > 1 ? `${key}-${i + 1}` : key,
      nombre: urls.length > 1 ? `${AUDIO_NAMES[key]} (${i + 1})` : AUDIO_NAMES[key],
      url,
    }));
  });
}
