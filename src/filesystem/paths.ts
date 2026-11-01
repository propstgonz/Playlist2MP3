import { join, resolve, sep } from "node:path";
import type { SpotifyTrack } from "../types/index.js";

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
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
const MAX_SEGMENT_LENGTH = 200;

export const FILE_NAME_PLACEHOLDERS: readonly string[] = ["artists", "artist", "title", "album", "year"];

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

export function renderFileName(template: string, track: SpotifyTrack): string {
  const values: Record<string, string> = {
    artists: track.artists.join(", "),
    artist: track.artists[0] ?? "",
    title: track.title,
    album: track.album ?? "",
    year: track.releaseYear === undefined ? "" : String(track.releaseYear),
  };
  const rendered = template
    .replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "")
    .replace(/\s*-\s*-\s*/g, " - ")
    .replace(/^[\s-]+|[\s-]+$/g, "");
  return `${sanitizeSegment(rendered)}.mp3`;
}

export function withIdSuffix(fileName: string, trackId: string): string {
  const base = fileName.replace(/\.mp3$/i, "");
  return `${base} (${trackId.slice(0, 8)}).mp3`;
}

export function assertContained(rootDir: string, candidate: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + sep)) {
    throw new PathSecurityError(
      `Resolved path "${resolvedCandidate}" escapes root directory "${resolvedRoot}"`,
    );
  }
  return resolvedCandidate;
}

export function playlistDir(musicDir: string, playlistName: string): string {
  return assertContained(musicDir, join(musicDir, sanitizeSegment(playlistName)));
}

export function fileInDir(dir: string, fileName: string): string {
  return assertContained(dir, join(dir, sanitizeSegment(fileName)));
}
