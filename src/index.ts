import { mkdir } from "node:fs/promises";
import { loadConfig, ConfigError } from "./config/index.js";
import { rootLogger } from "./utils/logger.js";
import { abortableSleep } from "./utils/concurrency.js";
import { runSyncCycle } from "./sync/syncCycle.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      rootLogger.error(`Configuration error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  await mkdir(config.tempDir, { recursive: true });

  rootLogger.info(
    `Starting Playlist2MP3: ${config.playlists.length} playlist(s), sync interval ${config.syncIntervalSec}s, concurrency ${config.downloadConcurrency}`,
  );
  for (const playlist of config.playlists) {
    rootLogger.info(`Configured playlist: ${playlist.name} -> ${playlist.rootDir}`);
  }

  const controller = new AbortController();
  let shuttingDown = false;

  const shutdown = (signalName: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    rootLogger.info(`Received ${signalName}, shutting down after current cycle`);
    controller.abort();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (!shuttingDown) {
    try {
      const summary = await runSyncCycle(config, rootLogger, controller.signal);
      const totalDownloaded = summary.playlistSummaries.reduce((sum, p) => sum + p.downloaded, 0);
      const totalSkipped = summary.playlistSummaries.reduce((sum, p) => sum + p.skipped, 0);
      const totalFailed = summary.playlistSummaries.reduce((sum, p) => sum + p.failed, 0);
      const totalErrors = summary.playlistSummaries.filter((p) => p.error !== undefined).length;
      rootLogger.info(
        `Cycle completed: ${summary.playlistsProcessed} playlists processed, ${totalDownloaded} downloaded, ${totalSkipped} skipped, ${totalFailed} failed, ${totalErrors} playlist errors, duration ${summary.durationMs}ms`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      rootLogger.error(`Sync cycle crashed unexpectedly: ${reason}`);
    }

    if (shuttingDown) {
      break;
    }

    try {
      await abortableSleep(config.syncIntervalSec * 1000, controller.signal);
    } catch {
      break;
    }
  }

  rootLogger.info("Shutdown complete");
}

main().catch((error) => {
  rootLogger.error(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
