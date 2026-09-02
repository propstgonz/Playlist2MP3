import { mkdir, rename, copyFile, unlink, stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlaylistConfig, SpotifyTrack } from "../types/index.js";
import {
  buildFileName,
  buildFileNameWithSuffix,
  resolvePlaylistDir,
  resolveTrackPath,
  resolveTrackPathWithSuffix,
} from "./paths.js";

export async function ensurePlaylistDir(config: PlaylistConfig): Promise<string> {
  const dir = resolvePlaylistDir(config);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function computeTrackPaths(
  config: PlaylistConfig,
  tracks: readonly SpotifyTrack[],
): ReadonlyMap<string, string> {
  const byFileName = new Map<string, SpotifyTrack[]>();
  for (const track of tracks) {
    const fileName = buildFileName(track);
    const group = byFileName.get(fileName) ?? [];
    group.push(track);
    byFileName.set(fileName, group);
  }

  const result = new Map<string, string>();
  for (const group of byFileName.values()) {
    const hasCollision = new Set(group.map((track) => track.id)).size > 1;
    for (const track of group) {
      result.set(
        track.id,
        hasCollision ? resolveTrackPathWithSuffix(config, track) : resolveTrackPath(config, track),
      );
    }
  }
  return result;
}

export async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function commitFile(tempPath: string, finalPath: string): Promise<boolean> {
  if (await fileExists(finalPath)) {
    await removeIfExists(tempPath);
    return false;
  }
  await mkdir(dirname(finalPath), { recursive: true });
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EXDEV") {
      await copyFile(tempPath, finalPath);
      await unlink(tempPath);
    } else {
      throw error;
    }
  }
  return true;
}

export async function getDirectorySizeBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySizeBytes(entryPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }
  return total;
}

export async function isStorageQuotaExceeded(
  maxSizeBytes: number,
  playlists: readonly PlaylistConfig[],
): Promise<boolean> {
  if (maxSizeBytes <= 0) {
    return false;
  }
  let total = 0;
  for (const playlist of playlists) {
    total += await getDirectorySizeBytes(resolvePlaylistDir(playlist));
    if (total >= maxSizeBytes) {
      return true;
    }
  }
  return false;
}

export { buildFileName, buildFileNameWithSuffix, resolvePlaylistDir, resolveTrackPath };
