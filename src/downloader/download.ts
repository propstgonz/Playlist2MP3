import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedSource } from "../types/index.js";

const execFileAsync = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 300_000;

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export async function downloadSource(
  source: ResolvedSource,
  workDir: string,
  baseName: string,
  signal?: AbortSignal,
): Promise<string> {
  const outputTemplate = join(workDir, `${baseName}.%(ext)s`);

  try {
    await execFileAsync(
      "yt-dlp",
      [
        source.sourceUrl,
        "-f",
        "bestaudio",
        "-o",
        outputTemplate,
        "--no-playlist",
        "--no-warnings",
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS, signal, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (error) {
    throw new DownloadError(
      `yt-dlp download failed for "${source.sourceUrl}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files = await readdir(workDir);
  const downloaded = files.find((file) => file.startsWith(`${baseName}.`));
  if (!downloaded) {
    throw new DownloadError(`yt-dlp reported success but no output file was found for "${baseName}"`);
  }

  return join(workDir, downloaded);
}
