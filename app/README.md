# Arabic Subs Android Companion App 📱

<p align="center">
  <img src="../docs/ArabicSubs.png" alt="عربي سبس Logo" width="120" />
</p>

The official native Android companion app for **Arabic Subs (عربي سبس)**. Built with **Modern Jetpack Compose**, **Material 3**, and Android's **Storage Access Framework (SAF)**.

---

## 🎯 Purpose & Architecture

The Android app acts as the user-facing command bridge for the on-device translation engine running inside **Termux**:

1. **Folder Selection & Permission Persistence:** Uses `ACTION_OPEN_DOCUMENT_TREE` to grant read/write access to media directories across reboots.
2. **Three-Step Setup Wizard:** Step-by-step guidance for Termux package installation, folder selection, and launching.
3. **Queue-Style & Specific File Operations:**
   - **تشغيل الكل (Run All):** Dispatches the entire queue of pending media files to Termux.
   - **نسخ الأمر (Copy Command):** Instantly copies the full run command to the clipboard with one tap.
   - **تنظيف وفحص (Reclean & Rescan):** Clears skipped statuses, re-verifies `.ArabicSubs.ar.srt` sidecars on disk, and synchronizes the queue.
   - **Single Item Controls:** Every video card offers a direct **Copy Command** and **Play** button to translate just that individual file.
   - **Skip / Unskip:** Skip any video so the engine bypasses it during batch operations.
4. **Live Engine Status:** Background coroutine polls `http://127.0.0.1:18435/status` on loopback to display active video name, cue progress, and queue statistics in real time.
5. **Seamless IPC:** Sends execution intents via `com.termux.RUN_COMMAND` with an automatic fallback that copies the command and opens Termux if the intent service is unavailable.

---

## 📱 Three-Step User Workflow

The app is built around the **Three Clear Steps** paradigm:

```
┌─────────────────────────────────┐
│ Step 1: One-Liner in Termux     │ ──> Copy & run single setup command
├─────────────────────────────────┤
│ Step 2: Choose Media Folder     │ ──> Pick /sdcard/Movies or TV Shows
├─────────────────────────────────┤
│ Step 3: Run Engine / Copy & Go  │ ──> Queue all or pick specific video
└─────────────────────────────────┘
```

### Dashboard Actions

- **🚀 تشغيل الكل (Run All):** Executes `node bin/arabic-subs.js run --media ...` in Termux.
- **📋 نسخ الأمر (Copy Command):** Copies the exact CLI command to your clipboard.
- **🧹 تنظيف وفحص (Reclean & Rescan):** Resets skipped items, cleans the list, and triggers a full rescan.
- **Per-Item Row:**
  - Status indicator: **Done ✅ (جاهز)**, **Pending ⏳ (بانتظار الترجمة)**, **Skipped ⏭️ (متخطى)**.
  - **نسخ (Copy):** Copies `node bin/arabic-subs.js process "/path/to/movie.mp4"` for that specific file.
  - **▶️ (Play):** Launches Termux directly targeting that specific video.
  - **⏭️ (Skip / Unskip):** Toggles inclusion in the batch queue.

---

## 🏗️ Project Structure

```text
app/
├── build.gradle.kts           # SDK 35, Min SDK 26, Compose BOM, arm64-v8a ABI filter
├── src/main/
│   ├── AndroidManifest.xml   # Permissions (INTERNET, RUN_COMMAND, STORAGE)
│   ├── java/com/arabicsubs/
│   │   ├── ArabicSubsApp.kt   # Application entry point
│   │   └── ui/
│   │       ├── MainActivity.kt # Core dashboard, media scanner, SAF persistence, IPC
│   │       ├── SetupWizard.kt  # 3-Step Setup Wizard dialog & clipboard helper
│   │       └── theme/         # AMOLED dark theme tokens & typography
│   └── res/                   # Drawables, mipmaps, strings, and icons
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

- **100% Offline:** The app only connects to `http://127.0.0.1:18435` (localhost loopback) to fetch engine statistics. No internet traffic, analytics, or external calls are ever made.
- **Scoped Storage:** Operates strictly within user-granted directories through Android's Storage Access Framework.
