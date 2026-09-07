import type { AppConfig } from "../types/index.js";
import {
  parsePositiveInt,
  parseByteSize,
  parseBoolean,
  parseNonNegativeInt,
  parsePartnerQueryHash,
} from "./env.js";
import { parsePlaylistConfigs, parseRandomPlaylistConfig } from "./playlists.js";

export { ConfigError } from "./playlists.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const syncIntervalSec = parsePositiveInt(env["SYNC_INTERVAL"], 86400, "SYNC_INTERVAL");
  const downloadConcurrency = parsePositiveInt(
    env["DOWNLOAD_CONCURRENCY"],
    2,
    "DOWNLOAD_CONCURRENCY",
  );
  const tempDir = env["TEMP_DIR"] ?? "/tmp/playlist2mp3";
  const maxSizeBytes = parseByteSize(env["MAX_SIZE"], "MAX_SIZE");
  const playlists = parsePlaylistConfigs(env);
  const randomPlaylist = parseRandomPlaylistConfig(env);
  const spotify = {
    fullCatalogEnabled: parseBoolean(
      env["SPOTIFY_FULL_CATALOG"],
      true,
      "SPOTIFY_FULL_CATALOG",
    ),
    partnerQueryHash: parsePartnerQueryHash(
      env["SPOTIFY_PARTNER_HASH"],
      "SPOTIFY_PARTNER_HASH",
    ),
    pageDelayMs: parseNonNegativeInt(
      env["SPOTIFY_PAGE_DELAY_MS"],
      250,
      "SPOTIFY_PAGE_DELAY_MS",
    ),
  };

  return {
    syncIntervalSec,
    downloadConcurrency,
    tempDir,
    maxSizeBytes,
    playlists,
    randomPlaylist,
    spotify,
  };
}
