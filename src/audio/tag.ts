import NodeID3 from "node-id3";
import type { SpotifyTrack } from "../types/index.js";
import { errorMessage, type Logger } from "../utils/logger.js";

const COVER_TIMEOUT_MS = 15_000;

export class TaggingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaggingError";
  }
}

async function fetchCover(url: string, logger: Logger): Promise<Buffer | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) });
    if (!response.ok) {
      logger.warn(`Cover art download failed with status ${response.status}; saving without cover`);
      return undefined;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    logger.warn(`Cover art download failed (${errorMessage(error)}); saving without cover`);
    return undefined;
  }
}

export async function tagMp3(filePath: string, track: SpotifyTrack, logger: Logger): Promise<void> {
  const cover = track.coverUrl ? await fetchCover(track.coverUrl, logger) : undefined;
  const tags: NodeID3.Tags = {
    title: track.title,
    artist: track.artists.join(", "),
    performerInfo: track.artists[0],
    trackNumber: String(track.position),
    ...(track.album !== undefined ? { album: track.album } : {}),
    ...(track.releaseYear !== undefined ? { year: String(track.releaseYear) } : {}),
    userDefinedText: [{ description: "SPOTIFY_TRACK_ID", value: track.id }],
    ...(cover
      ? {
          image: {
            mime: "image/jpeg",
            type: { id: 3, name: "front cover" },
            description: "cover",
            imageBuffer: cover,
          },
        }
      : {}),
  };
  const result = NodeID3.write(tags, filePath);
  if (result !== true) {
    throw new TaggingError(`Could not write ID3 tags: ${errorMessage(result)}`);
  }
}
