# Bundled engine binaries (arm64)

Everything in `app/src/main/jniLibs/arm64-v8a/` is committed to the repository
(not fetched at build time) and packaged by AGP as `arm64-v8a` native libraries.
Android executes the four tool binaries straight from `nativeLibraryDir`; they
are named `lib*.so` only because that is what the APK's `lib/` tree and
`EngineEnv.kt` expect. The file *is* the standalone executable. `libnode.so` is
the Node runtime (the Termux `node` executable, renamed) and the remaining
`lib*.so` are its runtime dependencies.

The names are a hard contract with `EngineEnv.base()`
(`app/src/main/java/com/arabicsubs/engine/EngineEnv.kt:23-27`) and
`EnginePaths.TOOL_NAMES`.

| Committed file | `DT_NEEDED` (observed) |
| :--- | :--- |
| `libllama-server.so` | `libm.so`, `libdl.so`, `libc.so` |
| `libwhisper-cli.so` | `libm.so`, `libdl.so`, `libc.so` |
| `libffmpeg.so` | `libm.so`, `libandroid.so`, `libcamera2ndk.so`, `libmediandk.so`, `libz.so`, `libdl.so`, `libc.so` |
| `libffprobe.so` | `libm.so`, `libandroid.so`, `libcamera2ndk.so`, `libmediandk.so`, `libz.so`, `libdl.so`, `libc.so` |
| `libnode.so` | `libz.so`, `libcares.so`, `libsqlite3.so`, `libcrypto.so`, `libssl.so`, `libicui18n.so`, `libicuuc.so`, `libc++_shared.so`, `libc.so`, `libm.so`, `libdl.so` |
| `libicuuc.so` | `libicudata.so`, `libc++_shared.so`, `libc.so`, `libm.so`, `libdl.so` |
| `libicui18n.so` | `libicuuc.so`, `libc++_shared.so`, `libc.so`, `libm.so`, `libdl.so` |
| `libicudata.so` | (none) |
| `libcrypto.so` | `libdl.so`, `libc.so` |
| `libssl.so` | `libcrypto.so`, `libc.so` |
| `libsqlite3.so` | `libz.so`, `libm.so`, `libdl.so`, `libc.so` |
| `libcares.so` | `libc.so` |
| `libc++_shared.so` | `libc.so`, `libm.so`, `libdl.so` |
| `libz.so` | `libc.so` |

Every file is ELF64, little-endian, `e_machine = 0xB7` (AArch64), `e_type = 3`
(ET_DYN / PIE). All 14 files have every `PT_LOAD` `p_align = 0x4000` (16 KB
pages, Android 15+); the four tool binaries are **hard-checked** for this, the
Termux-sourced files are **warn-checked** (see the alignment caveat below).
Verified by `scripts/verify-engine-libs.mjs`.

## Provenance

| Committed file | Source | Version | sha256 (of committed bytes) | Size | License |
| :--- | :--- | :--- | :--- | ---: | :--- |
| `libllama-server.so` | `arabic-subs-engine-android-arm64.zip` (asset `v2.2`) → entry `llama-server` | sjl623/llama.cpp STQ @ `1e411d8` (PR #22836), NDK r28c | `0b92d8969295295ec237004e42256816156d011b0d6ad8e1c873f6df4ffce46a` | 20 677 104 | MIT |
| `libwhisper-cli.so` | same zip → entry `whisper-cli` | ggml-org/whisper.cpp (master), NDK r28c | `2d329427c51d92d982f0edbba7956776939c74eebfd2071ab2ec578ff91634a0` | 2 170 344 | MIT |
| `libffmpeg.so` | `hzw1199/Android-FFmpeg-Prebuilt` `ffmpeg-9.0/bin/ffmpeg` | FFmpeg 9.0, arm64-v8a, NDK r28 | `9085507b0dc32643b4d6d084a7e7d3469ef17907a7ba15c22d3997ed09c932aa` | 15 713 352 | LGPL-2.1-or-later |
| `libffprobe.so` | `hzw1199/Android-FFmpeg-Prebuilt` `ffmpeg-9.0/bin/ffprobe` | FFmpeg 9.0, arm64-v8a, NDK r28 | `d8e929fcb2b3b5a1a7c8dc234f6d98834eaf8ff2ce408a85060a470b243e0bb5` | 15 546 464 | LGPL-2.1-or-later |

Exact source URLs:

- `https://github.com/muxd22-alt/arabic_subtitles/releases/download/v2.2/arabic-subs-engine-android-arm64.zip`
  (zip sha256 `42585d0b08b9156f28f06f9571f978b4d7fb1cba6f3763d7d37663b979e0756c`)
- `https://raw.githubusercontent.com/hzw1199/Android-FFmpeg-Prebuilt/main/ffmpeg-9.0/bin/ffmpeg`
- `https://raw.githubusercontent.com/hzw1199/Android-FFmpeg-Prebuilt/main/ffmpeg-9.0/bin/ffprobe`

The llama/whisper entries were taken out of the zip unchanged; only the file name
changed, so their committed sha256 equals the upstream entry's sha256. The
ffmpeg/ffprobe bytes are likewise the raw upstream files, renamed only (their
sizes match the upstream 15 713 352 / 15 546 464 exactly).

Notes:

- llama-server and whisper-cli are statically linked (`static libc++`,
  `GGML_OPENMP=OFF`) — the `libc/libm/libdl` triple is the whole dependency set,
  and the zip carries no external `.so`.
- The ffmpeg/ffprobe build is `--disable-gpl --disable-nonfree` (pure LGPL) and
  `--enable-small -Os`. It links the Android media/camera NDK libs
  (`libandroid.so`, `libcamera2ndk.so`, `libmediandk.so`), all system libraries
  available on API 28+.
- ffmpeg 9.0 targets **minSdk 28**, which is why `app/build.gradle.kts` pins
  `minSdk = 28` (Android 9.0+).

## Node runtime and Termux libraries (Task 11b)

`libnode.so` and its nine Termux runtime libraries were extracted from pinned
Termux packages by the committed, reproducible script
`scripts/fetch-node-libs.mjs` (it downloads each `.deb`, verifies its sha256,
unwraps the `ar` container, extracts `data.tar.xz`, and writes the patched
shared objects). Node is **24 LTS** (`nodejs-lts 24.18.0-1`), not the unsupported
`nodejs` 26 package.

| Committed file | Size (bytes) | sha256 (committed bytes) | Termux package | License |
| :--- | ---: | :--- | :--- | :--- |
| `libnode.so` | 45 318 136 | `9674209f8b43cffd166e3466a0ef63cfc3187b8fd197866c471a959e046a494d` | `nodejs-lts 24.18.0-1` (`usr/bin/node`) | MIT |
| `libicudata.so` | 33 108 832 | `a11249b24fb9f02b1026cc2d79c50c747ec3c898f102b1a2aa36e9826af8673d` | `libicu 78.3` | Unicode-3.0 |
| `libicui18n.so` | 3 358 568 | `a11b66a30dd88ec4c4dd7bbcfea0ffb4eb2188150b9a8a5c68eff730242abf5d` | `libicu 78.3` | Unicode-3.0 |
| `libicuuc.so` | 2 029 568 | `81b42561fc18cebe756b36bdaa6418be90bad1f2c2fc5f87b3c7f552cce1b18c` | `libicu 78.3` | Unicode-3.0 |
| `libcrypto.so` | 5 213 680 | `b9f1badc1fcf7337dececd3c6868fdf74cd99982ae0725cb7e639b74b7b70bc5` | `openssl 3.6.5` | Apache-2.0 |
| `libssl.so` | 880 976 | `7a05fcde37917d22037c6fb848555edb9dddcf82a3766cfa85d495729d8291ee` | `openssl 3.6.5` | Apache-2.0 |
| `libsqlite3.so` | 1 224 400 | `3f89d2713bb56cbc52cd5f2f64bef22f134b2130b6384998d7af0a28c004d828` | `libsqlite 3.54.1` | public-domain |
| `libc++_shared.so` | 1 423 696 | `05bef9d3901910c3ff8ab450b03bc8b28383d363a2290f2f7b9aed7331ea6ff7` | `libc++ 30` | Apache-2.0-with-LLVM-exception |
| `libcares.so` | 256 776 | `68733ce8d4bb1bdc87d8ec550c58c70f3dcdb0f8c48d86b83235f536cb736e83` | `c-ares 1.34.8` | MIT |
| `libz.so` | 72 880 | `22ac211cb02eec6ac8d408fb7d3539654e92647bbc1bc2e23a9b62f0d8625008` | `zlib 1.3.2` | zlib |

Exactly 92 887 512 bytes (88.6 MB) were added; `jniLibs/arm64-v8a/` now holds
146 994 776 bytes (~140 MB).

### Pinned sources

Base `https://packages.termux.dev/apt/termux-main/pool/main/`; each `.deb`'s
sha256 is re-verified on every run of `scripts/fetch-node-libs.mjs`:

| Package | Path under base | sha256 of `.deb` |
| :--- | :--- | :--- |
| `nodejs-lts 24.18.0-1` | `n/nodejs-lts/nodejs-lts_24.18.0-1_aarch64.deb` | `490f4d08c45b25a7ea7db6ee466ebb3ee61f07083260b85332704ed018f59a87` |
| `libc++ 30` | `libc/libc++/libc++_30_aarch64.deb` | `53d0b84a7ba7459024257cb94d5b136fe13ef858567f65a8064b35950799f2ca` |
| `libicu 78.3` | `libi/libicu/libicu_78.3_aarch64.deb` | `f536403f65a08fe0df6e7304184e902d54def77d5c3bd5edfd9109d57601d276` |
| `openssl 3.6.5` | `o/openssl/openssl_1:3.6.5_aarch64.deb` | `a2fb7856875e63ef6b90442752e05974813372c3ca86d2513a78ea43c67a0f8b` |
| `c-ares 1.34.8` | `c/c-ares/c-ares_1.34.8_aarch64.deb` | `7681fc23e822d7988ba8b2adf3468f93ae68f724dda365cff1385096a9fa87e6` |
| `libsqlite 3.54.1` | `libs/libsqlite/libsqlite_3.54.1_aarch64.deb` | `0856cac8cc87f6e112f2eef4fcac6ad5cb08209ecb7cc260f997874fc186a3c0` |
| `zlib 1.3.2` | `z/zlib/zlib_1.3.2_aarch64.deb` | `75e7d0af17fcc3b40004309fdc00a1ddb9ae08346dce5e269902c34ac3966ac9` |

(No `libffi`: `nodejs-lts 24.18.0-1` declares `Depends: libc++, openssl,
c-ares, libicu, libsqlite, zlib` and node's `DT_NEEDED` closure never references
it, so the package is not downloaded or bundled.)

### Why the sonames were shortened (packaging path)

Android's package manager extracts a native library into `nativeLibraryDir` only
when its file name both starts with `lib` and ends with `.so` (AOSP
`NativeLibraryHelper.cpp`, `NativeLibrariesIterator`). Because the engine
binaries are launched as separate processes, the app must keep
`packaging { jniLibs { useLegacyPackaging = true } }` — the libs have to be
extracted to disk, they cannot be loaded from inside the APK. A versioned soname
such as `libicuuc.so.78` therefore never reaches `nativeLibraryDir`.

The **in-place soname-shortening** fallback from the brief was taken. For each
Termux library the `DT_SONAME` and every matching `DT_NEEDED` string in `.dynstr`
were rewritten to the plain `lib<name>.so` form (the replacement is shorter, so
it fits and is NUL-terminated; no offsets move) and the file was renamed to the
plain name. Concretely:

- `libicuuc.so.78` → `libicuuc.so`, `libicui18n.so.78` → `libicui18n.so`,
  `libicudata.so.78` → `libicudata.so`
- `libssl.so.3` → `libssl.so`, `libcrypto.so.3` → `libcrypto.so`
- `libz.so.1` → `libz.so`

and the corresponding `DT_NEEDED` references in `libnode.so` (five),
`libssl.so` (one), `libsqlite3.so` (one), `libicuuc.so` (one) and
`libicui18n.so` (one) were rewritten to match. The committed bytes are the
**already-patched** files, so the repo bytes
are exactly what CI/AGP packages. `libcares.so`, `libc++_shared.so` and
`libsqlite3.so` already used plain names and were only copied (so their sha256
equals upstream); libsqlite3's `DT_NEEDED libz.so.1` was still rewritten.

Note the app's own `nativeLibraryDir` is first on the dynamic-linker search path,
so the bundled `libcrypto.so` / `libssl.so` / `libz.so` shadow the identically
named Android system libraries (Android's `libcrypto`/`libssl` are BoringSSL, a
different ABI from OpenSSL 3). **That shadowing is a real failure, not a
theoretical one** — see below.

### Soname shadowing: why tool processes run without `nativeLibraryDir` on the path

`libnode.so` genuinely needs its siblings, so the app starts the engine with
`LD_LIBRARY_PATH=<nativeLibraryDir>` (`EngineEnv.base()`). Children inherit it,
and ffmpeg died on the first real device because of that:

```
CANNOT LINK EXECUTABLE .../lib/arm64/libffmpeg.so: cannot locate symbol
"EVP_MD_CTX_init" referenced by /system/lib64/libsqlite.so
```

The chain: `libffmpeg.so`'s `DT_NEEDED libmediandk.so` / `libcamera2ndk.so` pull
in the Android media/binder stack, which loads the *system*
`/system/lib64/libsqlite.so`; bionic then resolved that library's `DT_NEEDED
"libcrypto.so"` to **our** OpenSSL 3.x (same soname, found first on
`LD_LIBRARY_PATH`) instead of the system BoringSSL. OpenSSL 3.0 dropped the
deprecated `EVP_MD_CTX_init` symbol, so the exec aborted before ffmpeg ran.

The fix keeps the naming (renaming our OpenSSL would mean patching `DT_NEEDED`
inside the 45 MB `libnode.so`) and instead **strips the tool's own directory from
the search path** for the four tool binaries — `toolEnv()` in
`src/binaries.js`, used by every tool spawn (`audio.runResult`, `llama.js`,
`srt.js`). This is sound precisely because the four tools have **no `SONAME` and
no `RUNPATH`** and their entire `DT_NEEDED` list is Android system libraries, so
they never need a sibling; `scripts/verify-engine-libs.mjs` now enforces that
invariant and prints the shadowing sonames it knowingly ships.

The deeper (not yet taken) alternative is a leaner ffmpeg build without
`--enable-libcamera`/media-NDK support, which would remove `libcamera2ndk.so` /
`libmediandk.so` — and with them the media stack — from the process entirely.

### 16 KB alignment caveat

All ten Termux-sourced files happened to be `PT_LOAD p_align = 0x4000` (16 KB) at
the pinned versions above, so they satisfy 16 KB-page devices today. Termux does
not *promise* 16 KB alignment, so `scripts/verify-engine-libs.mjs` hard-fails
only for the four tool binaries we control and prints a prominent `WARN` (without
failing) if a Termux-sourced file is below `0x4000`. A future re-fetch from
Termux that regresses alignment must be handled there (e.g. by an explicit ELF
`p_align` bump) rather than silently.

## Verification

- Structural (this repo / CI): `node scripts/verify-engine-libs.mjs` parses the
  ELF headers and dynamic tables and asserts architecture, PIE type, 16 KB
  alignment, and that every `DT_NEEDED` soname resolves to a sibling file or the
  Android allowlist in that script.
- Packaging (CI): the workflow runs `node scripts/verify-engine-libs.mjs
  --closure` and asserts `app-debug.apk` contains **every** library in that set
  (all 14 committed `lib/arm64-v8a/lib*.so` entries, including `libnode.so` and
  its whole bundled dependency closure) — this is what catches AGP dropping or
  mangling a name.
- **On-device execution is NOT verified here.** This machine is x64 Windows and
  CI is x64 Ubuntu, so the arm64 binaries cannot be run. Actually launching them
  (Node starting the engine from `libnode.so`, llama-server serving a model,
  whisper-cli transcribing, ffmpeg/ffprobe probing) remains an outstanding
  manual check on a real arm64 Android device.
- The `libcrypto`/`libssl`/`libz` shadowing of the system libraries **failed on
  the first real device** (`EVP_MD_CTX_init` referenced by
  `/system/lib64/libsqlite.so`) and is fixed as described above: tool processes
  no longer see `nativeLibraryDir` on `LD_LIBRARY_PATH`. The static side of that
  fix is CI-enforced (tools must depend on system libraries only), but the
  runtime side — ffmpeg/ffprobe actually linking and probing — can only be
  confirmed on a device.
