# Playlist2MP3

[![CI](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml/badge.svg)](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml)

A headless, containerized service that incrementally mirrors one or more public Spotify playlists into local MP3 collections.

Each playlist is configured independently via environment variables: a name, a Spotify playlist URL, and a root destination directory. The service runs a single long-lived process that periodically checks every configured playlist for tracks that are not yet present on disk, resolves and downloads only those, converts them to MP3, tags them with the original Spotify metadata, and writes them to `<PLAYLIST_DIR>/<PLAYLIST_NAME>/`.

## Features

- Multiple playlists, each with its own destination root directory.
- Incremental sync: only missing tracks are downloaded on every cycle.
- Filesystem is the only source of truth for what has already been downloaded — no database.
- Original Spotify track and artist names are preserved in file names (only filesystem-illegal characters are sanitized).
- ID3 tags (title, artist, track number, year, cover art) are written from Spotify metadata, not from the download source.
- Bounded global download concurrency.
- One failing playlist never stops the others from syncing.
- Clean shutdown on `SIGTERM`/`SIGINT`: no new downloads start, in-flight ones are allowed to finish.
- **No Spotify account, developer app, or subscription of any kind is required.** Playlist and track metadata is read from Spotify's public embed pages (`open.spotify.com/embed/...`), the same data Spotify serves to render an embedded playlist widget on any website, with no authentication.

## Requirements

- Only **public** playlists are supported, since there is no user login involved.
- Docker and Docker Compose for running the service.

## Known limitation: 100 tracks per playlist

Spotify's public embed page returns at most 100 tracks per playlist; there is no documented way to page past that without emulating a full logged-in web player session. If a configured playlist has 100 or more tracks, the service logs a warning and only the first 100 are considered for syncing. This is a hard constraint of not requiring any account or subscription, not a bug — see `EMBED_TRACK_LIST_CAP` in `src/playlist/spotifyClient.ts`.

This project relies on an undocumented, unofficial Spotify page structure. Spotify could change it at any time without notice, which would break metadata fetching until the scraper is updated.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```env
SYNC_INTERVAL=86400
DOWNLOAD_CONCURRENCY=2
TEMP_DIR=/tmp/playlist2mp3
LOG_LEVEL=info

PLAYLIST_1_NAME=Rock
PLAYLIST_1_URL=https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
PLAYLIST_1_DIR=/media/raid/music
```

Add as many playlists as needed following the `PLAYLIST_N_NAME` / `PLAYLIST_N_URL` / `PLAYLIST_N_DIR` pattern, incrementing `N`. All three fields are required for each entry; an incomplete entry fails configuration validation at startup with a clear error.

`PLAYLIST_N_DIR` is the **root** directory for that playlist, not its final destination. The service automatically creates and writes into `PLAYLIST_N_DIR/PLAYLIST_N_NAME/`.

## Running with Docker Compose

Update the volume in `docker-compose.yml` to match your actual music storage path, then:

```bash
docker compose up -d --build
```

The container persists nothing outside the mounted volume, so it can be freely destroyed and recreated without losing any downloaded collection or triggering redundant downloads.

## Running locally (development)

```bash
npm install
cp .env.example .env   # then edit it
npm run dev
```

Requires `yt-dlp` and `ffmpeg` available on `PATH`.

## Testing

```bash
npm run typecheck
npm test
```

Tests run entirely offline: no real network calls, no real downloads, no dependency on any real playlist.

## Project layout

- `src/index.ts` — main process and lifecycle.
- `src/config/` — environment parsing and validation.
- `src/playlist/` — Spotify metadata client (public embed pages, no authentication).
- `src/sync/` — per-playlist and per-cycle synchronization orchestration.
- `src/resolver/` — matches Spotify tracks to a downloadable source via `yt-dlp` search.
- `src/downloader/` — download execution and the per-track pipeline state machine.
- `src/audio/` — MP3 conversion and ID3 tagging.
- `src/filesystem/` — path sanitization, path resolution, and all disk I/O.
- `src/types/` — shared type definitions.
- `src/utils/` — logging, retry, and concurrency helpers.
- `tests/` — unit and integration tests.

## Disclaimer

This project is intended for personal, offline backups of playlists you already have legitimate access to. It reads metadata from Spotify's public embed pages and resolves audio through third-party sources via `yt-dlp`; it is not affiliated with, endorsed by, or supported by Spotify. Spotify's Terms of Service govern what you may do with content obtained from their platform — you are responsible for complying with them, and with copyright law in your jurisdiction, when using this tool.
