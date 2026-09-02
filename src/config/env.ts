import { ConfigError } from "./playlists.js";
import { parseSizeString } from "../utils/size.js";

export function parseByteSize(raw: string | undefined, varName: string): number {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "0") {
    return 0;
  }
  try {
    const bytes = parseSizeString(raw);
    if (bytes <= 0) {
      throw new Error("must be greater than zero");
    }
    return bytes;
  } catch {
    throw new ConfigError(
      `${varName} must be a positive number optionally followed by K, M, G or T (e.g. "500M", "1G"), got "${raw}"`,
    );
  }
}

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  varName: string,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${varName} must be a positive integer, got "${raw}"`);
  }
  return value;
}
