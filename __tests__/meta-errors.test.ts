import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaApiError, PermissionError, sendPrivateReply } from "../lib/meta/client";

function graphError(code: number, subcode: number, message: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    url: "https://graph.instagram.com/v25.0/ig_1/messages",
    json: async () => ({ error: { code, error_subcode: subcode, message, type: "IGApiException" } }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Meta API errors", () => {
  it("keeps the subcode on permission errors", async () => {
    // The worker decides whether a failed private reply is worth retrying from
    // this subcode; losing it made every refusal look retryable.
    vi.stubGlobal("fetch", graphError(100, 2534025, "The comment is invalid for a private reply"));

    const error = await sendPrivateReply("token", "ig_1", "comment_1", "hi").catch((e) => e);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ code: 100, subcode: 2534025 });
  });

  it("keeps the subcode on other Meta errors", async () => {
    vi.stubGlobal("fetch", graphError(2, 1545133, "Service temporarily unavailable"));

    const error = await sendPrivateReply("token", "ig_1", "comment_1", "hi").catch((e) => e);
    expect(error).toMatchObject({ name: "MetaApiError", code: 2, subcode: 1545133 });
  });
});
