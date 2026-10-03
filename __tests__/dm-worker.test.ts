import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
  mockSendDirectMessageWithButton,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockReleaseDMSlot,
  mockQueueAdd,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
  mockSendDirectAttachment,
  mockReservePaceSlot,
  mockMarkPaced,
  mockIsPaced,
  mockPrivateReplyBreakerUntil,
  mockRecordPrivateReplyOutcome,
} = vi.hoisted(() => ({
  mockPrisma: {
    zernioConnection: { findUnique: vi.fn() },
    postbackDelivery: { create: vi.fn(), delete: vi.fn() },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    lead: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockReleaseDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
  mockSendDirectAttachment: vi.fn(),
  mockReservePaceSlot: vi.fn(),
  mockMarkPaced: vi.fn(),
  mockIsPaced: vi.fn(),
  mockPrivateReplyBreakerUntil: vi.fn(),
  mockRecordPrivateReplyOutcome: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  sendDirectMessageWithButton: mockSendDirectMessageWithButton,
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  sendDirectAttachment: mockSendDirectAttachment,
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {
    code: number;
    subcode: number | undefined;
    constructor(
      code: number,
      subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.subcode = subcode;
      this.name = "MetaApiError";
    }
  },
  TokenExpiredError: class TokenExpiredError extends Error {
    name = "TokenExpiredError";
  },
  RateLimitError: class RateLimitError extends Error {
    name = "RateLimitError";
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
  releaseDMSlot: mockReleaseDMSlot,
  reservePaceSlot: mockReservePaceSlot,
  markPaced: mockMarkPaced,
  isPaced: mockIsPaced,
  privateReplyBreakerUntil: mockPrivateReplyBreakerUntil,
  recordPrivateReplyOutcome: mockRecordPrivateReplyOutcome,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
  }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
  LEAD_JOB_NAME: "notify-lead",
  LEAD_AUDIO_JOB_NAME: "send-lead-audio",
  OPENING_DM_READ_FALLBACK_WINDOW_MS: 24 * 60 * 60 * 1000,
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  return {
    Worker: MockWorker,
    UnrecoverableError: class UnrecoverableError extends Error {
      name = "UnrecoverableError";
    },
  };
});

import { createDMWorker, typedAnswerIsLead } from "../lib/queue/dm-worker";
import { getRedisConnection } from "@/lib/queue/client";
import { MetaApiError, sendCommentReply } from "@/lib/meta/client";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  name?: string;
  data: typeof mockJobData | Record<string, unknown>;
  id: string;
  attemptsMade: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    name?: string;
    data: typeof mockJobData | Record<string, unknown>;
    id: string;
    attemptsMade: number;
  }) => Promise<void>;
}

function createMockJob(data: Record<string, unknown> = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
  };
}

function createMockPostbackJob(
  data: Record<string, unknown> = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "reveal:auto_789",
  }
) {
  return {
    name: "process-postback",
    data,
    id: "postback_job_001",
    attemptsMade: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.postbackDelivery.create.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.delete.mockReset().mockResolvedValue({});

  mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  // Two different lookups share findFirst: the cross-campaign private-reply
  // check (keyed on status SENT) and the postback's name lookup. Only the
  // latter should resolve by default, or every comment would look like a
  // duplicate of an already-answered one.
  mockPrisma.dmLog.findFirst.mockImplementation(
    async (args: { where?: { status?: string; dmSentAt?: unknown } } = {}) =>
      // The read fallback's recent-opening check: by default there is one.
      args.where?.dmSentAt
        ? { id: "opening_log" }
        : args.where?.status === "SENT" ? null : { commenterName: "commenter_user" }
  );
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockResolvedValue({});
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseDMSlot.mockResolvedValue(0);
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
  mockSendPrivateReplyWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_003",
  });
  mockSendDirectMessageWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_004",
  });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_005",
  });
  mockSendDirectMessageWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_006",
  });
  mockGetUserFollowStatus.mockResolvedValue(true);
  mockPrivateReplyBreakerUntil.mockResolvedValue(null);
  mockRecordPrivateReplyOutcome.mockResolvedValue(0);
});

describe("DM Worker — comments left on an ad", () => {
  it("also matches the organic post the ad was created from", async () => {
    const processor = getProcessor();

    // A boosted post: the comment carries the ad's media id, while the
    // campaign is bound to the post the ad was made from. Without the second
    // id in the query the comment matches nothing and is dropped silently.
    await processor(
      createMockJob({
        ...mockJobData,
        mediaId: "ad_media_999",
        originalMediaId: "media_101",
      })
    );

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { postId: "ad_media_999" },
            { postId: "media_101" },
            { matchAnyPost: true },
          ],
        }),
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });
});

describe("DM Worker — Full Pipeline", () => {
  it("should send a private reply for a matching comment", async () => {
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        isActive: true,
        instagramAccount: { instagramId: "ig_456" },
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            label: true,
            destinationUrl: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(mockMatchKeywords).toHaveBeenCalledWith(
      "I want the LINK!",
      ["LINK", "PRICE"],
      true
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReserveDMSlot).toHaveBeenCalledWith("ig_456", 0);
    // A successful send keeps its slot; the release path is failure-only.
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted_token_abc");
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("should skip when no automations match the media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("should skip when keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip duplicate comments already sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_log",
      status: "SENT",
    });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip when monthly plan limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should requeue and release monthly usage when rate limited", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: 1800000,
      shouldSkip: false,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({
        commentId: "comment_555",
        requeueAttempt: 1,
      }),
      expect.objectContaining({
        delay: 1800000,
        jobId: "comment_ig_456_comment_555_retry_1",
      })
    );
  });

  it("should skip with SKIPPED_RATE_LIMIT after max requeue attempts", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
      })
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should log FAILED, release usage, and re-throw when private reply sending fails", async () => {
    const error = new Error("API Error");
    mockSendPrivateReply.mockRejectedValue(error);

    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("API Error");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "API Error",
      }),
    });
  });

  it("should handle missing access token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          accessToken: null,
        },
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        }),
      })
    );
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should drop the name when the commenter name is not available", async () => {
    const processor = getProcessor();
    const jobDataWithoutName = {
      instagramAccountId: mockJobData.instagramAccountId,
      commentId: mockJobData.commentId,
      commentText: mockJobData.commentText,
      commenterId: mockJobData.commenterId,
      mediaId: mockJobData.mediaId,
    };

    await processor(createMockJob(jobDataWithoutName as typeof mockJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey! Here is the link: https://example.com"
    );
  });

  it("should deliver tracked links as web_url buttons (one or two)", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
          {
            slug: "def456",
            label: "Book a call",
            destinationUrl: "https://example.com/book",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Primary button title comes from linkButtonLabel; the second from its
    // own stored label. Both point at their tracked /r/<slug> URLs.
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        { title: "Get offer", url: "http://localhost:3000/r/abc123" },
        { title: "Book a call", url: "http://localhost:3000/r/def456" },
      ]
    );
  });

  it("should send a follow-gate prompt when a non-follower comments", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false); // not following yet
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first {username}, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // The follow prompt goes out with a `followcheck:` postback button; the
    // link is NOT delivered yet.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Follow me first commenter_user, then tap 👇",
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should skip the prompt and send the link when the commenter already follows", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true); // already following
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Confirmed follower: no prompt, link delivered right away.
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [{ title: "Get offer", url: "http://localhost:3000/r/abc123" }]
    );
  });

  it("should send the opening DM first (routing to the follow check) when both opening DM and follow-gate are on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        openingDmEnabled: true,
        openingDmMessage: "Hey {username}, welcome!",
        openingDmButtonLabel: "Get the link",
        requireFollow: true,
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Opening DM goes out first; its button routes into the follow check.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user, welcome!",
      "Get the link",
      "followcheck:auto_789:open"
    );
    // Follow status is verified on the tap, not at comment time.
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
  });

  it("should deliver the next DM from a read fallback when no button tap has sent it yet", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockPrisma.dmLog.findUnique).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
        },
      },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not deliver a read fallback when the button tap already sent the reveal", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_reveal",
      status: "SENT",
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback bypass the follow gate", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(false); // still not following

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    // Non-follower on a read fallback: no link, and no re-prompt spam either.
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback through when follow status is unverifiable", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    // Instagram answers "User consent is required" until the person taps a
    // button, which is exactly the case of someone who only read the DM.
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("should deliver a follow-gated read fallback once the user follows", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not log a failure when a read fallback hits a closed messaging window", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(
      new Error("This message is sent outside of allowed window.")
    );

    const processor = getProcessor();
    // The window cannot reopen on its own, so this must not throw (no retries)
    // and must not leave a FAILED row the user can do nothing about.
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      )
    ).resolves.toBeUndefined();

    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
  });

  it("should still log a failure for a real button tap that fails", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(new Error("boom"));

    const processor = getProcessor();
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
        })
      )
    ).rejects.toThrow("boom");

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker — one private reply per comment", () => {
  it("should skip a campaign when another already used the comment's private reply", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string } } = {}) =>
        args.where?.status === "SENT"
          ? { automation: { name: "openreply 1" } }
          : { commenterName: "commenter_user" }
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("openreply 1"),
        }),
      })
    );
  });

  it("should not fall back to a plain-text private reply when the window is the problem", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new Error("The comment is invalid for a private reply")
    );

    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow(
      "The comment is invalid for a private reply"
    );

    // The reserved rate slot must be handed back when the send fails, so a
    // comment that never delivered a DM does not burn slots on each retry.
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");

    // A text retry on the same comment would fail identically and overwrite the
    // real reason, so it must not be attempted.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorMessage: "The comment is invalid for a private reply",
        }),
      })
    );
  });

  it("should still fall back to plain text when the button template itself is rejected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new Error("Unsupported message template")
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      })
    );
  });
});

describe("DM Worker — DM keyword trigger", () => {
  const dmTriggerAutomation = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
  };

  function createMockMessageJob(data: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_abc",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
        ...data,
      },
      id: "message_job_001",
      attemptsMade: 0,
    };
  }

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([dmTriggerAutomation]);
  });

  it("should reply to a DM whose text matches the campaign keywords", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dmTriggerEnabled: true,
          isActive: true,
        }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    // Never a private reply — there is no comment to reply to.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should not reply when the DM text matches no keyword", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    const processor = getProcessor();
    await processor(createMockMessageJob({ messageText: "hello there" }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("should log the reply against the inbound message id for dedup", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_789",
            commentId: "dm:mid_abc",
          },
        },
        create: expect.objectContaining({
          commenterId: "commenter_999",
          commentText: "can I get the LINK?",
          matchedKeyword: "LINK",
          status: "SENT",
        }),
      })
    );
  });

  it("should not re-send when this message was already answered", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should send the link as buttons when the campaign has tracked links", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        linkButtonLabel: "Get it",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Get it",
            destinationUrl: "https://example.com/offer",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should send the follow prompt instead of the link to a non-follower", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  // First contact, so the gate is fail-closed like processComment: an
  // unverifiable status must not hand out the link.
  it("should send the follow prompt when follow status cannot be verified", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should skip and log when the workspace is over its monthly limit", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should release the usage reservation and rethrow when the send fails", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("Meta is down"));

    const processor = getProcessor();
    await expect(processor(createMockMessageJob())).rejects.toThrow(
      "Meta is down"
    );

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("Zernio worker routing", () => {
  it("fails open on unknown follow status and sends once through the selected provider", async () => {
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted_key",
    });
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          provider: "ZERNIO",
          workspaceId: "workspace_123",
          zernioAccountId: "zernio_selected",
          accessToken: "",
        },
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            isFollower: null,
            unavailableReason: "consent_required",
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messageId: "sent" }))
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await getProcessor()(createMockJob());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain(
        "/inbox/comments/media_101/comment_555/private-reply"
      );
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).accountId).toBe(
        "zernio_selected"
      );
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SENT" }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("stops BullMQ retries after an ambiguous Zernio direct-message outcome", async () => {
  mockPrisma.zernioConnection.findUnique.mockResolvedValue({
    apiKey: "encrypted",
  });
  mockPrisma.automation.findFirst.mockResolvedValue({
    ...mockAutomation,
    instagramAccount: {
      ...mockAutomation.instagramAccount,
      provider: "ZERNIO",
      workspaceId: "workspace_123",
      zernioAccountId: "remote",
      accessToken: "",
    },
  });
  const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(getProcessor()(createMockPostbackJob())).rejects.toMatchObject(
      {
        name: "UnrecoverableError",
        message: expect.stringContaining("Inspect the Instagram inbox"),
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('binds queued comments to the local connection that received them', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([]);
  const job = createMockJob();
  Object.assign(job.data, { accountConnectionId: 'original-connection' });
  await getProcessor()(job);
  expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instagramAccountId: 'original-connection' }) }));
});

it('never automatically resends a private reply with an unconfirmed delivery', async () => {
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'FAILED', dmDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockSendPrivateReply).not.toHaveBeenCalled();
  expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

it('keeps an unconfirmed public reply untouched after the DM was delivered', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessage: 'Thanks!', publicReplyMessages: [] }]);
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'SENT', publicReplyDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

describe("durable Zernio postback delivery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      },
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        claims.delete(where.id);
      },
    );
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted",
    });
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock = vi.fn();
  });

  function tap(mid: string) {
    return createMockPostbackJob({
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "reveal:auto_789",
      mid,
    });
  }

  it("retains an uncertain tap across a newer successful tap and queue eviction", async () => {
    fetchMock
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: { messageId: "new-tap" } })),
      )
      .mockRejectedValueOnce(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("old"))).rejects.toMatchObject({
        name: "UnrecoverableError",
      });
      await process(tap("new"));
      await process({ ...tap("old"), id: "redelivery-job" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates successful old taps while permitting each distinct new mid", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await process(tap("first"));
      await process(tap("second"));
      await process({ ...tap("first"), id: "after-retention" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("releases a claim on a confirmed rejection so the same tap can retry", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { messageId: "sent" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("retry"))).rejects.toThrow();
      await process(tap("retry"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("claims concurrent deliveries of the same tap before either can send twice", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await Promise.all([
        process(tap("concurrent")),
        process({ ...tap("concurrent"), id: "other-job" }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates follow-gate prompts as well as reveal messages", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock.mockImplementation(
      async (_url: string, init: { method: string }) =>
        new Response(
          JSON.stringify(
            init.method === "GET"
              ? { isFollower: false }
              : { data: { messageId: "prompt" } },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      const followTap = tap("follow");
      // The prompt goes out on the last delayed re-check — an earlier false
      // only queues the next one — so exercise that pass: that is where the
      // prompt is sent, and where a redelivery must not send it a second time.
      followTap.data = {
        ...followTap.data,
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 2,
      };
      await process(followTap);
      await process({ ...followTap, id: "redelivery" });
      expect(
        fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("DM Worker — follow-gate re-check", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };

  it("re-checks a first false follow later instead of rejecting the tap", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    // Nothing is sent yet: a brand-new follow may simply not have registered.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheck: true, userId: "commenter_999" }),
      expect.objectContaining({ delay: expect.any(Number) })
    );
  });

  it("prompts and records the rejection when the last re-check still finds no follow", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 2,
      })
    );

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          message: "Follow gate rejected a button tap",
        }),
      })
    );
    // A re-check never queues another re-check.
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("buckets the re-check id by time so a later tap is not blocked by an old job", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    const [, , opts] = mockQueueAdd.mock.calls[0];
    // A fixed per-user id would collide with the retained completed job of an
    // earlier re-check and be dropped silently by BullMQ.
    expect(opts.jobId).toMatch(/^postback_recheck_auto_789_commenter_999_1_\d+$/);
  });

  it("checks twice: soon after the tap, then again before giving up", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
    const tap = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "followcheck:auto_789",
    };

    await getProcessor()(createMockPostbackJob(tap));
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.objectContaining({ delay: 20_000 })
    );

    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.objectContaining({ delay: 40_000 })
    );
    // Neither pass has given up yet, so neither re-sends the prompt.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("treats a re-check queued before counting existed as the first one done", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
      })
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.anything()
    );
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("prompts a non-follower right away when the tap came from the opening DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:open",
      })
    );

    // Tapping the opening DM is not a claim to follow, so there is nothing to
    // wait for: the follow prompt goes out now, not after the re-check delay.
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      expect.any(String),
      "followcheck:auto_789"
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // Nor is it a rejection: they were never told to follow before this.
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("prompts a non-follower right away after a lead-button tap, keeping the lead", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
    mockPrisma.lead.create.mockResolvedValue({ id: "lead_1" });

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:lead",
      })
    );

    expect(mockPrisma.lead.create).toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalledWith(
      "process-postback",
      expect.anything(),
      expect.anything()
    );
  });
});

describe("DM Worker — follow re-check acknowledgement", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };
  const tap = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "followcheck:auto_789",
  };
  const mockRedisSet = vi.fn();

  beforeEach(() => {
    process.env.FOLLOW_RECHECK_ACK_MESSAGE = "Dame unos segundos que lo verifico";
    mockRedisSet.mockReset().mockResolvedValue("OK");
    vi.mocked(getRedisConnection).mockReturnValue({ set: mockRedisSet } as never);
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;
  });

  it("answers a not-yet-visible follow right away instead of leaving the chat silent", async () => {
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Dame unos segundos que lo verifico"
    );
    // The re-check is still what decides; the acknowledgement only fills the wait.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("acknowledges a burst of taps only once", async () => {
    mockRedisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await getProcessor()(createMockPostbackJob(tap));
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge again on the re-check passes", async () => {
    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("still re-checks when the acknowledgement cannot be sent", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(new Error("boom"));

    await expect(getProcessor()(createMockPostbackJob(tap))).resolves.toBeUndefined();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("sends nothing extra when no acknowledgement message is configured", async () => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;

    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe("DM Worker — private replies Instagram refuses for good", () => {
  function failPrivateReply(error: Error) {
    mockSendPrivateReply.mockRejectedValue(error);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(error);
    mockSendPrivateReplyWithButton.mockRejectedValue(error);
  }

  it.each([
    [2534025, "El comentario no es válido para una respuesta privada"],
    [2534014, "No se puede encontrar al usuario solicitado."],
  ])("marks subcode %i as never-resend and stops BullMQ retries", async (subcode, message) => {
    failPrivateReply(new MetaApiError(100, subcode, undefined, message));

    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    // The flag the reconciler reads as handled, so no sweep re-enqueues it.
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", dmDeliveryUnconfirmed: true }),
      })
    );
  });

  it("marks 'Service temporarily unavailable' as never-resend: that attempt used the comment's one reply", async () => {
    failPrivateReply(new MetaApiError(2, 1545133, undefined, "Service temporarily unavailable"));

    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", dmDeliveryUnconfirmed: true }),
      })
    );
  });

  it("still retries a temporary Meta error", async () => {
    failPrivateReply(new MetaApiError(2, undefined, undefined, "An unexpected error has occurred"));

    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({
      name: "MetaApiError",
    });
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", dmDeliveryUnconfirmed: false }),
      })
    );
  });
});

describe("DM Worker — lead capture", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };

  it("saves a lead-button tap as a lead, queues its notification, and still sends the link", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(true);
    mockPrisma.lead.create.mockResolvedValue({ id: "lead_1" });

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:lead",
      })
    );

    expect(mockPrisma.lead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        automationId: "auto_789",
        userId: "commenter_999",
        username: "commenter_user",
      }),
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "notify-lead",
      expect.objectContaining({ leadId: "lead_1", instagramAccountId: "ig_456" })
    );
    // The ":lead" suffix must not break routing: the link still goes out.
    expect(mockSendDirectMessage).toHaveBeenCalled();
  });

  it("does not queue a second notification when the person is already a lead", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(true);
    mockPrisma.lead.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:lead",
      })
    );

    expect(mockQueueAdd).not.toHaveBeenCalledWith("notify-lead", expect.anything());
    // A repeat tap is still answered with the link.
    expect(mockSendDirectMessage).toHaveBeenCalled();
  });

  it("does not capture the lead again on the follow re-check pass", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(true);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:lead",
        followRecheck: true,
      })
    );

    expect(mockPrisma.lead.create).not.toHaveBeenCalled();
  });

  it("never lets a failed lead capture cost the person their link", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(true);
    mockPrisma.lead.create.mockRejectedValue(new Error("database down"));

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:lead",
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalled();
  });
});

describe("DM Worker — lead notification", () => {
  const leadRow = {
    id: "lead_1",
    automationId: "auto_789",
    userId: "commenter_999",
    username: "commenter_user",
    commentText: "legal",
    notifiedAt: null as Date | null,
    createdAt: new Date("2026-09-24T12:00:00Z"),
  };
  const fetchMock = vi.fn();
  const notifyJob = (id: string) => ({
    name: "notify-lead",
    data: { instagramAccountId: "ig_456", leadId: "lead_1" },
    id,
    attemptsMade: 0,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts the lead to the webhook with the shared secret and marks it notified", async () => {
    vi.stubEnv("LEAD_WEBHOOK_URL", "https://n8n.example/webhook/lead");
    vi.stubEnv("LEAD_WEBHOOK_SECRET", "s3cret");
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow);
    mockPrisma.automation.findUnique.mockResolvedValue({ name: "Legal checklist" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await getProcessor()(notifyJob("n1"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://n8n.example/webhook/lead");
    expect(init.headers["X-Lead-Secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toMatchObject({
      campaign: "Legal checklist",
      username: "commenter_user",
      profileUrl: "https://instagram.com/commenter_user",
      commentText: "legal",
    });
    expect(mockPrisma.lead.update).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { notifiedAt: expect.any(Date) },
    });
  });

  it("does not send a lead that was already notified", async () => {
    vi.stubEnv("LEAD_WEBHOOK_URL", "https://n8n.example/webhook/lead");
    mockPrisma.lead.findUnique.mockResolvedValue({ ...leadRow, notifiedAt: new Date() });
    vi.stubGlobal("fetch", fetchMock);

    await getProcessor()(notifyJob("n2"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a failed webhook so the job is retried, without marking it notified", async () => {
    vi.stubEnv("LEAD_WEBHOOK_URL", "https://n8n.example/webhook/lead");
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow);
    mockPrisma.automation.findUnique.mockResolvedValue({ name: "Legal checklist" });
    fetchMock.mockResolvedValue(new Response("down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProcessor()(notifyJob("n3"))).rejects.toThrow("502");
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  it("does not trust a bare 200 — the webhook must confirm with ok: true", async () => {
    // What n8n actually returns when its workflow fails before responding: a
    // 200 with an empty body. Treating that as success would lose the lead.
    vi.stubEnv("LEAD_WEBHOOK_URL", "https://n8n.example/webhook/lead");
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow);
    mockPrisma.automation.findUnique.mockResolvedValue({ name: "Legal checklist" });
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProcessor()(notifyJob("n5"))).rejects.toThrow(
      "did not confirm"
    );
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  it("does nothing when no lead webhook is configured", async () => {
    vi.stubEnv("LEAD_WEBHOOK_URL", "");
    vi.stubGlobal("fetch", fetchMock);

    await getProcessor()(notifyJob("n4"));

    expect(mockPrisma.lead.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DM Worker — lead voice note", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };
  const leadRow = {
    id: "lead_1",
    automationId: "auto_789",
    instagramAccountId: "ig_account_row_1",
    userId: "commenter_999",
    audioSentAt: null as Date | null,
  };
  const audioJob = { name: "send-lead-audio", data: { instagramAccountId: "ig_456", leadId: "lead_1" }, id: "a1", attemptsMade: 0 };
  const account = { id: "ig_account_row_1", instagramId: "ig_456", accessToken: "encrypted_token_abc" };

  beforeEach(() => {
    vi.stubEnv("LEAD_AUDIO_URLS", "https://files.example/hola.m4a");
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow);
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    mockPrisma.lead.update.mockResolvedValue({});
    mockPrisma.instagramAccount.findUnique.mockResolvedValue(account);
    mockSendDirectAttachment.mockResolvedValue({ recipient_id: "commenter_999", message_id: "m1" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("schedules the voice note with a delay when a lead is captured", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(true);
    mockPrisma.lead.create.mockResolvedValue({ id: "lead_1" });

    await getProcessor()(createMockPostbackJob({
      instagramAccountId: "ig_456", userId: "commenter_999", payload: "followcheck:auto_789:lead",
    }));

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "send-lead-audio",
      expect.objectContaining({ leadId: "lead_1" }),
      expect.objectContaining({ delay: expect.any(Number), jobId: "lead_audio_lead_1" })
    );
    const [, , opts] = mockQueueAdd.mock.calls.find(([name]) => name === "send-lead-audio")!;
    expect(opts.delay).toBeGreaterThanOrEqual(4 * 60_000);
  });

  it("does not schedule anything without audio files configured", async () => {
    vi.stubEnv("LEAD_AUDIO_URLS", "");
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(true);
    mockPrisma.lead.create.mockResolvedValue({ id: "lead_1" });

    await getProcessor()(createMockPostbackJob({
      instagramAccountId: "ig_456", userId: "commenter_999", payload: "followcheck:auto_789:lead",
    }));

    expect(mockQueueAdd).not.toHaveBeenCalledWith("send-lead-audio", expect.anything(), expect.anything());
  });

  it("sends the audio as an attachment and records it", async () => {
    await getProcessor()(audioJob);

    expect(mockSendDirectAttachment).toHaveBeenCalledWith(
      "decrypted_token", "ig_456", "commenter_999", "audio", "https://files.example/hola.m4a"
    );
    expect(mockPrisma.lead.update).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { audioSentAt: expect.any(Date), audioError: null },
    });
  });

  it("sends it once per person, even across campaigns", async () => {
    mockPrisma.lead.findFirst.mockResolvedValue({ id: "lead_other_campaign" });
    await getProcessor()(audioJob);
    expect(mockSendDirectAttachment).not.toHaveBeenCalled();
  });

  it("never resends after a retry once it went out", async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({ ...leadRow, audioSentAt: new Date() });
    await getProcessor()(audioJob);
    expect(mockSendDirectAttachment).not.toHaveBeenCalled();
  });

  it("records an unconfirmed delivery as sent, without retrying", async () => {
    mockSendDirectAttachment.mockRejectedValue(new MetaApiError(1, undefined, undefined, "An unknown error has occurred."));
    await expect(getProcessor()(audioJob)).resolves.toBeUndefined();
    expect(mockPrisma.lead.update).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { audioSentAt: expect.any(Date), audioError: expect.stringContaining("unconfirmed") },
    });
  });

  it("gives up quietly when the 24-hour window has closed", async () => {
    mockSendDirectAttachment.mockRejectedValue(
      new MetaApiError(10, 2534022, undefined, "Este mensaje se envía fuera del período permitido.")
    );
    await expect(getProcessor()(audioJob)).resolves.toBeUndefined();
    expect(mockPrisma.lead.update).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { audioError: expect.any(String) },
    });
  });

  it("lets BullMQ retry a temporary failure", async () => {
    mockSendDirectAttachment.mockRejectedValue(new MetaApiError(2, 1545133, undefined, "Service temporarily unavailable"));
    await expect(getProcessor()(audioJob)).rejects.toMatchObject({ name: "MetaApiError" });
  });
});

describe("DM Worker — lead reply ping", () => {
  const fetchMock = vi.fn();
  const message = (data: Record<string, unknown> = {}) => ({
    name: "process-message",
    data: { instagramAccountId: "ig_456", messageId: "mid_1", messageText: "tengo una inmobiliaria", senderId: "lead_user", ...data },
    id: "m1",
    attemptsMade: 0,
  });

  beforeEach(() => {
    vi.stubEnv("NTFY_TOPIC", "topic_x");
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "ig_account_row_1" });
    mockPrisma.lead.findFirst.mockResolvedValue({ username: "lauty" });
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    fetchMock.mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("pings the owner with a link that opens the chat", async () => {
    await getProcessor()(message());

    // Only leads that already got the voice note, and only unanswered ones.
    expect(mockPrisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "lead_user", audioSentAt: { not: null }, repliedAt: null }),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      topic: "topic_x",
      title: "@lauty respondió",
      message: '"tengo una inmobiliaria"',
      click: "https://ig.me/m/lauty",
    });
  });

  it("describes a voice note reply, and runs no keyword trigger for it", async () => {
    await getProcessor()(message({ messageText: "", attachmentType: "audio" }));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toBe("🎤 te mandó un audio");
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("pings once: a later message finds the lead already answered", async () => {
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 0 });
    await getProcessor()(message());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays quiet for people who are not waiting on a voice note", async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    await getProcessor()(message());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives the ping back when ntfy refuses it, so the next message retries", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await getProcessor()(message());
    expect(mockPrisma.lead.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { repliedAt: null },
    }));
  });

  it("never blocks the keyword trigger when the ping breaks", async () => {
    mockPrisma.instagramAccount.findFirst.mockRejectedValue(new Error("db down"));
    await expect(getProcessor()(message())).resolves.toBeUndefined();
    expect(mockPrisma.automation.findMany).toHaveBeenCalled();
  });
});

describe("DM Worker — private reply pacing", () => {
  beforeEach(() => {
    vi.stubEnv("PRIVATE_REPLY_INTERVAL_SECONDS", "90");
    mockIsPaced.mockResolvedValue(false);
    mockMarkPaced.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("schedules the comment for its turn instead of sending now", async () => {
    mockReservePaceSlot.mockImplementation(async (_a, _i, _m, now: number) => now + 10 * 60_000);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockMarkPaced).toHaveBeenCalledWith("ig_456", "comment_555", expect.any(Number));
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({ commentId: "comment_555", pacedFor: expect.any(Number) }),
      expect.objectContaining({ jobId: "comment_ig_456_comment_555_paced" })
    );
    const [, , opts] = mockQueueAdd.mock.calls[0];
    expect(opts.delay).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "PENDING", errorMessage: expect.stringContaining("Paced") }),
    }));
  });

  it("sends right away when its turn is now", async () => {
    mockReservePaceSlot.mockImplementation(async (_a, _i, _m, now: number) => now);
    await getProcessor()(createMockJob());
    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalledWith("process-comment", expect.anything(), expect.anything());
  });

  it("does not take a second turn for a copy of a comment already waiting", async () => {
    mockIsPaced.mockResolvedValue(true);
    await getProcessor()(createMockJob());
    expect(mockReservePaceSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("goes ahead on the scheduled run without asking for another turn", async () => {
    const job = createMockJob();
    // A copy: createMockJob hands out the shared mockJobData object.
    job.data = { ...job.data, pacedFor: Date.now() };
    await getProcessor()(job);
    expect(mockIsPaced).not.toHaveBeenCalled();
    expect(mockReservePaceSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });

  it("skips, with a reason, when the queue is longer than the maximum wait", async () => {
    mockReservePaceSlot.mockResolvedValue(null);
    await getProcessor()(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
    }));
  });

  it("is off without PRIVATE_REPLY_INTERVAL_SECONDS", async () => {
    vi.stubEnv("PRIVATE_REPLY_INTERVAL_SECONDS", "");
    await getProcessor()(createMockJob());
    expect(mockReservePaceSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });
});

describe("DM Worker — stale read fallbacks", () => {
  it("does not deliver a link for a campaign whose opening DM is days old", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ ...mockAutomation, trackedLinks: [] });
    mockPrisma.dmLog.findFirst.mockImplementation(async (args: { where?: { dmSentAt?: unknown; status?: string } } = {}) =>
      args.where?.dmSentAt ? null : args.where?.status === "SENT" ? null : { commenterName: "commenter_user" });

    await getProcessor()(createMockPostbackJob({
      instagramAccountId: "ig_456", userId: "commenter_999", payload: "reveal:auto_789", fallback: true,
    }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("checks for a recent opening DM from this campaign, not links or keyword replies", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ ...mockAutomation, trackedLinks: [] });

    await getProcessor()(createMockPostbackJob({
      instagramAccountId: "ig_456", userId: "commenter_999", payload: "reveal:auto_789", fallback: true,
    }));

    expect(mockPrisma.dmLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        automationId: "auto_789",
        commenterId: "commenter_999",
        status: "SENT",
        dmSentAt: { gte: expect.any(Date) },
        NOT: [{ commentId: { startsWith: "reveal:" } }, { commentId: { startsWith: "dm:" } }],
      }),
    }));
    expect(mockSendDirectMessage).toHaveBeenCalled();
  });

  it("leaves real button taps alone, however old the opening DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ ...mockAutomation, trackedLinks: [] });
    mockPrisma.dmLog.findFirst.mockImplementation(async (args: { where?: { dmSentAt?: unknown; status?: string } } = {}) =>
      args.where?.dmSentAt ? null : args.where?.status === "SENT" ? null : { commenterName: "commenter_user" });

    await getProcessor()(createMockPostbackJob({
      instagramAccountId: "ig_456", userId: "commenter_999", payload: "reveal:auto_789",
    }));

    expect(mockSendDirectMessage).toHaveBeenCalled();
  });
});

describe("DM Worker — private replies paused", () => {
  const withPublicReply = { ...mockAutomation, publicReplyEnabled: true, publicReplyMessages: ["te lo mandé por privado 📩"] };

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([withPublicReply]);
    vi.mocked(sendCommentReply).mockResolvedValue({ id: "reply_1" } as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("asks for an Instagram DM publicly and sends no private reply", async () => {
    vi.stubEnv("PRIVATE_REPLIES_PAUSED_UNTIL", new Date(Date.now() + 3600e3).toISOString());

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    const [, , text] = vi.mocked(sendCommentReply).mock.calls[0];
    expect(text).toMatch(/^@commenter_user /);
    expect(text).toContain("LINK");
    expect(text).toContain("Instagram");
    // Done for good: the reconciler must not bring it back after the pause.
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT", dmDeliveryUnconfirmed: true }),
    }));
  });

  it("uses PAUSED_PUBLIC_REPLY, with the matched keyword", async () => {
    vi.stubEnv("PRIVATE_REPLIES_PAUSED_UNTIL", new Date(Date.now() + 3600e3).toISOString());
    vi.stubEnv("PAUSED_PUBLIC_REPLY", "Escribime {keyword} por DM de Instagram");

    await getProcessor()(createMockJob());

    expect(vi.mocked(sendCommentReply).mock.calls[0][2]).toBe("Escribime LINK por DM de Instagram");
  });

  it("ends on its own once the date has passed", async () => {
    vi.stubEnv("PRIVATE_REPLIES_PAUSED_UNTIL", new Date(Date.now() - 1000).toISOString());

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(vi.mocked(sendCommentReply).mock.calls[0][2]).toBe("te lo mandé por privado 📩");
  });
});

describe("DM Worker — one reply per inbound DM", () => {
  const trigger = { ...mockAutomation, dmTriggerEnabled: true, requireFollow: false, trackedLinks: [] };
  const message = {
    name: "process-message",
    data: { instagramAccountId: "ig_456", messageId: "mid_legal", messageText: "legal", senderId: "commenter_999" },
    id: "m_legal",
    attemptsMade: 0,
  };

  it("answers once even when the keyword is in several campaigns", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([trigger, { ...trigger, id: "auto_trial", name: "[TRIAL] copy" }]);

    await getProcessor()(message);

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not answer from another campaign when the message was already answered", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([trigger, { ...trigger, id: "auto_trial" }]);
    mockPrisma.dmLog.findUnique.mockResolvedValueOnce({ status: "SENT" });

    await getProcessor()(message);

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("DM Worker — private-reply breaker", () => {
  const withPublicReply = { ...mockAutomation, publicReplyEnabled: true, publicReplyMessages: ["te lo mandé por privado 📩"] };
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([withPublicReply]);
    vi.mocked(sendCommentReply).mockResolvedValue({ id: "reply_1" } as never);
    fetchMock.mockReset().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function refuse(error: Error) {
    mockSendPrivateReply.mockRejectedValue(error);
  }

  it("counts a sent first message as a success", async () => {
    await getProcessor()(createMockJob());

    expect(mockRecordPrivateReplyOutcome).toHaveBeenCalledWith(
      "ig_456",
      false,
      { threshold: 4, window: 12, pauseMs: 24 * 3600_000 }
    );
  });

  it.each([
    [100, 2534025, "El comentario no es válido para una respuesta privada"],
    [2, 1545133, "Service temporarily unavailable"],
  ])("counts a first attempt refused with %i/%i", async (code, subcode, message) => {
    refuse(new MetaApiError(code, subcode, undefined, message));

    await expect(getProcessor()(createMockJob())).rejects.toBeTruthy();

    expect(mockRecordPrivateReplyOutcome).toHaveBeenCalledWith("ig_456", true, expect.anything());
  });

  it("does not count a retry, whose refusal the first attempt caused", async () => {
    refuse(new MetaApiError(100, 2534025, undefined, "El comentario no es válido para una respuesta privada"));

    await expect(
      getProcessor()({ ...createMockJob(), attemptsMade: 1 })
    ).rejects.toBeTruthy();

    expect(mockRecordPrivateReplyOutcome).not.toHaveBeenCalled();
  });

  it("does not count a person who is gone", async () => {
    refuse(new MetaApiError(100, 2534014, undefined, "No se puede encontrar al usuario solicitado."));

    await expect(getProcessor()(createMockJob())).rejects.toBeTruthy();

    expect(mockRecordPrivateReplyOutcome).not.toHaveBeenCalled();
  });

  it("pings the owner and logs a warning when it opens", async () => {
    vi.stubEnv("NTFY_TOPIC", "topic_x");
    refuse(new MetaApiError(100, 2534025, undefined, "El comentario no es válido para una respuesta privada"));
    mockRecordPrivateReplyOutcome.mockResolvedValue(4);

    await expect(getProcessor()(createMockJob())).rejects.toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ topic: "topic_x", title: "Pausé las respuestas privadas" });
    expect(body.message).toContain("4 de los últimos 12");
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ level: "WARNING", message: "Private replies paused by the breaker" }),
    });
  });

  it("while open, asks for a DM publicly and sends no private reply", async () => {
    mockPrivateReplyBreakerUntil.mockResolvedValue(Date.now() + 3600e3);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(vi.mocked(sendCommentReply).mock.calls[0][2]).toContain("LINK");
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SKIPPED_RATE_LIMIT",
        dmDeliveryUnconfirmed: true,
        errorMessage: expect.stringContaining("breaker"),
      }),
    }));
  });

  it("never blocks a send because Redis could not be read", async () => {
    mockPrivateReplyBreakerUntil.mockRejectedValue(new Error("ECONNRESET"));

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
  });

  it("in alert-only mode, pings the owner but keeps sending", async () => {
    vi.stubEnv("PRIVATE_REPLY_BREAKER_ALERT_ONLY", "true");
    vi.stubEnv("NTFY_TOPIC", "topic_x");
    // Even with the alert's cooldown key set, nothing is paused.
    mockPrivateReplyBreakerUntil.mockResolvedValue(Date.now() + 3600e3);
    refuse(new MetaApiError(100, 2534025, undefined, "El comentario no es válido para una respuesta privada"));
    mockRecordPrivateReplyOutcome.mockResolvedValue(11);

    await expect(getProcessor()(createMockJob())).rejects.toBeTruthy();

    expect(mockSendPrivateReply).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.title).toBe("Instagram rechaza casi todos los mensajes");
    expect(body.message).toContain("Los sigo intentando");
    expect(mockPrisma.dmLog.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorMessage: expect.stringContaining("breaker") }),
    }));
  });

  it("is off with a threshold of 0", async () => {
    vi.stubEnv("PRIVATE_REPLY_BREAKER_THRESHOLD", "0");
    mockPrivateReplyBreakerUntil.mockResolvedValue(Date.now() + 3600e3);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockRecordPrivateReplyOutcome).not.toHaveBeenCalled();
  });
});

describe("DM Worker — lead question after the first tap", () => {
  const opening = {
    ...mockAutomation,
    openingDmEnabled: true,
    openingDmMessage: "¡Hola {username}! ¿Te paso la guía?",
    openingDmButtonLabel: "Sí, pasámela",
    leadButtonLabel: "Tengo un negocio",
    requireFollow: true,
    followPromptMessage: "Seguime y tocá el botón",
    followPromptButtonLabel: "Ya te sigo",
  };

  afterEach(() => vi.unstubAllEnvs());

  it("sends a first message with the main button alone", async () => {
    vi.stubEnv("LEAD_QUESTION_MESSAGE", "Una pregunta rápida: ¿tenés un negocio?");
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...opening, openingDmMessage: "¡Hola {username}! {Vi que comentaste {keyword}|Vi que comentaste {keyword}} ¿Te paso la guía?" },
    ]);
    mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "link" });

    await getProcessor()(createMockJob());

    // No lead button, so nothing about a business reaches a stranger cold.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "¡Hola commenter_user! Vi que comentaste LINK ¿Te paso la guía?",
      "Sí, pasámela",
      "followcheck:auto_789:intro"
    );
  });

  it("keeps both buttons in the first message without a question configured", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([opening]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "¡Hola commenter_user! ¿Te paso la guía?",
      "Sí, pasámela",
      "followcheck:auto_789:open",
      [{ title: "Tengo un negocio", payload: "followcheck:auto_789:lead" }]
    );
  });

  it("asks the lead question on the first tap, before any gate", async () => {
    vi.stubEnv("LEAD_QUESTION_MESSAGE", "{Una pregunta rápida|Una pregunta rápida}: ¿tenés un negocio?");
    mockPrisma.automation.findFirst.mockResolvedValue(opening);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:intro",
      })
    );

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Una pregunta rápida: ¿tenés un negocio?",
      "No tengo un negocio",
      "followcheck:auto_789:open",
      [{ title: "Tengo un negocio", payload: "followcheck:auto_789:lead" }]
    );
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockPrisma.lead.create).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("uses LEAD_QUESTION_NO_LABEL for the other button", async () => {
    vi.stubEnv("LEAD_QUESTION_MESSAGE", "¿Tenés un negocio?");
    vi.stubEnv("LEAD_QUESTION_NO_LABEL", "Todavía no");
    mockPrisma.automation.findFirst.mockResolvedValue(opening);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:intro",
      })
    );

    expect(mockSendDirectMessageWithButton.mock.calls[0][4]).toBe("Todavía no");
  });

  it("treats the tap as the opening button once the question is unset", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(opening);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:intro",
      })
    );

    // Straight to the follow prompt, as an opening tap: no re-check wait.
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Seguime y tocá el botón",
      "Ya te sigo",
      "followcheck:auto_789"
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("DM Worker — public reply follows the DM's outcome", () => {
  const withPublicReply = { ...mockAutomation, publicReplyEnabled: true, publicReplyMessages: ["te lo mandé por privado 📩"] };

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([withPublicReply]);
    vi.mocked(sendCommentReply).mockReset().mockResolvedValue({ id: "reply_1" } as never);
  });

  it("says 'check your DMs' only after the DM went out", async () => {
    await getProcessor()(createMockJob());

    expect(vi.mocked(sendCommentReply).mock.calls[0][2]).toBe("te lo mandé por privado 📩");
    expect(mockSendPrivateReply.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendCommentReply).mock.invocationCallOrder[0]
    );
  });

  it.each([
    [100, 2534025, "El comentario no es válido para una respuesta privada"],
    [2, 1545133, "Service temporarily unavailable"],
  ])("asks for a DM publicly when Instagram refuses the private reply (%i/%i)", async (code, subcode, message) => {
    mockSendPrivateReply.mockRejectedValue(new MetaApiError(code, subcode, undefined, message));

    await expect(getProcessor()(createMockJob())).rejects.toBeTruthy();

    expect(sendCommentReply).toHaveBeenCalledTimes(1);
    const text = vi.mocked(sendCommentReply).mock.calls[0][2];
    expect(text).toContain("LINK");
    expect(text).not.toContain("te lo mandé");
  });

  it("gives a probably-delivered DM (code 1) the usual reply", async () => {
    mockSendPrivateReply.mockRejectedValue(new MetaApiError(1, undefined, undefined, "An unknown error has occurred."));

    await expect(getProcessor()(createMockJob())).rejects.toBeTruthy();

    expect(vi.mocked(sendCommentReply).mock.calls[0][2]).toBe("te lo mandé por privado 📩");
  });

  it("leaves the reply to the retry when the failure may still resolve", async () => {
    mockSendPrivateReply.mockRejectedValue(new MetaApiError(2, undefined, undefined, "An unexpected error has occurred"));

    await expect(getProcessor()(createMockJob())).rejects.toBeTruthy();

    expect(sendCommentReply).not.toHaveBeenCalled();
  });

  it("asks for a DM when retrying the public reply of a refused comment", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "FAILED", dmDeliveryUnconfirmed: true, publicReplySentAt: null });

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(vi.mocked(sendCommentReply).mock.calls[0][2]).toContain("LINK");
  });

  it("keeps the usual reply when another campaign already sent the DM", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(async (args: { where?: { status?: string } } = {}) =>
      args.where?.status === "SENT" ? { automation: { name: "Otra" } } : { commenterName: "commenter_user" }
    );

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(vi.mocked(sendCommentReply).mock.calls[0][2]).toBe("te lo mandé por privado 📩");
  });
});

describe("DM Worker — lead question on a DM keyword", () => {
  const dmCampaign = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    requireFollow: true,
    leadButtonLabel: "Tengo un negocio",
    followPromptMessage: "Seguime y tocá el botón",
    followPromptButtonLabel: "Ya te sigo",
  };
  const message = {
    name: "process-message",
    data: { instagramAccountId: "ig_456", messageId: "mid_abc", messageText: "LINK", senderId: "commenter_999" },
    id: "message_job_001",
    attemptsMade: 0,
  };

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([dmCampaign]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("asks it first, with the buttons that lead into the gate and link", async () => {
    vi.stubEnv("LEAD_QUESTION_MESSAGE", "Una pregunta rápida 👇 ¿Tenés un negocio?");

    await getProcessor()(message);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Una pregunta rápida 👇 ¿Tenés un negocio?",
      "No tengo un negocio",
      "followcheck:auto_789:open",
      [{ title: "Tengo un negocio", payload: "followcheck:auto_789:lead" }]
    );
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    // Answered: the same DM is not taken up again by another campaign.
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "SENT", commentId: "dm:mid_abc" }),
    }));
  });

  it("prefers DM_LEAD_QUESTION_MESSAGE", async () => {
    vi.stubEnv("LEAD_QUESTION_MESSAGE", "Antes, una pregunta");
    vi.stubEnv("DM_LEAD_QUESTION_MESSAGE", "¡Hola {username}! Ya te lo paso 🙌 ¿Tenés un negocio?");

    await getProcessor()(message);

    expect(mockSendDirectMessageWithButton.mock.calls[0][3]).toBe("¡Hola commenter_user! Ya te lo paso 🙌 ¿Tenés un negocio?");
  });

  it("keeps the gate first without a question configured", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(message);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Seguime y tocá el botón",
      "Ya te sigo",
      "followcheck:auto_789"
    );
  });

  it("uses reveal buttons for a campaign without the gate", async () => {
    vi.stubEnv("LEAD_QUESTION_MESSAGE", "¿Tenés un negocio?");
    mockPrisma.automation.findMany.mockResolvedValue([{ ...dmCampaign, requireFollow: false }]);

    await getProcessor()(message);

    expect(mockSendDirectMessageWithButton.mock.calls[0][5]).toBe("reveal:auto_789:open");
  });
});

describe("DM Worker — plain-text first message", () => {
  const campaign = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    openingDmEnabled: true,
    openingDmMessage: "¡Buenas {username}! Gracias por comentar {keyword} 🙌 ¿Te paso la guía?",
    openingDmButtonLabel: "Sí, pasámela",
    leadButtonLabel: "Tengo un negocio",
    requireFollow: true,
    followPromptMessage: "Seguime y tocá el botón",
    followPromptButtonLabel: "Ya te sigo",
  };
  const redis = { set: vi.fn(), get: vi.fn(), del: vi.fn() };
  const reply = (messageText: string, extra: Record<string, unknown> = {}) => ({
    name: "process-message",
    data: { instagramAccountId: "ig_456", messageId: "mid_r1", messageText, senderId: "commenter_999", ...extra },
    id: "message_job_r1",
    attemptsMade: 0,
  });

  beforeEach(() => {
    redis.set.mockReset().mockResolvedValue("OK");
    redis.get.mockReset().mockResolvedValue(null);
    redis.del.mockReset().mockResolvedValue(1);
    vi.mocked(getRedisConnection).mockReturnValue(redis as never);
    vi.stubEnv("LEAD_QUESTION_MESSAGE", "Antes, una pregunta rápida 👇 ¿Tenés un negocio?");
    vi.stubEnv("DM_LEAD_QUESTION_MESSAGE", "¡Hola! Ya te lo paso 🙌 ¿Tenés un negocio?");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends the opening as text, with no button, and remembers it for the reply", async () => {
    vi.stubEnv("OPENING_TEXT_ONLY", "true");
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "¡Buenas commenter_user! Gracias por comentar LINK 🙌 ¿Te paso la guía?"
    );
    expect(redis.set).toHaveBeenCalledWith("text_opening:ig_456:commenter_999", "auto_789", "PX", 24 * 3600_000);
  });

  it("adds the button label as a quick reply with OPENING_QUICK_REPLY", async () => {
    vi.stubEnv("OPENING_TEXT_ONLY", "true");
    vi.stubEnv("OPENING_QUICK_REPLY", "true");
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "¡Buenas commenter_user! Gracias por comentar LINK 🙌 ¿Te paso la guía?",
      [{ title: "Sí, pasámela", payload: "opening:auto_789" }]
    );
    expect(redis.set).toHaveBeenCalledWith("text_opening:ig_456:commenter_999", "auto_789", "PX", 24 * 3600_000);
  });

  it("sends the text alone when Meta turns the quick replies down as invalid", async () => {
    vi.stubEnv("OPENING_TEXT_ONLY", "true");
    vi.stubEnv("OPENING_QUICK_REPLY", "true");
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);
    mockSendPrivateReply.mockRejectedValueOnce(new MetaApiError(100, 2018001, undefined, "Invalid parameter"));

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(2);
    expect(mockSendPrivateReply.mock.calls[1]).toHaveLength(4);
    expect(redis.set).toHaveBeenCalledWith("text_opening:ig_456:commenter_999", "auto_789", "PX", 24 * 3600_000);
  });

  it("does not resend when Instagram refuses the reply itself", async () => {
    vi.stubEnv("OPENING_TEXT_ONLY", "true");
    vi.stubEnv("OPENING_QUICK_REPLY", "true");
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);
    mockSendPrivateReply.mockRejectedValueOnce(
      new MetaApiError(100, 2534025, undefined, "El comentario no es válido para una respuesta privada")
    );

    await getProcessor()(createMockJob()).catch(() => {});

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("keeps the button without OPENING_TEXT_ONLY", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("continues the campaign on any reply, with the plain lead question", async () => {
    redis.get.mockResolvedValue("auto_789");
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);

    await getProcessor()(reply("dale!"));

    // That campaign only, whatever its keywords or DM trigger say.
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "auto_789" }),
    }));
    expect(mockMatchKeywords).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Antes, una pregunta rápida 👇 ¿Tenés un negocio?",
      "No tengo un negocio",
      "followcheck:auto_789:open",
      [{ title: "Tengo un negocio", payload: "followcheck:auto_789:lead" }]
    );
    // Once: the next message is an ordinary DM again.
    expect(redis.del).toHaveBeenCalledWith("text_opening:ig_456:commenter_999");
  });

  it("continues the campaign a quick-reply tap names, with no marker", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);

    await getProcessor()(reply("Sí, pasámela", { quickReplyPayload: "opening:auto_789" }));

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "auto_789" }),
    }));
    expect(mockMatchKeywords).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton.mock.calls[0][3]).toBe("Antes, una pregunta rápida 👇 ¿Tenés un negocio?");
  });

  it("continues on a reply with no text (an emoji reaction, a voice note)", async () => {
    redis.get.mockResolvedValue("auto_789");
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);

    await getProcessor()(reply("", { attachmentType: "audio" }));

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ commentText: "(reply)", status: "SENT" }),
    }));
  });

  it("remembers the lead question it sends, for a written answer", async () => {
    redis.get.mockResolvedValue("auto_789");
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);

    await getProcessor()(reply("dale!"));

    expect(redis.set).toHaveBeenCalledWith(
      "lead_question:ig_456:commenter_999", "followcheck:auto_789", "PX", 24 * 3600_000
    );
  });

  describe("a written answer to the lead question", () => {
    beforeEach(() => {
      redis.get.mockImplementation(async (key: string) =>
        key === "lead_question:ig_456:commenter_999" ? "followcheck:auto_789" : null
      );
      mockPrisma.automation.findMany.mockResolvedValue([campaign]);
      mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    });

    it("counts a sí as the lead button", async () => {
      await getProcessor()(reply("Sí, tengo una barbería"));

      expect(redis.del).toHaveBeenCalledWith("lead_question:ig_456:commenter_999");
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "process-postback",
        {
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "followcheck:auto_789:lead",
          mid: "mid_r1",
        },
        { jobId: `typed_answer_ig_456_${Buffer.from("mid_r1").toString("base64url")}` }
      );
      expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    });

    it("counts anything else, even a voice note, as the other button", async () => {
      await getProcessor()(reply("no"));
      await getProcessor()(reply("", { attachmentType: "audio" }));

      expect(mockQueueAdd.mock.calls.map((call) => call[1].payload)).toEqual([
        "followcheck:auto_789:open",
        "followcheck:auto_789:open",
      ]);
    });

    it("answers once, however many messages follow", async () => {
      redis.del.mockResolvedValue(0);

      await getProcessor()(reply("si"));

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("lets a keyword start its own campaign instead", async () => {
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });

      await getProcessor()(reply("LINK"));

      expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).not.toHaveBeenCalledWith("process-postback", expect.anything(), expect.anything());
    });

    it("is cleared by a tap on one of its buttons", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({ ...campaign, trackedLinks: [] });

      await getProcessor()(createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:open",
      }));

      expect(redis.del).toHaveBeenCalledWith("lead_question:ig_456:commenter_999");
    });
  });

  it("ignores a reply that is not to a text opening and has no keyword", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    await getProcessor()(reply("dale!"));

    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("typedAnswerIsLead", () => {
  it.each([
    ["sí", true], ["Si", true], ["siii!", true], ["sip", true], ["sisi", true], ["👍 sí claro", true],
    ["Tengo una barbería", true], ["si si envíalo por acá", true],
    ["no", false], ["No tengo", false], ["sin negocio", false], ["la guía?", false],
    ["no me llega 😞", false], ["", false], ["🙌", false],
  ])("%s → %s", (text, lead) => {
    expect(typedAnswerIsLead(text)).toBe(lead);
  });
});
