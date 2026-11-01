import type { SpotifyTrack, SyncMode } from "../types/index.js";
import { renderFileName, withIdSuffix } from "../filesystem/paths.js";

export interface PlanInput {
  readonly tracks: readonly SpotifyTrack[];
  readonly manifest: ReadonlyMap<string, string>;
  readonly diskFiles: readonly string[];
  readonly mode: SyncMode;
  readonly complete: boolean;
  readonly fileNameTemplate: string;
}

export type PlanAction =
  | { readonly kind: "download"; readonly track: SpotifyTrack; readonly file: string }
  | { readonly kind: "rename"; readonly track: SpotifyTrack; readonly from: string; readonly to: string }
  | { readonly kind: "keep"; readonly track: SpotifyTrack; readonly file: string; readonly adopted: boolean }
  | { readonly kind: "remove"; readonly trackId: string; readonly file: string };

export interface SyncPlan {
  readonly actions: readonly PlanAction[];
  readonly manifest: ReadonlyMap<string, string>;
  readonly removalsBlocked: number;
}

function key(fileName: string): string {
  return fileName.toLowerCase();
}

function assignFileNames(tracks: readonly SpotifyTrack[], template: string): Map<string, string> {
  const claimed = new Set<string>();
  const result = new Map<string, string>();
  for (const track of tracks) {
    let name = renderFileName(template, track);
    if (claimed.has(key(name))) {
      name = withIdSuffix(name, track.id);
    }
    claimed.add(key(name));
    result.set(track.id, name);
  }
  return result;
}

export function buildPlan(input: PlanInput): SyncPlan {
  const onDisk = new Map(input.diskFiles.map((file) => [key(file), file]));
  const owners = new Map<string, string>();
  const manifest = new Map<string, string>();
  for (const [id, file] of input.manifest) {
    const actual = onDisk.get(key(file));
    if (actual !== undefined) {
      owners.set(key(actual), id);
      manifest.set(id, actual);
    }
  }

  const desired = assignFileNames(input.tracks, input.fileNameTemplate);
  const occupied = new Set(onDisk.keys());
  const listed = new Set(input.tracks.map((track) => track.id));
  const actions: PlanAction[] = [];

  for (const track of input.tracks) {
    const target = desired.get(track.id) ?? renderFileName(input.fileNameTemplate, track);
    const current = manifest.get(track.id);

    if (current !== undefined) {
      if (current === target) {
        actions.push({ kind: "keep", track, file: current, adopted: false });
      } else if (key(current) === key(target) || !occupied.has(key(target))) {
        occupied.delete(key(current));
        occupied.add(key(target));
        manifest.set(track.id, target);
        actions.push({ kind: "rename", track, from: current, to: target });
      } else {
        actions.push({ kind: "keep", track, file: current, adopted: false });
      }
      continue;
    }

    const existing = onDisk.get(key(target));
    if (existing !== undefined && !owners.has(key(existing))) {
      owners.set(key(existing), track.id);
      manifest.set(track.id, existing);
      actions.push({ kind: "keep", track, file: existing, adopted: true });
      continue;
    }

    const file = occupied.has(key(target)) ? withIdSuffix(target, track.id) : target;
    occupied.add(key(file));
    actions.push({ kind: "download", track, file });
  }

  const removalsAllowed = input.mode === "mirror" && input.complete && input.tracks.length > 0;
  let removalsBlocked = 0;
  for (const [id, file] of [...manifest]) {
    if (listed.has(id)) {
      continue;
    }
    if (input.mode !== "mirror") {
      continue;
    }
    if (!removalsAllowed) {
      removalsBlocked += 1;
      continue;
    }
    manifest.delete(id);
    actions.push({ kind: "remove", trackId: id, file });
  }

  return { actions, manifest, removalsBlocked };
}

export function buildM3u(
  tracks: readonly SpotifyTrack[],
  manifest: ReadonlyMap<string, string>,
): string {
  const lines = ["#EXTM3U"];
  for (const track of tracks) {
    const file = manifest.get(track.id);
    if (file !== undefined) {
      lines.push(
        `#EXTINF:${Math.round(track.durationMs / 1000)},${track.artists.join(", ")} - ${track.title}`,
        file,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
