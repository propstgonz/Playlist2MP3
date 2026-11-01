import { rename } from "node:fs/promises";
import { join } from "node:path";
import { readTextIfExists } from "./files.js";

export const MANIFEST_FILE = ".playlist2mp3.json";

export interface LoadedManifest {
  readonly tracks: Map<string, string>;
  readonly status: "loaded" | "missing" | "corrupt";
}

interface ManifestFile {
  readonly version: 1;
  readonly tracks: Record<string, { readonly file: string }>;
}

function parseManifest(text: string): Map<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("tracks" in parsed)) {
    return undefined;
  }
  const tracks = (parsed as { tracks: unknown }).tracks;
  if (typeof tracks !== "object" || tracks === null) {
    return undefined;
  }
  const result = new Map<string, string>();
  for (const [id, entry] of Object.entries(tracks)) {
    const file = typeof entry === "object" && entry !== null ? (entry as { file?: unknown }).file : undefined;
    if (typeof file === "string" && file !== "" && !file.includes("/") && !file.includes("\\")) {
      result.set(id, file);
    }
  }
  return result;
}

export async function loadManifest(dir: string, backupCorrupt: boolean): Promise<LoadedManifest> {
  const path = join(dir, MANIFEST_FILE);
  const text = await readTextIfExists(path);
  if (text === undefined) {
    return { tracks: new Map(), status: "missing" };
  }
  const tracks = parseManifest(text);
  if (tracks === undefined) {
    if (backupCorrupt) {
      await rename(path, join(dir, `.playlist2mp3.corrupt-${Date.now()}.json`));
    }
    return { tracks: new Map(), status: "corrupt" };
  }
  return { tracks, status: "loaded" };
}

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE);
}

export function serializeManifest(tracks: ReadonlyMap<string, string>): string {
  const sorted = [...tracks.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body: ManifestFile = {
    version: 1,
    tracks: Object.fromEntries(sorted.map(([id, file]) => [id, { file }])),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
