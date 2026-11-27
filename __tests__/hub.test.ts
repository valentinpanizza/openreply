import { UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hubForwardEnabled, hubKey, isHubRequest, signForHub } from "../lib/hub/config";
import { ECHO_DELAY_MS, forwardJobsFor } from "../lib/hub/forward";
import { hubAudios } from "../lib/hub/people";
import { postToHub } from "../lib/hub/post";
import { sendBody } from "../lib/hub/send";
import { parseRange, rangeBounds } from "../lib/hub/stats";

const KEY = "k".repeat(40);
const IG = "17841400000000000";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Hub key", () => {
  it("needs a long key, and checks it in full", () => {
    expect(hubKey({ HUB_CLAVE: "short" })).toBeNull();
    expect(hubKey({ HUB_CLAVE: ` ${KEY} ` })).toBe(KEY);
    const env = { HUB_CLAVE: KEY };
    expect(isHubRequest(`Bearer ${KEY}`, env)).toBe(true);
    expect(isHubRequest(`Bearer ${KEY}x`, env)).toBe(false);
    expect(isHubRequest(`Bearer ${"j".repeat(40)}`, env)).toBe(false);
    expect(isHubRequest(KEY, env)).toBe(false);
    expect(isHubRequest(null, env)).toBe(false);
    expect(isHubRequest(`Bearer ${KEY}`, {})).toBe(false);
  });

  it("forwards only with both the URL and the key", () => {
    expect(hubForwardEnabled({ HUB_URL: "https://hub.test", HUB_CLAVE: KEY })).toBe(true);
    expect(hubForwardEnabled({ HUB_URL: "hub.test", HUB_CLAVE: KEY })).toBe(false);
    expect(hubForwardEnabled({ HUB_URL: "https://hub.test" })).toBe(false);
  });
});

describe("forwardJobsFor", () => {
  const message = (mid: string, extra: Record<string, unknown> = {}) => ({
    sender: { id: "u1" },
    recipient: { id: IG },
    timestamp: 1,
    message: { mid, text: "hola", ...extra },
  });

  it("only takes the Hub's account and Instagram payloads", () => {
    const payload = { object: "instagram", entry: [{ id: IG, messaging: [message("m1")] }, { id: "other", messaging: [message("m2")] }] };
    const jobs = forwardJobsFor(payload, IG);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ account: IG, event: message("m1"), echo: false });
    expect(jobs[0].delay).toBe(0);
    expect(forwardJobsFor({ ...payload, object: "page" }, IG)).toEqual([]);
  });

  it("delays echoes so the setter records its own ids first", () => {
    const [job] = forwardJobsFor({ object: "instagram", entry: [{ id: IG, messaging: [message("m1", { is_echo: true })] }] }, IG);
    expect(job.data.echo).toBe(true);
    expect(job.delay).toBe(ECHO_DELAY_MS);
  });

  it("dedupes a message by its id, and a reaction by when it happened", () => {
    const twice = forwardJobsFor({ object: "instagram", entry: [{ id: IG, messaging: [message("m1"), message("m1")] }] }, IG);
    expect(twice[0].jobId).toBe(twice[1].jobId);
    const react = (timestamp: number, action = "react") => ({ timestamp, reaction: { mid: "m1", action, emoji: "❤" } });
    const jobs = forwardJobsFor(
      { object: "instagram", entry: [{ id: IG, messaging: [react(1), react(2), react(3, "unreact"), { timestamp: 4 }] }] },
      IG
    );
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.jobId)).size).toBe(3);
    expect(jobs.every((j) => /^fwd_[\w-]+$/.test(j.jobId))).toBe(true);
  });
});

describe("sendBody", () => {
  it("text, tagged as written by a person past 24 h", () => {
    expect(sendBody("u1", { kind: "message", text: "hola", tag: false })).toEqual({ recipient: { id: "u1" }, message: { text: "hola" } });
    expect(sendBody("u1", { kind: "message", text: "hola", tag: true })).toEqual({
      recipient: { id: "u1" },
      message: { text: "hola" },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
  });

  it("an attachment by URL, and a heart", () => {
    expect(sendBody("u1", { kind: "message", attachment: { type: "audio", url: "https://a/x.m4a" }, tag: false })).toEqual({
      recipient: { id: "u1" },
      message: { attachment: { type: "audio", payload: { url: "https://a/x.m4a" } } },
    });
    expect(sendBody("u1", { kind: "reaction", mid: "m1", emoji: "❤️" })).toEqual({
      recipient: { id: "u1" },
      sender_action: "react",
      payload: { message_id: "m1", reaction: "love" },
    });
    expect(sendBody("u1", { kind: "reaction", mid: "m1", emoji: null })).toEqual({
      recipient: { id: "u1" },
      sender_action: "unreact",
      payload: { message_id: "m1" },
    });
  });
});

describe("postToHub", () => {
  it("signs the exact body it sends", async () => {
    vi.stubEnv("HUB_URL", "https://hub.test/");
    vi.stubEnv("HUB_CLAVE", KEY);
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    await postToHub({ tipo: "envio", clave: "c1", mid: "m1", error: null }, fetcher as unknown as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.test/api/webhooks/openreply");
    expect((init.headers as Record<string, string>)["X-OpenReply-Firma"]).toBe(signForHub(init.body as string, KEY));
  });

  it("retries a Hub that is down, not a body it rejects", async () => {
    vi.stubEnv("HUB_URL", "https://hub.test");
    vi.stubEnv("HUB_CLAVE", KEY);
    const answer = (status: number) => (async () => new Response("no", { status })) as unknown as typeof fetch;
    await expect(postToHub({}, answer(503))).rejects.not.toBeInstanceOf(UnrecoverableError);
    await expect(postToHub({}, answer(400))).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("rangeBounds", () => {
  const now = Date.parse("2026-11-27T15:00:00Z"); // 12:00 in Montevideo (UTC-3)

  it("hoy and ayer follow the owner's calendar", () => {
    expect(rangeBounds("hoy", now, "America/Montevideo")).toEqual({ from: Date.parse("2026-11-27T03:00:00Z"), to: now });
    expect(rangeBounds("ayer", now, "America/Montevideo")).toEqual({
      from: Date.parse("2026-11-26T03:00:00Z"),
      to: Date.parse("2026-11-27T03:00:00Z"),
    });
  });

  it("7d and 30d count back from now; anything else is 7d", () => {
    expect(rangeBounds("7d", now).from).toBe(now - 7 * 86_400_000);
    expect(rangeBounds("30d", now).from).toBe(now - 30 * 86_400_000);
    expect(parseRange("x")).toBe("7d");
    expect(parseRange("30d")).toBe("30d");
  });
});

describe("hubAudios", () => {
  it("names each recorded audio, numbering repeats", () => {
    expect(hubAudios("pitch=https://a/1.m4a|https://a/2.m4a;situacion=https://a/s.m4a;otro=https://a/o.m4a")).toEqual([
      { id: "situacion", nombre: "Situación actual", url: "https://a/s.m4a" },
      { id: "pitch-1", nombre: "Pitch de agenda (1)", url: "https://a/1.m4a" },
      { id: "pitch-2", nombre: "Pitch de agenda (2)", url: "https://a/2.m4a" },
    ]);
  });
});
