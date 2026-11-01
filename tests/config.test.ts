import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, extractPlaylistId, parseConfig } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";
import { parseDuration } from "../src/utils/duration.js";

const URL_A = "https://open.spotify.com/playlist/1111111111111111111111";
const URL_B = "https://open.spotify.com/playlist/2222222222222222222222?si=abc";

function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { playlists: [{ name: "Rock", url: URL_A }], ...extra };
}

function rejects(raw: unknown, fragment: string): void {
  assert.throws(
    () => parseConfig(raw),
    (error: unknown) => error instanceof ConfigError && error.message.includes(fragment),
  );
}

test("only playlists are required and everything else has a default", () => {
  const config = parseConfig(minimal());
  assert.equal(config.syncIntervalMs, 86_400_000);
  assert.equal(config.concurrency, 2);
  assert.equal(config.logLevel, "info");
  assert.equal(config.dryRun, false);
  assert.equal(config.fileName, "{artists} - {title}");
  assert.equal(config.audioQuality, "best");
  assert.deepEqual(config.matching, { strict: true, durationToleranceSec: 7, youtubeFallback: true });
  assert.equal(config.random.enabled, false);
  assert.deepEqual(config.playlists, [
    { name: "Rock", url: URL_A, playlistId: "1111111111111111111111", mode: "mirror" },
  ]);
});

test("a playlist mode overrides the default mode", () => {
  const config = parseConfig({
    defaults: { mode: "incremental" },
    playlists: [
      { name: "A", url: URL_A },
      { name: "B", url: URL_B, mode: "mirror" },
    ],
  });
  assert.equal(config.playlists[0]?.mode, "incremental");
  assert.equal(config.playlists[1]?.mode, "mirror");
  assert.equal(config.playlists[1]?.playlistId, "2222222222222222222222");
});

test("parses every documented option", () => {
  const config = parseConfig(
    minimal({
      syncInterval: "6h",
      concurrency: 4,
      logLevel: "debug",
      timezone: "Europe/Madrid",
      dryRun: true,
      defaults: { mode: "incremental", fileName: "{artist} - {title} ({year})" },
      audio: { quality: "320k" },
      matching: { strict: false, durationToleranceSec: 10, youtubeFallback: false },
      random: { enabled: true, name: "Sorpresa", maxTracks: 20, mode: "mirror" },
    }),
  );
  assert.equal(config.syncIntervalMs, 6 * 3_600_000);
  assert.equal(config.concurrency, 4);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.timezone, "Europe/Madrid");
  assert.equal(config.dryRun, true);
  assert.equal(config.fileName, "{artist} - {title} ({year})");
  assert.equal(config.audioQuality, "320k");
  assert.deepEqual(config.matching, { strict: false, durationToleranceSec: 10, youtubeFallback: false });
  assert.deepEqual(config.random, { enabled: true, name: "Sorpresa", maxTracks: 20, mode: "mirror" });
  assert.equal(config.playlists[0]?.mode, "incremental");
});

test("errors name the exact option that is wrong", () => {
  rejects(minimal({ concurrency: 0 }), '"concurrency"');
  rejects(minimal({ syncInterval: "10" }), '"syncInterval"');
  rejects(minimal({ syncInterval: "30s" }), '"syncInterval"');
  rejects(minimal({ logLevel: "verbose" }), '"logLevel"');
  rejects(minimal({ timezone: "Mars/Olympus" }), '"timezone"');
  rejects(minimal({ audio: { quality: "999k" } }), '"audio.quality"');
  rejects(minimal({ defaults: { fileName: "{artists}" } }), "{title}");
  rejects(minimal({ defaults: { fileName: "{title} {genre}" } }), "{genre}");
  rejects({ playlists: [{ name: "A", url: URL_A, mode: "copy" }] }, '"playlists[0].mode"');
  rejects({ playlists: [{ name: "A" }] }, '"playlists[0]" needs both');
  rejects({ playlists: [{ name: "A", url: "https://example.com/x" }] }, '"playlists[0].url"');
  rejects({ playlists: "Rock" }, '"playlists" must be a list');
});

test("unknown options are reported instead of silently ignored", () => {
  rejects(minimal({ concurency: 2 }), 'Unknown option "concurency"');
  rejects(minimal({ matching: { strcit: true } }), 'Unknown option "matching.strcit"');
  rejects({ playlists: [{ name: "A", url: URL_A, dir: "/music" }] }, 'Unknown option "playlists[0].dir"');
});

test("requires at least one playlist unless the random playlist is enabled", () => {
  rejects({ playlists: [] }, "No playlists configured");
  rejects({}, "No playlists configured");
  assert.equal(parseConfig({ random: { enabled: true } }).playlists.length, 0);
});

test("rejects two playlists that would share a folder", () => {
  rejects({ playlists: [{ name: "Rock", url: URL_A }, { name: "rock", url: URL_B }] }, "same folder");
  rejects({ playlists: [{ name: "Aleatoria", url: URL_A }], random: { enabled: true } }, "same folder");
});

test("accepts Spotify playlist links in their common shapes", () => {
  assert.equal(extractPlaylistId("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x"), "37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(extractPlaylistId("https://open.spotify.com/intl-es/playlist/37i9dQZF1DXcBWIGoYBM5M"), "37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(extractPlaylistId("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"), "37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(extractPlaylistId("https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M"), undefined);
});

test("parses human durations", () => {
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("24h"), 86_400_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration("90"), undefined);
  assert.equal(parseDuration("soon"), undefined);
});

test("loadConfig reports a missing file, broken JSON and invalid content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "playlist2mp3-config-"));
  try {
    const good = join(dir, "good.json");
    const broken = join(dir, "broken.json");
    const invalid = join(dir, "invalid.json");
    await writeFile(good, `﻿${JSON.stringify(minimal())}`);
    await writeFile(broken, "{ not json");
    await writeFile(invalid, JSON.stringify({ playlists: [] }));
    assert.equal((await loadConfig(good)).playlists.length, 1);
    await assert.rejects(loadConfig(join(dir, "missing.json")), (e: unknown) => e instanceof ConfigError && e.message.includes("config.example.json"));
    await assert.rejects(loadConfig(broken), (e: unknown) => e instanceof ConfigError && e.message.includes("not valid JSON"));
    await assert.rejects(loadConfig(invalid), (e: unknown) => e instanceof ConfigError && e.message.includes("invalid.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the example configuration file is valid", async () => {
  const config = await loadConfig(join(process.cwd(), "config", "config.example.json"));
  assert.equal(config.playlists.length > 0, true);
});
