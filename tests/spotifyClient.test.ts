import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyClient, EMBED_TRACK_LIST_CAP } from "../src/playlist/spotifyClient.js";
import { NonRetryableError } from "../src/utils/retry.js";

function embedHtml(nextData: unknown): string {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData,
  )}</script></body></html>`;
}

function playlistNextData(trackList: readonly unknown[]): unknown {
  return { props: { pageProps: { state: { data: { entity: { trackList } } } } } };
}

function trackNextData(entity: unknown): unknown {
  return { props: { pageProps: { state: { data: { entity } } } } };
}

function withFetch(handler: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("parses tracks from the playlist embed page", async () => {
  await withFetch(
    (async () =>
      new Response(
        embedHtml(
          playlistNextData([
            {
              uri: "spotify:track:track1id00000000000000",
              title: "Song One",
              subtitle: "Artist One",
              duration: 180_000,
              entityType: "track",
            },
          ]),
        ),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const client = new SpotifyClient();
      const tracks = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, 1);
      assert.equal(tracks[0]?.id, "track1id00000000000000");
      assert.equal(tracks[0]?.title, "Song One");
      assert.deepEqual(tracks[0]?.artists, ["Artist One"]);
      assert.equal(tracks[0]?.durationMs, 180_000);
      assert.equal(tracks[0]?.trackNumber, 1);
    },
  );
});

test("skips non-track entries and deduplicates by id", async () => {
  await withFetch(
    (async () =>
      new Response(
        embedHtml(
          playlistNextData([
            {
              uri: "spotify:episode:podcast0000000000000",
              title: "A Podcast",
              subtitle: "Host",
              duration: 1_000_000,
              entityType: "episode",
            },
            {
              uri: "spotify:track:track1id00000000000000",
              title: "Song One",
              subtitle: "Artist One",
              duration: 180_000,
              entityType: "track",
            },
            {
              uri: "spotify:track:track1id00000000000000",
              title: "Song One",
              subtitle: "Artist One",
              duration: 180_000,
              entityType: "track",
            },
          ]),
        ),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const client = new SpotifyClient();
      const tracks = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, 1);
    },
  );
});

test("exposes the embed track-list cap so callers can warn on large playlists", async () => {
  const trackList = Array.from({ length: EMBED_TRACK_LIST_CAP }, (_, i) => ({
    uri: `spotify:track:id${String(i).padStart(20, "0")}`,
    title: `Song ${i}`,
    subtitle: "Artist",
    duration: 180_000,
    entityType: "track",
  }));

  await withFetch(
    (async () => new Response(embedHtml(playlistNextData(trackList)), { status: 200 })) as typeof fetch,
    async () => {
      const client = new SpotifyClient();
      const tracks = await client.getPlaylistTracks("abc");
      assert.equal(tracks.length, EMBED_TRACK_LIST_CAP);
    },
  );
});

test("throws a non-retryable error on 404", async () => {
  await withFetch(
    (async () => new Response("", { status: 404 })) as typeof fetch,
    async () => {
      const client = new SpotifyClient();
      await assert.rejects(client.getPlaylistTracks("missing"), NonRetryableError);
    },
  );
});

test("throws a non-retryable error when the page has no embedded data", async () => {
  await withFetch(
    (async () => new Response("<html><body>no data here</body></html>", { status: 200 })) as typeof fetch,
    async () => {
      const client = new SpotifyClient();
      await assert.rejects(client.getPlaylistTracks("abc"), NonRetryableError);
    },
  );
});

test("getTrackDetails enriches release year, cover art and artist list", async () => {
  await withFetch(
    (async () =>
      new Response(
        embedHtml(
          trackNextData({
            artists: [{ name: "Real Artist Name" }],
            releaseDate: { isoString: "1966-04-15T00:00:00Z" },
            visualIdentity: {
              image: [
                { url: "small.jpg", maxWidth: 64 },
                { url: "large.jpg", maxWidth: 640 },
                { url: "medium.jpg", maxWidth: 300 },
              ],
            },
          }),
        ),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const client = new SpotifyClient();
      const enriched = await client.getTrackDetails({
        id: "t1",
        title: "Song",
        artists: ["Fallback Artist"],
        durationMs: 100,
        trackNumber: 1,
        releaseYear: undefined,
        coverUrl: undefined,
      });
      assert.deepEqual(enriched.artists, ["Real Artist Name"]);
      assert.equal(enriched.releaseYear, 1966);
      assert.equal(enriched.coverUrl, "large.jpg");
      assert.equal(enriched.id, "t1");
      assert.equal(enriched.trackNumber, 1);
    },
  );
});
