/**
 * The second chance: someone who went quiet before getting the resource gets
 * it anyway, after SETTER_SECOND_CHANCE_MINUTES, with one soft question.
 */
import { describe, expect, it } from "vitest";
import { secondChanceMs } from "../lib/setter/config";
import { buildTurnPrompt, type TurnInput } from "../lib/setter/brain";

describe("second chance", () => {
  it("waits two hours unless told otherwise, and 0 turns it off", () => {
    expect(secondChanceMs({})).toBe(120 * 60_000);
    expect(secondChanceMs({ SETTER_SECOND_CHANCE_MINUTES: "90" })).toBe(90 * 60_000);
    expect(secondChanceMs({ SETTER_SECOND_CHANCE_MINUTES: "0" })).toBe(0);
    expect(secondChanceMs({ SETTER_SECOND_CHANCE_MINUTES: "nope" })).toBe(0);
  });

  it("tells the model to send the resource with one soft question, no audio", () => {
    const input: TurnInput = {
      mode: "charla",
      reel: "campaña: Inbox",
      username: "juan",
      phase: "abridor",
      notes: null,
      timezone: null,
      email: null,
      resourceSent: false,
      resourceAvailable: true,
      call: null,
      audios: ["pitch"],
      transcript: [{ role: "bot", text: "es para tu negocio o estas aprendiendo?", at: new Date("2026-11-14T15:00:00Z") }],
      now: new Date("2026-11-14T17:00:00Z"),
      ownerTimeZone: "America/Montevideo",
      secondChance: true,
    };
    const prompt = buildTurnPrompt(input);
    expect(prompt).toContain("segunda chance");
    expect(prompt).toContain("enviar_recurso");
    expect(buildTurnPrompt({ ...input, secondChance: undefined })).not.toContain("segunda chance");
  });
});
