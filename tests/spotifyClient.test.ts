import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyClient } from "../src/playlist/spotifyClient.js";
import { NonRetryableError } from "../src/utils/retry.js";

const TOKEN_URL = "https://open.spotify.com/get_access_token?reason=transport&productType=embed";

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      accessToken: "anon-token",
      accessTokenExpirationTimestampMs: Date.now() + 3_600_000,
    }),
    { status: 200 },
  );
}

function withFetch(handler: (url: string) => Promise<Response> | Response, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
    handler(String(input))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function withRandom(sequence: readonly number[], fn: () => Promise<void>): Promise<void> {
  const original = Math.random;
  let index = 0;
  Math.random = () => sequence[Math.min(index++, sequence.length - 1)] as number;
  return fn().finally(() => {
    Math.random = original;
  });
}

function apiTrack(id: string, name: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    is_local: false,
    track: {
      id,
      name,
      duration_ms: 180_000,
      is_playable: true,
      artists: [{ name: "Artist" }],
      album: { release_date: "1966-04-15", images: [{ url: "large.jpg", width: 640 }] },
      ...overrides,
    },
  };
}

test("parses tracks from a single API page", async () => {
  await withFetch(
    (url) => {
      if (url === TOKEN_URL) {
        return tokenResponse();
      }
      return new Response(
        JSON.stringify({ items: [apiTrack("t1", "Song One")], next: null, total: 1 }),
        { status: 200 },
      );
    },
    async () => {
      const client = new SpotifyClient();
      const { tracks } = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, 1);
      assert.equal(tracks[0]?.id, "t1");
      assert.equal(tracks[0]?.title, "Song One");
      assert.deepEqual(tracks[0]?.artists, ["Artist"]);
      assert.equal(tracks[0]?.releaseYear, 1966);
      assert.equal(tracks[0]?.coverUrl, "large.jpg");
    },
  );
});

test("follows the next link to fetch every page beyond the first 100 tracks", async () => {
  const nextUrl = "https://api.spotify.com/v1/playlists/abc/tracks?offset=100";
  let secondPageRequested = false;

  await withFetch(
    (url) => {
      if (url === TOKEN_URL) {
        return tokenResponse();
      }
      if (url === nextUrl) {
        secondPageRequested = true;
        return new Response(
          JSON.stringify({ items: [apiTrack("t101", "Song 101")], next: null, total: 101 }),
          { status: 200 },
        );
      }
      const firstPage = Array.from({ length: 100 }, (_, i) => apiTrack(`t${i}`, `Song ${i}`));
      return new Response(
        JSON.stringify({ items: firstPage, next: nextUrl, total: 101 }),
        { status: 200 },
      );
    },
    async () => {
      const client = new SpotifyClient();
      const { tracks } = await client.getPlaylistTracks("abc");
      assert.equal(secondPageRequested, true);
      assert.equal(tracks.length, 101);
      assert.equal(tracks[100]?.id, "t101");
    },
  );
});

test("skips local files and unplayable tracks, and deduplicates by id", async () => {
  await withFetch(
    (url) => {
      if (url === TOKEN_URL) {
        return tokenResponse();
      }
      return new Response(
        JSON.stringify({
          items: [
            { is_local: true, track: null },
            apiTrack("t1", "Song One", { is_playable: false }),
            apiTrack("t2", "Song Two"),
            apiTrack("t2", "Song Two"),
          ],
          next: null,
          total: 4,
        }),
        { status: 200 },
      );
    },
    async () => {
      const client = new SpotifyClient();
      const { tracks, unavailableCount } = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, 1);
      assert.equal(tracks[0]?.id, "t2");
      assert.equal(unavailableCount, 2);
    },
  );
});

test("throws a non-retryable error on 404", async () => {
  await withFetch(
    (url) => (url === TOKEN_URL ? tokenResponse() : new Response("", { status: 404 })),
    async () => {
      const client = new SpotifyClient();
      await assert.rejects(client.getPlaylistTracks("missing"), NonRetryableError);
    },
  );
});

test("throws a non-retryable error when the access token endpoint returns no token", async () => {
  await withFetch(
    () => new Response(JSON.stringify({}), { status: 200 }),
    async () => {
      const client = new SpotifyClient();
      await assert.rejects(client.getPlaylistTracks("abc"), NonRetryableError);
    },
  );
});

test("findRandomPublicPlaylist picks a playlist at a random offset within the result total", async () => {
  const requestedOffsets: number[] = [];

  await withFetch(
    (url) => {
      if (url === TOKEN_URL) {
        return tokenResponse();
      }
      const offsetMatch = /offset=(\d+)/.exec(url);
      const offset = Number(offsetMatch?.[1] ?? 0);
      requestedOffsets.push(offset);
      const isProbeRequest = requestedOffsets.length === 1;
      const item = isProbeRequest ? null : { id: "pl1", name: "Random Mix" };
      return new Response(
        JSON.stringify({ playlists: { total: 500, items: [item] } }),
        { status: 200 },
      );
    },
    () =>
      withRandom([0, 0.5], async () => {
        const client = new SpotifyClient();
        const result = await client.findRandomPublicPlaylist();
        assert.equal(result.playlistId, "pl1");
        assert.equal(result.playlistName, "Random Mix");
        assert.equal(requestedOffsets[0], 0);
        assert.equal(requestedOffsets[1], 250);
      }),
  );
});

test("findRandomPublicPlaylist throws when no public playlist can be found", async () => {
  await withFetch(
    (url) =>
      url === TOKEN_URL
        ? tokenResponse()
        : new Response(JSON.stringify({ playlists: { total: 0, items: [] } }), { status: 200 }),
    async () => {
      const client = new SpotifyClient();
      await assert.rejects(client.findRandomPublicPlaylist(), NonRetryableError);
    },
  );
});
