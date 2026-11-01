import { BROWSER_HEADERS } from "./embedPage.js";

export type PathfinderOperation = "fetchPlaylist" | "searchPlaylists";

export const KNOWN_QUERY_HASHES: Readonly<Record<PathfinderOperation, string>> = {
  fetchPlaylist: "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0",
  searchPlaylists: "d520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1",
};

const WEB_PLAYER_URL = "https://open.spotify.com/";
const ENTRY_SCRIPT_PATTERN = /src="(https:\/\/open\.spotifycdn\.com\/[^"]+\.js)"/g;
const CHILD_SCRIPT_PATTERN = /"([\w.~-]+\.[a-f0-9]{8,}\.js)"/g;
const CHUNK_MAP_PATTERN =
  /\(\{([^{}]*)\}\)\[\w\]\|\|\w\)\+"\."\+\(?\{([^{}]*)\}\)?\[\w\]\+"\.js"/;
const CHUNK_ENTRY_PATTERN = /(\d+):"([^"]+)"/g;
const MAX_SCRIPTS = 80;
const REDISCOVERY_COOLDOWN_MS = 6 * 3_600_000;

export function findHashInSource(source: string, operation: string): string | undefined {
  const exact = new RegExp(`"${operation}"\\s*,\\s*"query"\\s*,\\s*"([a-f0-9]{64})"`).exec(source);
  if (exact?.[1]) {
    return exact[1];
  }
  const forward = new RegExp(`"${operation}"[\\s\\S]{0,300}?([a-f0-9]{64})`).exec(source);
  const backward = new RegExp(`([a-f0-9]{64})[\\s\\S]{0,300}?"${operation}"`).exec(source);
  return forward?.[1] ?? backward?.[1];
}

export function lazyChunkUrls(source: string, scriptUrl: string, hint: string): string[] {
  const match = CHUNK_MAP_PATTERN.exec(source);
  if (!match) {
    return [];
  }
  const names = new Map([...(match[1] ?? "").matchAll(CHUNK_ENTRY_PATTERN)].map((m) => [m[1], m[2]]));
  const base = scriptUrl.slice(0, scriptUrl.lastIndexOf("/") + 1);
  const urls = [...(match[2] ?? "").matchAll(CHUNK_ENTRY_PATTERN)].map((m) => {
    const name = names.get(m[1]) ?? m[1];
    return { url: `${base}${name}.${m[2]}.js`, preferred: (name ?? "").includes(hint) };
  });
  return [...urls.filter((u) => u.preferred), ...urls.filter((u) => !u.preferred)].map((u) => u.url);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, signal });
    return response.ok ? await response.text() : undefined;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return undefined;
  }
}

export async function discoverQueryHash(
  operation: PathfinderOperation,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const html = await fetchText(WEB_PLAYER_URL, signal);
  if (html === undefined) {
    return undefined;
  }
  const hint = operation.startsWith("search") ? "search" : "playlist";
  const queue = [...html.matchAll(ENTRY_SCRIPT_PATTERN)].map((m) => m[1] as string);
  const seen = new Set(queue);
  let scanned = 0;

  while (queue.length > 0 && scanned < MAX_SCRIPTS) {
    const url = queue.shift() as string;
    scanned += 1;
    const source = await fetchText(url, signal);
    if (source === undefined) {
      continue;
    }
    const hash = findHashInSource(source, operation);
    if (hash !== undefined) {
      return hash;
    }
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    const children = [
      ...lazyChunkUrls(source, url, hint),
      ...[...source.matchAll(CHILD_SCRIPT_PATTERN)].map((m) => base + m[1]),
    ];
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return undefined;
}

export class QueryHashProvider {
  private readonly hashes = new Map<PathfinderOperation, string>();
  private readonly lastDiscovery = new Map<PathfinderOperation, number>();

  get(operation: PathfinderOperation): string {
    return this.hashes.get(operation) ?? KNOWN_QUERY_HASHES[operation];
  }

  async refresh(operation: PathfinderOperation, signal?: AbortSignal): Promise<string | undefined> {
    const last = this.lastDiscovery.get(operation);
    if (last !== undefined && Date.now() - last < REDISCOVERY_COOLDOWN_MS) {
      return undefined;
    }
    this.lastDiscovery.set(operation, Date.now());
    const found = await discoverQueryHash(operation, signal);
    if (found === undefined || found === this.get(operation)) {
      return undefined;
    }
    this.hashes.set(operation, found);
    return found;
  }
}
