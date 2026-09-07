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

export function parseBoolean(raw: string | undefined, fallback: boolean, varName: string): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new ConfigError(`${varName} must be true or false, got "${raw}"`);
}

export function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  varName: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${varName} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export function parsePartnerQueryHash(
  raw: string | undefined,
  varName: string,
): string | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new ConfigError(`${varName} must be a 64-character hex hash, got "${raw}"`);
  }
  return normalized;
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
