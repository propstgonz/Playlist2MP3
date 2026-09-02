import type { AppConfig } from "../types/index.js";
import { parsePositiveInt, parseByteSize } from "./env.js";
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

  return {
    syncIntervalSec,
    downloadConcurrency,
    tempDir,
    maxSizeBytes,
    playlists,
    randomPlaylist,
  };
}
