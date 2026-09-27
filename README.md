# <img src="app/icon/SubArabify.png" width="48" align="center" /> SubArabify

SubArabify is an automated background translation engine designed to translate and brand movie subtitles entirely on-device, with zero backend infrastructure. It leans on [Puter.js](https://puter.com/) for keyless AI, on the free [OpenSubtitles.com](https://www.opensubtitles.com/) REST API for ready-made subtitles, and on plain FFmpeg only as a last resort.

AI is now the **fallback**, not the default: whenever a usable subtitle already exists — locally, or on OpenSubtitles — SubArabify uses it and skips transcription entirely.

## Features

- **Subtitle-first pipeline (v3):** ready-made Arabic → ready-made English → audio transcription, in that order.
- **OpenSubtitles hash search:** computes the OpenSubtitles movie hash (size + first/last 64 KB) and searches by `moviehash`, falling back to title+year — implemented as a plain REST client, no heavy libraries.
- **Keyless AI Translation Engine:** translates existing English `.srt` files with `Puter.js` AI Gateway only when no Arabic subtitle exists.
- **Background Automation:** continuously watches your media directory for new movies and processes them transparently.
- **Smart Branding:** watermarks output subtitles with `[ ترجمت الأداة ساب أرابيفاي — مدعوم من Puter.js ]` and writes them as `MovieName.SubArabify.ar.srt`.
- **Decision log:** every per-movie decision (identified title/year, hash vs. title match, provider, fallback used) is appended to `logs/decisions.jsonl`.
- **Runs Everywhere:** designed to run on Termux (Android/ARM64) or any standard Node.js environment — pure JS, no native modules.

---

## Subtitle fallback order

For every new video, SubArabify tries these in order and stops at the first hit:

1. **Existing output** — `MovieName.SubArabify.ar.srt` already present → skip (idempotent).
2. **Local Arabic** — `MovieName.ar.srt` / `MovieName.arabic.srt` / any same-named subtitle whose *content* is Arabic → brand it and save (no translation, no AI).
3. **OpenSubtitles (Arabic)** — moviehash search first, then title+year search → download, validate, brand.
4. **Local English** — `MovieName.srt`, `MovieName.en.srt`, `eng.srt`, … → Puter.js translation.
5. **OpenSubtitles (English)** — same hash-then-title strategy → download, validate → Puter.js translation.
6. **Audio transcription** — only when nothing above exists: FFmpeg chunking + Puter.js Whisper.

Every downloaded or local subtitle is validated before use: it must parse as SRT, keep sane cue counts against the runtime, and be normalized to UTF-8.

---

## 🚀 Getting Started on Termux (Android)

You can run the SubArabify engine directly on your Android phone using standard Node.js tools in Termux.

### 1. Grant Storage Access
Allow Termux to read and write to your phone's media storage:
```bash
termux-setup-storage
```

### 2. Install Dependencies (Node.js & FFmpeg)
Install Node.js to power the `Puter.js` scripts, and FFmpeg for local audio extraction:
```bash
pkg update && pkg install nodejs ffmpeg -y
```

### 3. Setup Project
Clone the repository and install the NPM packages:
```bash
git clone https://github.com/muxd22-alt/SubArabify.git
cd SubArabify
npm install
```

### 4. Add your API keys (optional but recommended)
```bash
cp .env.example .env
nano .env
```

| Variable | Required for | Where to get it |
|---|---|---|
| `OPENSUBTITLES_API_KEY` | Remote subtitle search (steps 3 & 5) | Free consumer key: <https://www.opensubtitles.com/en/users/sign_up> → API section |
| `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` | Optional: unlocks the OpenSubtitles download quota (JWT) and quota reporting | Same account as above |
| `TMDB_API_KEY` | Genre-aware movie brief (lands with the next module) | Free v3 key: <https://www.themoviedb.org/settings/api> |
| `PUTER_AUTH_TOKEN` | Optional: Puter.js auth (AI calls work keyless) | <https://puter.com> |

Without `OPENSUBTITLES_API_KEY`, SubArabify still works — it simply skips remote search and falls back to local subtitles or audio transcription. CI stores these keys as the `OpenSubtitles` and `TMDBAPI` repository secrets.

### 5. Run SubArabify!
Run the node script and point it to your phone's movie folder:
```bash
npm start -- --media ~/storage/shared/Movies
```
Or run directly:
```bash
node subarabify.js --media ~/storage/shared/Movies
```

The script will now actively watch the destination folder. Whenever a `.mp4`, `.mkv`, `.avi` or `.m4v` file is added, it identifies the release name (title + year), looks for a ready-made subtitle in the order described above, and only extracts audio for transcription when nothing else is available.

---

## Manual test plan

Run these against a folder with at least **two different genres** of movies:

1. **Identification** — drop in e.g. `Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv` (sci-fi) and `Zombieland.2009.720p.BluRay.x264-REFINE.mkv` (horror). The log should show `Identified: "Interstellar" (2014)` and `Identified: "Zombieland" (2009)` — release noise (`1080p`, `BluRay`, `x264`, group name) must not leak into the title.
2. **Arabic subtitle skips translation** — place `SomeMovie.2020.1080p.ar.srt` next to `SomeMovie.2020.1080p.mkv` (no `.SubArabify` output yet). Processing must write `SomeMovie.2020.1080p.SubArabify.ar.srt` with the watermark and log `brand-arabic` — **no** Puter.js translation call must appear in the console.
3. **OpenSubtitles fetch** — with `OPENSUBTITLES_API_KEY` set, remove any local `.srt` for a movie that exists on OpenSubtitles. The log should show `remote-ar | search | N hit(s) | hash` (or `title`), then either a branded Arabic download or a translation from a downloaded English subtitle. `logs/decisions.jsonl` records the `fileId`, `moviehashMatch`, and remaining download quota.
4. **No-key degradation** — unset the key and repeat step 3: the run must log `remote | skipped | no OPENSUBTITLES_API_KEY` and proceed to local English or audio fallback instead of crashing.
5. **Audio last resort** — a video with no subtitles anywhere must log `audio-fallback` and only then run FFmpeg + Whisper.

*(The genre-aware brief check — different wording for sci-fi vs. horror translations — arrives with the `movie-brief.js` module in the next release.)*

---

## Development

```bash
npm test          # node --test: identifier, OSHash vectors, SRT utils, finder, pipeline
```

The hash tests assert against the canonical OpenSubtitles test vectors published by [opensubtitles/oshash](https://github.com/opensubtitles/oshash); regenerate the fixtures with `python test/fixtures/generate_fixtures.py`.

## Dependencies

- **Node.js** (v18+, global `fetch` required)
- **FFmpeg** (v4.0+, audio fallback only)
- **@heyputer/puter.js**: free AI translation/transcription without an API key.
- **chokidar**: efficient local folder monitoring.
- **parse-torrent-title**: proven release-name parser (MIT, pure JS).

---
*Created by [the SubArabify community](https://github.com/muxd22-alt).*
