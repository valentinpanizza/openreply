import { ownerTimeZone } from "./config";
import { zonedToUtc } from "./calendar";

/**
 * When the follow-up goes and to whom: someone who qualifies and went quiet at
 * the obstacle, the pitch or picking a time (24/11: ~3 of 4 people who heard
 * the pitch never booked, and nobody wrote to them again).
 */
const PHASES = new Set(["obstaculo", "pitch", "agendando"]);
const FROM_HOUR = 9;
const TO_HOUR = 21;
// Instagram takes a reply up to 24 h after the person's message; pacing.ts stops at 22.
const WINDOW_MS = 21.5 * 3600_000;

export interface FollowUpState {
  status: string;
  phase: string;
  fit: string | null;
  callAt: Date | null;
  lastUserAt: Date | null;
}

export function wantsFollowUp(c: FollowUpState): boolean {
  return (
    c.status === "ACTIVE" &&
    !c.callAt &&
    PHASES.has(c.phase) &&
    (c.fit === "negocio" || c.fit === "profesional")
  );
}

/**
 * The moment it goes: `delay` from now, never at night (owner's hours): the
 * next morning if that still is within the window, or else earlier, at the end
 * of the day. Null when there is no moment left.
 */
export function followUpAt(now: number, delay: number, lastUserAt: Date | null): number | null {
  if (!lastUserAt) return null;
  const timeZone = ownerTimeZone();
  const deadline = lastUserAt.getTime() + WINDOW_MS;
  const at = now + delay;
  const hour = (t: number) =>
    Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(t));
  const day = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(t);
  if (hour(at) >= FROM_HOUR && hour(at) < TO_HOUR) return at <= deadline ? at : null;
  const morningDay = hour(at) >= TO_HOUR ? day(at + 12 * 3600_000) : day(at);
  const morning = zonedToUtc(morningDay, FROM_HOUR, 0, timeZone).getTime() + Math.round(Math.random() * 40 * 60_000);
  if (morning <= deadline) return morning;
  // Too late by morning: the evening before, if it leaves them two hours.
  const evening = zonedToUtc(day(hour(at) >= TO_HOUR ? at : at - 12 * 3600_000), TO_HOUR, 0, timeZone).getTime() - 15 * 60_000;
  return evening >= now + 2 * 3600_000 && evening <= deadline ? evening : null;
}
