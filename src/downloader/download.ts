import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Candidate } from "../types/index.js";
import { errorMessage } from "../utils/logger.js";
import { fileExists, removeIfExists } from "../filesystem/files.js";
import { COMMON_ARGS, type CommandRunner } from "../resolver/search.js";

const DOWNLOAD_TIMEOUT_MS = 600_000;

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

async function removeLeftovers(tempDir: string, prefix: string): Promise<void> {
  const entries = await readdir(tempDir).catch((error: unknown) => {
    throw new DownloadError(`Cannot read temp directory ${tempDir}: ${errorMessage(error)}`);
  });
  await Promise.all(
    entries.filter((name) => name.startsWith(prefix)).map((name) => removeIfExists(join(tempDir, name))),
  );
}

export function qualityArg(quality: string): string {
  return quality === "best" ? "0" : quality.toUpperCase();
}

export function downloadArgs(url: string, outputBase: string, quality: string): string[] {
  return [
    url,
    "--format",
    "bestaudio/best",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    qualityArg(quality),
    "--output",
    `${outputBase}.%(ext)s`,
    "--no-playlist",
    ...COMMON_ARGS,
  ];
}

export async function downloadMp3(
  candidate: Candidate,
  tempDir: string,
  trackId: string,
  quality: string,
  run: CommandRunner,
  signal?: AbortSignal,
): Promise<string> {
  const outputBase = join(tempDir, `${trackId}-${randomBytes(4).toString("hex")}`);
  const mp3Path = `${outputBase}.mp3`;
  try {
    await run(downloadArgs(candidate.url, outputBase, quality), { timeoutMs: DOWNLOAD_TIMEOUT_MS, signal });
  } catch (error) {
    await removeLeftovers(tempDir, basename(outputBase));
    throw new DownloadError(`yt-dlp could not download ${candidate.url}: ${errorMessage(error)}`);
  }
  if (!(await fileExists(mp3Path))) {
    throw new DownloadError(`yt-dlp finished but produced no MP3 for ${candidate.url}`);
  }
  return mp3Path;
}
