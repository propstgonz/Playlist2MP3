import { SpotifyClient } from "../src/playlist/spotifyClient.js";
import { rootLogger } from "../src/utils/logger.js";

function toPlaylistId(input: string): string {
  const fromUrl = /playlist[/:]([a-zA-Z0-9]{22})/.exec(input);
  return fromUrl?.[1] ?? input.trim();
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("usage: npm run check:spotify -- <playlistUrlOrId> [...]\n");
  process.exit(1);
}

const client = new SpotifyClient({ logger: rootLogger.child("spotify") });

for (const arg of args) {
  const playlistId = toPlaylistId(arg);
  const startedAt = Date.now();
  try {
    const result = await client.getPlaylistTracks(playlistId);
    const withCover = result.tracks.filter((track) => track.coverUrl !== undefined).length;
    const withYear = result.tracks.filter((track) => track.releaseYear !== undefined).length;
    rootLogger.info(
      `${playlistId}: source=${result.source ?? "unknown"} tracks=${result.tracks.length} ` +
        `unavailable=${result.unavailableCount} covers=${withCover} years=${withYear} ` +
        `elapsed=${Date.now() - startedAt}ms`,
    );
    const first = result.tracks[0];
    const last = result.tracks[result.tracks.length - 1];
    if (first) {
      rootLogger.info(`  first: ${first.artists.join(", ")} - ${first.title} (${first.releaseYear})`);
    }
    if (last) {
      rootLogger.info(`  last:  ${last.artists.join(", ")} - ${last.title} (${last.releaseYear})`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    rootLogger.error(`${playlistId}: failed - ${reason}`);
    process.exitCode = 1;
  }
}
