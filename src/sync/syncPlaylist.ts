import type { PlaylistConfig, PlaylistSummary } from "../types/index.js";
import type { Logger } from "../utils/logger.js";
import { runWithLimit } from "../utils/concurrency.js";
import { ensurePlaylistDir, computeTrackPaths, fileExists } from "../filesystem/store.js";
import { runTrackPipeline, defaultPipelineOps, type PipelineOps } from "../downloader/pipeline.js";
import type { PlaylistTrackSource } from "../playlist/spotifyClient.js";

export interface SyncPlaylistDeps {
  readonly spotifyClient: PlaylistTrackSource;
  readonly downloadConcurrency: number;
  readonly tempDir: string;
  readonly logger: Logger;
  readonly pipelineOps?: PipelineOps;
}

export async function syncPlaylist(
  config: PlaylistConfig,
  deps: SyncPlaylistDeps,
  signal?: AbortSignal,
): Promise<PlaylistSummary> {
  const logger = deps.logger.child(config.name);
  logger.info("Starting synchronization");

  try {
    await ensurePlaylistDir(config);

    const tracks = await deps.spotifyClient.getPlaylistTracks(config.spotifyPlaylistId, signal);
    logger.info(`Found ${tracks.length} tracks`);

    const trackPaths = computeTrackPaths(config, tracks);
    const existenceChecks = await Promise.all(
      tracks.map(async (track) => {
        const path = trackPaths.get(track.id);
        if (!path) {
          return { track, exists: true };
        }
        return { track, exists: await fileExists(path) };
      }),
    );
    const missingTracks = existenceChecks
      .filter((entry) => !entry.exists)
      .map((entry) => entry.track);

    logger.info(`${missingTracks.length} new tracks`);

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    await runWithLimit(
      deps.downloadConcurrency,
      missingTracks,
      async (track) => {
        const finalPath = trackPaths.get(track.id);
        if (!finalPath) {
          failed += 1;
          return;
        }
        const outcome = await runTrackPipeline(
          track,
          finalPath,
          { tempDir: deps.tempDir, logger, signal },
          deps.pipelineOps ?? defaultPipelineOps,
        );
        if (outcome.status === "downloaded") {
          downloaded += 1;
        } else if (outcome.status === "skipped") {
          skipped += 1;
        } else {
          failed += 1;
        }
      },
      signal,
    );

    skipped += tracks.length - missingTracks.length;

    logger.info(
      `Synchronization completed: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`,
    );

    return {
      playlistId: config.id,
      playlistName: config.name,
      tracksFound: tracks.length,
      tracksNew: missingTracks.length,
      downloaded,
      skipped,
      failed,
      error: undefined,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(`Synchronization failed: ${reason}`);
    return {
      playlistId: config.id,
      playlistName: config.name,
      tracksFound: 0,
      tracksNew: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      error: reason,
    };
  }
}
