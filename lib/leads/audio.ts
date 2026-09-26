/**
 * Voice note sent automatically to a captured lead, a few minutes after they
 * tap the lead button. Off unless LEAD_AUDIO_URLS lists at least one file.
 *
 * Instagram allows it because the tap opened the 24-hour messaging window.
 * Pacing is deliberate: an instant reply, or one at 3 a.m., reads as a bot, and
 * this account was already suspended once by an automated spam filter.
 */

// Public URLs of the audio files (m4a, aac, wav or mp4, up to 25 MB). One is
// picked per lead, so not everyone receives the very same file.
export function leadAudioUrls(): string[] {
  return (process.env.LEAD_AUDIO_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

function pair(value: string | undefined, fallback: [number, number]): [number, number] {
  const [a, b] = (value ?? "").split(",").map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : fallback;
}

function localHour(date: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date)
  );
}

/**
 * When to send: a random delay (LEAD_AUDIO_DELAY_MINUTES, default "5,20"),
 * pushed out of quiet hours (LEAD_AUDIO_QUIET_HOURS, default "23,9", in
 * LEAD_AUDIO_TIMEZONE) to shortly after they end. The latest possible send,
 * a tap at 23:00 answered around 9:30, stays well inside the 24-hour window.
 */
export function leadAudioSendAt(now: Date, random: () => number = Math.random): Date {
  const [minDelay, maxDelay] = pair(process.env.LEAD_AUDIO_DELAY_MINUTES, [5, 20]);
  const [quietStart, quietEnd] = pair(process.env.LEAD_AUDIO_QUIET_HOURS, [23, 9]);
  const timeZone = process.env.LEAD_AUDIO_TIMEZONE ?? "America/Montevideo";
  const quiet = (hour: number) =>
    quietStart > quietEnd
      ? hour >= quietStart || hour < quietEnd
      : hour >= quietStart && hour < quietEnd;

  let at = new Date(now.getTime() + (minDelay + random() * (maxDelay - minDelay)) * 60_000);
  if (!quiet(localHour(at, timeZone))) return at;

  // Walk forward in 15-minute steps to the end of quiet hours, then spread the
  // morning's sends over half an hour instead of firing them all at once.
  while (quiet(localHour(at, timeZone))) at = new Date(at.getTime() + 15 * 60_000);
  return new Date(at.getTime() + random() * 30 * 60_000);
}
