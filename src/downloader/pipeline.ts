import { join } from "node:path";
import type { SpotifyTrack, TrackOutcome } from "../types/index.js";
import type { Logger } from "../utils/logger.js";
import { withRetry, type RetryOptions } from "../utils/retry.js";
import { resolveTrack } from "../resolver/ytdlpResolver.js";
import { downloadSource } from "../downloader/download.js";
import { convertToMp3 } from "../audio/convert.js";
import { tagMp3 } from "../audio/tag.js";
import { commitFile, removeIfExists } from "../filesystem/store.js";

export interface PipelineDeps {
  readonly tempDir: string;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly retryOptions?: Partial<RetryOptions>;
}

export interface PipelineOps {
  readonly resolveTrack: typeof resolveTrack;
  readonly downloadSource: typeof downloadSource;
  readonly convertToMp3: typeof convertToMp3;
  readonly tagMp3: typeof tagMp3;
  readonly commitFile: typeof commitFile;
}

export const defaultPipelineOps: PipelineOps = {
  resolveTrack,
  downloadSource,
  convertToMp3,
  tagMp3,
  commitFile,
};

export async function runTrackPipeline(
  track: SpotifyTrack,
  finalPath: string,
  deps: PipelineDeps,
  ops: PipelineOps = defaultPipelineOps,
): Promise<TrackOutcome> {
  const { tempDir, logger, signal, retryOptions } = deps;
  const baseName = track.id;
  const rawTempPath = join(tempDir, `${baseName}.raw`);
  const mp3TempPath = join(tempDir, `${baseName}.mp3`);

  let downloadedPath: string | undefined;

  try {
    logger.debug(`Resolving source for: ${track.artists.join(", ")} - ${track.title}`);
    const source = await withRetry(() => ops.resolveTrack(track, signal), {
      signal,
      ...retryOptions,
    });

    logger.info(`Downloading: ${track.artists.join(", ")} - ${track.title}`);
    downloadedPath = await withRetry(
      () => ops.downloadSource(source, tempDir, baseName, signal),
      { signal, ...retryOptions },
    );

    await ops.convertToMp3(downloadedPath, mp3TempPath);
    downloadedPath = undefined;

    await ops.tagMp3(mp3TempPath, track, logger);

    const committed = await ops.commitFile(mp3TempPath, finalPath);
    if (!committed) {
      logger.debug(`Skipped, already exists: ${finalPath}`);
      return { status: "skipped" };
    }

    logger.info(`Completed: ${track.artists.join(", ")} - ${track.title}`);
    return { status: "downloaded" };
  } catch (error) {
    if (downloadedPath) {
      await removeIfExists(downloadedPath);
    }
    await removeIfExists(rawTempPath);
    await removeIfExists(mp3TempPath);

    const reason = error instanceof Error ? error.message : String(error);
    const stage = classifyFailureStage(error);
    logger.error(
      `Failed: ${track.artists.join(", ")} - ${track.title} | id=${track.id} | stage=${stage} | reason=${reason}`,
    );
    return { status: "failed", stage, reason };
  }
}

function classifyFailureStage(
  error: unknown,
): "resolving" | "downloading" | "converting" | "tagging" | "committing" {
  if (!(error instanceof Error)) {
    return "resolving";
  }
  switch (error.name) {
    case "ResolutionError":
      return "resolving";
    case "DownloadError":
      return "downloading";
    case "ConversionError":
      return "converting";
    case "TaggingError":
      return "tagging";
    default:
      return "committing";
  }
}
