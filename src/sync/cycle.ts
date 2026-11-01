import type { AppConfig, PlaylistSummary } from "../types/index.js";
import { errorMessage, type Logger } from "../utils/logger.js";
import { Semaphore } from "../utils/concurrency.js";
import type { PipelineOps } from "../downloader/pipeline.js";
import type { PlaylistSource } from "../playlist/spotify.js";
import { syncPlaylist, type SyncTarget } from "./syncPlaylist.js";

export interface CycleDeps {
  readonly source: PlaylistSource;
  readonly ops: PipelineOps;
  readonly musicDir: string;
  readonly tempDir: string;
  readonly logger: Logger;
}

export interface CycleSummary {
  readonly playlists: readonly PlaylistSummary[];
  readonly durationMs: number;
}

async function resolveTargets(config: AppConfig, deps: CycleDeps, signal?: AbortSignal): Promise<SyncTarget[]> {
  const targets: SyncTarget[] = config.playlists.map((playlist) => ({
    name: playlist.name,
    playlistId: playlist.playlistId,
    mode: playlist.mode,
  }));
  if (!config.random.enabled) {
    return targets;
  }
  const logger = deps.logger.child(config.random.name);
  if (!deps.source.findRandomPlaylist) {
    logger.warn("Random playlists are not supported by this source");
    return targets;
  }
  try {
    const picked = await deps.source.findRandomPlaylist(signal);
    logger.info(`Random playlist for this cycle: "${picked.name}" (https://open.spotify.com/playlist/${picked.playlistId})`);
    targets.push({
      name: config.random.name,
      playlistId: picked.playlistId,
      mode: config.random.mode,
      maxTracks: config.random.maxTracks,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(`Could not pick a random playlist this cycle: ${errorMessage(error)}`);
  }
  return targets;
}

export async function runCycle(config: AppConfig, deps: CycleDeps, signal?: AbortSignal): Promise<CycleSummary> {
  const startedAt = Date.now();
  const semaphore = new Semaphore(config.concurrency);
  const targets = await resolveTargets(config, deps, signal);
  const playlists = await Promise.all(
    targets.map((target) =>
      syncPlaylist(
        target,
        { config, source: deps.source, semaphore, ops: deps.ops, musicDir: deps.musicDir, tempDir: deps.tempDir, logger: deps.logger },
        signal,
      ),
    ),
  );
  return { playlists, durationMs: Date.now() - startedAt };
}

export function describeCycle(summary: CycleSummary, dryRun: boolean): string {
  const sum = (pick: (p: PlaylistSummary) => number): number =>
    summary.playlists.reduce((total, playlist) => total + pick(playlist), 0);
  const errors = summary.playlists.filter((p) => p.error !== undefined).length;
  const verb = dryRun ? "would be " : "";
  return (
    `Cycle ${dryRun ? "(dry run) " : ""}finished in ${(summary.durationMs / 1000).toFixed(1)}s: ` +
    `${summary.playlists.length} playlists, ${sum((p) => p.total)} tracks, ` +
    `${sum((p) => p.downloaded)} ${verb}downloaded, ${sum((p) => p.renamed)} ${verb}renamed, ` +
    `${sum((p) => p.removed)} ${verb}removed, ${sum((p) => p.unchanged)} unchanged, ` +
    `${sum((p) => p.failed)} failed, ${errors} playlist errors`
  );
}
