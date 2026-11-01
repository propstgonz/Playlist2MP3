import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTrackPipeline, type PipelineContext, type PipelineOps } from "../src/downloader/pipeline.js";
import { commitFile } from "../src/filesystem/files.js";
import { NoMatchError } from "../src/resolver/resolve.js";
import { TaggingError } from "../src/audio/tag.js";
import { rootLogger } from "../src/utils/logger.js";
import { makeTrack, withTempDir } from "./helpers.js";

const track = makeTrack("t1", "Song");

function ops(overrides: Partial<PipelineOps> = {}): PipelineOps {
  return {
    resolve: async () => ({
      candidate: { source: "ytmusic", url: "u", title: "Song", track: "Song", artists: ["Artist"], channel: "", album: undefined, durationSec: 200 },
      doubtful: false,
    }),
    download: async (_source, tempDir, trackId) => {
      const path = join(tempDir, `${trackId}-temp.mp3`);
      await writeFile(path, "mp3");
      return path;
    },
    tag: async () => undefined,
    commit: commitFile,
    ...overrides,
  };
}

function context(tempDir: string, extra: Partial<PipelineContext> = {}): PipelineContext {
  return {
    tempDir,
    audioQuality: "best",
    matching: { strict: true, durationToleranceSec: 7, youtubeFallback: true },
    logger: rootLogger,
    ...extra,
  };
}

test("a successful run moves the tagged MP3 into place and leaves no temp files", async () => {
  await withTempDir(async (dir) => {
    const finalPath = join(dir, "Artist - Song.mp3");
    const outcome = await runTrackPipeline(track, finalPath, context(dir), ops());
    assert.deepEqual(outcome, { status: "downloaded", doubtful: false });
    assert.deepEqual(await readdir(dir), ["Artist - Song.mp3"]);
  });
});

test("never overwrites an existing final file", async () => {
  await withTempDir(async (dir) => {
    const finalPath = join(dir, "Artist - Song.mp3");
    await writeFile(finalPath, "original");
    const outcome = await runTrackPipeline(track, finalPath, context(dir), ops());
    assert.deepEqual(outcome, { status: "exists" });
    assert.deepEqual(await readdir(dir), ["Artist - Song.mp3"]);
  });
});

test("reports the searching stage when no faithful match exists and downloads nothing", async () => {
  await withTempDir(async (dir) => {
    let downloaded = false;
    const outcome = await runTrackPipeline(track, join(dir, "x.mp3"), context(dir), ops({
      resolve: async () => {
        throw new NoMatchError("no faithful version");
      },
      download: async () => {
        downloaded = true;
        return "";
      },
    }));
    assert.equal(outcome.status === "failed" && outcome.stage, "searching");
    assert.equal(downloaded, false);
  });
});

test("a tagging failure removes the temp file and commits nothing", async () => {
  await withTempDir(async (dir) => {
    const outcome = await runTrackPipeline(track, join(dir, "final.mp3"), context(dir), ops({
      tag: async () => {
        throw new TaggingError("bad tags");
      },
    }));
    assert.equal(outcome.status === "failed" && outcome.stage, "tagging");
    assert.deepEqual(await readdir(dir), []);
  });
});

test("enriches tracks missing metadata and survives enrichment failures", async () => {
  await withTempDir(async (dir) => {
    const seen: (number | undefined)[] = [];
    const tagSpy = ops({ tag: async (_path, t) => void seen.push(t.releaseYear) });
    const bare = makeTrack("t2", "Bare", { releaseYear: undefined });
    await runTrackPipeline(bare, join(dir, "a.mp3"), context(dir, { enrich: async (t) => ({ ...t, releaseYear: 1999 }) }), tagSpy);
    await runTrackPipeline(bare, join(dir, "b.mp3"), context(dir, { enrich: async () => { throw new Error("offline"); } }), tagSpy);
    assert.deepEqual(seen, [1999, undefined]);
  });
});
