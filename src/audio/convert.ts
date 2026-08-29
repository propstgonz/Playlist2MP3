import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { removeIfExists } from "../filesystem/store.js";

const execFileAsync = promisify(execFile);
const CONVERSION_TIMEOUT_MS = 300_000;

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}

export async function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-vn", "-codec:a", "libmp3lame", "-q:a", "0", outputPath],
      { timeout: CONVERSION_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (error) {
    await removeIfExists(outputPath);
    throw new ConversionError(
      `ffmpeg conversion failed for "${inputPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await removeIfExists(inputPath);
  }
}
