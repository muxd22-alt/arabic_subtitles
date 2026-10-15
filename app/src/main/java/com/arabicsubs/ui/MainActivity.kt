package com.arabicsubs.ui

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.documentfile.provider.DocumentFile
import com.arabicsubs.ui.theme.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : ComponentActivity() {

    private val videoExtensions = listOf("mp4", "mkv", "avi", "m4v", "mov", "webm", "ts", "m2ts")
    private val outputSuffix = ".ArabicSubs.ar.srt"

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
    private var showSetupDialog by mutableStateOf(false)
    private var showWizard by mutableStateOf(false)
    private var autoCopy by mutableStateOf(true)
    // how many videos the Termux engine works on at once (JOB_CONCURRENCY)
    private var jobConcurrency by mutableStateOf(2)

    // the wizard only auto-opens the very first time, never again after "تم"
    private val prefs by lazy { getSharedPreferences("arabic_subs", Context.MODE_PRIVATE) }

    // engine status polled from the node status server (127.0.0.1:18435)
    private var engineState by mutableStateOf<EngineStatus?>(null)
    private var statusJob: Job? = null

    data class EngineStatus(
        val running: Boolean,
        val model: String,
        val current: String?,
        val done: Int,
        val failed: Int,
        val pending: Int,
        val active: Int
    )

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
        startStatusPolling()
        jobConcurrency = prefs.getInt("job_concurrency", 2).coerceIn(1, 4)
        // first launch → straight into the one-liner walkthrough
        if (!prefs.getBoolean("setup_done", false)) showWizard = true
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
                                            "v2.2",
                                            color = AccentText,
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold,
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                        )
                                    }
                                }
                            },
                            actions = {
                                IconButton(onClick = { showWizard = true }) {
                                    Icon(Icons.Default.List, contentDescription = "الإعداد خطوة بخطوة", tint = AccentText)
                                }
                                IconButton(onClick = { showSetupDialog = true }) {
                                    Icon(Icons.Default.Settings, contentDescription = "إعداد تيرمكس", tint = TextSecondary)
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
                        DashboardScreen(context)
                        if (showSetupDialog) {
                            TermuxSetupDialog(onDismiss = { showSetupDialog = false })
                        }
                        if (showWizard) {
                            SetupWizard(
                                mediaPaths = folders.map { it.rawPath },
        autoCopy = autoCopy,
        onAutoCopyChange = { autoCopy = it },
        onPickFolders = {
            folderPickerLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE))
        },
        onDismiss = { showWizard = false },
                                onCompleted = { prefs.edit().putBoolean("setup_done", true).apply() },
                                suggestedFile = itemList.firstOrNull { !it.isDone && !it.isSkipped }?.fullPath
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        statusJob?.cancel()
    }

    // ── Status polling ────────────────────────────────────────────────

    private fun startStatusPolling() {
        statusJob?.cancel()
        statusJob = CoroutineScope(Dispatchers.IO).launch {
            while (true) {
                val status = fetchEngineStatus()
                withContext(Dispatchers.Main) { engineState = status }
                delay(3000)
            }
        }
    }

    private fun fetchEngineStatus(): EngineStatus? {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL("http://127.0.0.1:18435/status")
            conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 1500
            conn.readTimeout = 1500
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val queue = json.optJSONObject("queue")
            EngineStatus(
                running = json.optString("engine") == "running",
                model = json.optString("model"),
                current = queue?.optString("current")?.takeIf { it.isNotEmpty() && it != "null" },
                done = queue?.optInt("done") ?: 0,
                failed = queue?.optInt("failed") ?: 0,
                pending = queue?.optInt("pending") ?: 0,
                active = queue?.optInt("active") ?: 0
            )
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
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
        scanFolders()
    }

    // ── Engine launch ─────────────────────────────────────────────────

    /** How many videos the engine should work on at once, handed to the CLI. */
    private fun chooseJobConcurrency(n: Int) {
        jobConcurrency = n.coerceIn(1, 4)
        prefs.edit().putInt("job_concurrency", jobConcurrency).apply()
    }

    private fun buildRunCommand(): String {
        val mediaArgs = folders.joinToString(" ") { "--media \"${it.rawPath}\"" }
        return "cd ~/arabic_subtitles && (git pull --ff-only 2>/dev/null || true) && " +
            "JOB_CONCURRENCY=$jobConcurrency node bin/arabic-subs.js run $mediaArgs"
    }

    private fun buildSingleCommand(itemPath: String): String {
        return "cd ~/arabic_subtitles && (git pull --ff-only 2>/dev/null || true) && " +
            "JOB_CONCURRENCY=$jobConcurrency node bin/arabic-subs.js process \"$itemPath\""
    }

    /**
     * "Fix engine" = run the setup script, which downloads the verified 16 MB
     * prebuilt engine (no compiling on the phone) and re-links it on PATH. This
     * is the answer to a crash or a missing llama-server — never a source build.
     */
    private fun launchEngineFix(context: Context) {
        launchTermuxCommand(
            context,
            "cd ~/arabic_subtitles && (git pull --ff-only 2>/dev/null || true); bash scripts/setup-termux.sh",
            "جاري تثبيت المحرك"
        )
    }

    private fun recleanAndRescan() {
        itemList.forEachIndexed { index, item ->
            if (item.isSkipped) {
                itemList[index] = item.copy(isSkipped = false)
            }
        }
        scanFolders()
        Toast.makeText(this, "تم تنظيف قائمة الانتظار وإعادة الفحص", Toast.LENGTH_SHORT).show()
    }

    private fun launchTermuxCommand(context: Context, cmd: String, okMessage: String) {
        try {
            val runIntent = Intent("com.termux.RUN_COMMAND").apply {
                setClassName("com.termux", "com.termux.app.RunCommandService")
                putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", cmd))
                putExtra("com.termux.RUN_COMMAND_BACKGROUND", false)
            }
            context.startService(runIntent)
            Toast.makeText(context, okMessage, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            val launchIntent = context.packageManager.getLaunchIntentForPackage("com.termux")
            if (launchIntent != null) {
                copyToClipboard(context, cmd)
                context.startActivity(launchIntent)
                Toast.makeText(context, "تم نسخ الأمر — الصقه في تيرمكس", Toast.LENGTH_LONG).show()
            } else {
                Toast.makeText(context, "الرجاء تثبيت تيرمكس أولاً", Toast.LENGTH_SHORT).show()
                showSetupDialog = true
            }
        }
    }

    private fun launchTermuxEngine(context: Context, singleFile: String? = null) {
        if (folders.isEmpty() && singleFile == null) {
            Toast.makeText(context, "اختر مجلداً أولاً", Toast.LENGTH_SHORT).show()
            return
        }
        val cmd = if (singleFile != null) {
            buildSingleCommand(singleFile)
        } else {
            buildRunCommand()
        }
        launchTermuxCommand(context, cmd, "تم إرسال الأمر إلى تيرمكس")
    }

    private fun copyToClipboard(context: Context, text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Arabic Subs", text))
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
                            isDone = names.contains(base + outputSuffix),
                            folderName = folder.displayName
                        )
                    )
                }
            }

            withContext(Dispatchers.Main) {
                itemList.addAll(
                    newItems.sortedWith(compareBy({ it.isDone }, { it.folderName }, { it.name }))
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 20.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Button(
                onClick = {
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                    folderPickerLauncher.launch(intent)
                },
                modifier = Modifier.fillMaxWidth().height(58.dp),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
                elevation = ButtonDefaults.buttonElevation(defaultElevation = 6.dp)
            ) {
                Icon(Icons.Default.Movie, contentDescription = null, tint = DarkBg, modifier = Modifier.size(20.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("إضافة مجلد أفلام / مسلسلات", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = DarkBg)
            }

            Spacer(modifier = Modifier.height(10.dp))

            OutlinedButton(
                onClick = { showWizard = true },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(14.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, Accent.copy(alpha = 0.5f))
            ) {
                Icon(Icons.Default.List, contentDescription = null, tint = Accent, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("الإعداد خطوة بخطوة", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = Accent)
            }

            Spacer(modifier = Modifier.height(12.dp))

            if (folders.isNotEmpty()) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = DarkCard),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        folders.forEach { folder ->
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Box(modifier = Modifier.size(8.dp).background(SuccessGreen, CircleShape))
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(
                                    folder.rawPath,
                                    fontSize = 12.sp,
                                    color = TextSecondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                IconButton(
                                    onClick = { folders.remove(folder); scanFolders() }
                                ) {
                                    Icon(Icons.Default.Close, contentDescription = "إزالة ${folder.displayName}", tint = TextSecondary, modifier = Modifier.size(18.dp))
                                }
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            EngineStatusCard()

            Spacer(modifier = Modifier.height(12.dp))

            ParallelismSelector()

            Spacer(modifier = Modifier.height(12.dp))

            if (isScanning) {
                Spacer(modifier = Modifier.height(32.dp))
                CircularProgressIndicator(color = Gold500, strokeWidth = 3.dp, modifier = Modifier.size(44.dp))
                Text("جاري فحص المجلدات...", color = TextMuted, modifier = Modifier.padding(top = 14.dp))
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    StatCard("مكتمل", achievedCount, SuccessGreen, SuccessGreen.copy(alpha = 0.12f), Modifier.weight(1f), icon = Icons.Default.Check)
                    StatCard("بالانتظار", pendingCount, WarnAmber, WarnAmber.copy(alpha = 0.12f), Modifier.weight(1f), icon = Icons.Default.Refresh)
                    StatCard("متخطى", skippedCount, InfoCyan, InfoCyan.copy(alpha = 0.12f), Modifier.weight(1f), icon = Icons.Default.Close)
                }

                Spacer(modifier = Modifier.height(14.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = { launchTermuxEngine(context) },
                        modifier = Modifier.weight(1.3f).height(50.dp),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen),
                        elevation = ButtonDefaults.buttonElevation(defaultElevation = 2.dp)
                    ) {
                        Icon(Icons.Default.PlayArrow, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("تشغيل الكل", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = DarkBg)
                    }

                    OutlinedButton(
                        onClick = { launchEngineFix(context) },
                        modifier = Modifier.weight(1.1f).height(50.dp),
                        shape = RoundedCornerShape(14.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, InfoCyan.copy(alpha = 0.5f))
                    ) {
                        Icon(Icons.Default.Build, contentDescription = null, tint = InfoCyan, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("إصلاح المحرك", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = InfoCyan)
                    }

                    OutlinedButton(
                        onClick = { recleanAndRescan() },
                        modifier = Modifier.weight(1.2f).height(50.dp),
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

                if (itemList.isEmpty()) {
                    Spacer(modifier = Modifier.height(Space.xl))
                    Text("اختر مجلد الأفلام أو المسلسلات لبدء الفحص", color = TextMuted, fontSize = 15.sp)
                } else {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
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

    @Composable
    fun EngineStatusCard() {
        val status = engineState
        val (label, accent) = when {
            status == null -> "المحرك: متوقف" to TextMuted
            status.active > 1 -> "المحرك: يعمل — ${status.active} ملفات بالتوازي" to SuccessGreen
            status.running && status.current != null -> "المحرك: يعمل — ${status.current}" to SuccessGreen
            status.running -> "المحرك: جاهز (${status.done} ترجمة)" to InfoCyan
            else -> "المحرك: متوقف" to TextMuted
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = DarkCard),
            shape = RoundedCornerShape(12.dp)
        ) {
            Row(
                modifier = Modifier.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(modifier = Modifier.size(10.dp).background(accent, CircleShape))
                Spacer(modifier = Modifier.width(10.dp))
                Text(label, fontSize = 12.sp, color = accent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (status != null && (status.pending > 0 || status.failed > 0)) {
                    Text(
                        "بانتظار ${status.pending}${if (status.failed > 0) " · فشل ${status.failed}" else ""}",
                        fontSize = 11.sp,
                        color = TextMuted
                    )
                }
            }
        }
    }

    @Composable
    fun ParallelismSelector() {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = DarkCard),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Settings, contentDescription = null, tint = Accent, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("ملفات متوازية", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.weight(1f))
                    Text("$jobConcurrency في وقت واحد", color = TextMuted, fontSize = 11.sp)
                }
                Spacer(modifier = Modifier.height(10.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    (1..4).forEach { n ->
                        val selected = jobConcurrency == n
                        val onClick = { chooseJobConcurrency(n) }
                        if (selected) {
                            Button(
                                onClick = onClick,
                                modifier = Modifier.weight(1f).height(44.dp),
                                shape = RoundedCornerShape(12.dp),
                                contentPadding = PaddingValues(0.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Accent)
                            ) {
                                Text("$n", color = DarkBg, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                        } else {
                            OutlinedButton(
                                onClick = onClick,
                                modifier = Modifier.weight(1f).height(44.dp),
                                shape = RoundedCornerShape(12.dp),
                                contentPadding = PaddingValues(0.dp),
                                border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                            ) {
                                Text("$n", color = TextSecondary, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    "يترجم عدة ملفات في وقت واحد على المحرك المحلي — أسرع للمكتبة، واختر ١ لتبريد الجهاز.",
                    color = TextMuted,
                    fontSize = 11.sp,
                    lineHeight = 16.sp
                )
            }
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
                        OutlinedButton(
                            onClick = {
                                copyToClipboard(context, buildSingleCommand(item.fullPath))
                                Toast.makeText(context, "تم نسخ أمر هذا الملف", Toast.LENGTH_SHORT).show()
                            },
                            modifier = Modifier.height(Space.touch),
                            shape = RoundedCornerShape(12.dp),
                            contentPadding = PaddingValues(horizontal = Space.md),
                            border = androidx.compose.foundation.BorderStroke(1.dp, Accent.copy(alpha = 0.45f))
                        ) {
                            Icon(
                                Icons.Default.ContentCopy,
                                contentDescription = null,
                                tint = AccentText,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(Space.xs))
                            Text("نسخ", color = AccentText, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        }

                        Spacer(modifier = Modifier.width(Space.xs))

                        Button(
                            onClick = { launchTermuxEngine(context, singleFile = item.fullPath) },
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
    fun TermuxSetupDialog(onDismiss: () -> Unit) {
        val context = LocalContext.current
        // same idempotent commands as the wizard — one source of truth
        val foldersKey = folders.joinToString { it.rawPath }
        val steps = remember(foldersKey) { buildWizardSteps(folders.map { it.rawPath }) }

        AlertDialog(
            onDismissRequest = onDismiss,
            containerColor = DarkSurface,
            shape = RoundedCornerShape(20.dp),
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Settings, contentDescription = null, tint = Gold500, modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("دليل إعداد تيرمكس", color = Gold500, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                }
            },
            text = {
                LazyColumn {
                    item {
                        Card(
                            colors = CardDefaults.cardColors(containerColor = WarnAmber.copy(alpha = 0.1f)),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp)
                        ) {
                            Column(modifier = Modifier.padding(14.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.Info, contentDescription = null, tint = WarnAmber, modifier = Modifier.size(20.dp))
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text("مهم", fontWeight = FontWeight.Bold, color = TextPrimary)
                                }
                                Spacer(modifier = Modifier.height(6.dp))
                                Text("لا تقم بتثبيت تيرمكس من متجر بلاي. قم بتثبيته من F-Droid.", color = TextSecondary, fontSize = 13.sp)
                                Spacer(modifier = Modifier.height(10.dp))
                                Button(
                                    onClick = {
                                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/com.termux/"))
                                        context.startActivity(intent)
                                    },
                                    shape = RoundedCornerShape(10.dp),
                                    colors = ButtonDefaults.buttonColors(containerColor = InfoCyan)
                                ) {
                                    Text("تحميل تيرمكس من F-Droid", color = DarkBg, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }

                    steps.forEach { step ->
                        if (step.opensPicker) {
                            item {
                                Button(
                                    onClick = {
                                        folderPickerLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE))
                                    },
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 8.dp),
                                    shape = RoundedCornerShape(10.dp),
                                    colors = ButtonDefaults.buttonColors(containerColor = Accent)
                                ) {
                                    Icon(
                                        Icons.Default.Movie,
                                        contentDescription = null,
                                        tint = DarkBg,
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(modifier = Modifier.width(Space.sm))
                                    Text("اختيار مجلد أفلام / مسلسلات", color = DarkBg, fontWeight = FontWeight.Bold)
                                }
                            }
                        } else if (step.actions.isNotEmpty()) {
                            // step 3 is three functions in the wizard — name them here
                            item {
                                Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                                    Text(step.title, color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                    Spacer(modifier = Modifier.height(6.dp))
                                    step.actions.forEach { action ->
                                        Row(
                                            modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
                                            verticalAlignment = Alignment.CenterVertically
                                        ) {
                                            Icon(action.icon, contentDescription = null, tint = action.accent, modifier = Modifier.size(15.dp))
                                            Spacer(modifier = Modifier.width(8.dp))
                                            Text(action.title, color = TextSecondary, fontSize = 13.sp)
                                        }
                                    }
                                    Spacer(modifier = Modifier.height(6.dp))
                                    Text("افتح «الإعداد خطوة بخطوة» لتشغيل أي زر منها.", color = TextMuted, fontSize = 12.sp)
                                }
                            }
                        } else if (step.command.isNotEmpty()) {
                            item { SetupStep(step.title, step.command, context) }
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = onDismiss,
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Gold500)
                ) {
                    Text("إغلاق", color = DarkBg, fontWeight = FontWeight.Bold)
                }
            }
        )
    }

    @Composable
    fun SetupStep(title: String, command: String, context: Context) {
        Column(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth()) {
            Text(title, color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Spacer(modifier = Modifier.height(6.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(DarkBg, RoundedCornerShape(10.dp))
                    .border(1.dp, DarkBorder, RoundedCornerShape(10.dp))
                    .clickable {
                        copyToClipboard(context, command)
                        Toast.makeText(context, "تم نسخ الأمر!", Toast.LENGTH_SHORT).show()
                    }
                    .padding(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    command,
                    color = SuccessGreen,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(modifier = Modifier.width(Space.sm))
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = Accent.copy(alpha = 0.16f),
                    modifier = Modifier
                        .clickable {
                            copyToClipboard(context, command)
                            Toast.makeText(context, "تم نسخ الأمر", Toast.LENGTH_SHORT).show()
                        }
                ) {
                    Text(
                        "نسخ",
                        color = AccentText,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = Space.md, vertical = Space.sm)
                    )
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
