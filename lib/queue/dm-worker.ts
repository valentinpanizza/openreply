import { createHash } from "node:crypto";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import {
  getDMQueue,
  getRedisConnection,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
  FOLLOWUP_JOB_NAME,
  LEAD_JOB_NAME,
  LEAD_AUDIO_JOB_NAME,
  OPENING_DM_READ_FALLBACK_WINDOW_MS,
  type DmQueueJob,
  type ProcessCommentJob,
  type ProcessMessageJob,
  type ProcessPostbackJob,
  type ProcessFollowUpJob,
  type NotifyLeadJob,
  type LeadAudioJob,
} from "./client";
import { leadAudioSendAt, leadAudioUrls } from "@/lib/leads/audio";
import { prisma } from "@/lib/db/client";
import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
  getUserFollowStatus,
  sendCommentReply,
  sendDirectAudio,
  sendDirectMessage,
  sendDirectMessageWithButton,
  sendDirectMessageWithLinkButton,
  sendPrivateReply,
  sendPrivateReplyWithButton,
  sendPrivateReplyWithLinkButton,
} from "@/lib/instagram/provider";
import {
  createInstagramContext,
  hasInstagramCredentials,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import {
  isPaced,
  markPaced,
  privateReplyBreakerUntil,
  recordPrivateReplyOutcome,
  reserveDMSlot,
  releaseDMSlot,
  reservePaceSlot,
} from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import {
  buildTrackedUrl,
  pickVariants,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";

import {
  ZernioApiError,
  ZernioDeliveryUnconfirmedError,
} from "@/lib/zernio/client";

const BACKOFF_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];

/**
 * Sends Meta answered with an error but may well have delivered anyway.
 *
 * Meta returns the generic code 1 OAuthException on /messages *after* the DM
 * has reached the recipient — observed in production: a user tapped the reply's
 * button 30 seconds after a send this worker had already marked FAILED. Logging
 * that as a plain failure is harmful twice over: the job is retried (up to
 * BACKOFF_DELAYS.length times, each retry another copy in the same inbox), and
 * the comment never satisfies the reconciler's "handled" test, so every sweep
 * re-enqueues it for the whole lookback window. Together that sent one person
 * dozens of identical DMs.
 *
 * Flagging it as unconfirmed instead is exactly what dmDeliveryUnconfirmed is
 * for: the sweep's dedup already treats that as handled, and processComment
 * skips a DM whose delivery is unconfirmed. The trade-off is deliberate — a
 * code 1 that really did fail means that person gets no DM and can comment
 * again, which is far better than spamming someone who already received it.
 */
function isDeliveryUnconfirmed(error: unknown): boolean {
  return (
    error instanceof ZernioDeliveryUnconfirmedError ||
    (error instanceof MetaApiError && error.code === 1)
  );
}

/**
 * Instagram refused the private reply for good (code 100): 2534025 "the
 * comment is invalid for a private reply" — it already used its one private
 * reply, is past the 7-day window, or a failed send burned it — and 2534014
 * "user not found", when the comment or the account is gone.
 *
 * Observed in production: after a code 2 "Service temporarily unavailable",
 * every retry of that comment came back 2534025. Each was logged FAILED, so
 * BullMQ retried it and every reconciler sweep re-enqueued it: ~200 refused
 * sends an hour, while Instagram was already rationing the account.
 */
function isPrivateReplyRefused(error: unknown): boolean {
  return (
    error instanceof MetaApiError &&
    error.code === 100 &&
    (error.subcode === 2534025 || error.subcode === 2534014)
  );
}

// "Service temporarily unavailable" on a private reply: every retry of such a
// comment came back 2534025, because the refused attempt already used the
// comment's one private reply. Retrying only adds refusals. (Private replies
// only: a direct message spends nothing, and its retry can go through.)
function isPrivateReplyUnavailable(error: unknown): boolean {
  return error instanceof MetaApiError && error.code === 2 && error.subcode === 1545133;
}

// Never send this comment's DM again: it may already be in the inbox, or
// Instagram will not accept it. Both cases set dmDeliveryUnconfirmed, the flag
// the reconciler and processComment already read as "do not send again".
function isFinalDmFailure(error: unknown): boolean {
  return isDeliveryUnconfirmed(error) || isPrivateReplyRefused(error);
}

// How long to wait before re-checking a follow that came back false: one
// delay per re-check, each counted from the previous check.
//
// `is_user_follow_business` does not reflect a brand-new follow right away, and
// the follow gate asks people to follow and tap a button that is sitting in
// front of them — so tapping seconds after following is the normal case, not
// the exception. Rejecting on the first `false` therefore turns away the exact
// people who did what was asked, and they get told to follow an account they
// already follow.
//
// Two checks rather than one long wait: measured, a follow still read `false`
// 17 s after it happened and `true` by ~68 s. An early check catches the fast
// ones sooner; the last still covers the slow ones.
const FOLLOW_RECHECK_DELAYS_MS = (
  process.env.FOLLOW_RECHECK_DELAYS_MS ?? "20000,40000"
)
  .split(",")
  .map(Number)
  .filter((ms) => ms > 0);
const FOLLOW_RECHECK_TOTAL_MS = FOLLOW_RECHECK_DELAYS_MS.reduce(
  (total, ms) => total + ms,
  0
);

// A pause on private replies (PRIVATE_REPLIES_PAUSED_UNTIL, an ISO date): until
// then, a matching comment gets no DM, only a public reply asking the person to
// write the keyword by DM (PAUSED_PUBLIC_REPLY, where {keyword} is the matched
// keyword). Instagram's integrity system throttles an account that keeps
// messaging strangers, and Meta's advice is to stop for 24–48 hours so the
// counter resets; a message the person starts is never throttled. It ends on
// its own at that date. Read per call so tests can set it.
function privateRepliesPaused(): boolean {
  const until = Date.parse(process.env.PRIVATE_REPLIES_PAUSED_UNTIL ?? "");
  return Number.isFinite(until) && Date.now() < until;
}
const DEFAULT_PAUSED_PUBLIC_REPLY =
  "@{username} {¡Buenas|¡Hola}! Mandame {keyword} por DM acá en Instagram y te lo paso al toque 📩";

// The pause above, opened automatically (see recordPrivateReplyOutcome): once
// PRIVATE_REPLY_BREAKER_THRESHOLD of the last PRIVATE_REPLY_BREAKER_WINDOW
// first private replies were refused, private replies stop for
// PRIVATE_REPLY_BREAKER_PAUSE_HOURS. A threshold of 0 turns it off. With
// PRIVATE_REPLY_BREAKER_ALERT_ONLY=true it only pings the owner, at most once
// per PAUSE_HOURS, and private replies go on: a refused one already gets the
// ask-for-a-DM public reply, so pausing saves nobody anything and costs the
// replies that would have gone through. Read per call so tests can set it.
function breakerSettings() {
  return {
    threshold: Number(process.env.PRIVATE_REPLY_BREAKER_THRESHOLD ?? 4),
    window: Number(process.env.PRIVATE_REPLY_BREAKER_WINDOW ?? 12),
    pauseMs: Number(process.env.PRIVATE_REPLY_BREAKER_PAUSE_HOURS ?? 24) * 3600_000,
  };
}
function breakerAlertOnly(): boolean {
  return process.env.PRIVATE_REPLY_BREAKER_ALERT_ONLY === "true";
}

// Refusals that mean Instagram is filtering the account's first messages to
// strangers, as seen after the account was flagged: straight away "invalid for
// a private reply" (on a comment that could take one), or "Service temporarily
// unavailable". Not 2534014 (the person is gone) or code 1 (probably
// delivered), which say nothing about the account.
function isIntegrityRefusal(error: unknown): boolean {
  return (
    error instanceof MetaApiError &&
    ((error.code === 100 && error.subcode === 2534025) ||
      (error.code === 2 && error.subcode === 1545133))
  );
}

async function privateReplyBreakerOpen(instagramAccountId: string): Promise<boolean> {
  if (!(breakerSettings().threshold > 0) || breakerAlertOnly()) return false;
  try {
    return (await privateReplyBreakerUntil(instagramAccountId)) !== null;
  } catch (error) {
    console.log("[DM Worker] Could not read the private-reply breaker:", formatError(error));
    return false;
  }
}

async function recordPrivateReplyResult(
  automation: { workspaceId: string },
  instagramAccountId: string,
  refused: boolean
): Promise<void> {
  const settings = breakerSettings();
  if (!(settings.threshold > 0)) return;
  try {
    const refusals = await recordPrivateReplyOutcome(instagramAccountId, refused, settings);
    if (!refusals) return;
    const until = new Date(Date.now() + settings.pauseMs).toLocaleString("es-UY", {
      timeZone: "America/Montevideo",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
    const alertOnly = breakerAlertOnly();
    const message = alertOnly
      ? `Instagram rechazó ${refusals} de los últimos ${settings.window} primeros mensajes. Los sigo intentando; a quien le rechaza le pido por comentario que te escriba por DM.`
      : `Instagram rechazó ${refusals} de los últimos ${settings.window} primeros mensajes. Hasta el ${until} cada comentario recibe la respuesta pública pidiendo escribir por DM.`;
    console.log(`[DM Worker] Private-reply breaker ${alertOnly ? "alert" : "opened"}: ${message}`);
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId: automation.workspaceId,
          source: "WORKER",
          level: "WARNING",
          message: alertOnly
            ? "Instagram is refusing most private replies"
            : "Private replies paused by the breaker",
          payload: { instagramAccountId, refusals, window: settings.window, pauseMs: settings.pauseMs },
        },
      })
      .catch(() => {});
    await pushNotification({
      title: alertOnly ? "Instagram rechaza casi todos los mensajes" : "Pausé las respuestas privadas",
      message,
      tags: ["warning"],
    });
  } catch (error) {
    console.log("[DM Worker] Could not record the private-reply outcome:", formatError(error));
  }
}

// A ping to the owner's phone (ntfy, NTFY_TOPIC). Never throws.
async function pushNotification(body: { title: string; message: string; tags?: string[]; click?: string }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const response = await fetch(process.env.NTFY_URL ?? "https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.log(`[DM Worker] ntfy ping failed: HTTP ${response.status}`);
  } catch (error) {
    console.log("[DM Worker] ntfy ping failed:", formatError(error));
  }
}

// Asking "do you have a business?" in the first message to a stranger reads as
// the opener of a business-opportunity scam, and it is what the account was
// sending, identically, to hundreds of strangers the day it was suspended for
// "fraud and deception". With LEAD_QUESTION_MESSAGE set, a campaign with a lead
// button asks it one step later instead: the first message (the private reply)
// only offers the resource, with the main button alone; tapping it opens the
// conversation, and the question goes out as a direct message with the lead
// button and LEAD_QUESTION_NO_LABEL. Both then run the usual gate and link.
function leadQuestionMessage(): string {
  return process.env.LEAD_QUESTION_MESSAGE?.trim() ?? "";
}
// Someone who writes the keyword by DM already asked for the resource, so they
// get the lead question straight away — DM_LEAD_QUESTION_MESSAGE, which can
// open with a greeting, or LEAD_QUESTION_MESSAGE.
function dmLeadQuestionMessage(): string {
  return process.env.DM_LEAD_QUESTION_MESSAGE?.trim() || leadQuestionMessage();
}
const DEFAULT_LEAD_QUESTION_NO_LABEL = "No tengo un negocio";

// OPENING_TEXT_ONLY=true sends the first message (the private reply) as plain
// text, with no button: after the account was flagged Instagram refused more
// than half of the first messages to strangers, and every one of those carried
// a button template, so text is the untried variable. Without a button there
// is nothing to tap, so any reply to it — text, an emoji, a voice note — within
// the 24-hour window continues that campaign, exactly as if the person had
// written its keyword by DM.
function openingTextOnly(): boolean {
  return process.env.OPENING_TEXT_ONLY === "true";
}
// OPENING_QUICK_REPLY=true adds the campaign's button label to that text
// opening as a quick reply: a tappable suggestion under a message that is
// still plain text. With text alone nearly every first message arrived, but a
// fifth of people answered; with the button template twice as many answered,
// but only four in ten messages arrived. A tap comes back as an ordinary message, which
// the text opening already continues; its payload names the campaign, so the
// tap continues it even when the 24-hour marker is gone or points elsewhere.
function openingQuickReply(): boolean {
  return process.env.OPENING_QUICK_REPLY === "true";
}
const OPENING_QUICK_REPLY_PREFIX = "opening:";
function quickReplyCampaign(payload: string | undefined): string | null {
  if (!payload?.startsWith(OPENING_QUICK_REPLY_PREFIX)) return null;
  return payload.slice(OPENING_QUICK_REPLY_PREFIX.length) || null;
}
const TEXT_OPENING_TTL_MS = 24 * 3600_000;
function textOpeningKey(instagramAccountId: string, userId: string): string {
  return `text_opening:${instagramAccountId}:${userId}`;
}
async function markTextOpening(instagramAccountId: string, userId: string, automationId: string) {
  try {
    await getRedisConnection().set(textOpeningKey(instagramAccountId, userId), automationId, "PX", TEXT_OPENING_TTL_MS);
  } catch (error) {
    console.log("[DM Worker] Could not remember a text opening:", formatError(error));
  }
}
async function pendingTextOpening(instagramAccountId: string, userId: string): Promise<string | null> {
  try {
    return (await getRedisConnection().get(textOpeningKey(instagramAccountId, userId))) || null;
  } catch (error) {
    console.log("[DM Worker] Could not read a text opening:", formatError(error));
    return null;
  }
}
async function clearTextOpening(instagramAccountId: string, userId: string) {
  try {
    await getRedisConnection().del(textOpeningKey(instagramAccountId, userId));
  } catch (error) {
    console.log("[DM Worker] Could not clear a text opening:", formatError(error));
  }
}

// While the lead question waits for a tap, a written answer counts as one: a
// "sí" or "tengo…" as the lead button, anything else ("no", "la guía?", "no me
// llega") as the other one, which goes on to the follow gate and the link.
// Some people write instead of tapping, or do not see the buttons, and got no
// answer at all. The marker holds the buttons' payload without its marker
// (e.g. "followcheck:<campaign>"); a tap or a delivered link clears it.
const LEAD_QUESTION_TTL_MS = 24 * 3600_000;
function leadQuestionKey(instagramAccountId: string, userId: string): string {
  return `lead_question:${instagramAccountId}:${userId}`;
}
async function markLeadQuestion(instagramAccountId: string, userId: string, payloadBase: string) {
  try {
    await getRedisConnection().set(leadQuestionKey(instagramAccountId, userId), payloadBase, "PX", LEAD_QUESTION_TTL_MS);
  } catch (error) {
    console.log("[DM Worker] Could not remember a lead question:", formatError(error));
  }
}
async function clearLeadQuestion(instagramAccountId: string, userId: string) {
  try {
    await getRedisConnection().del(leadQuestionKey(instagramAccountId, userId));
  } catch (error) {
    console.log("[DM Worker] Could not clear a lead question:", formatError(error));
  }
}
// The first word, without accents: "sí", "Siii", "sip", "sisi", "Tengo una
// tienda". Not "sin", and not "no tengo".
export function typedAnswerIsLead(text: string): boolean {
  const firstWord =
    text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z]+/)?.[0] ?? "";
  return /^(s+i+)+p?$/.test(firstWord) || firstWord === "tengo";
}
async function answerLeadQuestion(data: ProcessMessageJob): Promise<void> {
  const key = leadQuestionKey(data.instagramAccountId, data.senderId);
  let payloadBase: string | null;
  try {
    const redis = getRedisConnection();
    payloadBase = await redis.get(key);
    // Claim it: one answer per question, however many messages follow.
    if (!payloadBase || (await redis.del(key)) === 0) return;
  } catch (error) {
    console.log("[DM Worker] Could not read a lead question:", formatError(error));
    return;
  }
  const marker = typedAnswerIsLead(data.messageText) ? "lead" : "open";
  await getDMQueue().add(
    POSTBACK_JOB_NAME,
    {
      instagramAccountId: data.instagramAccountId,
      accountConnectionId: data.accountConnectionId,
      userId: data.senderId,
      payload: `${payloadBase}:${marker}`,
      mid: data.messageId,
    },
    {
      jobId: `typed_answer_${data.instagramAccountId}_${Buffer.from(data.messageId).toString("base64url")}`,
    },
  );
}

// Private-reply pacing (see reservePaceSlot). Off unless
// PRIVATE_REPLY_INTERVAL_SECONDS is set; read per call so tests can set it.
function paceIntervalMs(): number {
  return Number(process.env.PRIVATE_REPLY_INTERVAL_SECONDS ?? 0) * 1000;
}
function paceMaxWaitMs(): number {
  // Short of the 7 days a comment can take a private reply, with margin.
  return Number(process.env.PRIVATE_REPLY_MAX_WAIT_HOURS ?? 144) * 3600_000;
}

function formatError(error: unknown): string {
  if (error instanceof MetaApiError) {
    return `${error.name} ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

// Meta rejections that a plain-text retry cannot fix: the send was refused for
// the conversation, not for the button template. Retrying as text just burns
// the attempt and — worse — overwrites the real error with a misleading one
// ("invalid for a private reply", because the first attempt already used up the
// comment's single allowed private reply).
const NON_TEMPLATE_REJECTIONS = [
  /outside of allowed window/i,
  /invalid for a private reply/i,
  /requested user cannot be found/i,
];

function isTemplateRejection(error: unknown): boolean {
  if (
    error instanceof TokenExpiredError ||
    error instanceof RateLimitError ||
    error instanceof ZernioApiError
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : "";
  return !NON_TEMPLATE_REJECTIONS.some((pattern) => pattern.test(message));
}

type WorkerTrackedLink = {
  slug: string;
  label: string | null;
  destinationUrl: string;
};

/**
 * Build the tappable link buttons for a DM. The first link uses the campaign's
 * `linkButtonLabel`; each additional link uses its own stored `label`. Capped at
 * Meta's 3-button limit for a button template.
 */
function buildLinkButtons(
  trackedLinks: WorkerTrackedLink[],
  primaryLabel: string | null
): { title: string; url: string }[] {
  return trackedLinks.slice(0, 3).map((link, index) => ({
    url: buildTrackedUrl(link.slug),
    title:
      (index === 0 ? primaryLabel : link.label) || link.label || "Open link",
  }));
}

/**
 * Fallback text when Meta rejects the button template: render the primary link
 * inline, then append any extra tracked URLs on their own lines so no link is
 * lost.
 */
function buildInlineLinkFallback(
  message: string,
  commenterName: string | null | undefined,
  trackedLinks: WorkerTrackedLink[],
  bodyText: string
): string {
  const base =
    renderMessageWithTracking({ message, commenterName, trackedLinks }) ||
    bodyText;
  const extraUrls = trackedLinks
    .slice(1)
    .map((link) => buildTrackedUrl(link.slug));
  return extraUrls.length > 0 ? `${base}\n${extraUrls.join("\n")}` : base;
}

type RevealAutomation = {
  dmMessage: string;
  linkButtonLabel: string | null;
  trackedLinks: WorkerTrackedLink[];
  instagramAccount: { instagramId: string };
};

/**
 * Deliver a campaign's reveal message as a direct message. Shared by the
 * button-tap (postback) path and the DM keyword-trigger path — both already
 * have an open conversation with the user, so neither uses a private reply.
 */
async function sendRevealDirectMessage({
  accessToken,
  automation,
  userId,
  commenterName,
  context,
}: {
  accessToken: InstagramContext;
  automation: RevealAutomation;
  userId: string;
  commenterName: string | null;
  context: string;
}): Promise<void> {
  if (automation.trackedLinks.length === 0) {
    await sendDirectMessage({
      context: accessToken,
      instagramAccountId: automation.instagramAccount.instagramId,
      userId: userId,
      message: renderMessageWithTracking({
        message: automation.dmMessage,
        commenterName,
        trackedLinks: automation.trackedLinks,
      }),
    });
    return;
  }

  // Try button template first; if Meta rejects it, fall back to inline links.
  const bodyText =
    renderMessageWithoutLink({
      message: automation.dmMessage,
      commenterName,
    }) || "Here's your link:";
  const buttons = buildLinkButtons(
    automation.trackedLinks,
    automation.linkButtonLabel
  );

  try {
    await sendDirectMessageWithLinkButton({
      context: accessToken,
      instagramAccountId: automation.instagramAccount.instagramId,
      userId: userId,
      text: bodyText,
      buttons: buttons,
    });
  } catch (buttonError) {
    // A closed messaging window rejects the text retry too, so don't let it
    // overwrite the original error with a misleading one.
    if (!isTemplateRejection(buttonError)) throw buttonError;

    console.log(
      `[DM Worker] Button template rejected in ${context}, falling back to inline link:`,
      formatError(buttonError)
    );
    try {
      await sendDirectMessage({
        context: accessToken,
        instagramAccountId: automation.instagramAccount.instagramId,
        userId: userId,
        message: buildInlineLinkFallback(
          automation.dmMessage,
          commenterName,
          automation.trackedLinks,
          bodyText
        ),
      });
    } catch {
      throw buttonError;
    }
  }
}


function connectionScope(data: DmQueueJob) {
  return data.accountConnectionId ? { instagramAccountId: data.accountConnectionId } : {};
}

async function processComment(job: Job<ProcessCommentJob>): Promise<void> {
  const {
    instagramAccountId,
    commentId,
    commentText,
    commenterId,
    commenterName,
    mediaId,
    originalMediaId,
  } = job.data;
  const requeueAttempt = job.data.requeueAttempt ?? 0;

  const automations = await prisma.automation.findMany({
    where: {
      ...connectionScope(job.data),
      // Match campaigns bound to this specific post, plus any-post campaigns.
      // A comment left on an ad carries the ad's own media id, while the
      // campaign is bound to the post the ad was created from, so both ids
      // have to be considered or the comment is dropped without a trace.
      OR: [
        { postId: mediaId },
        ...(originalMediaId ? [{ postId: originalMediaId }] : []),
        { matchAnyPost: true },
      ],
      isActive: true,
      instagramAccount: {
        instagramId: instagramAccountId,
      },
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

  for (const automation of automations) {
    // "Any word" campaigns fire on every comment; otherwise require a keyword hit.
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          commentText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) {
      continue;
    }

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId,
        },
      },
    });

    const alreadyDmd = existingLog?.status === "SENT";
    const alreadyPublicReplied = Boolean(existingLog?.publicReplySentAt);
    const needsDm = !alreadyDmd && !existingLog?.dmDeliveryUnconfirmed;

    // Skip only when there is genuinely nothing left to do. A comment whose DM
    // already sent but whose public reply never posted (e.g. it hit a rate
    // limit) must still come back so the public reply can be retried.
    if (existingLog?.status === "SKIPPED_PLAN_LIMIT") continue;
    if (
      !needsDm &&
      (alreadyPublicReplied || existingLog?.publicReplyDeliveryUnconfirmed || !automation.publicReplyEnabled)
    ) {
      continue;
    }

    if (!hasInstagramCredentials(automation.instagramAccount)) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let accessToken: InstagramContext;
    try {
      accessToken = await createInstagramContext(
        automation.instagramAccount,
        `${job.id}:${automation.id}`
      );
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    // Pacing: a first message to this commenter waits for its turn. It comes
    // before the public reply on purpose, so "sent you a DM" is posted when
    // the DM actually goes out, not hours earlier.
    const breakerOpen = needsDm && !privateRepliesPaused() && (await privateReplyBreakerOpen(instagramAccountId));
    const paused = privateRepliesPaused() || breakerOpen;
    if (needsDm && !paused && paceIntervalMs() > 0 && !job.data.pacedFor) {
      // Already waiting for its turn: this is a reconciler or webhook copy.
      if (await isPaced(instagramAccountId, commentId)) return;
      const now = Date.now();
      const slot = await reservePaceSlot(instagramAccountId, paceIntervalMs(), paceMaxWaitMs(), now);
      const logRow = {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId,
        commenterName,
        commentText,
        commentId,
        matchedKeyword: matchResult.matchedKeyword,
      };
      if (slot === null) {
        const errorMessage = "Pacing queue is longer than PRIVATE_REPLY_MAX_WAIT_HOURS";
        await prisma.dmLog.upsert({
          where: { automationId_commentId: { automationId: automation.id, commentId } },
          create: { ...logRow, status: "SKIPPED_RATE_LIMIT", errorMessage },
          update: { status: "SKIPPED_RATE_LIMIT", errorMessage },
        });
        continue;
      }
      if (slot - now > 5_000) {
        // A little jitter so the sends are not metronome-regular.
        const delay = slot - now + Math.floor(Math.random() * 20_000);
        const errorMessage = `Paced: scheduled for ${new Date(now + delay).toISOString()}`;
        await markPaced(instagramAccountId, commentId, delay + 3600_000);
        await prisma.dmLog.upsert({
          where: { automationId_commentId: { automationId: automation.id, commentId } },
          create: { ...logRow, status: "PENDING", errorMessage },
          update: { errorMessage },
        });
        // The scheduled run re-processes the whole comment, every campaign.
        await getDMQueue().add(
          "process-comment",
          { ...job.data, pacedFor: slot },
          { delay, jobId: `comment_${instagramAccountId}_${commentId}_paced` }
        );
        return;
      }
    }

    // Ensure a log row exists before the public reply leg (which updates it).
    // Only (re)set PENDING when the DM will actually be attempted, so a prior
    // SENT is never clobbered while we come back just to retry the public reply.
    if (!existingLog) {
      await prisma.dmLog.create({
        data: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "PENDING",
          attempts: job.attemptsMade + 1,
        },
      });
    } else if (needsDm) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "PENDING",
          attempts: job.attemptsMade + 1,
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: null,
        },
      });
    }

    // Public reply leg — decoupled from the DM, so a DM failure never
    // suppresses it. Idempotent across retries via publicReplySentAt. Its text
    // depends on the DM: the campaign's replies ("check your DMs") when one went
    // out, and PAUSED_PUBLIC_REPLY (write the keyword by DM) when none will —
    // during a pause, or when Instagram refused it.
    const keyword = (matchResult.matchedKeyword ?? automation.keywords[0] ?? "").toUpperCase();
    const askForDmReply = [
      (process.env.PAUSED_PUBLIC_REPLY || DEFAULT_PAUSED_PUBLIC_REPLY).replace(/\{keyword\}/gi, keyword),
    ];
    const campaignReply =
      automation.publicReplyMessages.length > 0
        ? automation.publicReplyMessages
        : automation.publicReplyMessage
          ? [automation.publicReplyMessage]
          : [];
    const postPublicReply = async (replyPool: string[]) => {
      if (
        automation.publicReplyEnabled &&
        replyPool.length > 0 &&
        !existingLog?.publicReplySentAt &&
        !existingLog?.publicReplyDeliveryUnconfirmed
      ) {
        try {
          const chosen = replyPool[Math.floor(Math.random() * replyPool.length)];
          const publicReply = renderMessageWithTracking({
            message: chosen,
            commenterName,
            trackedLinks: automation.trackedLinks,
          });
          await sendCommentReply({
            context: accessToken,
            commentId: commentId,
            message: publicReply,
            postId: mediaId,
          });
          await prisma.dmLog.update({
            where: {
              automationId_commentId: { automationId: automation.id, commentId },
            },
            data: { publicReplySentAt: new Date(), publicReplyError: null },
          });
        } catch (error) {
          console.error(
            "[DM Worker] Public comment reply failed:",
            formatError(error)
          );
          await prisma.dmLog
            .update({
              where: {
                automationId_commentId: {
                  automationId: automation.id,
                  commentId,
                },
              },
              data: { publicReplyError: formatError(error), publicReplyDeliveryUnconfirmed: isDeliveryUnconfirmed(error) },
            })
            .catch(() => {});
        }
      }
    };

    // With a DM to send, the public reply waits for how it went: posted first,
    // it told people whose DM Instagram then refused to check an empty inbox.
    // Without one, it goes out now: a retry of a reply that failed earlier, or
    // a pause.
    if (!needsDm || paused) {
      await postPublicReply(!paused && alreadyDmd ? campaignReply : askForDmReply);
    }

    // DM already sent on an earlier pass; the public reply retry above was all
    // this run needed. Don't re-send the DM.
    if (!needsDm) continue;

    // Paused: the public reply above asked for a DM; no private reply now, and
    // none later either — when the pause ends, the comments it covered are not
    // all messaged at once, which would be the very burst it exists to avoid.
    // dmDeliveryUnconfirmed is the flag the reconciler reads as "do not send".
    if (paused) {
      await prisma.dmLog.update({
        where: { automationId_commentId: { automationId: automation.id, commentId } },
        data: {
          status: "SKIPPED_RATE_LIMIT",
          dmDeliveryUnconfirmed: true,
          errorMessage: breakerOpen
            ? "Private replies paused by the breaker: asked to write the keyword by DM"
            : "Private replies paused: asked to write the keyword by DM",
        },
      });
      continue;
    }

    // Meta allows exactly ONE private reply per comment, ever — across every
    // campaign. When several campaigns match the same comment (duplicated
    // campaigns, or an any-post campaign overlapping a post-specific one), only
    // the first can deliver; the rest would fail with "The comment is invalid
    // for a private reply". Skip them explicitly instead of burning an API call
    // and logging a failure the user can do nothing about. The public reply
    // above still goes out per campaign — only the DM leg is deduped.
    const privateReplyUsedBy = await prisma.dmLog.findFirst({
      where: {
        commentId,
        status: "SENT",
        automationId: { not: automation.id },
      },
      select: { automation: { select: { name: true } } },
    });
    if (privateReplyUsedBy) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "SKIPPED_DEDUP",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Another campaign (${privateReplyUsedBy.automation?.name ?? "unknown"}) already sent the one private reply Instagram allows for this comment`,
        },
      });
      await postPublicReply(campaignReply);
      continue;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SKIPPED_PLAN_LIMIT",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      await postPublicReply(askForDmReply);
      continue;
    }

    let rateLimit;
    try {
      rateLimit = await reserveDMSlot(instagramAccountId, requeueAttempt);
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
        },
      });
      throw error;
    }

    if (!rateLimit.allowed) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      if (rateLimit.shouldSkip) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "SKIPPED_RATE_LIMIT",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly Instagram DM rate limit reached",
          },
        });
        await postPublicReply(askForDmReply);
        continue;
      }

      if (rateLimit.shouldRequeue) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "PENDING",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly rate limit hit; retry scheduled",
          },
        });

        await getDMQueue().add(
          "process-comment",
          {
            ...job.data,
            requeueAttempt: requeueAttempt + 1,
          },
          {
            delay: rateLimit.requeueDelayMs,
            jobId: `comment_${instagramAccountId}_${commentId}_retry_${requeueAttempt + 1}`,
          }
        );
        continue;
      }
    }

    // With an opening DM, the private reply is a button message; tapping it
    // fires a postback that delivers the reveal (see processPostback). Without
    // one, we send the reveal text directly as today.
    const useOpeningDm =
      automation.openingDmEnabled &&
      Boolean(automation.openingDmMessage) &&
      Boolean(automation.openingDmButtonLabel);

    // Follow-gating: the link is revealed only after a follow. When an opening
    // DM is enabled it comes FIRST, and its button routes into the follow check
    // (opening DM → follow gate → link). Without an opening DM, we check follow
    // status at comment time: confirmed followers get the link now, everyone
    // else gets the "follow me first" prompt (re-verified on tap).
    let sendFollowPrompt = false;
    if (automation.requireFollow && !useOpeningDm) {
      const alreadyFollows = await getUserFollowStatus({
        context: accessToken,
        recipientId: commenterId,
      });
      sendFollowPrompt =
        accessToken.provider === "ZERNIO"
          ? alreadyFollows === false
          : alreadyFollows !== true;
    }

    try {
      if (useOpeningDm) {
        // {keyword}: the word they commented, so the first message reads as
        // the answer to their request that it is.
        const openingText = renderMessageWithTracking({
          message: (automation.openingDmMessage as string).replace(/\{keyword\}/gi, keyword),
          commenterName,
          trackedLinks: [],
        });
        const openingPayload = automation.requireFollow
          ? `followcheck:${automation.id}`
          : `reveal:${automation.id}`;
        // The lead question moves to the next step (see leadQuestionMessage),
        // so this first message carries the main button alone.
        const askLeadNext = Boolean(automation.leadButtonLabel && leadQuestionMessage());
        if (openingTextOnly()) {
          const quickReplies = openingQuickReply() && automation.openingDmButtonLabel
            ? [{ title: automation.openingDmButtonLabel, payload: `${OPENING_QUICK_REPLY_PREFIX}${automation.id}` }]
            : [];
          const sendOpening = (withQuickReplies: typeof quickReplies) =>
            sendPrivateReply({
              context: accessToken,
              instagramAccountId: automation.instagramAccount.instagramId,
              commentId: commentId,
              message: openingText,
              postId: mediaId,
              quickReplies: withQuickReplies,
            });
          try {
            await sendOpening(quickReplies);
          } catch (error) {
            // Meta documents private replies as text only. If it turns the
            // quick replies down as an invalid request (rather than refusing
            // the reply itself), send the text alone so nobody loses theirs.
            if (
              quickReplies.length === 0 ||
              !(error instanceof MetaApiError) ||
              error.code !== 100 ||
              isPrivateReplyRefused(error)
            ) {
              throw error;
            }
            console.log("[DM Worker] Quick replies refused, sending the opening as text:", formatError(error));
            await sendOpening([]);
          }
          await markTextOpening(instagramAccountId, commenterId, automation.id);
        } else {
          await sendPrivateReplyWithButton({
            context: accessToken,
            instagramAccountId: automation.instagramAccount.instagramId,
            commentId: commentId,
            text: openingText,
            buttonTitle: automation.openingDmButtonLabel as string,
            // Both opening-DM buttons carry a marker, so a tap on them can be
            // told apart from the follow prompt's own "I'm following" button.
            payload: `${openingPayload}:${askLeadNext ? "intro" : "open"}`,
            postId: mediaId,
            leadingButtons: automation.leadButtonLabel && !askLeadNext
              ? [{ title: automation.leadButtonLabel, payload: `${openingPayload}:lead` }]
              : [],
          });
        }
      } else if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
          commenterName,
        });
        await sendPrivateReplyWithButton({
          context: accessToken,
          instagramAccountId: automation.instagramAccount.instagramId,
          commentId: commentId,
          text: promptText,
          buttonTitle: automation.followPromptButtonLabel || "i'm following",
          payload: `followcheck:${automation.id}`,
          postId: mediaId,
        });
      } else if (automation.trackedLinks.length > 0) {
        // Try button template first; if Meta rejects it, fall back to inline links.
        const bodyText =
          renderMessageWithoutLink({
            message: automation.dmMessage,
            commenterName,
          }) || "Here's your link:";
        const buttons = buildLinkButtons(
          automation.trackedLinks,
          automation.linkButtonLabel
        );

        try {
          await sendPrivateReplyWithLinkButton({
            context: accessToken,
            instagramAccountId: automation.instagramAccount.instagramId,
            commentId: commentId,
            text: bodyText,
            buttons: buttons,
            postId: mediaId,
          });
        } catch (buttonError) {
          // Only a template rejection is worth retrying as text. Anything else
          // (closed window, comment already replied to) fails the same way and
          // would replace the real error with a misleading one.
          if (!isTemplateRejection(buttonError)) throw buttonError;

          console.log(
            "[DM Worker] Button template rejected, falling back to inline link:",
            formatError(buttonError)
          );
          const fallbackMessage = buildInlineLinkFallback(
            automation.dmMessage,
            commenterName,
            automation.trackedLinks,
            bodyText
          );
          try {
            await sendPrivateReply({
              context: accessToken,
              instagramAccountId: automation.instagramAccount.instagramId,
              commentId: commentId,
              message: fallbackMessage,
              postId: mediaId,
            });
          } catch {
            // The first attempt consumed the comment's single private reply, so
            // this one reports "invalid for a private reply" no matter what the
            // underlying problem was. Surface the original rejection instead.
            throw buttonError;
          }
        }
      } else {
        const dmMessage = renderMessageWithTracking({
          message: automation.dmMessage,
          commenterName,
          trackedLinks: automation.trackedLinks,
        });
        await sendPrivateReply({
          context: accessToken,
          instagramAccountId: automation.instagramAccount.instagramId,
          commentId: commentId,
          message: dmMessage,
          postId: mediaId,
        });
      }

      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });
      await recordPrivateReplyResult(automation, instagramAccountId, false);
      await postPublicReply(campaignReply);
    } catch (error) {
      // The rate slot was reserved before the send; this send did not deliver a
      // DM, so hand the slot back instead of burning it (and burning more on
      // each BullMQ retry) until the hourly TTL expires.
      if (rateLimit?.reserved) {
        await releaseDMSlot(instagramAccountId);
      }
      // First attempts only: a retry after "Service temporarily unavailable"
      // comes back "invalid for a private reply" (the first attempt used the
      // comment's one reply), which would count the same refusal twice.
      if (job.attemptsMade === 0 && isIntegrityRefusal(error)) {
        await recordPrivateReplyResult(automation, instagramAccountId, true);
      }
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isFinalDmFailure(error) || isPrivateReplyUnavailable(error),
        },
      });
      // Final outcomes only; a retry decides the rest. Code 1 most likely
      // delivered, so it gets the usual reply.
      if (isDeliveryUnconfirmed(error)) {
        await postPublicReply(campaignReply);
      } else if (isFinalDmFailure(error) || isPrivateReplyUnavailable(error)) {
        await postPublicReply(askForDmReply);
      }
      if (isPrivateReplyUnavailable(error)) {
        throw new UnrecoverableError(formatError(error));
      }
      throw error;
    }
  }
}

async function sendPostbackOnce({
  operationId,
  send,
}: {
  operationId: string | null;
  send: () => Promise<unknown>;
}): Promise<boolean> {
  if (!operationId) {
    await send();
    return true;
  }
  try {
    await prisma.postbackDelivery.create({ data: { id: operationId } });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    )
      return false;
    throw error;
  }
  try {
    await send();
    return true;
  } catch (error) {
    // A durable claim survives queue eviction, concurrent redelivery, and a
    // process crash during delivery. Only confirmed rejections permit retry.
    if (
      (error instanceof ZernioApiError && error.code < 500) ||
      error instanceof RateLimitError ||
      error instanceof TokenExpiredError
    ) {
      await prisma.postbackDelivery.delete({ where: { id: operationId } });
      throw error;
    }
    throw error instanceof ZernioDeliveryUnconfirmedError
      ? error
      : new ZernioDeliveryUnconfirmedError();
  }
}

// Tells someone whose "I'm following" tap is being re-checked that it is being
// looked at, so the chat does not sit silent while Instagram catches up with
// the follow. Opt-in through FOLLOW_RECHECK_ACK_MESSAGE, and best-effort: it
// never holds up the re-check, which is already queued when this runs.
async function sendFollowRecheckAck({
  context,
  instagramAccountId,
  automationId,
  userId,
  operationId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  automationId: string;
  userId: string;
  operationId: string | null;
}): Promise<void> {
  const message = process.env.FOLLOW_RECHECK_ACK_MESSAGE?.trim();
  if (!message) return;
  try {
    // One acknowledgement per re-check cycle: a burst of taps collapses into a
    // single re-check (bucketed job id) and should get a single reply too.
    const first = await getRedisConnection().set(
      `follow_recheck_ack:${automationId}:${userId}`,
      "1",
      "PX",
      FOLLOW_RECHECK_TOTAL_MS,
      "NX"
    );
    if (first !== "OK") return;
    await sendPostbackOnce({
      // Its own id: the tap's id is claimed later by the link or prompt that
      // the re-check sends, and claiming it here would suppress that message.
      operationId: operationId ? `${operationId}:ack` : null,
      send: () =>
        sendDirectMessage({
          context,
          instagramAccountId,
          userId,
          message: pickVariants(message),
        }),
    });
  } catch (error) {
    console.log(
      "[DM Worker] Failed to send follow re-check acknowledgement:",
      formatError(error),
    );
  }
}

/**
 * Deliver the reveal message after a user taps an opening DM's button.
 * The postback payload is `reveal:<automationId>`; the sender is the user's
 * IGSID (same id as their comment author id), which we DM directly.
 */
async function processPostback(job: Job<ProcessPostbackJob>): Promise<void> {
  const { instagramAccountId, userId, payload, fallback } = job.data;

  const isFollowCheck = payload.startsWith("followcheck:");
  if (!isFollowCheck && !payload.startsWith("reveal:")) return;
  // Opening-DM buttons append a marker to the payload: ":open" on the main
  // button, ":lead" on the lead button. Both run the same follow gate and
  // deliver the same link; ":lead" also marks the person as a lead. Automation
  // ids are cuids and contain no colon.
  const [automationId, marker] = payload
    .slice(isFollowCheck ? "followcheck:".length : "reveal:".length)
    .split(":");
  const isLeadTap = marker === "lead";
  // ":intro" is the first message's only button when the lead question comes
  // one step later (see leadQuestionMessage).
  const isIntroTap = marker === "intro";
  const fromOpeningDm = marker === "open" || isLeadTap || isIntroTap;

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true, ...connectionScope(job.data) },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (
    !automation ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !hasInstagramCredentials(automation.instagramAccount)
  ) {
    return;
  }

  // A tap answers the lead question: later messages are just messages.
  if (!fallback) await clearLeadQuestion(instagramAccountId, userId);

  // Duplicate sends are enabled: every button tap re-sends the reveal
  // instead of only firing once per person.
  const dedupeId = `reveal:${userId}`;

  if (fallback) {
    const existingReveal = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });
    if (
      existingReveal?.status === "SENT" ||
      existingReveal?.dmDeliveryUnconfirmed
    )
      return;

    // Only a recent opening DM earns a fallback (same rule as the webhook that
    // queues it). Checked here as well, so a fallback queued before that rule
    // existed, or for an older campaign, cannot deliver a stale link.
    const recentOpening = await prisma.dmLog.findFirst({
      where: {
        automationId: automation.id,
        commenterId: userId,
        status: "SENT",
        dmSentAt: { gte: new Date(Date.now() - OPENING_DM_READ_FALLBACK_WINDOW_MS) },
        NOT: [
          { commentId: { startsWith: "reveal:" } },
          { commentId: { startsWith: "dm:" } },
        ],
      },
      select: { id: true },
    });
    if (!recentOpening) return;
  }

  // Personalize {username} from the opening DM log for this user, if present.
  const openingLog = await prisma.dmLog.findFirst({
    where: { automationId: automation.id, commenterId: userId },
    select: { commenterName: true },
  });
  const commenterName = openingLog?.commenterName ?? null;

  // Capture the lead on the first tap only: the delayed follow re-check re-runs
  // this job with the same payload and must not count twice. It happens before
  // the follow gate on purpose — a business owner who never follows is still a
  // lead worth a message.
  if (isLeadTap && !job.data.followRecheck) {
    await captureLead(automation, userId, commenterName, {
      instagramAccountId,
      accountConnectionId: job.data.accountConnectionId,
    });
  }

  let accessToken: InstagramContext;
  try {
    accessToken = await createInstagramContext(
      automation.instagramAccount,
      `${job.id}:${automation.id}`,
    );
  } catch {
    return;
  }

  const operationId =
    accessToken.provider === "ZERNIO"
      ? createHash("sha256")
          .update(
            JSON.stringify([
              automation.instagramAccountId,
              automation.id,
              userId,
              job.data.mid ?? job.id ?? payload,
            ]),
          )
          .digest("hex")
      : null;

  // The tap opened the conversation: now ask the lead question, whose two
  // buttons carry the usual ":lead" / ":open" markers into the gate and link.
  // Without a question configured (unset since the first message went out),
  // the tap simply counts as the opening button.
  const leadQuestion = leadQuestionMessage();
  if (isIntroTap && !fallback && leadQuestion && automation.leadButtonLabel) {
    const prefix = isFollowCheck ? "followcheck" : "reveal";
    try {
      await sendPostbackOnce({
        operationId,
        send: () =>
          sendDirectMessageWithButton({
            context: accessToken,
            instagramAccountId: automation.instagramAccount.instagramId,
            userId,
            text: renderMessageWithoutLink({ message: leadQuestion, commenterName }),
            buttonTitle:
              process.env.LEAD_QUESTION_NO_LABEL?.trim() || DEFAULT_LEAD_QUESTION_NO_LABEL,
            payload: `${prefix}:${automation.id}:open`,
            leadingButtons: [
              { title: automation.leadButtonLabel as string, payload: `${prefix}:${automation.id}:lead` },
            ],
          }),
      });
      await markLeadQuestion(instagramAccountId, userId, `${prefix}:${automation.id}`);
    } catch (error) {
      console.log("[DM Worker] Failed to send the lead question:", formatError(error));
    }
    return;
  }

  // Follow-gate: before revealing the link, verify the user follows. On a
  // `followcheck:` tap a non-follower gets the prompt again (no quota spent);
  // on a read fallback a non-follower is silently skipped — the gate must not
  // be bypassable by just reading the DM and waiting. On a tap, following or
  // unverifiable (null) falls through and delivers the link — fail-open so a
  // real follower is never trapped.
  if ((isFollowCheck || fallback) && automation.requireFollow) {
    const follows = await getUserFollowStatus({
      context: accessToken,
      recipientId: userId,
    });
    // A read fallback needs a confirmed follow. Instagram only reports follow
    // status once the person has tapped a button (before that it answers
    // "User consent is required", i.e. null), so failing open here handed the
    // link to anyone who read the opening DM and waited, follower or not.
    if (fallback && follows !== true) return;
    if (follows === false) {
      if (fallback) return;

      // A tap on an opening-DM button is not a claim to follow — most people
      // who tap it simply don't follow yet — so they get the follow prompt
      // right away. Only the prompt's own button earns the delayed re-check;
      // holding an opening tap for it left people staring at a silent chat.
      if (!fromOpeningDm) {
        // A `false` on a button tap: give the follow time to register and look
        // again, rather than rejecting someone who just followed.
        //
        // The job id is bucketed by the recheck window, not fixed per user.
        // BullMQ keeps completed jobs (removeOnComplete: count 1000) and silently
        // drops an add whose id is still retained, so a fixed id let a person be
        // re-checked once and then never again — their next false tap did
        // nothing at all, no link and no prompt. Bucketing still collapses a burst
        // of taps into a single re-check, which is what the fixed id was for.
        //
        // Jobs queued before re-checks were counted carry only `followRecheck`,
        // which meant one re-check done.
        const rechecksDone =
          job.data.followRecheckAttempt ?? (job.data.followRecheck ? 1 : 0);
        if (rechecksDone < FOLLOW_RECHECK_DELAYS_MS.length) {
          const delay = FOLLOW_RECHECK_DELAYS_MS[rechecksDone];
          const window = Math.floor(Date.now() / delay);
          await getDMQueue().add(
            POSTBACK_JOB_NAME,
            {
              ...job.data,
              followRecheck: true,
              followRecheckAttempt: rechecksDone + 1,
            },
            {
              delay,
              jobId: `postback_recheck_${automation.id}_${userId}_${rechecksDone + 1}_${window}`,
            }
          );
          if (rechecksDone === 0) {
            await sendFollowRecheckAck({
              context: accessToken,
              instagramAccountId: automation.instagramAccount.instagramId,
              automationId: automation.id,
              userId,
              operationId,
            });
          }
          return;
        }

        // Last `false`: they are genuinely not following. Record it — this
        // branch used to return without writing anything at all, so a gate that
        // turned people away left no trace and its rejection rate could not be
        // measured, only guessed at from complaints.
        await prisma.operationalEvent
          .create({
            data: {
              workspaceId: automation.workspaceId,
              source: "WORKER",
              level: "INFO",
              message: "Follow gate rejected a button tap",
              payload: {
                automationId: automation.id,
                automationName: automation.name,
                userId,
                commenterName,
              },
            },
          })
          .catch(() => {});
      }

      const promptText = renderMessageWithoutLink({
        message:
          automation.followPromptMessage ||
          "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
        commenterName,
      });
      try {
        await sendPostbackOnce({
          operationId,
          send: () =>
            sendDirectMessageWithButton({
              context: accessToken,
              instagramAccountId: automation.instagramAccount.instagramId,
              userId: userId,
              text: promptText,
              buttonTitle:
                automation.followPromptButtonLabel || "i'm following",
              payload: `followcheck:${automation.id}`,
            }),
        });
      } catch (error) {
        console.log(
          "[DM Worker] Failed to re-send follow prompt:",
          formatError(error),
        );
      }
      return;
    }
  }

  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  if (!usage.allowed) {
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
      update: { status: "SKIPPED_PLAN_LIMIT" },
    });
    return;
  }

  try {
    const delivered = await sendPostbackOnce({
      operationId,
      send: () =>
        sendRevealDirectMessage({
          accessToken: accessToken,
          automation: automation,
          userId: userId,
          commenterName: commenterName,
          context: "postback",
        }),
    });
    if (!delivered) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart,
      );
      return;
    }
    await clearLeadQuestion(instagramAccountId, userId);
    // Optional appreciation follow-up: once the link has been delivered, send a
    // short thank-you. It is scheduled as its own delayed job so it can go out
    // some minutes later (followUpDelayMinutes) rather than immediately. The
    // deterministic job id dedupes repeat button taps to one follow-up per user.
    if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
      const delayMs =
        Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000;
      await getDMQueue().add(
        FOLLOWUP_JOB_NAME,
        {
          instagramAccountId: automation.instagramAccount.instagramId,
          accountConnectionId: automation.instagramAccountId,
          userId,
          automationId: automation.id,
          commenterName,
        },
        {
          delay: delayMs,
          jobId: `followup_${automation.id}_${userId}`,
        },
      );
    }
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SENT",
        dmSentAt: new Date(),
      },
      update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
    });
  } catch (error) {
    await releaseWorkspaceDMReservation(
      automation.workspaceId,
      usage.periodStart,
    );

    // The read fallback is speculative: it only runs when the user read the
    // opening DM and never tapped the button, which means they never messaged
    // us, which means the 24-hour window is closed and Meta rejects the send
    // ("outside of allowed window"). That is the expected outcome here, not a
    // failure the user can act on — so don't log it as FAILED and don't retry
    // it against a window that cannot reopen on its own. It still delivers in
    // the case that does work: the user replied by typing instead of tapping.
    if (fallback && !(error instanceof ZernioDeliveryUnconfirmedError)) {
      console.log(
        "[DM Worker] Read fallback not delivered (messaging window closed):",
        formatError(error),
      );
      return;
    }

    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "FAILED",
        errorMessage: formatError(error),
        dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
      },
      update: {
        status: "FAILED",
        errorMessage: formatError(error),
        dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
      },
    });
    throw error;
  }
}

/**
 * Send the scheduled appreciation follow-up. Runs after its delay elapses.
 * Best-effort: if the message can't be delivered (e.g. the 24-hour messaging
 * window closed because the delay was long), it is logged, not retried forever.
 */
async function processFollowUp(job: Job<ProcessFollowUpJob>): Promise<void> {
  const { instagramAccountId, userId, automationId, commenterName } = job.data;

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true, ...connectionScope(job.data) },
    include: { instagramAccount: true },
  });

  if (
    !automation ||
    !automation.followUpEnabled ||
    !automation.followUpMessage?.trim() ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !hasInstagramCredentials(automation.instagramAccount)
  ) {
    return;
  }

  let accessToken: InstagramContext;
  try {
    accessToken = await createInstagramContext(
      automation.instagramAccount,
      `${job.id}:${automation.id}`
    );
  } catch {
    return;
  }

  try {
    await sendDirectMessage({
      context: accessToken,
      instagramAccountId: automation.instagramAccount.instagramId,
      userId: userId,
      message: renderMessageWithoutLink({
        message: automation.followUpMessage,
        commenterName: commenterName ?? null,
      }),
    });
  } catch (error) {
    console.log(
      "[DM Worker] Failed to send follow-up message:",
      formatError(error)
    );
  }
}

/**
 * Reply to an inbound DM whose text matches a campaign's keywords.
 *
 * The user has messaged us, so the conversation is already open: this path
 * skips the opening DM (which exists to work around private-reply limits from
 * comments) and delivers the reveal directly, honouring the follow gate.
 * Dedup is per inbound message id, so each message triggers at most one reply.
 */
async function processMessage(job: Job<ProcessMessageJob>): Promise<void> {
  const { instagramAccountId, messageId, messageText, senderId } = job.data;

  await notifyLeadReply(job.data);
  // A reply to a plain-text first message (see openingTextOnly), or a tap on
  // its quick reply, continues its campaign whatever it says; anything else
  // needs a keyword.
  const continuedId =
    quickReplyCampaign(job.data.quickReplyPayload) ??
    (await pendingTextOpening(instagramAccountId, senderId));
  // Keyword triggers read text only; an attachment-only message stops here,
  // unless it answers the lead question.
  if (!messageText && !continuedId) {
    await answerLeadQuestion(job.data);
    return;
  }

  const automations = await prisma.automation.findMany({
    where: {
      ...connectionScope(job.data),
      ...(continuedId ? { id: continuedId } : { dmTriggerEnabled: true }),
      isActive: true,
      instagramAccount: { instagramId: instagramAccountId },
    },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const dedupeId = `dm:${messageId}`;

  for (const automation of automations) {
    const matchResult = continuedId || automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          messageText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) continue;

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });

    // Already answered by this campaign: the message is done, so a retry of
    // the job must not move on and answer it again from the next campaign.
    if (existingLog?.status === "SENT" || existingLog?.dmDeliveryUnconfirmed) {
      return;
    }
    // Deliberately skipped by this campaign (plan limit): let another try.
    if (existingLog?.status === "SKIPPED_PLAN_LIMIT") {
      continue;
    }

    const logBase = {
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      instagramAccountId: automation.instagramAccountId,
      commenterId: senderId,
      commentText: messageText || "(reply)",
      commentId: dedupeId,
      matchedKeyword: matchResult.matchedKeyword,
    };

    if (!hasInstagramCredentials(automation.instagramAccount)) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let accessToken: InstagramContext;
    try {
      accessToken = await createInstagramContext(
        automation.instagramAccount,
        `${job.id}:${automation.id}`
      );
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    // Reuse a name captured on an earlier interaction so {username} still
    // renders — the messages webhook carries only the sender's IGSID.
    const priorLog = await prisma.dmLog.findFirst({
      where: { automationId: automation.id, commenterId: senderId },
      select: { commenterName: true },
    });
    const commenterName = priorLog?.commenterName ?? null;

    // Follow gate: anyone not confirmed as a follower gets the prompt instead of
    // the link, with the same `followcheck:` button that re-verifies on tap.
    // `null` (unverifiable) prompts too — this is first contact, exactly like a
    // comment, so it follows processComment's fail-closed rule rather than the
    // postback path's fail-open one. Fail-open is only safe after a tap, where
    // the user has already claimed to follow; here it would hand the link to
    // anyone whose status the API happens not to resolve.
    // A reply is mid-conversation (the first message already greeted them),
    // so it gets the plain question rather than the DM greeting.
    const leadQuestion = automation.leadButtonLabel
      ? continuedId ? leadQuestionMessage() : dmLeadQuestionMessage()
      : "";
    let sendFollowPrompt = false;
    if (automation.requireFollow && !leadQuestion) {
      const follows = await getUserFollowStatus({
        context: accessToken,
        recipientId: senderId,
      });
      sendFollowPrompt =
        accessToken.provider === "ZERNIO"
          ? follows === false
          : follows !== true;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
        update: {
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    try {
      if (leadQuestion) {
        // Its buttons carry the opening markers, so the gate and the link
        // follow exactly as after a comment (see processPostback).
        const prefix = automation.requireFollow ? "followcheck" : "reveal";
        await sendDirectMessageWithButton({
          context: accessToken,
          instagramAccountId: automation.instagramAccount.instagramId,
          userId: senderId,
          text: renderMessageWithoutLink({ message: leadQuestion, commenterName }),
          buttonTitle:
            process.env.LEAD_QUESTION_NO_LABEL?.trim() || DEFAULT_LEAD_QUESTION_NO_LABEL,
          payload: `${prefix}:${automation.id}:open`,
          leadingButtons: [
            { title: automation.leadButtonLabel as string, payload: `${prefix}:${automation.id}:lead` },
          ],
        });
        await markLeadQuestion(instagramAccountId, senderId, `${prefix}:${automation.id}`);
      } else if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "Almost there! Follow me and tap the button below to grab your link 💛",
          commenterName,
        });
        await sendDirectMessageWithButton({
          context: accessToken,
          instagramAccountId: automation.instagramAccount.instagramId,
          userId: senderId,
          text: promptText,
          buttonTitle: automation.followPromptButtonLabel || "I'm following ✅",
          payload: `followcheck:${automation.id}`,
        });
      } else {
        await sendRevealDirectMessage({
          accessToken: accessToken,
          automation: automation,
          userId: senderId,
          commenterName: commenterName,
          context: "message trigger",
        });

        // The link has been delivered, so the appreciation follow-up applies
        // here exactly as it does after a button tap. Not scheduled behind the
        // follow prompt — no link went out yet in that branch.
        if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
          await getDMQueue().add(
            FOLLOWUP_JOB_NAME,
            {
              instagramAccountId: automation.instagramAccount.instagramId,
              accountConnectionId: automation.instagramAccountId,
              userId: senderId,
              automationId: automation.id,
              commenterName,
            },
            {
              delay: Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000,
              jobId: `followup_${automation.id}_${senderId}`,
            }
          );
        }
      }

      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "SENT",
          dmSentAt: new Date(),
        },
        update: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });
      if (continuedId) await clearTextOpening(instagramAccountId, senderId);
      // One reply per message. A keyword often sits in several campaigns
      // (duplicated trial reels share one), and each would answer — the
      // person would get the same guide once per campaign.
      return;
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
        },
        update: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
        },
      });
      throw error;
    }
  }

  // No campaign took the message (a keyword still starts its own campaign):
  // it may be a written answer to the lead question.
  if (!continuedId) await answerLeadQuestion(job.data);
}

/**
 * Save someone who tapped the lead button, and queue the webhook notification.
 *
 * The unique key on (automationId, userId) is the dedupe: a repeat tap hits it
 * and stops here, so each person is captured and notified once per campaign.
 * Failure is logged and swallowed — capturing a lead must never cost that
 * person the link they asked for.
 */
async function captureLead(
  automation: { id: string; workspaceId: string; instagramAccountId: string },
  userId: string,
  username: string | null,
  // The postback job's own scope, carried over to the notification job.
  scope: { instagramAccountId: string; accountConnectionId?: string },
): Promise<void> {
  try {
    // The comment that brought them in, not a later "(button tap)" row.
    const comment = await prisma.dmLog.findFirst({
      where: {
        automationId: automation.id,
        commenterId: userId,
        commentText: { not: "(button tap)" },
      },
      orderBy: { createdAt: "asc" },
      select: { commentText: true },
    });

    const lead = await prisma.lead.create({
      data: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        userId,
        username,
        commentText: comment?.commentText ?? null,
      },
    });

    await getDMQueue().add(LEAD_JOB_NAME, { ...scope, leadId: lead.id });

    if (leadAudioUrls().length > 0) {
      const sendAt = leadAudioSendAt(new Date());
      await getDMQueue().add(
        LEAD_AUDIO_JOB_NAME,
        { ...scope, leadId: lead.id },
        { delay: Math.max(0, sendAt.getTime() - Date.now()), jobId: `lead_audio_${lead.id}` }
      );
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    )
      return;
    console.error("[DM Worker] Lead capture failed:", formatError(error));
  }
}

/**
 * Hand a captured lead to LEAD_WEBHOOK_URL — e.g. an n8n workflow that pings
 * the owner and appends a row to a sheet. With the variable unset the feature
 * is off and leads only live in the database.
 *
 * Throwing lets BullMQ retry on its normal backoff. notifiedAt is checked first
 * and written only once the webhook has accepted, so a retry after a success
 * never delivers the lead twice. Each lead gets exactly one job (captureLead
 * only enqueues on a fresh row), so there is no concurrent send to race.
 */
async function processNotifyLead(job: Job<NotifyLeadJob>): Promise<void> {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return;

  const lead = await prisma.lead.findUnique({ where: { id: job.data.leadId } });
  if (!lead || lead.notifiedAt) return;

  const automation = await prisma.automation.findUnique({
    where: { id: lead.automationId },
    select: { name: true },
  });

  const secret = process.env.LEAD_WEBHOOK_SECRET;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Lead-Secret": secret } : {}),
    },
    body: JSON.stringify({
      campaign: automation?.name ?? null,
      username: lead.username,
      profileUrl: lead.username
        ? `https://instagram.com/${lead.username}`
        : null,
      userId: lead.userId,
      commentText: lead.commentText,
      capturedAt: lead.createdAt.toISOString(),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  // A 2xx alone is not proof the lead was stored. n8n answers 200 with an empty
  // body when its workflow fails before reaching a "Respond to Webhook" node —
  // seen in production with a Google Sheets permission error — and trusting
  // that would mark the lead notified and never retry it. So the webhook has to
  // confirm explicitly with {"ok": true} once the lead is safely stored.
  const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(
      `Lead webhook did not confirm the lead (HTTP ${response.status})`
    );
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: { notifiedAt: new Date() },
  });
}

/**
 * Send a lead the automatic voice note. One per person: someone who became a
 * lead in two campaigns gets it once. A delivery Meta cannot confirm is
 * recorded as sent, never repeated; a closed 24-hour window is recorded and
 * left alone, since no retry can reopen it. Other failures throw, so BullMQ
 * retries them, and audioSentAt is checked first so a retry never sends twice.
 */
async function processLeadAudio(job: Job<LeadAudioJob>): Promise<void> {
  const urls = leadAudioUrls();
  if (urls.length === 0) return;

  const lead = await prisma.lead.findUnique({ where: { id: job.data.leadId } });
  if (!lead || lead.audioSentAt) return;
  const earlier = await prisma.lead.findFirst({
    where: {
      userId: lead.userId,
      instagramAccountId: lead.instagramAccountId,
      audioSentAt: { not: null },
    },
    select: { id: true },
  });
  if (earlier) return;

  const account = await prisma.instagramAccount.findUnique({
    where: { id: lead.instagramAccountId },
  });
  if (!account || !hasInstagramCredentials(account)) return;
  const context = await createInstagramContext(account, `${job.id}:lead-audio`);

  const url = urls[Math.floor(Math.random() * urls.length)];
  try {
    await sendDirectAudio({
      context,
      instagramAccountId: account.instagramId,
      userId: lead.userId,
      url,
    });
  } catch (error) {
    if (isDeliveryUnconfirmed(error)) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { audioSentAt: new Date(), audioError: `unconfirmed: ${formatError(error)}` },
      });
      return;
    }
    // Instagram localizes its messages, so the subcode is what identifies a
    // closed window; the English text is only a fallback.
    const windowClosed =
      (error instanceof MetaApiError && error.subcode === 2534022) ||
      /outside of allowed window/i.test(formatError(error));
    await prisma.lead.update({
      where: { id: lead.id },
      data: { audioError: formatError(error) },
    });
    if (windowClosed) return;
    throw error;
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: { audioSentAt: new Date(), audioError: null },
  });
}

const ATTACHMENT_LABELS: Record<string, string> = {
  audio: "🎤 te mandó un audio",
  image: "📷 te mandó una foto",
  video: "🎬 te mandó un video",
};

/**
 * Ping the owner the first time a lead writes back after their voice note,
 * with a link that opens that chat. Instagram files every conversation an app
 * has answered under General, and there is no API to move it to Primary, so
 * without this the replies get lost among the rest.
 *
 * Posts straight to ntfy (NTFY_TOPIC). Never throws: a missed ping must not
 * stop the keyword trigger that runs after it.
 */
async function notifyLeadReply(data: ProcessMessageJob): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const account = await prisma.instagramAccount.findFirst({
      where: { instagramId: data.instagramAccountId },
      select: { id: true },
    });
    if (!account) return;
    const scope = {
      userId: data.senderId,
      instagramAccountId: account.id,
      audioSentAt: { not: null },
    };
    const lead = await prisma.lead.findFirst({
      where: { ...scope, repliedAt: null },
      select: { username: true },
    });
    if (!lead) return;
    // Claim every campaign's lead row for this person at once, so two quick
    // messages (or a lead in two campaigns) ping only once.
    const claimedAt = new Date();
    const claimed = await prisma.lead.updateMany({
      where: { ...scope, repliedAt: null },
      data: { repliedAt: claimedAt },
    });
    if (claimed.count === 0) return;

    const preview = data.messageText
      ? `"${data.messageText.slice(0, 200)}"`
      : ATTACHMENT_LABELS[data.attachmentType ?? ""] ?? "📎 te mandó un archivo";
    const response = await fetch(process.env.NTFY_URL ?? "https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title: `${lead.username ? `@${lead.username}` : "Un lead"} respondió`,
        message: preview,
        // Opens that chat in the Instagram app, whatever folder it sits in.
        click: lead.username
          ? `https://ig.me/m/${lead.username}`
          : "https://www.instagram.com/direct/inbox/",
        tags: ["speech_balloon"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Give the ping back so the lead's next message tries again.
      await prisma.lead.updateMany({
        where: { ...scope, repliedAt: claimedAt },
        data: { repliedAt: null },
      });
      console.log(`[DM Worker] Lead reply ping failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.log("[DM Worker] Lead reply ping failed:", formatError(error));
  }
}

async function dispatchJob(job: Job<DmQueueJob>): Promise<void> {
  if (job.name === POSTBACK_JOB_NAME) {
    return processPostback(job as Job<ProcessPostbackJob>);
  }
  if (job.name === FOLLOWUP_JOB_NAME) {
    return processFollowUp(job as Job<ProcessFollowUpJob>);
  }
  if (job.name === MESSAGE_JOB_NAME) {
    return processMessage(job as Job<ProcessMessageJob>);
  }
  if (job.name === LEAD_JOB_NAME) {
    return processNotifyLead(job as Job<NotifyLeadJob>);
  }
  if (job.name === LEAD_AUDIO_JOB_NAME) {
    return processLeadAudio(job as Job<LeadAudioJob>);
  }
  return processComment(job as Job<ProcessCommentJob>);
}

async function processJob(job: Job<DmQueueJob>): Promise<void> {
  try {
    await dispatchJob(job);
  } catch (error) {
    // formatError() takes unknown; isFinalDmFailure() is a boolean check,
    // so it does not narrow `error` the way the old instanceof test did.
    if (isFinalDmFailure(error))
      throw new UnrecoverableError(formatError(error));
    throw error;
  }
}

async function recordWorkerFailure(
  job: Job<DmQueueJob> | undefined,
  error: Error
) {
  try {
    const instagramAccountId = job?.data.instagramAccountId;
    const commentId =
      job && "commentId" in job.data ? job.data.commentId : null;
    const account = instagramAccountId
      ? await prisma.instagramAccount.findUnique({
          where: { instagramId: instagramAccountId },
          select: { workspaceId: true },
        })
      : null;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "WORKER",
        level: "ERROR",
        message: `DM worker job ${job?.id ?? "unknown"} failed: ${error.message}`,
        payload: {
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          instagramAccountId: instagramAccountId ?? null,
          commentId,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
      instagramAccountId,
      commentId: commentId ?? undefined,
    });
  } catch (recordError) {
    console.error(
      "[DM Worker] Failed to record worker failure:",
      formatError(recordError)
    );
  }
}

export function createDMWorker(): Worker<DmQueueJob> {
  const worker = new Worker<DmQueueJob>("dm-processing", processJob, {
    connection: getRedisConnection(),
    concurrency: 5,
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        BACKOFF_DELAYS[Math.min(attemptsMade - 1, BACKOFF_DELAYS.length - 1)],
    },
  });

  worker.on("completed", (job) => {
    console.log(`[DM Worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[DM Worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message
    );
    void recordWorkerFailure(job, err);
  });

  worker.on("error", (err) => {
    console.error("[DM Worker] Worker error:", err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `DM worker process error: ${err.message}`,
          payload: { name: err.name },
        },
      })
      .catch((recordError) => {
        console.error(
          "[DM Worker] Failed to record worker process error:",
          formatError(recordError)
        );
      });
  });

  return worker;
}
