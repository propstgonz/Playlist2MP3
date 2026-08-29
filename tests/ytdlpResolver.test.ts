import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCandidate,
  selectBestCandidate,
  extractPartialStdout,
  pickBestFromSearchResult,
  ResolutionError,
  type YtDlpSearchEntry,
} from "../src/resolver/ytdlpResolver.js";
import type { SpotifyTrack } from "../src/types/index.js";

function makeTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: "t1",
    title: "Bohemian Rhapsody",
    artists: ["Queen"],
    durationMs: 354_000,
    trackNumber: 1,
    releaseYear: 1975,
    coverUrl: undefined,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<YtDlpSearchEntry> = {}): YtDlpSearchEntry {
  return {
    webpage_url: "https://youtube.com/watch?v=x",
    title: "Queen - Bohemian Rhapsody",
    duration: 354,
    ...overrides,
  };
}

test("rejects a candidate with no duration information", () => {
  const score = scoreCandidate(makeEntry({ duration: null }), makeTrack());
  assert.equal(score, -Infinity);
});

test("rejects a candidate more than twice the target duration", () => {
  const score = scoreCandidate(makeEntry({ duration: 354 * 3 }), makeTrack());
  assert.equal(score, -Infinity);
});

test("scores an exact artist and title match with matching duration highest", () => {
  const exact = scoreCandidate(makeEntry({ title: "Queen - Bohemian Rhapsody", duration: 354 }), makeTrack());
  const noArtist = scoreCandidate(makeEntry({ title: "Bohemian Rhapsody cover", duration: 354 }), makeTrack());
  assert.equal(exact > noArtist, true);
});

test("penalizes unwanted keywords like live or cover not present in the original title", () => {
  const clean = scoreCandidate(makeEntry({ title: "Queen - Bohemian Rhapsody", duration: 354 }), makeTrack());
  const live = scoreCandidate(
    makeEntry({ title: "Queen - Bohemian Rhapsody (Live at Wembley)", duration: 354 }),
    makeTrack(),
  );
  assert.equal(clean > live, true);
});

test("does not penalize a keyword that is genuinely part of the original title", () => {
  const track = makeTrack({ title: "Roar (Live Version)" });
  const score = scoreCandidate(
    makeEntry({ title: "Artist - Roar (Live Version)", duration: 354 }),
    track,
  );
  assert.equal(score > 0, true);
});

test("rewards a duration within tolerance over one further away", () => {
  const close = scoreCandidate(makeEntry({ duration: 356 }), makeTrack());
  const far = scoreCandidate(makeEntry({ duration: 330 }), makeTrack());
  assert.equal(close > far, true);
});

test("selectBestCandidate picks the highest scoring entry", () => {
  const track = makeTrack();
  const best = selectBestCandidate(
    [
      makeEntry({ webpage_url: "u1", title: "Random unrelated video", duration: 40 }),
      makeEntry({ webpage_url: "u2", title: "Queen - Bohemian Rhapsody", duration: 354 }),
      makeEntry({ webpage_url: "u3", title: "Queen - Bohemian Rhapsody (Cover)", duration: 354 }),
    ],
    track,
  );
  assert.equal(best?.webpage_url, "u2");
});

test("selectBestCandidate returns undefined when every candidate is rejected", () => {
  const track = makeTrack();
  const best = selectBestCandidate(
    [makeEntry({ duration: null }), makeEntry({ duration: 354 * 3 })],
    track,
  );
  assert.equal(best, undefined);
});

test("selectBestCandidate returns undefined for an empty list", () => {
  assert.equal(selectBestCandidate([], makeTrack()), undefined);
});

test("extractPartialStdout recovers usable results from a yt-dlp error carrying valid JSON", () => {
  const error = Object.assign(new Error("Command failed"), {
    stdout: JSON.stringify({ entries: [{ webpage_url: "u", title: "t", duration: 100 }] }),
  });
  assert.equal(extractPartialStdout(error), error.stdout);
});

test("extractPartialStdout returns undefined when stdout has no entries", () => {
  const error = Object.assign(new Error("Command failed"), {
    stdout: JSON.stringify({ entries: [] }),
  });
  assert.equal(extractPartialStdout(error), undefined);
});

test("extractPartialStdout returns undefined when stdout is not valid JSON", () => {
  const error = Object.assign(new Error("Command failed"), { stdout: "not json" });
  assert.equal(extractPartialStdout(error), undefined);
});

test("extractPartialStdout returns undefined when the error carries no stdout", () => {
  assert.equal(extractPartialStdout(new Error("Command failed")), undefined);
});

test("extractPartialStdout returns undefined for a non-error value", () => {
  assert.equal(extractPartialStdout("not an error"), undefined);
});

test("pickBestFromSearchResult skips a null entry (unavailable video) and still picks a match", () => {
  const track = makeTrack();
  const result = pickBestFromSearchResult(
    {
      entries: [
        null,
        { webpage_url: "u2", title: "Queen - Bohemian Rhapsody", duration: 354 },
      ],
    },
    track,
    "Queen Bohemian Rhapsody",
  );
  assert.equal(result.sourceUrl, "u2");
});

test("pickBestFromSearchResult throws ResolutionError when every entry is null", () => {
  assert.throws(
    () => pickBestFromSearchResult({ entries: [null, null] }, makeTrack(), "query"),
    ResolutionError,
  );
});

test("pickBestFromSearchResult throws ResolutionError when entries is missing", () => {
  assert.throws(() => pickBestFromSearchResult({}, makeTrack(), "query"), ResolutionError);
});
