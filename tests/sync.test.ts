import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPlaylist } from "../src/sync/syncPlaylist.js";
import { runSyncCycle } from "../src/sync/syncCycle.js";
import { rootLogger } from "../src/utils/logger.js";
import { Semaphore } from "../src/utils/concurrency.js";
import { commitFile } from "../src/filesystem/store.js";
import type { PipelineOps } from "../src/downloader/pipeline.js";
import type { PlaylistTrackSource } from "../src/playlist/spotifyClient.js";
import type { AppConfig, PlaylistConfig, SpotifyTrack } from "../src/types/index.js";

function makeTrack(id: string, title: string): SpotifyTrack {
  return {
    id,
    title,
    artists: ["Artist"],
    durationMs: 200_000,
    trackNumber: 1,
    releaseYear: 2020,
    coverUrl: undefined,
  };
}

function fakePipelineOps(): PipelineOps {
  return {
    resolveTrack: async () => ({ sourceUrl: "u", sourceTitle: "t", durationSec: 1 }),
    downloadSource: async (_source, workDir, baseName) => {
      const path = join(workDir, `${baseName}.raw`);
      await writeFile(path, "raw-audio");
      return path;
    },
    convertToMp3: async (_input, output) => {
      await writeFile(output, "mp3-audio");
    },
    tagMp3: async () => {},
    commitFile,
  };
}

function fakeSpotifyClient(tracksByPlaylist: ReadonlyMap<string, readonly SpotifyTrack[]>): PlaylistTrackSource {
  return {
    getPlaylistTracks: async (playlistId) => tracksByPlaylist.get(playlistId) ?? [],
  };
}

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "playlist2mp3-sync-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("first sync downloads all tracks and creates the playlist directory", async () => {
  await withTempDir(async (musicRoot) => {
    await withTempDir(async (tempDir) => {
      const config: PlaylistConfig = {
        id: "1",
        name: "Rock",
        url: "https://open.spotify.com/playlist/abc",
        spotifyPlaylistId: "abc",
        rootDir: musicRoot,
      };
      const tracks = [makeTrack("t1", "Song One"), makeTrack("t2", "Song Two")];
      const client = fakeSpotifyClient(new Map([["abc", tracks]]));

      const summary = await syncPlaylist(config, {
        spotifyClient: client,
        downloadSemaphore: new Semaphore(2),
        tempDir,
        logger: rootLogger,
        pipelineOps: fakePipelineOps(),
      });

      assert.equal(summary.error, undefined);
      assert.equal(summary.tracksFound, 2);
      assert.equal(summary.tracksNew, 2);
      assert.equal(summary.downloaded, 2);
      assert.equal(summary.failed, 0);

      const files = await readdir(join(musicRoot, "Rock"));
      assert.equal(files.length, 2);
    });
  });
});

test("second sync with no changes downloads nothing", async () => {
  await withTempDir(async (musicRoot) => {
    await withTempDir(async (tempDir) => {
      const config: PlaylistConfig = {
        id: "1",
        name: "Rock",
        url: "https://open.spotify.com/playlist/abc",
        spotifyPlaylistId: "abc",
        rootDir: musicRoot,
      };
      const tracks = [makeTrack("t1", "Song One")];
      const client = fakeSpotifyClient(new Map([["abc", tracks]]));
      const deps = {
        spotifyClient: client,
        downloadSemaphore: new Semaphore(2),
        tempDir,
        logger: rootLogger,
        pipelineOps: fakePipelineOps(),
      };

      const first = await syncPlaylist(config, deps);
      assert.equal(first.downloaded, 1);

      const second = await syncPlaylist(config, deps);
      assert.equal(second.downloaded, 0);
      assert.equal(second.skipped, 1);
      assert.equal(second.tracksNew, 0);
    });
  });
});

test("adding one new track only downloads that track", async () => {
  await withTempDir(async (musicRoot) => {
    await withTempDir(async (tempDir) => {
      const config: PlaylistConfig = {
        id: "1",
        name: "Rock",
        url: "https://open.spotify.com/playlist/abc",
        spotifyPlaylistId: "abc",
        rootDir: musicRoot,
      };
      const deps = (tracks: readonly SpotifyTrack[]) => ({
        spotifyClient: fakeSpotifyClient(new Map([["abc", tracks]])),
        downloadSemaphore: new Semaphore(2),
        tempDir,
        logger: rootLogger,
        pipelineOps: fakePipelineOps(),
      });

      const first = await syncPlaylist(config, deps([makeTrack("t1", "Song One")]));
      assert.equal(first.downloaded, 1);

      const second = await syncPlaylist(
        config,
        deps([makeTrack("t1", "Song One"), makeTrack("t2", "Song Two")]),
      );
      assert.equal(second.downloaded, 1);
      assert.equal(second.skipped, 1);
      assert.equal(second.tracksNew, 1);
    });
  });
});

test("two playlists with identically named tracks stay isolated in their own directories", async () => {
  await withTempDir(async (musicRoot) => {
    await withTempDir(async (tempDir) => {
      const configA: PlaylistConfig = {
        id: "1",
        name: "Rock",
        url: "https://open.spotify.com/playlist/abc",
        spotifyPlaylistId: "abc",
        rootDir: musicRoot,
      };
      const configB: PlaylistConfig = {
        id: "2",
        name: "Electronic",
        url: "https://open.spotify.com/playlist/def",
        spotifyPlaylistId: "def",
        rootDir: musicRoot,
      };
      const sameTrack = makeTrack("shared-title", "Same Song");
      const clientA = fakeSpotifyClient(new Map([["abc", [sameTrack]]]));
      const clientB = fakeSpotifyClient(new Map([["def", [sameTrack]]]));

      await syncPlaylist(configA, {
        spotifyClient: clientA,
        downloadSemaphore: new Semaphore(2),
        tempDir,
        logger: rootLogger,
        pipelineOps: fakePipelineOps(),
      });
      await syncPlaylist(configB, {
        spotifyClient: clientB,
        downloadSemaphore: new Semaphore(2),
        tempDir,
        logger: rootLogger,
        pipelineOps: fakePipelineOps(),
      });

      const rockFiles = await readdir(join(musicRoot, "Rock"));
      const electronicFiles = await readdir(join(musicRoot, "Electronic"));
      assert.equal(rockFiles.length, 1);
      assert.equal(electronicFiles.length, 1);
    });
  });
});

test("a failing playlist does not prevent other playlists from completing", async () => {
  await withTempDir(async (musicRoot) => {
    await withTempDir(async (tempDir) => {
      const config: AppConfig = {
        syncIntervalSec: 3600,
        downloadConcurrency: 2,
        tempDir,
        playlists: [
          {
            id: "1",
            name: "Broken",
            url: "https://open.spotify.com/playlist/broken",
            spotifyPlaylistId: "broken",
            rootDir: musicRoot,
          },
          {
            id: "2",
            name: "Working",
            url: "https://open.spotify.com/playlist/working",
            spotifyPlaylistId: "working",
            rootDir: musicRoot,
          },
        ],
      };

      const client: PlaylistTrackSource = {
        getPlaylistTracks: async (playlistId) => {
          if (playlistId === "broken") {
            throw new Error("Spotify API unreachable");
          }
          return [makeTrack("t1", "Song One")];
        },
      };

      const summary = await runSyncCycle(config, rootLogger, undefined, {
        spotifyClient: client,
        pipelineOps: fakePipelineOps(),
      });

      assert.equal(summary.playlistsProcessed, 2);
      const broken = summary.playlistSummaries.find((p) => p.playlistName === "Broken");
      const working = summary.playlistSummaries.find((p) => p.playlistName === "Working");
      assert.notEqual(broken?.error, undefined);
      assert.equal(working?.error, undefined);
      assert.equal(working?.downloaded, 1);
    });
  });
});

test("restarting after a completed sync does not redownload anything", async () => {
  await withTempDir(async (musicRoot) => {
    await withTempDir(async (tempDir) => {
      const config: PlaylistConfig = {
        id: "1",
        name: "Rock",
        url: "https://open.spotify.com/playlist/abc",
        spotifyPlaylistId: "abc",
        rootDir: musicRoot,
      };
      const tracks = [makeTrack("t1", "Song One"), makeTrack("t2", "Song Two")];

      await syncPlaylist(config, {
        spotifyClient: fakeSpotifyClient(new Map([["abc", tracks]])),
        downloadSemaphore: new Semaphore(2),
        tempDir,
        logger: rootLogger,
        pipelineOps: fakePipelineOps(),
      });

      const afterRestart = await syncPlaylist(config, {
        spotifyClient: fakeSpotifyClient(new Map([["abc", tracks]])),
        downloadSemaphore: new Semaphore(2),
        tempDir,
        logger: rootLogger,
        pipelineOps: fakePipelineOps(),
      });

      assert.equal(afterRestart.downloaded, 0);
      assert.equal(afterRestart.skipped, 2);
    });
  });
});

test("a slow playlist does not block a faster playlist from completing", async () => {
  await withTempDir(async (musicRoot) => {
    await withTempDir(async (tempDir) => {
      const completionOrder: string[] = [];

      const slowConfig: PlaylistConfig = {
        id: "1",
        name: "Slow",
        url: "https://open.spotify.com/playlist/slow",
        spotifyPlaylistId: "slow",
        rootDir: musicRoot,
      };
      const fastConfig: PlaylistConfig = {
        id: "2",
        name: "Fast",
        url: "https://open.spotify.com/playlist/fast",
        spotifyPlaylistId: "fast",
        rootDir: musicRoot,
      };

      const slowTracks = [
        makeTrack("slow-1", "Slow One"),
        makeTrack("slow-2", "Slow Two"),
        makeTrack("slow-3", "Slow Three"),
      ];
      const fastTracks = [makeTrack("fast-1", "Fast One")];

      const client: PlaylistTrackSource = {
        getPlaylistTracks: async (playlistId) =>
          playlistId === "slow" ? slowTracks : fastTracks,
      };

      const trackingOps: PipelineOps = {
        ...fakePipelineOps(),
        downloadSource: async (_source, workDir, baseName) => {
          if (baseName.startsWith("slow-")) {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          const path = join(workDir, `${baseName}.raw`);
          await writeFile(path, "raw-audio");
          return path;
        },
        commitFile: async (tempPathArg, finalPathArg) => {
          const result = await commitFile(tempPathArg, finalPathArg);
          completionOrder.push(finalPathArg);
          return result;
        },
      };

      const config: AppConfig = {
        syncIntervalSec: 3600,
        downloadConcurrency: 2,
        tempDir,
        playlists: [slowConfig, fastConfig],
      };

      await runSyncCycle(config, rootLogger, undefined, {
        spotifyClient: client,
        pipelineOps: trackingOps,
      });

      const fastIndex = completionOrder.findIndex((p) => p.includes("Fast One"));
      const lastSlowIndex = completionOrder.findIndex((p) => p.includes("Slow Three"));
      assert.equal(fastIndex < lastSlowIndex, true);
    });
  });
});

