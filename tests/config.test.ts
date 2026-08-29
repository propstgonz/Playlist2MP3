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
