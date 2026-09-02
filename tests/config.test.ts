import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config/index.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PLAYLIST_1_NAME: "Rock",
    PLAYLIST_1_URL: "https://open.spotify.com/playlist/1111111111111111111111",
    PLAYLIST_1_DIR: "/music",
  };
}

test("loads defaults when optional variables are absent", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.syncIntervalSec, 86400);
  assert.equal(config.downloadConcurrency, 2);
  assert.equal(config.tempDir, "/tmp/playlist2mp3");
  assert.equal(config.playlists.length, 1);
  assert.equal(config.maxSizeBytes, 0);
  assert.equal(config.randomPlaylist, undefined);
});

test("treats an absent, empty or zero MAX_SIZE as unlimited storage", () => {
  assert.equal(loadConfig(baseEnv()).maxSizeBytes, 0);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "" }).maxSizeBytes, 0);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "0" }).maxSizeBytes, 0);
});

test("parses MAX_SIZE suffixes into bytes", () => {
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "500M" }).maxSizeBytes, 500 * 1024 ** 2);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "1G" }).maxSizeBytes, 1024 ** 3);
  assert.equal(loadConfig({ ...baseEnv(), MAX_SIZE: "2048" }).maxSizeBytes, 2048);
});

test("rejects a malformed MAX_SIZE", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), MAX_SIZE: "not-a-size" }),
    (error: unknown) => error instanceof ConfigError && error.message.includes("MAX_SIZE"),
  );
});

test("enables the random playlist feature only when RANDOM_PLAYLIST is truthy", () => {
  assert.equal(loadConfig({ ...baseEnv(), RANDOM_PLAYLIST: "false" }).randomPlaylist, undefined);
  const config = loadConfig({
    ...baseEnv(),
    RANDOM_PLAYLIST: "true",
    RANDOM_PLAYLIST_DIR: "/music/random",
  });
  assert.deepEqual(config.randomPlaylist, { dir: "/music/random" });
});

test("requires RANDOM_PLAYLIST_DIR when RANDOM_PLAYLIST is enabled", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), RANDOM_PLAYLIST: "true" }),
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
  });
  assert.equal(config.syncIntervalSec, 3600);
  assert.equal(config.downloadConcurrency, 5);
  assert.equal(config.tempDir, "/custom/temp");
});

test("rejects a non-integer SYNC_INTERVAL", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), SYNC_INTERVAL: "not-a-number" }),
    (error: unknown) => error instanceof ConfigError && error.message.includes("SYNC_INTERVAL"),
  );
});

test("rejects a zero or negative DOWNLOAD_CONCURRENCY", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), DOWNLOAD_CONCURRENCY: "0" }),
    (error: unknown) =>
      error instanceof ConfigError && error.message.includes("DOWNLOAD_CONCURRENCY"),
  );
});

test("surfaces the underlying playlist configuration error", () => {
  assert.throws(() => loadConfig({ PLAYLIST_1_URL: "https://open.spotify.com/playlist/x" }), ConfigError);
});

test("requires at least one playlist to be configured", () => {
  assert.throws(() => loadConfig({}), ConfigError);
});
