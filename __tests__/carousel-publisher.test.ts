import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockMeta, mockJpeg, mockStage, mockUnstage, mockFetch, redis, cloud } = vi.hoisted(() => {
  const kv = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  return {
    mockPrisma: {
      automation: { findFirst: vi.fn(), update: vi.fn() },
      instagramAccount: { findFirst: vi.fn() },
    },
    mockMeta: {
      createCarouselItemContainer: vi.fn(),
      createCarouselContainer: vi.fn(),
      getMediaContainerStatus: vi.fn(),
      publishMediaContainer: vi.fn(),
      getMediaPermalink: vi.fn(),
      getUserMedia: vi.fn(),
    },
    mockJpeg: vi.fn(),
    mockStage: vi.fn(),
    mockUnstage: vi.fn(),
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
vi.mock("@/lib/carousels/jpeg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/carousels/jpeg")>()),
  toJpeg: mockJpeg,
}));
vi.mock("@/lib/trials/staging", () => ({ stageFile: mockStage }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  ...mockMeta,
}));
vi.mock("@/lib/trials/opencloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trials/opencloud")>()),
  OpenCloudClient: { fromEnv: () => cloud },
}));

import { addDays, isDoneFolder, runCarouselPublisher } from "../lib/carousels/publisher";
import { jpegArgs } from "../lib/carousels/jpeg";
import { MetaApiError } from "../lib/meta/client";

const ROOT = "Carruseles";
const folder = (name: string) => ({ name, path: `${ROOT}/${name}`, isDir: true, size: 0 });
const file = (dir: string, name: string, size = 1000) => ({ name, path: `${ROOT}/${dir}/${name}`, isDir: false, size });

// 12:30 in Montevideo (UTC-3), inside the 11-21 window.
const NOW = new Date("2026-10-20T15:30:00Z");
const sleep = vi.fn(async () => {});
const PNG = new TextEncoder().encode("png").buffer;
const JPEG = new TextEncoder().encode("jpeg").buffer;
const LINK = "https://recursos.example/contenido/";

let queue: Record<string, ReturnType<typeof file>[]>;
let texts: Record<string, string>;

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  redis.kv.clear();
  redis.hashes.clear();
  process.env.CAROUSEL_PUBLISH_ENABLED = "true";
  delete process.env.NTFY_TOPIC;
  delete process.env.CAROUSEL_START_DAY;
  delete process.env.CAROUSEL_EVERY_DAYS;
  // Due already.
  redis.kv.set("carousel:next", "2026-10-20T15:00:00.000Z");

  queue = {
    "Z - Hype": [file("Z - Hype", "01.png")],
    Captcha: [file("Captcha", "01.png"), file("Captcha", "02.png")],
    Contenido: [file("Contenido", "10.png"), file("Contenido", "02.png"), file("Contenido", "01.png"), file("Contenido", "notas.pdf")],
  };
  texts = {
    "Contenido/caption.txt": "Comenta CONTENIDO\n",
    "Contenido/carrusel.json": '{"campana": "Contenido"}',
    "Captcha/caption.txt": "Guárdalo",
  };
  cloud.list.mockImplementation(async (dir: string) =>
    dir === ROOT
      ? Object.keys(queue).map(folder).concat([folder("_borradores")])
      : queue[dir.slice(ROOT.length + 1)] ?? []
  );
  cloud.readText.mockImplementation(async (path: string) => texts[path.slice(ROOT.length + 1)] ?? null);
  cloud.download.mockResolvedValue(PNG);
  cloud.rename.mockImplementation(async (path: string, name: string) => `${ROOT}/${name}`);

  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "acc1",
    workspaceId: "ws1",
    instagramId: "ig1",
    accessToken: "encrypted",
  });
  mockPrisma.automation.findFirst.mockResolvedValue({
    id: "camp1",
    name: "Contenido",
    postId: null,
    trackedLinks: [{ destinationUrl: LINK }],
  });
  mockFetch.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", mockFetch);

  mockJpeg.mockReset().mockResolvedValue(JPEG);
  mockUnstage.mockReset().mockResolvedValue(undefined);
  let n = 0;
  mockStage.mockReset().mockImplementation(async () => ({ url: `https://files.example/${++n}.jpg`, remove: mockUnstage }));
  let item = 0;
  mockMeta.createCarouselItemContainer.mockReset().mockImplementation(async () => ({ id: `item${++item}` }));
  mockMeta.createCarouselContainer.mockReset().mockResolvedValue({ id: "c1" });
  mockMeta.getMediaContainerStatus
    .mockReset()
    .mockResolvedValueOnce({ status_code: "IN_PROGRESS" })
    .mockResolvedValue({ status_code: "FINISHED" });
  mockMeta.publishMediaContainer.mockReset().mockResolvedValue("m1");
  mockMeta.getMediaPermalink.mockResolvedValue("https://www.instagram.com/p/abc/");
  mockMeta.getUserMedia.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
});

describe("carousel queue", () => {
  it("knows the owner's done mark", () => {
    expect(isDoneFolder("Z - Hype")).toBe(true);
    expect(isDoneFolder("Z Hype")).toBe(true);
    expect(isDoneFolder("Z-Hype")).toBe(true);
    expect(isDoneFolder("Zapier")).toBe(false);
    expect(isDoneFolder("Diseno")).toBe(false);
  });

  it("counts days across months", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });

  it("converts to a near-lossless JPEG", () => {
    expect(jpegArgs("in.png", "out.jpg")).toEqual(
      expect.arrayContaining(["-i", "in.png", "-q:v", "2", "out.jpg"])
    );
  });
});

describe("runCarouselPublisher", () => {
  it("does nothing unless switched on", async () => {
    delete process.env.CAROUSEL_PUBLISH_ENABLED;
    expect(await runCarouselPublisher({ now: NOW, sleep })).toEqual({ status: "disabled" });
    expect(cloud.list).not.toHaveBeenCalled();
  });

  it("waits until the next one is due", async () => {
    redis.kv.set("carousel:next", "2026-10-21T15:00:00.000Z");
    expect(await runCarouselPublisher({ now: NOW, sleep })).toEqual({ status: "waiting" });
    expect(cloud.list).not.toHaveBeenCalled();
  });

  it("plans the first one on the start day when there is no schedule yet", async () => {
    redis.kv.delete("carousel:next");
    process.env.CAROUSEL_START_DAY = "2026-10-23";
    expect(await runCarouselPublisher({ now: NOW, sleep })).toEqual({ status: "waiting" });
    expect(redis.kv.get("carousel:next")!.slice(0, 10)).toBe("2026-10-23");
  });

  it("holds back when the account posted less than 90 minutes ago", async () => {
    mockMeta.getUserMedia.mockResolvedValue([{ id: "r", media_type: "VIDEO", timestamp: "2026-10-20T15:00:00+0000" }]);
    expect(await runCarouselPublisher({ now: NOW, sleep })).toEqual({ status: "waiting" });
    expect(mockMeta.createCarouselContainer).not.toHaveBeenCalled();
  });

  it("publishes the first folder by name as JPEGs, switches its campaign on and plans the next in 3 days", async () => {
    delete texts["Captcha/caption.txt"]; // Captcha is not ready: Contenido goes
    const result = await runCarouselPublisher({ now: NOW, sleep });

    expect(result).toMatchObject({
      status: "published",
      folder: `${ROOT}/Contenido`,
      campaign: "Contenido",
      permalink: "https://www.instagram.com/p/abc/",
    });
    expect(cloud.download.mock.calls.map(([path]) => path)).toEqual([
      `${ROOT}/Contenido/01.png`,
      `${ROOT}/Contenido/02.png`,
      `${ROOT}/Contenido/10.png`,
    ]);
    expect(mockJpeg).toHaveBeenCalledWith(PNG, "01.png");
    expect(mockStage).toHaveBeenCalledWith(JPEG, { extension: "jpg", contentType: "image/jpeg" });
    expect(mockMeta.createCarouselItemContainer).toHaveBeenNthCalledWith(1, "token", "ig1", "https://files.example/1.jpg");
    expect(mockMeta.createCarouselContainer).toHaveBeenCalledWith("token", "ig1", {
      children: ["item1", "item2", "item3"],
      caption: "Comenta CONTENIDO",
    });
    expect(mockMeta.publishMediaContainer).toHaveBeenCalledWith("token", "ig1", "c1");
    expect(mockUnstage).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenCalledWith(LINK, expect.anything());
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "camp1" },
      data: {
        isActive: true,
        postId: "m1",
        postUrl: "https://www.instagram.com/p/abc/",
        pendingNextReel: false,
        matchAnyPost: false,
      },
    });
    expect(cloud.rename).toHaveBeenCalledWith(`${ROOT}/Contenido`, "Z - Contenido");
    expect(redis.kv.get("carousel:next")!.slice(0, 10)).toBe("2026-10-23");
    expect(redis.kv.has("carousel:inflight")).toBe(false);
    expect(redis.kv.has("carousel:lock")).toBe(false);
  });

  it("publishes a carousel without carrusel.json on its own, with no campaign", async () => {
    const result = await runCarouselPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/Captcha`, campaign: null });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
    expect(cloud.rename).toHaveBeenCalledWith(`${ROOT}/Captcha`, "Z - Captcha");
  });

  it("skips a carousel whose resource page is not up, and the next one goes", async () => {
    queue = { Contenido: queue.Contenido, Diseno: [file("Diseno", "01.png"), file("Diseno", "02.png")] };
    texts["Diseno/caption.txt"] = "Comenta DISEÑO";
    mockFetch.mockImplementation(async (url: string) => ({ ok: url !== LINK }));
    const result = await runCarouselPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/Diseno` });
  });

  it("skips a campaign that already has a post", async () => {
    queue = { Contenido: queue.Contenido };
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "camp1", name: "Contenido", postId: "old", trackedLinks: [] });
    expect(await runCarouselPublisher({ now: NOW, sleep })).toEqual({ status: "empty" });
    expect(mockMeta.createCarouselContainer).not.toHaveBeenCalled();
  });

  it("skips a folder with more slides than the API takes", async () => {
    queue = { Largo: Array.from({ length: 11 }, (_, i) => file("Largo", `${i + 1}.png`)) };
    texts["Largo/caption.txt"] = "texto";
    expect(await runCarouselPublisher({ now: NOW, sleep })).toEqual({ status: "empty" });
  });

  it("publishes nothing and retries later when Instagram cannot process it", async () => {
    mockMeta.getMediaContainerStatus.mockReset().mockResolvedValue({ status_code: "ERROR", status: "bad image" });
    const result = await runCarouselPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "failed", folder: `${ROOT}/Captcha` });
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
    expect(mockUnstage).toHaveBeenCalledTimes(2);
    expect(cloud.rename).not.toHaveBeenCalled();
    expect(redis.kv.get("carousel:next")).toBe("2026-10-20T15:00:00.000Z");
  });

  it("leaves the folder for the next tick when Meta refuses the publish", async () => {
    mockMeta.publishMediaContainer.mockRejectedValue(new MetaApiError(9, undefined, undefined, "limit reached"));
    const result = await runCarouselPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "failed" });
    expect(redis.kv.has("carousel:inflight")).toBe(false);
  });

  it("finishes the bookkeeping of a carousel that went out before a crash, without publishing again", async () => {
    redis.kv.set("carousel:inflight", JSON.stringify({
      folderPath: `${ROOT}/Contenido`,
      folderName: "Contenido",
      campaignId: "camp1",
      campaignName: "Contenido",
      containerId: "c1",
      mediaId: "m1",
    }));
    const result = await runCarouselPublisher({ now: NOW, sleep });
    expect(result).toMatchObject({ status: "published", folder: `${ROOT}/Contenido` });
    expect(mockMeta.createCarouselContainer).not.toHaveBeenCalled();
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "camp1" } }));
    expect(cloud.rename).toHaveBeenCalledWith(`${ROOT}/Contenido`, "Z - Contenido");
  });

  it("parks the folder for review when a run died mid-publish", async () => {
    redis.kv.set("carousel:inflight", JSON.stringify({
      folderPath: `${ROOT}/Captcha`,
      folderName: "Captcha",
      campaignId: null,
      campaignName: null,
      containerId: "c1",
    }));
    expect(await runCarouselPublisher({ now: NOW, sleep })).toEqual({ status: "review", folder: `${ROOT}/Captcha` });
    expect(cloud.rename).toHaveBeenCalledWith(`${ROOT}/Captcha`, "_REVISAR Captcha");
    expect(mockMeta.publishMediaContainer).not.toHaveBeenCalled();
  });

  it("shows what would go out on a dry run, even before it is due", async () => {
    redis.kv.set("carousel:next", "2026-10-23T15:00:00.000Z");
    const result = await runCarouselPublisher({ dryRun: true, now: NOW, sleep });
    expect(result).toEqual({
      status: "dry-run",
      folder: `${ROOT}/Captcha`,
      images: ["01.png", "02.png"],
      campaign: null,
      caption: "Guárdalo",
      next: "2026-10-23T15:00:00.000Z",
    });
    expect(mockMeta.createCarouselContainer).not.toHaveBeenCalled();
  });
});
