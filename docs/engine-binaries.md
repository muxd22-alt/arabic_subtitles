# Bundled engine binaries (arm64)

The four executables in `app/src/main/jniLibs/arm64-v8a/` are committed to the
repository (not fetched at build time) and packaged by AGP as `arm64-v8a` native
libraries. Android executes them straight from `nativeLibraryDir`; they are named
`lib*.so` only because that is what the APK's `lib/` tree and `EngineEnv.kt`
expect. The file *is* the standalone executable.

The names are a hard contract with `EngineEnv.base()`
(`app/src/main/java/com/arabicsubs/engine/EngineEnv.kt:23-26`) and
`EnginePaths.TOOL_NAMES`.

| Committed file | `DT_NEEDED` (observed) |
| :--- | :--- |
| `libllama-server.so` | `libm.so`, `libdl.so`, `libc.so` |
| `libwhisper-cli.so` | `libm.so`, `libdl.so`, `libc.so` |
| `libffmpeg.so` | `libm.so`, `libandroid.so`, `libcamera2ndk.so`, `libmediandk.so`, `libz.so`, `libdl.so`, `libc.so` |
| `libffprobe.so` | `libm.so`, `libandroid.so`, `libcamera2ndk.so`, `libmediandk.so`, `libz.so`, `libdl.so`, `libc.so` |

All four are ELF64, little-endian, `e_machine = 0xB7` (AArch64), `e_type = 3`
(ET_DYN / PIE), with every `PT_LOAD` `p_align = 0x4000` (16 KB pages, Android
15+). Verified by `scripts/verify-engine-libs.mjs`.

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

## Verification

- Structural (this repo / CI): `node scripts/verify-engine-libs.mjs` parses the
  ELF headers and dynamic tables and asserts architecture, PIE type, 16 KB
  alignment, and that every `DT_NEEDED` soname resolves to a sibling file or the
  Android allowlist in that script.
- Packaging (CI): the workflow asserts `app-debug.apk` contains all four
  `lib/arm64-v8a/lib*.so` entries.
- **On-device execution is NOT verified here.** This machine is x64 Windows and
  CI is x64 Ubuntu, so the arm64 binaries cannot be run. Actually launching them
  (llama-server serving a model, whisper-cli transcribing, ffmpeg/ffprobe
  probing) remains an outstanding manual check on a real arm64 Android device.
