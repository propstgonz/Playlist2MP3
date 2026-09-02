import { withRetry, NonRetryableError } from "../utils/retry.js";
import type { SpotifyTrack } from "../types/index.js";

const ACCESS_TOKEN_URL =
  "https://open.spotify.com/get_access_token?reason=transport&productType=embed";
const API_BASE = "https://api.spotify.com/v1";
const PAGE_LIMIT = 100;
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const RANDOM_SEARCH_MAX_ATTEMPTS = 5;
const RANDOM_SEARCH_OFFSET_CAP = 1000;
const RANDOM_SEARCH_TERMS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};
const PLAYLIST_TRACKS_FIELDS =
  "items(is_local,track(id,name,duration_ms,is_playable,artists(name),album(release_date,images))),next,total";
const SEARCH_FIELDS = "playlists(total,items(id,name))";

interface AccessToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

interface AccessTokenResponse {
  readonly accessToken?: string;
  readonly accessTokenExpirationTimestampMs?: number;
}

interface SpotifyApiImage {
  readonly url: string;
  readonly width: number | null;
}

interface SpotifyApiArtist {
  readonly name: string;
}

interface SpotifyApiAlbum {
  readonly release_date?: string;
  readonly images?: readonly SpotifyApiImage[];
}

interface SpotifyApiTrack {
  readonly id: string | null;
  readonly name: string;
  readonly artists: readonly SpotifyApiArtist[];
  readonly duration_ms: number;
  readonly is_playable?: boolean;
  readonly album?: SpotifyApiAlbum;
}

interface SpotifyApiPlaylistItem {
  readonly is_local: boolean;
  readonly track: SpotifyApiTrack | null;
}

interface SpotifyApiPage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
  readonly total: number;
}

interface SpotifyApiPlaylistMeta {
  readonly id: string;
  readonly name: string;
}

interface SpotifyApiSearchResponse {
  readonly playlists?: SpotifyApiPage<SpotifyApiPlaylistMeta | null>;
}

export interface PlaylistTracksResult {
  readonly tracks: readonly SpotifyTrack[];
  readonly unavailableCount: number;
}

export interface RandomPlaylistResult {
  readonly playlistId: string;
  readonly playlistName: string;
}

export interface PlaylistTrackSource {
  getPlaylistTracks(
    playlistId: string,
    signal?: AbortSignal,
  ): Promise<PlaylistTracksResult>;
  findRandomPublicPlaylist?(signal?: AbortSignal): Promise<RandomPlaylistResult>;
}

function pickLargestImage(images: readonly SpotifyApiImage[] | undefined): string | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }
  return images.reduce((best, image) => ((image.width ?? 0) > (best.width ?? 0) ? image : best))
    .url;
}

function parseReleaseYear(releaseDate: string | undefined): number | undefined {
  if (!releaseDate) {
    return undefined;
  }
  const year = Number(releaseDate.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

export class SpotifyClient implements PlaylistTrackSource {
  private cachedToken: AccessToken | undefined;

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return this.cachedToken.value;
    }

    const token = await withRetry(async () => {
      const response = await fetch(ACCESS_TOKEN_URL, { headers: REQUEST_HEADERS, signal });
      if (!response.ok) {
        throw new Error(`Spotify access token request failed with status ${response.status}`);
      }
      const body = (await response.json()) as AccessTokenResponse;
      if (!body.accessToken) {
        throw new NonRetryableError("Spotify access token response did not include a token");
      }
      return {
        value: body.accessToken,
        expiresAtMs: body.accessTokenExpirationTimestampMs ?? Date.now() + 60_000,
      };
    }, { signal });

    this.cachedToken = token;
    return token.value;
  }

  private async apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
    return withRetry(async () => {
      const token = await this.getAccessToken(signal);
      const response = await fetch(url, {
        headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${token}` },
        signal,
      });

      if (response.status === 404) {
        throw new NonRetryableError(`Spotify resource not found or not public (url: ${url})`);
      }
      if (response.status === 401) {
        this.cachedToken = undefined;
        throw new Error(`Spotify API request unauthorized (url: ${url})`);
      }
      if (!response.ok) {
        throw new Error(`Spotify API request failed with status ${response.status} (url: ${url})`);
      }
      return (await response.json()) as T;
    }, { signal });
  }

  async getPlaylistTracks(
    playlistId: string,
    signal?: AbortSignal,
  ): Promise<PlaylistTracksResult> {
    const seen = new Map<string, SpotifyTrack>();
    let unavailableCount = 0;
    let position = 0;
    let url: string | null =
      `${API_BASE}/playlists/${playlistId}/tracks?fields=${encodeURIComponent(PLAYLIST_TRACKS_FIELDS)}&limit=${PAGE_LIMIT}&offset=0`;

    while (url) {
      const page: SpotifyApiPage<SpotifyApiPlaylistItem> = await this.apiGet(url, signal);
      for (const item of page.items) {
        position += 1;
        const track = item.track;
        if (item.is_local || !track || !track.id || track.is_playable === false) {
          unavailableCount += 1;
          continue;
        }
        if (seen.has(track.id)) {
          continue;
        }
        seen.set(track.id, {
          id: track.id,
          title: track.name,
          artists: track.artists.map((artist) => artist.name),
          durationMs: track.duration_ms,
          trackNumber: position,
          releaseYear: parseReleaseYear(track.album?.release_date),
          coverUrl: pickLargestImage(track.album?.images),
        });
      }
      url = page.next;
    }

    return { tracks: [...seen.values()], unavailableCount };
  }

  async findRandomPublicPlaylist(signal?: AbortSignal): Promise<RandomPlaylistResult> {
    for (let attempt = 0; attempt < RANDOM_SEARCH_MAX_ATTEMPTS; attempt += 1) {
      const term =
        RANDOM_SEARCH_TERMS[Math.floor(Math.random() * RANDOM_SEARCH_TERMS.length)] ?? "a";
      const probeUrl = `${API_BASE}/search?type=playlist&limit=1&offset=0&fields=${encodeURIComponent(SEARCH_FIELDS)}&q=${encodeURIComponent(term)}`;
      const probe: SpotifyApiSearchResponse = await this.apiGet(probeUrl, signal);
      const total = probe.playlists?.total ?? 0;
      if (total === 0) {
        continue;
      }

      const maxOffset = Math.min(total, RANDOM_SEARCH_OFFSET_CAP) - 1;
      const offset = Math.floor(Math.random() * (maxOffset + 1));
      const searchUrl = `${API_BASE}/search?type=playlist&limit=1&offset=${offset}&fields=${encodeURIComponent(SEARCH_FIELDS)}&q=${encodeURIComponent(term)}`;
      const result: SpotifyApiSearchResponse = await this.apiGet(searchUrl, signal);
      const found = result.playlists?.items.find(
        (item): item is SpotifyApiPlaylistMeta => item !== null,
      );
      if (found) {
        return { playlistId: found.id, playlistName: found.name };
      }
    }

    throw new NonRetryableError("Could not find a random public playlist after several attempts");
  }
}
