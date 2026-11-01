import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config/index.js";

const FILE_CONFIG = {
  playlists: [{ name: "Rock", url: "https://open.spotify.com/playlist/1111111111111111111111" }],
};

function baseEnv(): NodeJS.ProcessEnv {
  return {};
}

test("loads defaults when optional variables are absent", () => {
  const config = loadConfig(baseEnv(), FILE_CONFIG);
  assert.equal(config.syncIntervalSec, 86400);
  assert.equal(config.downloadConcurrency, 2);
  assert.equal(config.tempDir, "/tmp/playlist2mp3");
  assert.equal(config.playlists.length, 1);
  assert.equal(config.maxSizeBytes, 0);
  assert.equal(config.randomPlaylist, undefined);
});

test("treats an absent, empty or zero MAX_SIZE as unlimited storage", () => {
  assert.equal(loadConfig(baseEnv(), FILE_CONFIG).maxSizeBytes, 0);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "" }, FILE_CONFIG).maxSizeBytes, 0);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "0" }, FILE_CONFIG).maxSizeBytes, 0);
});

test("parses MAX_SIZE suffixes into bytes", () => {
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "500M" }, FILE_CONFIG).maxSizeBytes, 500 * 1024 ** 2);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "1G" }, FILE_CONFIG).maxSizeBytes, 1024 ** 3);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "2048" }, FILE_CONFIG).maxSizeBytes, 2048);
});

test("rejects a malformed MAX_SIZE", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), MAX_SIZE: "not-a-size" }, FILE_CONFIG),
    (error: unknown) => error instanceof ConfigError && error.message.includes("MAX_SIZE"),
  );
});

test("enables the random playlist feature only when RANDOM_PLAYLIST is truthy", () => {
  assert.equal(loadConfig({ ...baseEnv(), RANDOM_PLAYLIST: "false" }, FILE_CONFIG).randomPlaylist, undefined);
  const config = loadConfig({
    ...baseEnv(),
    RANDOM_PLAYLIST: "true",
    RANDOM_PLAYLIST_DIR: "/music/random",
  }, FILE_CONFIG);
  assert.deepEqual(config.randomPlaylist, { dir: "/music/random" });
});

test("requires RANDOM_PLAYLIST_DIR when RANDOM_PLAYLIST is enabled", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), RANDOM_PLAYLIST: "true" }, FILE_CONFIG),
    (error: unknown) =>
      error instanceof ConfigError && error.message.includes("RANDOM_PLAYLIST_DIR"),
  );
});

test("applies explicit SYNC_INTERVAL, DOWNLOAD_CONCURRENCY and TEMP_DIR", () => {
  const config = loadConfig({
    ...baseEnv(),
    SYNC_INTERVAL: "3600",
    DOWNLOAD_CONCURRENCY: "5",
    TEMP_DIR: "/custom/temp",
  }, FILE_CONFIG);
  assert.equal(config.syncIntervalSec, 3600);
  assert.equal(config.downloadConcurrency, 5);
  assert.equal(config.tempDir, "/custom/temp");
});

test("rejects a non-integer SYNC_INTERVAL", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), SYNC_INTERVAL: "not-a-number" }, FILE_CONFIG),
    (error: unknown) => error instanceof ConfigError && error.message.includes("SYNC_INTERVAL"),
  );
});

test("rejects a zero or negative DOWNLOAD_CONCURRENCY", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), DOWNLOAD_CONCURRENCY: "0" }, FILE_CONFIG),
    (error: unknown) =>
      error instanceof ConfigError && error.message.includes("DOWNLOAD_CONCURRENCY"),
  );
});

test("surfaces the underlying playlist configuration error", () => {
  assert.throws(() => loadConfig({}, { playlists: [{ name: "Rock", url: "https://example.com/not-spotify" }] }), ConfigError);
});

test("requires at least one playlist to be configured", () => {
  assert.throws(() => loadConfig({}, { playlists: [] }), ConfigError);
});

test("defaults the Spotify full-catalog source to enabled", () => {
  const config = loadConfig(baseEnv(), FILE_CONFIG);
  assert.equal(config.spotify.fullCatalogEnabled, true);
  assert.equal(config.spotify.partnerQueryHash, undefined);
  assert.equal(config.spotify.pageDelayMs, 250);
});

test("parses the Spotify full-catalog overrides", () => {
  const hash = "b".repeat(64);
  const config = loadConfig({
    ...baseEnv(),
    SPOTIFY_FULL_CATALOG: "false",
    SPOTIFY_PARTNER_HASH: hash.toUpperCase(),
    SPOTIFY_PAGE_DELAY_MS: "0",
  }, FILE_CONFIG);
  assert.equal(config.spotify.fullCatalogEnabled, false);
  assert.equal(config.spotify.partnerQueryHash, hash);
  assert.equal(config.spotify.pageDelayMs, 0);
});

test("rejects an invalid SPOTIFY_PARTNER_HASH", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), SPOTIFY_PARTNER_HASH: "not-a-hash" }, FILE_CONFIG),
    ConfigError,
  );
});

test("rejects an invalid SPOTIFY_FULL_CATALOG value", () => {
  assert.throws(() => loadConfig({ ...baseEnv(), SPOTIFY_FULL_CATALOG: "maybe" }, FILE_CONFIG), ConfigError);
});
