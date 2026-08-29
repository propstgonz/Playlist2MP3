import { withRetry, NonRetryableError } from "../utils/retry.js";
import type { SpotifyTrack } from "../types/index.js";
import type { SpotifyAuthClient } from "./spotifyAuth.js";

const API_BASE = "https://api.spotify.com/v1";
const PAGE_LIMIT = 100;

interface SpotifyApiArtist {
  readonly name: string;
}

interface SpotifyApiImage {
  readonly url: string;
}

interface SpotifyApiAlbum {
  readonly name: string;
  readonly release_date?: string;
  readonly images?: readonly SpotifyApiImage[];
}

interface SpotifyApiTrack {
  readonly id: string | null;
  readonly name: string;
  readonly artists: readonly SpotifyApiArtist[];
  readonly album: SpotifyApiAlbum;
  readonly duration_ms: number;
  readonly track_number: number;
  readonly is_local: boolean;
}

interface SpotifyApiPlaylistItem {
  readonly track: SpotifyApiTrack | null;
}

interface SpotifyApiPlaylistTracksPage {
  readonly items: readonly SpotifyApiPlaylistItem[];
  readonly next: string | null;
}

function toSpotifyTrack(apiTrack: SpotifyApiTrack): SpotifyTrack | undefined {
  if (apiTrack.is_local || !apiTrack.id) {
    return undefined;
  }
  const releaseYear = apiTrack.album.release_date
    ? Number.parseInt(apiTrack.album.release_date.slice(0, 4), 10)
    : undefined;
  return {
    id: apiTrack.id,
    title: apiTrack.name,
    artists: apiTrack.artists.map((artist) => artist.name),
    album: apiTrack.album.name,
    durationMs: apiTrack.duration_ms,
    trackNumber: apiTrack.track_number,
    releaseYear: releaseYear !== undefined && Number.isFinite(releaseYear) ? releaseYear : undefined,
    coverUrl: apiTrack.album.images?.[0]?.url,
  };
}

export interface PlaylistTrackSource {
  getPlaylistTracks(
    playlistId: string,
    signal?: AbortSignal,
  ): Promise<readonly SpotifyTrack[]>;
}

export class SpotifyClient implements PlaylistTrackSource {
  constructor(private readonly auth: SpotifyAuthClient) {}

  async getPlaylistTracks(
    playlistId: string,
    signal?: AbortSignal,
  ): Promise<readonly SpotifyTrack[]> {
    const seen = new Map<string, SpotifyTrack>();
    let url: string | null =
      `${API_BASE}/playlists/${playlistId}/tracks?limit=${PAGE_LIMIT}`;

    while (url) {
      const page: SpotifyApiPlaylistTracksPage = await this.fetchPage(url, signal);
      for (const item of page.items) {
        if (!item.track) {
          continue;
        }
        const track = toSpotifyTrack(item.track);
        if (track && !seen.has(track.id)) {
          seen.set(track.id, track);
        }
      }
      url = page.next;
    }

    return [...seen.values()];
  }

  private async fetchPage(
    url: string,
    signal?: AbortSignal,
  ): Promise<SpotifyApiPlaylistTracksPage> {
    return withRetry(
      async () => {
        const token = await this.auth.getAccessToken(signal);
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });

        if (response.status === 404) {
          throw new NonRetryableError(
            `Spotify playlist not found or not public (url: ${url})`,
          );
        }
        if (response.status === 403) {
          throw new NonRetryableError(
            "Spotify API returned 403. Apps in Development Mode require the app owner's " +
              "Spotify account to have an active Premium subscription, or the app must be " +
              "approved for Extended Quota Mode. See: " +
              "https://developer.spotify.com/documentation/web-api/concepts/quota-modes",
          );
        }
        if (response.status === 429) {
          const retryAfterSec = Number.parseInt(
            response.headers.get("Retry-After") ?? "1",
            10,
          );
          await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));
          throw new Error("Spotify rate limit hit, retrying");
        }
        if (!response.ok) {
          throw new Error(`Spotify API request failed with status ${response.status}`);
        }

        return (await response.json()) as SpotifyApiPlaylistTracksPage;
      },
      { signal },
    );
  }
}
