import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, SpotifyTrack } from "../src/types/index.js";
import { configureLogger } from "../src/utils/logger.js";

export const logLines: string[] = [];

configureLogger({ level: "debug", sink: (line) => logLines.push(line) });

export function makeTrack(id: string, title: string, overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id,
    title,
    artists: ["Artist"],
    album: undefined,
    durationMs: 200_000,
    position: 1,
    releaseYear: 2020,
    coverUrl: undefined,
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    syncIntervalMs: 3_600_000,
    concurrency: 2,
    logLevel: "debug",
    timezone: undefined,
    dryRun: false,
    fileName: "{artists} - {title}",
    audioQuality: "best",
    matching: { strict: true, durationToleranceSec: 7, youtubeFallback: true },
    random: { enabled: false, name: "Aleatoria", maxTracks: 50, mode: "mirror" },
    playlists: [],
    ...overrides,
  };
}

export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "playlist2mp3-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
