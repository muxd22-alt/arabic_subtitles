# Subtitle Bazaar — design

**Date:** 2026-10-18 · **Status:** awaiting approval · **Ship as:** 2.6.0

## Why

The person this is for downloads movies with Flud. Sometimes a release ships
with subtitle files (usually English or Spanish, sometimes Korean); sometimes it
ships nothing; occasionally a subtitle is embedded inside the MKV. Today the
engine only reads *sibling files named like the movie* — anything else falls
straight to 20–40 minutes of whisper transcription on the phone.

He wants the engine to act like a bazaar: first use anything already at hand
(embedded track, any shipped subtitle file in any language), then go look on the
free sites on the phone, and only when all of that is empty or unusable, run
whisper. Transcription becomes the **last resort**, not the default.

## Decisions he made (not up for redesign)

1. **Cascade:** found (any language) → translate; else download → translate;
   else, if nothing fits or nothing good → transcribe.
2. **Never any API keys; never any paid service.** Free, keyless sources only.
3. Whatever subtitle is downloaded must be **renamed to the movie's base name**
   ("synced to the first part") so the normal pipeline adopts it.
4. Output stays `Movie.ArabicSubs.ar.ass`, watermark `[ ترجمة الأداة عربي سبس ]`,
   font Thmanyah Sans. All paths — branded, translated, or transcribed — produce
   exactly this.
5. **Scan and list new movies automatically in the background** for as long as
   he has started the engine. Movies dropped in later must just get picked up.
6. `.addstogithignore/` (a bazarr-sync checkout) is local-only reference; it is
   gitignored. It contains no reusable code — it drives a *running Bazarr
   server*, whose sync math (ffsubsync) lives elsewhere. Nothing is copied from
   Bazarr's Python providers either; they were read only to learn the public
   endpoint shapes of the sites below. (Bazarr is GPL — endpoint facts only, own
   implementation.)

## The ladder (final)

For each video, in order; each rung's result is validated before it is kept.

| # | Source | Cost | Notes |
|---|--------|------|-------|
| 0 | Output already exists (`*.ArabicSubs.ar.ass` or legacy `.ar.srt`) | 0 | skip (today's behaviour) |
| 1 | Arabic caption anywhere (sibling file, embedded track, download) | tiny | brand only, no AI |
| 2 | Non-Arabic sibling file (any language) | tiny | translate (today's behaviour) |
| 3 | Embedded text track in the MKV (any language) | seconds (ffmpeg) | extract → treat as rung 1/2 result |
| 4 | Online search (keyless) | ≤ ~3 min budget | download → adopt → treat as rung 1/2 result |
| 5 | Whisper on the audio | 20–40 min | translate (today's ASR path) |
| 6 | Nothing → skip | — | logged reason |

Rationale for 3 before 4: a track inside the file cannot be the wrong release,
needs no network, and takes seconds. Rationale for Arabic-wins-absolutely at
every rung: an Arabic caption (even from the web) means no translation at all.

"Found but bad" is not a stop. Every candidate passes a **fit check** (§ Fit);
a failed candidate is discarded, recorded, and the ladder continues.

## Sources: what is in, what is out, and why

Recon evidence, 2026-10-18: live checks from the build machine and Bazarr's
provider sources at `github.com/morpheus65535/bazarr` (`custom_libs/subliminal_patch/providers/`).

| Source | Type | Verdict | Evidence |
|--------|------|---------|----------|
| embedded tracks | local, any language | **in** | ffmpeg/ffprobe already bundled; Bazarr's `embeddedsubtitles.py` confirms text codecs subrip/ass/webvtt/mov_text; skip image codecs (PGS/VobSub) |
| yifysubtitles.ch | movies, scrape | **in** (highest value) | reachable; `GET /movie-imdb/<ttid>` one page, rows of {language, release, link}; the Shawshank page carried dozens of **Arabic** subs; no key |
| gestdown | TV only | **in** | `api.gestdown.info`, keyless REST: `shows/search/<q>` (verified live) → `subtitles/get/<showId>/<s>/<e>/<lang>` → `downloadUri`; language list includes `ara` |
| podnapisi.net | movies+TV, XML | **in, best-effort, last** | legacy endpoint `…/subtitles/search/old?sXML=1&sK=&sJ=`; unreachable from build machine *and* removed from current Bazarr *and* "ConnectionError" on his own Bazarr → short timeout, expected to fail |
| supersubtitles (= feliratok.eu) | movies+TV | **out** | the Bazarr provider reveals it is the Hungarian feliratok.eu, languages limited to Hungarian+English; low value, high maintenance |
| opensubtitlescom | movies+TV | **out** | needs a free account + API key — violates decision 2 |
| subdl | movies+TV | **out** | needs a free API key — violates decision 2 |
| subf2m.co | movies+TV | deferred | answered 500 from build machine; adapter interface supports adding it later |

IMDb id lookup (only to query yifysubtitles): keyless public endpoint
`v3.sg.media-imdb.com/suggestion/x/<title>.json`. If it fails, skip that source;
never block the ladder on it.

## How a download works (rung 4)

1. **Parse the release name** (`src/providers/query.js`):
   `Hope.2026.1080p.WEBRip.Korean.10Bit.DDP5.1.x265-NeoNoir.mkv` →
   `{ title: "Hope", year: 2026 }`; `Show.S02E05.…` → `{ series, season, episode }`.
   Conservative: title = words before first known tag (year, resolution, codec,
   source, audio); strip `[...]` groups, dots→spaces.
2. **Search, in language order** `ar` → `en` → `es` (config `SUB_FETCH_LANGS`,
   override via env). For each language, query all applicable sources
   concurrently with `Promise.allSettled`, per-request timeout 15 s, per-source
   total cap 45 s, overall fetch budget 180 s. A source hanging or erroring
   never blocks another.
3. **Rank candidates** (deterministic, testable): language priority → exact year
   match → release-group/token overlap with the video name → source order
   (yify, gestdown, podnapisi) → fewer uploader artifacts. Penalise
   forced/signs-only markers in titles/names.
4. **Download top candidate** → unwrap if ZIP/GZIP (`src/unzip.js`, see below) →
   if not already SRT, convert with ffmpeg (`-f srt`) → text re-encode via
   existing `normalizeToUtf8` → parse with existing `validateSRT`.
5. **Fit check** (§ Fit). On pass: write next to the video as
   `<videoBase>.<lang>.srt` — e.g. `Hope.2026.1080p.WEBRip.Korean.10Bit.DDP5.1.x265-NeoNoir.ar.srt`
   — then continue the ladder with it as the source (rung 1 if Arabic, rung 2 if not).
   On fail: discard the bytes, log the reason, try the next candidate.
6. If all sources and candidates fail: proceed to rung 5 (whisper), never error
   out the job.

The saved file is legitimate material: if translation later fails, the next run
picks it up as a plain sibling (no re-download). Arabic files are saved as
`.ar.srt` specifically because the existing sibling scorer already ranks `.ar`
first — the ladder then brands it.

## Embedded tracks (rung 3)

`src/media-tracks.js`, reusing `toolEnv()` and the bundled binaries:

- List: `ffprobe -v error -select_streams s -show_entries stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,default -of json <file>`. Keep text codecs only (`subrip`, `ass`, `ssa`, `mov_text`, `webvtt`); ignore/still-log image codecs.
- Incomplete-track heuristic borrowed from Bazarr: if `NUMBER_OF_FRAMES` tags exist and one track has < ⅓ of the max, drop it (signs/partial tracks).
- Track preference: `language` tag in {`ara`,`ar`} → Arabic rung; else tag in {`eng`,`en`} first, then any; untagged tracks are extracted **and sniffed** with the existing `looksArabic()` ratio (extraction is cheap).
- Extract: `ffmpeg -v error -i <file> -map 0:s:<index> -c:s srt -f srt -` (timeout 120 s, stdout cap 20 MB). Empty/garbage output → next track.
- Extracted text enters the same fit check as everything else.

## Fit check

`src/providers/fit.js`, applied to every non-whisper source (sibling files get
it laxly for backward compatibility — existing behaviour must not regress):

- `validateSRT` passes.
- ≥ 8 cues.
- If the duration is known: last cue end ≤ duration + 90 s (allows trailing
  credits gaps; a 2-hour sub on a 90-minute movie is the wrong release).
- Total visible characters ≥ 300 (kills signs-only/forced-only files).

Failing candidates are discarded with a reason (`too-few-cues`, `out-of-range`,
`signs-only`), logged, and the ladder marches on. Whisper output is exempt (it is
generated against this exact file).

## Provenance — the bazaar is visible

- New log lines (appear in سجل المحرك, which already renders unknown lines):
  - `[Embedded] Hope.mkv → track #2 (kor, subrip) → 940 cues`
  - `[Fetch] Hope.mkv → yifysubtitles: 12 candidates (ar 3, en 9), best: ar "…" ✓ 812 cues`
  - `[Fetch] Hope.mkv → podnapisi: timeout (15s)`
  - `[Fetch] Hope.mkv → nothing usable (23 candidates tried) → whisper`
  - `[Fetch] → saved Hope.2026.….ar.srt (from yifysubtitles)`
- `decisions.jsonl` entries gain: `provider`, `providerId`, `downloadedAs`,
  `sourceLanguage`, `attempts: [{source, outcome, reason}]`, `fit` stats. The
  existing `action` vocabulary is extended, not replaced.
- App: each library item shows its Arabic origin — `مدمج` / `ملف إسباني` /
  `yifysubtitles` / `whisper` — read from the tail of `decisions.jsonl`
  (the app already points `ARABIC_SUBS_LOG` at its own storage). Missing entry →
  no badge. This is a "nice to see" feature: if it fights the plan it is the
  first thing cut, but the *engine* provenance above is required.

## App changes

1. **Auto-refresh while running:** `MainActivity` re-scans folders every 30 s
   while engine status is `running` (silent variant — no scanning spinner, no
   list flicker), so a movie Flud drops mid-run appears and its status flips
   pending → working → done. Manual refresh button stays.
2. **Sources toggle** in إعدادات: «البحث عن ترجمات من الإنترنت» — default ON,
   writes `SUB_FETCH=0/1` into the engine env. Off = ladder skips rung 4
   entirely (offline mode preserved for anyone who wants it).
3. Settings copy explains the ladder in one line.

## Engine changes

- New: `src/providers/{index,query,fit,podnapisi,yifysubtitles,gestdown}.js`,
  `src/unzip.js`, `src/media-tracks.js`.
- Changed: `src/pipeline.js` (ladder), `src/config.js` (budgets, langs,
  `SUB_FETCH`), `bin/arabic-subs.js` (`--no-fetch` flag, `[Fetch]`/`[Embedded]`
  logging, new `fetch <video> [--dry-run]` debug command that prints the ranked
  candidates and their outcomes without adopting anything — this is how he can
  see the bazaar working on the phone).
- `src/unzip.js`: minimal reader — EOCD scan → central directory → stored +
  deflate entries via `zlib.inflateRawSync`; `.gz` via `zlib.gunzipSync`; pick
  the first entry whose name ends `.srt`/`.ass`/`.ssa`/`.vtt`, preferring one
  matching the requested language; loud error on encrypted/zip64.
- No new dependencies (repo rule: zero runtime deps). Plain `fetch` + existing
  `fetchResponse` helper for redirects; per-source User-Agent tuning allowed
  (some sites block `ArabicSubs v…`); response size caps on every read.

## Constraints and conventions

- CJS `require`, existing module style, `toolEnv()` for every ffmpeg/ffprobe
  spawn, `normalizeToUtf8`/`validateSRT`/`looksArabic`/`writeOutput`/`logDecision`
  reused, never duplicated.
- Every network call: 15 s request timeout, capped response size, fail-soft.
- Whisper timeout behaviour, chunking, parallelism from 2.5.2 untouched.
- Version 2.6.0 (versionCode 19), CHANGELOG, README ladder section,
  docs/index.html, app badge — same release flow as 2.5.x, CI is the gate.

## Goals

1. A downloaded-or-embedded subtitle replaces transcription whenever it exists
   and fits, on any language.
2. The whole bazaar is visible in the log and the decisions file.
3. New movies are picked up and listed automatically while the engine runs.
4. Zero keys, zero paid services, zero new dependencies.

## Non-goals

- Timing sync / framerate repair of downloaded subtitles (needs
  ffsubsync/alass, not shippable here; a *global offset* fix is a possible
  later feature, not this one).
- TV support beyond files that carry `SxxExx` in the name (gestdown needs the
  episode number to ask).
- Anything requiring an account, a key, or a paid tier.
- A pick-a-subtitle UI. The bazaar is automatic; `fetch --dry-run` is the
  only browsing surface.
- Changes to translation quality or the ASS template.

## Anti-goals

- Slowing the fast paths: an existing sibling Arabic sub must still finish in
  seconds with zero network traffic.
- Blocking the queue: no network attempt may hold a job hostage; worst case
  adds ~3 minutes before whisper.
- Silent fallbacks: every attempted source logs its outcome.
- Adopting garbage: no file is kept unless it passes the fit check.

## Risks

- Sites change HTML or block datacenter/mobile IPs → adapters fail-soft; the
  ladder still ends at whisper. `fetch --dry-run` turns "it found nothing" into
  a diagnosable log line.
- IMDb suggestion endpoint shape changes → yifysubtitles source simply skips.
- Wrong-release downloads that still pass the fit check (timings roughly match,
  dialogue wrong) → mitigated by year + release-token ranking; the user can
  delete a bad `.ar.srt` if they ever see one.

## Left to the builder

- Exact HTML/JSON selectors per source (record a fixture from the live page and
  pin the parser to it), including yifysubtitles' download-link pattern.
- UA strings per source; whether a session/cookie warm-up is needed.
- Zip fixture strategy for tests (generate in-test with `deflateRawSync`).
- Kotlin badge styling and the precise auto-refresh plumbing.

## Verification

- Offline: unit tests for query parsing, ranking, fit check, unzip, embedded
  track listing (stub ffprobe JSON), gestdown/yify/podnapisi parsers against
  recorded fixtures, ladder order with stubbed providers, `--no-fetch` and
  `SUB_FETCH=0`.
- On-device (his): `arabic-subs fetch "<movie>" --dry-run` prints the ranked
  candidates; then a full run shows `[Fetch]` or `[Embedded]` before translate
  instead of `[ASR]`; a movie dropped into the folder mid-run appears in the
  list and gets done; a network-off run with the toggle on falls back to
  whisper after the fetch budget.
