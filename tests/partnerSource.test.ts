import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyClient, EMBED_TRACK_LIST_CAP } from "../src/playlist/spotifyClient.js";
import { FALLBACK_PARTNER_QUERY_HASH } from "../src/playlist/partnerHash.js";

const CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken";
const PATHFINDER_PREFIX = "https://api-partner.spotify.com/pathfinder/v1/query";
const WEB_PLAYER_URL = "https://open.spotify.com/";
const BUNDLE_URL = "https://open.spotifycdn.com/cdn/build/web-player/web-player.deadbeef.js";
const ROTATED_HASH = "a".repeat(64);

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function trackId(index: number): string {
  return `t${String(index).padStart(21, "0")}`;
}

function embedHtml(nextData: unknown): string {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData,
  )}</script></body></html>`;
}

function embedPlaylistPage(trackList: readonly unknown[], withSession = true): string {
  return embedHtml({
    props: {
      pageProps: {
        state: {
          settings: withSession
            ? {
                session: {
                  accessToken: "anonymous-access-token",
                  accessTokenExpirationTimestampMs: Date.now() + 3_600_000,
                  isAnonymous: true,
                },
              }
            : undefined,
          data: { entity: { name: "Embed Name", trackList } },
        },
      },
    },
  });
}

function embedTrackItem(index: number): unknown {
  return {
    uri: `spotify:track:${trackId(index)}`,
    title: `Embed Song ${index}`,
    subtitle: "Embed Artist",
    duration: 180_000,
    entityType: "track",
    isPlayable: true,
  };
}

function partnerTrack(index: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    itemV2: {
      data: {
        __typename: "Track",
        uri: `spotify:track:${trackId(index)}`,
        name: `Song ${index}`,
        trackDuration: { totalMilliseconds: 200_000 + index },
        playability: { playable: true },
        artists: { items: [{ profile: { name: "Main Artist" } }, { profile: { name: "Feature" } }] },
        albumOfTrack: {
          date: { isoString: "1989-05-02T00:00:00Z" },
          coverArt: {
            sources: [
              { url: "small.jpg", width: 64 },
              { url: "large.jpg", width: 640 },
              { url: "medium.jpg", width: 300 },
            ],
          },
        },
        ...overrides,
      },
    },
  };
}

function partnerPage(items: readonly unknown[], totalCount: number): string {
  return JSON.stringify({
    data: {
      playlistV2: {
        __typename: "Playlist",
        name: "Partner Name",
        content: { totalCount, items },
      },
    },
  });
}

function offsetOf(url: string): number {
  const variables = new URL(url).searchParams.get("variables") ?? "{}";
  return (JSON.parse(variables) as { offset?: number }).offset ?? 0;
}

function hashOf(url: string): string {
  const extensions = new URL(url).searchParams.get("extensions") ?? "{}";
  return (
    JSON.parse(extensions) as { persistedQuery?: { sha256Hash?: string } }
  ).persistedQuery?.sha256Hash as string;
}

interface RouterOptions {
  readonly embedTracks?: readonly unknown[];
  readonly withSession?: boolean;
  readonly pathfinder: (url: string, callIndex: number) => Response;
  readonly clientTokenStatus?: number;
}

function makeFetch(options: RouterOptions): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let pathfinderCalls = 0;

  const handler = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);

    if (url.startsWith(CLIENT_TOKEN_URL)) {
      const status = options.clientTokenStatus ?? 200;
      if (status !== 200) {
        return new Response("nope", { status });
      }
      return new Response(
        JSON.stringify({
          response_type: "RESPONSE_GRANTED_TOKEN_RESPONSE",
          granted_token: { token: "client-token", refresh_after_seconds: 3600 },
        }),
        { status: 200 },
      );
    }

    if (url.startsWith(PATHFINDER_PREFIX)) {
      const response = options.pathfinder(url, pathfinderCalls);
      pathfinderCalls += 1;
      return response;
    }

    if (url === WEB_PLAYER_URL) {
      return new Response(`<html><script src="${BUNDLE_URL}"></script></html>`, { status: 200 });
    }

    if (url === BUNDLE_URL) {
      return new Response(`x={"fetchPlaylist":"${ROTATED_HASH}"};`, { status: 200 });
    }

    if (url.includes("/embed/playlist/")) {
      return new Response(
        embedPlaylistPage(options.embedTracks ?? [], options.withSession ?? true),
        { status: 200 },
      );
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  return { fetch: handler, calls };
}

async function withFetch(handler: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function makeClient(): SpotifyClient {
  return new SpotifyClient({ logger: silentLogger, pageDelayMs: 0 });
}

test("paginates past the 100-track embed cap", async () => {
  const total = 250;
  const router = makeFetch({
    embedTracks: Array.from({ length: EMBED_TRACK_LIST_CAP }, (_, i) => embedTrackItem(i)),
    pathfinder: (url) => {
      const offset = offsetOf(url);
      const size = Math.min(100, total - offset);
      const items = Array.from({ length: size }, (_, i) => partnerTrack(offset + i));
      return new Response(partnerPage(items, total), { status: 200 });
    },
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.source, "partner");
    assert.equal(result.tracks.length, total);
    assert.equal(result.tracks[0]?.title, "Song 0");
    assert.equal(result.tracks[249]?.title, "Song 249");
    assert.equal(result.tracks[249]?.trackNumber, 250);
  });

  const pages = router.calls.filter((url) => url.startsWith(PATHFINDER_PREFIX));
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(offsetOf), [0, 100, 200]);
});

test("maps artists, duration, release year and the largest cover", async () => {
  const router = makeFetch({
    pathfinder: () => new Response(partnerPage([partnerTrack(1)], 1), { status: 200 }),
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    const track = result.tracks[0];
    assert.deepEqual(track?.artists, ["Main Artist", "Feature"]);
    assert.equal(track?.durationMs, 200_001);
    assert.equal(track?.releaseYear, 1989);
    assert.equal(track?.coverUrl, "large.jpg");
  });
});

test("counts unplayable tracks and ignores non-track items", async () => {
  const router = makeFetch({
    pathfinder: () =>
      new Response(
        partnerPage(
          [
            partnerTrack(1),
            partnerTrack(2, { playability: { playable: false } }),
            { itemV2: { data: { __typename: "Episode", uri: "spotify:episode:xyz" } } },
            partnerTrack(1),
          ],
          4,
        ),
        { status: 200 },
      ),
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.tracks.length, 1);
    assert.equal(result.unavailableCount, 1);
  });
});

test("refreshes the session once when pathfinder answers 401", async () => {
  const router = makeFetch({
    pathfinder: (_url, callIndex) =>
      callIndex === 0
        ? new Response("unauthorized", { status: 401 })
        : new Response(partnerPage([partnerTrack(1)], 1), { status: 200 }),
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.source, "partner");
    assert.equal(result.tracks.length, 1);
  });

  const tokenCalls = router.calls.filter((url) => url.startsWith(CLIENT_TOKEN_URL));
  assert.equal(tokenCalls.length, 2);
});

test("rediscovers the persisted query hash when Spotify rotates it", async () => {
  const usedHashes: string[] = [];
  const router = makeFetch({
    pathfinder: (url) => {
      usedHashes.push(hashOf(url));
      if (hashOf(url) === FALLBACK_PARTNER_QUERY_HASH) {
        return new Response(
          JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] }),
          { status: 200 },
        );
      }
      return new Response(partnerPage([partnerTrack(1)], 1), { status: 200 });
    },
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.source, "partner");
    assert.equal(result.tracks.length, 1);
  });

  assert.deepEqual(usedHashes, [FALLBACK_PARTNER_QUERY_HASH, ROTATED_HASH]);
});

test("falls back to the embed track list when pathfinder keeps failing", async () => {
  const router = makeFetch({
    embedTracks: [embedTrackItem(1), embedTrackItem(2)],
    pathfinder: () => new Response("server error", { status: 500 }),
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.source, "embed");
    assert.equal(result.tracks.length, 2);
    assert.equal(result.tracks[0]?.title, "Embed Song 1");
  });
});

test("keeps the embed list when the full-catalog source returns fewer tracks", async () => {
  const router = makeFetch({
    embedTracks: [embedTrackItem(1), embedTrackItem(2), embedTrackItem(3)],
    pathfinder: () => new Response(partnerPage([partnerTrack(1)], 1), { status: 200 }),
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.source, "embed");
    assert.equal(result.tracks.length, 3);
  });
});

test("skips the full-catalog source when the embed page exposes no token", async () => {
  const router = makeFetch({
    embedTracks: [embedTrackItem(1)],
    withSession: false,
    pathfinder: () => new Response("must not be called", { status: 500 }),
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.source, "embed");
  });

  assert.equal(router.calls.filter((url) => url.startsWith(PATHFINDER_PREFIX)).length, 0);
});

test("reuses the cached client token across pages", async () => {
  const router = makeFetch({
    pathfinder: (url) => {
      const offset = offsetOf(url);
      const items = Array.from({ length: 100 }, (_, i) => partnerTrack(offset + i));
      return new Response(partnerPage(items, 200), { status: 200 });
    },
  });

  await withFetch(router.fetch, async () => {
    const result = await makeClient().getPlaylistTracks("playlist123");
    assert.equal(result.tracks.length, 200);
  });

  assert.equal(router.calls.filter((url) => url.startsWith(CLIENT_TOKEN_URL)).length, 1);
});
