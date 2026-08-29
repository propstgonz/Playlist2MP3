# Playlist2MP3

[![CI](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml/badge.svg)](https://github.com/propstgonz/Playlist2MP3/actions/workflows/ci.yml)

A small background program that keeps a folder on your computer full of MP3s from a Spotify playlist. You give it a playlist link and a folder, and it takes care of everything else: it checks the playlist regularly, downloads whatever songs are missing, and never touches what's already there. You don't need a Spotify account, a paid subscription, or any technical knowledge to use it — just follow the steps below.

## What you need first

- **A Windows, Mac, or Linux computer.** These instructions use Windows, but the same steps work everywhere — only how you open a terminal changes.
- **Docker Desktop.** This is the only program you need to install. It lets your computer run this project in a safe, self-contained "box" (called a *container*) without installing anything else by hand.
  1. Go to [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) and download it.
  2. Run the installer, keeping all the default options.
  3. Once it's done, open Docker Desktop and wait until it says it's running (you'll see a whale icon appear near your clock, in the taskbar).

That's the only software to install. Everything else (the downloader, the audio converter) is already bundled inside the project.

## Step 1 — Get the project onto your computer

Go to the project's page on GitHub and choose one of these:

- **Easiest — no extra software:** click the green **Code** button, then **Download ZIP**. Once downloaded, right-click the ZIP file and choose **Extract All...**, and pick a folder you'll remember (e.g. your Desktop).
- **If you already use Git:** open a terminal anywhere and run:
  ```bash
  git clone https://github.com/propstgonz/Playlist2MP3.git
  ```

Either way, you'll end up with a folder named `Playlist2MP3` containing all the project's files.

## Step 2 — Open a terminal inside that folder

A terminal is just a window where you type commands instead of clicking.

1. Open the `Playlist2MP3` folder in File Explorer.
2. Click once on the address bar at the top of the window (where the folder path is shown), so it becomes editable.
3. Type `cmd` and press **Enter**. A black window will open — that's your terminal, already pointed at the right folder.

Keep this window open; you'll use it in Step 4.

## Step 3 — Create and fill in your settings file

1. In the `Playlist2MP3` folder, find the file named `.env.example`.
2. Copy it (select it, press `Ctrl+C`, then `Ctrl+V`) and rename the copy to `.env` — exactly that, including the dot at the start, with nothing after it.
3. Right-click `.env` and open it with **Notepad**.
4. Change two lines:
   - `MUSIC_HOST_DIR` — the folder where you want your MP3s to be saved. It can be any folder you like, e.g. `C:/Users/YourName/Music/Playlist`. Docker will create it automatically if it doesn't exist yet.
   - `PLAYLIST_1_URL` — the link to your Spotify playlist. In Spotify, right-click the playlist → **Share** → **Copy link to playlist**, then paste it here.
5. Optionally change `PLAYLIST_1_NAME` to whatever you want that playlist's folder to be called.
6. Save the file and close Notepad.

Your playlist must be **public** in Spotify (not private) for this to work, since there's no login step involved.

## Step 4 — Start it

Back in the terminal window from Step 2, type this and press **Enter**:

```bash
docker compose up -d --build
```

The first time, this takes a few minutes while it prepares everything. After that, it starts working right away: it reads your playlist and begins downloading the songs.

## Step 5 — Check that it worked

Open the folder you set as `MUSIC_HOST_DIR`. You should see a new subfolder named after your playlist, and inside it, MP3 files appearing one by one.

From now on, it keeps running quietly in the background and checks your playlist once a day for new songs, downloading only what's new — you don't need to do anything else.

## Everyday use

- **Stop it:** `docker compose down`
- **Start it again:** `docker compose up -d`
- **Add more playlists:** open `.env` in Notepad again and add a new block, changing the number each time:
  ```env
  PLAYLIST_2_NAME=Electronic
  PLAYLIST_2_URL=https://open.spotify.com/playlist/37i9dQZF1DX4dyzvuaRJ0n
  PLAYLIST_2_DIR=/music
  ```
  Then run `docker compose up -d` again to apply the change.
- **Change how often it checks:** edit `SYNC_INTERVAL` in `.env` (in seconds — `86400` is once a day, `3600` is once an hour).

## Good to know

- **100 tracks per playlist, max.** Reading a playlist without logging in only shows its first 100 tracks — a limit of not needing an account, not a bug. Bigger playlists log a warning about this.
- Spotify sometimes removes a track after it's been added to a playlist. The service notices and skips those automatically, and says so in its logs.
- This relies on how Spotify's public playlist pages happen to be built today. If Spotify changes that, it could stop working until this project is updated to match.

## For developers

Everything above is controlled through `.env`; `docker-compose.yml` itself never needs editing.

| Variable | Meaning |
|---|---|
| `MUSIC_HOST_DIR` | Real folder on your machine, mounted into the container. |
| `SYNC_INTERVAL` | Seconds between sync cycles. |
| `DOWNLOAD_CONCURRENCY` | Max tracks downloaded at once. |
| `PLAYLIST_N_NAME` / `_URL` / `_DIR` | One playlist per number; `_DIR` should always be `/music`. |

Features:

- Multiple playlists at once, each in its own folder.
- Only downloads what's missing — safe to stop and restart anytime.
- Keeps original track/artist names (only filesystem-illegal characters get replaced).
- Tags every MP3 (title, artist, track number, year, cover art) from Spotify's own metadata.
- One playlist failing never stops the others.
- No Spotify account, developer app, or subscription: metadata comes from Spotify's public embed pages, the same data used to render an embedded playlist widget on any website.

Local development:

```bash
npm install
npm run typecheck
npm test
npm run dev   # requires yt-dlp and ffmpeg on PATH
```

Tests run fully offline — no network calls, no real downloads.

Project layout:

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

For personal, offline backups of playlists you already have legitimate access to. Not affiliated with, endorsed by, or supported by Spotify. You're responsible for complying with Spotify's Terms of Service and the copyright law in your jurisdiction when using this tool.
