import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  sanitizeSegment,
  buildFileName,
  resolvePlaylistDir,
  resolveTrackPath,
} from "../src/filesystem/paths.js";
import type { PlaylistConfig, SpotifyTrack } from "../src/types/index.js";

function makeTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: "track-id-123",
    title: "Café del Mar",
    artists: ["Énergie"],
    album: "Album",
    durationMs: 200_000,
    trackNumber: 1,
    releaseYear: 2020,
    coverUrl: undefined,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PlaylistConfig> = {}): PlaylistConfig {
  return {
    id: "1",
    name: "Rock",
    url: "https://open.spotify.com/playlist/abc",
    spotifyPlaylistId: "abc",
    rootDir: join(tmpdir(), "playlist2mp3-paths-test"),
    ...overrides,
  };
}

test("preserves accents, casing and spaces in sanitized segments", () => {
  assert.equal(sanitizeSegment("Énergie Rock Café"), "Énergie Rock Café");
});

test("rejects path traversal via ../", () => {
  assert.equal(sanitizeSegment("../../etc/passwd").includes(".."), false);
  assert.equal(sanitizeSegment("../../etc/passwd").includes("/"), false);
});

test("rejects alternate path separators", () => {
  const sanitized = sanitizeSegment("a/b\\c");
  assert.equal(sanitized.includes("/"), false);
  assert.equal(sanitized.includes("\\"), false);
});

test("rejects Windows reserved device names", () => {
  assert.notEqual(sanitizeSegment("CON").toUpperCase(), "CON");
  assert.notEqual(sanitizeSegment("con").toUpperCase(), "CON");
});

test("strips control characters", () => {
  const withControlChar = `bad${String.fromCharCode(0)}name`;
  assert.equal(sanitizeSegment(withControlChar), "bad_name");
});

test("builds deterministic file names preserving original artist/title spacing", () => {
  const track = makeTrack({ artists: ["Daft Punk"], title: "One More Time" });
  assert.equal(buildFileName(track), "Daft Punk - One More Time.mp3");
});

test("buildFileName is deterministic for the same track", () => {
  const track = makeTrack();
  assert.equal(buildFileName(track), buildFileName(track));
});

test("resolvePlaylistDir stays contained within rootDir", () => {
  const config = makeConfig({ name: "Rock" });
  const dir = resolvePlaylistDir(config);
  assert.equal(dir.startsWith(resolve(config.rootDir)), true);
});

test("resolveTrackPath rejects a playlist name that tries to escape rootDir", () => {
  const config = makeConfig({ name: "../../outside" });
  const path = resolveTrackPath(config, makeTrack());
  assert.equal(path.startsWith(resolve(config.rootDir)), true);
});

test("two distinct playlist names never resolve to the same directory after sanitization collapse", () => {
  const configA = makeConfig({ name: "Rock/../Electronic" });
  const configB = makeConfig({ name: "Electronic" });
  assert.notEqual(resolvePlaylistDir(configA), undefined);
  assert.equal(resolvePlaylistDir(configB).endsWith("Electronic"), true);
});
