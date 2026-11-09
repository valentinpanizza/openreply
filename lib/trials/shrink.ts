/**
 * Shrinks a video that is too heavy for the staging bucket: Supabase refuses
 * files over its size limit (50 MB on the free plan) with "413 Payload too
 * large", and the publisher would retry the same file forever. Picture size,
 * frame rate and length stay; only the bitrate goes down, capped so the result
 * fits whatever the length. Instagram re-encodes every reel anyway, at less
 * than this. Lowest priority on one thread, like the speed change: the host is
 * a small laptop that also runs the printer.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_STAGING_MAX_MB = 50;
const AUDIO_KBPS = 128;
const MIN_VIDEO_KBPS = 300;
const MAX_VIDEO_KBPS = 8000;

/** The bucket's size limit in bytes (TRIAL_STAGING_MAX_MB, default 50). */
export function stagingLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.TRIAL_STAGING_MAX_MB?.trim());
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_STAGING_MAX_MB) * 1024 * 1024;
}

/** Video bitrate cap (kbps) so `seconds` of picture and sound weigh about `targetBytes`. */
export function videoKbps(seconds: number, targetBytes: number): number {
  const totalKbps = (targetBytes * 8) / 1000 / seconds;
  return Math.max(MIN_VIDEO_KBPS, Math.min(MAX_VIDEO_KBPS, Math.floor(totalKbps * 0.95 - AUDIO_KBPS)));
}

export function shrinkArgs(input: string, output: string, kbps: number): string[] {
  return [
    "-y", "-i", input,
    "-c:v", "libx264", "-preset", "medium", "-crf", "19",
    "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ar", "48000",
    "-movflags", "+faststart", "-threads", "1",
    output,
  ];
}

/**
 * The file cannot be made to fit, or ffmpeg cannot read it. Trying again would
 * spend the same minutes of CPU on the same result: the publishers take the
 * video out of the queue, as they do with one Instagram cannot process.
 */
export class ShrinkError extends Error {}

function run(label: string, command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) =>
      error
        ? reject(new ShrinkError(`${label} falló: ${String(stderr).trim().split("\n").slice(-3).join(" | ") || error.message}`))
        : resolve(String(stdout))
    );
  });
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * The video as it is when it fits under `limitBytes` (with a 5% margin);
 * otherwise re-encoded to about 80% of the limit.
 */
export async function fitVideo(video: ArrayBuffer, limitBytes: number): Promise<ArrayBuffer> {
  const ceiling = Math.floor(limitBytes * 0.95);
  if (video.byteLength <= ceiling) return video;

  const dir = await mkdtemp(join(tmpdir(), "shrink-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "out.mp4");
    await writeFile(input, Buffer.from(video));
    const seconds = Number(
      (await run("ffprobe", "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input], 60_000)).trim()
    );
    if (!(seconds > 0)) throw new ShrinkError("no pude leer la duración del video para comprimirlo");
    const kbps = videoKbps(seconds, limitBytes * 0.8);
    console.log(`[Staging] El video pesa ${mb(video.byteLength)} MB y el límite es ${mb(limitBytes)} MB: lo comprimo (${kbps} kbps)`);
    await run("ffmpeg", "nice", ["-n", "19", "ffmpeg", ...shrinkArgs(input, output, kbps)], 45 * 60_000);
    const out = await readFile(output);
    if (out.byteLength > ceiling) {
      throw new ShrinkError(`aun comprimido pesa ${mb(out.byteLength)} MB; el límite de Supabase es ${mb(limitBytes)} MB`);
    }
    console.log(`[Staging] Comprimido: ${mb(video.byteLength)} MB → ${mb(out.byteLength)} MB`);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
