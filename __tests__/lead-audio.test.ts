import { afterEach, describe, expect, it, vi } from "vitest";
import { leadAudioSendAt, leadAudioUrls } from "../lib/leads/audio";

// Montevideo is UTC-3 all year, so these instants map to fixed local times.
const at = (utc: string) => new Date(utc);
const localTime = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "America/Montevideo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

afterEach(() => vi.unstubAllEnvs());

describe("lead audio schedule", () => {
  it("waits between 5 and 20 minutes during the day", () => {
    const tap = at("2026-09-26T17:00:00Z"); // 14:00 local
    expect(leadAudioSendAt(tap, () => 0).getTime() - tap.getTime()).toBe(5 * 60_000);
    expect(leadAudioSendAt(tap, () => 0.9999).getTime() - tap.getTime()).toBeCloseTo(20 * 60_000, -3);
  });

  it("holds a night tap until shortly after 9:00", () => {
    const tap = at("2026-09-26T06:10:00Z"); // 03:10 local
    const send = leadAudioSendAt(tap, () => 0.5);
    expect(localTime(send) >= "09:00" && localTime(send) <= "09:45").toBe(true);
    // Still inside Instagram's 24-hour window.
    expect(send.getTime() - tap.getTime()).toBeLessThan(24 * 3600_000);
  });

  it("also holds a late-evening tap whose delay crosses 23:00", () => {
    const tap = at("2026-09-27T01:55:00Z"); // 22:55 local
    expect(localTime(leadAudioSendAt(tap, () => 0.9))).toMatch(/^09:/);
  });

  it("reads the delay and quiet hours from the environment", () => {
    vi.stubEnv("LEAD_AUDIO_DELAY_MINUTES", "1,2");
    vi.stubEnv("LEAD_AUDIO_QUIET_HOURS", "0,0");
    const tap = at("2026-09-26T06:10:00Z");
    expect(leadAudioSendAt(tap, () => 0).getTime() - tap.getTime()).toBe(60_000);
  });

  it("lists the configured files, ignoring blanks", () => {
    vi.stubEnv("LEAD_AUDIO_URLS", " https://x/a.m4a , ,https://x/b.m4a");
    expect(leadAudioUrls()).toEqual(["https://x/a.m4a", "https://x/b.m4a"]);
  });
});
