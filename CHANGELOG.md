# Changelog

## 1.1.0 — Termux step-by-step wizard + Thmanyah landing page

### App (Android)

- **`SetupWizard`** — after the first folder is picked the app opens a one-step-at-a-time
  onboarding dialog: progress bar, plain-language hint, and the exact command for that step.
- **Auto-copy** — every time a step is shown its command is written to the clipboard
  (toggleable per step), with a "paste it in Termux" confirmation and a manual copy button.
- **Run in Termux** — commands are sent straight to Termux's `RUN_COMMAND` service; if
  Termux is missing the app falls back to copy + open Termux, or reports that F-Droid is needed.
- Last step is rebuilt from the folders you actually picked (`--media` per folder).
- New dashboard button **"الإعداد خطوة بخطوة مع تيرمكس"** and a list icon in the top bar
  reopen the wizard at any time; the old Termux setup dialog stays behind the gear icon.
- `versionCode 2`, `versionName 1.1.0`.

### Docs

- Landing page rewritten around the **Thmanyah Sans** family (bundled in `docs/fonts/`),
  gold-on-dark identity matching the app, RTL throughout, preload hints for the OTFs.
- `docs/.nojekyll` added.

### Fixes

- Kotlin: `@OptIn(ExperimentalMaterial3Api::class)` on `onCreate` — the release build no
  longer fails on the experimental `TopAppBar` APIs.
- GitHub Pages switched to `build_type: workflow` so `configure-pages` succeeds and the
  site is deployed from the Actions workflow instead of the legacy `/docs` auto-build.

## 1.0.0 — ground-up rebuild: Arabic Subs (offline EN→AR translation)

The project was renamed from **SubArabify** to **Arabic Subs / arabic_subtitles**
and rewritten from scratch around Tencent **Hy-MT2**. Everything OpenSubtitles-,
TMDB-, and Puter.js-related is gone.

### Engine (new `src/`, `bin/arabic-subs.js`)

- **Hy-MT2 translation** — `Hy-MT2-1.8B-1.25Bit.gguf` (461 860 800 bytes) served
  by a locally spawned `llama-server`; numbered-line prompt with per-line
  fallback parsing.
- **Parallel chunk translation** — cues batched at ≤16 lines / ≤800 chars,
  pushed through a 4-way pool; every batch is validated (must return Arabic) and
  a bad batch is split in half and retried, falling back to source text rather
  than aborting the video.
- **Audio path** — ffmpeg splits the timeline into 5-minute windows with a
  1-second overlap (2 concurrent workers), whisper.cpp transcribes each window,
  and cues are merged by midpoint ownership so overlap regions never duplicate.
- **Per-video pipeline** — existing output → skip; ready-made Arabic → brand;
  English subtitle → translate; embedded track → extract then translate;
  otherwise the audio path; every outcome logged to `logs/decisions.jsonl`.
- **Zero runtime dependencies** — watchers replaced by polling folder scans
  (inotify is unreliable on Android shared storage), torrent-name parsing and
  OpenSubtitles clients deleted outright.
- **Model downloader** — Range-resume from `.part` files, redirect handling,
  bounded retries; `arabic-subs setup` fetches both the Hy-MT2 and whisper models.
- **Status API** — `GET http://127.0.0.1:18435/status` for the companion APK.
- **CLI** — `setup`, `run`, `translate`, `transcribe`, `scan`, `status`, `log`.

### App (Android)

- Rebranded to `com.arabicsubs` (namespace, applicationId, sources, proguard).
- Multiple media folders can be picked (Movies + TV Shows) instead of one.
- Live engine status card polling the node status API.
- Launch/translate commands updated to `~/arabic_subtitles` + `arabic-subs`.
- `INTERNET` permission added for localhost status polling; WorkManager dropped.
- `versionCode 1`, `versionName 1.0.0`; icon renamed `arabicsubs_icon`.

### Docs & CI

- README rewritten for the offline pipeline; landing page rewritten.
- `node-ci.yml` no longer needs OpenSubtitles/TMDB secrets (62 tests, no network).
- `android-build.yml` artifacts renamed `ArabicSubs-APK`, release only on tags.
- New `scripts/setup-termux.sh`: installs nodejs/ffmpeg/llama-cpp and builds
  llama.cpp + whisper.cpp from source when packages are unavailable.

### Removed

- `subarabify.js`, `opensubtitles.js`, `movie-identifier.js`, `subtitle-finder.js`,
  `srt-utils.js`, `config.js`, `decision-log.js`, `.env.example`,
  `parse-torrent-title` / `chokidar` dependencies, all related tests.
