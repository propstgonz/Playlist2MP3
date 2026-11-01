export type SyncMode = "mirror" | "incremental";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface PlaylistSettings {
  readonly name: string;
  readonly url: string;
  readonly playlistId: string;
  readonly mode: SyncMode;
}

export interface MatchingSettings {
  readonly strict: boolean;
  readonly durationToleranceSec: number;
  readonly youtubeFallback: boolean;
}

export interface RandomSettings {
  readonly enabled: boolean;
  readonly name: string;
  readonly maxTracks: number;
  readonly mode: SyncMode;
}

export interface AppConfig {
  readonly syncIntervalMs: number;
  readonly concurrency: number;
  readonly logLevel: LogLevel;
  readonly timezone: string | undefined;
  readonly dryRun: boolean;
  readonly fileName: string;
  readonly audioQuality: string;
  readonly matching: MatchingSettings;
  readonly random: RandomSettings;
  readonly playlists: readonly PlaylistSettings[];
}

export interface SpotifyTrack {
  readonly id: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string | undefined;
  readonly durationMs: number;
  readonly position: number;
  readonly releaseYear: number | undefined;
  readonly coverUrl: string | undefined;
}

export interface SpotifyPlaylist {
  readonly tracks: readonly SpotifyTrack[];
  readonly unavailable: number;
  readonly complete: boolean;
}

export type CandidateSource = "ytmusic" | "youtube";

export interface Candidate {
  readonly source: CandidateSource;
  readonly url: string;
  readonly title: string;
  readonly track: string | undefined;
  readonly artists: readonly string[];
  readonly channel: string;
  readonly album: string | undefined;
  readonly durationSec: number | undefined;
}

export type TrackStage = "metadata" | "searching" | "downloading" | "tagging" | "saving";

export interface PlaylistSummary {
  readonly name: string;
  readonly total: number;
  readonly unavailable: number;
  readonly downloaded: number;
  readonly renamed: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly error: string | undefined;
}
