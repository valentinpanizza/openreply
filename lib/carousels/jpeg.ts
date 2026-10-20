/**
 * Instagram's API takes only JPEG for images; the carousels come out of the
 * renderer as PNG. Converted with ffmpeg (already in the worker image) at the
 * lowest priority, like the trial speed-up: the host also runs the printer.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const isJpeg = (name: string) => /\.jpe?g$/i.test(name);

export function jpegArgs(input: string, output: string): string[] {
  // -q:v 2 is near-lossless; a 1080x1350 slide stays well under the 8 MB limit.
  return ["-y", "-i", input, "-q:v", "2", "-pix_fmt", "yuvj420p", "-threads", "1", output];
}

/** The image as JPEG bytes. A file that already is one comes back untouched. */
export async function toJpeg(image: ArrayBuffer, name: string): Promise<ArrayBuffer> {
  if (isJpeg(name)) return image;
  const dir = await mkdtemp(join(tmpdir(), "carousel-"));
  try {
    const input = join(dir, "in.png");
    const output = join(dir, "out.jpg");
    await writeFile(input, Buffer.from(image));
    await new Promise<void>((resolve, reject) => {
      execFile(
        "nice",
        ["-n", "19", "ffmpeg", ...jpegArgs(input, output)],
        { timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024 },
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
