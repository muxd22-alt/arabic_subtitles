package com.arabicsubs.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arabicsubs.engine.EngineService
import com.arabicsubs.ui.theme.*

/**
 * Everything that is configuration rather than everyday use, in the same order
 * the first-run walkthrough asks for it. The dashboard stays for the library and
 * the run controls, so this screen is the only place these knobs live.
 */
@Composable
fun SettingsScreen(
    folders: List<MainActivity.MediaFolder>,
    parallelism: Int,
    maxParallelism: Int,
    onAddFolder: () -> Unit,
    onRemoveFolder: (MainActivity.MediaFolder) -> Unit,
    onChooseSlots: (Int) -> Unit,
    onOpenWizard: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val status by EngineService.status.collectAsState()
    val mediaPaths = folders.map { it.rawPath }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = Space.screen, vertical = Space.lg)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) {
                Icon(Icons.Default.ArrowBack, contentDescription = "رجوع", tint = AccentText)
            }
            Spacer(modifier = Modifier.width(Space.sm))
            Text("الإعدادات", color = AccentText, fontWeight = FontWeight.Black, fontSize = 22.sp)
            Spacer(modifier = Modifier.weight(1f))
            TextButton(onClick = onOpenWizard) {
                Icon(Icons.Default.List, contentDescription = null, tint = Accent, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(Space.xs))
                Text("الإعداد خطوة بخطوة", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }

        Spacer(modifier = Modifier.height(Space.md))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
        ) {
            SettingsSection(
                number = 1,
                title = "الوصول إلى الملفات",
                hint = "يقرأ التطبيق أفلامك ويكتب ملف الترجمة بجانبها على الجهاز."
            ) {
                AccessStep(context)
            }

            SettingsSection(
                number = 2,
                title = "مكتبتي — مجلدات الأفلام والمسلسلات",
                hint = "أضف مجلداً جديداً لتغيير مكان مكتبتك، أو أزل مجلداً لم تعد تريده."
            ) {
                LibrarySection(folders, onAddFolder, onRemoveFolder)
            }

            SettingsSection(
                number = 3,
                title = "النموذج",
                hint = "نزّل نموذج الترجمة والنسخ الصوتي (~١٫٢ جيجابايت) إلى مجلد ArabicSubs. مرة واحدة تكفي."
            ) {
                ModelStep(context, mediaPaths, status)
            }

            SettingsSection(
                number = 4,
                title = "توازي الترجمة",
                hint = "رقم واحد يضبط كل شيء: كم مقطعاً يُنسخ صوتياً في الوقت نفسه، وكم جملة تُترجم في الوقت نفسه، وكم فتحة llama تخدمها. اختر ١ لأقل استهلاك، أو ارفعه حتى $maxParallelism (عدد أنوية جهازك) لسرعة أكبر وحرارة أعلى. النسخ الصوتي يتوقف عند نصف عدد الأنوية ويمنح كل مقطع خيطين على الأقل، لأن تشغيل نسخ أكثر من ذلك يجعل كل مقطع أبطأ لا أسرع."
            ) {
                ParallelismSelector(parallelism, maxParallelism, onChooseSlots)
            }

            Spacer(modifier = Modifier.height(Space.xl))
        }
    }
}

/** A numbered card: the number is what makes the screen read as a sequence. */
@Composable
private fun SettingsSection(
    number: Int,
    title: String,
    hint: String?,
    content: @Composable () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(bottom = Space.md),
        colors = CardDefaults.cardColors(containerColor = DarkCard),
        shape = RoundedCornerShape(14.dp)
    ) {
        Column(modifier = Modifier.padding(Space.md)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .background(Accent.copy(alpha = 0.18f), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Text("$number", color = AccentText, fontSize = 12.sp, fontWeight = FontWeight.Black)
                }
                Spacer(modifier = Modifier.width(Space.sm))
                Text(title, color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            }

            if (hint != null) {
                Spacer(modifier = Modifier.height(Space.xs))
                Text(hint, color = TextMuted, fontSize = 12.sp, lineHeight = 17.sp)
            }

            Spacer(modifier = Modifier.height(Space.md))
            content()
        }
    }
}

/** Add a folder, and see (and prune) the ones already in the library. */
@Composable
private fun LibrarySection(
    folders: List<MainActivity.MediaFolder>,
    onAdd: () -> Unit,
    onRemove: (MainActivity.MediaFolder) -> Unit
) {
    Button(
        onClick = onAdd,
        modifier = Modifier.fillMaxWidth().height(Space.touch),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Accent)
    ) {
        Icon(Icons.Default.Movie, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.width(Space.sm))
        Text("إضافة مجلد أفلام / مسلسلات", color = DarkBg, fontSize = 14.sp, fontWeight = FontWeight.Bold)
    }

    Spacer(modifier = Modifier.height(Space.md))

    if (folders.isEmpty()) {
        Text("لم تُضف مجلدات بعد.", color = TextMuted, fontSize = 12.sp)
    } else {
        folders.forEach { folder ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = Space.xxs),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(modifier = Modifier.size(8.dp).background(SuccessGreen, CircleShape))
                Spacer(modifier = Modifier.width(Space.sm))
                Text(
                    folder.rawPath,
                    color = TextSecondary,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                IconButton(onClick = { onRemove(folder) }) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = "إزالة ${folder.displayName}",
                        tint = TextSecondary,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }
    }
}

/**
 * Translation parallelism: how many chunks are transcribed at once, how many are
 * translated at once, and how many llama slots back them — all in one choice.
 * The ceiling is the device's core count, so the phone is never asked to do more
 * at once than it has cores for. Transcription caps itself lower than that
 * (half the cores, at least two threads per chunk): whisper.cpp is memory
 * bandwidth bound and loads the whole model per process, so more concurrent
 * transcriptions make every chunk slower, not the file faster.
 */
@Composable
fun ParallelismSelector(parallelism: Int, maxParallelism: Int, onSelect: (Int) -> Unit) {
    val ceiling = maxParallelism.coerceAtLeast(1)

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Settings, contentDescription = null, tint = Accent, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(Space.sm))
            Text("عدد المهام المتوازية", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.weight(1f))
            Text("$parallelism من $ceiling", color = TextMuted, fontSize = 11.sp)
        }

        Spacer(modifier = Modifier.height(Space.md))

        // Up to 8 options per row; scroll horizontally when the device has more.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Space.sm)
        ) {
            (1..ceiling).forEach { n ->
                val selected = parallelism == n
                val label: @Composable () -> Unit = {
                    Text(
                        "$n",
                        color = if (selected) DarkBg else TextSecondary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp
                    )
                }
                if (selected) {
                    Button(
                        onClick = { onSelect(n) },
                        modifier = Modifier.width(52.dp).height(44.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(0.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Accent),
                        content = { label() }
                    )
                } else {
                    OutlinedButton(
                        onClick = { onSelect(n) },
                        modifier = Modifier.width(52.dp).height(44.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(0.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        content = { label() }
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(Space.sm))
        Text(
            if (parallelism >= ceiling) {
                "على أقصى سرعة — الجهاز سيصبح ساخناً أثناء العمل."
            } else {
                "زيادة الرقم = ترجمة أسرع وجهاز أسخن."
            },
            color = if (parallelism >= ceiling) WarnAmber else TextMuted,
            fontSize = 11.sp,
            lineHeight = 16.sp
        )
    }
}
