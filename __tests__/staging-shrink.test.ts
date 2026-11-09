import { afterEach, describe, expect, it, vi } from "vitest";

import { fitVideo, shrinkArgs, stagingLimitBytes, videoKbps } from "../lib/trials/shrink";
import { stageVideo } from "../lib/trials/staging";

const MiB = 1024 * 1024;
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("shrink", () => {
  it("reads the bucket limit, 50 MB unless set", () => {
    expect(stagingLimitBytes(env({}))).toBe(50 * MiB);
    expect(stagingLimitBytes(env({ TRIAL_STAGING_MAX_MB: "100" }))).toBe(100 * MiB);
    expect(stagingLimitBytes(env({ TRIAL_STAGING_MAX_MB: "mucho" }))).toBe(50 * MiB);
  });

  it("caps the bitrate so a minute of video lands well under the limit", () => {
    // 3 CLAUDE: 61 s, 79 MB at 10 Mbps, refused by Supabase on 2026-11-08.
    const kbps = videoKbps(60.7, 40 * MiB);
    expect(kbps).toBeGreaterThan(4000);
    expect((kbps + 128) * 1000 / 8 * 60.7).toBeLessThan(40 * MiB);
  });

  it("keeps the bitrate within sane bounds for very short and very long videos", () => {
    expect(videoKbps(5, 40 * MiB)).toBe(8000);
    expect(videoKbps(3600, 40 * MiB)).toBe(300);
  });

  it("keeps size and frame rate, caps the bitrate and runs on one thread", () => {
    const args = shrinkArgs("in", "out.mp4", 5000);
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-r");
    expect(args.join(" ")).toContain("-maxrate 5000k -bufsize 10000k");
    expect(args.join(" ")).toContain("-threads 1");
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("leaves a video that already fits untouched", async () => {
    const video = new ArrayBuffer(1000);
    await expect(fitVideo(video, 50 * MiB)).resolves.toBe(video);
  });
});

describe("stageVideo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uploads a video that fits as it is", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const video = new ArrayBuffer(1000);
    const staged = await stageVideo(video, env({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_KEY: "k" }));
    expect(staged.url).toMatch(/^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/trial-tmp\/.+\.mp4$/);
    expect(fetchMock.mock.calls[0][1].body).toBe(video);
  });
});
