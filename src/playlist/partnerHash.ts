import { BROWSER_HEADERS } from "./embedPage.js";

const WEB_PLAYER_URL = "https://open.spotify.com/";
const ENTRY_SCRIPT_PATTERN = /src="(https:\/\/open\.spotifycdn\.com\/[^"]+\.js)"/g;
const CHILD_SCRIPT_PATTERN = /"([\w.-]+\.[a-f0-9]{8,}\.js)"/g;
const MAX_BUNDLES = 60;

export const PARTNER_OPERATION_NAME = "fetchPlaylist";
export const FALLBACK_PARTNER_QUERY_HASH =
  "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0";

function findHashInSource(source: string, operationName: string): string | undefined {
  const forward = new RegExp(`"${operationName}"[\\s\\S]{0,300}?([a-f0-9]{64})`);
  const backward = new RegExp(`([a-f0-9]{64})[\\s\\S]{0,300}?"${operationName}"`);
  const hit = forward.exec(source) ?? backward.exec(source);
  return hit?.[1];
}

export async function discoverPartnerQueryHash(
  operationName: string = PARTNER_OPERATION_NAME,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(WEB_PLAYER_URL, { headers: BROWSER_HEADERS, signal });
  if (!response.ok) {
    return undefined;
  }
  const html = await response.text();

  const queue = [...html.matchAll(ENTRY_SCRIPT_PATTERN)].map((match) => match[1] as string);
  const seen = new Set<string>(queue);
  let scanned = 0;

  while (queue.length > 0 && scanned < MAX_BUNDLES) {
    const url = queue.shift() as string;
    scanned += 1;

    let source: string;
    try {
      const bundle = await fetch(url, { headers: BROWSER_HEADERS, signal });
      if (!bundle.ok) {
        continue;
      }
      source = await bundle.text();
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      continue;
    }

    const hash = findHashInSource(source, operationName);
    if (hash !== undefined) {
      return hash;
    }

    const base = url.slice(0, url.lastIndexOf("/") + 1);
    for (const match of source.matchAll(CHILD_SCRIPT_PATTERN)) {
      const child = base + match[1];
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }

  return undefined;
}

export class PartnerQueryHashProvider {
  private hash: string;
  private discovered: boolean;

  constructor(configuredHash?: string) {
    this.hash = configuredHash ?? FALLBACK_PARTNER_QUERY_HASH;
    this.discovered = configuredHash !== undefined;
  }

  getHash(): string {
    return this.hash;
  }

  async refresh(signal?: AbortSignal): Promise<string | undefined> {
    if (this.discovered) {
      return undefined;
    }
    this.discovered = true;
    const found = await discoverPartnerQueryHash(PARTNER_OPERATION_NAME, signal);
    if (found === undefined || found === this.hash) {
      return undefined;
    }
    this.hash = found;
    return found;
  }
}
