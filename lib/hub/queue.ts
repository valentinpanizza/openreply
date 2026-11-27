/**
 * Two small queues for the Hub, apart from dm-processing so pausing that one
 * (or a long backlog in it) never holds the inbox up:
 *
 * - hub-forward: every DM, echo, reaction and read of the account, forwarded
 *   to the Hub (lib/hub/forward.ts). Retried while the Hub does not answer.
 * - hub-send: what the owner writes from the Hub, one at a time, through the
 *   send gate like every other message (lib/hub/send.ts).
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

export const HUB_FORWARD_QUEUE = "hub-forward";
export const HUB_SEND_QUEUE = "hub-send";

export interface HubForwardJob {
  // Instagram id of the account (entry.id).
  account: string;
  // One item of entry[].messaging, as Meta sent it.
  event: Record<string, unknown>;
  echo: boolean;
}

export type HubOutgoing =
  | { kind: "message"; text?: string; attachment?: { type: "image" | "audio"; url: string }; tag: boolean }
  | { kind: "reaction"; mid: string; emoji: string | null };

export type HubSendJob = HubOutgoing & {
  // Chosen by the Hub for each attempt: the same key is never sent twice.
  clave: string;
  userId: string;
};

let forwardQueue: Queue<HubForwardJob> | null = null;
let sendQueue: Queue<HubSendJob> | null = null;

export function getHubForwardQueue(): Queue<HubForwardJob> {
  forwardQueue ??= new Queue<HubForwardJob>(HUB_FORWARD_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: { age: 24 * 3600, count: 500 },
      // ~2 days of retries: the Hub's backup pass covers anything older.
      attempts: 12,
      backoff: { type: "exponential", delay: 10_000 },
    },
  });
  return forwardQueue;
}

export function getHubSendQueue(): Queue<HubSendJob> {
  sendQueue ??= new Queue<HubSendJob>(HUB_SEND_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: { age: 24 * 3600, count: 200 },
      // Only telling the Hub how it went is retried: the message itself goes
      // out at most once per clave (see send.ts).
      attempts: 8,
      backoff: { type: "exponential", delay: 10_000 },
    },
  });
  return sendQueue;
}
