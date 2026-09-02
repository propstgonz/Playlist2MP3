# Playlist2MP3

[![CI](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml/badge.svg)](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml)

A headless, containerized service that incrementally mirrors one or more public Spotify playlists into local MP3 collections.

Each playlist is configured independently via environment variables: a name, a Spotify playlist URL, and a root destination directory. The service runs a single long-lived process that periodically checks every configured playlist for tracks that are not yet present on disk, resolves and downloads only those, converts them to MP3, tags them with the original Spotify metadata, and writes them to `<PLAYLIST_DIR>/<PLAYLIST_NAME>/`.

## Features

- Multiple playlists, each with its own destination root directory.
- Incremental sync: only missing tracks are downloaded on every cycle.
- Full playlist pagination: playlists of any size are fetched completely, not just the first 100 tracks.
- Optional random public playlist discovery: pulls in a different public Spotify playlist each cycle.
- Optional local storage quota (`MAX_SIZE`): skips a sync cycle's downloads when configured directories are already at/above the limit.
- Filesystem is the only source of truth for what has already been downloaded — no database.
- Original Spotify track and artist names are preserved in file names (only filesystem-illegal characters are sanitized).
- ID3 tags (title, artist, track number, year, cover art) are written from Spotify metadata, not from the download source.
- Bounded global download concurrency.
- One failing playlist never stops the others from syncing.
- Clean shutdown on `SIGTERM`/`SIGINT`: no new downloads start, in-flight ones are allowed to finish.
- **No Spotify account, developer app, or subscription of any kind is required.** Playlist, search and track metadata is read through the same anonymous, unauthenticated access token that Spotify's own public embed player (`open.spotify.com/embed/...`) uses in every visitor's browser — obtained from `open.spotify.com/get_access_token`, never a registered developer app or user login.

## Requirements

- Only **public** playlists are supported, since there is no user login involved.
- Docker and Docker Compose for running the service.

## How metadata is fetched

This project relies on an undocumented, unofficial Spotify mechanism: the anonymous access token issued to visitors of the public embed player. That token is used against the standard `api.spotify.com/v1` endpoints — with normal `limit`/`offset` pagination — to read full playlist contents (any size) and to search for public playlists. Spotify could change or restrict this at any time without notice, which would break metadata fetching until the client is updated.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```env
MUSIC_HOST_DIR=/media/raid/music

SYNC_INTERVAL=86400
DOWNLOAD_CONCURRENCY=2
TEMP_DIR=/tmp/playlist2mp3
LOG_LEVEL=info
MAX_SIZE=

RANDOM_PLAYLIST=false
RANDOM_PLAYLIST_DIR=/music

PLAYLIST_1_NAME=Rock
PLAYLIST_1_URL=https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
PLAYLIST_1_DIR=/music
```

- `MAX_SIZE` caps the combined size of all configured playlist directories (including the random one, if enabled). Accepts a plain byte count or a number with a `K`, `M`, `G` or `T` suffix, e.g. `500M` or `1G`. Leave it empty, unset, or `0` for unlimited storage (the default). The check runs once at the start of every sync cycle, before any track is fetched or downloaded; if the limit is already reached, that cycle's downloads are skipped and a clear error is logged, but the service keeps running and retries on the next cycle.
- `RANDOM_PLAYLIST` (`true`/`false`, default `false`) picks a different public Spotify playlist at random at the start of every sync cycle and syncs it alongside the playlists configured with `PLAYLIST_N_*`, using the same incremental, no-duplicate-download logic. Requires `RANDOM_PLAYLIST_DIR`. If no random playlist can be found in a given cycle, a warning is logged and the rest of the cycle proceeds normally.
- `RANDOM_PLAYLIST_DIR` is the root directory the randomly picked playlist is written under (same convention as `PLAYLIST_N_DIR`: a subfolder named after the picked playlist is created inside it). Required only when `RANDOM_PLAYLIST=true`.

`MUSIC_HOST_DIR` is the real path on your machine that Docker Compose mounts into the container at the fixed path `/music` (see `docker-compose.yml`). Every `PLAYLIST_N_DIR` should point at `/music` — that's the container-side path, not `MUSIC_HOST_DIR` itself.

Add as many playlists as needed following the `PLAYLIST_N_NAME` / `PLAYLIST_N_URL` / `PLAYLIST_N_DIR` pattern, incrementing `N`. All three fields are required for each entry; an incomplete entry fails configuration validation at startup with a clear error.

`PLAYLIST_N_DIR` is the **root** directory for that playlist, not its final destination. The service automatically creates and writes into `PLAYLIST_N_DIR/PLAYLIST_N_NAME/`.

## Running with Docker Compose

Only `.env` needs editing — `docker-compose.yml` itself never needs to change:

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
