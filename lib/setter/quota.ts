import { getRedisConnection } from "@/lib/queue/client";
import { ownerTimeZone } from "./config";
import { zonedToUtc } from "./calendar";

/**
 * A daily cap on the setter's answers (SETTER_DAILY_REPLIES, owner's day; 0
 * turns it off). Instagram's block on DMs (368) came back on 28/10 after a
 * day of steady sends with no burst, so fewer sends a day is the only lever
 * left. Past the cap only the people worth a call (a business, a professional,
 * someone already at the pitch or booked) are answered; the rest wait for the
 * next morning, when their answers go out spaced like any other.
 * The first message to someone who commented is not counted: private replies
 * kept going through every block.
 */

export const FITS = ["negocio", "profesional", "no", "no_se"] as const;
export type Fit = (typeof FITS)[number];

const MORNING_HOUR = 9;

export function dailyReplyCap(): number {
  const value = Number(process.env.SETTER_DAILY_REPLIES);
  return Number.isFinite(value) && value >= 0 ? value : 250;
}

function ownerDay(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ownerTimeZone() }).format(at);
}

const sentKey = (now = Date.now()) => `setter:replies:${ownerDay(now)}`;
const fitKey = (conversationId: string) => `setter:fit:${conversationId}`;

export async function recordReplies(count: number): Promise<void> {
  if (!(count > 0)) return;
  const redis = getRedisConnection();
  const key = sentKey();
  await redis.incrby(key, count);
  await redis.expire(key, 3 * 24 * 3600);
}

export async function repliesToday(): Promise<number> {
  return Number((await getRedisConnection().get(sentKey())) ?? 0);
}

export async function overReplyCap(): Promise<boolean> {
  const cap = dailyReplyCap();
  return cap > 0 && (await repliesToday()) >= cap;
}

/** What the setter last said about whether this person qualifies. */
export async function rememberFit(conversationId: string, fit: Fit | null): Promise<void> {
  if (!fit || fit === "no_se") return;
  await getRedisConnection().set(fitKey(conversationId), fit, "EX", 14 * 24 * 3600);
}

export async function fitOf(conversationId: string): Promise<Fit | null> {
  const value = await getRedisConnection().get(fitKey(conversationId));
  return (FITS as readonly string[]).includes(value ?? "") ? (value as Fit) : null;
}

/** Answered even past the cap: the conversations that can end in a call. */
export function isPriority(
  conversation: { phase: string; callAt: Date | null },
  fit: Fit | null
): boolean {
  return (
    fit === "negocio" ||
    fit === "profesional" ||
    Boolean(conversation.callAt) ||
    ["pitch", "agendando", "agendado"].includes(conversation.phase)
  );
}

/** Some minutes after 9:00 (owner's time) of the next morning after `now`. */
export function nextMorning(now: number, random: () => number = Math.random): number {
  const timeZone = ownerTimeZone();
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now)
  );
  const [year, month, day] = ownerDay(now).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + (hour < MORNING_HOUR ? 0 : 1)))
    .toISOString()
    .slice(0, 10);
  return zonedToUtc(date, MORNING_HOUR, 0, timeZone).getTime() + Math.round(random() * 60 * 60_000);
}
