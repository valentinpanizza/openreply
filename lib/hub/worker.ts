import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { hubForwardEnabled } from "./config";
import { processHubForward } from "./forward";
import { HUB_FORWARD_QUEUE, HUB_SEND_QUEUE, type HubForwardJob, type HubSendJob } from "./queue";
import { processHubSend } from "./send";

/** The Hub's two queues (lib/hub/queue.ts). None without HUB_URL and HUB_CLAVE. */
export function createHubWorkers(): Worker[] {
  if (!hubForwardEnabled()) return [];
  const forward = new Worker<HubForwardJob>(HUB_FORWARD_QUEUE, processHubForward, {
    connection: getRedisConnection(),
    concurrency: 4,
  });
  // One at a time: each send may wait at the gate, and they go out in order.
  const send = new Worker<HubSendJob>(HUB_SEND_QUEUE, processHubSend, {
    connection: getRedisConnection(),
    concurrency: 1,
  });
  for (const [name, worker] of [
    ["forward", forward],
    ["send", send],
  ] as const) {
    worker.on("failed", (job, error) => {
      console.error(`[Hub] ${name} job ${job?.id} failed (attempt ${job?.attemptsMade}):`, error.message);
    });
    worker.on("error", (error) => console.error(`[Hub] ${name} worker error:`, error.message));
  }
  console.log("[Hub] Forwarding the inbox to the Hub");
  return [forward, send];
}
