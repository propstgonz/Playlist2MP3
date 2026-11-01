import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyClient, EMBED_TRACK_LIST_CAP } from "../src/playlist/spotify.js";
import { KNOWN_QUERY_HASHES, findHashInSource, lazyChunkUrls } from "../src/playlist/queryHash.js";
import { NonRetryableError } from "../src/utils/retry.js";
import { rootLogger } from "../src/utils/logger.js";
import "./helpers.js";

const CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken";
const PATHFINDER_PREFIX = "https://api-partner.spotify.com/pathfinder/v1/query";
const WEB_PLAYER_URL = "https://open.spotify.com/";
const BUNDLE_URL = "https://open.spotifycdn.com/cdn/build/web-player/web-player.deadbeef.js";
const ROTATED_HASH = "a".repeat(64);

function trackId(index: number): string {
  return `t${String(index).padStart(21, "0")}`;
}

function embedHtml(entity: unknown, withSession = true): string {
  const nextData = {
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
          data: { entity },
        },
      },
    },
  };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`;
}

function embedItem(index: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    uri: `spotify:track:${trackId(index)}`,
    title: `Embed Song ${index}`,
    subtitle: "Embed Artist",
    duration: 180_000,
    entityType: "track",
    isPlayable: true,
    ...overrides,
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
          name: "The Album",
          date: { isoString: "1989-05-02T00:00:00Z" },
          coverArt: { sources: [{ url: "small.jpg", width: 64 }, { url: "large.jpg", width: 640 }] },
        },
        ...overrides,
      },
    },
  };
}

function partnerPage(items: readonly unknown[], totalCount: number): string {
  return JSON.stringify({ data: { playlistV2: { content: { totalCount, items } } } });
}

function searchPage(names: readonly string[]): string {
  return JSON.stringify({
    data: {
      searchV2: {
        playlists: {
          items: names.map((name, i) => ({ data: { uri: `spotify:playlist:pl${i}xxxxxxxxxxxxxxxxxx`, name } })),
        },
      },
    },
  });
}

function query(url: string, param: "variables" | "extensions" | "operationName"): unknown {
  const raw = new URL(url).searchParams.get(param) ?? "{}";
  return param === "operationName" ? raw : JSON.parse(raw);
}

function offsetOf(url: string): number {
  return (query(url, "variables") as { offset?: number }).offset ?? 0;
}

function hashOf(url: string): string {
  return (query(url, "extensions") as { persistedQuery: { sha256Hash: string } }).persistedQuery.sha256Hash;
}

interface RouterOptions {
  readonly embedTracks?: readonly unknown[];
  readonly withSession?: boolean;
  readonly embedStatus?: number;
  readonly pathfinder?: (url: string, callIndex: number) => Response;
}

function makeFetch(options: RouterOptions): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let pathfinderCalls = 0;
  const handler = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.startsWith(CLIENT_TOKEN_URL)) {
      return new Response(
        JSON.stringify({
          response_type: "RESPONSE_GRANTED_TOKEN_RESPONSE",
          granted_token: { token: "client-token", refresh_after_seconds: 3600 },
        }),
        { status: 200 },
      );
    }
    if (url.startsWith(PATHFINDER_PREFIX)) {
      const response = (options.pathfinder ?? (() => new Response("down", { status: 500 })))(url, pathfinderCalls);
      pathfinderCalls += 1;
      return response;
    }
    if (url === WEB_PLAYER_URL) {
      return new Response(`<html><script src="${BUNDLE_URL}"></script></html>`, { status: 200 });
    }
    if (url === BUNDLE_URL) {
      return new Response(`x={"fetchPlaylist":"${ROTATED_HASH}"};`, { status: 200 });
    }
    if (url.includes("/embed/")) {
      if (options.embedStatus !== undefined) {
        return new Response("", { status: options.embedStatus });
      }
      return new Response(embedHtml({ trackList: options.embedTracks ?? [] }, options.withSession ?? true), { status: 200 });
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

function client(random: () => number = Math.random): SpotifyClient {
  return new SpotifyClient({ logger: rootLogger, pageDelayMs: 0, random });
}

test("reads the full playlist page by page past the 100-track embed cap", async () => {
  const total = 250;
  const router = makeFetch({
    embedTracks: Array.from({ length: EMBED_TRACK_LIST_CAP }, (_, i) => embedItem(i)),
    pathfinder: (url) => {
      const offset = offsetOf(url);
      const items = Array.from({ length: Math.min(100, total - offset) }, (_, i) => partnerTrack(offset + i));
      return new Response(partnerPage(items, total), { status: 200 });
    },
  });
  await withFetch(router.fetch, async () => {
    const result = await client().getPlaylist("playlist123");
    assert.equal(result.source, "full");
    assert.equal(result.complete, true);
    assert.equal(result.tracks.length, total);
    assert.equal(result.tracks[249]?.position, 250);
  });
  assert.deepEqual(router.calls.filter((u) => u.startsWith(PATHFINDER_PREFIX)).map(offsetOf), [0, 100, 200]);
});

test("maps artists, album, duration, year and the largest cover", async () => {
  const router = makeFetch({ pathfinder: () => new Response(partnerPage([partnerTrack(1)], 1), { status: 200 }) });
  await withFetch(router.fetch, async () => {
    const track = (await client().getPlaylist("p")).tracks[0];
    assert.deepEqual(track?.artists, ["Main Artist", "Feature"]);
    assert.equal(track?.album, "The Album");
    assert.equal(track?.durationMs, 200_001);
    assert.equal(track?.releaseYear, 1989);
    assert.equal(track?.coverUrl, "large.jpg");
  });
});

test("leaves out unplayable tracks, non-track items and duplicates", async () => {
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
    const result = await client().getPlaylist("p");
    assert.equal(result.tracks.length, 1);
    assert.equal(result.unavailable, 1);
  });
});

test("refreshes the session once when Spotify answers 401", async () => {
  const router = makeFetch({
    pathfinder: (_url, call) =>
      call === 0 ? new Response("no", { status: 401 }) : new Response(partnerPage([partnerTrack(1)], 1), { status: 200 }),
  });
  await withFetch(router.fetch, async () => {
    assert.equal((await client().getPlaylist("p")).source, "full");
  });
  assert.equal(router.calls.filter((u) => u.startsWith(CLIENT_TOKEN_URL)).length, 2);
});

test("rediscovers the query hash when Spotify rotates it", async () => {
  const used: string[] = [];
  const router = makeFetch({
    pathfinder: (url) => {
      used.push(hashOf(url));
      return hashOf(url) === KNOWN_QUERY_HASHES.fetchPlaylist
        ? new Response(JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] }), { status: 200 })
        : new Response(partnerPage([partnerTrack(1)], 1), { status: 200 });
    },
  });
  await withFetch(router.fetch, async () => {
    assert.equal((await client().getPlaylist("p")).tracks.length, 1);
  });
  assert.deepEqual(used, [KNOWN_QUERY_HASHES.fetchPlaylist, ROTATED_HASH]);
});

test("falls back to the embed list, marked incomplete when it hits the cap", async () => {
  const small = makeFetch({ embedTracks: [embedItem(1), embedItem(2)] });
  await withFetch(small.fetch, async () => {
    const result = await client().getPlaylist("p");
    assert.equal(result.source, "embed");
    assert.equal(result.complete, true);
    assert.equal(result.tracks[0]?.title, "Embed Song 1");
  });
  const capped = makeFetch({ embedTracks: Array.from({ length: EMBED_TRACK_LIST_CAP }, (_, i) => embedItem(i)) });
  await withFetch(capped.fetch, async () => {
    assert.equal((await client().getPlaylist("p")).complete, false);
  });
});

test("uses the embed list without a session token and counts blanked tracks as unavailable", async () => {
  const router = makeFetch({
    withSession: false,
    embedTracks: [embedItem(1), embedItem(2, { title: "", isPlayable: false }), { ...(embedItem(3) as object), entityType: "episode" }],
  });
  await withFetch(router.fetch, async () => {
    const result = await client().getPlaylist("p");
    assert.equal(result.tracks.length, 1);
    assert.equal(result.unavailable, 1);
  });
  assert.equal(router.calls.filter((u) => u.startsWith(PATHFINDER_PREFIX)).length, 0);
});

test("a private or missing playlist fails without retrying", async () => {
  const router = makeFetch({ embedStatus: 404 });
  await withFetch(router.fetch, async () => {
    await assert.rejects(client().getPlaylist("missing"), NonRetryableError);
  });
});

test("picks a random public playlist from a Spotify search", async () => {
  const router = makeFetch({
    pathfinder: (url) => {
      assert.equal(query(url, "operationName"), "searchPlaylists");
      return new Response(searchPage(["First", "Second", "Third"]), { status: 200 });
    },
  });
  await withFetch(router.fetch, async () => {
    const picked = await client(() => 0.5).findRandomPlaylist();
    assert.equal(picked.name, "Second");
    assert.equal(picked.playlistId, "pl1xxxxxxxxxxxxxxxxxx");
  });
});

test("reports when the random search finds nothing", async () => {
  const router = makeFetch({ pathfinder: () => new Response(searchPage([]), { status: 200 }) });
  await withFetch(router.fetch, async () => {
    await assert.rejects(client().findRandomPlaylist(), /no public playlists/);
  });
});

test("finds query hashes in exact and loose bundle formats", () => {
  const hash = "b".repeat(64);
  assert.equal(findHashInSource(`new x("searchPlaylists","query","${hash}",null)`, "searchPlaylists"), hash);
  assert.equal(findHashInSource(`{"fetchPlaylist":"${hash}"}`, "fetchPlaylist"), hash);
  assert.equal(findHashInSource("nothing here", "fetchPlaylist"), undefined);
});

test("builds lazy chunk urls from the webpack chunk map, preferred chunks first", () => {
  const source = 'u.u=e=>""+(({12:"xpui-routes-album",34:"xpui-routes-search"})[e]||e)+"."+({12:"aaaa1111",34:"bbbb2222",56:"cccc3333"})[e]+".js"';
  assert.deepEqual(lazyChunkUrls(source, "https://cdn/x/web-player.abc.js", "search"), [
    "https://cdn/x/xpui-routes-search.bbbb2222.js",
    "https://cdn/x/xpui-routes-album.aaaa1111.js",
    "https://cdn/x/56.cccc3333.js",
  ]);
});
