import type { PlaylistConfig, RandomPlaylistConfig } from "../types/index.js";
import type { PlaylistTrackSource } from "../playlist/spotifyClient.js";

export async function pickRandomPlaylistConfig(
  spotifyClient: PlaylistTrackSource,
  randomPlaylist: RandomPlaylistConfig,
  signal?: AbortSignal,
): Promise<PlaylistConfig> {
  if (!spotifyClient.findRandomPublicPlaylist) {
    throw new Error("Configured Spotify client does not support random playlist discovery");
  }

  const found = await spotifyClient.findRandomPublicPlaylist(signal);
  return {
    id: "random",
    name: `${found.playlistName} (${found.playlistId.slice(0, 8)})`,
    url: `https://open.spotify.com/playlist/${found.playlistId}`,
    spotifyPlaylistId: found.playlistId,
    rootDir: randomPlaylist.dir,
  };
}
