import type { Candidate, SpotifyTrack } from "../types/index.js";
import { formatClock } from "../utils/duration.js";
import {
  containsPhrase,
  coreTitle,
  normalizeArtist,
  normalizeText,
  titleSimilarity,
} from "./normalize.js";

const VARIANTS: Readonly<Record<string, readonly string[]>> = {
  live: ["live", "en vivo", "ao vivo", "en directo", "directo", "concierto", "en concierto", "concert", "in concert", "unplugged", "live session", "tour"],
  acoustic: ["acoustic", "acustico", "acustica", "unplugged", "stripped"],
  cover: ["cover", "covers", "tribute", "tributo", "karaoke", "originally performed", "in the style of", "made famous"],
  instrumental: ["instrumental", "backing track", "minus one", "playback"],
  remix: ["remix", "remixes", "rmx", "bootleg", "mashup", "club mix", "extended mix", "dub mix", "vip mix"],
  altered: ["sped up", "speed up", "slowed", "reverb", "nightcore", "8d", "bass boosted", "daycore", "chopped"],
  other: ["reaction", "tutorial", "lesson", "how to play", "full album", "demo", "rehearsal", "piano version", "orchestral", "symphonic", "medley", "parody"],
};

const MIN_TITLE_SIMILARITY = 0.65;
const REJECTION_PENALTY = 30;

export interface MatchOptions {
  readonly durationToleranceSec: number;
}

export interface CandidateVerdict {
  readonly candidate: Candidate;
  readonly score: number;
  readonly rejections: readonly string[];
  readonly durationDiffSec: number | undefined;
}

export interface MatchResult {
  readonly best: CandidateVerdict | undefined;
  readonly verdicts: readonly CandidateVerdict[];
}

export function detectVariants(normalized: string): Set<string> {
  const found = new Set<string>();
  for (const [category, phrases] of Object.entries(VARIANTS)) {
    if (phrases.some((phrase) => containsPhrase(normalized, phrase))) {
      found.add(category);
    }
  }
  return found;
}

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

function artistMatch(track: SpotifyTrack, candidate: Candidate): { matched: boolean; official: boolean } {
  const candidateArtists = candidate.artists.map(normalizeArtist);
  const channel = normalizeText(candidate.channel.replace(/vevo$/i, "").replace(/\s-\stopic$/i, ""));
  const haystack = [...candidateArtists, channel, normalizeText(candidate.title)].join(" ");
  let matched = false;
  let official = false;
  for (const artist of track.artists.map(normalizeArtist)) {
    const inText =
      containsPhrase(haystack, artist) ||
      (compact(artist).length >= 5 && compact(haystack).includes(compact(artist)));
    if (inText) {
      matched = true;
    }
    if (candidateArtists.includes(artist) || (/\s-\stopic$/i.test(candidate.channel) && channel === artist)) {
      official = true;
    }
  }
  return { matched, official };
}

function candidateTitleSimilarity(track: SpotifyTrack, candidate: Candidate): number {
  const expected = coreTitle(track.title, true);
  const options: string[] = [];
  if (candidate.track !== undefined) {
    options.push(coreTitle(candidate.track, true));
  }
  let fromTitle = ` ${coreTitle(candidate.title, false)} `;
  for (const artist of [...track.artists, ...candidate.artists]) {
    const name = normalizeText(artist);
    if (name !== "") {
      fromTitle = fromTitle.split(` ${name} `).join(" ");
    }
  }
  options.push(fromTitle.trim());
  return Math.max(...options.map((option) => titleSimilarity(expected, option)));
}

export function evaluateCandidate(
  track: SpotifyTrack,
  candidate: Candidate,
  options: MatchOptions,
): CandidateVerdict {
  const rejections: string[] = [];
  let score = 0;

  const targetSec = track.durationMs / 1000;
  const durationDiffSec = candidate.durationSec === undefined ? undefined : candidate.durationSec - targetSec;
  if (durationDiffSec === undefined) {
    rejections.push("no duration");
  } else if (Math.abs(durationDiffSec) > options.durationToleranceSec) {
    rejections.push(`duration ${durationDiffSec > 0 ? "+" : ""}${Math.round(durationDiffSec)}s`);
  } else {
    score += 25 * (1 - Math.abs(durationDiffSec) / options.durationToleranceSec);
  }

  const expectedVariants = detectVariants(normalizeText(`${track.title} ${track.album ?? ""}`));
  const candidateVariants = detectVariants(
    normalizeText(`${candidate.title} ${candidate.track ?? ""} ${candidate.album ?? ""}`),
  );
  for (const variant of candidateVariants) {
    if (!expectedVariants.has(variant)) {
      rejections.push(`${variant} version`);
    }
  }
  for (const variant of expectedVariants) {
    if (!candidateVariants.has(variant)) {
      score -= 15;
    }
  }

  const similarity = candidateTitleSimilarity(track, candidate);
  score += 40 * similarity;
  if (similarity < MIN_TITLE_SIMILARITY) {
    rejections.push(`title differs (${Math.round(similarity * 100)}%)`);
  }

  const artist = artistMatch(track, candidate);
  if (artist.matched) {
    score += 25 + (artist.official ? 5 : 0);
  } else {
    rejections.push("artist not found");
  }

  if (
    track.album !== undefined &&
    candidate.album !== undefined &&
    coreTitle(track.album, true) === coreTitle(candidate.album, true)
  ) {
    score += 10;
  }
  if (candidate.source === "ytmusic") {
    score += 10;
  }

  return {
    candidate,
    score: Math.round(score - rejections.length * REJECTION_PENALTY),
    rejections,
    durationDiffSec,
  };
}

export function evaluateCandidates(
  track: SpotifyTrack,
  candidates: readonly Candidate[],
  options: MatchOptions,
): MatchResult {
  const seen = new Set<string>();
  const verdicts = candidates
    .filter((candidate) => {
      const id = candidate.url.replace(/^https?:\/\/(?:music|www)\./, "");
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    })
    .map((candidate) => evaluateCandidate(track, candidate, options))
    .sort((a, b) => b.score - a.score);
  return { best: verdicts.find((verdict) => verdict.rejections.length === 0), verdicts };
}

export function describeVerdict(verdict: CandidateVerdict): string {
  const { candidate } = verdict;
  const duration =
    candidate.durationSec === undefined
      ? "?:??"
      : `${formatClock(candidate.durationSec)} (${(verdict.durationDiffSec ?? 0) >= 0 ? "+" : ""}${Math.round(verdict.durationDiffSec ?? 0)}s)`;
  const artists = candidate.artists.length > 0 ? candidate.artists.join(", ") : candidate.channel;
  const status = verdict.rejections.length === 0 ? "OK" : `REJECTED: ${verdict.rejections.join(", ")}`;
  return (
    `[${candidate.source}] score ${verdict.score} | "${candidate.track ?? candidate.title}" - ${artists}` +
    `${candidate.album ? ` | album "${candidate.album}"` : ""} | ${duration} | ${status} | ${candidate.url}`
  );
}
