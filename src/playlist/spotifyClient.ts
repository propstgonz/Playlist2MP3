import { withRetry, NonRetryableError } from "../utils/retry.js";
import type { SpotifyTrack } from "../types/index.js";

const EMBED_BASE = "https://open.spotify.com/embed";
const NEXT_DATA_PATTERN = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s;
const TRACK_URI_PATTERN = /^spotify:track:([a-zA-Z0-9]+)$/;
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export const EMBED_TRACK_LIST_CAP = 100;

interface EmbedImage {
  readonly url: string;
  readonly maxWidth?: number | null;
}

interface EmbedPlaylistTrackItem {
  readonly uri: string;
  readonly title: string;
  readonly subtitle: string;
  readonly duration: number;
  readonly entityType: string;
  readonly isPlayable: boolean;
}

interface EmbedPlaylistEntity {
  readonly trackList: readonly EmbedPlaylistTrackItem[];
}

interface EmbedTrackArtist {
  readonly name: string;
}

interface EmbedTrackEntity {
  readonly artists: readonly EmbedTrackArtist[];
  readonly releaseDate?: { readonly isoString: string } | null;
  readonly visualIdentity?: { readonly image?: readonly EmbedImage[] } | null;
}

interface EmbedNextData<T> {
  readonly props: {
    readonly pageProps: {
      readonly state: {
        readonly data: {
          readonly entity: T;
        };
      };
    };
  };
}

export interface PlaylistTracksResult {
  readonly tracks: readonly SpotifyTrack[];
  readonly unavailableCount: number;
}

export interface PlaylistTrackSource {
  getPlaylistTracks(
    playlistId: string,
    signal?: AbortSignal,
  ): Promise<PlaylistTracksResult>;
  getTrackDetails?(track: SpotifyTrack, signal?: AbortSignal): Promise<SpotifyTrack>;
}

async function fetchEmbedEntity<T>(url: string, signal?: AbortSignal): Promise<T> {
  return withRetry(
    async () => {
      const response = await fetch(url, { headers: REQUEST_HEADERS, signal });

      if (response.status === 404) {
        throw new NonRetryableError(`Spotify page not found or not public (url: ${url})`);
      }
      if (!response.ok) {
        throw new Error(`Spotify embed page request failed with status ${response.status}`);
      }

      const html = await response.text();
      const match = NEXT_DATA_PATTERN.exec(html);
      if (!match?.[1]) {
        throw new NonRetryableError(
          `Could not find embedded data in Spotify page (url: ${url}). The page format may have changed.`,
        );
      }

      let parsed: EmbedNextData<T>;
      try {
        parsed = JSON.parse(match[1]) as EmbedNextData<T>;
      } catch {
        throw new NonRetryableError(`Spotify embed page returned invalid JSON (url: ${url})`);
      }

      return parsed.props.pageProps.state.data.entity;
    },
    { signal },
  );
}

function pickLargestImage(images: readonly EmbedImage[] | undefined): string | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }
  return images.reduce((best, image) =>
    (image.maxWidth ?? 0) > (best.maxWidth ?? 0) ? image : best,
  ).url;
}

export class SpotifyClient implements PlaylistTrackSource {
  async getPlaylistTracks(
    playlistId: string,
    signal?: AbortSignal,
  ): Promise<PlaylistTracksResult> {
    const entity = await fetchEmbedEntity<EmbedPlaylistEntity>(
      `${EMBED_BASE}/playlist/${playlistId}`,
      signal,
    );

    const seen = new Map<string, SpotifyTrack>();
    let unavailableCount = 0;
    entity.trackList.forEach((item, index) => {
      if (item.entityType !== "track") {
        return;
      }
      if (!item.isPlayable || item.title.trim() === "") {
        unavailableCount += 1;
        return;
      }
      const match = TRACK_URI_PATTERN.exec(item.uri);
      const id = match?.[1];
      if (!id || seen.has(id)) {
        return;
      }
      seen.set(id, {
        id,
        title: item.title,
        artists: [item.subtitle],
        durationMs: item.duration,
        trackNumber: index + 1,
        releaseYear: undefined,
        coverUrl: undefined,
      });
    });

    return { tracks: [...seen.values()], unavailableCount };
  }

  async getTrackDetails(track: SpotifyTrack, signal?: AbortSignal): Promise<SpotifyTrack> {
    const entity = await fetchEmbedEntity<EmbedTrackEntity>(
      `${EMBED_BASE}/track/${track.id}`,
      signal,
    );

    const releaseYear = entity.releaseDate?.isoString
      ? new Date(entity.releaseDate.isoString).getUTCFullYear()
      : undefined;

    return {
      ...track,
      artists: entity.artists.length > 0 ? entity.artists.map((artist) => artist.name) : track.artists,
      releaseYear: releaseYear !== undefined && Number.isFinite(releaseYear) ? releaseYear : undefined,
      coverUrl: pickLargestImage(entity.visualIdentity?.image),
    };
  }
}
