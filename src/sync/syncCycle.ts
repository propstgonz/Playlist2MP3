import type { AppConfig, SyncSummary } from "../types/index.js";
import type { Logger } from "../utils/logger.js";
import { SpotifyAuthClient } from "../playlist/spotifyAuth.js";
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
  const spotifyClient =
    overrides.spotifyClient ??
    new SpotifyClient(new SpotifyAuthClient(config.spotifyClientId, config.spotifyClientSecret));

  const playlistSummaries = [];
  for (const playlistConfig of config.playlists) {
    if (signal?.aborted) {
      break;
    }
    const summary = await syncPlaylist(
      playlistConfig,
      {
        spotifyClient,
        downloadConcurrency: config.downloadConcurrency,
        tempDir: config.tempDir,
        logger,
        pipelineOps: overrides.pipelineOps,
      },
      signal,
    );
    playlistSummaries.push(summary);
  }

  return {
    playlistsProcessed: playlistSummaries.length,
    playlistSummaries,
    durationMs: Date.now() - startedAt,
  };
}
