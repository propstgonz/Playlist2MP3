export interface PlaylistConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly spotifyPlaylistId: string;
  readonly rootDir: string;
}

export interface AppConfig {
  readonly syncIntervalSec: number;
  readonly downloadConcurrency: number;
  readonly tempDir: string;
  readonly spotifyClientId: string;
  readonly spotifyClientSecret: string;
  readonly playlists: readonly PlaylistConfig[];
}

export interface SpotifyTrack {
  readonly id: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string;
  readonly durationMs: number;
  readonly trackNumber: number;
  readonly releaseYear: number | undefined;
  readonly coverUrl: string | undefined;
}

export interface ResolvedSource {
  readonly sourceUrl: string;
  readonly sourceTitle: string;
  readonly durationSec: number;
}

export type PipelineStage =
  | "resolving"
  | "downloading"
  | "converting"
  | "tagging"
  | "committing";

export type TrackOutcome =
  | { readonly status: "downloaded" }
  | { readonly status: "skipped" }
  | {
      readonly status: "failed";
      readonly stage: PipelineStage;
      readonly reason: string;
    };

export interface PlaylistSummary {
  readonly playlistId: string;
  readonly playlistName: string;
  readonly tracksFound: number;
  readonly tracksNew: number;
  readonly downloaded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly error: string | undefined;
}

export interface SyncSummary {
  readonly playlistsProcessed: number;
  readonly playlistSummaries: readonly PlaylistSummary[];
  readonly durationMs: number;
}
