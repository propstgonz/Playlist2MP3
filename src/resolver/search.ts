import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Candidate, CandidateSource, SpotifyTrack } from "../types/index.js";
import { errorMessage } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const SEARCH_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export const RESULTS_PER_SOURCE = 5;
export const COMMON_ARGS: readonly string[] = ["--js-runtimes", "node", "--no-warnings", "--no-progress"];

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

interface YtDlpEntry {
  readonly webpage_url?: string | null;
  readonly title?: string | null;
  readonly track?: string | null;
  readonly artists?: readonly string[] | null;
  readonly artist?: string | null;
  readonly channel?: string | null;
  readonly uploader?: string | null;
  readonly album?: string | null;
  readonly duration?: number | null;
}

interface YtDlpResult {
  readonly entries?: readonly (YtDlpEntry | null)[];
}

export type CommandRunner = (
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<string>;

function partialStdout(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("stdout" in error)) {
    return undefined;
  }
  const stdout = (error as { stdout: unknown }).stdout;
  return typeof stdout === "string" && stdout.trim().startsWith("{") ? stdout : undefined;
}

export const runYtDlp: CommandRunner = async (args, options) => {
  try {
    const result = await execFileAsync("yt-dlp", [...args], {
      timeout: options.timeoutMs,
      signal: options.signal,
      maxBuffer: MAX_BUFFER,
    });
    return result.stdout;
  } catch (error) {
    const stdout = partialStdout(error);
    if (stdout !== undefined) {
      return stdout;
    }
    throw error;
  }
};

export function buildQuery(track: SpotifyTrack): string {
  const title = track.title.replace(/\s[-–]\s[^-]*remaster[^-]*$/i, "").trim();
  return `${track.artists.slice(0, 2).join(" ")} ${title}`;
}

export function searchArgs(source: CandidateSource, query: string): string[] {
  const target =
    source === "ytmusic"
      ? `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`
      : `ytsearch${RESULTS_PER_SOURCE}:${query}`;
  return [
    target,
    "--dump-single-json",
    "--skip-download",
    "--playlist-end",
    String(RESULTS_PER_SOURCE),
    "--ignore-errors",
    ...COMMON_ARGS,
  ];
}

function splitArtists(entry: YtDlpEntry): string[] {
  if (entry.artists && entry.artists.length > 0) {
    return [...new Set(entry.artists)];
  }
  if (entry.artist) {
    return [...new Set(entry.artist.split(/\s*[,，]\s*/).filter((name) => name !== ""))];
  }
  return [];
}

export function parseSearchOutput(stdout: string, source: CandidateSource): Candidate[] {
  let parsed: YtDlpResult;
  try {
    parsed = JSON.parse(stdout) as YtDlpResult;
  } catch (error) {
    throw new SearchError(`yt-dlp returned invalid JSON: ${errorMessage(error)}`);
  }
  return (parsed.entries ?? []).flatMap((entry) => {
    if (!entry?.webpage_url || !entry.title) {
      return [];
    }
    return [
      {
        source,
        url: entry.webpage_url,
        title: entry.title,
        track: entry.track ?? undefined,
        artists: splitArtists(entry),
        channel: entry.channel ?? entry.uploader ?? "",
        album: entry.album ?? undefined,
        durationSec: typeof entry.duration === "number" ? entry.duration : undefined,
      },
    ];
  });
}

export async function searchCandidates(
  source: CandidateSource,
  query: string,
  run: CommandRunner,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  let stdout: string;
  try {
    stdout = await run(searchArgs(source, query), { timeoutMs: SEARCH_TIMEOUT_MS, signal });
  } catch (error) {
    throw new SearchError(`yt-dlp ${source} search failed for "${query}": ${errorMessage(error)}`);
  }
  return parseSearchOutput(stdout, source);
}
