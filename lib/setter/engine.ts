import { randomBytes } from "node:crypto";
import type { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import {
  getDMQueue,
  getRedisConnection,
  LEAD_JOB_NAME,
  SETTER_REMINDER_JOB_NAME,
  SETTER_REPLY_JOB_NAME,
  type ProcessMessageJob,
  type SetterEchoJob,
  type SetterReminderJob,
  type SetterReplyJob,
} from "@/lib/queue/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  MetaApiError,
  sendDirectAudio,
  sendDirectMessage,
  sendDirectMessageWithLinkButton,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { renderMessageWithTracking } from "@/lib/tracking/message";
import type { SetterConversation } from "@/app/generated/prisma/client";
import {
  AUDIO_KEYS,
  SETTER_ECHOES_FLAG,
  callMinutes,
  ownerTimeZone,
  setterAllowsUser,
  setterAudios,
  setterEnabled,
  setterModel,
  setterShadowModel,
  type AudioKey,
} from "./config";
import { budgetLeft, recordSpend } from "./budget";
import { runTurn, wording, type TranscriptLine, type TurnDecision, type TurnInput, type TurnTools } from "./brain";
import {
  busyBetween,
  calendarConfigured,
  createCallEvent,
  createPrivateEvent,
  formatInZone,
  freeSlotsOn,
  isValidTimeZone,
  withinOwnerHours,
  zonedToUtc,
} from "./calendar";
import { reelContext, type ReelCampaign } from "./context";
import { describeAttachment, humanize, splitLink } from "./text";
import { transcribeAudio } from "./transcribe";
import { forbiddenOutput, looksLikeInjection } from "./guard";
import { replyDelayMs, typingDelayMs } from "./timing";
import { isRateLimited, pauseSending, pausedUntil, rateLimitPauseMs, reserveSlot, withinReplyWindow } from "./pacing";
import { dailyReplyCap, fitOf, isPriority, nextMorning, overReplyCap, recordReplies, rememberFit } from "./quota";
import { chatLink, notifyOwner, setterButtons } from "./notify";
import { callPrepPrompt } from "./prep";

/**
 * The AI setter: instead of the campaign's fixed messages, Claude talks to the
 * people who comment, following the owner's setting structure, and books calls
 * in his Google Calendar. Off unless SETTER_ENABLED=true (see config.ts).
 *
 * Hooks into the DM worker at three points: a comment (the first message, as
 * the private reply), a DM from someone it is talking to (an answer, a little
 * later), and an echo of a message the owner wrote by hand (it leaves that
 * message to him and answers the person's next one, unless he silenced it).
 */

const TRANSCRIPT_LIMIT = 40;
const LOCK_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Conversation = SetterConversation;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function connectionId(data: { accountConnectionId?: string; instagramAccountId: string }) {
  if (data.accountConnectionId) return data.accountConnectionId;
  const account = await prisma.instagramAccount.findFirst({
    where: { instagramId: data.instagramAccountId },
    select: { id: true },
  });
  return account?.id ?? null;
}

async function findConversation(data: { accountConnectionId?: string; instagramAccountId: string }, userId: string) {
  const id = await connectionId(data);
  if (!id) return null;
  return prisma.setterConversation.findUnique({
    where: { instagramAccountId_userId: { instagramAccountId: id, userId } },
  });
}

// People the owner knows, who should not get the setter (scripts/setter.ts
// exclude). Usernames, lowercase, without @.
export const SETTER_EXCLUDED_KEY = "setter:excluded";

async function isExcluded(username: string | null | undefined): Promise<boolean> {
  if (!username) return false;
  return (await getRedisConnection().sismember(SETTER_EXCLUDED_KEY, username.toLowerCase())) === 1;
}

/** Whether the setter is talking to this person (the read fallback must not cut in). */
export async function setterHasConversation(
  data: { accountConnectionId?: string; instagramAccountId: string },
  userId: string
): Promise<boolean> {
  if (!setterEnabled()) return false;
  return Boolean(await findConversation(data, userId));
}

async function campaignFor(automationId: string | null) {
  if (!automationId) return null;
  return prisma.automation.findUnique({
    where: { id: automationId },
    include: { trackedLinks: { select: { slug: true, destinationUrl: true }, orderBy: { createdAt: "asc" } } },
  });
}

async function transcriptOf(conversationId: string, limit = TRANSCRIPT_LIMIT): Promise<TranscriptLine[]> {
  const rows = await prisma.setterMessage.findMany({
    where: { conversationId, role: { in: ["user", "bot", "owner"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse().map((row) => ({
    role: row.role as TranscriptLine["role"],
    text: row.kind === "audio" ? describeOwnAudio(row.text) : row.text,
    at: row.createdAt,
  }));
}

// What each recorded step says, so the model knows what the person heard and
// does not ask it again in writing.
const AUDIO_CONTENT: Record<AudioKey, string> = {
  situacion: "le preguntaste en qué área necesita más la ia",
  obstaculo: "le preguntaste si intentó automatizarlo por su cuenta y qué lo frenó",
  pitch: "le ofreciste la llamada gratis y le preguntaste si coordinan un horario",
  precio: "le explicaste que el precio depende del caso y que en la llamada le pasás un número",
  agendado: "le confirmaste la llamada y que le llega la invitación al mail",
};

function describeOwnAudio(text: string): string {
  const key = text.replace(/^\[audio: (\w+)\]$/, "$1") as AudioKey;
  return AUDIO_CONTENT[key] ? `[audio: ${key}. ${AUDIO_CONTENT[key]}]` : text;
}

async function audiosLeft(conversationId: string): Promise<AudioKey[]> {
  const available = setterAudios();
  const used = await prisma.setterMessage.findMany({
    where: { conversationId, kind: "audio", role: "bot" },
    select: { text: true },
  });
  const usedKeys = new Set(used.map((row) => row.text.replace(/^\[audio: (\w+)\]$/, "$1")));
  return AUDIO_KEYS.filter((key) => available[key]?.length && !usedKeys.has(key));
}

function describeCall(conversation: Conversation): string | null {
  if (!conversation.callAt) return null;
  const timeZone = conversation.timezone ?? ownerTimeZone();
  const when = formatInZone(conversation.callAt, timeZone);
  return conversation.callAt.getTime() > Date.now()
    ? `agendada para el ${when} (hora de la persona)`
    : `fue el ${when}`;
}

/**
 * Whether the person already got this campaign's resource (the reveal row,
 * also written by the button flows). Per campaign: someone who got another
 * reel's resource still gets this one.
 */
async function resourceSentFor(
  conversation: Conversation,
  campaign: Awaited<ReturnType<typeof campaignFor>>
): Promise<boolean> {
  if (!campaign) return Boolean(conversation.resourceSentAt);
  const row = await prisma.dmLog.findUnique({
    where: { automationId_commentId: { automationId: campaign.id, commentId: `reveal:${conversation.userId}` } },
    select: { status: true },
  });
  return row?.status === "SENT";
}

async function turnInput(
  mode: TurnInput["mode"],
  conversation: Conversation,
  campaign: Awaited<ReturnType<typeof campaignFor>>,
  context: InstagramContext | null
): Promise<TurnInput> {
  return {
    mode,
    reel: campaign ? await reelContext(campaign as ReelCampaign, context) : "",
    username: conversation.username,
    phase: conversation.phase,
    notes: conversation.notes,
    timezone: conversation.timezone,
    email: conversation.email,
    resourceSent: await resourceSentFor(conversation, campaign),
    resourceAvailable: Boolean(campaign?.trackedLinks.length),
    call: describeCall(conversation),
    audios: mode === "charla" ? await audiosLeft(conversation.id) : [],
    transcript: await transcriptOf(conversation.id),
    now: new Date(),
    ownerTimeZone: ownerTimeZone(),
    wording: wording(),
  };
}

// ─── Tools Claude can use ───────────────────────────────────────────────────────

function slotTools(conversation: Conversation, campaign: Awaited<ReturnType<typeof campaignFor>>, dryRun: boolean): TurnTools {
  return {
    async freeSlots(date, timeZone) {
      if (!calendarConfigured()) return "el calendario no está conectado: usá pasar_a_humano.";
      if (!isValidTimeZone(timeZone)) return `zona horaria inválida: ${timeZone}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "la fecha tiene que ser YYYY-MM-DD";
      const slots = await freeSlotsOn(date, timeZone, callMinutes());
      if (slots.length === 0) return `no hay horarios libres el ${date}. probá otro día.`;
      const fmt = new Intl.DateTimeFormat("es-UY", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      return `horarios libres el ${date} (hora de la persona, ${timeZone}): ${slots.map((s) => fmt.format(s)).join(", ")}`;
    },
    async book(args) {
      if (!calendarConfigured()) return "el calendario no está conectado: usá pasar_a_humano.";
      if (!isValidTimeZone(args.zona_horaria)) return `zona horaria inválida: ${args.zona_horaria}`;
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(args.inicio);
      if (!match) return "el inicio tiene que ser YYYY-MM-DDTHH:MM";
      const email = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return `ese mail no parece válido: ${args.email}`;
      if (conversation.callAt && conversation.callAt.getTime() > Date.now()) {
        return `ya tiene una llamada ${describeCall(conversation)}. si la quiere cambiar, usá pasar_a_humano.`;
      }
      const start = zonedToUtc(match[1], Number(match[2]), Number(match[3]), args.zona_horaria);
      if (start.getTime() < Date.now() + 60 * 60_000) return "ese horario ya pasó o es muy pronto: ofrecé otro.";
      if (!withinOwnerHours(start, callMinutes())) {
        return "ese horario no te sirve: ofrecé uno de los que da ver_horarios.";
      }
      const end = new Date(start.getTime() + callMinutes() * 60_000);
      if ((await busyBetween(start, end)).length > 0) return "ese horario ya no está libre: ofrecé otro.";
      const when = formatInZone(start, args.zona_horaria);
      if (dryRun) return `(prueba) agendado para el ${when}, invitación a ${email}.`;

      const event = await createCallEvent({
        start,
        minutes: callMinutes(),
        email,
        summary: `Llamada NodeStudio con ${args.nombre || conversation.username || "lead de instagram"}`,
        // The person sees this: nothing about them here (that goes in the prep event).
        description: "Llamada con Valentín Panizza (NodeStudio) por Google Meet.",
      });
      const updated = await prisma.setterConversation.update({
        where: { id: conversation.id },
        data: { callAt: start, eventId: event.id, email, timezone: args.zona_horaria, phase: "agendado" },
      });
      Object.assign(conversation, updated);
      await afterBooking(updated, campaign, start);
      return `agendada: ${when} (hora de la persona), invitación con link de meet enviada a ${email}. esto es para vos, no lo copies: confirmale el día y la hora hablándole a ella ("te llega la invitación a tu mail").`;
    },
  };
}

const PREP_LEAD_MINUTES = 30;

/** The prompt to prepare a booked call in Claude (see prep.ts). */
export async function callPrep(
  conversation: Conversation,
  campaign?: Awaited<ReturnType<typeof campaignFor>>
): Promise<string> {
  if (!conversation.callAt) throw new Error("No tiene llamada agendada");
  campaign ??= await campaignFor(conversation.automationId);
  return callPrepPrompt({
    username: conversation.username,
    email: conversation.email,
    callAt: conversation.callAt,
    minutes: callMinutes(),
    personTimeZone: conversation.timezone,
    ownerTimeZone: ownerTimeZone(),
    // Without an Instagram context: the cached text, or name, keywords and resource.
    reel: campaign ? await reelContext(campaign as ReelCampaign, null) : "",
    notes: conversation.notes,
    transcript: await transcriptOf(conversation.id, 500),
  });
}

async function afterBooking(
  conversation: Conversation,
  campaign: Awaited<ReturnType<typeof campaignFor>>,
  start: Date
): Promise<void> {
  const queue = getDMQueue();
  const account = await prisma.instagramAccount.findUnique({
    where: { id: conversation.instagramAccountId },
    select: { instagramId: true },
  });
  // A booked call is a lead: into the sheet like every other one (n8n).
  if (campaign && account) {
    try {
      const lead = await prisma.lead.create({
        data: {
          workspaceId: conversation.workspaceId,
          automationId: campaign.id,
          instagramAccountId: conversation.instagramAccountId,
          userId: conversation.userId,
          username: conversation.username,
          commentText: `agendó llamada: ${formatInZone(start, ownerTimeZone())}`,
        },
      });
      await queue.add(LEAD_JOB_NAME, {
        instagramAccountId: account.instagramId,
        accountConnectionId: conversation.instagramAccountId,
        leadId: lead.id,
      });
    } catch (error) {
      // Already a lead in this campaign (unique key): the call is still booked.
      if (!(typeof error === "object" && error && "code" in error && error.code === "P2002")) {
        console.error("[Setter] Lead after booking failed:", formatError(error));
      }
    }
  }
  if (account) {
    const reminderAt = start.getTime() - 60 * 60_000;
    if (reminderAt > Date.now() + 5 * 60_000) {
      await queue.add(
        SETTER_REMINDER_JOB_NAME,
        {
          instagramAccountId: account.instagramId,
          accountConnectionId: conversation.instagramAccountId,
          conversationId: conversation.id,
          callAt: start.toISOString(),
        },
        { delay: reminderAt - Date.now(), jobId: `setter_reminder_${conversation.id}_${start.getTime()}` }
      );
    }
  }
  let prepLink: string | null = null;
  try {
    const prep = await createPrivateEvent({
      start: new Date(start.getTime() - PREP_LEAD_MINUTES * 60_000),
      minutes: 20,
      summary: `Preparar llamada con ${conversation.username ? `@${conversation.username}` : "lead de instagram"}`,
      description: `Copiá todo esto y pegalo en Claude:\n\n${await callPrep(conversation, campaign)}`,
    });
    prepLink = prep.link;
  } catch (error) {
    console.error("[Setter] Call prep event failed:", formatError(error));
  }
  await notifyOwner({
    title: `📅 ${conversation.username ? `@${conversation.username}` : "Alguien"} agendó una llamada`,
    message: `${formatInZone(start, ownerTimeZone())} (tu hora) · ${conversation.email ?? ""}${
      prepLink ? "\nEl prompt para preparar la llamada está en tu calendario, 30 min antes." : ""
    }`,
    tags: ["calendar"],
    click: chatLink(conversation.username),
  });
}

/** Tell the webhook whether to queue echoes (see SETTER_ECHOES_FLAG). */
export async function syncSetterEchoesFlag(): Promise<void> {
  const redis = getRedisConnection();
  if (setterEnabled()) await redis.set(SETTER_ECHOES_FLAG, "1", "EX", 300);
  else await redis.del(SETTER_ECHOES_FLAG);
}

// ─── Opening: the private reply to a comment ────────────────────────────────────

export type SetterOpening =
  | { kind: "send"; conversationId: string; text: string; model: string; costUsd: number }
  | { kind: "owner" };

/**
 * The first message for someone who commented, written by the setter. Null
 * leaves the comment to the campaign's usual flow (setter off, person not in
 * SETTER_ONLY_USERS, budget spent, or Claude failed). "owner" means the owner
 * is already talking to them by hand, so nothing should be sent.
 */
export async function setterOpening({
  automation,
  context,
  commenterId,
  commenterName,
  commentText,
}: {
  automation: { id: string; workspaceId: string; instagramAccountId: string; name: string };
  context: InstagramContext;
  commenterId: string;
  commenterName?: string | null;
  commentText: string;
}): Promise<SetterOpening | null> {
  if (!setterEnabled() || !setterAllowsUser(commenterName, commenterId)) return null;
  if (await isExcluded(commenterName)) return null;
  const key = { instagramAccountId: automation.instagramAccountId, userId: commenterId };
  let existing: Conversation | null = null;
  let conversationId: string | null = null;
  try {
    existing = await prisma.setterConversation.findUnique({ where: { instagramAccountId_userId: key } });
    if (existing && existing.status !== "ACTIVE") return { kind: "owner" };
    if (!(await budgetLeft())) return null;

    const conversation = await prisma.setterConversation.upsert({
      where: { instagramAccountId_userId: key },
      create: {
        ...key,
        workspaceId: automation.workspaceId,
        username: commenterName ?? null,
        automationId: automation.id,
      },
      update: { automationId: automation.id, ...(commenterName ? { username: commenterName } : {}) },
    });
    conversationId = conversation.id;
    await prisma.setterMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        kind: "comment",
        text: `[comentó "${commentText}" en el reel de la campaña ${automation.name}]`,
      },
    });

    const campaign = await campaignFor(automation.id);
    const model = setterModel();
    const input = await turnInput("abridor", conversation, campaign, context);
    // Written for each person, never reused: hundreds of identical first
    // messages to strangers is what Instagram's spam filter looks for.
    const { decision, costUsd } = await runTurn(model, input, slotTools(conversation, campaign, true));
    await recordSpend(costUsd);
    const text = humanize(decision.messages[0] ?? "");
    if (!text) throw new Error("The opening came back empty");
    const blocked = forbiddenOutput([text]);
    if (blocked) throw new Error(`The opening ${blocked}`);
    if (decision.notes) {
      await prisma.setterConversation.update({ where: { id: conversation.id }, data: { notes: decision.notes } });
    }
    return { kind: "send", conversationId: conversation.id, text, model, costUsd };
  } catch (error) {
    console.error("[Setter] Opening failed, falling back to the campaign:", formatError(error));
    // A conversation made just now goes away again, so this person carries on
    // with the campaign's flow instead of a setter that never said hello.
    if (!existing && conversationId) {
      await prisma.setterConversation.delete({ where: { id: conversationId } }).catch(() => {});
    }
    return null;
  }
}

/** Record the opening once Instagram accepted it. */
export async function recordSetterOpening(
  opening: Extract<SetterOpening, { kind: "send" }>,
  messageId: string | undefined
): Promise<void> {
  await prisma.setterMessage.create({
    data: {
      conversationId: opening.conversationId,
      role: "bot",
      text: opening.text,
      mid: messageId ?? null,
      model: opening.model,
      costUsd: opening.costUsd,
    },
  });
  await prisma.setterConversation.update({
    where: { id: opening.conversationId },
    data: { lastBotAt: new Date(), phase: "abridor" },
  });
}

// ─── A message from the person ──────────────────────────────────────────────────

function tokenKey(conversationId: string) {
  return `setter:token:${conversationId}`;
}

async function scheduleReply(
  conversation: Conversation,
  data: { instagramAccountId: string; accountConnectionId?: string },
  token: string,
  delay: number,
  retry = 0,
  wait?: { slotAt?: number; waits: number }
) {
  await getRedisConnection().set(tokenKey(conversation.id), token, "EX", 24 * 3600);
  await getDMQueue().add(
    SETTER_REPLY_JOB_NAME,
    {
      instagramAccountId: data.instagramAccountId,
      accountConnectionId: conversation.instagramAccountId,
      conversationId: conversation.id,
      token,
      ...(retry ? { retry } : {}),
      ...(wait ?? {}),
    },
    {
      delay,
      jobId: `setter_reply_${conversation.id}_${Buffer.from(token).toString("base64url")}_${retry}${wait ? `_w${wait.waits}` : ""}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
    }
  );
}

/**
 * A DM from someone the setter is talking to. Returns true when the setter
 * owns the conversation, so the usual flows (keywords, lead question, link)
 * leave the message alone.
 */
export async function setterTakesMessage(data: ProcessMessageJob): Promise<boolean> {
  if (!setterEnabled()) return false;
  const conversation = await findConversation(data, data.senderId);
  if (!conversation) return false;

  // A voice note is read as text when it can be transcribed; otherwise the
  // owner listens to it (below).
  const voiceText =
    !data.messageText && data.attachmentType === "audio" && conversation.status === "ACTIVE"
      ? await transcribeAudio(data.attachmentUrl)
      : null;
  const text = data.messageText || (voiceText ? `[audio de voz, transcripto] ${voiceText}` : describeAttachment(data.attachmentType));
  try {
    await prisma.setterMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        kind: data.messageText ? "text" : "attachment",
        text,
        mid: data.messageId,
      },
    });
  } catch (error) {
    // Same message delivered twice (webhook and retry): already handled.
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return true;
    throw error;
  }
  const now = new Date();
  await prisma.setterConversation.update({ where: { id: conversation.id }, data: { lastUserAt: now } });
  if (conversation.status !== "ACTIVE") return true;

  // A voice note, photo or video: the setter cannot hear or see it, and asking
  // to have it typed reads as a bot. The owner takes the conversation.
  if (!data.messageText && !voiceText && ["audio", "image", "video"].includes(data.attachmentType ?? "")) {
    await handOver(
      conversation,
      `${describeAttachment(data.attachmentType).slice(1, -1)}: escuchalo/miralo y seguí vos la charla.`
    );
    return true;
  }

  // Built to override its instructions: not answered, the owner takes it.
  const heard = data.messageText || voiceText;
  if (heard && looksLikeInjection(heard)) {
    await handOver(conversation, `Mensaje raro, posible intento de manipular al setter: "${heard.slice(0, 150)}"`);
    return true;
  }

  await scheduleReply(conversation, data, data.messageId, replyDelayMs(conversation.lastBotAt, now));
  return true;
}

/**
 * A tap on a button of an older message (from before the setter) by someone
 * the setter is talking to: it reaches the setter as part of the chat, instead
 * of running that old flow on its own.
 */
export async function setterTakesTap(
  data: { instagramAccountId: string; accountConnectionId?: string; mid?: string; payload: string },
  userId: string
): Promise<boolean> {
  return setterTakesMessage({
    instagramAccountId: data.instagramAccountId,
    accountConnectionId: data.accountConnectionId,
    messageId: data.mid ?? `tap:${userId}:${data.payload}:${Date.now()}`,
    messageText: "[tocó el botón de un mensaje anterior pidiendo el recurso]",
    senderId: userId,
  });
}

// ─── The answer ─────────────────────────────────────────────────────────────────

async function handOver(conversation: Conversation, reason: string, { quiet = false } = {}): Promise<void> {
  await prisma.setterConversation.update({
    where: { id: conversation.id },
    data: { status: "HUMAN", statusReason: reason },
  });
  await getRedisConnection().del(tokenKey(conversation.id));
  if (quiet) return;
  await notifyOwner({
    title: `Contestale vos a ${conversation.username ? `@${conversation.username}` : "esta persona"}`,
    message: reason,
    tags: ["raising_hand"],
    click: chatLink(conversation.username),
    actions: setterButtons(conversation.id),
  });
}

/** The owner does not want the setter with this person: quiet for good. */
export async function silenceSetter(conversation: Conversation, reason: string): Promise<void> {
  await prisma.setterConversation.update({
    where: { id: conversation.id },
    data: { status: "STOPPED", statusReason: reason },
  });
  await getRedisConnection().del(tokenKey(conversation.id));
}

/**
 * The setter takes the conversation back. If the person's last message is
 * still unanswered, it answers it now; otherwise it waits for the next one.
 */
export async function resumeSetter(conversation: Conversation): Promise<void> {
  await prisma.setterConversation.update({
    where: { id: conversation.id },
    data: { status: "ACTIVE", statusReason: null },
  });
  const last = await prisma.setterMessage.findFirst({
    where: { conversationId: conversation.id, role: { in: ["user", "bot", "owner"] } },
    orderBy: { createdAt: "desc" },
  });
  if (last?.role !== "user") return;
  const account = await prisma.instagramAccount.findUnique({
    where: { id: conversation.instagramAccountId },
    select: { instagramId: true },
  });
  if (!account) return;
  await scheduleReply(conversation, { instagramAccountId: account.instagramId }, last.mid ?? last.id, 5_000);
}

async function stillCurrent(conversationId: string, token: string): Promise<boolean> {
  const [current, conversation] = await Promise.all([
    getRedisConnection().get(tokenKey(conversationId)),
    prisma.setterConversation.findUnique({ where: { id: conversationId }, select: { status: true } }),
  ]);
  return current === token && conversation?.status === "ACTIVE";
}

/**
 * Puts the answer off until `slotAt`, its turn to send (see pacing.ts). Past
 * Instagram's 24 h window it can no longer go, and the owner takes it.
 */
async function waitForTurn(
  conversation: Conversation,
  data: SetterReplyJob,
  token: string,
  slotAt: number
): Promise<void> {
  if (!withinReplyWindow(conversation.lastUserAt, slotAt)) {
    // Without a notice each: a pause of hours runs out dozens of them (the
    // pause's own notice says so, and setter.ts list shows them).
    await handOver(
      conversation,
      "Instagram frenó los envíos del setter (límite de frecuencia) y su mensaje ya está por pasar las 24 h: contestale vos.",
      { quiet: true }
    );
    return;
  }
  await scheduleReply(conversation, data, token, Math.max(0, slotAt - Date.now()), data.retry ?? 0, {
    slotAt,
    waits: (data.waits ?? 0) + 1,
  });
}

/**
 * Past the daily cap (quota.ts), someone not worth a call waits for the next
 * morning, spaced again then. Past Instagram's 24 h window by then, the owner
 * takes it, without a notice each.
 */
async function deferToMorning(conversation: Conversation, data: SetterReplyJob, token: string): Promise<void> {
  const morning = nextMorning(Date.now());
  if (!withinReplyWindow(conversation.lastUserAt, morning)) {
    await handOver(
      conversation,
      `Se llegó al tope diario de respuestas del setter (SETTER_DAILY_REPLIES=${dailyReplyCap()}) y su mensaje no llegaba a esperar a mañana: contestale vos si vale la pena.`,
      { quiet: true }
    );
    return;
  }
  await scheduleReply(conversation, data, token, morning - Date.now(), data.retry ?? 0, {
    waits: (data.waits ?? 0) + 1,
  });
}

// A message that only introduced the link ("dale, aca lo tenes:"), left
// empty when the link can't go.
const LINK_INTRO_ONLY =
  /^[\w\s,]*(aca|acá|ahi|ahí)\s+(te\s+)?(lo|la)\s+ten[eé]s:?$|\b(aca|acá|ahi|ahí)?\s*abajo\b/i;

function resourceMessages(
  decision: TurnDecision,
  campaign: Awaited<ReturnType<typeof campaignFor>>,
  { onlyLink = false } = {}
): { messages: string[]; sentResource: boolean } {
  let messages = decision.messages.map(humanize);
  // Writing {link} is asking for it too: sent again if they ask again, since
  // the turn input already told the model it was sent.
  const wantsLink = decision.sendResource || messages.some((m) => /\{link\}/i.test(m));
  const canSend = wantsLink && Boolean(campaign?.trackedLinks.length);
  if (!canSend) {
    messages = messages
      .map((m) => m.replace(/\s*\{link\}/gi, "").trim())
      .filter((m) => m && !LINK_INTRO_ONLY.test(m));
    // The goodbye to someone who already has the resource: one line at most.
    return { messages: onlyLink ? messages.slice(0, 1) : messages, sentResource: false };
  }
  // A chat that ends with the resource ends with that one message: the
  // "quedo a las ordenes" around it were ~15% of the sends (27/10).
  if (onlyLink) messages = messages.filter((m) => /\{link\}/i.test(m)).slice(0, 1);
  if (!messages.some((m) => /\{link\}/i.test(m))) {
    // A message that already hands it over ("te lo dejo aca abajo") carries
    // the button; otherwise one more message does.
    const handing = messages.findIndex((m) => /\babajo\b/i.test(m));
    if (handing >= 0) messages[handing] = `${messages[handing]} {link}`;
    else messages.push("te lo dejo aca abajo {link}");
  }
  const trackedLinks = trackedLinksFor(campaign!.trackedLinks);
  messages = messages.map((m) =>
    /\{link\}/i.test(m) ? renderMessageWithTracking({ message: m, trackedLinks }) : m
  );
  return { messages, sentResource: true };
}

/**
 * The campaign's links with a random tail (/r/<slug>/<ref>, which redirects
 * the same): one identical URL going to dozens of people within minutes is
 * what Instagram's spam filter looks for (the 368 blocks of 22/10 and 26/10
 * came after bursts carrying the same /r/ link).
 */
export function trackedLinksFor<T extends { slug: string }>(links: T[]): T[] {
  return links.map((link) => ({ ...link, slug: `${link.slug}/${randomBytes(4).toString("hex")}` }));
}

const LINK_BUTTON_TITLES = ["Abrir", "Ver acá", "Abrir acá", "Verlo"];

/**
 * A message carrying the resource goes out with the link in a button under it
 * (like ManyChat does), not pasted in the text: links in DM text are what
 * Meta's filter reads as harvesting data. If Instagram refuses the template,
 * the plain text with the link goes instead.
 */
async function sendSetterMessage(params: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  message: string;
}) {
  const split = splitLink(params.message);
  if (!split) return sendDirectMessage(params);
  const title = LINK_BUTTON_TITLES[Math.floor(Math.random() * LINK_BUTTON_TITLES.length)];
  try {
    return await sendDirectMessageWithLinkButton({ ...params, text: split.text, buttons: [{ title, url: split.url }] });
  } catch (error) {
    if (!(error instanceof MetaApiError) || error.code !== 100) throw error;
    console.log("[Setter] Link button refused, sending the link as text:", error.message);
    return sendDirectMessage(params);
  }
}

export async function processSetterReply(job: Job<SetterReplyJob>): Promise<void> {
  const { conversationId, token } = job.data;
  const redis = getRedisConnection();
  const lockKey = `setter:lock:${conversationId}`;

  // One answer at a time per conversation. A newer message's job that arrives
  // while one is being written waits for it, then answers what is left.
  if (!(await redis.set(lockKey, token, "PX", LOCK_MS, "NX"))) {
    if (await stillCurrent(conversationId, token)) {
      const conversation = await prisma.setterConversation.findUnique({ where: { id: conversationId } });
      if (conversation) await scheduleReply(conversation, job.data, token, 15_000, (job.data.retry ?? 0) + 1);
    }
    return;
  }

  let sentSomething = false;
  let conversation: Conversation | null = null;
  try {
    if (!(await stillCurrent(conversationId, token))) return;
    conversation = await prisma.setterConversation.findUnique({ where: { id: conversationId } });
    if (!conversation) return;

    if ((await overReplyCap()) && !isPriority(conversation, await fitOf(conversationId))) {
      await deferToMorning(conversation, job.data, token);
      return;
    }

    // Its turn to send: right away, unless Instagram has the setter paused or
    // another answer just went out. One that already waited keeps its turn,
    // and so does a newer message from someone already waiting for one.
    const instagramId = job.data.instagramAccountId;
    if (!job.data.slotAt || (await pausedUntil(instagramId)) > Date.now()) {
      const slotAt = await reserveSlot(instagramId, Date.now(), conversationId);
      if (slotAt > Date.now() + 1000) {
        await waitForTurn(conversation, job.data, token, slotAt);
        return;
      }
    }

    if (!(await budgetLeft())) {
      await handOver(conversation, "Se terminó el presupuesto diario del setter (SETTER_DAILY_BUDGET_USD).");
      return;
    }

    const account = await prisma.instagramAccount.findUnique({ where: { id: conversation.instagramAccountId } });
    if (!account || !hasInstagramCredentials(account)) return;
    const context = await createInstagramContext(account, `${job.id}:setter`);
    const campaign = await campaignFor(conversation.automationId);
    const model = setterModel();
    const input = await turnInput("charla", conversation, campaign, context);
    const { decision, costUsd } = await runTurn(model, input, slotTools(conversation, campaign, false));
    await recordSpend(costUsd);

    // Something new came in, or the owner took over, while it was writing:
    // the newer job answers instead. A booking made meanwhile is already saved.
    if (!(await stillCurrent(conversationId, token))) return;

    await rememberFit(conversationId, decision.fit);
    const closing = decision.phase === "cierre" && !conversation.callAt;
    const { messages, sentResource } = resourceMessages(decision, campaign, { onlyLink: closing });
    if (closing) decision.audio = null;
    const blocked = forbiddenOutput(messages);
    if (blocked) {
      await prisma.setterConversation.update({
        where: { id: conversationId },
        data: { notes: decision.notes, phase: decision.phase },
      });
      await handOver(
        conversation,
        `No mandé la respuesta del setter porque ${blocked}: "${messages.join(" / ").slice(0, 200)}"`
      );
      return;
    }
    let firstCost: number | null = costUsd;
    for (const [index, text] of messages.entries()) {
      if (index > 0) {
        await sleep(typingDelayMs(text));
        if (!(await stillCurrent(conversationId, token))) break;
      }
      const result = await sendSetterMessage({
        context,
        instagramAccountId: account.instagramId,
        userId: conversation.userId,
        message: text,
      });
      sentSomething = true;
      await recordReplies(1);
      await prisma.setterMessage.create({
        data: {
          conversationId,
          role: "bot",
          kind: sentResource && text.includes("/r/") ? "resource" : "text",
          text,
          mid: result?.message_id ?? null,
          model,
          costUsd: firstCost,
        },
      });
      firstCost = null;
    }

    const audioUrls = decision.audio ? setterAudios()[decision.audio] : undefined;
    if (decision.audio && audioUrls?.length && (await stillCurrent(conversationId, token))) {
      await sleep(4_000 + Math.random() * 4_000);
      const result = await sendDirectAudio({
        context,
        instagramAccountId: account.instagramId,
        userId: conversation.userId,
        url: audioUrls[Math.floor(Math.random() * audioUrls.length)],
      });
      sentSomething = true;
      await recordReplies(1);
      await prisma.setterMessage.create({
        data: {
          conversationId,
          role: "bot",
          kind: "audio",
          text: `[audio: ${decision.audio}]`,
          mid: result?.message_id ?? null,
          model,
          costUsd: firstCost,
        },
      });
    }

    if (sentResource && campaign) {
      // Counted like every other resource delivery (the reveal rows).
      const logKey = { automationId: campaign.id, commentId: `reveal:${conversation.userId}` };
      await prisma.dmLog.upsert({
        where: { automationId_commentId: logKey },
        create: {
          ...logKey,
          workspaceId: campaign.workspaceId,
          instagramAccountId: campaign.instagramAccountId,
          commenterId: conversation.userId,
          commenterName: conversation.username,
          commentText: "(setter)",
          status: "SENT",
          dmSentAt: new Date(),
        },
        update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
      });
    }

    const timezone = decision.timezone && isValidTimeZone(decision.timezone) ? decision.timezone : conversation.timezone;
    conversation = await prisma.setterConversation.update({
      where: { id: conversationId },
      data: {
        phase: conversation.callAt && decision.phase !== "cierre" ? "agendado" : decision.phase,
        notes: decision.notes,
        timezone,
        ...(sentSomething ? { lastBotAt: new Date() } : {}),
        ...(sentResource ? { resourceSentAt: new Date() } : {}),
      },
    });
    if (decision.handoff) await handOver(conversation, decision.handoff);

    await shadowTurn(conversation, campaign, input).catch((error) =>
      console.log("[Setter] Shadow turn failed:", formatError(error))
    );
  } catch (error) {
    console.error("[Setter] Reply failed:", formatError(error));
    const retry = job.data.retry ?? 0;
    if (isRateLimited(error) && conversation) {
      // Instagram's cap on sends: pause, and answer again after the pause
      // instead of handing the conversation over.
      const instagramId = job.data.instagramAccountId;
      if (await pauseSending(instagramId)) {
        await notifyOwner({
          title: "Instagram frenó al setter",
          message: `Límite de frecuencia (368). Pausa de unas ${Math.round(rateLimitPauseMs() / 3600_000)} h: las respuestas esperan y después salen de a una. Las que pasen las 24 h quedan para vos, sin aviso (setter.ts list).`,
          tags: ["hourglass"],
        });
      }
      if (sentSomething) {
        await handOver(conversation, `Instagram cortó la respuesta del setter a la mitad: fijate cómo quedó y seguí vos. ${formatError(error)}`);
      } else if (await stillCurrent(conversationId, token)) {
        await waitForTurn(conversation, job.data, token, await reserveSlot(instagramId));
      }
    } else if (!sentSomething && retry < 2 && conversation && (await stillCurrent(conversationId, token))) {
      await scheduleReply(conversation, job.data, token, 30_000 * (retry + 1), retry + 1);
    } else if (conversation) {
      await handOver(conversation, `El setter falló al contestar: ${formatError(error)}`);
    }
  } finally {
    if ((await redis.get(lockKey)) === token) await redis.del(lockKey);
  }
}

/**
 * The comparison model writes its own answer to the same turn. Stored as a
 * "shadow" message, never sent; it can look at free times, and its bookings
 * are only pretend.
 */
async function shadowTurn(
  conversation: Conversation,
  campaign: Awaited<ReturnType<typeof campaignFor>>,
  input: TurnInput
): Promise<void> {
  const shadow = setterShadowModel();
  if (!shadow || shadow === setterModel() || !(await budgetLeft())) return;
  const { decision, costUsd } = await runTurn(shadow, input, slotTools(conversation, campaign, true));
  await recordSpend(costUsd);
  const extras = [
    decision.audio ? `[audio: ${decision.audio}]` : null,
    decision.sendResource ? "[recurso]" : null,
    decision.handoff ? `[pasar a humano: ${decision.handoff}]` : null,
  ].filter(Boolean);
  await prisma.setterMessage.create({
    data: {
      conversationId: conversation.id,
      role: "shadow",
      text: [...decision.messages.map(humanize), ...extras].join(" / ") || "(nada)",
      model: shadow,
      costUsd,
    },
  });
}

// ─── The owner writing by hand ──────────────────────────────────────────────────

export async function processSetterEcho(job: Job<SetterEchoJob>): Promise<void> {
  if (!setterEnabled()) return;
  const { userId, messageId, messageText, attachmentType } = job.data;
  const conversation = await findConversation(job.data, userId);
  if (!conversation) return;
  // One of the setter's own messages.
  if (await prisma.setterMessage.findUnique({ where: { mid: messageId }, select: { id: true } })) return;

  try {
    await prisma.setterMessage.create({
      data: {
        conversationId: conversation.id,
        role: "owner",
        kind: messageText ? "text" : "attachment",
        text: messageText || describeAttachment(attachmentType),
        mid: messageId,
      },
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return;
    throw error;
  }
  // He answered by hand: what he answered is his (a reply the setter was about
  // to send goes away), and the person's next message is the setter's again.
  if (conversation.status !== "STOPPED") {
    await prisma.setterConversation.update({
      where: { id: conversation.id },
      data: { status: "ACTIVE", statusReason: null, lastBotAt: new Date() },
    });
    await getRedisConnection().del(tokenKey(conversation.id));
  }
}

// ─── Reminder before the call ───────────────────────────────────────────────────

export async function processSetterReminder(job: Job<SetterReminderJob>): Promise<void> {
  const conversation = await prisma.setterConversation.findUnique({ where: { id: job.data.conversationId } });
  if (!conversation?.callAt || conversation.callAt.toISOString() !== job.data.callAt) return;
  const account = await prisma.instagramAccount.findUnique({ where: { id: conversation.instagramAccountId } });
  if (!account || !hasInstagramCredentials(account)) return;
  // While Instagram has the setter paused, trying would only extend the block:
  // the calendar invitation reminds them anyway.
  if ((await pausedUntil(account.instagramId)) > Date.now()) return;
  const context = await createInstagramContext(account, `${job.id}:setter-reminder`);
  const time = new Intl.DateTimeFormat("es-UY", {
    timeZone: conversation.timezone ?? ownerTimeZone(),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(conversation.callAt);
  const text = humanize(
    `buenas! te recuerdo que hoy a las ${time} tenemos la llamada. el link de meet esta en la invitacion que te llego al mail, nos vemos ahi`
  );
  try {
    const result = await sendDirectMessage({
      context,
      instagramAccountId: account.instagramId,
      userId: conversation.userId,
      message: text,
    });
    await prisma.setterMessage.create({
      data: { conversationId: conversation.id, role: "bot", text, mid: result?.message_id ?? null },
    });
  } catch (error) {
    // Usually the 24-hour window: they have not written since the day before.
    console.log("[Setter] Call reminder not sent:", formatError(error));
  }
}
