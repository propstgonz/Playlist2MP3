import type { AppConfig, PlaylistSummary, SyncSummary } from "../types/index.js";
import type { Logger } from "../utils/logger.js";
import { formatBytes } from "../utils/size.js";
import { Semaphore } from "../utils/concurrency.js";
import { SpotifyClient, type PlaylistTrackSource } from "../playlist/spotifyClient.js";
import { isStorageQuotaExceeded } from "../filesystem/store.js";
import { pickRandomPlaylistConfig } from "./randomPlaylist.js";
import { syncPlaylist } from "./syncPlaylist.js";
import type { PipelineOps } from "../downloader/pipeline.js";

export interface SyncCycleOverrides {
  readonly spotifyClient?: PlaylistTrackSource;
  readonly pipelineOps?: PipelineOps;
}

function quotaSkippedSummary(playlistId: string, playlistName: string): PlaylistSummary {
  return {
    playlistId,
    playlistName,
    tracksFound: 0,
    tracksUnavailable: 0,
    tracksNew: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    error: "Skipped: local storage quota (MAX_SIZE) reached",
  };
}

export async function runSyncCycle(
  config: AppConfig,
  logger: Logger,
  signal?: AbortSignal,
  overrides: SyncCycleOverrides = {},
): Promise<SyncSummary> {
  const startedAt = Date.now();
  const spotifyClient = overrides.spotifyClient ?? new SpotifyClient();
  const downloadSemaphore = new Semaphore(config.downloadConcurrency);

  const playlists = [...config.playlists];
  if (config.randomPlaylist) {
    try {
      const picked = await pickRandomPlaylistConfig(spotifyClient, config.randomPlaylist, signal);
      logger.info(`Random playlist selected for this cycle: "${picked.name}"`);
      playlists.push(picked);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not select a random public playlist this cycle: ${reason}`);
    }
  }

  const quotaExceeded = await isStorageQuotaExceeded(config.maxSizeBytes, playlists);
  if (quotaExceeded) {
    logger.error(
      `Storage quota reached (MAX_SIZE=${formatBytes(config.maxSizeBytes)}). Skipping downloads this cycle.`,
    );
  }

  const playlistSummaries = await Promise.all(
    playlists.map((playlistConfig) =>
      quotaExceeded
        ? Promise.resolve(quotaSkippedSummary(playlistConfig.id, playlistConfig.name))
        : syncPlaylist(
            playlistConfig,
            {
              spotifyClient,
              downloadSemaphore,
              tempDir: config.tempDir,
              logger,
              pipelineOps: overrides.pipelineOps,
            },
            signal,
          ),
    ),
  );

  return {
    playlistsProcessed: playlistSummaries.length,
    playlistSummaries,
    durationMs: Date.now() - startedAt,
  };
}
