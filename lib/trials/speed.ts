/**
 * Speeds a video up (or down) with ffmpeg before it is published: the last
 * touch the owner used to give every variant by hand. Audio keeps its pitch.
 * Runs at the lowest priority on one thread: the host is a small laptop that
 * also runs the printer.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// atempo takes 0.5-2; the same range keeps the picture natural.
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** "1.2" or "1,2" (also "1.2x") to a factor; null when it is not one. */
export function parseSpeed(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(/x$/i, "").replace(",", "."));
  return Number.isFinite(n) && n >= MIN_SPEED && n <= MAX_SPEED ? n : null;
}

export function speedArgs(input: string, output: string, factor: number): string[] {
  return [
    "-y", "-i", input,
    "-filter:v", `setpts=PTS/${factor}`,
    "-filter:a", `atempo=${factor}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
    "-movflags", "+faststart", "-threads", "1",
    output,
  ];
}

/** The video at `factor` times its speed, as the bytes of an .mp4. */
export async function changeSpeed(video: ArrayBuffer, factor: number): Promise<ArrayBuffer> {
  const dir = await mkdtemp(join(tmpdir(), "trial-"));
  try {
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    await writeFile(input, Buffer.from(video));
    await new Promise<void>((resolve, reject) => {
      execFile(
        "nice",
        ["-n", "19", "ffmpeg", ...speedArgs(input, output, factor)],
        { timeout: 30 * 60_000, maxBuffer: 10 * 1024 * 1024 },
        (error, _stdout, stderr) =>
          error ? reject(new Error(`ffmpeg falló: ${stderr.trim().split("\n").slice(-3).join(" | ") || error.message}`)) : resolve()
      );
    });
    const out = await readFile(output);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
