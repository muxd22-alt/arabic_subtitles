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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.documentfile.provider.DocumentFile
import com.arabicsubs.engine.EngineMode
import com.arabicsubs.engine.EngineService
import com.arabicsubs.storage.AllFilesAccess
import com.arabicsubs.ui.theme.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    private var showWizard by mutableStateOf(false)
    // translation parallelism + llama slots for the one movie being worked on
    private var slots by mutableStateOf(2)

    // the wizard only auto-opens the very first time, never again after "تم"
    private val prefs by lazy { getSharedPreferences("arabic_subs", Context.MODE_PRIVATE) }

    private val threads: Int
        get() = Runtime.getRuntime().availableProcessors().coerceIn(1, 8)

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
        slots = prefs.getInt("slots", 2).coerceIn(1, 4)
        // first launch → straight into the setup walkthrough
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
                                            "v2.3",
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
        scanFolders()
    }

    // ── Engine launch ─────────────────────────────────────────────────

    /** Translation parallelism + llama slots for the single movie being worked on. */
    private fun chooseSlots(n: Int) {
        slots = n.coerceIn(1, 4)
        prefs.edit().putInt("slots", slots).apply()
    }

    private fun runAllFolders(context: Context) {
        if (folders.isEmpty()) {
            Toast.makeText(context, "اختر مجلداً أولاً", Toast.LENGTH_SHORT).show()
            return
        }
        if (!ensureAllFilesAccess(context)) return
        EngineService.start(context, EngineMode.Run(folders.map { it.rawPath }, slots, threads))
        Toast.makeText(context, "بدأت الترجمة", Toast.LENGTH_SHORT).show()
    }

    private fun runSingleFile(context: Context, path: String) {
        if (!ensureAllFilesAccess(context)) return
        EngineService.start(context, EngineMode.Process(path, slots, threads))
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
        val status by EngineService.status.collectAsState()
        val (label, accent) = when {
            status.failedToStart != null -> "المحرك: تعذّر التشغيل" to ErrorRose
            status.running && !status.stage.isNullOrEmpty() -> "المحرك: يعمل — ${status.stage}" to SuccessGreen
            status.running -> "المحرك: يعمل" to SuccessGreen
            status.exitCode == 0 -> "المحرك: انتهى بنجاح" to InfoCyan
            status.exitCode != null -> "المحرك: انتهى (رمز ${status.exitCode})" to ErrorRose
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
                    Text("توازي الترجمة", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.weight(1f))
                    Text("$slots", color = TextMuted, fontSize = 11.sp)
                }
                Spacer(modifier = Modifier.height(10.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    (1..4).forEach { n ->
                        val selected = slots == n
                        val onClick = { chooseSlots(n) }
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
                    "يضبط عدد المقاطع المترجمة بالتوازي داخل الفيلم الواحد وعدد فتحات llama — الجودة نفسها لكن أسرع. اختر ١ لتقليل استهلاك الجهاز.",
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
