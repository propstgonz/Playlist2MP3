import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig, SpotifyTrack, SyncMode } from "../src/types/index.js";
import type { PipelineOps } from "../src/downloader/pipeline.js";
import type { PlaylistFetchResult, PlaylistSource } from "../src/playlist/spotify.js";
import { commitFile } from "../src/filesystem/files.js";
import { describeCycle, runCycle } from "../src/sync/cycle.js";
import { rootLogger } from "../src/utils/logger.js";
import { makeConfig, makeTrack, withTempDir } from "./helpers.js";

interface FakeSource extends PlaylistSource {
  readonly lists: Map<string, PlaylistFetchResult>;
}

function fakeSource(lists: Record<string, readonly SpotifyTrack[]>, failing: readonly string[] = []): FakeSource {
  const map = new Map(
    Object.entries(lists).map(([id, tracks]) => [id, { tracks, unavailable: 0, complete: true, source: "full" as const }]),
  );
  return {
    lists: map,
    getPlaylist: async (id) => {
      if (failing.includes(id)) {
        throw new Error(`playlist ${id} is broken`);
      }
      const found = map.get(id);
      if (!found) {
        throw new Error(`unknown playlist ${id}`);
      }
      return found;
    },
    findRandomPlaylist: async () => ({ playlistId: "random", name: "Random Mix" }),
  };
}

interface FakeOps extends PipelineOps {
  readonly resolved: string[];
  maxActive: number;
}

function fakeOps(failIds: readonly string[] = []): FakeOps {
  let active = 0;
  const result: FakeOps = {
    resolved: [],
    maxActive: 0,
    resolve: async (track) => {
      result.resolved.push(track.id);
      if (failIds.includes(track.id)) {
        throw new Error("no faithful version found");
      }
      return {
        candidate: { source: "ytmusic", url: `u-${track.id}`, title: track.title, track: track.title, artists: [...track.artists], channel: "", album: undefined, durationSec: 200 },
        doubtful: false,
      };
    },
    download: async (_source, tempDir, trackId) => {
      active += 1;
      result.maxActive = Math.max(result.maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const path = join(tempDir, `${trackId}-${Math.random().toString(36).slice(2)}.mp3`);
      await writeFile(path, `audio-${trackId}`);
      return path;
    },
    tag: async () => undefined,
    commit: commitFile,
  };
  return result;
}

function playlists(...entries: [string, string, SyncMode?][]): AppConfig["playlists"] {
  return entries.map(([name, playlistId, mode]) => ({ name, playlistId, url: `https://open.spotify.com/playlist/${playlistId}`, mode: mode ?? "mirror" }));
}

async function cycle(config: AppConfig, source: PlaylistSource, ops: PipelineOps, root: string) {
  const tempDir = join(root, "tmp");
  await mkdir(tempDir, { recursive: true });
  return runCycle(config, { source, ops, musicDir: join(root, "music"), tempDir, logger: rootLogger });
}

async function files(root: string, playlist: string): Promise<string[]> {
  return (await readdir(join(root, "music", playlist))).sort();
}

const a = makeTrack("a1", "Alpha", { position: 1 });
const b = makeTrack("b2", "Beta", { position: 2 });
const c = makeTrack("c3", "Gamma", { position: 3 });

test("first sync downloads everything and writes the folder index and the m3u", async () => {
  await withTempDir(async (root) => {
    const summary = await cycle(makeConfig({ playlists: playlists(["Rock", "p1"]) }), fakeSource({ p1: [a, b] }), fakeOps(), root);
    assert.equal(summary.playlists[0]?.downloaded, 2);
    assert.deepEqual(await files(root, "Rock"), [".playlist2mp3.json", "Artist - Alpha.mp3", "Artist - Beta.mp3", "Rock.m3u"]);
    const m3u = await readFile(join(root, "music", "Rock", "Rock.m3u"), "utf8");
    assert.equal(m3u.indexOf("Alpha") < m3u.indexOf("Beta"), true);
  });
});

test("an unchanged playlist causes zero work on the next cycle", async () => {
  await withTempDir(async (root) => {
    const config = makeConfig({ playlists: playlists(["Rock", "p1"]) });
    const source = fakeSource({ p1: [a, b] });
    await cycle(config, source, fakeOps(), root);
    const ops = fakeOps();
    const summary = await cycle(config, source, ops, root);
    assert.deepEqual(ops.resolved, []);
    assert.equal(summary.playlists[0]?.unchanged, 2);
    assert.equal(summary.playlists[0]?.downloaded, 0);
  });
});

test("mirror mode removes songs that left Spotify but never touches your own files", async () => {
  await withTempDir(async (root) => {
    const config = makeConfig({ playlists: playlists(["Rock", "p1"]) });
    const source = fakeSource({ p1: [a, b] });
    await cycle(config, source, fakeOps(), root);
    await writeFile(join(root, "music", "Rock", "My own recording.mp3"), "mine");
    await writeFile(join(root, "music", "Rock", "cover.jpg"), "img");
    source.lists.set("p1", { tracks: [a], unavailable: 1, complete: true, source: "full" });
    const summary = await cycle(config, source, fakeOps(), root);
    assert.equal(summary.playlists[0]?.removed, 1);
    assert.deepEqual(await files(root, "Rock"), [".playlist2mp3.json", "Artist - Alpha.mp3", "My own recording.mp3", "Rock.m3u", "cover.jpg"]);
  });
});

test("incremental mode only adds", async () => {
  await withTempDir(async (root) => {
    const config = makeConfig({ playlists: playlists(["Rock", "p1", "incremental"]) });
    const source = fakeSource({ p1: [a, b] });
    await cycle(config, source, fakeOps(), root);
    source.lists.set("p1", { tracks: [a, c], unavailable: 0, complete: true, source: "full" });
    const summary = await cycle(config, source, fakeOps(), root);
    assert.equal(summary.playlists[0]?.removed, 0);
    assert.equal(summary.playlists[0]?.downloaded, 1);
    assert.deepEqual(await files(root, "Rock"), [".playlist2mp3.json", "Artist - Alpha.mp3", "Artist - Beta.mp3", "Artist - Gamma.mp3", "Rock.m3u"]);
  });
});

test("an incomplete track list never deletes anything", async () => {
  await withTempDir(async (root) => {
    const config = makeConfig({ playlists: playlists(["Rock", "p1"]) });
    const source = fakeSource({ p1: [a, b] });
    await cycle(config, source, fakeOps(), root);
    source.lists.set("p1", { tracks: [a], unavailable: 0, complete: false, source: "embed" });
    const summary = await cycle(config, source, fakeOps(), root);
    assert.equal(summary.playlists[0]?.removed, 0);
    assert.equal((await files(root, "Rock")).includes("Artist - Beta.mp3"), true);
  });
});

test("dry run reports the plan and writes nothing at all", async () => {
  await withTempDir(async (root) => {
    const ops = fakeOps();
    const summary = await cycle(makeConfig({ dryRun: true, playlists: playlists(["Rock", "p1"]) }), fakeSource({ p1: [a, b] }), ops, root);
    assert.equal(summary.playlists[0]?.downloaded, 2);
    assert.deepEqual(ops.resolved, []);
    assert.deepEqual(await readdir(join(root, "music")).catch(() => []), []);
    assert.equal(describeCycle(summary, true).includes("2 would be downloaded"), true);
  });
});

test("adopts the MP3s already in a folder without downloading them again", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "music", "Rock"), { recursive: true });
    await writeFile(join(root, "music", "Rock", "Artist - Alpha.mp3"), "old download");
    const ops = fakeOps();
    const summary = await cycle(makeConfig({ playlists: playlists(["Rock", "p1"]) }), fakeSource({ p1: [a, b] }), ops, root);
    assert.deepEqual(ops.resolved, ["b2"]);
    assert.equal(summary.playlists[0]?.unchanged, 1);
    const index = JSON.parse(await readFile(join(root, "music", "Rock", ".playlist2mp3.json"), "utf8")) as { tracks: Record<string, unknown> };
    assert.deepEqual(Object.keys(index.tracks).sort(), ["a1", "b2"]);
  });
});

test("after a failed or interrupted cycle only the missing songs are retried", async () => {
  await withTempDir(async (root) => {
    const config = makeConfig({ playlists: playlists(["Rock", "p1"]) });
    const source = fakeSource({ p1: [a, b, c] });
    const first = await cycle(config, source, fakeOps(["b2"]), root);
    assert.equal(first.playlists[0]?.failed, 1);
    assert.equal((await files(root, "Rock")).includes("Artist - Beta.mp3"), false);
    const ops = fakeOps();
    await cycle(config, source, ops, root);
    assert.deepEqual(ops.resolved, ["b2"]);
  });
});

test("one broken playlist does not stop the others", async () => {
  await withTempDir(async (root) => {
    const summary = await cycle(
      makeConfig({ playlists: playlists(["Broken", "bad"], ["Rock", "p1"]) }),
      fakeSource({ p1: [a] }, ["bad"]),
      fakeOps(),
      root,
    );
    assert.equal(summary.playlists[0]?.error, "playlist bad is broken");
    assert.equal(summary.playlists[1]?.downloaded, 1);
    assert.equal(describeCycle(summary, false).includes("1 playlist errors"), true);
  });
});

test("the concurrency limit is shared by all playlists", async () => {
  await withTempDir(async (root) => {
    const many = (prefix: string) => Array.from({ length: 6 }, (_, i) => makeTrack(`${prefix}${i}`, `${prefix} ${i}`));
    const ops = fakeOps();
    await cycle(makeConfig({ concurrency: 2, playlists: playlists(["One", "p1"], ["Two", "p2"]) }), fakeSource({ p1: many("x"), p2: many("y") }), ops, root);
    assert.equal(ops.maxActive <= 2, true);
    assert.equal(ops.resolved.length, 12);
  });
});

test("the random playlist goes to its own folder, limited to maxTracks", async () => {
  await withTempDir(async (root) => {
    const config = makeConfig({ random: { enabled: true, name: "Aleatoria", maxTracks: 2, mode: "mirror" } });
    const summary = await cycle(config, fakeSource({ random: [a, b, c] }), fakeOps(), root);
    assert.equal(summary.playlists[0]?.name, "Aleatoria");
    assert.equal(summary.playlists[0]?.downloaded, 2);
    assert.deepEqual(await files(root, "Aleatoria"), [".playlist2mp3.json", "Aleatoria.m3u", "Artist - Alpha.mp3", "Artist - Beta.mp3"]);
  });
});
