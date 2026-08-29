import NodeID3 from "node-id3";
import type { Logger } from "../utils/logger.js";
import type { SpotifyTrack } from "../types/index.js";

export class TaggingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaggingError";
  }
}

async function fetchCoverImage(coverUrl: string, logger: Logger): Promise<Buffer | undefined> {
  try {
    const response = await fetch(coverUrl);
    if (!response.ok) {
      logger.warn(`Cover art download failed with status ${response.status}, skipping cover`);
      return undefined;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    logger.warn(
      `Cover art download failed: ${error instanceof Error ? error.message : String(error)}, skipping cover`,
    );
    return undefined;
  }
}

export async function tagMp3(
  filePath: string,
  track: SpotifyTrack,
  logger: Logger,
): Promise<void> {
  const cover = track.coverUrl ? await fetchCoverImage(track.coverUrl, logger) : undefined;

  const tags: NodeID3.Tags = {
    title: track.title,
    artist: track.artists.join(", "),
    album: track.album,
    trackNumber: String(track.trackNumber),
    ...(track.releaseYear !== undefined ? { year: String(track.releaseYear) } : {}),
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

  const success = NodeID3.write(tags, filePath);
  if (success !== true) {
    throw new TaggingError(`Failed to write ID3 tags to "${filePath}"`);
  }
}
