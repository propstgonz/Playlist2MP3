import type { SpotifyPlaylist, SpotifyTrack } from "../types/index.js";
import { errorMessage, rootLogger, type Logger } from "../utils/logger.js";
import { abortableSleep } from "../utils/duration.js";
import { NonRetryableError } from "../utils/retry.js";
import { EMBED_BASE, fetchEmbedPage, type EmbedSession } from "./embedPage.js";
import { SpotifyClientTokenProvider, type ClientTokenProvider } from "./clientToken.js";
import { QueryHashProvider } from "./queryHash.js";
import { pathfinderQuery, type PathfinderContext } from "./pathfinder.js";

export const EMBED_TRACK_LIST_CAP = 100;
const PAGE_SIZE = 100;
const TRACK_URI_PATTERN = /^spotify:track:([a-zA-Z0-9]+)$/;
const PLAYLIST_URI_PATTERN = /^spotify:playlist:([a-zA-Z0-9]+)$/;
const TOKEN_MARGIN_MS = 30_000;
const TOKEN_REFERENCE_TRACK = "4uLU6hMCjMI75M1A2tKUQC";
const RANDOM_SEARCH_WORDS = [
  "rock", "pop", "indie", "jazz", "blues", "soul", "funk", "disco", "reggae", "latin",
  "salsa", "flamenco", "metal", "punk", "folk", "country", "classical", "lofi", "chill",
  "summer", "road trip", "party", "workout", "focus", "sleep", "rain", "coffee", "night",
  "80s", "90s", "2000s", "acoustic", "piano", "guitar", "dance", "house", "techno",
  "hip hop", "rap", "r&b", "k-pop", "anime", "soundtrack", "retro", "love", "sad", "happy",
];

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

interface EmbedTrackEntity {
  readonly artists: readonly { readonly name: string }[];
  readonly releaseDate?: { readonly isoString: string } | null;
  readonly visualIdentity?: { readonly image?: readonly EmbedImage[] } | null;
}

interface PartnerImageSource {
  readonly url?: string;
  readonly width?: number | null;
}

interface PartnerTrackData {
  readonly __typename?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly trackDuration?: { readonly totalMilliseconds?: number };
  readonly playability?: { readonly playable?: boolean };
  readonly artists?: { readonly items?: readonly { readonly profile?: { readonly name?: string } }[] };
  readonly albumOfTrack?: {
    readonly name?: string;
    readonly date?: { readonly isoString?: string };
    readonly coverArt?: { readonly sources?: readonly PartnerImageSource[] };
  };
}

interface PartnerPlaylistData {
  readonly playlistV2?: {
    readonly content?: {
      readonly totalCount?: number;
      readonly items?: readonly { readonly itemV2?: { readonly data?: PartnerTrackData } }[];
    };
  };
}

interface PartnerSearchData {
  readonly searchV2?: {
    readonly playlists?: {
      readonly items?: readonly { readonly data?: { readonly uri?: string; readonly name?: string } }[];
    };
  };
}

export interface RandomPlaylist {
  readonly playlistId: string;
  readonly name: string;
}

export interface PlaylistFetchResult extends SpotifyPlaylist {
  readonly source: "full" | "embed";
}

export interface PlaylistSource {
  getPlaylist(playlistId: string, signal?: AbortSignal): Promise<PlaylistFetchResult>;
  enrich?(track: SpotifyTrack, signal?: AbortSignal): Promise<SpotifyTrack>;
  findRandomPlaylist?(signal?: AbortSignal): Promise<RandomPlaylist>;
}

export interface SpotifyClientOptions {
  readonly logger?: Logger;
  readonly clientTokens?: ClientTokenProvider;
  readonly pageDelayMs?: number;
  readonly random?: () => number;
}

function largestImage<T>(items: readonly T[] | undefined, width: (item: T) => number, url: (item: T) => string | undefined): string | undefined {
  if (!items || items.length === 0) {
    return undefined;
  }
  return url(items.reduce((best, item) => (width(item) > width(best) ? item : best)));
}

function parseYear(isoString: string | undefined): number | undefined {
  if (isoString === undefined || isoString === "") {
    return undefined;
  }
  const year = new Date(isoString).getUTCFullYear();
  return Number.isFinite(year) ? year : undefined;
}

function mapEmbedTracks(entity: EmbedPlaylistEntity): SpotifyPlaylist {
  const seen = new Map<string, SpotifyTrack>();
  let unavailable = 0;
  entity.trackList.forEach((item, index) => {
    if (item.entityType !== "track") {
      return;
    }
    if (!item.isPlayable || item.title.trim() === "") {
      unavailable += 1;
      return;
    }
    const id = TRACK_URI_PATTERN.exec(item.uri)?.[1];
    if (!id || seen.has(id)) {
      return;
    }
    seen.set(id, {
      id,
      title: item.title,
      artists: [item.subtitle],
      album: undefined,
      durationMs: item.duration,
      position: index + 1,
      releaseYear: undefined,
      coverUrl: undefined,
    });
  });
  const tracks = [...seen.values()];
  return { tracks, unavailable, complete: entity.trackList.length < EMBED_TRACK_LIST_CAP };
}

function mapPartnerTrack(data: PartnerTrackData, position: number): SpotifyTrack | "unavailable" | undefined {
  if (data.__typename !== "Track") {
    return undefined;
  }
  const id = TRACK_URI_PATTERN.exec(data.uri ?? "")?.[1];
  const title = (data.name ?? "").trim();
  if (!id || title === "" || data.playability?.playable === false) {
    return "unavailable";
  }
  const artists = (data.artists?.items ?? [])
    .map((artist) => artist.profile?.name ?? "")
    .filter((name) => name !== "");
  return {
    id,
    title,
    artists: artists.length > 0 ? artists : ["Unknown Artist"],
    album: data.albumOfTrack?.name || undefined,
    durationMs: data.trackDuration?.totalMilliseconds ?? 0,
    position,
    releaseYear: parseYear(data.albumOfTrack?.date?.isoString),
    coverUrl: largestImage(data.albumOfTrack?.coverArt?.sources, (s) => s.width ?? 0, (s) => s.url),
  };
}

export class SpotifyClient implements PlaylistSource {
  private readonly logger: Logger;
  private readonly clientTokens: ClientTokenProvider;
  private readonly hashes = new QueryHashProvider();
  private readonly pageDelayMs: number;
  private readonly random: () => number;
  private accessToken: string | undefined;
  private accessTokenExpiresAtMs = 0;
  private tokenReference = `${EMBED_BASE}/track/${TOKEN_REFERENCE_TRACK}`;

  constructor(options: SpotifyClientOptions = {}) {
    this.logger = options.logger ?? rootLogger.child("spotify");
    this.clientTokens = options.clientTokens ?? new SpotifyClientTokenProvider();
    this.pageDelayMs = options.pageDelayMs ?? 250;
    this.random = options.random ?? Math.random;
  }

  private rememberSession(session: EmbedSession | undefined): void {
    if (session?.accessToken) {
      this.accessToken = session.accessToken;
      this.accessTokenExpiresAtMs = session.accessTokenExpirationTimestampMs - TOKEN_MARGIN_MS;
    }
  }

  private async getAccessToken(forceRefresh: boolean, signal?: AbortSignal): Promise<string> {
    if (!forceRefresh && this.accessToken !== undefined && Date.now() < this.accessTokenExpiresAtMs) {
      return this.accessToken;
    }
    const page = await fetchEmbedPage<unknown>(this.tokenReference, signal);
    if (!page.session?.accessToken) {
      throw new Error("Spotify did not provide an anonymous access token");
    }
    this.rememberSession(page.session);
    return page.session.accessToken;
  }

  private context(): PathfinderContext {
    return {
      getAccessToken: (force, signal) => this.getAccessToken(force, signal),
      clientTokens: this.clientTokens,
      hashes: this.hashes,
      logger: this.logger,
    };
  }

  private async fetchFullPlaylist(playlistId: string, signal?: AbortSignal): Promise<SpotifyPlaylist> {
    const collected = new Map<string, SpotifyTrack>();
    let unavailable = 0;
    let offset = 0;

    for (;;) {
      const data = (await pathfinderQuery(
        this.context(),
        "fetchPlaylist",
        { uri: `spotify:playlist:${playlistId}`, offset, limit: PAGE_SIZE, enableWatchFeedEntrypoint: false },
        signal,
      )) as PartnerPlaylistData | undefined;
      const content = data?.playlistV2?.content;
      if (content === undefined) {
        throw new NonRetryableError(`Spotify returned no playlist data for ${playlistId}`);
      }
      const items = content.items ?? [];
      const total = content.totalCount ?? 0;
      this.logger.debug(`Playlist ${playlistId}: page at offset ${offset}, ${items.length} items of ${total}`);

      items.forEach((item, index) => {
        const mapped = item.itemV2?.data ? mapPartnerTrack(item.itemV2.data, offset + index + 1) : undefined;
        if (mapped === "unavailable") {
          unavailable += 1;
        } else if (mapped !== undefined && !collected.has(mapped.id)) {
          collected.set(mapped.id, mapped);
        }
      });

      offset += items.length;
      if (items.length === 0 || offset >= total) {
        break;
      }
      if (this.pageDelayMs > 0) {
        await abortableSleep(this.pageDelayMs, signal);
      }
    }
    return { tracks: [...collected.values()], unavailable, complete: true };
  }

  async getPlaylist(playlistId: string, signal?: AbortSignal): Promise<PlaylistFetchResult> {
    this.tokenReference = `${EMBED_BASE}/playlist/${playlistId}`;
    const page = await fetchEmbedPage<EmbedPlaylistEntity>(this.tokenReference, signal);
    this.rememberSession(page.session);
    const embed: PlaylistFetchResult = { ...mapEmbedTracks(page.entity), source: "embed" };

    if (!page.session?.accessToken) {
      this.logger.warn("Spotify exposed no session token; using the embed list (max 100 tracks)");
      return embed;
    }
    try {
      const full = await this.fetchFullPlaylist(playlistId, signal);
      if (full.tracks.length < embed.tracks.length) {
        this.logger.warn(
          `Full list returned ${full.tracks.length} tracks but the embed page listed ${embed.tracks.length}; using the embed list`,
        );
        return embed;
      }
      return { ...full, source: "full" };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      this.logger.warn(
        `Full track list unavailable (${errorMessage(error)}); using the embed list (max ${EMBED_TRACK_LIST_CAP} tracks)`,
      );
      return embed;
    }
  }

  async enrich(track: SpotifyTrack, signal?: AbortSignal): Promise<SpotifyTrack> {
    if (track.coverUrl !== undefined && track.releaseYear !== undefined) {
      return track;
    }
    const page = await fetchEmbedPage<EmbedTrackEntity>(`${EMBED_BASE}/track/${track.id}`, signal);
    this.rememberSession(page.session);
    const entity = page.entity;
    return {
      ...track,
      artists: entity.artists.length > 0 ? entity.artists.map((artist) => artist.name) : track.artists,
      releaseYear: track.releaseYear ?? parseYear(entity.releaseDate?.isoString),
      coverUrl:
        track.coverUrl ??
        largestImage(entity.visualIdentity?.image, (i) => i.maxWidth ?? 0, (i) => i.url),
    };
  }

  async findRandomPlaylist(signal?: AbortSignal): Promise<RandomPlaylist> {
    const word = RANDOM_SEARCH_WORDS[Math.floor(this.random() * RANDOM_SEARCH_WORDS.length)] ?? "music";
    const data = (await pathfinderQuery(
      this.context(),
      "searchPlaylists",
      {
        searchTerm: word,
        offset: 0,
        limit: 30,
        numberOfTopResults: 5,
        includeAudiobooks: false,
        includePreReleases: false,
        includeLocalConcertsField: false,
        includeArtistHasConcertsField: false,
        includeAuthors: false,
      },
      signal,
    )) as PartnerSearchData | undefined;

    const found = (data?.searchV2?.playlists?.items ?? []).flatMap((item) => {
      const id = PLAYLIST_URI_PATTERN.exec(item.data?.uri ?? "")?.[1];
      return id && item.data?.name ? [{ playlistId: id, name: item.data.name }] : [];
    });
    const picked = found[Math.floor(this.random() * found.length)];
    if (picked === undefined) {
      throw new Error(`Spotify search for "${word}" returned no public playlists`);
    }
    this.logger.debug(`Random search "${word}": ${found.length} playlists, picked "${picked.name}"`);
    return picked;
  }
}
