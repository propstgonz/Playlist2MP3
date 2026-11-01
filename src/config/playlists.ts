import { readFileSync } from "node:fs";
import type { PlaylistConfig, RandomPlaylistConfig } from "../types/index.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_PLAYLIST_DIR = "/music";

const SPOTIFY_PLAYLIST_URL_PATTERN =
  /^https:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)(?:\?.*)?$/;
const SPOTIFY_PLAYLIST_URI_PATTERN = /^spotify:playlist:([a-zA-Z0-9]+)$/;

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

function readStringField(entry: Record<string, unknown>, field: string, index: string): string | undefined {
  const value = entry[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Playlist ${index}: "${field}" must be a string`);
  }
  return value.trim() === "" ? undefined : value.trim();
}

export function readConfigFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Cannot read playlist config file "${path}" (${reason}). Copy config.example.json to config.json and edit it.`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Playlist config file "${path}" is not valid JSON: ${reason}`);
  }
}

export function parsePlaylistConfigs(fileConfig: unknown): readonly PlaylistConfig[] {
  const rawPlaylists =
    typeof fileConfig === "object" && fileConfig !== null
      ? (fileConfig as Record<string, unknown>)["playlists"]
      : undefined;
  if (!Array.isArray(rawPlaylists)) {
    throw new ConfigError('Playlist config must be an object with a "playlists" array.');
  }

  const configs: PlaylistConfig[] = [];
  const seenNameDirPairs = new Set<string>();

  for (const [position, rawEntry] of rawPlaylists.entries()) {
    const index = String(position + 1);
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      throw new ConfigError(`Playlist ${index}: each entry must be an object with "name" and "url"`);
    }
    const entry = rawEntry as Record<string, unknown>;
    const name = readStringField(entry, "name", index);
    const url = readStringField(entry, "url", index);
    const dir = readStringField(entry, "dir", index) ?? DEFAULT_PLAYLIST_DIR;

    if (name === undefined || url === undefined) {
      const missing = name === undefined ? (url === undefined ? "name, url" : "name") : "url";
      throw new ConfigError(
        `Incomplete playlist configuration for playlist ${index}: missing ${missing}`,
      );
    }

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
      'No playlists configured. Add at least one { "name": ..., "url": ... } entry to "playlists" in config.json.',
    );
  }

  return configs;
}

const TRUTHY_FLAG_VALUES = new Set(["true", "1", "yes"]);

export function parseRandomPlaylistConfig(
  env: NodeJS.ProcessEnv,
): RandomPlaylistConfig | undefined {
  const enabled = TRUTHY_FLAG_VALUES.has((env["RANDOM_PLAYLIST"] ?? "").trim().toLowerCase());
  if (!enabled) {
    return undefined;
  }

  const dir = env["RANDOM_PLAYLIST_DIR"];
  if (!dir) {
    throw new ConfigError("RANDOM_PLAYLIST is enabled but RANDOM_PLAYLIST_DIR is not set");
  }

  return { dir };
}
