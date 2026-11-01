import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, parseSearchOutput, searchArgs, searchCandidates, SearchError, type CommandRunner } from "../src/resolver/search.js";
import { NoMatchError, resolveSource } from "../src/resolver/resolve.js";
import { downloadArgs } from "../src/downloader/download.js";
import { rootLogger } from "../src/utils/logger.js";
import { makeTrack } from "./helpers.js";

const YTM_OUTPUT = JSON.stringify({
  entries: [
    null,
    {
      webpage_url: "https://www.youtube.com/watch?v=BSTsnWoslP4",
      title: "Bohemian Rhapsody",
      track: "Bohemian Rhapsody",
      artists: ["Queen", "Queen"],
      channel: "Queen Official",
      album: "A Night At The Opera",
      duration: 354,
    },
    {
      webpage_url: "https://www.youtube.com/watch?v=x",
      title: "Bohemian Rhapsody",
      artist: "Royal Philharmonic Orchestra， The Royal Choral Society",
      uploader: "RPO",
      duration: 378,
    },
  ],
});

test("parses yt-dlp search output into candidates", () => {
  const candidates = parseSearchOutput(YTM_OUTPUT, "ytmusic");
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0]?.artists, ["Queen"]);
  assert.equal(candidates[0]?.album, "A Night At The Opera");
  assert.equal(candidates[0]?.durationSec, 354);
  assert.deepEqual(candidates[1]?.artists, ["Royal Philharmonic Orchestra", "The Royal Choral Society"]);
  assert.equal(candidates[1]?.channel, "RPO");
});

test("builds search queries and yt-dlp arguments", () => {
  const track = makeTrack("t", "Bohemian Rhapsody - Remastered 2011", { artists: ["Queen", "A", "B"] });
  assert.equal(buildQuery(track), "Queen A Bohemian Rhapsody");
  assert.equal(buildQuery(makeTrack("t", "Song - Live at Wembley")), "Artist Song - Live at Wembley");
  assert.equal(searchArgs("ytmusic", "a b")[0], "https://music.youtube.com/search?q=a%20b#songs");
  assert.equal(searchArgs("youtube", "a b")[0], "ytsearch5:a b");
  const download = downloadArgs("https://u", "/tmp/x", "320k");
  assert.equal(download[download.indexOf("--audio-quality") + 1], "320K");
  const best = downloadArgs("https://u", "/tmp/x", "best");
  assert.equal(best[best.indexOf("--audio-quality") + 1], "0");
});

test("wraps yt-dlp failures in a SearchError", async () => {
  const failing: CommandRunner = async () => {
    throw new Error("network down");
  };
  await assert.rejects(searchCandidates("ytmusic", "q", failing), SearchError);
});

function runnerFor(outputs: Record<"ytmusic" | "youtube", string>, calls: string[] = []): CommandRunner {
  return async (args) => {
    const source = String(args[0]).startsWith("https://music.youtube.com") ? "ytmusic" : "youtube";
    calls.push(source);
    return outputs[source];
  };
}

const bohemian = makeTrack("t", "Bohemian Rhapsody", { artists: ["Queen"], durationMs: 354_000 });
const liveOnly = JSON.stringify({
  entries: [{ webpage_url: "https://www.youtube.com/watch?v=live", title: "Bohemian Rhapsody (Live)", artists: ["Queen"], duration: 360 }],
});
const settings = { strict: true, durationToleranceSec: 7, youtubeFallback: true };

test("stops after YouTube Music when it has a faithful match", async () => {
  const calls: string[] = [];
  const result = await resolveSource(bohemian, settings, runnerFor({ ytmusic: YTM_OUTPUT, youtube: liveOnly }, calls), rootLogger);
  assert.equal(result.candidate.url, "https://www.youtube.com/watch?v=BSTsnWoslP4");
  assert.deepEqual(calls, ["ytmusic"]);
});

test("falls back to YouTube, then refuses doubtful matches in strict mode", async () => {
  const calls: string[] = [];
  const run = runnerFor({ ytmusic: liveOnly, youtube: JSON.stringify({ entries: [] }) }, calls);
  await assert.rejects(resolveSource(bohemian, settings, run, rootLogger), NoMatchError);
  assert.deepEqual(calls, ["ytmusic", "youtube"]);
});

test("accepts the closest doubtful match when strict is off", async () => {
  const run = runnerFor({ ytmusic: liveOnly, youtube: JSON.stringify({ entries: [] }) });
  const result = await resolveSource(bohemian, { ...settings, strict: false }, run, rootLogger);
  assert.equal(result.doubtful, true);
  assert.equal(result.candidate.url, "https://www.youtube.com/watch?v=live");
});

test("skips YouTube when the fallback is disabled", async () => {
  const calls: string[] = [];
  const run = runnerFor({ ytmusic: liveOnly, youtube: YTM_OUTPUT }, calls);
  await assert.rejects(resolveSource(bohemian, { ...settings, youtubeFallback: false }, run, rootLogger), NoMatchError);
  assert.deepEqual(calls, ["ytmusic"]);
});
