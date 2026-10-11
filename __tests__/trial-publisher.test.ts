import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockMeta, mockDuplicate, mockSpeed, redis, cloud } = vi.hoisted(() => {
  const kv = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  return {
    mockPrisma: {
      automation: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      instagramAccount: { findFirst: vi.fn() },
    },
    mockMeta: {
      createReelUploadContainer: vi.fn(),
      uploadReelVideo: vi.fn(),
      getMediaContainerStatus: vi.fn(),
      publishMediaContainer: vi.fn(),
      getMediaPermalink: vi.fn(),
    },
    mockDuplicate: vi.fn(),
    mockSpeed: vi.fn(),
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
      moveInto: vi.fn(),
      rename: vi.fn(),
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "token" }));
vi.mock("@/lib/campaigns/duplicate", () => ({ duplicateCampaign: mockDuplicate }));
vi.mock("@/lib/trials/speed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trials/speed")>()),
  changeSpeed: mockSpeed,
}));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  ...mockMeta,
}));
vi.mock("@/lib/trials/opencloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trials/opencloud")>()),
  OpenCloudClient: { fromEnv: () => cloud },
}));

import { nextTrialNumber, parseFolderName, planDaySlots, runTrialPublisher } from "../lib/trials/publisher";
import { parsePropfind } from "../lib/trials/opencloud";
import { parseSpeed, speedArgs } from "../lib/trials/speed";
import { MetaApiError } from "../lib/meta/client";

const DIR = "Reels/Trial/Costo";
const folder = (name: string) => ({ name, path: `Reels/Trial/${name}`, isDir: true, size: 0 });
const file = (name: string, size = 1000) => ({ name, path: `${DIR}/${name}`, isDir: false, size });

// 12:30 in Montevideo (UTC-3), inside the 11-21 window.
const NOW = new Date("2026-10-08T15:30:00Z");
const sleep = vi.fn(async () => {});
const VIDEO = new TextEncoder().encode("video").buffer;

function seedSlots(slots: { at: string; done: boolean }[]) {
  redis.kv.set("trial:slots:2026-10-08", JSON.stringify(slots));
}
const slots = () => JSON.parse(redis.kv.get("trial:slots:2026-10-08")!);

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  redis.kv.clear();
  redis.hashes.clear();
  process.env.TRIAL_PUBLISH_ENABLED = "true";
  delete process.env.NTFY_TOPIC;
  delete process.env.TRIAL_GRADUATION;

  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "acc1",
    workspaceId: "ws1",
    instagramId: "ig1",
    accessToken: "encrypted",
  });
  mockPrisma.automation.findFirst.mockImplementation(async ({ where }) =>
    where.postId ? null : { id: "base", name: "Costo", isActive: true }
  );
  mockPrisma.automation.findMany.mockResolvedValue([
    { name: "Costo" },
    { name: "[TRIAL] Costo" },
    { name: "[TRAIL3] Costo" },
    { name: "Jarvis" },
  ]);
  mockDuplicate.mockResolvedValue({ id: "copy" });

  cloud.list.mockImplementation(async (dir: string) =>
    dir === "Reels/Trial"
      ? [folder("Costo")]
      : [file("texto.txt", 20), file("normal_10.mp4"), file("normal_2.mp4"), { ...folder("publicados"), path: `${DIR}/publicados` }]
  );
  cloud.readText.mockImplementation(async (path: string) =>
    path.endsWith("trial.json") ? null : "Comentá COSTO y te lo paso\n"
  );
  cloud.download.mockResolvedValue(VIDEO);
  cloud.rename.mockImplementation(async (path: string, name: string) => `${path.split("/").slice(0, -1).join("/")}/${name}`);
  mockSpeed.mockReset();
  delete process.env.TRIAL_SKIP_FOLDERS;
  cloud.moveInto.mockImplementation(async (path: string, dir: string) => `${dir}/${path.split("/").pop()}`);

  mockMeta.createReelUploadContainer.mockResolvedValue({ id: "c1", uri: "https://rupload.example/c1" });
  mockMeta.uploadReelVideo.mockResolvedValue(undefined);
  mockMeta.getMediaContainerStatus
    .mockReset()
    .mockResolvedValueOnce({ status_code: "IN_PROGRESS" })
    .mockResolvedValue({ status_code: "FINISHED" });
  mockMeta.publishMediaContainer.mockResolvedValue("m1");
  mockMeta.getMediaPermalink.mockResolvedValue("https://www.instagram.com/reel/abc/");
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("trial schedule", () => {
  it("spreads the posts over the window in the local time zone", () => {
    const config = { perDay: 2, startHour: 11, endHour: 21, timeZone: "America/Montevideo" };
    // 11:30 and 16:30 in Montevideo.
    expect(planDaySlots("2026-10-08", config, () => 0)).toEqual([
      "2026-10-08T14:30:00.000Z",
      "2026-10-08T19:30:00.000Z",
    ]);
    // 15:30 and 20:30: the first post never lands in the second share.
    expect(planDaySlots("2026-10-08", config, () => 1)).toEqual([
      "2026-10-08T18:30:00.000Z",
      "2026-10-08T23:30:00.000Z",
    ]);
  });

  it("numbers trials after the ones made by hand, typos included", () => {
    const names = ["Costo", "[TRIAL] Costo", "[TRIAL2] Costo", "[TRAIL5] Costo copy", "[TRIAL9] Jarvis"];
    expect(nextTrialNumber(names, "Costo")).toBe(6);
    expect(nextTrialNumber(names, "Avatar")).toBe(1);
    expect(nextTrialNumber(["[TRIAL] Costo"], "costo")).toBe(2);
  });
});

describe("runTrialPublisher", () => {
  it("does nothing unless switched on", async () => {
    delete process.env.TRIAL_PUBLISH_ENABLED;
    expect(await runTrialPublisher({ now: NOW, sleep })).toEqual({ status: "disabled" });
    expect(cloud.list).not.toHaveBeenCalled();
  });

  it("waits until a slot is due", async () => {
    seedSlots([{ at: "2026-10-08T17:00:00.000Z", done: false }]);
    expect(await runTrialPublisher({ now: NOW, sleep })).toEqual({ status: "waiting" });
    expect(cloud.list).not.toHaveBeenCalled();
  });

  it("waits outside the daily window", async () => {
    seedSlots([{ at: "2026-10-08T10:00:00.000Z", done: false }]);
    // 08:00 in Montevideo.
    const early = new Date("2026-10-08T11:00:00Z");
    expect(await runTrialPublisher({ now: early, sleep })).toEqual({ status: "waiting" });
  });

  it("publishes the next variant as a trial and gives it its own campaign", async () => {
    seedSlots([
      { at: "2026-10-08T15:00:00.000Z", done: false },
      { at: "2026-10-08T21:00:00.000Z", done: false },
    ]);

    const result = await runTrialPublisher({ now: NOW, sleep });

    expect(result).toEqual({
      status: "published",
      file: `${DIR}/normal_2.mp4`,
      campaign: "[TRIAL4] Costo",
      permalink: "https://www.instagram.com/reel/abc/",
    });
    expect(cloud.download).toHaveBeenCalledWith(`${DIR}/normal_2.mp4`);
    expect(mockMeta.createReelUploadContainer).toHaveBeenCalledWith("token", "ig1", {
      caption: "Comentá COSTO y te lo paso",
      thumbOffsetMs: 1000,
      trial: "MANUAL",
    });
    expect(mockMeta.uploadReelVideo).toHaveBeenCalledWith("token", "https://rupload.example/c1", VIDEO);
    expect(mockMeta.publishMediaContainer).toHaveBeenCalledWith("token", "ig1", "c1");
    expect(mockDuplicate).toHaveBeenCalledWith({ automationId: "base", workspaceId: "ws1" });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "copy" },
      data: {
        name: "[TRIAL4] Costo",
        isActive: true,
        postId: "m1",
        postUrl: "https://www.instagram.com/reel/abc/",
        pendingNextReel: false,
        matchAnyPost: false,
      },
    });
    expect(cloud.rename).toHaveBeenCalledWith(`${DIR}/normal_2.mp4`, "Znormal_2.mp4");
    expect(redis.kv.has("trial:inflight")).toBe(false);
    expect(redis.kv.has("trial:lock")).toBe(false);
    expect(slots().map((slot: { done: boolean }) => slot.done)).toEqual([true, false]);
  });

  it("lets Instagram graduate the trial when configured", async () => {
    process.env.TRIAL_GRADUATION = "SS_PERFORMANCE";
    await runTrialPublisher({ now: NOW, sleep, force: true });
    expect(mockMeta.createReelUploadContainer.mock.calls[0][2].trial).toBe("SS_PERFORMANCE");
  });

  it("keeps a gap after the last post even when the next slot is due", async () => {
    seedSlots([{ at: "2026-10-08T15:00:00.000Z", done: false }]);
    redis.kv.set("trial:last", "2026-10-08T15:00:00.000Z");
    expect(await runTrialPublisher({ now: NOW, sleep })).toEqual({ status: "waiting" });
  });

  it("parks a video Instagram cannot process and publishes nothing", async () => {
    seedSlots([{ at: "2026-10-08T15:00:00.000Z", done: false }]);
    mockMeta.getMediaContainerStatus.mockReset().mockResolvedValue({ status_code: "ERROR", status: "bad codec" });

    const result = await runTrialPublisher({ now: NOW, sleep });

    expect(result.status).toBe("failed");
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
    expect(cloud.moveInto).toHaveBeenCalledWith(`${DIR}/normal_2.mp4`, `${DIR}/error`);
    expect(redis.kv.has("trial:inflight")).toBe(false);
    expect(slots()[0].done).toBe(true);
  });

  it("leaves the file for the next slot when Meta refuses the publish", async () => {
    seedSlots([{ at: "2026-10-08T15:00:00.000Z", done: false }]);
    mockMeta.publishMediaContainer.mockRejectedValue(new MetaApiError(9007, 2207027, undefined, "not ready"));

    const result = await runTrialPublisher({ now: NOW, sleep });

    expect(result.status).toBe("failed");
    expect(cloud.moveInto).not.toHaveBeenCalled();
    expect(cloud.rename).not.toHaveBeenCalled();
    expect(mockDuplicate).not.toHaveBeenCalled();
    expect(redis.kv.has("trial:inflight")).toBe(false);
  });

  it("finishes the bookkeeping of a reel that went out before a crash, without publishing again", async () => {
    seedSlots([{ at: "2026-10-08T15:00:00.000Z", done: false }]);
    redis.kv.set(
      "trial:inflight",
      JSON.stringify({
        path: `${DIR}/normal_2.mp4`,
        size: 1000,
        folderPath: DIR,
        folderName: "Costo",
        fileName: "normal_2.mp4",
        campaignId: "base",
        baseName: "Costo",
        workspaceId: "ws1",
        instagramAccountId: "acc1",
        containerId: "c1",
        mediaId: "m1",
      })
    );

    const result = await runTrialPublisher({ now: NOW, sleep });

    expect(result).toMatchObject({ status: "published", campaign: "[TRIAL4] Costo" });
    expect(mockMeta.createReelUploadContainer).not.toHaveBeenCalled();
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
    expect(cloud.rename).toHaveBeenCalledWith(`${DIR}/normal_2.mp4`, "Znormal_2.mp4");
    expect(slots()[0].done).toBe(true);
  });

  it("parks the file for review when a run died mid-publish", async () => {
    seedSlots([{ at: "2026-10-08T15:00:00.000Z", done: false }]);
    redis.kv.set(
      "trial:inflight",
      JSON.stringify({
        path: `${DIR}/normal_2.mp4`,
        size: 1000,
        folderPath: DIR,
        folderName: "Costo",
        fileName: "normal_2.mp4",
        containerId: "c1",
      })
    );

    const result = await runTrialPublisher({ now: NOW, sleep });

    expect(result).toEqual({ status: "review", file: `${DIR}/normal_2.mp4` });
    expect(cloud.moveInto).toHaveBeenCalledWith(`${DIR}/normal_2.mp4`, `${DIR}/revisar`);
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
  });

  it("never republishes a file whose rename failed", async () => {
    redis.hashes.set("trial:published", new Map([[`${DIR}/normal_2.mp4|1000`, "m0"]]));
    await runTrialPublisher({ now: NOW, sleep, force: true });
    expect(cloud.download).toHaveBeenCalledWith(`${DIR}/normal_10.mp4`);
  });

  it("skips a folder whose campaign is paused", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "base", name: "Costo", isActive: false });
    expect(await runTrialPublisher({ now: NOW, sleep, force: true })).toEqual({ status: "empty" });
    expect(mockMeta.createReelUploadContainer).not.toHaveBeenCalled();
  });

  it("shows what would go out on a dry run", async () => {
    const result = await runTrialPublisher({ now: NOW, sleep, force: true, dryRun: true });
    expect(result).toMatchObject({
      status: "dry-run",
      file: `${DIR}/normal_2.mp4`,
      campaign: "Costo",
      trialName: "[TRIAL4] Costo",
    });
    expect(cloud.download).not.toHaveBeenCalled();
    expect(mockMeta.createReelUploadContainer).not.toHaveBeenCalled();
  });
});

describe("the owner's TRIAL layout", () => {
  const ROOT = "TRIAL";
  const FOLDER = `${ROOT}/[TRIAL] JARVIS`;
  const vid = (name: string, dir = FOLDER) => ({ name, path: `${dir}/${name}`, isDir: false, size: 1000 });
  const dir = (name: string) => ({ name, path: `${ROOT}/${name}`, isDir: true, size: 0 });

  function layout(folders: ReturnType<typeof dir>[], files: Record<string, ReturnType<typeof vid>[]>) {
    process.env.TRIAL_FOLDER = "TRIAL";
    cloud.list.mockImplementation(async (path: string) => (path === ROOT ? folders : files[path] ?? []));
  }

  it("reads folder names", () => {
    expect(parseFolderName("Z[TRIAL] Sesión")).toEqual({ done: true, label: "Sesión" });
    expect(parseFolderName("[TRAIL] CLIENTE")).toEqual({ done: false, label: "CLIENTE" });
    expect(parseFolderName("Costo")).toEqual({ done: false, label: "Costo" });
    expect(parseFolderName("Zorro")).toEqual({ done: false, label: "Zorro" });
  });

  it("skips done folders and videos, speeds up, and uses the campaign and name from trial.json", async () => {
    layout(
      [dir("Z[TRIAL] Costo"), dir("[TRIAL] JARVIS")],
      { [FOLDER]: [vid("Znormal_01.mp4"), vid("normal_02.mp4"), vid("normal_03.mp4")] }
    );
    cloud.readText.mockImplementation(async (path: string) =>
      path.endsWith("texto.txt")
        ? 'Comentá "JARVIS" y te mando la guía'
        : '{"campana": "Jarvis2", "nombre": "Jarvis", "velocidad": "1,2x"}'
    );
    mockPrisma.automation.findFirst.mockImplementation(async ({ where }) =>
      where.postId ? null : { id: "j2", name: where.name.equals, isActive: true }
    );
    mockPrisma.automation.findMany.mockResolvedValue([{ name: "[TRIAL4] Jarvis" }, { name: "[TRIAL5] Jarvis" }]);
    const sped = new TextEncoder().encode("rapido").buffer;
    mockSpeed.mockResolvedValue(sped);

    const result = await runTrialPublisher({ now: NOW, sleep, force: true });

    expect(result).toMatchObject({ status: "published", file: `${FOLDER}/normal_02.mp4`, campaign: "[TRIAL6] Jarvis" });
    expect(mockPrisma.automation.findFirst.mock.calls[0][0].where.name.equals).toBe("Jarvis2");
    expect(mockSpeed).toHaveBeenCalledWith(VIDEO, 1.2);
    expect(mockMeta.uploadReelVideo).toHaveBeenCalledWith("token", "https://rupload.example/c1", sped);
    expect(cloud.rename).toHaveBeenCalledWith(`${FOLDER}/normal_02.mp4`, "Znormal_02.mp4");
    expect(cloud.rename).not.toHaveBeenCalledWith(FOLDER, expect.anything());
  });

  it("marks the folder with a Z when the last video goes out", async () => {
    layout([dir("[TRIAL] JARVIS")], { [FOLDER]: [vid("Znormal_01.mp4"), vid("normal_02.mp4")] });
    cloud.readText.mockImplementation(async (path: string) => (path.endsWith("texto.txt") ? "x" : null));
    // After the rename the folder has nothing left to publish.
    cloud.rename.mockImplementation(async (path: string, name: string) => {
      if (name === "Znormal_02.mp4") cloud.list.mockImplementation(async (p: string) => (p === ROOT ? [] : [vid("Znormal_01.mp4"), vid(name)]));
      return `${path}/../${name}`;
    });
    mockPrisma.automation.findFirst.mockImplementation(async ({ where }) =>
      where.postId ? null : { id: "j", name: "JARVIS", isActive: true }
    );

    await runTrialPublisher({ now: NOW, sleep, force: true });

    expect(cloud.rename).toHaveBeenCalledWith(FOLDER, "Z[TRIAL] JARVIS");
  });

  it("leaves out the folders in TRIAL_SKIP_FOLDERS", async () => {
    process.env.TRIAL_SKIP_FOLDERS = "grokbot";
    layout([dir("[TRIAL] GrokBot")], { [`${ROOT}/[TRIAL] GrokBot`]: [vid("grok_03.mp4", `${ROOT}/[TRIAL] GrokBot`)] });
    expect(await runTrialPublisher({ now: NOW, sleep, force: true })).toEqual({ status: "empty" });
    expect(cloud.download).not.toHaveBeenCalled();
  });

  it("skips a folder with a broken trial.json and publishes nothing", async () => {
    layout([dir("[TRIAL] JARVIS")], { [FOLDER]: [vid("normal_02.mp4")] });
    cloud.readText.mockImplementation(async (path: string) => (path.endsWith("texto.txt") ? "x" : '{"velocidad": 9}'));
    expect(await runTrialPublisher({ now: NOW, sleep, force: true })).toEqual({ status: "empty" });
    expect(mockMeta.createReelUploadContainer).not.toHaveBeenCalled();
  });
});

describe("speed", () => {
  it("reads factors the way the owner writes them", () => {
    expect(parseSpeed("1,2x")).toBe(1.2);
    expect(parseSpeed(1.3)).toBe(1.3);
    expect(parseSpeed("rápido")).toBeNull();
    expect(parseSpeed(3)).toBeNull();
  });

  it("speeds picture and sound by the same factor", () => {
    const args = speedArgs("in.mp4", "out.mp4", 1.2);
    expect(args).toContain("setpts=PTS/1.2");
    expect(args).toContain("atempo=1.2");
  });
});

describe("parsePropfind", () => {
  it("reads names, sizes and folders whatever the namespace prefix", () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/spaces/a%24b%21c/Reels/Trial/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/spaces/a%24b%21c/Reels/Trial/Costo%20nuevo/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop></d:propstat></d:response>
  <D:response><D:href>/dav/spaces/a%24b%21c/Reels/Trial/v%C3%ADdeo.mp4</D:href>
    <D:propstat><D:prop><D:getcontentlength>41055536</D:getcontentlength><D:resourcetype/></D:prop></D:propstat></D:response>
</d:multistatus>`;
    expect(parsePropfind(xml)).toEqual([
      { href: "/dav/spaces/a$b!c/Reels/Trial/", isDir: true, size: 0 },
      { href: "/dav/spaces/a$b!c/Reels/Trial/Costo nuevo/", isDir: true, size: 0 },
      { href: "/dav/spaces/a$b!c/Reels/Trial/vídeo.mp4", isDir: false, size: 41055536 },
    ]);
  });
});
