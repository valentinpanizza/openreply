/**
 * The owner's Google Calendar, for the setter to offer free times and book
 * calls. Authorized once with scripts/google-auth.mjs (scope calendar.events):
 * GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
 *
 * Times are offered in the person's own time zone. The owner takes calls at
 * any hour, so the only window is the person's (SETTER_CALL_HOURS, default
 * 9 to 21 their time) and the owner's existing events.
 */

const CALENDAR_ID = () => process.env.SETTER_CALENDAR_ID?.trim() || "primary";

export function calendarConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN
  );
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN ?? "",
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(`Google token refresh failed: ${data.error ?? response.status}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function calendarFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID())}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    }
  );
  const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(`Google Calendar ${response.status}: ${data.error?.message ?? "unknown error"}`);
  }
  return data;
}

// ─── Time zones (no library: Intl is enough) ───────────────────────────────────

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

// Minutes the zone is ahead of UTC at that instant.
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - instant) / 60_000);
}

/** The instant a wall-clock time ("2026-10-15", 10, 30) happens in a zone. */
export function zonedToUtc(date: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = guess - offsetMinutes(guess, timeZone) * 60_000;
  // Once more, in case the guess and the answer sit on different sides of a
  // daylight-saving change.
  instant = guess - offsetMinutes(instant, timeZone) * 60_000;
  return new Date(instant);
}

export function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-UY", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

export function dateInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

// ─── Free times ─────────────────────────────────────────────────────────────────

export interface Busy {
  start: Date;
  end: Date;
}

function callHours(): [number, number] {
  const [from, to] = (process.env.SETTER_CALL_HOURS ?? "").split(",").map(Number);
  return Number.isFinite(from) && Number.isFinite(to) && from < to ? [from, to] : [9, 21];
}

/**
 * Free call starts on `date` (YYYY-MM-DD in the person's zone), every 30
 * minutes within their call hours, that overlap none of the owner's events and
 * start at least two hours from now.
 */
export function freeSlots({
  date,
  timeZone,
  minutes,
  busy,
  now,
}: {
  date: string;
  timeZone: string;
  minutes: number;
  busy: Busy[];
  now: Date;
}): Date[] {
  const [from, to] = callHours();
  const slots: Date[] = [];
  for (let at = from * 60; at + minutes <= to * 60; at += 30) {
    const start = zonedToUtc(date, Math.floor(at / 60), at % 60, timeZone);
    const end = new Date(start.getTime() + minutes * 60_000);
    if (start.getTime() < now.getTime() + 2 * 3600_000) continue;
    if (busy.some((b) => b.start < end && b.end > start)) continue;
    slots.push(start);
  }
  return slots;
}

interface CalendarEvent {
  id: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  hangoutLink?: string;
  htmlLink?: string;
}

export async function busyBetween(start: Date, end: Date): Promise<Busy[]> {
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const data = await calendarFetch<{ items?: CalendarEvent[] }>(`/events?${params}`);
  return (data.items ?? [])
    .filter(
      (event) =>
        event.status !== "cancelled" &&
        event.transparency !== "transparent" &&
        // All-day events (birthdays, reminders) do not block a call.
        Boolean(event.start?.dateTime && event.end?.dateTime) &&
        !event.attendees?.some((a) => a.self && a.responseStatus === "declined")
    )
    .map((event) => ({ start: new Date(event.start!.dateTime!), end: new Date(event.end!.dateTime!) }));
}

/** Free starts for a day in the person's zone, read from the calendar. */
export async function freeSlotsOn(date: string, timeZone: string, minutes: number): Promise<Date[]> {
  const dayStart = zonedToUtc(date, 0, 0, timeZone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
  const busy = await busyBetween(dayStart, dayEnd);
  return freeSlots({ date, timeZone, minutes, busy, now: new Date() });
}

export async function createCallEvent({
  start,
  minutes,
  email,
  summary,
  description,
}: {
  start: Date;
  minutes: number;
  email: string;
  summary: string;
  description: string;
}): Promise<{ id: string; meetLink: string | null }> {
  const end = new Date(start.getTime() + minutes * 60_000);
  const event = await calendarFetch<CalendarEvent>(`/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [{ email }],
      conferenceData: {
        createRequest: {
          requestId: `setter-${start.getTime()}-${Math.random().toString(36).slice(2, 10)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
      reminders: { useDefault: true },
    }),
  });
  return { id: event.id, meetLink: event.hangoutLink ?? null };
}
