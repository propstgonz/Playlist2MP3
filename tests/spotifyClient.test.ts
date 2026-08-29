import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyClient } from "../src/playlist/spotifyClient.js";
import { NonRetryableError } from "../src/utils/retry.js";
import type { SpotifyAuthClient } from "../src/playlist/spotifyAuth.js";

function fakeAuth(): SpotifyAuthClient {
  return { getAccessToken: async () => "fake-token" } as unknown as SpotifyAuthClient;
}

function withFetch(handler: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("returns tracks and stops paginating when next is null", async () => {
  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              track: {
                id: "t1",
                name: "Song",
                artists: [{ name: "Artist" }],
                album: { name: "Album", release_date: "2020-01-01", images: [{ url: "cover" }] },
                duration_ms: 100_000,
                track_number: 1,
                is_local: false,
              },
            },
          ],
          next: null,
        }),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const client = new SpotifyClient(fakeAuth());
      const tracks = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, 1);
      assert.equal(tracks[0]?.id, "t1");
    },
  );
});

test("filters out local tracks and null items", async () => {
  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          items: [
            { track: null },
            {
              track: {
                id: "t1",
                name: "Local",
                artists: [{ name: "Artist" }],
                album: { name: "Album" },
                duration_ms: 1000,
                track_number: 1,
                is_local: true,
              },
            },
          ],
          next: null,
        }),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const client = new SpotifyClient(fakeAuth());
      const tracks = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, 0);
    },
  );
});

test("throws a non-retryable error with a 404", async () => {
  await withFetch(
    (async () => new Response("", { status: 404 })) as typeof fetch,
    async () => {
      const client = new SpotifyClient(fakeAuth());
      await assert.rejects(client.getPlaylistTracks("missing"), NonRetryableError);
    },
  );
});

test("throws a clear non-retryable error explaining the 403 development-mode restriction", async () => {
  await withFetch(
    (async () => new Response("", { status: 403 })) as typeof fetch,
    async () => {
      const client = new SpotifyClient(fakeAuth());
      await assert.rejects(
        client.getPlaylistTracks("abc"),
        (error: unknown) =>
          error instanceof NonRetryableError && error.message.includes("Development Mode"),
      );
    },
  );
});

test("retries after a 429 and eventually succeeds", async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "0" } });
      }
      return new Response(JSON.stringify({ items: [], next: null }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const client = new SpotifyClient(fakeAuth());
      const tracks = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, 0);
      assert.equal(calls, 2);
    },
  );
});
