/**
 * AI setter — pure pieces: how messages look, when it answers, config parsing,
 * time zones and free times, echoes, page text and the turn prompt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanize, describeAttachment } from "../lib/setter/text";
import { replyDelayMs, typingDelayMs } from "../lib/setter/timing";
import { setterAllowsUser, setterAudios } from "../lib/setter/config";
import { freeSlots, zonedToUtc, isValidTimeZone } from "../lib/setter/calendar";
import { costUsd } from "../lib/setter/budget";
import { pageText } from "../lib/setter/context";
import { buildTurnPrompt, type TurnInput } from "../lib/setter/brain";
import { parseEchoEvents, parseMessageEvents } from "../lib/meta/webhook";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("humanize", () => {
  it("lowercases, drops emojis, opening marks and long dashes", () => {
    expect(humanize("¡Buenas! 🙌 ¿Es para tu Negocio — o para aprender? 🔥")).toBe(
      "buenas! es para tu negocio, o para aprender?"
    );
  });

  it("keeps links, emails and the {link} token as they are", () => {
    expect(humanize("Acá Lo Tenés: https://Example.com/R/AbC y {link} Mail: Juan@Mail.COM")).toBe(
      "acá lo tenés: https://Example.com/R/AbC y {link} mail: Juan@Mail.COM"
    );
  });

  it("strips flags and skin tones too", () => {
    expect(humanize("Dale 👍🏽 desde 🇺🇾")).toBe("dale desde");
  });
});

describe("timing", () => {
  const now = new Date("2026-10-14T15:00:00Z");

  it("answers fast while the person is in the chat", () => {
    const lastBot = new Date(now.getTime() - 60_000);
    expect(replyDelayMs(lastBot, now, () => 0)).toBe(12_000);
    expect(replyDelayMs(lastBot, now, () => 1)).toBe(35_000);
  });

  it("takes a minute or two when they come back later", () => {
    const lastBot = new Date(now.getTime() - 2 * 3600_000);
    expect(replyDelayMs(lastBot, now, () => 0)).toBe(45_000);
    expect(replyDelayMs(null, now, () => 1)).toBe(150_000);
  });

  it("caps the typing pause", () => {
    expect(typingDelayMs("x".repeat(1000), () => 0)).toBe(9_000);
    expect(typingDelayMs("hola", () => 0)).toBe(1_680);
  });
});

describe("config", () => {
  it("talks to everyone without SETTER_ONLY_USERS", () => {
    expect(setterAllowsUser("alguien", "123")).toBe(true);
  });

  it("only talks to the listed users while SETTER_ONLY_USERS is set", () => {
    vi.stubEnv("SETTER_ONLY_USERS", "@Prueba.Cuenta, 999");
    expect(setterAllowsUser("prueba.cuenta", "1")).toBe(true);
    expect(setterAllowsUser(null, "999")).toBe(true);
    expect(setterAllowsUser("otra", "1")).toBe(false);
    expect(setterAllowsUser(undefined, "1")).toBe(false);
  });

  it("reads the audios by step, several per step, https only", () => {
    expect(
      setterAudios("pitch=https://a/1.m4a|https://a/2.m4a; agendado=https://a/3.m4a;precio=http://x;otro=https://y")
    ).toEqual({ pitch: ["https://a/1.m4a", "https://a/2.m4a"], agendado: ["https://a/3.m4a"] });
    expect(setterAudios("")).toEqual({});
  });
});

describe("time zones", () => {
  it("turns a wall-clock time in a zone into the right instant", () => {
    expect(zonedToUtc("2026-10-15", 10, 30, "America/Argentina/Buenos_Aires").toISOString()).toBe(
      "2026-10-15T13:30:00.000Z"
    );
    expect(zonedToUtc("2026-10-15", 10, 0, "Europe/Madrid").toISOString()).toBe("2026-10-15T08:00:00.000Z");
    expect(zonedToUtc("2026-10-15", 9, 0, "America/Mexico_City").toISOString()).toBe("2026-10-15T15:00:00.000Z");
  });

  it("follows daylight-saving changes", () => {
    // Madrid moves from UTC+2 to UTC+1 on 25/10/2026.
    expect(zonedToUtc("2026-10-26", 10, 0, "Europe/Madrid").toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });

  it("rejects made-up zones", () => {
    expect(isValidTimeZone("America/Montevideo")).toBe(true);
    expect(isValidTimeZone("Uruguay/Montevideo")).toBe(false);
  });
});

describe("free times", () => {
  it("offers half-hour starts in the person's hours, around the owner's events", () => {
    const busy = [
      // 11:00-12:00 Buenos Aires time.
      { start: new Date("2026-10-15T14:00:00Z"), end: new Date("2026-10-15T15:00:00Z") },
    ];
    const slots = freeSlots({
      date: "2026-10-15",
      timeZone: "America/Argentina/Buenos_Aires",
      minutes: 30,
      busy,
      now: new Date("2026-10-14T20:00:00Z"),
    });
    const labels = slots.map((s) =>
      new Intl.DateTimeFormat("es", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(s)
    );
    expect(labels[0]).toBe("09:00");
    expect(labels).toContain("10:30");
    expect(labels).not.toContain("11:00");
    expect(labels).not.toContain("11:30");
    expect(labels).toContain("12:00");
    expect(labels.at(-1)).toBe("20:30");
  });

  it("never offers something within the next two hours", () => {
    const slots = freeSlots({
      date: "2026-10-15",
      timeZone: "America/Montevideo",
      minutes: 30,
      busy: [],
      now: new Date("2026-10-15T12:00:00Z"), // 9:00 in Montevideo
    });
    expect(slots[0].toISOString()).toBe("2026-10-15T14:00:00.000Z"); // 11:00
  });
});

describe("cost", () => {
  it("prices tokens per model, cache reads cheaper", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    expect(costUsd("claude-haiku-5-5", usage)).toBeCloseTo(0.61);
    expect(costUsd("claude-sonnet-5-5", usage)).toBeCloseTo(12.2);
  });
});

describe("echoes", () => {
  const payload = (
    message: { mid: string; text?: string; is_echo?: boolean },
    sender = "ACCOUNT",
    recipient = "USER"
  ) => ({
    object: "instagram",
    entry: [{ id: "ACCOUNT", time: 0, messaging: [{ sender: { id: sender }, recipient: { id: recipient }, message }] }],
  });

  it("reads a message the account sent, addressed to the person", () => {
    expect(parseEchoEvents(payload({ mid: "m1", text: " hola! ", is_echo: true }))).toEqual([
      { instagramAccountId: "ACCOUNT", userId: "USER", messageId: "m1", messageText: "hola!" },
    ]);
  });

  it("ignores ordinary inbound messages, and the message parser ignores echoes", () => {
    const inbound = payload({ mid: "m2", text: "hola" }, "USER", "ACCOUNT");
    expect(parseEchoEvents(inbound)).toEqual([]);
    expect(parseMessageEvents(payload({ mid: "m1", text: "hola", is_echo: true }))).toEqual([]);
  });
});

describe("page text", () => {
  it("keeps the readable text of a resource page", () => {
    const html =
      "<html><head><style>p{}</style><script>var x=1</script></head><body><h1>Guía</h1><p>Paso 1: instalá &amp; probá</p></body></html>";
    expect(pageText(html)).toBe("Guía\nPaso 1: instalá & probá");
  });
});

describe("turn prompt", () => {
  const input: TurnInput = {
    mode: "charla",
    reel: "campaña: Skills",
    username: "juan",
    phase: "situacion",
    notes: "tiene una inmobiliaria",
    timezone: null,
    email: null,
    resourceSent: false,
    resourceAvailable: true,
    call: null,
    audios: ["pitch"],
    transcript: [
      { role: "bot", text: "buenas! es para tu negocio?", at: new Date("2026-10-14T15:00:00Z") },
      { role: "user", text: "si, una inmobiliaria", at: new Date("2026-10-14T15:01:00Z") },
    ],
    now: new Date("2026-10-14T15:02:00Z"),
    ownerTimeZone: "America/Montevideo",
  };

  it("gives the model the reel, the person, the audios and the chat", () => {
    const prompt = buildTurnPrompt(input);
    expect(prompt).toContain("<reel>\ncampaña: Skills\n</reel>");
    expect(prompt).toContain("usuario: @juan");
    expect(prompt).toContain("recurso: todavía no se lo mandaste");
    expect(prompt).toContain("<audios_disponibles>pitch</audios_disponibles>");
    expect(prompt).toContain("[14/10, 12:01] la persona: si, una inmobiliaria");
    expect(prompt).toContain("escribí tu próxima respuesta.");
  });

  it("asks for exactly one message on the opening", () => {
    expect(buildTurnPrompt({ ...input, mode: "abridor" })).toContain("exactamente un mensaje");
  });
});

describe("attachments", () => {
  it("describes what the person sent", () => {
    expect(describeAttachment("audio")).toBe("[mandó un audio de voz]");
    expect(describeAttachment(undefined)).toBe("[mandó un archivo]");
  });
});
