import { describe, expect, it } from "vitest";
import {
  calculateCtr,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "../lib/tracking/analytics";
import {
  buildTrackedUrl,
  extractFirstUrl,
  pickVariants,
  renderMessageWithoutLink,
  renderMessageWithTracking,
  replaceUrlWithTrackedPlaceholder,
} from "../lib/tracking/message";

describe("tracked link messages", () => {
  it("extracts a destination URL and replaces it with the tracked placeholder", () => {
    const message =
      "Hey {username}, here is your guide: https://example.com/guide.";
    const url = extractFirstUrl(message);

    expect(url).toBe("https://example.com/guide");
    expect(replaceUrlWithTrackedPlaceholder(message, url)).toBe(
      "Hey {username}, here is your guide: {link}."
    );
  });

  it("renders tracked URLs with username personalization", () => {
    expect(
      renderMessageWithTracking({
        message: "Hey {username}, grab it here: {link}",
        commenterName: "Maya",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Hey Maya, grab it here: https://manychat-alternative.com/r/abc123");
  });

  it("can replace a raw destination URL when the placeholder is missing", () => {
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com/guide",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com/",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("matches normalized root URLs with or without trailing slash", () => {
    expect(
      replaceUrlWithTrackedPlaceholder("Link: https://example.com", "https://example.com/")
    ).toBe("Link: {link}");
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("builds redirect URLs from a base URL", () => {
    expect(buildTrackedUrl("abc123", "https://manychat-alternative.com/")).toBe(
      "https://manychat-alternative.com/r/abc123"
    );
  });
});

describe("campaign analytics helpers", () => {
  it("summarizes DM status rows", () => {
    expect(
      summarizeDmStatuses([
        { status: "SENT", _count: 20 },
        { status: "FAILED", _count: 2 },
        { status: "SKIPPED_RATE_LIMIT", _count: 3 },
        { status: "SKIPPED_PLAN_LIMIT", _count: 1 },
      ])
    ).toEqual({ sent: 20, skipped: 4, failed: 2 });
  });

  it("calculates CTR and handles empty send volume", () => {
    expect(calculateCtr(5, 20)).toBe(25);
    expect(calculateCtr(2, 3)).toBe(66.7);
    expect(calculateCtr(5, 0)).toBe(0);
  });

  it("normalizes top keywords by count", () => {
    expect(
      normalizeTopKeywords([
        { matchedKeyword: "PRICE", _count: 3 },
        { matchedKeyword: null, _count: 9 },
        { matchedKeyword: "LINK", _count: 7 },
      ])
    ).toEqual([
      { keyword: "LINK", count: 7 },
      { keyword: "PRICE", count: 3 },
    ]);
  });
});

describe("message variants", () => {
  it("picks one option from each {a|b} group", () => {
    const first = () => 0;
    const last = () => 0.99;
    expect(pickVariants("{Hola|Buenas|Qué tal}, ¿{todo bien|cómo va}?", first)).toBe("Hola, ¿todo bien?");
    expect(pickVariants("{Hola|Buenas|Qué tal}, ¿{todo bien|cómo va}?", last)).toBe("Qué tal, ¿cómo va?");
  });

  it("leaves placeholders and plain braces alone", () => {
    expect(pickVariants("Hola {username}, acá va {link}")).toBe("Hola {username}, acá va {link}");
  });

  it("fills the name before picking, so it can sit inside a group", () => {
    const rendered = renderMessageWithoutLink({
      message: "{Listo {username} 🙌|Listo {username} 🙌}",
      commenterName: "ana",
    });
    expect(rendered).toBe("Listo ana 🙌");
  });

  it("drops the name cleanly when it is unknown", () => {
    expect(renderMessageWithoutLink({ message: "¡Hola {username}! Acá va", commenterName: null }))
      .toBe("¡Hola! Acá va");
  });

  it("varies messages with a tracked link too", () => {
    const rendered = renderMessageWithTracking({
      message: "{Listo|Listo} {username}: {link}",
      commenterName: "ana",
      trackedLinks: [{ slug: "abc", destinationUrl: "https://example.com" }],
      baseUrl: "https://t.example",
    });
    expect(rendered).toBe("Listo ana: https://t.example/r/abc");
  });
});
