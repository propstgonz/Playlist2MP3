import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePlaylistConfigs,
  extractSpotifyPlaylistId,
  readConfigFile,
  ConfigError,
} from "../src/config/playlists.js";

test("parses multiple playlists in file order", () => {
  const configs = parsePlaylistConfigs({
    playlists: [
      { name: "Rock", url: "https://open.spotify.com/playlist/1111111111111111111111", dir: "/music" },
      { name: "Electronic", url: "https://open.spotify.com/playlist/2222222222222222222222", dir: "/other" },
    ],
  });

  assert.equal(configs.length, 2);
  assert.equal(configs[0]?.name, "Rock");
  assert.equal(configs[0]?.id, "1");
  assert.equal(configs[1]?.name, "Electronic");
  assert.equal(configs[1]?.rootDir, "/other");
});

test("defaults dir to /music when omitted", () => {
  const configs = parsePlaylistConfigs({
    playlists: [{ name: "Rock", url: "https://open.spotify.com/playlist/1111111111111111111111" }],
  });
  assert.equal(configs[0]?.rootDir, "/music");
});

test("extracts playlist id from open.spotify.com URL", () => {
  const id = extractSpotifyPlaylistId(
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123",
  );
  assert.equal(id, "37i9dQZF1DXcBWIGoYBM5M");
});

test("extracts playlist id from spotify URI", () => {
  const id = extractSpotifyPlaylistId("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(id, "37i9dQZF1DXcBWIGoYBM5M");
});

test("rejects a non-Spotify-playlist URL", () => {
  assert.throws(() => extractSpotifyPlaylistId("https://example.com/not-spotify"), ConfigError);
});

test("throws on entry missing name and url", () => {
  assert.throws(() => parsePlaylistConfigs({ playlists: [{ dir: "/music" }] }), (error: unknown) => {
    return error instanceof ConfigError && error.message.includes("name, url");
  });
});

test("throws on non-string fields", () => {
  assert.throws(
    () => parsePlaylistConfigs({ playlists: [{ name: 5, url: "spotify:playlist:abc" }] }),
    ConfigError,
  );
});

test("throws on duplicate name+dir pair", () => {
  assert.throws(
    () =>
      parsePlaylistConfigs({
        playlists: [
          { name: "Rock", url: "https://open.spotify.com/playlist/1111111111111111111111" },
          { name: "Rock", url: "https://open.spotify.com/playlist/2222222222222222222222" },
        ],
      }),
    ConfigError,
  );
});

test("throws when playlists is missing, not an array, or empty", () => {
  assert.throws(() => parsePlaylistConfigs({}), ConfigError);
  assert.throws(() => parsePlaylistConfigs(null), ConfigError);
  assert.throws(() => parsePlaylistConfigs({ playlists: "Rock" }), ConfigError);
  assert.throws(() => parsePlaylistConfigs({ playlists: [] }), ConfigError);
});

test("readConfigFile parses JSON and reports missing or malformed files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "playlist2mp3-config-"));
  try {
    const valid = join(dir, "config.json");
    const broken = join(dir, "broken.json");
    await writeFile(valid, '{"playlists":[]}');
    await writeFile(broken, "{ not json");
    assert.deepEqual(readConfigFile(valid), { playlists: [] });
    assert.throws(() => readConfigFile(broken), ConfigError);
    assert.throws(() => readConfigFile(join(dir, "missing.json")), ConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
