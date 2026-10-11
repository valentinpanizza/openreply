/**
 * Puts a video in a public Supabase Storage bucket for the few minutes
 * Instagram needs to download it, under a random name, and takes it away
 * afterwards. Instagram Login cannot receive the file directly: it only takes
 * a video_url.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_KEY (the project's service_role key)
 * and a public bucket (TRIAL_STAGING_BUCKET, default "trial-tmp").
 */

import { randomUUID } from "node:crypto";

export interface StagedVideo {
  url: string;
  remove: () => Promise<void>;
}

export async function stageVideo(
  video: ArrayBuffer,
  env: NodeJS.ProcessEnv = process.env
): Promise<StagedVideo> {
  const base = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_KEY?.trim();
  if (!base || !key) throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el .env del worker");
  const bucket = env.TRIAL_STAGING_BUCKET?.trim() || "trial-tmp";
  const name = `${randomUUID()}.mp4`;
  const headers = { Authorization: `Bearer ${key}`, apikey: key };

  const response = await fetch(`${base}/storage/v1/object/${bucket}/${name}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "video/mp4" },
    body: video,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Supabase no aceptó el video (HTTP ${response.status}): ${detail}`);
  }

  return {
    url: `${base}/storage/v1/object/public/${bucket}/${name}`,
    remove: async () => {
      await fetch(`${base}/storage/v1/object/${bucket}/${name}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
    },
  };
}
