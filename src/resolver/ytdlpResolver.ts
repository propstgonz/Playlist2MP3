import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedSource, SpotifyTrack } from "../types/index.js";

const execFileAsync = promisify(execFile);
const SEARCH_RESULT_COUNT = 5;
const DURATION_TOLERANCE_SEC = 15;
const SEARCH_TIMEOUT_MS = 30_000;
const UNWANTED_KEYWORDS = ["live", "cover", "remix", "karaoke", "8d audio", "reaction"];

export interface YtDlpSearchEntry {
  readonly webpage_url: string;
  readonly title: string;
  readonly duration: number | null;
}

interface YtDlpSearchResult {
  readonly entries?: readonly YtDlpSearchEntry[];
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

function containsUnwantedKeyword(candidateTitle: string, originalTitle: string): boolean {
  const lowerCandidate = candidateTitle.toLowerCase();
  const lowerOriginal = originalTitle.toLowerCase();
  return UNWANTED_KEYWORDS.some(
    (keyword) => lowerCandidate.includes(keyword) && !lowerOriginal.includes(keyword),
  );
}

export function scoreCandidate(entry: YtDlpSearchEntry, track: SpotifyTrack): number {
  if (entry.duration === null) {
    return -Infinity;
  }
  const targetDurationSec = track.durationMs / 1000;
  const durationDiff = Math.abs(entry.duration - targetDurationSec);

  if (entry.duration > targetDurationSec * 2) {
    return -Infinity;
  }

  let score = 100 - durationDiff;

  const lowerCandidate = entry.title.toLowerCase();
  const artistMatches = track.artists.filter((artist) =>
    lowerCandidate.includes(artist.toLowerCase()),
  ).length;
  score += artistMatches * 10;

  if (lowerCandidate.includes(track.title.toLowerCase())) {
    score += 20;
  }

  if (containsUnwantedKeyword(entry.title, track.title)) {
    score -= 50;
  }

  if (durationDiff <= DURATION_TOLERANCE_SEC) {
    score += 30;
  }

  return score;
}

export function selectBestCandidate(
  entries: readonly YtDlpSearchEntry[],
  track: SpotifyTrack,
): YtDlpSearchEntry | undefined {
  let bestEntry: YtDlpSearchEntry | undefined;
  let bestScore = -Infinity;
  for (const entry of entries) {
    const score = scoreCandidate(entry, track);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  return bestScore === -Infinity ? undefined : bestEntry;
}

export async function resolveTrack(
  track: SpotifyTrack,
  signal?: AbortSignal,
): Promise<ResolvedSource> {
  const query = `${track.artists.join(" ")} ${track.title}`;
  const searchTerm = `ytsearch${SEARCH_RESULT_COUNT}:${query}`;

  let stdout: string;
  try {
    const result = await execFileAsync(
      "yt-dlp",
      [searchTerm, "--dump-single-json", "--no-playlist", "--skip-download", "--no-warnings"],
      { timeout: SEARCH_TIMEOUT_MS, signal, maxBuffer: 10 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new ResolutionError(
      `yt-dlp search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: YtDlpSearchResult;
  try {
    parsed = JSON.parse(stdout) as YtDlpSearchResult;
  } catch {
    throw new ResolutionError(`yt-dlp returned invalid JSON for query "${query}"`);
  }

  const entries = parsed.entries ?? [];
  if (entries.length === 0) {
    throw new ResolutionError(`No search results found for "${query}"`);
  }

  const bestEntry = selectBestCandidate(entries, track);
  if (!bestEntry) {
    throw new ResolutionError(`No acceptable match found for "${query}"`);
  }

  return {
    sourceUrl: bestEntry.webpage_url,
    sourceTitle: bestEntry.title,
    durationSec: bestEntry.duration ?? 0,
  };
}
