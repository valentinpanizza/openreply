/**
 * Forwarding the account's DMs to the Hub.
 *
 * The webhook (Vercel) only queues: one hub-forward job per item of
 * entry[].messaging (a message, an echo, a reaction, a read). The worker
 * posts it to the Hub as Meta sent it, plus who wrote an echo:
 *
 * - "hub": it went out from the Hub (send.ts marks its mid);
 * - "agente": the setter sent it (SetterMessage, role bot);
 * - "valentin": anything else (written by hand in the Instagram app).
 *
 * Echoes wait 20 s before going, like the setter's own echo job (15 s), so the
 * setter has recorded the ids of its messages by then.
 */

import type { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { hubAccount } from "./account";
import { hubForwardEnabled } from "./config";
import { postToHub } from "./post";
import { getHubForwardQueue, type HubForwardJob } from "./queue";

export const ECHO_DELAY_MS = 20_000;
export const HUB_MID_TTL_S = 7 * 24 * 3600;

export function hubMidKey(mid: string): string {
  return `hub:mid:${mid}`;
}

type Messaging = Record<string, unknown> & {
  timestamp?: number;
  message?: { mid?: string; is_echo?: boolean };
  reaction?: { mid?: string; action?: string; emoji?: string };
  read?: { mid?: string };
  postback?: { mid?: string };
};

type Payload = { object?: string; entry?: { id?: string; messaging?: Messaging[] }[] };

/** The jobs to queue for a webhook payload: only the Hub's account, only what has an id to dedupe on. */
export function forwardJobsFor(
  payload: Payload,
  igId: string
): { jobId: string; data: HubForwardJob; delay: number }[] {
  if (payload.object !== "instagram") return [];
  const jobs: { jobId: string; data: HubForwardJob; delay: number }[] = [];
  for (const entry of payload.entry ?? []) {
    if (entry.id !== igId) continue;
    for (const event of entry.messaging ?? []) {
      const mid = event.message?.mid ?? event.reaction?.mid ?? event.read?.mid ?? event.postback?.mid;
      if (!mid) continue;
      const kind = event.message ? "m" : event.reaction ? `r${event.reaction.action ?? ""}${event.reaction.emoji ?? ""}` : event.read ? "v" : "p";
      const echo = Boolean(event.message?.is_echo);
      // A message is forwarded once; a reaction or a read, once per moment it happened.
      const key = kind === "m" ? `m:${mid}` : `${kind}:${mid}:${event.timestamp ?? ""}`;
      jobs.push({
        jobId: `fwd_${Buffer.from(key).toString("base64url")}`,
        data: { account: igId, event, echo },
        delay: echo ? ECHO_DELAY_MS : 0,
      });
    }
  }
  return jobs;
}

/** From the webhook. Never throws: the Hub must not get in the way of OpenReply's own work. */
export async function queueHubForward(payload: unknown): Promise<void> {
  if (!hubForwardEnabled()) return;
  try {
    const account = await hubAccount();
    if (!account || account.provider !== "META") return;
    const jobs = forwardJobsFor(payload as Payload, account.instagramId);
    if (!jobs.length) return;
    const queue = getHubForwardQueue();
    await Promise.all(jobs.map((job) => queue.add("forward", job.data, { jobId: job.jobId, delay: job.delay })));
  } catch (error) {
    console.error("[Hub] Could not queue the forward:", error instanceof Error ? error.message : error);
  }
}

export type EchoOrigin = "hub" | "agente" | "valentin";

/** Who wrote a message the account sent. */
export async function echoOrigin(mid: string): Promise<EchoOrigin> {
  if (await getRedisConnection().get(hubMidKey(mid))) return "hub";
  const row = await prisma.setterMessage.findUnique({ where: { mid }, select: { role: true } });
  return row?.role === "bot" ? "agente" : "valentin";
}

export async function processHubForward(job: Job<HubForwardJob>): Promise<void> {
  const { account, event, echo } = job.data;
  const mid = (event as Messaging).message?.mid;
  const origen = echo && mid ? await echoOrigin(mid) : null;
  await postToHub({ tipo: "meta", cuenta: account, evento: event, origen });
}
