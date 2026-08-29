import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaylistConfigs, extractSpotifyPlaylistId, ConfigError } from "../src/config/playlists.js";

test("parses multiple playlists from unordered env keys", () => {
  const env = {
    PLAYLIST_2_NAME: "Electronic",
    PLAYLIST_2_URL: "https://open.spotify.com/playlist/2222222222222222222222",
    PLAYLIST_2_DIR: "/music",
    PLAYLIST_1_NAME: "Rock",
    PLAYLIST_1_URL: "https://open.spotify.com/playlist/1111111111111111111111",
    PLAYLIST_1_DIR: "/music",
  };

  const configs = parsePlaylistConfigs(env);

  assert.equal(configs.length, 2);
  assert.equal(configs[0]?.name, "Rock");
  assert.equal(configs[1]?.name, "Electronic");
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

test("throws on incomplete entry missing DIR", () => {
  const env = {
    PLAYLIST_1_NAME: "Rock",
    PLAYLIST_1_URL: "https://open.spotify.com/playlist/1111111111111111111111",
  };
  assert.throws(() => parsePlaylistConfigs(env), (error: unknown) => {
    return error instanceof ConfigError && error.message.includes("PLAYLIST_1_DIR");
  });
});

test("throws on incomplete entry missing NAME and DIR", () => {
  const env = {
    PLAYLIST_1_URL: "https://open.spotify.com/playlist/1111111111111111111111",
  };
  assert.throws(() => parsePlaylistConfigs(env), (error: unknown) => {
    return (
      error instanceof ConfigError &&
      error.message.includes("PLAYLIST_1_NAME") &&
      error.message.includes("PLAYLIST_1_DIR")
    );
  });
});

test("throws on duplicate name+dir pair across different indices", () => {
  const env = {
    PLAYLIST_1_NAME: "Rock",
    PLAYLIST_1_URL: "https://open.spotify.com/playlist/1111111111111111111111",
    PLAYLIST_1_DIR: "/music",
    PLAYLIST_2_NAME: "Rock",
    PLAYLIST_2_URL: "https://open.spotify.com/playlist/2222222222222222222222",
    PLAYLIST_2_DIR: "/music",
  };
  assert.throws(() => parsePlaylistConfigs(env), ConfigError);
});

test("throws when no playlists are configured", () => {
  assert.throws(() => parsePlaylistConfigs({}), ConfigError);
});
