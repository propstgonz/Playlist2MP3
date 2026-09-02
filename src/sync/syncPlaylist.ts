import type { PlaylistConfig, PlaylistSummary, SpotifyTrack } from "../types/index.js";
import type { Logger } from "../utils/logger.js";
import { runWithSemaphore, type Semaphore } from "../utils/concurrency.js";
import { ensurePlaylistDir, computeTrackPaths, fileExists } from "../filesystem/store.js";
import { runTrackPipeline, defaultPipelineOps, type PipelineOps } from "../downloader/pipeline.js";
import { EMBED_TRACK_LIST_CAP, type PlaylistTrackSource } from "../playlist/spotifyClient.js";

export interface SyncPlaylistDeps {
  readonly spotifyClient: PlaylistTrackSource;
  readonly downloadSemaphore: Semaphore;
  readonly tempDir: string;
  readonly logger: Logger;
  readonly pipelineOps?: PipelineOps;
}

async function enrichTrack(
  track: SpotifyTrack,
  spotifyClient: PlaylistTrackSource,
  logger: Logger,
  signal?: AbortSignal,
): Promise<SpotifyTrack> {
  if (!spotifyClient.getTrackDetails) {
    return track;
  }
  try {
    return await spotifyClient.getTrackDetails(track, signal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Could not fetch extra metadata for "${track.title}" (id=${track.id}): ${reason}. ` +
        "Continuing with basic metadata only.",
    );
    return track;
  }
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

    const { tracks, unavailableCount } = await deps.spotifyClient.getPlaylistTracks(
      config.spotifyPlaylistId,
      signal,
    );
    logger.info(
      `Found ${tracks.length} tracks` +
        (unavailableCount > 0
          ? ` (${unavailableCount} more listed in the playlist are unavailable — local-only or removed from Spotify's catalog — and were skipped)`
          : ""),
    );
    if (tracks.length >= EMBED_TRACK_LIST_CAP) {
      logger.warn(
        `This playlist has ${tracks.length} tracks, which may hit the ${EMBED_TRACK_LIST_CAP}-track limit of the ` +
          "no-login metadata source used by this service. Tracks beyond that point may not be visible or synced.",
      );
    }

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

    await runWithSemaphore(
      deps.downloadSemaphore,
      missingTracks,
      async (track) => {
        const finalPath = trackPaths.get(track.id);
        if (!finalPath) {
          failed += 1;
          return;
        }
        const enrichedTrack = await enrichTrack(track, deps.spotifyClient, logger, signal);
        const outcome = await runTrackPipeline(
          enrichedTrack,
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
      tracksUnavailable: unavailableCount,
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
      tracksUnavailable: 0,
      tracksNew: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      error: reason,
    };
  }
}
