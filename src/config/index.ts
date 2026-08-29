import type { AppConfig } from "../types/index.js";
import { parsePositiveInt } from "./env.js";
import { parsePlaylistConfigs } from "./playlists.js";

export { ConfigError } from "./playlists.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const syncIntervalSec = parsePositiveInt(env["SYNC_INTERVAL"], 86400, "SYNC_INTERVAL");
  const downloadConcurrency = parsePositiveInt(
    env["DOWNLOAD_CONCURRENCY"],
    2,
    "DOWNLOAD_CONCURRENCY",
  );
  const tempDir = env["TEMP_DIR"] ?? "/tmp/playlist2mp3";
  const playlists = parsePlaylistConfigs(env);

  return {
    syncIntervalSec,
    downloadConcurrency,
    tempDir,
    playlists,
  };
}
