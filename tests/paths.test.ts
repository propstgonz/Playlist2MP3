import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileInDir, playlistDir, renderFileName, sanitizeSegment, withIdSuffix } from "../src/filesystem/paths.js";
import { commitFile, fileExists, renameNoOverwrite, writeIfChanged } from "../src/filesystem/files.js";
import { loadManifest, manifestPath, serializeManifest } from "../src/filesystem/manifest.js";
import { makeTrack, withTempDir } from "./helpers.js";

test("keeps accents, casing and spaces", () => {
  assert.equal(sanitizeSegment("Café del Mar"), "Café del Mar");
});

test("neutralises path traversal, separators, control characters and reserved names", () => {
  assert.equal(sanitizeSegment("../../etc/passwd").includes(".."), false);
  assert.equal(sanitizeSegment("a/b\\c").includes("/"), false);
  assert.equal(sanitizeSegment("a\u0001b"), "a_b");
  assert.equal(sanitizeSegment("CON"), "_CON");
  assert.equal(sanitizeSegment("   "), "untitled");
});

test("playlist folders always stay inside the music directory", () => {
  const root = join(tmpdir(), "music-root");
  assert.equal(playlistDir(root, "../../outside").startsWith(resolve(root)), true);
  assert.equal(fileInDir(playlistDir(root, "Rock"), "../escape.mp3").startsWith(resolve(root)), true);
});

test("renders file names from the template", () => {
  const track = makeTrack("abcdefgh123", "One More Time", { artists: ["Daft Punk", "Romanthony"], album: "Discovery", releaseYear: 2001 });
  assert.equal(renderFileName("{artists} - {title}", track), "Daft Punk, Romanthony - One More Time.mp3");
  assert.equal(renderFileName("{artist} - {title} ({year})", track), "Daft Punk - One More Time (2001).mp3");
  assert.equal(renderFileName("{artist} - {album} - {title}", { ...track, album: undefined }), "Daft Punk - One More Time.mp3");
  assert.equal(renderFileName("{artists} - {title}", { ...track, title: "AC/DC: Live?" }), "Daft Punk, Romanthony - AC_DC_ Live_.mp3");
  assert.equal(withIdSuffix("A - B.mp3", "abcdefgh123"), "A - B (abcdefgh).mp3");
});

test("commitFile never overwrites and renameNoOverwrite refuses existing targets", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "final.mp3"), "keep");
    await writeFile(join(dir, "temp.mp3"), "new");
    assert.equal(await commitFile(join(dir, "temp.mp3"), join(dir, "final.mp3")), false);
    assert.equal(await readFile(join(dir, "final.mp3"), "utf8"), "keep");
    assert.equal(await fileExists(join(dir, "temp.mp3")), false);

    await writeFile(join(dir, "other.mp3"), "other");
    assert.equal(await renameNoOverwrite(join(dir, "other.mp3"), join(dir, "final.mp3")), false);
    assert.equal(await renameNoOverwrite(join(dir, "other.mp3"), join(dir, "Other.mp3")), true);
    assert.deepEqual((await readdir(dir)).sort(), ["Other.mp3", "final.mp3"]);
  });
});

test("writeIfChanged skips identical content", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "list.m3u");
    assert.equal(await writeIfChanged(path, "a"), true);
    assert.equal(await writeIfChanged(path, "a"), false);
    assert.equal(await writeIfChanged(path, "b"), true);
  });
});

test("the folder index round-trips and a corrupt one is set aside", async () => {
  await withTempDir(async (dir) => {
    assert.equal((await loadManifest(dir, true)).status, "missing");
    await writeFile(manifestPath(dir), serializeManifest(new Map([["t1", "A - B.mp3"], ["bad", "../x.mp3"]])));
    const loaded = await loadManifest(dir, true);
    assert.equal(loaded.status, "loaded");
    assert.deepEqual([...loaded.tracks], [["t1", "A - B.mp3"]]);

    await writeFile(manifestPath(dir), "{ broken");
    assert.equal((await loadManifest(dir, false)).status, "corrupt");
    assert.equal(await fileExists(manifestPath(dir)), true);
    assert.equal((await loadManifest(dir, true)).status, "corrupt");
    const files = await readdir(dir);
    assert.equal(files.some((f) => f.startsWith(".playlist2mp3.corrupt-")), true);
    assert.equal(files.includes(".playlist2mp3.json"), false);
  });
});

test("an empty directory has no index and no files", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "sub"));
    assert.equal((await loadManifest(join(dir, "sub"), true)).tracks.size, 0);
  });
});
