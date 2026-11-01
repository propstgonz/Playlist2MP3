import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candidate } from "../src/types/index.js";
import { detectVariants, evaluateCandidates } from "../src/resolver/match.js";
import { coreTitle, normalizeText } from "../src/resolver/normalize.js";
import { makeTrack } from "./helpers.js";

const OPTIONS = { durationToleranceSec: 7 };

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    source: "ytmusic",
    url: `https://www.youtube.com/watch?v=${Math.random().toString(36).slice(2, 13)}`,
    title: "Song",
    track: undefined,
    artists: [],
    channel: "",
    album: undefined,
    durationSec: 200,
    ...overrides,
  };
}

const bohemian = makeTrack("bohemian", "Bohemian Rhapsody - Remastered 2011", {
  artists: ["Queen"],
  album: "A Night At The Opera (2011 Remaster)",
  durationMs: 354_320,
});

const bohemianCandidates: Candidate[] = [
  candidate({ title: "Bohemian Rhapsody", track: "Bohemian Rhapsody", artists: ["Alex Goot", "Sam Tsui"], channel: "Alex Goot", album: "Bohemian Rhapsody", durationSec: 356 }),
  candidate({ title: "Bohemian Rhapsody", track: "Bohemian Rhapsody", artists: ["Sungha Jung"], channel: "Sungha Jung", album: "Sungha Jung Cover Compilation 11", durationSec: 367 }),
  candidate({ title: "Bohemian Rhapsody (Live Aid)", track: "Bohemian Rhapsody (Live Aid)", artists: ["Queen"], channel: "Queen - Topic", album: "Live Aid", durationSec: 357 }),
  candidate({ url: "https://www.youtube.com/watch?v=BSTsnWoslP4", title: "Bohemian Rhapsody", track: "Bohemian Rhapsody", artists: ["Queen"], channel: "Queen Official", album: "A Night At The Opera", durationSec: 354 }),
  candidate({ title: "Bohemian Rhapsody x Walk It Talk It", track: "Bohemian Rhapsody x Walk It Talk It", artists: ["nimphia", "Freddie Mercury"], channel: "nimphia - Topic", durationSec: 114 }),
];

test("picks the studio recording over covers, tributes, live and mashups", () => {
  const result = evaluateCandidates(bohemian, bohemianCandidates, OPTIONS);
  assert.equal(result.best?.candidate.url, "https://www.youtube.com/watch?v=BSTsnWoslP4");
});

test("rejects a live version even when everything else matches perfectly", () => {
  const live = bohemianCandidates[2] as Candidate;
  const result = evaluateCandidates(bohemian, [live], OPTIONS);
  assert.equal(result.best, undefined);
  assert.deepEqual(result.verdicts[0]?.rejections, ["live version"]);
});

test("requires the live version when the Spotify track itself is live", () => {
  const liveTrack = makeTrack("live", "Bohemian Rhapsody - Live Aid", { artists: ["Queen"], durationMs: 357_000 });
  const result = evaluateCandidates(liveTrack, bohemianCandidates, OPTIONS);
  assert.equal(result.best?.candidate.title, "Bohemian Rhapsody (Live Aid)");
});

test("rejects candidates outside the duration tolerance", () => {
  const rasputin = makeTrack("r", "Rasputin", { artists: ["Boney M."], durationMs: 221_000 });
  const result = evaluateCandidates(
    rasputin,
    [
      candidate({ title: "Rasputin", track: "Rasputin", artists: ["Boney M."], album: "Nightflight to Venus", durationSec: 352 }),
      candidate({ source: "youtube", title: "Boney M - Rasputin (Lyrics)", channel: "7clouds", durationSec: 221 }),
    ],
    OPTIONS,
  );
  assert.equal(result.best?.candidate.title, "Boney M - Rasputin (Lyrics)");
  assert.deepEqual(result.verdicts.find((v) => v.candidate.durationSec === 352)?.rejections, ["duration +131s"]);
});

test("rejects karaoke, sped up, remix and instrumental uploads", () => {
  const track = makeTrack("t", "Moskau", { artists: ["Dschinghis Khan"], durationMs: 270_000 });
  const fakes = [
    "Moskau (Karaoke Version)",
    "Moskau (Sped Up)",
    "Moskau (Remix)",
    "Moskau (Instrumental)",
    "Moskau - Nightcore",
    "Moskau (8D Audio)",
  ].map((title) => candidate({ source: "youtube", title, channel: "Dschinghis Khan", durationSec: 270 }));
  assert.equal(evaluateCandidates(track, fakes, OPTIONS).best, undefined);
});

test("matches whole words only, so 'alive' is not a live version", () => {
  assert.equal(detectVariants(normalizeText("Staying Alive")).has("live"), false);
  assert.equal(detectVariants(normalizeText("Delivery Man")).has("live"), false);
  assert.equal(detectVariants(normalizeText("Song (Live at Wembley)")).has("live"), true);
  assert.equal(detectVariants(normalizeText("Canción (En Vivo)")).has("live"), true);
  const track = makeTrack("t", "Stayin' Alive", { artists: ["Bee Gees"], durationMs: 285_000 });
  const result = evaluateCandidates(
    track,
    [candidate({ title: "Stayin' Alive", track: "Stayin' Alive", artists: ["Bee Gees"], durationSec: 285 })],
    OPTIONS,
  );
  assert.notEqual(result.best, undefined);
});

test("rejects a result by a different artist with the same title", () => {
  const track = makeTrack("t", "Hello", { artists: ["Adele"], durationMs: 295_000 });
  const result = evaluateCandidates(
    track,
    [candidate({ title: "Hello", track: "Hello", artists: ["Lionel Richie"], channel: "Lionel Richie - Topic", durationSec: 293 })],
    OPTIONS,
  );
  assert.equal(result.best, undefined);
  assert.deepEqual(result.verdicts[0]?.rejections, ["artist not found"]);
});

test("recognises the artist in a YouTube video title, channel or VEVO name", () => {
  const track = makeTrack("t", "Smooth Criminal", { artists: ["Michael Jackson"], durationMs: 257_000 });
  const viaTitle = candidate({ source: "youtube", title: "Michael Jackson - Smooth Criminal (Official Video)", channel: "Random Uploads", durationSec: 258 });
  const viaVevo = candidate({ source: "youtube", title: "Smooth Criminal", channel: "michaeljacksonVEVO", durationSec: 258 });
  assert.notEqual(evaluateCandidates(track, [viaTitle], OPTIONS).best, undefined);
  assert.notEqual(evaluateCandidates(track, [viaVevo], OPTIONS).best, undefined);
});

test("ignores accents, remaster tags, featuring credits and video noise when comparing titles", () => {
  assert.equal(coreTitle("Canción del Mariachi - Remastered 2004", true), "cancion del mariachi");
  assert.equal(coreTitle("Song (feat. Someone) [Official Video]", false), "song");
  assert.equal(coreTitle("Smooth Criminal (2012 Remaster)", true), "smooth criminal");
  assert.equal(coreTitle("Paint It, Black", true), "paint it black");
});

test("prefers YouTube Music over a plain YouTube upload of the same recording", () => {
  const track = makeTrack("t", "Thriller", { artists: ["Michael Jackson"], durationMs: 357_000 });
  const result = evaluateCandidates(
    track,
    [
      candidate({ source: "youtube", url: "https://www.youtube.com/watch?v=yt", title: "Michael Jackson - Thriller (Audio)", channel: "Michael Jackson", durationSec: 357 }),
      candidate({ source: "ytmusic", url: "https://www.youtube.com/watch?v=ytm", title: "Thriller", track: "Thriller", artists: ["Michael Jackson"], durationSec: 357 }),
    ],
    OPTIONS,
  );
  assert.equal(result.best?.candidate.url, "https://www.youtube.com/watch?v=ytm");
});

test("drops duplicate videos found on both YouTube Music and YouTube", () => {
  const track = makeTrack("t", "Song", { artists: ["Artist"] });
  const result = evaluateCandidates(
    track,
    [
      candidate({ url: "https://music.youtube.com/watch?v=same", title: "Song", artists: ["Artist"] }),
      candidate({ source: "youtube", url: "https://www.youtube.com/watch?v=same", title: "Artist - Song", channel: "Artist" }),
    ],
    OPTIONS,
  );
  assert.equal(result.verdicts.length, 1);
});
