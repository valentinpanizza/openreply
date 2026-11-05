import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockMeta, mockStage, mockUnstage, mockDuplicate, mockFetch, redis, cloud } = vi.hoisted(() => {
  const kv = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  return {
    mockPrisma: {
      automation: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      instagramAccount: { findFirst: vi.fn() },
    },
    mockMeta: {
      createReelContainer: vi.fn(),
      getMediaContainerStatus: vi.fn(),
      publishMediaContainer: vi.fn(),
      getMediaPermalink: vi.fn(),
      getUserMedia: vi.fn(),
    },
    mockStage: vi.fn(),
    mockUnstage: vi.fn(),
    mockDuplicate: vi.fn(),
    mockFetch: vi.fn(),
    redis: {
      kv,
      hashes,
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
        if (args.includes("NX") && kv.has(key)) return null;
        kv.set(key, String(value));
        return "OK";
      }),
      del: vi.fn(async (key: string) => (kv.delete(key) ? 1 : 0)),
      hset: vi.fn(async (key: string, field: string, value: string) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        hashes.get(key)!.set(field, value);
        return 1;
      }),
      hexists: vi.fn(async (key: string, field: string) => (hashes.get(key)?.has(field) ? 1 : 0)),
    },
    cloud: {
      list: vi.fn(),
      readText: vi.fn(),
      download: vi.fn(),
      rename: vi.fn(),
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "token" }));
vi.mock("@/lib/campaigns/duplicate", () => ({ duplicateCampaign: mockDuplicate }));
vi.mock("@/lib/trials/staging", () => ({ stageVideo: mockStage, stageFile: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  ...mockMeta,
}));
vi.mock("@/lib/trials/opencloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trials/opencloud")>()),
  OpenCloudClient: { fromEnv: () => cloud },
}));

import { reelCampaignName, reelPublisherConfig, runReelPublisher } from "../lib/reels/publisher";
import { MetaApiError } from "../lib/meta/client";

const ROOT = "Animados";
const folder = (name: string) => ({ name, path: `${ROOT}/${name}`, isDir: true, size: 0 });
const file = (dir: string, name: string, size = 1000) => ({ name, path: `${ROOT}/${dir}/${name}`, isDir: false, size });

// 12:30 in Montevideo (UTC-3), inside the 11-21 window.
const NOW = new Date("2026-11-06T15:30:00Z");
const sleep = vi.fn(async () => {});
const MP4 = new TextEncoder().encode("mp4").buffer;

let queue: Record<string, ReturnType<typeof file>[]>;
let texts: Record<string, string>;

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  redis.kv.clear();
  redis.hashes.clear();
  process.env.REEL_PUBLISH_ENABLED = "true";
  delete process.env.NTFY_TOPIC;
  delete process.env.REEL_START_DAY;
  delete process.env.REEL_EVERY_DAYS;
  // Due already.
  redis.kv.set("reel:next", "2026-11-06T15:00:00.000Z");

  queue = {
    "Z - 0 Viejo": [file("Z - 0 Viejo", "viejo.mp4")],
    "10 CLAUDE": [file("10 CLAUDE", "CLAUDE_animado.mp4")],
    "2 LEGAL": [file("2 LEGAL", "LEGAL_animado.mp4"), file("2 LEGAL", "caption.txt"), file("2 LEGAL", "reel.json")],
  };
  texts = {
    "2 LEGAL/caption.txt": "Comentá LEGAL\n",
    "2 LEGAL/reel.json": '{"campana": "Legal checklist", "portada_ms": 1300}',
    "10 CLAUDE/caption.txt": "Comentá CLAUDE",
  };
  cloud.list.mockImplementation(async (dir: string) =>
    dir === ROOT
      ? Object.keys(queue).map(folder).concat([folder("_borradores")])
      : queue[dir.slice(ROOT.length + 1)] ?? []
  );
  cloud.readText.mockImplementation(async (path: string) => texts[path.slice(ROOT.length + 1)] ?? null);
  cloud.download.mockResolvedValue(MP4);
  cloud.rename.mockImplementation(async (_path: string, name: string) => `${ROOT}/${name}`);

  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "acc1",
    workspaceId: "ws1",
    instagramId: "ig1",
    accessToken: "encrypted",
  });
  mockPrisma.automation.findFirst.mockImplementation(async ({ where }: { where: { postId?: string } }) =>
    where.postId
      ? null
      : { id: "base1", name: "Legal checklist", trackedLinks: [{ destinationUrl: "https://recursos.example/legal/" }] }
  );
  mockPrisma.automation.findMany.mockResolvedValue([{ name: "Legal checklist" }, { name: "[TRIAL1] Legal checklist" }]);
  mockDuplicate.mockReset().mockResolvedValue({ id: "copy1" });
  mockFetch.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", mockFetch);

  mockUnstage.mockReset().mockResolvedValue(undefined);
  mockStage.mockReset().mockResolvedValue({ url: "https://files.example/1.mp4", remove: mockUnstage });
  mockMeta.createReelContainer.mockReset().mockResolvedValue({ id: "c1" });
  mockMeta.getMediaContainerStatus
    .mockReset()
    .mockResolvedValueOnce({ status_code: "IN_PROGRESS" })
    .mockResolvedValue({ status_code: "FINISHED" });
  mockMeta.publishMediaContainer.mockReset().mockResolvedValue("m1");
  mockMeta.getMediaPermalink.mockResolvedValue("https://www.instagram.com/reel/abc/");
  mockMeta.getUserMedia.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
});

describe("reel queue", () => {
  it("numbers the campaign copies", () => {
    expect(reelCampaignName(["Costo"], "Costo")).toBe("[ANIM] Costo");
    expect(reelCampaignName(["[ANIM] Costo"], "Costo")).toBe("[ANIM2] Costo");
    expect(reelCampaignName(["[ANIM] Costo", "[ANIM2] Costo", "[ANIM] Otro"], "Costo")).toBe("[ANIM3] Costo");
  });

  it("publishes one a day by default, in the day window", () => {
    const config = reelPublisherConfig({} as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ enabled: false, everyDays: 1, startHour: 11, endHour: 21, folder: "Animados" });
  });

  it("does nothing while switched off", async () => {
    process.env.REEL_PUBLISH_ENABLED = "false";
    await expect(runReelPublisher({ now: NOW, sleep })).resolves.toEqual({ status: "disabled" });
    expect(cloud.list).not.toHaveBeenCalled();
  });

  it("waits until the next one is due", async () => {
    redis.kv.set("reel:next", "2026-11-06T20:00:00.000Z");
    await expect(runReelPublisher({ now: NOW, sleep })).resolves.toEqual({ status: "waiting" });
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
  });

  it("plans the first one for the start day", async () => {
    redis.kv.delete("reel:next");
    process.env.REEL_START_DAY = "2026-11-08";
    await expect(runReelPublisher({ now: NOW, sleep })).resolves.toEqual({ status: "waiting" });
    expect(redis.kv.get("reel:next")!.slice(0, 10)).toBe("2026-11-08");
  });

  it("holds back right after any post on the account", async () => {
    mockMeta.getUserMedia.mockResolvedValue([{ timestamp: "2026-11-06T15:00:00Z" }]);
    await expect(runReelPublisher({ now: NOW, sleep })).resolves.toEqual({ status: "waiting" });
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
  });
});

describe("publishing", () => {
  it("goes to the feed, not as a trial, in name order, with the cover asked for", async () => {
    const result = await runReelPublisher({ now: NOW, sleep });

    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/2 LEGAL`, campaign: "[ANIM] Legal checklist" });
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith("token", "ig1", {
      videoUrl: "https://files.example/1.mp4",
      caption: "Comentá LEGAL",
      thumbOffsetMs: 1300,
      shareToFeed: true,
    });
    expect(mockMeta.createReelContainer.mock.calls[0][2]).not.toHaveProperty("trial");
    expect(mockMeta.publishMediaContainer).toHaveBeenCalledWith("token", "ig1", "c1");
    expect(mockUnstage).toHaveBeenCalled();
  });

  it("copies the base campaign and binds the copy to the new post", async () => {
    await runReelPublisher({ now: NOW, sleep });

    expect(mockDuplicate).toHaveBeenCalledWith({ automationId: "base1", workspaceId: "ws1" });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "copy1" },
      data: {
        name: "[ANIM] Legal checklist",
        isActive: true,
        postId: "m1",
        postUrl: "https://www.instagram.com/reel/abc/",
        pendingNextReel: false,
        matchAnyPost: false,
      },
    });
  });

  it("marks the folder done and plans the next one for tomorrow", async () => {
    await runReelPublisher({ now: NOW, sleep });

    expect(cloud.rename).toHaveBeenCalledWith(`${ROOT}/2 LEGAL`, "Z - 2 LEGAL");
    expect(redis.kv.get("reel:next")!.slice(0, 10)).toBe("2026-11-07");
    expect(redis.kv.has("reel:inflight")).toBe(false);
  });

  it("never publishes the same folder twice", async () => {
    redis.hashes.set("reel:published", new Map([[`${ROOT}/2 LEGAL`, "m0"]]));
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/10 CLAUDE`, campaign: null });
    expect(mockDuplicate).not.toHaveBeenCalled();
  });

  it("skips a reel whose resource page is down and sends the next", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/10 CLAUDE` });
  });

  it("skips a reel whose campaign does not exist", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/10 CLAUDE` });
  });

  it("skips a folder with no caption", async () => {
    delete texts["2 LEGAL/caption.txt"];
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/10 CLAUDE` });
  });

  it("only reports on a dry run", async () => {
    const result = await runReelPublisher({ now: NOW, sleep, dryRun: true, force: true });
    expect(result).toMatchObject({ status: "dry-run", folder: `${ROOT}/2 LEGAL`, video: "LEGAL_animado.mp4", campaign: "Legal checklist" });
    expect(mockStage).not.toHaveBeenCalled();
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
  });

  it("takes a video Instagram refused out of the queue", async () => {
    mockMeta.getMediaContainerStatus.mockReset().mockResolvedValue({ status_code: "ERROR", status: "bad" });
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "failed", folder: `${ROOT}/2 LEGAL` });
    expect(cloud.rename).toHaveBeenCalledWith(`${ROOT}/2 LEGAL`, "_ERROR 2 LEGAL");
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
    expect(mockUnstage).toHaveBeenCalled();
  });

  it("leaves the folder in place when Meta refuses the publish", async () => {
    mockMeta.publishMediaContainer.mockRejectedValue(new MetaApiError(400, undefined, undefined, "no"));
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "failed" });
    expect(cloud.rename).not.toHaveBeenCalled();
    expect(redis.kv.has("reel:inflight")).toBe(false);
  });
});

describe("a run cut half way", () => {
  const state = {
    folderPath: `${ROOT}/2 LEGAL`,
    folderName: "2 LEGAL",
    campaignId: "base1",
    campaignName: "Legal checklist",
    workspaceId: "ws1",
    instagramAccountId: "acc1",
  };

  it("finishes the bookkeeping without publishing again", async () => {
    redis.kv.set("reel:inflight", JSON.stringify({ ...state, containerId: "c9", mediaId: "m9" }));
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/2 LEGAL` });
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "copy1" } }));
  });

  it("does not copy the campaign twice", async () => {
    redis.kv.set("reel:inflight", JSON.stringify({ ...state, mediaId: "m9" }));
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "copy0", name: "[ANIM] Legal checklist" });
    await runReelPublisher({ now: NOW, sleep });
    expect(mockDuplicate).not.toHaveBeenCalled();
  });

  it("parks the folder when nobody knows whether it went out", async () => {
    redis.kv.set("reel:inflight", JSON.stringify({ ...state, containerId: "c9" }));
    const result = await runReelPublisher({ now: NOW, sleep });
    expect(result).toEqual({ status: "review", folder: `${ROOT}/2 LEGAL` });
    expect(cloud.rename).toHaveBeenCalledWith(`${ROOT}/2 LEGAL`, "_REVISAR 2 LEGAL");
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
  });
});

describe("the real client", () => {
  it("asks for the feed and sends no trial params", async () => {
    const { createReelContainer } = await vi.importActual<typeof import("../lib/meta/client")>("../lib/meta/client");
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "c1" }), text: async () => '{"id":"c1"}' });
    await createReelContainer("token", "ig1", { videoUrl: "https://x/1.mp4", caption: "hola", shareToFeed: true });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ media_type: "REELS", video_url: "https://x/1.mp4", share_to_feed: true });
    expect(body).not.toHaveProperty("trial_params");
  });
});
