# <img src="app/icon/SubArabify.png" width="48" align="center" /> SubArabify

SubArabify is an automated background worker that finds ready-made **Arabic subtitles** for your movies and TV episodes, brands them, and saves them next to the video — entirely on-device, with zero backend infrastructure and **no AI services**. It leans on the free [OpenSubtitles.com](https://www.opensubtitles.com/) REST API (movie-hash search) and reads only your media folder.

AI translation and audio transcription have been **removed**: if a ready-made Arabic subtitle exists (locally or on OpenSubtitles), SubArabify uses it; if it doesn't, the video is logged and skipped.

## Features

- **Subtitle-first pipeline (v3):** local Arabic → OpenSubtitles Arabic → skip (with a logged reason). No AI, no audio extraction, no API costs.
- **OpenSubtitles hash search:** computes the OpenSubtitles movie hash (size + first/last 64 KB) and searches by `moviehash`, falling back to title+year — implemented as a plain REST client, no heavy libraries.
- **Release-name identification:** parses names like `Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv` into title + year (via `parse-torrent-title`) so hash/title searches are accurate — including Arabic file names.
- **Smart Branding:** watermarks output subtitles with `[ ترجمت الأداة ساب أرابيفاي ]` and writes them as `MovieName.SubArabify.ar.srt`.
- **Decision log:** every per-movie decision (identified title/year, hash vs. title match, provider, why a video was skipped) is appended to `logs/decisions.jsonl`.
- **Runs Everywhere:** designed to run on Termux (Android/ARM64) or any standard Node.js environment — pure JS, no native modules.

---

## Subtitle lookup order

For every new video, SubArabify tries these in order and stops at the first hit:

1. **Existing output** — `MovieName.SubArabify.ar.srt` already present → skip (idempotent).
2. **Local Arabic** — `MovieName.ar.srt` / `MovieName.arabic.srt` / any same-named subtitle whose *content* is Arabic → brand it and save.
3. **OpenSubtitles (Arabic)** — moviehash search first, then title+year search → download, validate, brand.
4. **English subtitle found** — logged as `skip-english` (AI translation was removed) → video left untouched.
5. **Nothing found** — logged as `no-subtitle` → video left untouched.

Every candidate is validated before use: it must parse as SRT, keep sane cue counts against the runtime, and be normalized to UTF-8 (BOM/UTF-16 handled).

---

## 🚀 Getting Started on Termux (Android)

You can run the SubArabify engine directly on your Android phone using standard Node.js tools in Termux.

### 1. Grant Storage Access
Allow Termux to read and write to your phone's media storage:
```bash
termux-setup-storage
```

### 2. Install Dependencies (Node.js & FFmpeg)
```bash
pkg update && pkg install nodejs ffmpeg -y
```
Node.js powers the app; FFmpeg is only used for `ffprobe` (reading a video's runtime so subtitle cue counts can be sanity-checked — the app still works without it).

### 3. Setup Project
Clone the repository and install the NPM packages:
```bash
git clone https://github.com/muxd22-alt/SubArabify.git
cd SubArabify
npm install
```

### 4. Add your API key (optional but recommended)
```bash
cp .env.example .env
nano .env
```

| Variable | Required for | Where to get it |
|---|---|---|
| `OPENSUBTITLES_API_KEY` | Remote Arabic subtitle search | Free consumer key: <https://www.opensubtitles.com/en/users/sign_up> → API section |
| `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` | Optional: unlocks the OpenSubtitles download quota (JWT) | Same account as above |
| `TMDB_API_KEY` | Reserved for the upcoming genre-aware brief | Free v3 key: <https://www.themoviedb.org/settings/api> |

Without `OPENSUBTITLES_API_KEY`, SubArabify still works — it just searches your local files only and skips remote lookup. CI stores these keys as the `OpenSubtitles` and `TMDBAPI` repository secrets. There are no other AI services or tokens: nothing else to configure.

### 5. Run SubArabify!
Run the node script and point it to your phone's movie folder:
```bash
npm start -- --media ~/storage/shared/Movies
```
Or run directly:
```bash
node subarabify.js --media ~/storage/shared/Movies
```

The script will now actively watch the destination folder. Whenever a `.mp4`, `.mkv`, `.avi` or `.m4v` file is added, it identifies the release name (title + year), looks for a ready-made Arabic subtitle in the order described above, brands it, and records every decision in `logs/decisions.jsonl`.

---

## Manual test plan

Run these against a folder with at least **two different genres** of movies:

1. **Identification** — drop in e.g. `Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv` (sci-fi) and `Zombieland.2009.720p.BluRay.x264-REFINE.mkv` (horror). The log should show `Identified: "Interstellar" (2014)` and `Identified: "Zombieland" (2009)` — release noise (`1080p`, `BluRay`, `x264`, group name) must not leak into the title.
2. **Local Arabic is branded, nothing else runs** — place `SomeMovie.2020.1080p.ar.srt` next to `SomeMovie.2020.1080p.mkv` (no `.SubArabify` output yet). Processing must write `SomeMovie.2020.1080p.SubArabify.ar.srt` with the watermark `[ ترجمت الأداة ساب أرابيفاي ]` and log `brand-arabic` — no translation or network call may appear.
3. **OpenSubtitles fetch** — with `OPENSUBTITLES_API_KEY` set, remove any local `.srt` for a movie that exists on OpenSubtitles. The log should show `remote-ar | search | N hit(s) | hash` (or `title`), then a branded Arabic subtitle. `logs/decisions.jsonl` records the `fileId`, `moviehashMatch`, and remaining download quota.
4. **No-key degradation** — unset the key and repeat step 3: the run must log `remote | skipped | no OPENSUBTITLES_API_KEY` and proceed without crashing.
5. **English-only and no-subtitle videos are skipped cleanly** — a video whose only subtitle is English must log `skip-english` and leave no output; a video with no subtitle at all must log `no-subtitle`. Neither may crash or touch the file.

---

## Development

```bash
npm test          # node --test: identifier, OSHash vectors, SRT utils, finder, pipeline
```

The hash tests assert against the canonical OpenSubtitles test vectors published by [opensubtitles/oshash](https://github.com/opensubtitles/oshash); regenerate the fixtures with `python test/fixtures/generate_fixtures.py`.

## Dependencies

- **Node.js** (v18+, global `fetch` required)
- **FFmpeg** (optional, runtime probing only)
- **chokidar**: efficient local folder monitoring.
- **parse-torrent-title**: proven release-name parser (MIT, pure JS).

---
*Created by [the SubArabify community](https://github.com/muxd22-alt).*
