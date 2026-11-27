/**
 * The setter's numbers for the Hub ("Setter Valentin"). A period counts the
 * conversations that started in it (the cohort) and how far each one got:
 * answered, qualifies (negocio or profesional), got the resource, reached the
 * pitch, booked. Plus where the ones that answered stopped, how long people
 * waited for the first answer, per campaign, the leads, and Claude's spend.
 *
 * Columns are timestamp without time zone, in UTC.
 */

import { prisma } from "@/lib/db/client";
import { zonedToUtc } from "@/lib/setter/calendar";
import { ownerTimeZone } from "@/lib/setter/config";
import { conversationLink } from "@/lib/setter/notify";

export type HubRange = "hoy" | "ayer" | "7d" | "30d";
export const HUB_RANGES: HubRange[] = ["hoy", "ayer", "7d", "30d"];
const DAY_MS = 24 * 3600_000;
const MAX_LEADS = 300;

export function parseRange(raw: string | null | undefined): HubRange {
  return HUB_RANGES.includes(raw as HubRange) ? (raw as HubRange) : "7d";
}

function ownerDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
}

/** hoy and ayer follow the owner's calendar; 7d and 30d are the last 7 or 30 days up to now. */
export function rangeBounds(range: HubRange, now = Date.now(), timeZone = ownerTimeZone()): { from: number; to: number } {
  if (range === "7d") return { from: now - 7 * DAY_MS, to: now };
  if (range === "30d") return { from: now - 30 * DAY_MS, to: now };
  const startToday = zonedToUtc(ownerDay(now, timeZone), 0, 0, timeZone).getTime();
  if (range === "hoy") return { from: startToday, to: now };
  const startYesterday = zonedToUtc(ownerDay(startToday - 12 * 3600_000, timeZone), 0, 0, timeZone).getTime();
  return { from: startYesterday, to: startToday };
}

const utc = (at: number) => new Date(at).toISOString().replace("T", " ").replace("Z", "");
const n = (value: unknown) => Number(value ?? 0);
const msOrNull = (value: unknown) => (value == null ? null : Math.round(Number(value)));

export type Totals = {
  consultas: number;
  respondieron: number;
  califican: number;
  recurso: number;
  pitches: number;
  agendadas: number;
};
export type Groups = { negocio: number; profesional: number; no: number; sin_definir: number };
export type CampaignRow = Totals & { tema: string; grupos: Groups; costUsd: number };

const COHORT = `
  with c as (
    select c.id, c."automationId", c.fit, c.phase, c."resourceSentAt", c."bookedAt",
      exists (select 1 from "SetterMessage" m where m."conversationId" = c.id and m.role = 'user'
              and m.text not like '[comentó%') as replied,
      (c.phase in ('pitch', 'agendando', 'agendado') or c."bookedAt" is not null
        or exists (select 1 from "SetterMessage" m where m."conversationId" = c.id and m.role = 'bot'
                   and m.kind = 'audio' and m.text = '[audio: pitch]')) as pitch
    from "SetterConversation" c
    where c."instagramAccountId" = $1 and c."createdAt" >= $2::timestamp and c."createdAt" < $3::timestamp
  )`;

type CampaignSql = Record<
  "consultas" | "respondieron" | "califican" | "recurso" | "pitches" | "agendadas" | "negocio" | "profesional" | "no" | "sin_definir",
  bigint
> & { id: string | null; tema: string | null; usd: number | null };

export async function hubStats(connectionId: string, range: HubRange, now = Date.now()) {
  const { from, to } = rangeBounds(range, now);
  const args = [connectionId, utc(from), utc(to)] as const;

  const campaignRows = await prisma.$queryRawUnsafe<CampaignSql[]>(
    `${COHORT},
     cost as (select m."conversationId" id, sum(m."costUsd") usd from "SetterMessage" m
              where m."conversationId" in (select id from c) and m."costUsd" is not null group by 1)
     select c."automationId" id, a.name tema,
       count(*) consultas,
       count(*) filter (where replied) respondieron,
       count(*) filter (where replied and fit in ('negocio', 'profesional')) califican,
       count(*) filter (where "resourceSentAt" is not null) recurso,
       count(*) filter (where pitch) pitches,
       count(*) filter (where "bookedAt" is not null) agendadas,
       count(*) filter (where replied and fit = 'negocio') negocio,
       count(*) filter (where replied and fit = 'profesional') profesional,
       count(*) filter (where replied and fit = 'no') no,
       count(*) filter (where replied and (fit is null or fit not in ('negocio', 'profesional', 'no'))) sin_definir,
       coalesce(sum(cost.usd), 0)::float8 usd
     from c left join "Automation" a on a.id = c."automationId" left join cost on cost.id = c.id
     group by 1, 2`,
    ...args
  );

  const stopRows = await prisma.$queryRawUnsafe<{ fase: string; n: bigint }[]>(
    `${COHORT} select phase fase, count(*) n from c where replied and not pitch group by 1 order by 2 desc`,
    ...args
  );

  const [wait] = await prisma.$queryRawUnsafe<{ mediana: number | null; p90: number | null }[]>(
    `${COHORT},
     w as (
       select extract(epoch from (
           select min(b."createdAt") from "SetterMessage" b
           where b."conversationId" = c.id and b.role in ('bot', 'owner') and b."createdAt" > u.first_at
         ) - u.first_at) / 60 minutes
       from c join lateral (
         select min(m."createdAt") first_at from "SetterMessage" m
         where m."conversationId" = c.id and m.role = 'user' and m.text not like '[comentó%'
       ) u on u.first_at is not null)
     select percentile_cont(0.5) within group (order by minutes)::float8 mediana,
            percentile_cont(0.9) within group (order by minutes)::float8 p90
     from w`,
    ...args
  );

  const leadRows = await prisma.$queryRawUnsafe<
    {
      id: string;
      userId: string;
      username: string | null;
      channel: string;
      tema: string | null;
      inicio: number;
      fit: string | null;
      phase: string;
      status: string;
      pitch: boolean;
      recurso: number | null;
      agendado: number | null;
      llamada: number | null;
      notes: string | null;
    }[]
  >(
    `${COHORT}
     select s.id, s."userId", s.username, s.channel, a.name tema, s.fit, s.phase, s.status, s.notes, c.pitch,
       (extract(epoch from s."createdAt") * 1000)::float8 inicio,
       (extract(epoch from s."resourceSentAt") * 1000)::float8 recurso,
       (extract(epoch from s."bookedAt") * 1000)::float8 agendado,
       (extract(epoch from s."callAt") * 1000)::float8 llamada
     from c join "SetterConversation" s on s.id = c.id left join "Automation" a on a.id = s."automationId"
     where c.replied
     order by (s."bookedAt" is not null) desc, c.pitch desc, (s.fit in ('negocio', 'profesional')) desc nulls last,
       s."createdAt" desc
     limit ${MAX_LEADS}`,
    ...args
  );

  const reels: CampaignRow[] = campaignRows
    .map((row) => ({
      tema: row.tema ?? "Sin campaña",
      consultas: n(row.consultas),
      respondieron: n(row.respondieron),
      califican: n(row.califican),
      recurso: n(row.recurso),
      pitches: n(row.pitches),
      agendadas: n(row.agendadas),
      grupos: { negocio: n(row.negocio), profesional: n(row.profesional), no: n(row.no), sin_definir: n(row.sin_definir) },
      costUsd: Number(row.usd ?? 0),
    }))
    .sort((a, b) => b.consultas - a.consultas);

  const sum = (key: keyof Totals) => reels.reduce((total, r) => total + r[key], 0);
  const totals: Totals = {
    consultas: sum("consultas"),
    respondieron: sum("respondieron"),
    califican: sum("califican"),
    recurso: sum("recurso"),
    pitches: sum("pitches"),
    agendadas: sum("agendadas"),
  };
  const groups = (key: keyof Groups) => reels.reduce((total, r) => total + r.grupos[key], 0);
  const tipos = (["negocio", "profesional", "no", "sin_definir"] as const)
    .map((tipo) => ({ tipo, n: groups(tipo) }))
    .filter((t) => t.n > 0);

  return {
    range: { key: range, from, to },
    generatedAt: now,
    totals,
    espera: {
      medianaMin: wait?.mediana == null ? null : Math.round(wait.mediana),
      p90Min: wait?.p90 == null ? null : Math.round(wait.p90),
    },
    reels,
    tipos,
    cortes: stopRows.map((row) => ({ fase: row.fase, n: n(row.n) })),
    leads: leadRows.map((row) => ({
      id: row.id,
      igsid: row.userId,
      username: row.username,
      link: row.username || row.channel === "facebook" ? conversationLink(row) : null,
      canal: row.channel,
      tema: row.tema ?? "Sin campaña",
      startedAt: msOrNull(row.inicio) ?? 0,
      fit: row.fit,
      fase: row.phase,
      estado: row.status,
      pitch: row.pitch,
      recursoAt: msOrNull(row.recurso),
      bookedAt: msOrNull(row.agendado),
      callAt: msOrNull(row.llamada),
      notas: row.notes,
    })),
  };
}

/**
 * Everything the Hub shows, in one answer. The money (`credits` and each
 * campaign's `costUsd`: Claude's spend by the setter's own count, at list
 * price) is split off on the Hub's side, where only Finanzas may show it.
 */
export async function hubSetterPanel(connectionId: string, range: HubRange, now = Date.now()) {
  const [stats, byPeriod] = await Promise.all([hubStats(connectionId, range, now), creditsByPeriod(connectionId, now)]);
  const spent = stats.reels.reduce((total, r) => total + r.costUsd, 0);
  return {
    ...stats,
    credits: {
      ...byPeriod,
      rango: spent,
      porCharla: stats.totals.consultas ? spent / stats.totals.consultas : null,
      porPitch: stats.totals.pitches ? spent / stats.totals.pitches : null,
    },
  };
}

async function creditsByPeriod(connectionId: string, now: number) {
  const bounds = Object.fromEntries(HUB_RANGES.map((r) => [r, rangeBounds(r, now)])) as Record<HubRange, { from: number; to: number }>;
  const oldest = Math.min(...HUB_RANGES.map((r) => bounds[r].from));
  const [row] = await prisma.$queryRawUnsafe<Record<string, number | bigint | null>[]>(
    `select
       ${HUB_RANGES.map(
         (r, i) =>
           `coalesce(sum(m."costUsd") filter (where m."createdAt" >= $${2 + i * 2}::timestamp and m."createdAt" < $${3 + i * 2}::timestamp), 0)::float8 "${r}_usd",
            count(*) filter (where m."costUsd" > 0 and m."createdAt" >= $${2 + i * 2}::timestamp and m."createdAt" < $${3 + i * 2}::timestamp) "${r}_n"`
       ).join(",\n")}
     from "SetterMessage" m join "SetterConversation" c on c.id = m."conversationId"
     where c."instagramAccountId" = $1 and m."costUsd" is not null and m."createdAt" >= $10::timestamp`,
    connectionId,
    ...HUB_RANGES.flatMap((r) => [utc(bounds[r].from), utc(bounds[r].to)]),
    utc(oldest)
  );
  return Object.fromEntries(
    HUB_RANGES.map((r) => [r, { usd: Number(row?.[`${r}_usd`] ?? 0), llamadas: n(row?.[`${r}_n`]) }])
  ) as Record<HubRange, { usd: number; llamadas: number }>;
}
