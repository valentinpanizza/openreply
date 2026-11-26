import { describe, expect, it } from "vitest";
import {
  gapWithJitter,
  sendGateConfig,
  SendGateTimeoutError,
  waitForSendSlot,
  type SendGateConfig,
  type SendGateDeps,
} from "../lib/utils/send-gate";

const CFG: SendGateConfig = { minGapMs: 45_000, jitter: 0.5, maxPerHour: 60, maxWaitMs: 3 * 3_600_000 };

/** An in-memory copy of the Redis script, on a fake clock. */
function fakeGate(cfg = CFG) {
  let clock = 0;
  let nextAt = 0;
  let sends: number[] = [];
  const sent: number[] = [];
  const deps: SendGateDeps = {
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
    evalGate: async (_keys, args) => {
      const [now, gap, cap] = args.map(Number);
      sends = sends.filter((t) => t > now - 3_600_000);
      let wait = Math.max(0, nextAt - now);
      if (cap > 0 && sends.length >= cap) wait = Math.max(wait, sends[0] + 3_600_000 - now);
      if (wait > 0) return wait;
      nextAt = now + gap;
      sends.push(now);
      sent.push(now);
      return 0;
    },
  };
  return { deps, sent, cfg, tick: (ms: number) => (clock += ms) };
}

describe("send gate", () => {
  it("never lets two messages out together, even when many are ready at once", async () => {
    const g = fakeGate();
    for (let i = 0; i < 10; i++) await waitForSendSlot("ig:1", g.deps, g.cfg);
    for (let i = 1; i < g.sent.length; i++) {
      expect(g.sent[i] - g.sent[i - 1]).toBeGreaterThanOrEqual(45_000);
    }
  });

  it("caps a rolling hour", async () => {
    const g = fakeGate({ ...CFG, minGapMs: 20_000, jitter: 0, maxPerHour: 5 });
    for (let i = 0; i < 6; i++) await waitForSendSlot("ig:1", g.deps, g.cfg);
    expect(g.sent[5] - g.sent[0]).toBeGreaterThanOrEqual(3_600_000);
  });

  it("waits instead of sending when Redis fails", async () => {
    const g = fakeGate();
    let failures = 2;
    const real = g.deps.evalGate;
    g.deps.evalGate = async (k, a) => {
      if (failures-- > 0) throw new Error("ECONNRESET");
      return real(k, a);
    };
    await waitForSendSlot("ig:1", g.deps, g.cfg);
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0]).toBeGreaterThanOrEqual(10_000);
  });

  it("gives up after the maximum wait rather than sleeping forever", async () => {
    const g = fakeGate({ ...CFG, maxWaitMs: 60_000 });
    g.deps.evalGate = async () => 10 * 60_000;
    await expect(waitForSendSlot("ig:1", g.deps, g.cfg)).rejects.toBeInstanceOf(SendGateTimeoutError);
  });

  it("adds a random extra to the gap and keeps a 20 s floor", () => {
    expect(gapWithJitter(CFG, () => 0)).toBe(45_000);
    expect(gapWithJitter(CFG, () => 1)).toBe(67_500);
    expect(sendGateConfig({ SEND_MIN_GAP_SECONDS: "1" }).minGapMs).toBe(20_000);
    expect(sendGateConfig({}).maxPerHour).toBe(60);
  });
});
