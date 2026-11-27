/**
 * Messages the owner writes from the Hub.
 *
 * The Hub calls /api/interno/inbox/enviar, which only queues (hub-send). The
 * worker, one at a time:
 * 1. drops the reply the setter has pending for this person;
 * 2. waits at the send gate like any other message (lib/utils/send-gate.ts);
 * 3. sends (beyond 24 h, tagged HUMAN_AGENT: written by a person);
 * 4. records it in the setter as written by the owner, which is what makes
 *    the setter step aside until the person writes again;
 * 5. tells the Hub the message id, or why it did not go out.
 *
 * A clave is sent at most once: the outcome is kept in Redis before telling
 * the Hub, and a retry only repeats step 5.
 */

import type { Job } from "bullmq";
import { getMetaGraphApiVersion } from "@/lib/env";
import { getRedisConnection } from "@/lib/queue/client";
import { cancelPendingReply, recordOwnerMessage } from "@/lib/setter/engine";
import { waitForSendSlot } from "@/lib/utils/send-gate";
import { hubAccessToken, hubAccount, type HubAccount } from "./account";
import { HUB_MID_TTL_S, hubMidKey } from "./forward";
import { postToHub } from "./post";
import type { HubOutgoing, HubSendJob } from "./queue";

const OUTCOME_TTL_S = 7 * 24 * 3600;

function outcomeKey(clave: string): string {
  return `hub:send:${clave}`;
}

/** The body of the Send API call for what the Hub asked. */
export function sendBody(userId: string, out: HubOutgoing): Record<string, unknown> {
  if (out.kind === "reaction") {
    return out.emoji
      ? { recipient: { id: userId }, sender_action: "react", payload: { message_id: out.mid, reaction: "love" } }
      : { recipient: { id: userId }, sender_action: "unreact", payload: { message_id: out.mid } };
  }
  const message = out.text
    ? { text: out.text }
    : { attachment: { type: out.attachment!.type, payload: { url: out.attachment!.url } } };
  return {
    recipient: { id: userId },
    message,
    ...(out.tag ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : {}),
  };
}

type SendResult = { message_id?: string };

async function callSendApi(token: string, igId: string, body: Record<string, unknown>): Promise<SendResult> {
  await waitForSendSlot(`ig:${igId}`);
  const response = await fetch(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${igId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await response.json().catch(() => ({}))) as SendResult & { error?: { message?: string; code?: number } };
  if (!response.ok || data.error) {
    const error = data.error;
    throw new Error(`${error?.message ?? `HTTP ${response.status}`}${error?.code ? ` (código ${error.code})` : ""}`);
  }
  return data;
}

type Outcome = { mid: string | null; error: string | null };

async function deliver(account: HubAccount, token: string, job: HubSendJob): Promise<Outcome> {
  const connection = { accountConnectionId: account.id, instagramAccountId: account.instagramId };
  if (job.kind === "message") await cancelPendingReply(connection, job.userId);
  const result = await callSendApi(token, account.instagramId, sendBody(job.userId, job));
  const mid = result.message_id ?? null;
  if (job.kind === "message" && mid) {
    await getRedisConnection().set(hubMidKey(mid), "1", "EX", HUB_MID_TTL_S);
    await recordOwnerMessage({
      ...connection,
      userId: job.userId,
      messageId: mid,
      messageText: job.text ?? "",
      ...(job.attachment ? { attachmentType: job.attachment.type } : {}),
    });
  }
  return { mid, error: null };
}

export async function processHubSend(job: Job<HubSendJob>): Promise<void> {
  const data = job.data;
  const redis = getRedisConnection();
  const saved = await redis.get(outcomeKey(data.clave));
  let outcome: Outcome;
  if (saved) {
    outcome = JSON.parse(saved) as Outcome;
  } else {
    try {
      const { account, token } = await hubAccessToken(await hubAccount());
      outcome = await deliver(account, token, data);
    } catch (error) {
      outcome = { mid: null, error: error instanceof Error ? error.message : String(error) };
      console.log("[Hub] Message from the Hub not sent:", outcome.error);
    }
    await redis.set(outcomeKey(data.clave), JSON.stringify(outcome), "EX", OUTCOME_TTL_S);
  }
  await postToHub({ tipo: data.kind === "reaction" ? "reaccion" : "envio", clave: data.clave, ...outcome });
}
