import type { AppConfig, SyncSummary } from "../types/index.js";
import type { Logger } from "../utils/logger.js";
import { Semaphore } from "../utils/concurrency.js";
import { SpotifyClient, type PlaylistTrackSource } from "../playlist/spotifyClient.js";
import { syncPlaylist } from "./syncPlaylist.js";
import type { PipelineOps } from "../downloader/pipeline.js";

export interface SyncCycleOverrides {
  readonly spotifyClient?: PlaylistTrackSource;
  readonly pipelineOps?: PipelineOps;
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

  const playlistSummaries = await Promise.all(
    config.playlists.map((playlistConfig) =>
      syncPlaylist(
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
