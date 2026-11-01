import { test } from "node:test";
import assert from "node:assert/strict";
import { buildM3u, buildPlan, type PlanAction, type PlanInput } from "../src/sync/plan.js";
import { makeTrack } from "./helpers.js";

const one = makeTrack("t1", "One");
const two = makeTrack("t2", "Two");

function plan(overrides: Partial<PlanInput>) {
  return buildPlan({
    tracks: [one, two],
    manifest: new Map(),
    diskFiles: [],
    mode: "mirror",
    complete: true,
    fileNameTemplate: "{artists} - {title}",
    ...overrides,
  });
}

function kinds(actions: readonly PlanAction[]): string[] {
  return actions.map((a) => `${a.kind}:${"file" in a ? a.file : `${a.from}>${a.to}`}`);
}

test("downloads everything into an empty folder", () => {
  const result = plan({});
  assert.deepEqual(kinds(result.actions), ["download:Artist - One.mp3", "download:Artist - Two.mp3"]);
  assert.equal(result.manifest.size, 0);
});

test("an unchanged folder produces no work", () => {
  const result = plan({
    manifest: new Map([["t1", "Artist - One.mp3"], ["t2", "Artist - Two.mp3"]]),
    diskFiles: ["Artist - One.mp3", "Artist - Two.mp3"],
  });
  assert.deepEqual(kinds(result.actions), ["keep:Artist - One.mp3", "keep:Artist - Two.mp3"]);
});

test("adopts existing files that match by name when there is no index yet", () => {
  const result = plan({ diskFiles: ["artist - one.MP3"] });
  assert.deepEqual(kinds(result.actions), ["keep:artist - one.MP3", "download:Artist - Two.mp3"]);
  assert.equal(result.manifest.get("t1"), "artist - one.MP3");
  assert.equal(result.actions[0]?.kind === "keep" && result.actions[0].adopted, true);
});

test("mirror mode removes indexed files that left the playlist", () => {
  const result = plan({
    tracks: [one],
    manifest: new Map([["t1", "Artist - One.mp3"], ["gone", "Artist - Gone.mp3"]]),
    diskFiles: ["Artist - One.mp3", "Artist - Gone.mp3", "My own song.mp3"],
  });
  assert.deepEqual(kinds(result.actions), ["keep:Artist - One.mp3", "remove:Artist - Gone.mp3"]);
  assert.equal(result.manifest.has("gone"), false);
});

test("files that the program did not download are never removed", () => {
  const result = plan({ tracks: [one], manifest: new Map([["t1", "Artist - One.mp3"]]), diskFiles: ["Artist - One.mp3", "Mine.mp3"] });
  assert.equal(result.actions.some((a) => a.kind === "remove"), false);
});

test("incremental mode keeps indexed files that left the playlist", () => {
  const result = plan({
    tracks: [one],
    mode: "incremental",
    manifest: new Map([["t1", "Artist - One.mp3"], ["gone", "Artist - Gone.mp3"]]),
    diskFiles: ["Artist - One.mp3", "Artist - Gone.mp3"],
  });
  assert.equal(result.actions.some((a) => a.kind === "remove"), false);
  assert.equal(result.manifest.get("gone"), "Artist - Gone.mp3");
});

test("never removes anything when the track list may be incomplete or is empty", () => {
  const indexed = { manifest: new Map([["gone", "Artist - Gone.mp3"]]), diskFiles: ["Artist - Gone.mp3"] };
  const incomplete = plan({ ...indexed, tracks: [one], complete: false });
  assert.equal(incomplete.actions.some((a) => a.kind === "remove"), false);
  assert.equal(incomplete.removalsBlocked, 1);
  const empty = plan({ ...indexed, tracks: [] });
  assert.equal(empty.actions.length, 0);
  assert.equal(empty.manifest.get("gone"), "Artist - Gone.mp3");
});

test("renames instead of downloading again when the title or template changes", () => {
  const result = plan({
    tracks: [makeTrack("t1", "One (New Title)")],
    manifest: new Map([["t1", "Artist - One.mp3"]]),
    diskFiles: ["Artist - One.mp3"],
  });
  assert.deepEqual(kinds(result.actions), ["rename:Artist - One.mp3>Artist - One (New Title).mp3"]);
  assert.equal(result.manifest.get("t1"), "Artist - One (New Title).mp3");
});

test("does not rename onto a file that already exists", () => {
  const result = plan({
    tracks: [makeTrack("t1", "Two")],
    manifest: new Map([["t1", "Artist - One.mp3"]]),
    diskFiles: ["Artist - One.mp3", "Artist - Two.mp3"],
  });
  assert.deepEqual(kinds(result.actions), ["keep:Artist - One.mp3"]);
});

test("gives a suffix to distinct tracks that render to the same file name", () => {
  const result = plan({ tracks: [makeTrack("aaaaaaaa1", "Same"), makeTrack("bbbbbbbb2", "Same")] });
  assert.deepEqual(kinds(result.actions), ["download:Artist - Same.mp3", "download:Artist - Same (bbbbbbbb).mp3"]);
});

test("re-downloads an indexed track whose file was deleted by hand", () => {
  const result = plan({ tracks: [one], manifest: new Map([["t1", "Artist - One.mp3"]]), diskFiles: [] });
  assert.deepEqual(kinds(result.actions), ["download:Artist - One.mp3"]);
});

test("the m3u follows the Spotify order and lists only files that exist", () => {
  const m3u = buildM3u([two, one], new Map([["t1", "Artist - One.mp3"], ["t2", "Artist - Two.mp3"]]));
  assert.equal(m3u, "#EXTM3U\n#EXTINF:200,Artist - Two\nArtist - Two.mp3\n#EXTINF:200,Artist - One\nArtist - One.mp3\n");
  assert.equal(buildM3u([one, two], new Map([["t2", "Artist - Two.mp3"]])).includes("One"), false);
});
