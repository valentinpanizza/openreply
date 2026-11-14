/**
 * Booking a call without the person's mail: the event goes out with no guest
 * (the Meet link is passed by DM), and a mail given later becomes the guest.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCallGuest, callMeetLink, createCallEvent } from "../lib/setter/calendar";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(event: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = url.includes("oauth2") ? { access_token: "t", expires_in: 3600 } : event;
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  return calls.filter.bind(calls);
}

describe("calls without a mail", () => {
  it("books with no guest and hands back the Meet link", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const body = url.includes("oauth2")
          ? { access_token: "t", expires_in: 3600 }
          : { id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    const event = await createCallEvent({
      start: new Date("2026-11-15T12:00:00Z"),
      minutes: 30,
      email: null,
      summary: "Llamada",
      description: "x",
    });
    expect(event).toEqual({ id: "ev1", meetLink: "https://meet.google.com/abc-defg-hij" });
    const post = calls.find((c) => c.url.includes("/events?"))!;
    expect(JSON.parse(String(post.init!.body)).attendees).toEqual([]);
  });

  it("adds the mail later and sends the invitation", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600, id: "ev1" }), { status: 200 });
      })
    );
    await addCallGuest("ev1", "a@b.com");
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toContain("/events/ev1?sendUpdates=all");
    expect(JSON.parse(String(patch.init!.body))).toEqual({ attendees: [{ email: "a@b.com" }] });
  });

  it("reads the Meet link back, none for a cancelled event", async () => {
    mockFetch({ id: "ev1", hangoutLink: "https://meet.google.com/x" });
    expect(await callMeetLink("ev1")).toBe("https://meet.google.com/x");
    mockFetch({ id: "ev1", status: "cancelled", hangoutLink: "https://meet.google.com/x" });
    expect(await callMeetLink("ev1")).toBeNull();
  });
});
