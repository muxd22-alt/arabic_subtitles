# Arabic Subs Android App 📱

<p align="center">
  <img src="../docs/ArabicSubs.png" alt="عربي سبس Logo" width="120" />
</p>

The official native Android app for **Arabic Subs (عربي سبس)**. Built with **Modern Jetpack Compose**, **Material 3**, and a **foreground service** that runs the bundled engine on-device.

---

## 🎯 Purpose & Architecture

The app **is** the runner: it carries its own Node engine and native tools inside the APK and executes them itself — there is no Termux and no clipboard step.

1. **All-files access:** the engine needs real filesystem paths to read videos and write `.ass` files beside them, so the app requests `MANAGE_EXTERNAL_STORAGE` (sideloaded app, primary storage).
2. **Three-step first run:** allow access → choose media folder(s) → download the models once into `<media>/ArabicSubs/`.
3. **The engine runs in-app:** an `android.app.Service` (`EngineService`) unpacks the bundled tools, sets up the environment, spawns the Node engine and streams its output.
4. **Live status:** the dashboard observes `EngineService.status` (a `StateFlow`) for the active stage and progress — no loopback server.
5. **Queue-style & single-file runs:**
   - **تشغيل الكل (Run All):** runs the whole pending queue, one film at a time.
   - **▶ ترجمة (Translate):** run just one file.
   - **تنظيف وفحص (Reclean & Rescan):** clears skipped statuses, re-verifies the `.ArabicSubs.ar.ass` sidecars on disk, and syncs the queue (legacy `.ArabicSubs.ar.srt` outputs from before 2.4 are still recognised as done).
   - **Skip / Unskip:** skip a video so batch runs bypass it.

---

## 📱 Three-Step User Workflow

```
┌─────────────────────────────────┐
│ Step 1: Allow file access       │ ──> Settings → allow all files
├─────────────────────────────────┤
│ Step 2: Choose media folder     │ ──> Pick /sdcard/Movies or TV Shows
├─────────────────────────────────┤
│ Step 3: Download the model      │ ──> ~1.1 GB, once, into <media>/ArabicSubs/
└─────────────────────────────────┘
```

### Dashboard Actions

- **🚀 تشغيل الكل (Run All):** starts the engine over the queued folders.
- **🧹 تنظيف وفحص (Reclean & Rescan):** resets skipped items, cleans the list, and triggers a full rescan.
- **Per-Item Row:**
  - Status indicator: **Done ✅ (جاهز)**, **Pending ⏳ (بانتظار الترجمة)**, **Skipped ⏭️ (متخطى)**.
  - **▶️ (Translate):** runs just that video through the engine.
  - **⏭️ (Skip / Unskip):** toggles inclusion in the batch queue.
- **1–4 selector:** sizes the in-video translation parallelism and the llama `-np`
  slot pool (the engine always works on **one video at a time**).

---

## 🏗️ Project Structure

```text
app/
├── build.gradle.kts           # SDK 35, Min SDK 28, Compose BOM, arm64-v8a ABI filter
├── src/main/
│   ├── AndroidManifest.xml    # Permissions (storage, foreground service), the engine service
│   ├── java/com/arabicsubs/
│   │   ├── ArabicSubsApp.kt    # Application entry point
│   │   ├── engine/             # Paths, assets unpack, env, argv, output parsing, EngineService
│   │   ├── storage/            # All-files-access helpers
│   │   └── ui/
│   │       ├── MainActivity.kt # Dashboard, media scanner, service wiring
│   │       ├── SetupWizard.kt  # 3-step first-run wizard
│   │       └── theme/          # AMOLED dark theme tokens & typography
│   └── res/                    # Drawables, mipmaps, strings, and icons
```

---

## 🔨 Building the APK

### Prerequisites
- JDK 17
- Android SDK (API 35, Build Tools 35.0.0)

### Debug Build
```bash
./gradlew assembleDebug
```
The output APK is generated at:
```text
app/build/outputs/apk/debug/app-debug.apk
```

### Release Build
```bash
./gradlew assembleRelease
```
The output APK is generated at:
```text
app/build/outputs/apk/release/app-release.apk
```

---

## 🔒 Security & Privacy

- **100% Offline once set up:** the only network traffic is the one-time model
  download from GitHub; after that the engine runs entirely on-device. No
  analytics and no external calls.
- **All-files access is required** because the engine reads and writes real files
  next to your videos; nothing is uploaded anywhere.
