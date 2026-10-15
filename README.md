# Arabic Subs (عربي سبس) 🎬

<p align="center">
  <strong>Point it at your movies. It writes the Arabic subtitles.</strong><br>
  Fully offline EN→AR subtitles on Android (Termux) — no cloud, no account, no tracking.
</p>

<p align="center">
  <a href="https://github.com/muxd22-alt/arabic_subtitles/releases/latest"><img src="https://img.shields.io/github/v/release/muxd22-alt/arabic_subtitles?color=E5A93C&label=APK" alt="APK" /></a>
  <img src="https://img.shields.io/badge/Android-8.0%2B-arm64-blue" alt="Android" />
  <img src="https://img.shields.io/badge/privacy-100%25%20on--device-success" alt="Privacy" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="License" /></a>
</p>

---

## Three steps. That's the whole thing.

| | Step | What you do |
| :--: | :--- | :--- |
| **1** | **Install** | Paste one line into Termux. Everything — packages, the engine, the model — downloads from GitHub. Nothing is compiled on your phone. |
| **2** | **Pick your folders** | Choose your Movies / TV folder in the app. It finds every video and checks what's already there. |
| **3** | **Run** | Tap **تشغيل الكل** and it works through the queue until it finishes — or tap **▶ ترجمة** on one film and do just that. |

---

### 1️⃣ Install

Install **Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) (**not** the Play Store — that build is dead), open it, and paste:

```bash
pkg install -y curl; curl -fsSL -o ArabicSubs.sh https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/ArabicSubs.sh; bash ArabicSubs.sh
```

That one line:

- installs `nodejs`, `ffmpeg`, `git`, `curl`, `unzip`;
- clones the repo into `~/arabic_subtitles`;
- downloads the **prebuilt engine** — `llama-server` and `whisper-cli`, compiled for android-arm64 with the Android NDK, checked against a sha256, and smoke-tested before it's trusted (~16 MB, a few seconds);
- downloads the models (~1.2 GB) **both at once**, resumable, only after you say yes.

Re-run it any time. Every step reports "already … — skipping" instead of asking twice.

<details>
<summary>What if something goes wrong</summary>

```bash
cd ~/arabic_subtitles
bash scripts/setup-termux.sh     # re-installs the engines
node bin/arabic-subs.js run --media /sdcard/Movies
```

- **`killed by signal SIGSEGV`** → the engine crashed. Re-run the setup above; it re-downloads the prebuilt. Details: `~/.arabic-subs/models/llama-server.log`.
- **`tensor 'blk.0.attn_k_norm.weight' has offset …, expected …`** → the model and the engine disagree on the quant format. Re-run the setup so both are re-fetched as a matched pair.
- **Nothing happens when you tap run** → open Termux and run the command the app copied.

</details>

### 2️⃣ Pick your folders

Install the companion app ([latest APK](https://github.com/muxd22-alt/arabic_subtitles/releases/latest)) and tap **« إضافة مجلد أفلام / مسلسلات »** to pick your media folder (e.g. `/sdcard/Movies`). Add as many as you like.

The app scans and sorts your library for you, marking each video:

| State | Meaning |
| :--- | :--- |
| ✅ جاهز | Arabic subtitle already written |
| ⏳ بانتظار الترجمة | waiting in the queue |
| ⏭️ متخطى | you skipped it |

Prefer not to use the app? The CLI takes the same folders:

```bash
cd ~/arabic_subtitles && node bin/arabic-subs.js run --media /sdcard/Movies
```

### 3️⃣ Run

- **The whole queue:** tap **تشغيل الكل** — it translates everything pending, one film at a time, until it finishes.
- **Just one film:** tap **▶ ترجمة** on that row.

Either way it runs in Termux, watching its progress live.

Prefer the CLI?

```bash
cd ~/arabic_subtitles
node bin/arabic-subs.js run --media /sdcard/Movies              # the queue
node bin/arabic-subs.js process "/sdcard/Movies/Gladiator.mkv"  # one film
node bin/arabic-subs.js translate movie.srt --out movie.ar.srt  # one subtitle file
node bin/arabic-subs.js scan /sdcard/Movies                     # what will happen
node bin/arabic-subs.js status                                  # live status
```

---

## How it decides

For every video, in this order — and it logs every decision to `logs/decisions.jsonl`:

| # | If… | Then | Model |
| :--: | :--- | :--- | :--- |
| 1 | the Arabic subtitle already exists | skip (idempotent) | — |
| 2 | an Arabic subtitle sits next to the video | brand it and save | — |
| 3 | an English subtitle sits next to the video | translate the cues | loaded |
| 4 | the video has an embedded subtitle track | extract, then translate | loaded |
| 5 | no subtitles, but there is audio | transcribe with whisper, then translate | loaded |
| 6 | neither | skip, with the reason logged | — |

Videos go one at a time so the phone stays cool; inside a video, cues are batched and translated in parallel.

---

## What runs on your phone

| Piece | What it is |
| :--- | :--- |
| **Translation** | Tencent **Hy-MT2-1.8B**, Q4_K_M GGUF. ~1.06 GB, served by `llama-server`. |
| **Transcription** | `whisper.cpp` (`base`), only for videos with no subtitle track. |
| **Engine** | `llama-server` + `whisper-cli`, prebuilt for android-arm64 — ships with the app [release](https://github.com/muxd22-alt/arabic_subtitles/releases/tag/v2.2) |

The engine is **prebuilt, not compiled on the phone**: cross-compiled with the Android NDK, statically linked (needs only `libc`/`libm`/`libdl`), 16 KB-page ready for Android 15+, and baseline NEON so it runs on any arm64 device.

> **Why Q4_K_M and not the tiny 1.25-bit model?**<br>
> Hy-MT2 also ships extreme-bit GGUFs — 1.25-bit "Sherry" (STQ1_0) and 2-bit
> "Stride16" (int2). Both are **gated behind unmerged llama.cpp PRs**
> ([#22836](https://github.com/ggml-org/llama.cpp/pull/22836) and draft
> [#19357](https://github.com/ggml-org/llama.cpp/pull/19357)), so no ordinary
> llama.cpp can read them — they abort with
> `tensor 'blk.0.attn_k_norm.weight' has offset …, expected …`. Q4_K_M is an
> ordinary quant, so the engine stops depending on a pinned fork commit, at the
> cost of 1.06 GB instead of 440 MB. Want more accuracy? Set
> `HYMT_MODEL_FLAVOR=q8_0` (1.9 GB) or `=q6_k` (1.5 GB) — both from Tencent's
> official repo. The 1.25-bit file is still selectable with
> `HYMT_MODEL_FLAVOR=stq`, but it needs the fork engine.

---

## Configuration

Set these as environment variables (or in a `.env` file):

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `HYMT_MODEL_FLAVOR` | `q4_k_m` | model to use: `q4_k_m`, `q6_k`, `q8_0` (standard) or `stq` (1.25-bit, fork engine) |
| `HYMT2_MODEL` | `~/.arabic-subs/models/Hy-MT2-1.8B-Q4_K_M.gguf` | model path |
| `LLAMA_PORT` | `18434` | engine port |
| `TRANSLATE_CONCURRENCY` | `4` | parallel cue workers |
| `TRANSLATE_BATCH_LINES` | `16` | cues per request |
| `WHISPER_MODEL` | `base` | `tiny` / `base` / `small` |
| `LLAMA_SERVER_BIN` | auto | use your own `llama-server` |

---

## Development

```bash
npm test        # 74 tests, fully offline
```

Layout: `bin/arabic-subs.js` (CLI), `src/` (engine, media, pipeline), `app/` (Android UI), `scripts/setup-termux.sh` (installer).

---

## License

MIT — see [LICENSE](LICENSE).