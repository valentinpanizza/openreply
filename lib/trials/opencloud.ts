/**
 * Minimal WebDAV client for the owner's OpenCloud, where finished trial reel
 * variants wait to be published. Paths are relative to the personal space
 * ("Reels/Trial/Costo/normal_01.mp4"). Logs in with an app password
 * (OPENCLOUD_USER + OPENCLOUD_TOKEN), the same kind the upload script uses.
 */

export interface DavEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** Parse a PROPFIND multistatus body. Namespace prefixes vary between servers. */
export function parsePropfind(xml: string): { href: string; isDir: boolean; size: number }[] {
  const entries: { href: string; isDir: boolean; size: number }[] = [];
  const responseRe = /<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/g;
  for (const match of xml.matchAll(responseRe)) {
    const body = match[1];
    const href = body.match(/<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/)?.[1];
    if (!href) continue;
    const size = Number(
      body.match(/<(?:\w+:)?getcontentlength>(\d+)<\/(?:\w+:)?getcontentlength>/)?.[1] ?? 0
    );
    const isDir = /<(?:\w+:)?collection\s*\/>/.test(body);
    entries.push({ href: decodeURIComponent(href), isDir, size });
  }
  return entries;
}

export class OpenCloudClient {
  private spaceUrl: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly token: string
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenCloudClient | null {
    const url = env.OPENCLOUD_URL?.trim();
    const user = env.OPENCLOUD_USER?.trim();
    const token = env.OPENCLOUD_TOKEN?.trim();
    if (!url || !user || !token) return null;
    return new OpenCloudClient(url.replace(/\/+$/, ""), user, token);
  }

  private async request(
    url: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const auth = Buffer.from(`${this.user}:${this.token}`).toString("base64");
    return fetch(url, {
      ...init,
      headers: { Authorization: `Basic ${auth}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5 * 60_000),
    });
  }

  private async space(): Promise<string> {
    if (this.spaceUrl) return this.spaceUrl;
    const response = await this.request(
      `${this.baseUrl}/graph/v1.0/me/drives?$filter=${encodeURIComponent("driveType eq 'personal'")}`
    );
    if (!response.ok) throw new Error(`OpenCloud: no pude entrar (HTTP ${response.status})`);
    const data = (await response.json()) as { value?: { id: string }[] };
    const id = data.value?.[0]?.id;
    if (!id) throw new Error("OpenCloud: no encontré el espacio personal");
    this.spaceUrl = `${this.baseUrl}/dav/spaces/${encodeURIComponent(id)}`;
    return this.spaceUrl;
  }

  private async url(path: string): Promise<string> {
    return `${await this.space()}/${encodePath(path)}`;
  }

  /** Direct children of a folder. A missing folder lists as empty. */
  async list(dir: string): Promise<DavEntry[]> {
    const response = await this.request(`${await this.url(dir)}/`, {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`OpenCloud: no pude listar ${dir} (HTTP ${response.status})`);
    // Hrefs are absolute paths on the server; strip the space prefix to get
    // paths like the ones callers pass in. The folder itself comes back too.
    const prefix = decodeURIComponent(new URL(await this.space()).pathname).replace(/\/+$/, "");
    const self = trimSlashes(dir);
    return parsePropfind(await response.text())
      .map((entry) => {
        const href = entry.href.startsWith("http") ? new URL(entry.href).pathname : entry.href;
        const path = trimSlashes(href.startsWith(prefix) ? href.slice(prefix.length) : href);
        return { name: path.split("/").pop() ?? "", path, isDir: entry.isDir, size: entry.size };
      })
      .filter((entry) => entry.name && entry.path !== self);
  }

  async download(path: string): Promise<ArrayBuffer> {
    const response = await this.request(await this.url(path));
    if (!response.ok) throw new Error(`OpenCloud: no pude bajar ${path} (HTTP ${response.status})`);
    return response.arrayBuffer();
  }

  /** Text file contents, or null when it does not exist. */
  async readText(path: string): Promise<string | null> {
    const response = await this.request(await this.url(path));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenCloud: no pude leer ${path} (HTTP ${response.status})`);
    return response.text();
  }

  /** Rename a file or folder in place. Never overwrites; returns the new path. */
  async rename(path: string, newName: string): Promise<string> {
    const parent = trimSlashes(path).split("/").slice(0, -1).join("/");
    const target = parent ? `${parent}/${newName}` : newName;
    const response = await this.request(await this.url(path), {
      method: "MOVE",
      headers: { Destination: await this.url(target), Overwrite: "F" },
    });
    if (!response.ok) throw new Error(`OpenCloud: no pude renombrar ${path} (HTTP ${response.status})`);
    return target;
  }

  /** Move a file into `targetDir`, creating it if needed. Never overwrites. */
  async moveInto(path: string, targetDir: string): Promise<string> {
    const created = await this.request(`${await this.url(targetDir)}/`, { method: "MKCOL" });
    // 405: the folder already exists.
    if (!created.ok && created.status !== 405) {
      throw new Error(`OpenCloud: no pude crear ${targetDir} (HTTP ${created.status})`);
    }
    const name = path.split("/").pop() ?? path;
    let target = `${targetDir}/${name}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await this.request(await this.url(path), {
        method: "MOVE",
        headers: { Destination: await this.url(target), Overwrite: "F" },
      });
      if (response.ok) return target;
      // 412: a file with that name is already there; keep both.
      if (response.status !== 412) {
        throw new Error(`OpenCloud: no pude mover ${path} (HTTP ${response.status})`);
      }
      target = `${targetDir}/${Date.now()}-${name}`;
    }
    throw new Error(`OpenCloud: no pude mover ${path}`);
  }
}
