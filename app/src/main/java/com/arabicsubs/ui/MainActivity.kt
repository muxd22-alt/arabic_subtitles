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
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
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

    // engine status polled from the node status server (127.0.0.1:18435)
    private var engineState by mutableStateOf<EngineStatus?>(null)
    private var statusJob: Job? = null

    data class EngineStatus(
        val running: Boolean,
        val model: String,
        val current: String?,
        val done: Int,
        val failed: Int,
        val pending: Int
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startStatusPolling()
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
                                        color = Gold500,
                                        fontWeight = FontWeight.Black,
                                        fontSize = 24.sp
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Surface(
                                        shape = RoundedCornerShape(6.dp),
                                        color = Gold500.copy(alpha = 0.15f),
                                    ) {
                                        Text(
                                            "v1.0.0",
                                            color = Gold500,
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold,
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                        )
                                    }
                                }
                            },
                            actions = {
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
                pending = queue?.optInt("pending") ?: 0
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

    private fun buildRunCommand(): String {
        val mediaArgs = folders.joinToString(" ") { "--media \"${it.rawPath}\"" }
        return "cd ~/arabic_subtitles && node bin/arabic-subs.js run $mediaArgs"
    }

    private fun launchTermuxEngine(context: Context, singleFile: String? = null) {
        if (folders.isEmpty()) {
            Toast.makeText(context, "اختر مجلداً أولاً", Toast.LENGTH_SHORT).show()
            return
        }
        val cmd = if (singleFile != null) {
            "cd ~/arabic_subtitles && node bin/arabic-subs.js translate \"$singleFile\""
        } else {
            buildRunCommand()
        }

        try {
            val runIntent = Intent("com.termux.RUN_COMMAND").apply {
                setClassName("com.termux", "com.termux.app.RunCommandService")
                putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", cmd))
                putExtra("com.termux.RUN_COMMAND_BACKGROUND", false)
            }
            context.startService(runIntent)
            Toast.makeText(context, "🚀 تم إرسال الأمر إلى تيرمكس", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            val launchIntent = context.packageManager.getLaunchIntentForPackage("com.termux")
            if (launchIntent != null) {
                copyToClipboard(context, cmd)
                context.startActivity(launchIntent)
                Toast.makeText(context, "📋 تم نسخ الأمر — الصقه في تيرمكس", Toast.LENGTH_LONG).show()
            } else {
                Toast.makeText(context, "❌ الرجاء تثبيت تيرمكس أولاً", Toast.LENGTH_SHORT).show()
                showSetupDialog = true
            }
        }
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
                    newItems.add(
                        MediaItemStatus(
                            name = base,
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
                modifier = Modifier.fillMaxWidth().height(56.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Gold500),
                elevation = ButtonDefaults.buttonElevation(defaultElevation = 4.dp)
            ) {
                Text("📂  إضافة مجلد أفلام / مسلسلات", fontSize = 17.sp, fontWeight = FontWeight.Bold, color = DarkBg)
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
                                    onClick = { folders.remove(folder); scanFolders() },
                                    modifier = Modifier.size(28.dp)
                                ) {
                                    Icon(Icons.Default.Close, contentDescription = "إزالة", tint = TextMuted, modifier = Modifier.size(14.dp))
                                }
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            EngineStatusCard()

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
                    StatCard("مكتمل ✅", achievedCount, SuccessGreen, SuccessGreen.copy(alpha = 0.12f), Modifier.weight(1f))
                    StatCard("بالانتظار ⏳", pendingCount, WarnAmber, WarnAmber.copy(alpha = 0.12f), Modifier.weight(1f))
                    StatCard("متخطى ⏭️", skippedCount, InfoCyan, InfoCyan.copy(alpha = 0.12f), Modifier.weight(1f))
                }

                Spacer(modifier = Modifier.height(14.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Button(
                        onClick = { launchTermuxEngine(context) },
                        modifier = Modifier.weight(1f).height(50.dp),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen),
                        elevation = ButtonDefaults.buttonElevation(defaultElevation = 2.dp)
                    ) {
                        Icon(Icons.Default.PlayArrow, contentDescription = null, tint = DarkBg, modifier = Modifier.size(20.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("تشغيل المحرك", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = DarkBg)
                    }

                    OutlinedButton(
                        onClick = { scanFolders() },
                        modifier = Modifier.weight(1f).height(50.dp),
                        shape = RoundedCornerShape(12.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                    ) {
                        Icon(Icons.Default.Refresh, contentDescription = null, tint = InfoCyan, modifier = Modifier.size(20.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("إعادة الفحص", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = InfoCyan)
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))
                Divider(color = DarkBorder, thickness = 1.dp)
                Spacer(modifier = Modifier.height(10.dp))

                if (itemList.isEmpty()) {
                    Spacer(modifier = Modifier.height(40.dp))
                    Text("اختر مجلد الأفلام أو المسلسلات لبدء الفحص", color = TextMuted, fontSize = 15.sp)
                } else {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        val grouped = itemList.groupBy { it.folderName }
                        grouped.forEach { (folder, folderItems) ->
                            item {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text("📁", fontSize = 16.sp)
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(folder, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                                    Spacer(modifier = Modifier.weight(1f))
                                    Surface(shape = RoundedCornerShape(6.dp), color = DarkCardHigh) {
                                        Text(
                                            "${folderItems.size} ملف",
                                            color = TextMuted,
                                            fontSize = 11.sp,
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                        )
                                    }
                                }
                            }
                            items(folderItems) { item -> MediaItemRow(context, item) }
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
                        },
                        modifier = Modifier.size(34.dp)
                    ) {
                        Icon(
                            if (item.isSkipped) Icons.Default.Refresh else Icons.Default.Close,
                            contentDescription = if (item.isSkipped) "إلغاء التخطي" else "تخطي",
                            tint = if (item.isSkipped) InfoCyan else WarnAmber,
                            modifier = Modifier.size(18.dp)
                        )
                    }

                    if (!item.isSkipped) {
                        IconButton(
                            onClick = { launchTermuxEngine(context) },
                            modifier = Modifier.size(34.dp)
                        ) {
                            Icon(Icons.Default.PlayArrow, contentDescription = "ترجمة", tint = SuccessGreen, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
        }
    }

    @Composable
    fun TermuxSetupDialog(onDismiss: () -> Unit) {
        val context = LocalContext.current

        AlertDialog(
            onDismissRequest = onDismiss,
            containerColor = DarkSurface,
            shape = RoundedCornerShape(20.dp),
            title = { Text("⚙️ دليل إعداد تيرمكس", color = Gold500, fontWeight = FontWeight.Bold, fontSize = 20.sp) },
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
                                    Text("⚠️ هام", fontWeight = FontWeight.Bold, color = TextPrimary)
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

                    item { SetupStep("1️⃣  منح إذن التخزين", "termux-setup-storage", context) }
                    item { SetupStep("2️⃣  تثبيت الحزمة", "pkg update && pkg install nodejs ffmpeg -y", context) }
                    item { SetupStep("3️⃣  تحميل المشروع", "git clone https://github.com/muxd22-alt/arabic_subtitles.git && cd arabic_subtitles && npm install", context) }
                    item { SetupStep("4️⃣  الإعداد (تحميل النماذج)", "cd ~/arabic_subtitles && bash scripts/setup-termux.sh", context) }
                    item { SetupStep("5️⃣  تشغيل المحرك", buildRunCommand(), context) }
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
                        Toast.makeText(context, "✅ تم نسخ الأمر!", Toast.LENGTH_SHORT).show()
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
                Spacer(modifier = Modifier.width(8.dp))
                Surface(shape = RoundedCornerShape(6.dp), color = Gold500.copy(alpha = 0.2f)) {
                    Text("نسخ", color = Gold500, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
                }
            }
        }
    }

    @Composable
    fun StatCard(title: String, count: Int, accentColor: Color, bgColor: Color, modifier: Modifier = Modifier) {
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
                Text(title, color = accentColor.copy(alpha = 0.8f), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}
