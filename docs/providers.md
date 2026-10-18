# The subtitle bazaar

Before the engine transcribes anything, it looks for a subtitle that **already
exists** — because a real subtitle is better than an ASR transcript and costs a
fraction of the time. This page documents the stalls, how they are ranked, and
what happens when one of them is down.

```
existing output            → skip (idempotent)
Arabic sidecar in the folder → brand it (watermark + Thmanyah Sans), no model
other-language sidecar     → translate it
subtitle track inside the file → extract it, brand or translate
the bazaar (free providers)→ download, save as a sidecar, brand or translate
no subtitle anywhere, audio → whisper transcription (last resort)
neither                    → skip, with the reason logged
```

Arabic found at **any** step is used as-is: the brand identity does not need a
model at all. Everything else becomes the translation source.

## The stalls

| Priority | Provider | Kind | Covers | Key needed |
| :--: | :--- | :--- | :--- | :--- |
| 0 | `embeddedsubtitles` | local (ffprobe/ffmpeg) | movies + series | — |
| 2 | `gestdown` | JSON API (Addic7ed library) | series only | — |
| 3 | `subf2m` | HTML | movies, some series | — |
| 4 | `yifysubtitles` | HTML + zip | movies only | — |
| 5 | `supersubtitles` (feliratok.eu) | HTML | movies + series | — |
| 6 | `podnapisi` | legacy XML | movies + series | — |
| 7 | `subdl` | JSON API | movies + series | `SUBDL_API_KEY` (free) |
| 8 | `opensubtitlescom` | JSON API | movies + series | `OPENSUBTITLES_API_KEY` + `OPENSUBTITLES_USERNAME`/`PASSWORD` (free tier) |

Everything keyless is used out of the box. The key-based stalls are simply
reported as **`Not configured`** until their free key is added to `.env` — a
missing key is never a failure and never affects the other providers.

### What each one wants

- **`gestdown`** — `GET api.gestdown.info/shows/search/<title>`, then
  `GET /subtitles/get/<showId>/<season>/<episode>/<language>` with the full
  lowercase language name. Downloads are plain SRT. Arabic is requested but many
  shows only carry English.
- **`subf2m`** — `GET subf2m.co/subtitles/<slug>` (the slug is the plain
  title; a `<slug>-<year>` variant is tried for remakes). The title page lists
  the language tabs, the language page lists the versions, and the details page
  finally holds the `/download` link. The download is sent with the details page
  as `Referer`.
- **`yifysubtitles`** — an IMDb id is resolved first (below), then the whole
  per-movie page is read: `<tr data-id=…>` rows whose language sits in
  `<span class="sub-lang">`. Downloads are zips and **only** work with the
  details page as `Referer` (without it Cloudflare answers 403). The site's own
  search box is client-side JavaScript, which is why the id matters.
- **`supersubtitles`** — `feliratok.eu/index.php?search=<title>`. Rows carry a
  direct `action=letolt` link; the file name already contains the language
  token. Languages are labelled in Hungarian (`Angol`, `Magyar`, `Arab`, …) and
  are translated before ranking.
- **`podnapisi`** — the legacy XML API
  (`/subtitles/search/old?sXML=1&sK=<title>`), downloads as a zip. Some
  networks cannot resolve `podnapisi.net` at all; that shows up as
  `ConnectionError` with a cooldown, exactly like in Bazarr.
- **`subdl`** — `api.subdl.com/api/v1/subtitles` with `film_name`/`tv_name`.
  Files come from `dl.subdl.com`. The free key lives under the profile page.
- **`opensubtitlescom`** — `api.opensubtitles.com/api/v1/subtitles` (JSON). A
  download needs a login token from `/login`, then `POST /download {file_id}`
  returns a one-time link; the free tier has a small daily quota.

### The free IMDb lookup

`yifysubtitles`, `subdl` and `opensubtitlescom` are far more accurate when asked
by IMDb id. The engine resolves it through IMDb's own public suggestion endpoint
(`v3.sg.media-imdb.com/suggestion/x/<title>.json`) — no key, no account — and
caches the answer in `~/.arabic-subs/imdb-cache.json`, so a title is looked up
once, ever. An id found in an `.nfo` next to the video always wins.

Set `PROVIDER_RESOLVE_IMDB=0` to turn the lookup off.

## Ranking, when several stalls offer something

1. **Arabic** first — it is the goal, and it needs no model.
2. The `PROVIDER_LANGUAGES` order (default `ar,en,es`) — English translates
   better with Hy-MT2 than the more exotic choices.
3. Release-name similarity to the actual file (`Inception.2010.1080p.BluRay…`),
   with a bonus for the right year.
4. The provider's own signals: rating, download counts, corrected/HD flags, and
   the stall order from the table above.

Wrong-movie protection is built in: a candidate whose name carries a **different
year** than the release is dropped, fuzzy search rows for other films are
filtered by title similarity, and series candidates must mention the right
`SxxExx`. The engine downloads **one** candidate at a time and stops at the
first that really parses as a subtitle (SRT, ASS/SSA, VTT — plain, zipped,
gzipped, tarred or, on systems that have `unrar`/`7z`, RAR).

## Health, cooldowns and the table

Every provider has a small state entry in `~/.arabic-subs/providers.json`:

| Status | Meaning |
| :--- | :--- |
| `Good` | the last call answered |
| `ConnectionError` | the last call threw; a retry is scheduled |
| `Not configured` | needs a key (or the tool, for embedded tracks) |
| `Disabled` | switched off |

A failure puts the stall on a cooldown that **doubles** with every consecutive
failure — 1, 2, 4, 8, 16, 32, 60 minutes — and a success resets it to zero. A
provider in cooldown is *skipped*, not failed, so the rest of the library keeps
moving and `arabic-subs providers` shows something like:

```
Name                Status              Next Retry
podnapisi           ConnectionError     in 8 minutes
subdl               Not configured      -
```

```bash
arabic-subs providers              # the table
arabic-subs providers --reset      # forget all health state
arabic-subs providers --reset subf2m
```

## What gets written to disk

Whatever a provider hands back is saved next to the video with the **same name
the local scan already reads**, so the next run is offline and the user can see
(and edit) exactly what was fetched:

```
Movie.2020.1080p.mkv          the video
Movie.2020.1080p.ar.srt       the downloaded/extracted source (Arabic → brand)
Movie.2020.1080p.en.subf2m.srt  a second copy from a different provider
Movie.2020.1080p.ArabicSubs.ar.ass  the branded output (the engine's own)
```

The engine's own `.ArabicSubs.ar.ass` output is never re-consumed as a source.

## Commands

```bash
arabic-subs fetch "Inception.2010.1080p.BluRay.mkv"            # what every provider has
arabic-subs fetch movie.mkv --download --provider yifysubtitles
arabic-subs scan /media/Movies --search                        # plan + what the bazaar offers
arabic-subs run --media /media/Movies --once                   # one full pass, then exit
arabic-subs run --media /media/Movies --no-providers           # keep it offline
```

## Configuration

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `ARABIC_SUBS_PROVIDERS` | `1` | `0` disables the whole bazaar (local sidecars + whisper only) |
| `PROVIDER_LANGUAGES` | `ar,en,es` | languages to ask for, in order |
| `PROVIDER_TIMEOUT_MS` | `15000` | per-provider search timeout |
| `PROVIDER_MAX_TRIES` | `6` | downloads attempted per video |
| `PROVIDER_RESOLVE_IMDB` | `1` | `0` disables the free IMDb lookup |
| `SUBDL_API_KEY` | — | free key from subdl.com |
| `OPENSUBTITLES_API_KEY` | — | free key from opensubtitles.com |
| `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` | — | free account, needed for downloads |
| `PROVIDER_EMBEDDED` | `1` | `0` never reads tracks inside the file |

## Notes for maintainers

- Everything is dependency-free: the scrapers are regular expressions over the
  pages the sites actually serve today, plus a tiny HTML helper
  (`src/scrape.js`). If a stall changes its markup, only its parser fixture and
  regex need to change — the ranking, health and archive layers are shared.
- The whole provider layer is injectable for tests: `net.setFetchImpl(fake)` for
  HTTP, `options.bazaar` for the pipeline. `test/bazaar.test.js` covers the
  parsers, the ranking, the backoff, the Windows-1256 decoding and the save
  path with **no network access at all**.
- `scripts/provider-smoke.mjs` is the opposite: it really talks to the sites and
  prints what each one returns for a handful of well-known titles. Run it (with
  network) after touching a parser.
