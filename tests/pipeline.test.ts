import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrackPipeline, type PipelineOps } from "../src/downloader/pipeline.js";
import { rootLogger } from "../src/utils/logger.js";
import { ResolutionError } from "../src/resolver/ytdlpResolver.js";
import { ConversionError } from "../src/audio/convert.js";
import { TaggingError } from "../src/audio/tag.js";
import type { SpotifyTrack } from "../src/types/index.js";

function makeTrack(): SpotifyTrack {
  return {
    id: "track-1",
    title: "Title",
    artists: ["Artist"],
    durationMs: 200_000,
    trackNumber: 1,
    releaseYear: 2020,
    coverUrl: undefined,
  };
}

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "playlist2mp3-pipeline-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function successfulOps(tempDir: string): PipelineOps {
  return {
    resolveTrack: async () => ({ sourceUrl: "https://example.com/x", sourceTitle: "x", durationSec: 200 }),
    downloadSource: async (_source, workDir, baseName) => {
      const path = join(workDir, `${baseName}.raw`);
      await writeFile(path, "raw-audio");
      return path;
    },
    convertToMp3: async (_input, output) => {
      await writeFile(output, "mp3-audio");
    },
    tagMp3: async () => {},
    commitFile: async (tempPath, finalPath) => {
      await writeFile(finalPath, "mp3-audio");
      await rm(tempPath);
      return true;
    },
  };
}

test("pipeline progresses resolve -> download -> convert -> tag -> commit and returns downloaded", async () => {
  await withTempDir(async (tempDir) => {
    const finalPath = join(tempDir, "final.mp3");
    const outcome = await runTrackPipeline(
      makeTrack(),
      finalPath,
      { tempDir, logger: rootLogger },
      successfulOps(tempDir),
    );
    assert.deepEqual(outcome, { status: "downloaded" });
    const info = await stat(finalPath);
    assert.equal(info.size > 0, true);
  });
});

test("pipeline reports skipped when commitFile finds the destination already present", async () => {
  await withTempDir(async (tempDir) => {
    const ops = successfulOps(tempDir);
    const outcome = await runTrackPipeline(
      makeTrack(),
      join(tempDir, "final.mp3"),
      { tempDir, logger: rootLogger },
      { ...ops, commitFile: async () => false },
    );
    assert.deepEqual(outcome, { status: "skipped" });
  });
});

test("pipeline reports a failed resolving stage and never calls downstream stages", async () => {
  await withTempDir(async (tempDir) => {
    let downloadCalled = false;
    const ops: PipelineOps = {
      resolveTrack: async () => {
        throw new ResolutionError("no results");
      },
      downloadSource: async () => {
        downloadCalled = true;
        return join(tempDir, "unused");
      },
      convertToMp3: async () => {},
      tagMp3: async () => {},
      commitFile: async () => true,
    };

    const outcome = await runTrackPipeline(
      makeTrack(),
      join(tempDir, "final.mp3"),
      { tempDir, logger: rootLogger, retryOptions: { maxAttempts: 1 } },
      ops,
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" && outcome.stage, "resolving");
    assert.equal(downloadCalled, false);
  });
});

test("pipeline reports a failed converting stage and cleans up the raw temp file", async () => {
  await withTempDir(async (tempDir) => {
    const rawPath = join(tempDir, "track-1.raw");
    const ops: PipelineOps = {
      resolveTrack: async () => ({ sourceUrl: "u", sourceTitle: "t", durationSec: 1 }),
      downloadSource: async () => {
        await writeFile(rawPath, "raw-audio");
        return rawPath;
      },
      convertToMp3: async () => {
        throw new ConversionError("ffmpeg exploded");
      },
      tagMp3: async () => {},
      commitFile: async () => true,
    };

    const outcome = await runTrackPipeline(
      makeTrack(),
      join(tempDir, "final.mp3"),
      { tempDir, logger: rootLogger },
      ops,
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" && outcome.stage, "converting");
    await assert.rejects(stat(rawPath));
  });
});

test("pipeline reports a failed tagging stage without committing the file", async () => {
  await withTempDir(async (tempDir) => {
    let committed = false;
    const ops: PipelineOps = {
      resolveTrack: async () => ({ sourceUrl: "u", sourceTitle: "t", durationSec: 1 }),
      downloadSource: async (_s, workDir, baseName) => {
        const path = join(workDir, `${baseName}.raw`);
        await writeFile(path, "raw-audio");
        return path;
      },
      convertToMp3: async (_input, output) => {
        await writeFile(output, "mp3-audio");
      },
      tagMp3: async () => {
        throw new TaggingError("bad tags");
      },
      commitFile: async () => {
        committed = true;
        return true;
      },
    };

    const outcome = await runTrackPipeline(
      makeTrack(),
      join(tempDir, "final.mp3"),
      { tempDir, logger: rootLogger },
      ops,
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" && outcome.stage, "tagging");
    assert.equal(committed, false);
  });
});
