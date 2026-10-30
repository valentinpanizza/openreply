import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { ownerTimeZone, setterEnabled } from "./config";
import { zonedToUtc } from "./calendar";
import { notifyOwner } from "./notify";

/**
 * The setter's funnel for one day (owner's time): how many conversations it
 * opened, how many answered, who qualifies, how many reached the pitch and
 * booked, how many went quiet, and how long people waited for an answer.
 * Sent to the owner's phone every night (SETTER_REPORT_HOUR, "off" to stop)
 * and printed by `setter.ts report [YYYY-MM-DD]`.
 * The wait is the number to watch: from 23/10, with the sends slowed down for
 * Instagram's cap, it went from a minute to ~7 h and the calls stopped.
 */

export interface DayReport {
  day: string;
  opened: number;
  answered: number;
  resource: number;
  fits: { negocio: number; profesional: number; no: number; unknown: number };
  pitch: number;
  booked: number;
  handedOver: number;
  // Never answered the first message (the setter spoke last, still at the opener).
  noReply: number;
  // Went quiet further on, by the phase they stopped at.
  quiet: number;
  quietByPhase: Record<string, number>;
  waitMedianMin: number | null;
  waitP90Min: number | null;
  unanswered: number;
}

function ownerDay(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ownerTimeZone() }).format(at);
}

function dayBounds(day: string): { start: Date; end: Date } {
  const start = zonedToUtc(day, 0, 0, ownerTimeZone());
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  return { start, end: zonedToUtc(next, 0, 0, ownerTimeZone()) };
}

const DAY_MS = 24 * 3600_000;
// Columns are timestamp without time zone, in UTC.
const utc = (at: Date) => at.toISOString().replace("T", " ").replace("Z", "");

export async function dayReport(day = ownerDay(Date.now())): Promise<DayReport> {
  const { start, end } = dayBounds(day);
  const [s, e] = [utc(start), utc(end)];
  // Gone quiet: the setter spoke last, 24 h ago, counted the day it turns 24 h.
  const [qs, qe] = [utc(new Date(start.getTime() - DAY_MS)), utc(new Date(end.getTime() - DAY_MS))];

  const [counts] = await prisma.$queryRawUnsafe<Record<string, bigint>[]>(
    `with replied as (
       select distinct m."conversationId" id from "SetterMessage" m
       where m.role = 'user' and m.text not like '[comentó%' and m."createdAt" >= $1::timestamp and m."createdAt" < $2::timestamp)
     select
       (select count(*) from "SetterConversation" where "createdAt" >= $1::timestamp and "createdAt" < $2::timestamp) opened,
       (select count(*) from replied) answered,
       (select count(*) from "SetterConversation" where "resourceSentAt" >= $1::timestamp and "resourceSentAt" < $2::timestamp) resource,
       (select count(*) from replied r join "SetterConversation" c on c.id = r.id where c.fit = 'negocio') negocio,
       (select count(*) from replied r join "SetterConversation" c on c.id = r.id where c.fit = 'profesional') profesional,
       (select count(*) from replied r join "SetterConversation" c on c.id = r.id where c.fit = 'no') no,
       (select count(*) from "SetterConversation" where "lastBotAt" >= $1::timestamp and "lastBotAt" < $2::timestamp
          and phase in ('pitch', 'agendando', 'agendado')) pitch,
       (select count(*) from "SetterConversation" where "bookedAt" >= $1::timestamp and "bookedAt" < $2::timestamp) booked,
       (select count(*) from "SetterConversation" where status = 'HUMAN' and "updatedAt" >= $1::timestamp and "updatedAt" < $2::timestamp) handed`,
    s,
    e
  );

  const quietRows = await prisma.$queryRawUnsafe<{ phase: string; n: bigint }[]>(
    `select c.phase, count(*) n from "SetterConversation" c
     join lateral (select role, "createdAt" from "SetterMessage" m
                   where m."conversationId" = c.id and m.role <> 'shadow' order by m."createdAt" desc limit 1) last on true
     where c.status = 'ACTIVE' and c."callAt" is null and last.role = 'bot'
       and last."createdAt" >= $1::timestamp and last."createdAt" < $2::timestamp
     group by c.phase`,
    qs,
    qe
  );

  // From each message that starts a run of the person's (not the comment) to
  // the next answer, by the setter or by hand.
  const [wait] = await prisma.$queryRawUnsafe<{ median: number | null; p90: number | null; unanswered: bigint }[]>(
    `with runs as (
       select m."conversationId", m."createdAt",
         lag(m.role) over (partition by m."conversationId" order by m."createdAt") prev, m.role, m.text
       from "SetterMessage" m
       where m.role in ('user', 'bot', 'owner')
         and m."conversationId" in (select "conversationId" from "SetterMessage"
                                    where role = 'user' and "createdAt" >= $1::timestamp and "createdAt" < $2::timestamp)),
     asks as (
       select r."conversationId", r."createdAt",
         (select min(a."createdAt") from "SetterMessage" a where a."conversationId" = r."conversationId"
            and a.role in ('bot', 'owner') and a."createdAt" > r."createdAt") answered_at
       from runs r
       where r.role = 'user' and r.text not like '[comentó%' and (r.prev is null or r.prev <> 'user')
         and r."createdAt" >= $1::timestamp and r."createdAt" < $2::timestamp)
     select
       percentile_cont(0.5) within group (order by extract(epoch from answered_at - "createdAt") / 60)
         filter (where answered_at is not null) median,
       percentile_cont(0.9) within group (order by extract(epoch from answered_at - "createdAt") / 60)
         filter (where answered_at is not null) p90,
       count(*) filter (where answered_at is null) unanswered
     from asks`,
    s,
    e
  );

  const n = (value: bigint | undefined) => Number(value ?? 0);
  const answered = n(counts.answered);
  const fits = { negocio: n(counts.negocio), profesional: n(counts.profesional), no: n(counts.no), unknown: 0 };
  fits.unknown = Math.max(0, answered - fits.negocio - fits.profesional - fits.no);
  const quietByPhase = Object.fromEntries(
    quietRows.filter((row) => row.phase !== "abridor").map((row) => [row.phase, n(row.n)])
  );
  return {
    day,
    opened: n(counts.opened),
    answered,
    resource: n(counts.resource),
    fits,
    pitch: n(counts.pitch),
    booked: n(counts.booked),
    handedOver: n(counts.handed),
    noReply: n(quietRows.find((row) => row.phase === "abridor")?.n),
    quiet: Object.values(quietByPhase).reduce((a, b) => a + b, 0),
    quietByPhase,
    waitMedianMin: wait?.median == null ? null : Math.round(Number(wait.median)),
    waitP90Min: wait?.p90 == null ? null : Math.round(Number(wait.p90)),
    unanswered: n(wait?.unanswered),
  };
}

const PHASES: Record<string, string> = {
  situacion: "situación",
  obstaculo: "obstáculo",
  pitch: "pitch",
  agendando: "agendando",
  cierre: "cierre",
};

export function formatMinutes(minutes: number | null): string {
  if (minutes == null) return "-";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatReport(report: DayReport): string {
  const [, month, date] = report.day.split("-");
  const quiet = Object.entries(report.quietByPhase)
    .sort((a, b) => b[1] - a[1])
    .map(([phase, count]) => `${PHASES[phase] ?? phase} ${count}`)
    .join(", ");
  return [
    `Día ${date}/${month}`,
    `Charlas nuevas: ${report.opened}`,
    `Contestaron: ${report.answered}`,
    `No contestaron el primer mensaje (24 h): ${report.noReply}`,
    `Recibieron el recurso: ${report.resource}`,
    `De los que contestaron: negocio ${report.fits.negocio}, profesional ${report.fits.profesional}, aprendiendo ${report.fits.no}, sin saber ${report.fits.unknown}`,
    `Llegaron al pitch: ${report.pitch}`,
    `Agendaron llamada: ${report.booked}`,
    `Se colgaron a mitad de charla (24 h): ${report.quiet}${quiet ? ` (${quiet})` : ""}`,
    `Pasadas a vos: ${report.handedOver}`,
    `Espera hasta la respuesta: mediana ${formatMinutes(report.waitMedianMin)}, 9 de cada 10 en menos de ${formatMinutes(report.waitP90Min)}${report.unanswered ? ` (${report.unanswered} todavía sin respuesta)` : ""}`,
  ].join("\n");
}

/** The hour (owner's time) the day's report goes out; null when off. */
export function reportHour(): number | null {
  const raw = process.env.SETTER_REPORT_HOUR;
  if (raw === "off") return null;
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 && value <= 23 ? value : 23;
}

/** Sends today's report once, at reportHour(). Called every few minutes by the worker. */
export async function maybeSendDayReport(now = Date.now()): Promise<boolean> {
  const hour = reportHour();
  if (hour === null || !setterEnabled()) return false;
  const current = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: ownerTimeZone(), hour: "numeric", hourCycle: "h23" }).format(now)
  );
  if (current < hour) return false;
  const day = ownerDay(now);
  const fresh = await getRedisConnection().set(`setter:report:${day}`, "1", "EX", 2 * 24 * 3600, "NX");
  if (fresh !== "OK") return false;
  const report = await dayReport(day);
  await notifyOwner({ title: "Resumen del setter", message: formatReport(report), tags: ["bar_chart"] });
  return true;
}
