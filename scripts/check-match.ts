import type { SpotifyTrack } from "../src/types/index.js";
import { configureLogger, errorMessage, rootLogger } from "../src/utils/logger.js";
import { extractPlaylistId } from "../src/config/schema.js";
import { SpotifyClient } from "../src/playlist/spotify.js";
import { resolveSource } from "../src/resolver/resolve.js";
import { runYtDlp } from "../src/resolver/search.js";

const MANUAL_PATTERN = /^(.+?)\s+-\s+(.+?)\s+(\d+):(\d{2})$/;

function usage(): never {
  process.stderr.write(
    'usage:\n  npm run check:match -- "<Artist> - <Title> <m:ss>"\n  npm run check:match -- <spotify playlist url> [maxTracks]\n',
  );
  process.exit(1);
}

async function tracksFromArgs(args: readonly string[]): Promise<SpotifyTrack[]> {
  const first = args[0];
  if (first === undefined) {
    usage();
  }
  const playlistId = extractPlaylistId(first);
  if (playlistId !== undefined) {
    const playlist = await new SpotifyClient({ logger: rootLogger.child("spotify") }).getPlaylist(playlistId);
    return playlist.tracks.slice(0, Number(args[1] ?? playlist.tracks.length));
  }
  const manual = MANUAL_PATTERN.exec(args.join(" "));
  if (!manual?.[1] || !manual[2]) {
    usage();
  }
  return [
    {
      id: "manual",
      title: manual[2],
      artists: manual[1].split(/\s*,\s*/),
      album: undefined,
      durationMs: (Number(manual[3]) * 60 + Number(manual[4])) * 1000,
      position: 1,
      releaseYear: undefined,
      coverUrl: undefined,
    },
  ];
}

configureLogger({ level: "debug" });
const tracks = await tracksFromArgs(process.argv.slice(2));
let failures = 0;
for (const track of tracks) {
  const logger = rootLogger.child(`${track.artists.join(", ")} - ${track.title}`);
  try {
    const result = await resolveSource(
      track,
      { strict: true, durationToleranceSec: 7, youtubeFallback: true },
      runYtDlp,
      logger,
    );
    logger.info(`PICKED ${result.candidate.url} "${result.candidate.track ?? result.candidate.title}"`);
  } catch (error) {
    failures += 1;
    logger.warn(`NO MATCH: ${errorMessage(error)}`);
  }
}
rootLogger.info(`${tracks.length - failures}/${tracks.length} tracks matched`);
