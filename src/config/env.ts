import { ConfigError } from "./playlists.js";

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
