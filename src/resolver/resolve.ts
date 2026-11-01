import type { Candidate, MatchingSettings, SpotifyTrack } from "../types/index.js";
import { errorMessage, type Logger } from "../utils/logger.js";
import { NonRetryableError, withRetry } from "../utils/retry.js";
import { describeVerdict, evaluateCandidates, type MatchResult } from "./match.js";
import { buildQuery, searchCandidates, type CommandRunner } from "./search.js";

export class NoMatchError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "NoMatchError";
  }
}

export interface ResolvedSource {
  readonly candidate: Candidate;
  readonly doubtful: boolean;
}

async function trySearch(
  source: Candidate["source"],
  query: string,
  run: CommandRunner,
  logger: Logger,
  signal?: AbortSignal,
): Promise<Candidate[] | Error> {
  try {
    return await withRetry(() => searchCandidates(source, query, run, signal), { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.debug(`Search on ${source} failed: ${errorMessage(error)}`);
    return error instanceof Error ? error : new Error(String(error));
  }
}

function logVerdicts(logger: Logger, result: MatchResult): void {
  for (const verdict of result.verdicts) {
    logger.debug(`  ${describeVerdict(verdict)}`);
  }
}

export async function resolveSource(
  track: SpotifyTrack,
  settings: MatchingSettings,
  run: CommandRunner,
  logger: Logger,
  signal?: AbortSignal,
): Promise<ResolvedSource> {
  const query = buildQuery(track);
  const options = { durationToleranceSec: settings.durationToleranceSec };
  logger.debug(`Searching "${query}" (Spotify duration ${Math.round(track.durationMs / 1000)}s)`);

  const candidates: Candidate[] = [];
  const failures: Error[] = [];
  const sources: Candidate["source"][] = settings.youtubeFallback ? ["ytmusic", "youtube"] : ["ytmusic"];
  let result: MatchResult = { best: undefined, verdicts: [] };

  for (const source of sources) {
    const found = await trySearch(source, query, run, logger, signal);
    if (found instanceof Error) {
      failures.push(found);
      continue;
    }
    candidates.push(...found);
    result = evaluateCandidates(track, candidates, options);
    if (result.best !== undefined) {
      break;
    }
  }

  if (candidates.length === 0 && failures.length > 0) {
    throw failures[0];
  }
  logVerdicts(logger, result);

  if (result.best !== undefined) {
    return { candidate: result.best.candidate, doubtful: false };
  }
  const fallback = result.verdicts.find((verdict) => verdict.candidate.durationSec !== undefined);
  if (!settings.strict && fallback !== undefined) {
    logger.warn(
      `No faithful match for "${track.title}"; downloading the closest one because matching.strict is false: ${describeVerdict(fallback)}`,
    );
    return { candidate: fallback.candidate, doubtful: true };
  }

  const reasons = result.verdicts
    .slice(0, 3)
    .map((verdict) => `"${verdict.candidate.title}" (${verdict.rejections.join(", ")})`)
    .join("; ");
  throw new NoMatchError(
    `no faithful version found among ${result.verdicts.length} results` +
      (reasons === "" ? "" : `: ${reasons}`) +
      ". Set logLevel to \"debug\" to see every candidate, or matching.strict to false to accept the closest one",
  );
}
