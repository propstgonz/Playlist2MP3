# Playlist2MP3

[![CI](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml/badge.svg)](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml)

A small background program that keeps folders on your computer full of MP3s from your Spotify playlists. You give it playlist links, and it takes care of everything else: it checks Spotify regularly, downloads the songs that are missing, and (if you want) deletes the ones you removed from the playlist, so each folder is an exact copy.

It works hard to download **the same version you hear on Spotify**: it looks on YouTube Music first, checks the duration, artist and title, and refuses live versions, covers, remixes, karaoke, sped-up edits and similar unless the Spotify track itself is one of those.

You don't need a Spotify account, a paid subscription, or any technical knowledge — just follow the steps below.

## What you need first

- **A Windows, Mac, or Linux computer** (or a home server). These instructions use Windows; only how you open a terminal changes elsewhere.
- **Docker Desktop.** The only program you need to install. It runs this project in a self-contained "box" (a *container*).
  1. Download it from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/).
  2. Run the installer with the default options.
  3. Open Docker Desktop and wait until it says it's running (a whale icon appears near your clock).

Everything else (the downloader, the audio converter) is already bundled inside the project.

## Step 1 — Get the project

On the project's GitHub page, either:

- click the green **Code** button → **Download ZIP**, then right-click the ZIP → **Extract All...**, or
- if you use Git: `git clone https://github.com/propstgonz/Playlist2MP3.git`

You'll end up with a folder named `Playlist2MP3`.

## Step 2 — Open a terminal inside that folder

1. Open the `Playlist2MP3` folder in File Explorer.
2. Click the address bar at the top, type `cmd` and press **Enter**. A black window opens, already in the right folder. Keep it open.

## Step 3 — Tell it where to save the music (`.env`)

1. Copy `.env.example` and rename the copy to `.env` (with the dot, nothing after it).
2. Open `.env` with **Notepad** and change `MUSIC_HOST_DIR` to the folder where you want your MP3s, e.g. `C:/Users/YourName/Music/Playlist`. Docker creates it if it doesn't exist.
3. Save and close.

That is the only setting in `.env`. Inside the container that folder is always called `/music` — that's an internal path of the container, not a folder on your computer, and you never need to type it anywhere.

## Step 4 — Choose your playlists (`config/config.json`)

1. Open the `config` folder, copy `config.example.json` and rename the copy to `config.json`.
2. Open `config.json` with **Notepad**. The only part you really need is the list of playlists:
   ```json
   {
     "playlists": [
       { "name": "Rock", "url": "https://open.spotify.com/playlist/37i9dQZF1DWXRqgorJj26U" }
     ]
   }
   ```
   - `url` — in Spotify, right-click the playlist → **Share** → **Copy link to playlist**, and paste it here. The playlist must be **public**.
   - `name` — the name of the folder where its MP3s go.
3. Save and close.

**Tip:** for your very first run, set `"dryRun": true`. The program then only *tells you* in the log what it would download, rename or delete, without touching anything. When it looks right, set it back to `false`.

## Step 5 — Start it

In the terminal from Step 2:

```bash
docker compose up -d --build
```

The first time takes a few minutes. Then it starts right away: it reads your playlists and begins downloading. To watch what it's doing:

```bash
docker compose logs -f
```

Open the folder you set as `MUSIC_HOST_DIR`: you'll see one subfolder per playlist, with the MP3s and a `.m3u` file that opens the playlist in Spotify's order in any music player.

## Everyday use

- **Add or remove a playlist:** edit `config/config.json`. There's no need to restart: the file is read again at the start of every check. If you made a mistake in the file, the log tells you exactly where, and the previous settings keep working.
- **Apply a change right now** instead of waiting for the next check: `docker compose restart`
- **Stop it:** `docker compose down` — **start it again:** `docker compose up -d`
- **See what it's doing in detail:** set `"logLevel": "debug"`. For every song you'll see which YouTube results were considered, their score, and why each one was accepted or rejected.

## All the options

Everything is optional except `playlists`. Values shown are the defaults.

```json
{
  "syncInterval": "24h",
  "concurrency": 2,
  "logLevel": "info",
  "timezone": "Europe/Madrid",
  "dryRun": false,
  "defaults": { "mode": "mirror", "fileName": "{artists} - {title}" },
  "audio": { "quality": "best" },
  "matching": { "strict": true, "durationToleranceSec": 7, "youtubeFallback": true },
  "random": { "enabled": false, "name": "Aleatoria", "maxTracks": 50, "mode": "mirror" },
  "playlists": [
    { "name": "Rock", "url": "https://open.spotify.com/playlist/...", "mode": "incremental" }
  ]
}
```

| Option | What it does |
|---|---|
| `syncInterval` | How often it checks Spotify: `30m`, `6h`, `1d`... (between `1m` and `20d`). |
| `concurrency` | How many songs are downloaded at the same time, across all playlists (1–16). |
| `logLevel` | `debug` shows every detail; `info`, `warn`, `error` show less. |
| `timezone` | Time zone for the log timestamps, e.g. `Europe/Madrid`. Default: UTC. |
| `dryRun` | `true`: only report what would happen, change nothing. |
| `defaults.mode` | `mirror`: exact copy — adds new songs **and deletes** the ones no longer in the playlist (or no longer playable on Spotify). `incremental`: only adds, never deletes. |
| `defaults.fileName` | File name pattern. Placeholders: `{artists}`, `{artist}` (first one), `{title}`, `{album}`, `{year}`. Must contain `{title}`. Changing it renames existing files, it doesn't download them again. |
| `audio.quality` | `best` (VBR V0, the highest MP3 quality) or a fixed bitrate: `320k`, `256k`, `192k`, `160k`, `128k`, `96k`, `64k`. |
| `matching.strict` | `true`: if no faithful version is found, the song is skipped and the log explains why (it's retried on the next check). `false`: the closest result is downloaded anyway and flagged as a doubtful match. |
| `matching.durationToleranceSec` | Maximum difference in seconds from the Spotify duration (1–60). |
| `matching.youtubeFallback` | Also search regular YouTube when YouTube Music has no faithful match. |
| `random.enabled` | Every check, pick a random public Spotify playlist and save it in its own folder. |
| `random.name` | Folder name for the random playlist. |
| `random.maxTracks` | Maximum songs taken from each random playlist (1–1000). |
| `random.mode` | `mirror` replaces the folder with each new random playlist; `incremental` keeps adding to it. |
| `playlists[].mode` | Overrides `defaults.mode` for one playlist. |

## Good to know

- **Your own files are safe.** In each playlist folder there's a hidden index file (`.playlist2mp3.json`) listing the MP3s the program downloaded. Only those can ever be deleted; an MP3 you put there yourself, or any non-MP3 file, is never touched. Don't delete the index file unless you want the program to forget which files it owns.
- **Upgrading from an older version:** the first time it runs on an existing folder, MP3s whose name matches a song in the playlist are adopted into the index instead of being downloaded again.
- **Nothing is deleted when in doubt.** If Spotify only returns a partial list (its fallback source stops at 100 songs) or an empty one, no files are removed that cycle.
- **Restart-safe.** A song only counts as done once the finished MP3 is in place. If the container stops halfway, the next run picks up exactly where it left off.
- Songs that Spotify marks as unavailable (removed from its catalog or local files) can't be downloaded; the log says how many there are.
- This relies on how Spotify's and YouTube's public pages work today. If they change, it may stop working until the project is updated. To update the YouTube downloader, change `YTDLP_VERSION` in the `Dockerfile` and run `docker compose up -d --build`.

## For developers

```bash
npm install
npm run typecheck
npm test                 # fully offline: no network calls, no real downloads
npm run dev              # needs yt-dlp, ffmpeg and node on PATH; see env vars below
npm run check:match -- "Queen - Bohemian Rhapsody 5:54"
npm run check:match -- https://open.spotify.com/playlist/<id> 20
```

`check:match` searches for real (no download) and prints every candidate with its score and rejection reasons, so you can verify which version would be picked for a song or for the first N songs of a playlist.

Paths inside the container are fixed; for local runs they can be overridden with `CONFIG_FILE` (default `/config/config.json`), `MUSIC_DIR` (default `/music`) and `TEMP_DIR` (default `/tmp/playlist2mp3`).

How a cycle works:

1. Read and validate `config/config.json` (keep the previous config if the new one is invalid).
2. For every playlist, in parallel: fetch the full track list from Spotify, load the folder index, build a plan (download / rename / keep / remove), apply it, download the missing songs through a global concurrency limit, and write the `.m3u`.
3. Log a summary, wait `syncInterval`, repeat.

Project layout:

- `src/index.ts` — main loop, config reload, shutdown.
- `src/config/` — `config.json` validation and defaults.
- `src/playlist/` — anonymous Spotify client: full playlist pages, embed fallback, random playlist search, query hash discovery.
- `src/resolver/` — YouTube Music / YouTube search via `yt-dlp` and the matching rules (`match.ts`).
- `src/downloader/` — `yt-dlp` audio download to MP3 and the per-song pipeline.
- `src/audio/` — ID3 tags and cover art.
- `src/filesystem/` — safe names, folder index, atomic file operations.
- `src/sync/` — the plan (pure logic), per-playlist execution and the cycle.
- `src/types/`, `src/utils/` — shared types, logger, retry, concurrency, durations.
- `tests/` — unit and integration tests.

## Disclaimer

For personal, offline backups of playlists you already have legitimate access to. Not affiliated with, endorsed by, or supported by Spotify or YouTube. You're responsible for complying with their Terms of Service and with the copyright law in your jurisdiction.
