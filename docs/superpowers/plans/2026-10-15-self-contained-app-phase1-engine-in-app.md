# Phase 1 — Engine in the app (no Termux) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app carries its own Node engine and native tools and runs them itself, replacing the Termux remote-control path entirely.

**Architecture:** The prebuilt arm64 tools (`llama-server`, `whisper-cli`, `ffmpeg`, `ffprobe`, `node`) ship inside the APK as `jniLibs`, so Android extracts them into the app's native library directory where they can legally execute. The existing Node engine (`bin/arabic-subs.js` and `src/*.js`) ships as an asset, is unpacked to app-private storage, and is launched as a child process by a foreground service. The engine keeps its current status server, so the UI keeps polling `127.0.0.1:18435`. All heavy data (the models) is downloaded once into `<media>/ArabicSubs/models/`.

**Tech Stack:** Kotlin + Jetpack Compose (existing), Android foreground service, `ProcessBuilder`, Node.js (prebuilt arm64 binary), llama.cpp / whisper.cpp / ffmpeg (prebuilt arm64), Gradle KTS.

**Spec:** `docs/superpowers/specs/2026-10-15-self-contained-app-design.md`

## Global Constraints

- ABI: `arm64-v8a` only. `minSdk = 26` (do not raise without recording why).
- The engine is the existing Node code; do not reimplement any of it in Kotlin.
- Executables must live in the APK's native library dir; never download-and-execute a program.
- Models live in `<media>/ArabicSubs/models/`; the home dir is `<media>/ArabicSubs/`.
- Default model flavour `q4_k_m` → file `Hy-MT2-1.8B-Q4_K_M.gguf`, exact `1133080448` bytes.
- Default whisper model `base` → file `ggml-base.bin`.
- Output suffix stays `.ArabicSubs.ar.srt`.
- Permission: `MANAGE_EXTERNAL_STORAGE` ("All files access"); sideloaded app only.
- Nothing is compiled on the phone.
- The app's file access uses real filesystem paths, never SAF URIs, for anything handed to the engine.

## Review Focus

These are the failure modes the spec implies but no task's unit tests naturally cover; each owning task pins one with a test or an explicit manual check.

1. Media paths that contain spaces or Arabic (non-ASCII) characters — argv must never be built by string-joining or shell-splitting. (Task 5 test.)
2. "All files access" granted, then revoked, then the run starts — the engine must fail with a readable state, not a crash. (Task 9 manual check.)
3. A partially-extracted native library (killed mid-install) — the launch layer must detect a missing tool and say so. (Task 2 test.)
4. Non-primary storage (SD card path) chosen — must be detected and refused with a message, not silently produce no work. (Task 2 test.)
5. The engine writes its temp WAVs under shared storage, which is `noexec`; that is fine for data but must be on a path ffmpeg can write. (Task 4 test asserts the temp dir is under the home dir.)

---

## Phase roadmap

This is plan 1 of 3. It ships "Termux is gone, the app runs its own engine."

- **Phase 2 — the library experience:** multi-folder, real-path scan including loose root files, movie rows with sizes and states, per-movie run. (separate plan)
- **Phase 3 — speed and fidelity:** the 1–4 selector wired to translation parallelism and llama slots, in-app progress bar + ETA (app and notification), and embedded subtitle-track extraction in the Node pipeline. (separate plan)

## File Structure

Created in this phase:

- `app/src/main/java/com/arabicsubs/engine/EnginePaths.kt` — where the tools and JS live; refuses unsupported storage.
- `app/src/main/java/com/arabicsubs/engine/EngineAssets.kt` — unpacks bundled JS to app storage.
- `app/src/main/java/com/arabicsubs/engine/EngineEnv.kt` — the environment handed to Node.
- `app/src/main/java/com/arabicsubs/engine/EngineCommand.kt` — argv for `run` / `setup`.
- `app/src/main/java/com/arabicsubs/engine/EngineOutput.kt` — parses engine stderr into events.
- `app/src/main/java/com/arabicsubs/engine/EngineService.kt` — foreground service owning the Node process.
- `app/src/main/java/com/arabicsubs/storage/AllFilesAccess.kt` — permission check + settings intent.
- `app/src/test/java/com/arabicsubs/engine/*.kt` — JVM unit tests for the above.
- `app/src/main/assets/node/**` — generated copy of `bin/`, `src/`, `package.json` (not committed; built).
- `app/src/main/jniLibs/arm64-v8a/*.so` — populated by CI (not committed).

Modified in this phase:

- `app/build.gradle.kts` — jniLibs packaging, `syncNodeSources` task.
- `app/src/main/AndroidManifest.xml` — permissions, service, remove Termux.
- `app/src/main/java/com/arabicsubs/ui/MainActivity.kt` — run the service instead of Termux; drop copy-command UI.
- `app/src/main/java/com/arabicsubs/ui/SetupWizard.kt` — access → folder → model steps.
- `.github/workflows/android-build.yml` — stage the tools into `jniLibs` before assembling.
- `scripts/fetch-engine.sh` — local/CI downloader for the tools.

---

### Task 1: Bundle the tools and Node sources into the APK

**Files:**
- Modify: `app/build.gradle.kts`
- Create: `scripts/fetch-engine.sh`
- Modify: `.github/workflows/android-build.yml`

**Interfaces:**
- Produces: `app/src/main/jniLibs/arm64-v8a/` containing `libllama-server.so`, `libwhisper-cli.so`, `libffmpeg.so`, `libffprobe.so`, `libnode.so`; `app/src/main/assets/node/` containing `bin/`, `src/`, `package.json`.

- [ ] **Step 1: Add a Gradle task that copies the Node sources into assets**

In `app/build.gradle.kts`, register a `Copy` task from the repo root's `bin/`, `src/` and `package.json` into `src/main/assets/node/`, and make `preBuild` depend on it:

```kotlin
val syncNodeSources by tasks.registering(Copy::class) {
    from(rootProject.file("bin")) { into("bin") }
    from(rootProject.file("src")) { into("src") }
    from(rootProject.file("package.json"))
    into(layout.projectDirectory.dir("src/main/assets/node"))
}
tasks.named("preBuild") { dependsOn(syncNodeSources) }
```

- [ ] **Step 2: Turn on legacy native packaging**

In the `android { }` block add:

```kotlin
packaging {
    jniLibs { useLegacyPackaging = true }
}
```

This keeps the `.so` files extracted on disk (required for executing them) on all supported API levels.

- [ ] **Step 3: Write the fetcher script**

`scripts/fetch-engine.sh` downloads one pinned engine asset and unzips the tools into `app/src/main/jniLibs/arm64-v8a/`, renaming each to a `lib*.so` name. Header pins the exact URLs and sha256 values. It is idempotent (skips a file that already matches its sha256).

- [ ] **Step 4: Call it from CI before the build**

In `.github/workflows/android-build.yml`, add a step before the Gradle assemble step: `bash scripts/fetch-engine.sh` with `GH_TOKEN` so the private engine asset can be fetched. The APK is built with the tools already in `jniLibs`.

- [ ] **Step 5: Verify the build contains everything**

Run: `bash scripts/fetch-engine.sh && ./gradlew :app:assembleDebug`
Then: `unzip -l app/build/outputs/apk/debug/app-debug.apk | Select-String "lib/(arm64-v8a|node)"`
Expected: five `lib*.so` entries and the `assets/node/...` tree.

- [ ] **Step 6: Commit**

```bash
git add app/build.gradle.kts scripts/fetch-engine.sh .github/workflows/android-build.yml
git commit -m "build: bundle engine tools and node sources into the apk"
```

---

### Task 2: Locate the tools and refuse unusable storage

**Files:**
- Create: `app/src/main/java/com/arabicsubs/engine/EnginePaths.kt`
- Test: `app/src/test/java/com/arabicsubs/engine/EnginePathsTest.kt`

**Interfaces:**
- Produces: `object EnginePaths { fun tool(context: Context, name: String): String; fun missingTools(context: Context): List<String>; fun homeFor(mediaPath: String): String; fun isSupportedMediaPath(path: String): Boolean }` where `name` is one of `llama-server`, `whisper-cli`, `ffmpeg`, `ffprobe`, `node`.

- [ ] **Step 1: Write the failing test**

```kotlin
class EnginePathsTest {
    @Test fun reports_tools_missing_from_native_dir() {
        val dir = Files.createTempDirectory("nat").toFile()
        File(dir, "libffmpeg.so").writeText("x")
        assertEquals(listOf("llama-server", "node"), EnginePaths.missingToolsIn(dir))
    }
    @Test fun splits_on_spaces_and_arabic_without_a_shell() {
        assertEquals("/storage/emulated/0/Movies/فيلم.2024.mkv",
            EnginePaths.mediaPath("primary:Movies/فيلم.2024.mkv"))
    }
    @Test fun rejects_sd_card_paths() {
        assertFalse(EnginePaths.isSupportedMediaPath("/storage/1234-5678/Movies"))
        assertTrue(EnginePaths.isSupportedMediaPath("/storage/emulated/0/Movies"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EnginePathsTest"`
Expected: FAIL — unresolved reference `EnginePaths`.

- [ ] **Step 3: Implement `EnginePaths`**

Take the native dir as a parameter in `missingToolsIn(dir)` so it is testable without a `Context`. Real methods call `context.applicationInfo.nativeLibraryDir`. `mediaPath` maps a SAF doc-id ("primary:…") to `/storage/emulated/0/…` and leaves anything else untouched. `isSupportedMediaPath` returns true only for paths beginning `/storage/emulated/0/`.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EnginePathsTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/arabicsubs/engine/EnginePaths.kt app/src/test/java/com/arabicsubs/engine/EnginePathsTest.kt
git commit -m "feat(engine): locate bundled tools and reject unsupported storage"
```

---

### Task 3: Unpack the bundled Node engine

**Files:**
- Create: `app/src/main/java/com/arabicsubs/engine/EngineAssets.kt`
- Test: `app/src/test/java/com/arabicsubs/engine/EngineAssetsTest.kt`

**Interfaces:**
- Produces: `class EngineAssets(assetsRoot: File, stamp: String) { fun ensureExtracted(): File; fun mainScript(): File }` — `ensureExtracted()` copies the tree once (guarded by a `stamp` file holding the app version) and returns the engine root; `mainScript()` is `<root>/bin/arabic-subs.js`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```kotlin
class EngineAssetsTest {
    @Test fun extracts_once_and_rewrites_on_new_stamp() {
        val src = Files.createTempDirectory("src").toFile().apply {
            File(this, "bin").mkdirs(); File(this, "bin/arabic-subs.js").writeText("//x")
            File(this, "src").mkdirs(); File(this, "src/config.js").writeText("//c")
        }
        val dest = Files.createTempDirectory("dest").toFile()
        val a = EngineAssets(src, "2.3.0")
        val root = a.ensureExtracted(dest)
        assertTrue(File(root, "bin/arabic-subs.js").exists())
        File(root, "bin/arabic-subs.js").writeText("//edited")
        a.ensureExtracted(dest)
        assertEquals("//x", File(root, "bin/arabic-subs.js").readText()) // stamp unchanged → no rewrite
        EngineAssets(src, "2.3.1").ensureExtracted(dest)
        assertEquals("//x", File(root, "bin/arabic-subs.js").readText())
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineAssetsTest"`
Expected: FAIL — unresolved reference `EngineAssets`.

- [ ] **Step 3: Implement `EngineAssets`**

`extract(File src, File dest)` recurses, overwriting; `ensureExtracted(dest)` skips when `dest/.stamp` already equals `stamp`, else wipes the managed subdirs (`bin`, `src`) and re-extracts, then writes the stamp. Never touch `models/`, `tmp/` or `logs/`. The production constructor reads from `context.assets` via an `AssetManager`; keep the `File`-based path for tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineAssetsTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/arabicsubs/engine/EngineAssets.kt app/src/test/java/com/arabicsubs/engine/EngineAssetsTest.kt
git commit -m "feat(engine): unpack bundled node engine into app storage"
```

---

### Task 4: Build the engine environment

**Files:**
- Create: `app/src/main/java/com/arabicsubs/engine/EngineEnv.kt`
- Test: `app/src/test/java/com/arabicsubs/engine/EngineEnvTest.kt`

**Interfaces:**
- Produces: `object EngineEnv { fun forRun(home: String, nativeDir: String, translationSlots: Int, threads: Int): Map<String, String> }` and `fun forSetup(home: String, nativeDir: String): Map<String, String>`.
- Consumes: `EnginePaths` names.

- [ ] **Step 1: Write the failing test**

```kotlin
class EngineEnvTest {
    @Test fun points_node_at_bundled_tools_and_media_home() {
        val env = EngineEnv.forRun("/storage/emulated/0/ArabicSubs", "/data/app/lib/arm64", 4, 8)
        assertEquals("/storage/emulated/0/ArabicSubs", env["ARABIC_SUBS_HOME"])
        assertEquals("/storage/emulated/0/ArabicSubs/models", env["ARABIC_SUBS_MODELS"])
        assertEquals("/data/app/lib/arm64/libllama-server.so", env["LLAMA_SERVER_BIN"])
        assertEquals("/data/app/lib/arm64/libwhisper-cli.so", env["WHISPER_BIN"])
        assertEquals("/data/app/lib/arm64/libffmpeg.so", env["FFMPEG_BIN"])
        assertEquals("/data/app/lib/arm64/libffprobe.so", env["FFPROBE_BIN"])
        assertEquals("/data/app/lib/arm64", env["LD_LIBRARY_PATH"])
        assertEquals("4", env["TRANSLATE_CONCURRENCY"])
        assertEquals("8", env["THREADS"])
    }
    @Test fun temp_dir_is_under_the_home() {
        val env = EngineEnv.forRun("/storage/emulated/0/ArabicSubs", "/lib", 2, 4)
        assertTrue(env.getValue("ARABIC_SUBS_HOME").let { env["TMPDIR"]!!.startsWith(it) })
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineEnvTest"`
Expected: FAIL — unresolved reference `EngineEnv`.

- [ ] **Step 3: Implement `EngineEnv`**

Return the keys the engine already reads (`ARABIC_SUBS_HOME`, `ARABIC_SUBS_MODELS`, `ARABIC_SUBS_LOG`, `TMPDIR`, `LLAMA_SERVER_BIN`, `WHISPER_BIN`, `FFMPEG_BIN`, `FFPROBE_BIN`, `LD_LIBRARY_PATH`, `TRANSLATE_CONCURRENCY`, `LLAMA_PARALLEL`, `THREADS`, `HYMT_MODEL_FLAVOR=q4_k_m`, `WHISPER_MODEL=base`). `forSetup` omits the slot/thread keys.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineEnvTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/arabicsubs/engine/EngineEnv.kt app/src/test/java/com/arabicsubs/engine/EngineEnvTest.kt
git commit -m "feat(engine): build the node environment from bundled paths"
```

---

### Task 5: Build the engine command line

**Files:**
- Create: `app/src/main/java/com/arabicsubs/engine/EngineCommand.kt`
- Test: `app/src/test/java/com/arabicsubs/engine/EngineCommandTest.kt`

**Interfaces:**
- Produces: `object EngineCommand { fun run(script: String, mediaPaths: List<String>): List<String>; fun setup(script: String): List<String>; fun process(script: String, file: String): List<String> }`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```kotlin
class EngineCommandTest {
    @Test fun passes_paths_as_separate_arguments() {
        val argv = EngineCommand.run("/files/node/bin/arabic-subs.js",
            listOf("/storage/emulated/0/Movies", "/storage/emulated/0/فيلم مع مسافات"))
        assertEquals(listOf("run", "--media", "/storage/emulated/0/Movies", "--media",
            "/storage/emulated/0/فيلم مع مسافات"), argv.drop(1))
    }
    @Test fun setup_is_non_interactive() {
        assertEquals(listOf("setup", "--yes"), EngineCommand.setup("/x/bin/arabic-subs.js").drop(1))
    }
    @Test fun process_targets_one_file() {
        assertEquals(listOf("process", "/v/a.mkv"),
            EngineCommand.process("/x/bin/arabic-subs.js", "/v/a.mkv").drop(1))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineCommandTest"`
Expected: FAIL — unresolved reference `EngineCommand`.

- [ ] **Step 3: Implement `EngineCommand`**

Each function returns a list beginning with the Node **binary path** is not included (the caller prepends it); the returned list starts with the script path. Build one `--media` per path; never join with spaces.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineCommandTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/arabicsubs/engine/EngineCommand.kt app/src/test/java/com/arabicsubs/engine/EngineCommandTest.kt
git commit -m "feat(engine): build argv for run, setup and process"
```

---

### Task 6: Parse engine output into progress events

**Files:**
- Create: `app/src/main/java/com/arabicsubs/engine/EngineOutput.kt`
- Test: `app/src/test/java/com/arabicsubs/engine/EngineOutputTest.kt`

**Interfaces:**
- Produces: `sealed interface EngineEvent { data class Stage(...); data class Asr(...); data class Translate(...); data class Queue(...); data class Raw(val line: String) }` and `class EngineOutput { fun feed(line: String): EngineEvent }`.
- Consumes: the exact output formats in `bin/arabic-subs.js` (`[Stage] name → stage (source) (N cues)`, `[ASR] d/t chunks`, `[Translate] d lines done`, `[Queue] → / ✓ / ✗ name`).

- [ ] **Step 1: Write the failing test**

```kotlin
class EngineOutputTest {
    private val out = EngineOutput()
    @Test fun reads_stage_lines() {
        val e = out.feed("[Stage] a.mkv → translate (subtitle) (812 cues)") as EngineEvent.Stage
        assertEquals("translate", e.stage); assertEquals(812, e.cueCount)
    }
    @Test fun reads_asr_chunk_progress() {
        val e = out.feed("[ASR] 12/41 chunks") as EngineEvent.Asr
        assertEquals(12, e.done); assertEquals(41, e.total)
    }
    @Test fun unknown_lines_are_raw() {
        assertTrue(out.feed("some llama-server noise") is EngineEvent.Raw)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineOutputTest"`
Expected: FAIL — unresolved reference `EngineOutput`.

- [ ] **Step 3: Implement `EngineOutput`**

Regex each known prefix; anything else is `Raw`. Keep it tolerant: a `\r`-terminated partial line must buffer until newline (the engine writes `\r` progress without a newline).

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineOutputTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/arabicsubs/engine/EngineOutput.kt app/src/test/java/com/arabicsubs/engine/EngineOutputTest.kt
git commit -m "feat(engine): parse engine output into progress events"
```

---

### Task 7: Manifest, permissions and the all-files helper

**Files:**
- Modify: `app/src/main/AndroidManifest.xml`
- Create: `app/src/main/java/com/arabicsubs/storage/AllFilesAccess.kt`

**Interfaces:**
- Produces: `object AllFilesAccess { fun granted(context: Context): Boolean; fun settingsIntent(context: Context): Intent }`.
- Consumes: nothing.

- [ ] **Step 1: Update the manifest**

Add `MANAGE_EXTERNAL_STORAGE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`. Declare the service from Task 8 (add it in that task if you prefer to keep this one green). Remove `com.termux.permission.RUN_COMMAND` and the `<queries>` block for `com.termux`.

- [ ] **Step 2: Implement `AllFilesAccess`**

`granted` checks `Environment.isExternalStorageManager()` on API 30+ and returns true on older APIs (legacy permissions suffice there). `settingsIntent` returns the `ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` intent for this package.

- [ ] **Step 3: Verify the build**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL; `AndroidManifest.xml` in the APK has no `com.termux` entry.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/AndroidManifest.xml app/src/main/java/com/arabicsubs/storage/AllFilesAccess.kt
git commit -m "feat(storage): request all-files access, drop termux from the manifest"
```

---

### Task 8: The engine foreground service

**Files:**
- Create: `app/src/main/java/com/arabicsubs/engine/EngineService.kt`
- Modify: `app/src/main/AndroidManifest.xml`
- Test: `app/src/test/java/com/arabicsubs/engine/EngineLaunchTest.kt`

**Interfaces:**
- Consumes: `EnginePaths`, `EngineAssets`, `EngineEnv`, `EngineCommand`, `EngineOutput`.
- Produces: `EngineService.start(context, mode)` where `mode` is `Run(mediaPaths, slots, threads)` or `Setup`; it writes a process handle into a `StateFlow` the UI observes; a notification shows the current stage.

- [ ] **Step 1: Test the pure launch description**

Extract the decision of "what to run" into a testable function `EngineLaunch.describe(mode, paths): Launch` returning binary path, argv and env:

```kotlin
@Test fun run_uses_node_binary_and_sets_env() {
    val l = EngineLaunch.describe(EngineMode.Run(listOf("/v"), 2, 4),
        EnginePathsSpec("/lib", "/files/node/bin/arabic-subs.js", "/storage/emulated/0/ArabicSubs"))
    assertEquals("/lib/libnode.so", l.binary)
    assertEquals(listOf("/files/node/bin/arabic-subs.js", "run", "--media", "/v"), l.argv)
    assertEquals("4", l.env["TRANSLATE_CONCURRENCY"])
}
```

Run: `./gradlew :app:testDebugUnitTest --tests "com.arabicsubs.engine.EngineLaunchTest"` — FAIL first, then implement `EngineLaunch` in `EngineService.kt`, then PASS.

- [ ] **Step 2: Implement `EngineService`**

A `LifecycleService`/`Service` that: on `onStartCommand`, builds the `Launch`, starts a `ProcessBuilder(binary, *argv)` with `env`, reads stdout+stderr through `EngineOutput`, updates a `StateFlow<EngineStatus>`, and posts a foreground notification (channel `engine`) titled with the stage. On `onDestroy`/stop action, `destroy()` the process. Start foreground with type `dataSync`.

- [ ] **Step 3: Declare the service in the manifest**

`<service android:name=".engine.EngineService" android:exported="false" android:foregroundServiceType="dataSync" />`

- [ ] **Step 4: Verify**

Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/arabicsubs/engine/EngineService.kt app/src/test/java/com/arabicsubs/engine/EngineLaunchTest.kt app/src/main/AndroidManifest.xml
git commit -m "feat(engine): run the node engine from a foreground service"
```

---

### Task 9: Wire the UI and remove the Termux surfaces

**Files:**
- Modify: `app/src/main/java/com/arabicsubs/ui/MainActivity.kt`
- Modify: `app/src/main/java/com/arabicsubs/ui/SetupWizard.kt`

**Interfaces:**
- Consumes: `AllFilesAccess`, `EngineService`.
- Produces: the dashboard "Run" button calls `EngineService.start(...)`; the setup wizard becomes access → folder → model → done.

- [ ] **Step 1: Replace the Termux launch with the service**

Delete `launchTermuxCommand`, `launchTermuxEngine`, `buildRunCommand`, `buildSingleCommand`, `launchEngineFix`, `runInTermux`, `copyToClipboard`, `SETUP_ONE_LINER`, `TermuxSetupDialog` and every "نسخ" (copy) command control. The run button starts `EngineService` with the chosen folder(s).

- [ ] **Step 2: Rewrite the wizard steps**

`buildWizardSteps` returns: (1) "Allow access to your files" opening `AllFilesAccess.settingsIntent`; (2) "Choose your media folder" opening the picker; (3) "Download the model" starting `EngineService` in `Setup` mode and showing progress from the status flow.

- [ ] **Step 3: Manual verification on a device**

Install the debug APK; grant access; pick `/storage/emulated/0/Movies`; run setup with no network to confirm a readable failure; then with network to confirm the models land in `/storage/emulated/0/ArabicSubs/models/`. Explicitly check the Review Focus item: revoke all-files access while the app is open and press Run — expect a message, not a crash.

- [ ] **Step 4: Confirm no Termux strings remain**

Run: `rg -i "termux" app/src` (or the search tool).
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/arabicsubs/ui/MainActivity.kt app/src/main/java/com/arabicsubs/ui/SetupWizard.kt
git commit -m "feat(ui): run the in-app engine, remove all termux surfaces"
```

---

### Task 10: Version and docs

**Files:**
- Modify: `app/build.gradle.kts` (`versionCode 14`, `versionName "2.3"`)
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Bump the version** and add a `## 2.3` changelog section: "the app now runs its own engine — no Termux".

- [ ] **Step 2: Update the README** to remove the Termux one-liner and describe the new first-run flow.

- [ ] **Step 3: Verify** `./gradlew :app:assembleRelease` and `npm test` both pass.

- [ ] **Step 4: Commit**

```bash
git add app/build.gradle.kts CHANGELOG.md README.md
git commit -m "chore: 2.3 — engine runs inside the app"
```

---

## Self-Review

- **Spec coverage:** engine-in-APK (Task 1), no-compile-on-phone (Task 1), models in `<media>/ArabicSubs` (Tasks 4, 9), All-files access (Task 7), Termux removed (Tasks 7, 9), tool paths (Task 2), JS unpack (Task 3), env (Task 4), foreground service (Task 8), UI first-run flow (Task 9). Deferred to plans 2–3: multi-folder list UI, per-movie rows, 1–4 selector, ETA bar, embedded-track extraction.
- **Type consistency:** `EnginePaths`/`EngineEnv`/`EngineCommand`/`EngineOutput`/`EngineAssets` are used only through the signatures fixed in their Interfaces blocks; `EngineService` consumes exactly those.
- **Review Focus:** each of the five items is pinned — argv safety (Task 5 test), revoked access (Task 9 manual), partial extraction (Task 2 test), SD-card path (Task 2 test), temp dir under home (Task 4 test).
- **Proportion:** ten tasks, each one deliverable with its own test cycle; the plan argues from the spec and does not transcribe the engine.
