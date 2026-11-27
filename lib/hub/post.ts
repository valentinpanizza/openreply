import { UnrecoverableError } from "bullmq";
import { hubKey, hubUrl, signForHub } from "./config";

/**
 * POST to the Hub's webhook (`/api/webhooks/openreply`), signed. Throws to
 * retry when the Hub is down or answers 5xx; a 4xx means the body is wrong and
 * is not retried.
 */
export async function postToHub(body: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<void> {
  const url = hubUrl();
  const key = hubKey();
  if (!url || !key) throw new UnrecoverableError("HUB_URL or HUB_CLAVE is not set");
  const raw = JSON.stringify(body);
  const response = await fetcher(`${url}/api/webhooks/openreply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenReply-Firma": signForHub(raw, key) },
    body: raw,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return;
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  if (response.status < 500) throw new UnrecoverableError(`The Hub answered ${response.status}: ${detail}`);
  throw new Error(`The Hub answered ${response.status}: ${detail}`);
}
