import type { PlaylistConfig } from "../types/index.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const PLAYLIST_KEY_PATTERN = /^PLAYLIST_(\d+)_(NAME|URL|DIR)$/;

const SPOTIFY_PLAYLIST_URL_PATTERN =
  /^https:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)(?:\?.*)?$/;
const SPOTIFY_PLAYLIST_URI_PATTERN = /^spotify:playlist:([a-zA-Z0-9]+)$/;

interface RawPlaylistEntry {
  name?: string;
  url?: string;
  dir?: string;
}

export function extractSpotifyPlaylistId(url: string): string {
  const trimmed = url.trim();
  const httpMatch = SPOTIFY_PLAYLIST_URL_PATTERN.exec(trimmed);
  if (httpMatch?.[1] !== undefined) {
    return httpMatch[1];
  }
  const uriMatch = SPOTIFY_PLAYLIST_URI_PATTERN.exec(trimmed);
  if (uriMatch?.[1] !== undefined) {
    return uriMatch[1];
  }
  throw new ConfigError(
    `Invalid Spotify playlist URL: "${url}". Expected https://open.spotify.com/playlist/<id> or spotify:playlist:<id>`,
  );
}

export function parsePlaylistConfigs(
  env: NodeJS.ProcessEnv,
): readonly PlaylistConfig[] {
  const entries = new Map<string, RawPlaylistEntry>();

  for (const [key, value] of Object.entries(env)) {
    const match = PLAYLIST_KEY_PATTERN.exec(key);
    if (!match || value === undefined || value === "") {
      continue;
    }
    const index = match[1] as string;
    const field = match[2] as "NAME" | "URL" | "DIR";
    const entry = entries.get(index) ?? {};
    if (field === "NAME") {
      entry.name = value;
    } else if (field === "URL") {
      entry.url = value;
    } else {
      entry.dir = value;
    }
    entries.set(index, entry);
  }

  const sortedIndices = [...entries.keys()].sort((a, b) => Number(a) - Number(b));
  const configs: PlaylistConfig[] = [];
  const seenNameDirPairs = new Set<string>();

  for (const index of sortedIndices) {
    const entry = entries.get(index) as RawPlaylistEntry;
    const missing: string[] = [];
    if (!entry.name) missing.push(`PLAYLIST_${index}_NAME`);
    if (!entry.url) missing.push(`PLAYLIST_${index}_URL`);
    if (!entry.dir) missing.push(`PLAYLIST_${index}_DIR`);

    if (missing.length > 0) {
      throw new ConfigError(
        `Incomplete playlist configuration for index ${index}: missing ${missing.join(", ")}`,
      );
    }

    const name = entry.name as string;
    const url = entry.url as string;
    const dir = entry.dir as string;
    const spotifyPlaylistId = extractSpotifyPlaylistId(url);

    const pairKey = `${dir}::${name}`;
    if (seenNameDirPairs.has(pairKey)) {
      throw new ConfigError(
        `Duplicate playlist configuration: name "${name}" combined with dir "${dir}" is used more than once. Each playlist + destination pair must be unique.`,
      );
    }
    seenNameDirPairs.add(pairKey);

    configs.push({
      id: index,
      name,
      url,
      spotifyPlaylistId,
      rootDir: dir,
    });
  }

  if (configs.length === 0) {
    throw new ConfigError(
      "No playlists configured. Define at least PLAYLIST_1_NAME, PLAYLIST_1_URL and PLAYLIST_1_DIR.",
    );
  }

  return configs;
}
