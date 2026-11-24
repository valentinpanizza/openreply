/** The follow-up: one message with times to someone who qualifies and went quiet. */
import { describe, expect, it } from "vitest";
import { followUpMs } from "../lib/setter/config";
import { followUpAt, wantsFollowUp } from "../lib/setter/follow-up";
import { buildTurnPrompt, type TurnInput } from "../lib/setter/brain";

const H = 3600_000;
const uy = (s: string) => Date.parse(`${s}-03:00`);
const base = { status: "ACTIVE", phase: "pitch", fit: "negocio", callAt: null, lastUserAt: null };

describe("follow-up", () => {
  it("is on by default and 0 turns it off", () => {
    expect(followUpMs({})).toBe(300 * 60_000);
    expect(followUpMs({ SETTER_FOLLOW_UP_MINUTES: "0" })).toBe(0);
  });
  it("only for people who qualify, near the call, without one", () => {
    expect(wantsFollowUp(base)).toBe(true);
    expect(wantsFollowUp({ ...base, fit: null })).toBe(false);
    expect(wantsFollowUp({ ...base, fit: "no" })).toBe(false);
    expect(wantsFollowUp({ ...base, phase: "cierre" })).toBe(false);
    expect(wantsFollowUp({ ...base, status: "HUMAN" })).toBe(false);
    expect(wantsFollowUp({ ...base, callAt: new Date() })).toBe(false);
  });
  it("goes after the delay by day", () => {
    const now = uy("2026-11-24T12:00:00");
    expect(followUpAt(now, 5 * H, new Date(now))).toBe(now + 5 * H);
  });
  it("waits for the morning when it would go at night", () => {
    for (const t of ["2026-11-24T19:00:00", "2026-11-24T23:00:00", "2026-11-25T03:00:00"]) {
      const at = followUpAt(uy(t), 5 * H, new Date(uy(t)))!;
      expect(at).toBeGreaterThanOrEqual(uy("2026-11-25T09:00:00"));
      expect(at).toBeLessThan(uy("2026-11-25T09:41:00"));
    }
  });
  it("goes that evening when the morning is past the window, or not at all", () => {
    const now = uy("2026-11-24T18:00:00");
    expect(followUpAt(now, 5 * H, new Date(uy("2026-11-24T09:00:00")))).toBe(uy("2026-11-24T20:45:00"));
    expect(followUpAt(now, 5 * H, new Date(uy("2026-11-23T22:00:00")))).toBeNull();
    expect(followUpAt(now, 5 * H, null)).toBeNull();
  });
  it("asks for concrete times, and for the resource only if missing", () => {
    const input: TurnInput = {
      mode: "charla", reel: "", username: "a", phase: "pitch", notes: null, timezone: null, email: null,
      resourceSent: true, resourceAvailable: true, call: null, audios: [], transcript: [],
      now: new Date(), ownerTimeZone: "America/Montevideo", followUp: true,
    };
    const prompt = buildTurnPrompt(input);
    expect(prompt).toContain("único seguimiento");
    expect(prompt).not.toContain("enviar_recurso");
    expect(buildTurnPrompt({ ...input, resourceSent: false })).toContain("enviar_recurso");
  });
});
