import type { MatchingSettings, SpotifyTrack, TrackStage } from "../types/index.js";
import { errorMessage, type Logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { commitFile, removeIfExists } from "../filesystem/files.js";
import { resolveSource, type ResolvedSource } from "../resolver/resolve.js";
import { runYtDlp, type CommandRunner } from "../resolver/search.js";
import { tagMp3 } from "../audio/tag.js";
import { downloadMp3 } from "./download.js";

export interface PipelineOps {
  readonly resolve: (track: SpotifyTrack, settings: MatchingSettings, logger: Logger, signal?: AbortSignal) => Promise<ResolvedSource>;
  readonly download: (source: ResolvedSource, tempDir: string, trackId: string, quality: string, signal?: AbortSignal) => Promise<string>;
  readonly tag: (filePath: string, track: SpotifyTrack, logger: Logger) => Promise<void>;
  readonly commit: (tempPath: string, finalPath: string) => Promise<boolean>;
}

export function createPipelineOps(run: CommandRunner = runYtDlp): PipelineOps {
  return {
    resolve: (track, settings, logger, signal) => resolveSource(track, settings, run, logger, signal),
    download: (source, tempDir, trackId, quality, signal) =>
      downloadMp3(source.candidate, tempDir, trackId, quality, run, signal),
    tag: tagMp3,
    commit: commitFile,
  };
}

export interface PipelineContext {
  readonly tempDir: string;
  readonly audioQuality: string;
  readonly matching: MatchingSettings;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly enrich?: (track: SpotifyTrack, signal?: AbortSignal) => Promise<SpotifyTrack>;
}

export type PipelineOutcome =
  | { readonly status: "downloaded"; readonly doubtful: boolean }
  | { readonly status: "exists" }
  | { readonly status: "failed"; readonly stage: TrackStage; readonly reason: string };

function label(track: SpotifyTrack): string {
  return `${track.artists.join(", ")} - ${track.title}`;
}

async function enrichTrack(track: SpotifyTrack, context: PipelineContext): Promise<SpotifyTrack> {
  if (!context.enrich || (track.coverUrl !== undefined && track.releaseYear !== undefined)) {
    return track;
  }
  try {
    return await context.enrich(track, context.signal);
  } catch (error) {
    context.logger.debug(`Extra metadata unavailable for "${track.title}": ${errorMessage(error)}`);
    return track;
  }
}

export async function runTrackPipeline(
  original: SpotifyTrack,
  finalPath: string,
  context: PipelineContext,
  ops: PipelineOps,
): Promise<PipelineOutcome> {
  const { logger, signal } = context;
  let stage: TrackStage = "metadata";
  let tempPath: string | undefined;

  try {
    const track = await enrichTrack(original, context);

    stage = "searching";
    const source = await ops.resolve(track, context.matching, logger, signal);
    logger.debug(`Selected ${source.candidate.url} for "${label(track)}"`);

    stage = "downloading";
    tempPath = await withRetry(
      () => ops.download(source, context.tempDir, track.id, context.audioQuality, signal),
      { signal },
    );

    stage = "tagging";
    await ops.tag(tempPath, track, logger);

    stage = "saving";
    const committed = await ops.commit(tempPath, finalPath);
    tempPath = undefined;
    return committed ? { status: "downloaded", doubtful: source.doubtful } : { status: "exists" };
  } catch (error) {
    const reason = errorMessage(error);
    logger.error(
      `Failed: ${label(original)} | id=${original.id} | stage=${stage} | reason=${reason}`,
    );
    return { status: "failed", stage, reason };
  } finally {
    if (tempPath !== undefined) {
      await removeIfExists(tempPath);
    }
  }
}
