import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePlaylistDir,
  computeTrackPaths,
  fileExists,
  commitFile,
} from "../src/filesystem/store.js";
import type { PlaylistConfig, SpotifyTrack } from "../src/types/index.js";

function makeTrack(id: string, overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id,
    title: "Title",
    artists: ["Artist"],
    durationMs: 200_000,
    trackNumber: 1,
    releaseYear: 2020,
    coverUrl: undefined,
    ...overrides,
  };
}

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "playlist2mp3-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ensurePlaylistDir creates the playlist directory automatically", async () => {
  await withTempDir(async (root) => {
    const config: PlaylistConfig = {
      id: "1",
      name: "Rock",
      url: "https://open.spotify.com/playlist/abc",
      spotifyPlaylistId: "abc",
      rootDir: root,
    };
    const dir = await ensurePlaylistDir(config);
    const info = await stat(dir);
    assert.equal(info.isDirectory(), true);
  });
});

test("fileExists returns false for a missing file", async () => {
  await withTempDir(async (root) => {
    assert.equal(await fileExists(join(root, "missing.mp3")), false);
  });
});

test("fileExists returns false for a zero-byte file", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "empty.mp3");
    await writeFile(path, "");
    assert.equal(await fileExists(path), false);
  });
});

test("fileExists returns true for a non-empty file", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "real.mp3");
    await writeFile(path, "audio-bytes");
    assert.equal(await fileExists(path), true);
  });
});

test("computeTrackPaths gives distinct tracks the same directory but different files", () => {
  const config: PlaylistConfig = {
    id: "1",
    name: "Rock",
    url: "https://open.spotify.com/playlist/abc",
    spotifyPlaylistId: "abc",
    rootDir: join(tmpdir(), "root"),
  };
  const tracks = [makeTrack("id-1", { title: "Song A" }), makeTrack("id-2", { title: "Song B" })];
  const paths = computeTrackPaths(config, tracks);
  assert.notEqual(paths.get("id-1"), paths.get("id-2"));
});

test("computeTrackPaths appends a deterministic suffix only for colliding filenames", () => {
  const config: PlaylistConfig = {
    id: "1",
    name: "Rock",
    url: "https://open.spotify.com/playlist/abc",
    spotifyPlaylistId: "abc",
    rootDir: join(tmpdir(), "root"),
  };
  const collidingA = makeTrack("id-1", { artists: ["Artist"], title: "Same Title" });
  const collidingB = makeTrack("id-2", { artists: ["Artist"], title: "Same Title" });
  const unique = makeTrack("id-3", { artists: ["Artist"], title: "Unique Title" });

  const firstRun = computeTrackPaths(config, [collidingA, collidingB, unique]);
  const secondRun = computeTrackPaths(config, [collidingA, collidingB, unique]);

  assert.notEqual(firstRun.get("id-1"), firstRun.get("id-2"));
  assert.equal(firstRun.get("id-3")?.includes("id-3".slice(0, 8)), false);
  assert.equal(firstRun.get("id-1"), secondRun.get("id-1"));
  assert.equal(firstRun.get("id-2"), secondRun.get("id-2"));
});

test("commitFile moves the temp file into place and reports it was written", async () => {
  await withTempDir(async (root) => {
    const tempPath = join(root, "temp.mp3");
    const finalPath = join(root, "final.mp3");
    await writeFile(tempPath, "audio-bytes");

    const committed = await commitFile(tempPath, finalPath);

    assert.equal(committed, true);
    assert.equal(await fileExists(finalPath), true);
    assert.equal(await fileExists(tempPath), false);
  });
});

test("commitFile never overwrites an existing final file", async () => {
  await withTempDir(async (root) => {
    const tempPath = join(root, "temp.mp3");
    const finalPath = join(root, "final.mp3");
    await writeFile(finalPath, "original-bytes");
    await writeFile(tempPath, "new-bytes");

    const committed = await commitFile(tempPath, finalPath);

    assert.equal(committed, false);
    assert.equal(await fileExists(tempPath), false);
    const info = await stat(finalPath);
    assert.equal(info.size, "original-bytes".length);
  });
});
