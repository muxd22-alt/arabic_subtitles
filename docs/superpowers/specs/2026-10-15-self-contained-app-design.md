# Arabic Subs — a self-contained Android app

Status: draft, awaiting approval. Date: 2026-10-15. Target release: 2.3 (next after the shipped 2.2).

## Why this exists

The phone app today is only a remote control. It builds command lines and hands them to
Termux, where a Node.js program does the real work: find a subtitle, or transcribe the audio,
translate it, and write the `.srt`. So the user must install Termux from F-Droid, paste a
one-liner, wait through a setup script, and then keep pasting commands. That is not "choose a
folder and go", and every command change breaks it.

This design makes the app the whole product. It carries its own engine, downloads the model
once into the user's own media folder, scans folders the way a downloader leaves them,
translates one movie at a time with the parallelism tuned to the phone's cores, and shows a
progress bar with an expected finish time. Termux stops being required.

## Who it is for, and the moment

Someone who downloads films on their phone with Flud (or any downloader). Downloads land in
per-torrent folders, sometimes in season subfolders, sometimes just loose in the root. The
moment this serves: a download just finished; they open Arabic Subs; without leaving the app,
the film gets Arabic subtitles.

## Goals

- No terminal. Install, open, grant access, pick a folder, done.
- One folder of our own, inside their media, reused forever: `<media>/ArabicSubs/`, holding
  the model(s) and logs.
- Find videos the way downloads arrive: per-torrent folders, nested season folders, and loose
  files dropped at the root.
- Translate a whole movie in parallel, sized to the device (1–4): fastest by default, lightest
  on demand.
- Honest feedback: per-movie progress bar, expected finish time, and a live notification;
  file sizes shown for movies, models, and finished `.srt` files.
- Same signing key as 2.2, so updates install in place.

## Non-goals

- Any online/API translation; it stays fully offline.
- Embedding the model inside the APK (far too big). The model is a one-time download.
- Editing or styling subtitles beyond writing a correct `.srt`.
- iOS or desktop.

## Anti-goals (a failure even if it "works")

- Asking the user to copy a command or open a second app.
- Running several whole movies at once as the default (the wrong axis, and it makes the ETA
  meaningless and cooks the phone).
- Silently missing videos that sit at the folder root.
- A progress bar that stalls, or an ETA that lies.

## Constraints

- Android, arm64 only, as today.
- The engines are Linux arm64 binaries: `llama-server` (translation), `whisper-cli`
  (speech-to-text), `ffmpeg`/`ffprobe` (audio). They can only run from a non-writable location,
  so they are bundled as `jniLibs/arm64-v8a/lib*.so` and executed from the app's native library
  directory. This is the standard Android trick for shipping executables.
- Real filesystem paths are needed to hand files to those binaries, so the app needs "All files
  access" (`MANAGE_EXTERNAL_STORAGE`). That rules out a Play Store listing; it is fine for a
  sideloaded app, which this is.
- About 30–80 MB of APK growth from the bundled engines and Node runtime (exact size depends on
  which prebuilt libraries are chosen).
- The CPU is the bottleneck and the phone gets hot; the number of parallel tasks must be
  bounded and user-controllable.

## The experience

### First run — one screen, three taps

1. "Allow access to your files" — opens the All-files access settings page.
2. "Choose your media folder" — Android folder picker. We create `<that folder>/ArabicSubs/`
   with `models/` inside; nothing is copied out of it later.
3. "Download the model" — shows the size and a progress bar, downloads
   `Hy-MT2-1.8B-Q4_K_M.gguf` (~1.06 GB) and the whisper `base` model (~142 MB) into that folder,
   cancelable and resumable. The engine itself is already inside the app, so this is the only
   download.

Then the dashboard. No commands, no clipboard.

### Adding folders

Add or remove media folders; the app rescans. More than one folder is allowed. Loose videos in
the root are included, exactly like files inside subfolders.

### The movie list

One row per video: name, size, state (waiting / transcribing / translating / done / failed /
skipped), and the `.srt` size once it exists. A per-movie "translate now" button. A movie whose
`.ArabicSubs.ar.srt` already exists shows as done (so 2.2 output is recognised).

### Running

"Run all" or a single movie. Exactly one movie is processed at a time; the speed comes from
parallelism *inside* that movie, not from running several at once.

### Progress and ETA

Stages: extract → transcribe → translate → write. One bar per movie, overall percent, and a
line like "~4 min left (12/41 chunks)". The notification mirrors the same numbers so the
screen can be off.

## Architecture

### App pieces

- **UI** (Compose, keeps the current dark theme): setup, dashboard, movie list, settings.
- **EngineService** — a foreground service that owns the engine processes and the job queue.
  It survives the screen turning off and posts the progress notification. (Foreground service
  type and notification copy: builder's call, but expect `dataSync`.)
- **Engine** — starts/stops `llama-server` and `whisper-cli`, health-checks the server, and
  reads progress from the tools' output.
- **Pipeline** — the existing Node engine (`src/*.js`, `bin/arabic-subs.js`) is the product and is
  reused as-is, run as a child process by the bundled Node runtime. The app does not reimplement
  it in Kotlin.
- **ModelStore** — download, verify against a pinned byte count / sha256, place under
  `<media>/ArabicSubs/models/`.
- **Scanner** — a Kotlin port of `walkMedia`: recursive with a depth cap, plus root-level files,
  same video extensions.

### Bundled engines

`jniLibs/arm64-v8a/libllama-server.so`, `libwhisper-cli.so`, `libffmpeg.so`, `libffprobe.so`,
plus a `libnode.so` runtime and the Node sources as assets — all prebuilt arm64, all fetched from
GitHub rather than compiled on the phone (the user's rule: "make it using precompiled on GitHub").
`minSdk` is chosen so the exec-from-nativeLibraryDir path works; `extractNativeLibs` stays on.

The `ffmpeg`/`ffprobe` and Node pieces are the open sourcing question (see open question 1): the
engine zip CI publishes today contains only `llama-server`, `llama-cli` and `whisper-cli`, so the
rest must be pinned from a known prebuilt source and added to the same release.

### The model store

`<media>/ArabicSubs/models/` sits in the user's own storage, not app-private storage, so it
survives app updates and reinstalls and is downloaded exactly once, then reused by future
versions.

### The pipeline (reuse, do not rewrite)

The Node engine is the product; it runs unchanged, with its 80 tests as the behaviour oracle.
Preserve the decisions already proven in `src/pipeline.js`:

- A sibling subtitle that is mostly Arabic → just brand/copy it (no AI).
- A sibling subtitle that is non-Arabic → translate it.
- No subtitle at all → transcribe the audio with whisper, then translate.
- Output `<base>.ArabicSubs.ar.srt` beside the video (keep the suffix).
- Never re-consume our own output as a source.
- Validation failures and "no speech" are reported, not silently dropped.

### Parallelism — the corrected axis

- One movie at a time.
- Inside the movie:
  - **Transcription**: split audio into chunks and run `AUDIO_WORKERS` whisper processes at
    once, each using the phone's cores.
  - **Translation**: start `llama-server` with `-np PARALLEL` slots and `-t cores`, and
    translate subtitle chunks in `PARALLEL` concurrent requests.
- The UI's **1–4** selector means "engine slots" (parallel tasks), defaulting to a value derived
  from the device (about 2 on a 4-core phone, up to 4 on 8 cores). 1 = coolest/slowest,
  4 = fastest/hottest.
- "How many whole videos at once" is dropped as a default. It may return later as an advanced
  "process an entire library overnight" option, but it is not the fast-path.

### ETA

Track completed chunks against total chunks and a rolling average of seconds per chunk;
ETA = average × remaining, recomputed every chunk. Finish time is shown in the app and the
notification.

## Decisions made with the user

- The repo is a clean slate: one commit, one release (v2.2), same signing key. Done.
- This work targets the next release, 2.3.
- The Node engine stays the product: the app bundles a Node runtime and runs the existing
  `bin/arabic-subs.js` as a child process; the pipeline is not ported to Kotlin.
- The **1–4** selector sets the translation chunk parallelism and the llama `-np` slots; the user
  chooses based on their phone and how fast they want the `.srt` produced. Transcription stays at
  a small fixed worker count so the CPU is not oversubscribed.
- Embedded subtitle tracks inside the video are extracted and translated in 2.3, so the README row
  becomes true.
- Finished subtitles are written beside each video (`.ArabicSubs.ar.srt`) so players pick them up
  normally.
- Default model: `Q4_K_M` (~1.06 GB).
- Primary storage only; no removable-storage (SD card) support.
- The first folder chosen hosts `<media>/ArabicSubs/`; removing it never deletes the downloaded
  model, and the user can re-point it.
- The release signing key is reachable from CI, so updates install in place.

## Calls I am making — change any of them

- **Engines ship inside the APK; models are downloaded on demand.** This is forced by Android, not
  a preference: a program downloaded into storage cannot be executed (W^X and noexec shared
  storage), so only code the package manager installs — the APK's native library directory — can
  run. Data such as the models downloads fine. This is why your "download the engine if needed"
  idea cannot work as stated, and the engine has to ride in the APK. Flag it if you disagree.
- Prefer community prebuilt arm64 libraries where they exist (llama.cpp, whisper.cpp, ffmpeg,
  nodejs-mobile) instead of building our own; nothing is ever compiled on the phone.
- Use All-files access (sideloaded app; not on Play).
- Keep the `.ArabicSubs.ar.srt` output suffix.
- One movie at a time, with parallelism inside the movie.
- Remove the Termux path from the product surface (the wizard, copy-commands, app Termux intents).

## What is left to the builder

- Exact foreground-service type, notification channels, and copy.
- Audio chunk size and overlap tuned for phones.
- Making the model download resumable.
- Recovering a half-finished movie after a crash or a kill.
- Whether `minSdk` must move up from 26 for any engine or permission reason.

## Risks

- Bundling binaries as `jniLibs` and executing them is well-trodden but must be verified on
  API 34+.
- All-files access is a broad permission, and users must grant it explicitly.
- Running Node as a child process must be proven on API 34+ (exec from nativeLibraryDir); a
  `nodejs-mobile` in-process alternative exists if the subprocess path fights SELinux.
- The release signing key must still be reachable from CI or "updates install in place" fails.
