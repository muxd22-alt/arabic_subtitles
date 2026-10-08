# Arabic Subs (عربي سبس)

Fully **offline EN→AR subtitle factory** for your phone. Point it at your Movies /
TV Shows folder and it produces `Movie.ArabicSubs.ar.srt` next to every video —
translated on-device by **Tencent Hy-MT2** (1.8B, 1.25-bit GGUF, ~440 MB) running
in llama.cpp, with **ffmpeg + whisper.cpp** handling videos that have no English
subtitle at all.

No cloud APIs, no accounts, no telemetry. Built for **Termux on Android (arm64)**
and any Linux/macOS box with Node 18+.

## How it works

For every video the engine picks the first source that applies:

| # | Source | What happens |
|---|--------|--------------|
| 1 | `Movie.ArabicSubs.ar.srt` already exists | skip (idempotent) |
| 2 | an Arabic subtitle next to the video | brand it and save — no model load |
| 3 | an English subtitle next to the video | translate cue-by-cue with Hy-MT2 |
| 4 | embedded English subtitle track | same as (3) |
| 5 | nothing — but audio exists | ffmpeg chunk extraction → whisper.cpp → Hy-MT2 |
| 6 | none of the above | skipped, reason logged |

Every decision lands in `logs/decisions.jsonl`.

### Performance design

- **Parallel translation chunks** — cues are batched (≤16 lines / ≤800 chars)
  and sent to `llama-server` through a 4-way pool. Each batch is validated
  (must come back Arabic); a bad batch is split in half and retried.
- **Parallel audio chunks** — the timeline is cut into 5-minute windows with a
  1-second overlap, extracted and transcribed concurrently (2 workers), then
  merged by midpoint ownership so overlap cues never duplicate.
- **Sequential video queue** — one video at a time keeps the phone cool while
  chunks inside each video run in parallel.
- **Resumable model downloads** — Range-request resume from `.part` files, so a
  dropped connection never restarts a 440 MB transfer.

## Quick start (Termux)

```bash
# 1. install Termux from F-Droid (not Play Store)

# 2. one file does everything: packages, code, llama-server, whisper,
#    then asks permission before the ~590 MB of models.
#    Safe to re-run: every step reports "already …" instead of asking twice.
pkg install -y curl; curl -fsSL -o ArabicSubs.sh https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/ArabicSubs.sh; bash ArabicSubs.sh

# 3. run the engine over your media folders
node bin/arabic-subs.js run --media /sdcard/Movies --media "/sdcard/TV Shows"
```

`ArabicSubs.sh` (repo root) is the whole thing — what it prints:

```text
[ArabicSubs] 1/5  packages (git, nodejs, ffmpeg)
[ArabicSubs] 2/5  code — clone first time, git pull every time after
[ArabicSubs] 3/5  node dependencies
[ArabicSubs] 4/5  llama-server + whisper (+ cmake repair if the toolchain is broken)
[setup]   Download now? [y/N] y
[ArabicSubs] 5/5  done

  Now open the Arabic Subs app:
    1. add your Movies / TV Shows folder(s)
    2. press start — the engine runs through Termux
```

Every source goes through **one model** — Hy-MT2. Whether the text comes from an
English subtitle, an embedded track, or whisper transcribing the audio, only the
way it is obtained changes; the translation model never does
(`https://huggingface.co/tencent/Hy-MT2-1.8B`).

The APK (`app/`) is a companion UI: pick Movies/TV Shows folders, see which
videos are still missing Arabic subtitles, launch the engine through Termux's
`RUN_COMMAND` intent, and watch live progress — the engine serves a status API
on `http://127.0.0.1:18435/status` that the app polls.

On first launch the app opens a **three-step wizard**: one Termux command that
does everything (it is copied to the clipboard, one tap sends it to Termux),
then back in the app to pick your Movies/TV Shows folders, then start the
engine. Every command is idempotent, so re-running the wizard reports
`already … — skipping` instead of asking the same questions again, and the
wizard only auto-opens once. Grab the APK from the
[latest release](https://github.com/muxd22-alt/arabic_subtitles/releases/latest).

## CLI

```text
arabic-subs setup                      # download Hy-MT2 + whisper models
arabic-subs run --media <dir>          # watch folders, translate everything
arabic-subs translate file.srt …       # one-shot SRT translation
arabic-subs transcribe video.mkv …     # audio → English SRT
arabic-subs scan [dir] …               # list videos + which source each uses
arabic-subs status                     # engine/model status JSON
arabic-subs log                        # recent decisions
```

## Requirements

| Tool | Why | Termux |
|------|-----|--------|
| Node 18+ | engine | `pkg install nodejs` |
| ffmpeg / ffprobe | audio chunks, duration probing | `pkg install ffmpeg` |
| llama-server | serves Hy-MT2 | `pkg install llama-cpp` |
| whisper-cli | speech → text for subtitle-less videos | `bash ~/ArabicSubs.sh` |

Without ffmpeg/whisper the engine still translates any existing English
subtitle — the audio path simply reports `no-subtitle-or-audio`.

## Configuration

Everything has a default; override with env vars or a `.env` file:

| Var | Default | Meaning |
|-----|---------|---------|
| `HYMT2_MODEL` | `~/.arabic-subs/models/Hy-MT2-1.8B-1.25Bit.gguf` | model path |
| `WHISPER_MODEL` | `base` | whisper.cpp model size |
| `LLAMA_PORT` | `18434` | llama-server port |
| `STATUS_PORT` | `18435` | status API port |
| `LLAMA_BASE_URL` | *(spawn local)* | use an already-running server |
| `TRANSLATE_CONCURRENCY` | `4` | parallel translation requests |
| `TRANSLATE_BATCH_LINES` / `BATCH_CHARS` | `16` / `800` | batch size |
| `AUDIO_CONCURRENCY` | `2` | parallel ffmpeg/whisper workers |
| `AUDIO_CHUNK_MINUTES` | `5` | audio chunk length |
| `NGL` / `THREADS` | auto | GPU layers / CPU threads for llama.cpp |

## Output

- Files: `MovieName.ArabicSubs.ar.srt` (sidecar, never touches the video)
- Watermark: first cue is `[ ترجمة الأداة عربي سبس ]`
- Log: `logs/decisions.jsonl` — one JSON object per decision

## Development

```bash
npm test          # node --test — 62 tests, no network, no model needed
```

The suite covers SRT parsing/validation/encoding detection, batch chunking and
retry logic, the per-video pipeline (against a fake engine), the download
resumer (against a local HTTP server), the job queue/watcher, audio chunk
planning and overlap merging, and the status API. ffmpeg/whisper/llama-server
are never invoked.

## License

MIT
