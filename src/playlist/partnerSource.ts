import type { SpotifyTrack } from "../types/index.js";
import type { Logger } from "../utils/logger.js";
import { BROWSER_HEADERS } from "./embedPage.js";
import { WEB_PLAYER_VERSION, type ClientTokenProvider } from "./clientToken.js";
import { PARTNER_OPERATION_NAME, type PartnerQueryHashProvider } from "./partnerHash.js";
import { NonRetryableError } from "../utils/retry.js";

const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query";
const TRACK_URI_PATTERN = /^spotify:track:([a-zA-Z0-9]+)$/;
const MAX_PAGE_ATTEMPTS = 3;

export const PARTNER_PAGE_LIMIT = 100;

interface PartnerImageSource {
  readonly url?: string;
  readonly width?: number | null;
}

interface PartnerArtistItem {
  readonly profile?: { readonly name?: string };
}

interface PartnerTrackData {
  readonly __typename?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly trackDuration?: { readonly totalMilliseconds?: number };
  readonly playability?: { readonly playable?: boolean };
  readonly artists?: { readonly items?: readonly PartnerArtistItem[] };
  readonly albumOfTrack?: {
    readonly date?: { readonly isoString?: string };
    readonly coverArt?: { readonly sources?: readonly PartnerImageSource[] };
  };
}

interface PartnerPlaylistItem {
  readonly itemV2?: { readonly data?: PartnerTrackData };
}

interface PartnerResponse {
  readonly errors?: readonly { readonly message?: string }[];
  readonly data?: {
    readonly playlistV2?: {
      readonly __typename?: string;
      readonly name?: string;
      readonly content?: {
        readonly totalCount?: number;
        readonly items?: readonly PartnerPlaylistItem[];
      };
    };
  };
}

export interface PartnerFetchContext {
  readonly getAccessToken: (forceRefresh: boolean, signal?: AbortSignal) => Promise<string>;
  readonly clientTokens: ClientTokenProvider;
  readonly hashes: PartnerQueryHashProvider;
  readonly pageDelayMs: number;
  readonly logger: Logger;
}

export interface PartnerTracksResult {
  readonly playlistName: string | undefined;
  readonly tracks: readonly SpotifyTrack[];
  readonly unavailableCount: number;
  readonly totalCount: number;
}

function pickLargestCover(sources: readonly PartnerImageSource[] | undefined): string | undefined {
  if (!sources || sources.length === 0) {
    return undefined;
  }
  const best = sources.reduce((current, candidate) =>
    (candidate.width ?? 0) > (current.width ?? 0) ? candidate : current,
  );
  return best.url;
}

function parseReleaseYear(isoString: string | undefined): number | undefined {
  if (isoString === undefined || isoString === "") {
    return undefined;
  }
  const year = new Date(isoString).getUTCFullYear();
  return Number.isFinite(year) ? year : undefined;
}

function buildQueryUrl(playlistId: string, offset: number, hash: string): string {
  const variables = {
    uri: `spotify:playlist:${playlistId}`,
    offset,
    limit: PARTNER_PAGE_LIMIT,
    enableWatchFeedEntrypoint: false,
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: hash } };
  return (
    `${PATHFINDER_URL}?operationName=${PARTNER_OPERATION_NAME}` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`
  );
}

function isPersistedQueryError(payload: PartnerResponse): boolean {
  return (payload.errors ?? []).some((entry) =>
    (entry.message ?? "").toLowerCase().includes("persistedquerynotfound"),
  );
}

async function requestPage(
  playlistId: string,
  offset: number,
  context: PartnerFetchContext,
  signal?: AbortSignal,
): Promise<PartnerResponse> {
  let forceTokenRefresh = false;

  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
    const accessToken = await context.getAccessToken(forceTokenRefresh, signal);
    const clientToken = await context.clientTokens.getClientToken(signal);
    const url = buildQueryUrl(playlistId, offset, context.hashes.getHash());

    const response = await fetch(url, {
      signal,
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "client-token": clientToken,
        "app-platform": "WebPlayer",
        "spotify-app-version": WEB_PLAYER_VERSION,
      },
    });

    if (response.status === 401 || response.status === 403) {
      if (attempt === MAX_PAGE_ATTEMPTS) {
        throw new Error(`Spotify pathfinder rejected the session (status ${response.status})`);
      }
      context.logger.debug(
        `Pathfinder returned ${response.status} at offset ${offset}, refreshing tokens`,
      );
      context.clientTokens.invalidate();
      forceTokenRefresh = true;
      continue;
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      throw new NonRetryableError(
        `Spotify pathfinder rate limited this client (retry after ${retryAfter}s)`,
      );
    }

    if (!response.ok) {
      throw new Error(`Spotify pathfinder request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as PartnerResponse;

    if (isPersistedQueryError(payload) && attempt < MAX_PAGE_ATTEMPTS) {
      const refreshed = await context.hashes.refresh(signal);
      if (refreshed !== undefined) {
        context.logger.debug(`Pathfinder query hash rotated, retrying with ${refreshed}`);
        continue;
      }
      throw new NonRetryableError(
        "Spotify pathfinder rejected the persisted query and no replacement hash was found",
      );
    }

    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((entry) => entry.message ?? "unknown").join("; ");
      throw new Error(`Spotify pathfinder returned errors: ${message}`);
    }

    return payload;
  }

  throw new Error("Spotify pathfinder request exhausted its attempts");
}

export async function fetchPartnerPlaylistTracks(
  playlistId: string,
  context: PartnerFetchContext,
  signal?: AbortSignal,
): Promise<PartnerTracksResult> {
  const collected = new Map<string, SpotifyTrack>();
  let unavailableCount = 0;
  let playlistName: string | undefined;
  let totalCount = 0;
  let offset = 0;

  for (;;) {
    const payload = await requestPage(playlistId, offset, context, signal);
    const playlist = payload.data?.playlistV2;

    if (!playlist || playlist.content === undefined) {
      throw new NonRetryableError(
        `Spotify pathfinder returned no playlist data (playlistId: ${playlistId})`,
      );
    }

    playlistName = playlist.name ?? playlistName;
    totalCount = playlist.content.totalCount ?? totalCount;
    const items = playlist.content.items ?? [];

    if (items.length === 0) {
      break;
    }

    items.forEach((item, indexInPage) => {
      const track = item.itemV2?.data;
      if (!track || track.__typename !== "Track") {
        return;
      }
      const match = TRACK_URI_PATTERN.exec(track.uri ?? "");
      const id = match?.[1];
      const title = (track.name ?? "").trim();
      if (!id || title === "") {
        unavailableCount += 1;
        return;
      }
      if (track.playability?.playable === false) {
        unavailableCount += 1;
        return;
      }
      if (collected.has(id)) {
        return;
      }
      const artists = (track.artists?.items ?? [])
        .map((artist) => artist.profile?.name ?? "")
        .filter((name) => name !== "");

      collected.set(id, {
        id,
        title,
        artists: artists.length > 0 ? artists : ["Unknown Artist"],
        durationMs: track.trackDuration?.totalMilliseconds ?? 0,
        trackNumber: offset + indexInPage + 1,
        releaseYear: parseReleaseYear(track.albumOfTrack?.date?.isoString),
        coverUrl: pickLargestCover(track.albumOfTrack?.coverArt?.sources),
      });
    });

    offset += items.length;

    if (offset >= totalCount) {
      break;
    }

    if (context.pageDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, context.pageDelayMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Aborted while paginating Spotify playlist"));
          },
          { once: true },
        );
      });
    }
  }

  return {
    playlistName,
    tracks: [...collected.values()],
    unavailableCount,
    totalCount,
  };
}
