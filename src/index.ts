import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./types/index.js";
import { ConfigError, loadConfig, runtimePaths } from "./config/load.js";
import { configureLogger, errorMessage, rootLogger } from "./utils/logger.js";
import { abortableSleep } from "./utils/duration.js";
import { SpotifyClient } from "./playlist/spotify.js";
import { createPipelineOps } from "./downloader/pipeline.js";
import { describeCycle, runCycle } from "./sync/cycle.js";

function applyLogging(config: AppConfig): void {
  configureLogger({ level: config.logLevel, timezone: config.timezone });
}

function describeConfig(config: AppConfig): void {
  rootLogger.info(
    `Settings: every ${Math.round(config.syncIntervalMs / 60_000)} min, concurrency ${config.concurrency}, ` +
      `log ${config.logLevel}, quality ${config.audioQuality}, strict matching ${config.matching.strict}` +
      (config.dryRun ? ", DRY RUN (nothing is written)" : ""),
  );
  for (const playlist of config.playlists) {
    rootLogger.info(`Playlist: ${playlist.name} [${playlist.mode}] ${playlist.url}`);
  }
  if (config.random.enabled) {
    rootLogger.info(`Random playlist: ${config.random.name} [${config.random.mode}], up to ${config.random.maxTracks} tracks`);
  }
}

async function reloadConfig(path: string, previous: AppConfig): Promise<AppConfig> {
  try {
    const next = await loadConfig(path);
    applyLogging(next);
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      rootLogger.info("Configuration changed, applying it from this cycle on");
      describeConfig(next);
    }
    return next;
  } catch (error) {
    rootLogger.error(`${errorMessage(error)} - keeping the previous configuration`);
    return previous;
  }
}

async function main(): Promise<void> {
  const paths = runtimePaths();
  let config: AppConfig;
  try {
    config = await loadConfig(paths.configFile);
  } catch (error) {
    if (error instanceof ConfigError) {
      rootLogger.error(`Configuration error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  applyLogging(config);
  rootLogger.info(`Playlist2MP3 starting (config ${paths.configFile}, music ${paths.musicDir})`);
  describeConfig(config);

  const workDir = join(paths.tempDir, ".playlist2mp3-work");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const controller = new AbortController();
  const shutdown = (signalName: string): void => {
    if (!controller.signal.aborted) {
      rootLogger.info(`Received ${signalName}, stopping`);
      controller.abort();
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const deps = {
    source: new SpotifyClient({ logger: rootLogger.child("spotify") }),
    ops: createPipelineOps(),
    musicDir: paths.musicDir,
    tempDir: workDir,
    logger: rootLogger,
  };

  let first = true;
  while (!controller.signal.aborted) {
    if (!first) {
      config = await reloadConfig(paths.configFile, config);
    }
    first = false;
    try {
      const summary = await runCycle(config, deps, controller.signal);
      rootLogger.info(describeCycle(summary, config.dryRun));
    } catch (error) {
      if (controller.signal.aborted) {
        break;
      }
      rootLogger.error(`Cycle crashed unexpectedly: ${errorMessage(error)}`);
    }
    if (controller.signal.aborted) {
      break;
    }
    rootLogger.info(`Next check in ${Math.round(config.syncIntervalMs / 60_000)} min`);
    try {
      await abortableSleep(config.syncIntervalMs, controller.signal);
    } catch (error) {
      rootLogger.debug(`Wait interrupted: ${errorMessage(error)}`);
      break;
    }
  }

  await rm(workDir, { recursive: true, force: true });
  rootLogger.info("Shutdown complete");
}

main().catch((error: unknown) => {
  rootLogger.error(`Fatal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
