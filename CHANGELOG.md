# Changelog

## 2.3 — the engine runs inside the app (no Termux)

- **Termux is gone.** The app now carries its own Node engine and native tools
  and runs them itself in a foreground service; there is no companion installer
  and nothing to paste into a terminal.
- The app ships the engine as `arm64-v8a` native libraries (`libnode.so`,
  `libllama-server.so`, `libwhisper-cli.so`, `libffmpeg.so`, `libffprobe.so`)
  unpacked from the APK on first run — still **nothing is compiled on the phone**.
- **One movie at a time, parallelism inside it:** `JOB_CONCURRENCY` is pinned to
  `1`, while the app's 1–4 selector now sizes the in-video translation chunks
  (`TRANSLATE_CONCURRENCY`) and the llama `-np` slot pool (`LLAMA_PARALLEL`).
- First run walks you through three steps — allow all-files access, choose your
  media folder, download the models once into `<media>/ArabicSubs/` — then
  **تشغيل الكل** works through the queue in the app, with progress and status
  surfaced from the service.
- Removed the `com.termux.permission.RUN_COMMAND` permission, the Termux
  `<queries>` entry, every copy-command control and the loopback status server.

## 2.2 — clean slate: one commit, one release

- The repository is reset to a **single commit** and every older release/tag was
  removed — one tag (`v2.2`), one release.
- The prebuilt android-arm64 engine (`arabic-subs-engine-android-arm64.zip`) now
  ships *with* the app release instead of as its own prerelease, so `v2.2`
  carries both the APK and the engines.
- Same signing keystore as before, so this APK installs as an in-place update and
  later releases keep updating on top of it.
- Carries the parallel engine: `JOB_CONCURRENCY` (several videos at once),
  `LLAMA_PARALLEL` slots and the app's «ملفات متوازية» selector.

## 2.1.0 — parallel engine, refreshed app, standard quant

- The engine now works on **several videos at once** instead of one at a time.
  `JOB_CONCURRENCY` (default `2`) is how many videos run in parallel; the
  in-video translation chunks stay parallel as before. Set `JOB_CONCURRENCY=1`
  for the old strictly-sequential behaviour, which keeps the phone coolest.
- `LLAMA_PARALLEL` (default `TRANSLATE_CONCURRENCY × JOB_CONCURRENCY`) sizes
  `llama-server`'s slot pool, so the extra videos' requests are served
  concurrently instead of queueing behind each other in the engine.
- The companion app gains a **«ملفات متوازية» 1-4 selector** on the dashboard.
  The choice is stored in shared preferences and passed to Termux as
  `JOB_CONCURRENCY=n` on the run / single-file commands; the engine card now
  reports how many files are in flight (`… ملفات بالتوازي`).

- The shipped model is now **Hy-MT2-1.8B Q4_K_M** (1.06 GB) from Tencent's own
  GGUF repo — an ordinary quant any recent `llama.cpp` reads. The engine no
  longer depends on a pinned fork commit for the default path.
- `HYMT_MODEL_FLAVOR` selects the model: `q4_k_m` (default), `q6_k`, `q8_0`
  (all standard, stock engine) or `stq` (the 440 MB 1.25-bit STQ1_0 file, which
  still needs the PR #22836 fork engine). Each preset pins its exact byte count,
  so a partial or corrupt download is caught before `llama-server` sees it.
- `setup-termux.sh` builds **mainline** `llama.cpp` as the source fallback for
  the standard quant, and only reaches for the `sjl623/llama.cpp` `STQ_0` fork
  when `HYMT_MODEL_FLAVOR=stq`. The verified prebuilt engine stays the first
  choice either way.
- The CLI, help text and README no longer describe the model as STQ1_0-only.
- `setup` (and the first `run`) now fetch the translation model **and** the
  whisper model at the same time on two resumable streams, instead of one after
  the other, so the phone spends the download window once. A multi-line progress
  display keeps the two bars from overwriting each other.
- CI fix: `app/build.gradle.kts` imported `java.util.Properties` explicitly —
  a bare `java.util.Properties()` resolved against Gradle's `java` extension
  and failed the Android build with `Unresolved reference: util`.
- Version is **2.1.0** across `package.json` (which drives the CI release tag),
  `versionName`/`versionCode` and the app's version badge.

## 2.0.1 — the phone compiles nothing; the engines are downloaded

- The one-liner used to leave the phone compiling: `llama-server` from the STQ
  fork, then `whisper.cpp` from source. Both are now in **one prebuilt archive**
  — release [`engine-android-arm64-v2`](https://github.com/muxd22-alt/arabic_subtitles/releases/tag/engine-android-arm64-v2),
  `arabic-subs-engine-android-arm64.zip`, sha256 pinned in the release notes:
  - `llama-server` + `llama-cli` — `sjl623/llama.cpp` `STQ_0` @ `1e411d8`
    (the PR #22836 tree with the STQ1_0 kernel Hy-MT2 needs);
  - `whisper-cli` — `ggml-org/whisper.cpp` master;
  - all three cross-compiled with NDK r28c: static libc++, `GGML_OPENMP=OFF`
    (the first build died with `CANNOT LINK EXECUTABLE … libomp.so`), 16 KB page
    aligned, baseline NEON so any arm64 phone runs them.
- `scripts/setup-termux.sh` verifies the archive's sha256, smoke-tests
  `llama-cli --version`, then links `llama-server` **and** `whisper-cli` into
  `$PREFIX/bin`. The whisper source build is now explicitly the fallback, and
  the llama source build stays behind `ARABIC_SUBS_FORCE_LLAMA_BUILD=1`.
- Engines install to `~/.arabic-subs/engine` (the old `~/llama-stq` path still
  resolves, for phones set up before this release).
- Release hygiene: engine archives are marked **prerelease** so they never take
  the repository's *Latest* badge — that belongs to the app APK, and the README
  links `releases/latest` for the download.
- Version is **2.0.1** across `package.json` (which drives the CI release tag),
  `versionName`/`versionCode` and the app's version badge.
- 74 node tests.

### App: new look, and step 3 is three buttons

- The companion app (v1.1.7) gets a new identity: a violet/indigo night palette
  (one `Accent` behind the whole UI) replacing the old gold, with the dark
  surfaces re-tuned to sit on it. Hero actions, stat tiles and the wizard restyled.
- **Step 3 of the wizard is no longer a single command** — it is three function
  cards, each with its own run / copy buttons:
  1. **تثبيت / إصلاح المحرك** — installs the verified 16 MB prebuilt engine (the
     app never asks anyone to compile llama.cpp),
  2. **تشغيل قائمة الانتظار** — the queue,
  3. **ترجمة ملف واحد** — the first pending file (disabled with an explanation
     when there is nothing pending).
- The dashboard gains an **«إصلاح المحرك»** button that runs the setup script,
  replacing the copy-the-run-command button; launching anything in Termux now
  goes through one shared `launchTermuxCommand` helper.
- The Arabic landing page and README describe the three functions and the
  prebuilt engine — no step tells a user to build llama.cpp any more.

### The engine ships as a prebuilt; the phone stopped compiling it

- Building llama.cpp **on the phone** was the worst link in the chain: 15-40
  minutes, and it does not always even produce a binary that runs. The STQ1_0
  fork at a given commit only has to be compiled once — so it is compiled once
  here, on the PC, with the Android NDK, and published with this repo:
  - **Release [`llama-stq-android-v1`](https://github.com/muxd22-alt/arabic_subtitles/releases/tag/llama-stq-android-v1)**
    — `llama-server` + `llama-cli`, arm64, stripped, sha256 pinned in the
    release notes (asset name and tag are immutable, so an install can never
    download half of a different build);
  - cross-compiled from `sjl623/llama.cpp` `STQ_0` @ `1e411d8` (the PR #22836
    tree) with NDK r28c, static libc++, `GGML_OPENMP=OFF` so the binary needs
    **no external libraries** — the first build linked `libomp.so`, which
    Termux does not ship, and died with `CANNOT LINK EXECUTABLE`;
  - `ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON`, so it also runs on the 16 KB-page
    devices of Android 15+;
  - `GGML_NATIVE=OFF` (baseline NEON, no illegal-instruction risk on an older
    CPU) — the STQ kernel keeps a non-dotprod fallback path.
- `scripts/setup-termux.sh` now installs that zip instead of compiling: it
  downloads it, checks the sha256, smoke-tests `llama-cli --version` (which is
  what catches a damaged download or an incompatible CPU), links it into
  `$PREFIX/bin`, and **only falls back to the 15-40 minute source build** when
  the download or the smoke test fails. `ARABIC_SUBS_FORCE_LLAMA_BUILD=1` skips
  straight to the build; `ARABIC_SUBS_SKIP_LLAMA_BUILD=1` skips both. The
  download can be redirected with `ARABIC_SUBS_PREBUILT_URL` /
  `ARABIC_SUBS_PREBUILT_SHA256` / `ARABIC_SUBS_PREBUILT_DIR`.
- `run` / `translate` no longer offer a 15-40 minute phone build as the *first*
  choice: they offer the ~16 MB install, and keep the build as the documented
  escape hatch.
- `findLlamaServer()` also looks in `~/llama-stq`, so the engine is found even
  if the `$PREFIX/bin` symlink was replaced by a `pkg upgrade`.
- A llama-server that dies at startup still reports how (`killed by signal
  SIGSEGV`) and its full output lands in
  `~/.arabic-subs/models/llama-server.log`; the README explains what to collect
  from `logcat` when even the prebuilt crashes.

### The model was never corrupt; llama.cpp lacked the STQ kernel

- The phone had a byte-perfect copy of Hy-MT2 — twice — and `llama-server` still
  refused it (`tensor 'blk.0.attn_k_norm.weight' has offset 203154464, expected
  203277344`). Root cause: the 1.25-bit GGUF is quantized with **STQ1_0**, a
  kernel that exists only in the llama.cpp fork of
  [PR #22836](https://github.com/ggml-org/llama.cpp/pull/22836), unmerged
  upstream. Termux's `llama-cpp` package predates it, mis-sizes every STQ
  tensor and reports that offset mismatch. Now:
  - `scripts/setup-termux.sh` always builds llama-server from
    `sjl623/llama.cpp` branch `STQ_0` (the PR's fork), symlinked in front of
    any packaged binary, and records the pin in
    `~/.arabic-subs/llama-stq.sha` — a stamped build is reused on later runs
    and re-linked if `pkg upgrade` restored the packaged one;
  - `ARABIC_SUBS_FORCE_LLAMA_BUILD=1` forces that rebuild,
    `ARABIC_SUBS_SKIP_LLAMA_BUILD=1` skips it;
  - `run` no longer offers a pointless 440 MB re-download when the file passes
    the size + GGUF checks: it says the kernel is missing and offers the
    rebuild instead (15-40 min, once);
  - `ensureLlamaServer` stops offering `pkg install llama-cpp` — that package
    cannot run this model — and goes straight to the source build.
- Corruption hardening stays for genuine cases: `modelStatus()` is exact (size
  must equal `MODEL_BYTES` and the file must open with the `GGUF` magic,
  otherwise `corrupt`), a resumed download verifies that the `206 Content-Range`
  starts exactly where we asked, an oversized `.part` is deleted instead of
  being renamed into place, and `setup` never prints "already present" for a
  broken file. `HYMT2_MODEL_BYTES` overrides the expected size (used by tests).
- A llama-server that dies at startup now says how (`killed by signal SIGSEGV`
  instead of `exited with code null`) and its full output is appended to
  `~/.arabic-subs/models/llama-server.log`, so a crash with a swallowed stdout
  still leaves evidence.
- 71 tests.

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
