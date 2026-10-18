package com.arabicsubs.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.documentfile.provider.DocumentFile
import com.arabicsubs.engine.EngineMode
import com.arabicsubs.engine.EngineService
import com.arabicsubs.engine.EngineStatus
import com.arabicsubs.storage.AllFilesAccess
import com.arabicsubs.ui.theme.*
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private val videoExtensions = listOf("mp4", "mkv", "avi", "m4v", "mov", "webm", "ts", "m2ts")
    private val outputSuffixes = listOf(".ArabicSubs.ar.ass", ".ArabicSubs.ar.srt")

    data class MediaFolder(val id: String, val displayName: String, val rawPath: String)

    data class MediaItemStatus(
        val name: String,
        val fileName: String = "",
        val fullPath: String = "",
        val isDone: Boolean,
        val folderName: String,
        var isSkipped: Boolean = false
    )

    private var folders = mutableStateListOf<MediaFolder>()
    private var itemList = mutableStateListOf<MediaItemStatus>()
    private var achievedCount by mutableStateOf(0)
    private var pendingCount by mutableStateOf(0)
    private var skippedCount by mutableStateOf(0)
    private var isScanning by mutableStateOf(false)
    private var showWizard by mutableStateOf(false)
    private var showSettings by mutableStateOf(false)
    // ONE parallelism number for the whole run: the same value drives how many
    // whisper chunks are transcribed at once, how many translation requests run
    // at once, and how many llama slots serve them.
    private var parallelism by mutableStateOf(2)

    // the wizard only auto-opens the very first time, never again after "تم"
    private val prefs by lazy { getSharedPreferences("arabic_subs", Context.MODE_PRIVATE) }

    /** Cores are also the ceiling: never offer more parallel work than the phone has cores. */
    private val maxParallelism: Int
        get() = Runtime.getRuntime().availableProcessors().coerceIn(1, 8)

    private val threads: Int
        get() = maxParallelism

    private val folderPickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                result.data?.data?.let { uri ->
                    try {
                        contentResolver.takePersistableUriPermission(
                            uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                        )
                    } catch (e: SecurityException) {
                        // some providers only grant a one-shot permission; keep going
                    }
                    addFolder(uri)
                }
            }
        }

    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // "slots" is the old key, kept as a fallback so an upgrade keeps the choice
        parallelism = prefs.getInt("parallelism", prefs.getInt("slots", 2)).coerceIn(1, maxParallelism)
        // first launch → straight into the setup walkthrough
        if (!prefs.getBoolean("setup_done", false)) showWizard = true
        // Restore the folders the user picked in an earlier session: the tree URIs
        // hold persistable permissions, so this survives restarts and reboots.
        loadFolders()
        if (folders.isNotEmpty()) scanFolders()
        setContent {
            ArabicSubsTheme {
                val context = LocalContext.current
                Scaffold(
                    topBar = {
                        TopAppBar(
                            title = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        "عربي سبس",
                                        color = AccentText,
                                        fontWeight = FontWeight.Black,
                                        fontSize = 24.sp
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Surface(
                                        shape = RoundedCornerShape(6.dp),
                                        color = Gold500.copy(alpha = 0.15f),
                                    ) {
                                        Text(
                                            "v2.5",
                                            color = AccentText,
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold,
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                        )
                                    }
                                }
                            },
                            actions = {
                                // Everything configuration-shaped lives behind the gear,
                                // so the dashboard stays about the library and the run.
                                IconButton(onClick = { showSettings = true }) {
                                    Icon(Icons.Default.Settings, contentDescription = "الإعدادات", tint = AccentText)
                                }
                            },
                            colors = TopAppBarDefaults.topAppBarColors(containerColor = DarkSurface)
                        )
                    }
                ) { paddingValues ->
                    Surface(
                        modifier = Modifier.fillMaxSize().padding(paddingValues),
                        color = DarkBg
                    ) {
                        if (showSettings) {
                            SettingsScreen(
                                folders = folders,
                                parallelism = parallelism,
                                maxParallelism = maxParallelism,
                                onAddFolder = {
                                    folderPickerLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE))
                                },
                                onRemoveFolder = { removeFolder(it) },
                                onChooseSlots = { chooseParallelism(it) },
                                onOpenWizard = { showWizard = true },
                                onClose = { showSettings = false }
                            )
                        } else {
                            DashboardScreen(context)
                        }
                        if (showWizard) {
                            SetupWizard(
                                mediaPaths = folders.map { it.rawPath },
                                onPickFolders = {
                                    folderPickerLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE))
                                },
                                onDismiss = { showWizard = false },
                                onCompleted = { prefs.edit().putBoolean("setup_done", true).apply() }
                            )
                        }
                    }
                }
            }
        }
    }

    // ── Folder management ─────────────────────────────────────────────

    private fun rawPathFor(uri: Uri): String {
        val segment = uri.lastPathSegment ?: return "/storage/emulated/0"
        return if (segment.startsWith("primary:")) {
            "/storage/emulated/0/" + segment.removePrefix("primary:")
        } else {
            "/storage/emulated/0/" + segment.substringAfter(":")
        }
    }

    private fun addFolder(uri: Uri) {
        val raw = rawPathFor(uri)
        if (folders.any { it.rawPath == raw }) {
            Toast.makeText(this, "المجلد مضاف مسبقاً", Toast.LENGTH_SHORT).show()
            return
        }
        folders.add(
            MediaFolder(
                id = uri.toString(),
                displayName = uri.lastPathSegment?.substringAfter(':') ?: raw,
                rawPath = raw
            )
        )
        saveFolders()
        scanFolders()
    }

    private fun removeFolder(folder: MediaFolder) {
        folders.remove(folder)
        saveFolders()
        scanFolders()
    }

    // ── Persistence ───────────────────────────────────────────────────

    /** Folders, as JSON, so the list survives the app being closed. */
    private fun saveFolders() {
        val arr = JSONArray()
        folders.forEach { folder ->
            arr.put(
                JSONObject()
                    .put("id", folder.id)
                    .put("name", folder.displayName)
                    .put("path", folder.rawPath)
            )
        }
        prefs.edit().putString("folders", arr.toString()).apply()
    }

    private fun loadFolders() {
        val raw = prefs.getString("folders", null) ?: return
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val id = obj.optString("id")
                val path = obj.optString("path")
                if (id.isEmpty() || path.isEmpty()) continue
                if (folders.any { it.rawPath == path }) continue
                folders.add(MediaFolder(id, obj.optString("name", path), path))
            }
        } catch (e: Exception) {
            // unreadable store: start clean instead of crashing on launch
            prefs.edit().remove("folders").apply()
        }
    }

    /** Queue skips are a user choice, so they persist across launches too. */
    private fun saveSkipped() {
        val arr = JSONArray()
        itemList.filter { it.isSkipped }.forEach { arr.put(it.fullPath) }
        prefs.edit().putString("skipped", arr.toString()).apply()
    }

    private fun loadSkipped(): Set<String> {
        val raw = prefs.getString("skipped", null) ?: return emptySet()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { arr.optString(it) }.filter { it.isNotEmpty() }.toSet()
        } catch (e: Exception) {
            emptySet()
        }
    }

    // ── Engine launch ─────────────────────────────────────────────────

    /** One parallelism number for whisper chunks, translation requests and llama slots. */
    private fun chooseParallelism(n: Int) {
        parallelism = n.coerceIn(1, maxParallelism)
        prefs.edit().putInt("parallelism", parallelism).apply()
    }

    private fun runAllFolders(context: Context) {
        if (folders.isEmpty()) {
            Toast.makeText(context, "اختر مجلداً أولاً", Toast.LENGTH_SHORT).show()
            return
        }
        if (!ensureAllFilesAccess(context)) return
        EngineService.start(context, EngineMode.Run(folders.map { it.rawPath }, parallelism, threads))
        Toast.makeText(context, "بدأت الترجمة", Toast.LENGTH_SHORT).show()
    }

    private fun runSingleFile(context: Context, path: String) {
        if (!ensureAllFilesAccess(context)) return
        EngineService.start(context, EngineMode.Process(path, parallelism, threads))
        Toast.makeText(context, "بدأت ترجمة هذا الملف", Toast.LENGTH_SHORT).show()
    }

    /** True when all-files access is granted; otherwise toasts and opens settings. */
    private fun ensureAllFilesAccess(context: Context): Boolean {
        if (AllFilesAccess.granted(context)) return true
        Toast.makeText(context, "امنح الوصول إلى الملفات أولاً", Toast.LENGTH_SHORT).show()
        context.startActivity(AllFilesAccess.settingsIntent(context))
        return false
    }

    private fun recleanAndRescan() {
        itemList.forEachIndexed { index, item ->
            if (item.isSkipped) {
                itemList[index] = item.copy(isSkipped = false)
            }
        }
        saveSkipped()
        scanFolders()
        Toast.makeText(this, "تم تنظيف قائمة الانتظار وإعادة الفحص", Toast.LENGTH_SHORT).show()
    }

    // ── Scanning ──────────────────────────────────────────────────────

    private fun scanFolders() {
        if (folders.isEmpty()) {
            itemList.clear()
            recalcCounts()
            return
        }
        isScanning = true
        itemList.clear()

        CoroutineScope(Dispatchers.IO).launch {
            val newItems = mutableListOf<MediaItemStatus>()

            for (folder in folders) {
                val root = DocumentFile.fromTreeUri(this@MainActivity, Uri.parse(folder.id)) ?: continue
                val allFiles = mutableListOf<DocumentFile>()

                fun walk(dir: DocumentFile?) {
                    dir?.listFiles()?.forEach { file ->
                        if (file.isDirectory) walk(file) else allFiles.add(file)
                    }
                }
                walk(root)

                val videos = allFiles.filter { file ->
                    val ext = file.name?.substringAfterLast('.', "")?.lowercase() ?: ""
                    videoExtensions.contains(ext)
                }
                val names = allFiles.mapNotNull { it.name }.toSet()

                videos.forEach { video ->
                    val base = video.name?.substringBeforeLast('.') ?: return@forEach
                    val fullName = video.name ?: "$base.mp4"
                    val itemPath = "${folder.rawPath}/$fullName"
                    newItems.add(
                        MediaItemStatus(
                            name = base,
                            fileName = fullName,
                            fullPath = itemPath,
                            isDone = outputSuffixes.any { names.contains(base + it) },
                            folderName = folder.displayName
                        )
                    )
                }
            }

            withContext(Dispatchers.Main) {
                val skipped = loadSkipped()
                itemList.addAll(
                    newItems
                        .map { if (skipped.contains(it.fullPath)) it.copy(isSkipped = true) else it }
                        .sortedWith(compareBy({ it.isDone }, { it.folderName }, { it.name }))
                )
                recalcCounts()
                isScanning = false
            }
        }
    }

    private fun recalcCounts() {
        achievedCount = itemList.count { it.isDone }
        pendingCount = itemList.count { !it.isDone && !it.isSkipped }
        skippedCount = itemList.count { it.isSkipped }
    }

    // ── UI ────────────────────────────────────────────────────────────

    @Composable
    fun DashboardScreen(context: Context) {
        val engineStatus by EngineService.status.collectAsState()

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = Space.screen, vertical = Space.lg)
        ) {
            // Pinned: the engine tile must never scroll away, so the progress bar
            // and the current stage stay visible while everything else scrolls.
            EngineStatusCard(
                status = engineStatus,
                onStop = { EngineService.stop(context) }
            )

            Spacer(modifier = Modifier.height(12.dp))

            if (isScanning) {
                Column(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    CircularProgressIndicator(color = Gold500, strokeWidth = 3.dp, modifier = Modifier.size(44.dp))
                    Text("جاري فحص المجلدات...", color = TextMuted, modifier = Modifier.padding(top = 14.dp))
                }
            } else {
                // Everything except the pinned tile lives in one scroll container.
                // The old fixed Column overflowed on shorter screens and squeezed
                // the movie list into an unreadable strip at the bottom.
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentPadding = PaddingValues(bottom = Space.xl)
                ) {
                    item(key = "stats") {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            StatCard("مكتمل", achievedCount, SuccessGreen, SuccessGreen.copy(alpha = 0.12f), Modifier.weight(1f), icon = Icons.Default.Check)
                            StatCard("بالانتظار", pendingCount, WarnAmber, WarnAmber.copy(alpha = 0.12f), Modifier.weight(1f), icon = Icons.Default.Refresh)
                            StatCard("متخطى", skippedCount, InfoCyan, InfoCyan.copy(alpha = 0.12f), Modifier.weight(1f), icon = Icons.Default.Close)
                        }
                    }

                    item(key = "actions") {
                        Column {
                            Spacer(modifier = Modifier.height(14.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Button(
                                    onClick = { runAllFolders(context) },
                                    modifier = Modifier.weight(1.4f).height(50.dp),
                                    shape = RoundedCornerShape(14.dp),
                                    colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen),
                                    elevation = ButtonDefaults.buttonElevation(defaultElevation = 2.dp)
                                ) {
                                    Icon(Icons.Default.PlayArrow, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text("تشغيل الكل", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = DarkBg)
                                }

                                OutlinedButton(
                                    onClick = { recleanAndRescan() },
                                    modifier = Modifier.weight(1f).height(50.dp),
                                    shape = RoundedCornerShape(14.dp),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                                ) {
                                    Icon(Icons.Default.Refresh, contentDescription = null, tint = Accent, modifier = Modifier.size(16.dp))
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text("تنظيف وفحص", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Accent)
                                }
                            }

                            Spacer(modifier = Modifier.height(Space.md))
                            HorizontalDivider(color = DarkBorder, thickness = 1.dp)
                            Spacer(modifier = Modifier.height(Space.md))
                        }
                    }

                    // The terminal window: what the engine is doing, and every
                    // error it reported, without leaving the dashboard.
                    item(key = "log") {
                        EngineLogCard(engineStatus)
                        Spacer(modifier = Modifier.height(Space.md))
                    }

                    if (itemList.isEmpty()) {
                        item(key = "empty") {
                            EmptyLibrary(onOpenSettings = { showSettings = true })
                        }
                    } else {
                        val grouped = itemList.groupBy { it.folderName }
                        grouped.forEach { (folder, folderItems) ->
                            item(key = "header-$folder") {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(top = Space.lg, bottom = Space.sm),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Icon(
                                        Icons.Default.FolderOpen,
                                        contentDescription = null,
                                        tint = TextMuted,
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(modifier = Modifier.width(Space.sm))
                                    Text(folder, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                                    Spacer(modifier = Modifier.weight(1f))
                                    Surface(shape = RoundedCornerShape(8.dp), color = DarkCardHigh) {
                                        Text(
                                            "${folderItems.size} ملف",
                                            color = TextSecondary,
                                            fontSize = 11.sp,
                                            modifier = Modifier.padding(horizontal = Space.sm, vertical = Space.xxs)
                                        )
                                    }
                                }
                            }
                            // stable keys: without them a scan/reorder makes rows jump
                            items(folderItems, key = { it.fullPath }) { item -> MediaItemRow(context, item) }
                        }
                    }
                }
            }
        }
    }

    /** Empty state of the library, pointing at the one place folders live now. */
    @Composable
    fun EmptyLibrary(onOpenSettings: () -> Unit) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = Space.xl),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                "مكتبتك فارغة",
                color = TextPrimary,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(Space.xs))
            Text(
                "أضف مجلد الأفلام أو المسلسلات من الإعدادات لبدء الفحص والترجمة.",
                color = TextMuted,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(Space.lg))
            Button(
                onClick = onOpenSettings,
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Accent)
            ) {
                Icon(Icons.Default.Settings, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(Space.sm))
                Text("فتح الإعدادات", color = DarkBg, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            }
        }
    }

    @Composable
    fun EngineStatusCard(status: EngineStatus, onStop: () -> Unit) {
        val (label, accent) = when {
            status.failedToStart != null -> "المحرك: تعذّر التشغيل" to ErrorRose
            status.running && !status.stage.isNullOrEmpty() -> "المحرك: يعمل — ${status.stage}" to SuccessGreen
            status.running -> "المحرك: يعمل" to SuccessGreen
            status.exitCode == 0 -> "المحرك: انتهى بنجاح" to InfoCyan
            status.exitCode != null -> "المحرك: انتهى (رمز ${status.exitCode})" to ErrorRose
            else -> "المحرك: متوقف" to TextMuted
        }

        val done = status.progressDone
        val total = status.progressTotal
        val fraction: Float? = if (status.running && done != null && total != null && total > 0) {
            (done.toFloat() / total.toFloat()).coerceIn(0f, 1f)
        } else {
            null
        }

        // A 1s tick re-evaluates the ETA while a stage is running, without
        // recomposing the media list.
        var nowMs by remember { mutableStateOf(0L) }
        LaunchedEffect(status.running, status.progressStartedAtMs) {
            while (status.running && status.progressStartedAtMs != null) {
                nowMs = System.currentTimeMillis()
                delay(1000)
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = DarkCard),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(10.dp).background(accent, CircleShape))
                    Spacer(modifier = Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            label,
                            fontSize = 12.sp,
                            color = accent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        val detail = status.failedToStart ?: status.lastLine
                        if (!detail.isNullOrEmpty()) {
                            Spacer(modifier = Modifier.height(2.dp))
                            Text(
                                detail,
                                fontSize = 11.sp,
                                color = TextMuted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                    if (fraction != null) {
                        Text(
                            "${(fraction * 100).toInt()}%",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                            color = accent
                        )
                    }

                    // A visible way out when a stage looks stuck.
                    if (status.running) {
                        Spacer(modifier = Modifier.width(Space.sm))
                        OutlinedButton(
                            onClick = onStop,
                            modifier = Modifier.height(Space.touch),
                            shape = RoundedCornerShape(10.dp),
                            contentPadding = PaddingValues(horizontal = Space.sm),
                            border = androidx.compose.foundation.BorderStroke(1.dp, ErrorRose.copy(alpha = 0.6f))
                        ) {
                            Icon(Icons.Default.Stop, contentDescription = null, tint = ErrorRose, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(Space.xs))
                            Text("إيقاف", color = ErrorRose, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                if (status.running) {
                    Spacer(modifier = Modifier.height(10.dp))
                    if (fraction != null && done != null && total != null) {
                        LinearProgressIndicator(
                            progress = { fraction },
                            modifier = Modifier.fillMaxWidth().height(6.dp),
                            color = accent,
                            trackColor = DarkCardHigh
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(modifier = Modifier.fillMaxWidth()) {
                            Text("$done / $total", fontSize = 11.sp, color = TextMuted)
                            Spacer(modifier = Modifier.weight(1f))
                            estimateEta(status.progressStartedAtMs, nowMs, done, total)?.let { eta ->
                                Text("الوقت المتبقي $eta", fontSize = 11.sp, color = TextMuted)
                            }
                        }
                    } else {
                        // Stage is active but no total reported yet — indeterminate.
                        LinearProgressIndicator(
                            modifier = Modifier.fillMaxWidth().height(6.dp),
                            color = accent,
                            trackColor = DarkCardHigh
                        )
                    }
                }
            }
        }
    }

    // Wall-clock ETA from the observed rate so far. Deliberately conservative: it
    // stays silent until there is at least 2s of data and a real total.
    private fun estimateEta(startedAtMs: Long?, nowMs: Long, done: Int, total: Int): String? {
        if (startedAtMs == null || done <= 0 || total <= done) return null
        val elapsedMs = nowMs - startedAtMs
        if (elapsedMs < 2000) return null
        val estimatedTotalMs = elapsedMs.toDouble() * total / done
        val remainingSec = ((estimatedTotalMs - elapsedMs) / 1000.0).toLong()
        if (remainingSec <= 0) return null
        return when {
            remainingSec < 60 -> "أقل من دقيقة"
            remainingSec < 3600 -> "≈ ${remainingSec / 60} دقيقة"
            else -> "≈ ${remainingSec / 3600} ساعة"
        }
    }

    @Composable
    fun MediaItemRow(context: Context, item: MediaItemStatus) {
        val index = itemList.indexOf(item)
        val statusColor = when {
            item.isDone -> SuccessGreen
            item.isSkipped -> WarnAmber
            else -> ErrorRose
        }
        val statusLabel = when {
            item.isDone -> "جاهز"
            item.isSkipped -> "متخطى"
            else -> "بانتظار الترجمة"
        }

        Card(
            modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
            colors = CardDefaults.cardColors(containerColor = DarkCard),
            shape = RoundedCornerShape(14.dp),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(modifier = Modifier.size(10.dp).background(statusColor, CircleShape))
                Spacer(modifier = Modifier.width(12.dp))

                Column(modifier = Modifier.weight(1f)) {
                    Text(item.name, color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(statusLabel, color = statusColor.copy(alpha = 0.75f), fontSize = 11.sp)
                }

                if (item.isDone) {
                    Icon(Icons.Default.Check, contentDescription = "مكتمل", tint = SuccessGreen, modifier = Modifier.size(20.dp))
                } else {
                    IconButton(
                        onClick = {
                            if (index >= 0) {
                                itemList[index] = itemList[index].copy(isSkipped = !item.isSkipped)
                                recalcCounts()
                                saveSkipped()
                            }
                        }
                    ) {
                        Icon(
                            if (item.isSkipped) Icons.Default.Refresh else Icons.Default.Close,
                            contentDescription = if (item.isSkipped) "إلغاء تخطي ${item.name}" else "تخطي ${item.name}",
                            tint = if (item.isSkipped) InfoCyan else WarnAmber,
                            modifier = Modifier.size(20.dp)
                        )
                    }

                    if (!item.isSkipped) {
                        // a real button, so TalkBack announces it and the tap target is 48dp
                        Button(
                            onClick = { runSingleFile(context, item.fullPath) },
                            modifier = Modifier.height(Space.touch),
                            shape = RoundedCornerShape(12.dp),
                            contentPadding = PaddingValues(horizontal = Space.md),
                            colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen)
                        ) {
                            Icon(
                                Icons.Default.PlayArrow,
                                contentDescription = null,
                                tint = DarkBg,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(modifier = Modifier.width(Space.xs))
                            Text(
                                "ترجمة",
                                color = DarkBg,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                }
            }
        }
    }

    @Composable
    fun StatCard(
        title: String,
        count: Int,
        accentColor: Color,
        bgColor: Color,
        modifier: Modifier = Modifier,
        icon: androidx.compose.ui.graphics.vector.ImageVector? = null
    ) {
        Card(
            modifier = modifier.height(86.dp),
            colors = CardDefaults.cardColors(containerColor = bgColor),
            shape = RoundedCornerShape(14.dp),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
        ) {
            Column(
                modifier = Modifier.fillMaxSize().padding(8.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(count.toString(), color = accentColor, fontSize = 26.sp, fontWeight = FontWeight.ExtraBold)
                Spacer(modifier = Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (icon != null) {
                        Icon(icon, contentDescription = null, tint = accentColor.copy(alpha = 0.85f), modifier = Modifier.size(13.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                    }
                    Text(title, color = accentColor.copy(alpha = 0.8f), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
