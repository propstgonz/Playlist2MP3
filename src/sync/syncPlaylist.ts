import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig, PlaylistSummary, SpotifyTrack, SyncMode } from "../types/index.js";
import { errorMessage, type Logger } from "../utils/logger.js";
import { runWithSemaphore, type Semaphore } from "../utils/concurrency.js";
import { fileInDir, playlistDir, sanitizeSegment } from "../filesystem/paths.js";
import { listMp3Files, removeIfExists, renameNoOverwrite, writeIfChanged } from "../filesystem/files.js";
import { loadManifest, manifestPath, serializeManifest } from "../filesystem/manifest.js";
import { runTrackPipeline, type PipelineOps } from "../downloader/pipeline.js";
import type { PlaylistSource } from "../playlist/spotify.js";
import { buildM3u, buildPlan, type PlanAction } from "./plan.js";

export interface SyncTarget {
  readonly name: string;
  readonly playlistId: string;
  readonly mode: SyncMode;
  readonly maxTracks?: number;
}

export interface SyncDeps {
  readonly config: AppConfig;
  readonly source: PlaylistSource;
  readonly semaphore: Semaphore;
  readonly ops: PipelineOps;
  readonly musicDir: string;
  readonly tempDir: string;
  readonly logger: Logger;
}

function label(track: SpotifyTrack): string {
  return `${track.artists.join(", ")} - ${track.title}`;
}

function describeAction(action: PlanAction): string {
  switch (action.kind) {
    case "download":
      return `download  ${label(action.track)} -> "${action.file}"`;
    case "rename":
      return `rename    "${action.from}" -> "${action.to}"`;
    case "keep":
      return `${action.adopted ? "adopt" : "keep"}      "${action.file}"`;
    case "remove":
      return `remove    "${action.file}" (id=${action.trackId})`;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function emptySummary(name: string, error: string): PlaylistSummary {
  return { name, total: 0, unavailable: 0, downloaded: 0, renamed: 0, removed: 0, unchanged: 0, failed: 0, error };
}

export async function syncPlaylist(
  target: SyncTarget,
  deps: SyncDeps,
  signal?: AbortSignal,
): Promise<PlaylistSummary> {
  const { config } = deps;
  const logger = deps.logger.child(target.name);
  const dryRun = config.dryRun;

  try {
    const dir = playlistDir(deps.musicDir, target.name);
    const exists = await directoryExists(dir);
    if (!exists && !dryRun) {
      await mkdir(dir, { recursive: true });
    }

    const fetched = await deps.source.getPlaylist(target.playlistId, signal);
    const tracks = target.maxTracks === undefined ? fetched.tracks : fetched.tracks.slice(0, target.maxTracks);
    logger.info(
      `Spotify: ${tracks.length} tracks` +
        (fetched.unavailable > 0 ? `, ${fetched.unavailable} unavailable on Spotify (not downloaded)` : "") +
        (fetched.source === "embed" ? " [embed list]" : ""),
    );
    if (!fetched.complete) {
      logger.warn("The track list may be incomplete (embed list capped at 100). Nothing will be removed this cycle.");
    }

    const loaded = exists ? await loadManifest(dir, !dryRun) : { tracks: new Map<string, string>(), status: "missing" as const };
    if (loaded.status === "corrupt") {
      logger.warn("The folder index was unreadable; it was set aside and is being rebuilt from the files on disk");
    }
    const diskFiles = exists ? await listMp3Files(dir) : [];

    const plan = buildPlan({
      tracks,
      manifest: loaded.tracks,
      diskFiles,
      mode: target.mode,
      complete: fetched.complete,
      fileNameTemplate: config.fileName,
    });
    for (const action of plan.actions) {
      logger.debug(`plan: ${describeAction(action)}`);
    }
    if (plan.removalsBlocked > 0) {
      logger.warn(`${plan.removalsBlocked} files no longer in the playlist were kept because the track list may be incomplete`);
    }

    const downloads = plan.actions.flatMap((a) => (a.kind === "download" ? [a] : []));
    const renames = plan.actions.flatMap((a) => (a.kind === "rename" ? [a] : []));
    const removals = plan.actions.flatMap((a) => (a.kind === "remove" ? [a] : []));
    const adopted = plan.actions.filter((a) => a.kind === "keep" && a.adopted).length;
    const unchanged = plan.actions.filter((a) => a.kind === "keep").length;

    if (dryRun) {
      for (const action of [...downloads, ...renames, ...removals]) {
        logger.info(`[dry run] would ${describeAction(action)}`);
      }
      logger.info(
        `[dry run] ${downloads.length} to download, ${renames.length} to rename, ${removals.length} to remove, ${unchanged} unchanged (${adopted} adopted)`,
      );
      return {
        name: target.name,
        total: tracks.length,
        unavailable: fetched.unavailable,
        downloaded: downloads.length,
        renamed: renames.length,
        removed: removals.length,
        unchanged,
        failed: 0,
        error: undefined,
      };
    }

    const manifest = new Map(plan.manifest);
    let saving: Promise<unknown> = Promise.resolve();
    const persist = (): Promise<unknown> => {
      saving = saving.then(() => writeIfChanged(manifestPath(dir), serializeManifest(manifest)));
      return saving;
    };

    let renamed = 0;
    for (const action of renames) {
      if (await renameNoOverwrite(fileInDir(dir, action.from), fileInDir(dir, action.to))) {
        renamed += 1;
        logger.info(`Renamed: "${action.from}" -> "${action.to}"`);
      } else {
        manifest.set(action.track.id, action.from);
        logger.warn(`Could not rename "${action.from}": "${action.to}" already exists`);
      }
    }
    for (const action of removals) {
      await removeIfExists(fileInDir(dir, action.file));
      logger.info(`Removed: "${action.file}" (no longer in the Spotify playlist)`);
    }
    if (adopted > 0) {
      logger.info(`Adopted ${adopted} existing files into the folder index`);
    }
    await persist();

    logger.info(`${downloads.length} new tracks to download`);
    let downloaded = 0;
    let failed = 0;
    await runWithSemaphore(
      deps.semaphore,
      downloads,
      async (action) => {
        const outcome = await runTrackPipeline(
          action.track,
          fileInDir(dir, action.file),
          {
            tempDir: deps.tempDir,
            audioQuality: config.audioQuality,
            matching: config.matching,
            logger,
            signal,
            enrich: deps.source.enrich?.bind(deps.source),
          },
          deps.ops,
        );
        if (outcome.status === "failed") {
          failed += 1;
          return;
        }
        manifest.set(action.track.id, action.file);
        await persist();
        if (outcome.status === "downloaded") {
          downloaded += 1;
          logger.info(`Downloaded: ${label(action.track)}${outcome.doubtful ? " (doubtful match)" : ""}`);
        }
      },
      signal,
    );
    await saving;

    await writeIfChanged(join(dir, `${sanitizeSegment(target.name)}.m3u`), buildM3u(tracks, manifest));

    logger.info(
      `Done: ${downloaded} downloaded, ${renamed} renamed, ${removals.length} removed, ${unchanged} unchanged, ${failed} failed`,
    );
    return {
      name: target.name,
      total: tracks.length,
      unavailable: fetched.unavailable,
      downloaded,
      renamed,
      removed: removals.length,
      unchanged,
      failed,
      error: undefined,
    };
  } catch (error) {
    const reason = signal?.aborted ? "interrupted by shutdown" : errorMessage(error);
    logger.error(`Synchronization failed: ${reason}`);
    return emptySummary(target.name, reason);
  }
}
