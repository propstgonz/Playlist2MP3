import type { SpotifyTrack } from "../types/index.js";
import { rootLogger, type Logger } from "../utils/logger.js";
import { EMBED_BASE, fetchEmbedPage, type EmbedSession } from "./embedPage.js";
import { SpotifyClientTokenProvider, type ClientTokenProvider } from "./clientToken.js";
import { PartnerQueryHashProvider } from "./partnerHash.js";
import { fetchPartnerPlaylistTracks, type PartnerFetchContext } from "./partnerSource.js";

const TRACK_URI_PATTERN = /^spotify:track:([a-zA-Z0-9]+)$/;
const TOKEN_MARGIN_MS = 30_000;
const DEFAULT_PAGE_DELAY_MS = 250;

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
  readonly name?: string;
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

export type TrackSourceKind = "partner" | "embed";

export interface PlaylistTracksResult {
  readonly tracks: readonly SpotifyTrack[];
  readonly unavailableCount: number;
  readonly source?: TrackSourceKind;
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
  getTrackDetails?(track: SpotifyTrack, signal?: AbortSignal): Promise<SpotifyTrack>;
  findRandomPublicPlaylist?(signal?: AbortSignal): Promise<RandomPlaylistResult>;
}

export interface SpotifyClientOptions {
  readonly logger?: Logger;
  readonly clientTokens?: ClientTokenProvider;
  readonly partnerQueryHash?: string;
  readonly pageDelayMs?: number;
  readonly partnerEnabled?: boolean;
}

function pickLargestImage(images: readonly EmbedImage[] | undefined): string | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }
  return images.reduce((best, image) =>
    (image.maxWidth ?? 0) > (best.maxWidth ?? 0) ? image : best,
  ).url;
}

function mapEmbedTracks(entity: EmbedPlaylistEntity): PlaylistTracksResult {
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

  return { tracks: [...seen.values()], unavailableCount, source: "embed" };
}

export class SpotifyClient implements PlaylistTrackSource {
  private readonly logger: Logger;
  private readonly clientTokens: ClientTokenProvider;
  private readonly hashes: PartnerQueryHashProvider;
  private readonly pageDelayMs: number;
  private readonly partnerEnabled: boolean;
  private accessToken: string | undefined;
  private accessTokenExpiresAtMs = 0;
  private lastPlaylistId: string | undefined;

  constructor(options: SpotifyClientOptions = {}) {
    this.logger = options.logger ?? rootLogger.child("spotify");
    this.clientTokens = options.clientTokens ?? new SpotifyClientTokenProvider();
    this.hashes = new PartnerQueryHashProvider(options.partnerQueryHash);
    this.pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
    this.partnerEnabled = options.partnerEnabled ?? true;
  }

  private rememberSession(session: EmbedSession | undefined): void {
    if (!session?.accessToken) {
      return;
    }
    this.accessToken = session.accessToken;
    this.accessTokenExpiresAtMs = session.accessTokenExpirationTimestampMs - TOKEN_MARGIN_MS;
  }

  private async getAccessToken(forceRefresh: boolean, signal?: AbortSignal): Promise<string> {
    if (!forceRefresh && this.accessToken !== undefined && Date.now() < this.accessTokenExpiresAtMs) {
      return this.accessToken;
    }
    const reference = this.lastPlaylistId;
    const url =
      reference !== undefined
        ? `${EMBED_BASE}/playlist/${reference}`
        : `${EMBED_BASE}/track/4uLU6hMCjMI75M1A2tKUQC`;
    const page = await fetchEmbedPage<unknown>(url, signal);
    if (!page.session?.accessToken) {
      throw new Error("Spotify embed page did not expose an anonymous access token");
    }
    this.rememberSession(page.session);
    return page.session.accessToken;
  }

  async getPlaylistTracks(
    playlistId: string,
    signal?: AbortSignal,
  ): Promise<PlaylistTracksResult> {
    this.lastPlaylistId = playlistId;

    const page = await fetchEmbedPage<EmbedPlaylistEntity>(
      `${EMBED_BASE}/playlist/${playlistId}`,
      signal,
    );
    this.rememberSession(page.session);
    const embedResult = mapEmbedTracks(page.entity);

    if (!this.partnerEnabled) {
      return embedResult;
    }
    if (!page.session?.accessToken) {
      this.logger.warn(
        "Spotify embed page exposed no access token, falling back to the embed track list " +
          `(capped at ${EMBED_TRACK_LIST_CAP} tracks)`,
      );
      return embedResult;
    }

    const context: PartnerFetchContext = {
      getAccessToken: (forceRefresh, abortSignal) =>
        this.getAccessToken(forceRefresh, abortSignal),
      clientTokens: this.clientTokens,
      hashes: this.hashes,
      pageDelayMs: this.pageDelayMs,
      logger: this.logger,
    };

    try {
      const partner = await fetchPartnerPlaylistTracks(playlistId, context, signal);
      if (partner.tracks.length < embedResult.tracks.length) {
        this.logger.warn(
          `Full-catalog source returned ${partner.tracks.length} tracks but the embed page listed ` +
            `${embedResult.tracks.length}, keeping the embed list`,
        );
        return embedResult;
      }
      return {
        tracks: partner.tracks,
        unavailableCount: partner.unavailableCount,
        source: "partner",
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Full-catalog source unavailable (${reason}), falling back to the embed track list ` +
          `(capped at ${EMBED_TRACK_LIST_CAP} tracks)`,
      );
      return embedResult;
    }
  }

  async getTrackDetails(track: SpotifyTrack, signal?: AbortSignal): Promise<SpotifyTrack> {
    const page = await fetchEmbedPage<EmbedTrackEntity>(
      `${EMBED_BASE}/track/${track.id}`,
      signal,
    );
    this.rememberSession(page.session);
    const entity = page.entity;

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
