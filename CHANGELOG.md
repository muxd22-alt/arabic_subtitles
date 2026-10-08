# Changelog

## 1.1.6 — the engine fixes itself instead of printing an error

- `run` / `translate` no longer stop at `llama-server is not installed yet`:
  1. they offer the Termux package (`pkg install -y llama-cpp`),
  2. if that fails or is declined they offer `scripts/setup-termux.sh`
     (repairs a broken cmake, then builds llama.cpp from source),
  3. only after both are refused do they print the one-line fix.
- A missing `whisper-cli` now offers that same setup instead of only warning
  that subtitle-less videos will be skipped.
- With no terminal to ask, every path prints the `ArabicSubs.sh` one-liner
  rather than a path the phone may not have.
- `ArabicSubs.sh` no longer aborts on a noisy `pkg update` or `npm install`
  (reported as warnings), resets a clean checkout to `FETCH_HEAD` when
  `git pull --ff-only` cannot fast-forward, and a trap names the line that
  failed so re-running resumes there.
- `scripts/setup-termux.sh` skips the download prompt entirely when both
  models are already present.
- Engine only — `git pull` picks this up, no new APK.

## 1.1.5 — ArabicSubs.sh: the whole setup in one file

- New `ArabicSubs.sh` at the repo root — packages, code, npm deps,
  llama-server, whisper, cmake repair, models (after the `[y/N]` prompt), all
  in one file you download and run:

  ```bash
  pkg install -y curl; curl -fsSL -o ArabicSubs.sh https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/ArabicSubs.sh; bash ArabicSubs.sh
  ```

- Wizard step 1 runs exactly that line, so what is copied is short enough to
  paste without the terminal joining it to whatever was already on the prompt.
- `scripts/bootstrap.sh` removed — `ArabicSubs.sh` is the one and only
  bootstrap; `scripts/setup-termux.sh` stays as the deep installer it calls.
- README and the landing page show the command plus the output it prints.
- `versionCode 7`, `versionName 1.1.5`.

## 1.1.4 — one command in Termux, then back to the app

- **Wizard rewritten to three steps**: ① one Termux command that does everything
  (storage link, packages, clone-or-update, `npm install`,
  `scripts/setup-termux.sh` → llama-server + whisper + models after you say yes),
  ② pick the Movies/TV Shows folders from inside the app (the step opens the
  system folder picker itself), ③ start the engine over what you picked.
- The wizard now auto-opens on **first launch** instead of after the first
  folder, because the folder step is step 2 of the flow.
- New `scripts/bootstrap.sh` — the same setup behind
  `curl … | bash` for people who prefer a one-liner without a repo.
- `scripts/setup-termux.sh` asks for the model download permission on
  `/dev/tty` when stdin is a pipe (so `curl | bash` still prompts), and skips
  the duplicate `pkg update` when bootstrap already refreshed the index.
- `run` / `translate` now offer to install `llama-server` themselves: when the
  binary is missing on Termux they ask `Install the Termux package "llama-cpp"
  now? [y/N]` and run `pkg install -y llama-cpp` for you, falling back to
  `bash scripts/setup-termux.sh` only if the package cannot be used.
- Watermark wording corrected: the first cue now reads
  `[ ترجمة الأداة عربي سبس ]` (was `ترجمت`). Engine only - no new APK needed,
  `git pull` picks it up on the next run.
- `versionCode 6`, `versionName 1.1.4`.

## 1.1.3 — self-updating setup, guards that survive the clipboard

- `scripts/setup-termux.sh` pulls the latest checkout and re-executes itself, so
  a phone holding an old copy of the script still gets the fixed version
  (broken-cmake repair, permission-gated downloads, idempotent steps).
- Wizard commands no longer contain `||` — a couple of Android clipboards drop
  that token while copying, turning `A || B` into `A  B`. All guards are written
  with `if/then/fi` now.
- The run/translate commands do a quiet `git pull --ff-only` before starting the
  engine, so an outdated clone can no longer keep answering
  `Model not ready (missing)`.
- Wizard step 3 pulls before `npm install`; step 2 installs `git` too.
- `versionCode 5`, `versionName 1.1.3`.

## 1.1.2 — the wizard updates an existing clone

- Wizard step 3 now runs `git pull --ff-only` when `~/arabic_subtitles` already
  exists, so a phone that cloned the project earlier gets the current engine
  (permission prompts, idempotent setup) instead of staying on stale code.
- `versionCode 4`, `versionName 1.1.2`.

## 1.1.1 — permission-gated downloads, idempotent setup

### Engine (`arabic-subs run` / `translate`)

- **Downloads now ask first.** Nothing is fetched silently: the engine lists what
  is missing (size + Hugging Face page), then asks `Download now? [y/N]`.
  `--yes` allows it up front, `--no-download` forbids it. With no terminal it
  explains both options instead of hanging.
- **One model for every source.** English subtitles, embedded tracks and
  whisper output are all translated by the same Hy-MT2 model — only the way the
  text is obtained differs per video. The stage log now shows it:
  `[Stage] x.mkv → translate (audio) (642 cues)`.
- `run` no longer aborts on a missing model: it offers the download, resumes a
  partial one, and only fails if the user says no or the transfer breaks.
- Missing `llama-server` now prints the fix (`bash scripts/setup-termux.sh` and
  `pkg upgrade -y` for the broken-cmake case) instead of a bare stack error.
- Missing whisper no longer blocks startup: it warns that videos without
  subtitles will be skipped and downloads `ggml-base` after permission.
- New `--yes` / `--no-download` flags (documented in `help`).

### Termux bootstrap (`scripts/setup-termux.sh`)

- Fully idempotent: storage link, packages, llama-server, whisper and models are
  each skipped with `already … — skipping` when present, so a second run looks
  exactly like the first one (no more `~/storage already exists` rebuild prompts).
- Repairs `CANNOT LINK EXECUTABLE "cmake" … missing symbol` by upgrading the
  toolchain and reinstalling `cmake + libc++ before building from source.
- Asks permission before the ~590 MB of model downloads; `--yes` skips the
  question; non-interactive runs download nothing and say how to do it later.

### App

- Wizard commands are now one-liners that skip what is already done, so
  re-running the wizard never hits "directory already exists" / "destination
  path already exists" / "already the newest version" surprises.
- The wizard auto-opens only the first time — finishing the last step records
  it (`setup_done`), after which it stays behind the dashboard button and the
  list icon.
- `versionCode 3`, `versionName 1.1.1`.

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
