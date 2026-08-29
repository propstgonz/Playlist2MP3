import { join, resolve, sep } from "node:path";
import type { PlaylistConfig, SpotifyTrack } from "../types/index.js";

const ILLEGAL_CHARS = /[<>:"/\\|?*]/g;
const CONTROL_CHARS = new RegExp(
  "[" + Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") + "]",
  "g",
);
const TRAILING_DOTS_SPACES = /[. ]+$/;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);
const MAX_SEGMENT_LENGTH = 200;

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export function sanitizeSegment(raw: string): string {
  let sanitized = raw.replace(ILLEGAL_CHARS, "_");
  sanitized = sanitized.replace(CONTROL_CHARS, "_");
  sanitized = sanitized.replace(/\.\.+/g, (match) => "_".repeat(match.length));
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  sanitized = sanitized.replace(TRAILING_DOTS_SPACES, "");

  if (sanitized.length > MAX_SEGMENT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_SEGMENT_LENGTH).trim();
  }

  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    sanitized = "untitled";
  }

  if (WINDOWS_RESERVED_NAMES.has(sanitized.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

export function buildFileName(track: SpotifyTrack): string {
  const artistPart = track.artists.join(", ");
  const rawName = `${artistPart} - ${track.title}`;
  return `${sanitizeSegment(rawName)}.mp3`;
}

export function buildFileNameWithSuffix(track: SpotifyTrack): string {
  const artistPart = track.artists.join(", ");
  const shortId = track.id.slice(0, 8);
  const rawName = `${artistPart} - ${track.title} (${shortId})`;
  return `${sanitizeSegment(rawName)}.mp3`;
}

function assertContained(rootDir: string, candidate: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedCandidate = resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + sep)
  ) {
    throw new PathSecurityError(
      `Resolved path "${resolvedCandidate}" escapes root directory "${resolvedRoot}"`,
    );
  }
  return resolvedCandidate;
}

export function resolvePlaylistDir(config: PlaylistConfig): string {
  const sanitizedName = sanitizeSegment(config.name);
  const candidate = join(config.rootDir, sanitizedName);
  return assertContained(config.rootDir, candidate);
}

export function resolveTrackPath(config: PlaylistConfig, track: SpotifyTrack): string {
  const playlistDir = resolvePlaylistDir(config);
  const candidate = join(playlistDir, buildFileName(track));
  return assertContained(config.rootDir, candidate);
}

export function resolveTrackPathWithSuffix(
  config: PlaylistConfig,
  track: SpotifyTrack,
): string {
  const playlistDir = resolvePlaylistDir(config);
  const candidate = join(playlistDir, buildFileNameWithSuffix(track));
  return assertContained(config.rootDir, candidate);
}
