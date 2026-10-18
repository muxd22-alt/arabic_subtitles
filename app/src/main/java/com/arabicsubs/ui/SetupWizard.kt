package com.arabicsubs.ui

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arabicsubs.engine.EngineMode
import com.arabicsubs.engine.EngineService
import com.arabicsubs.engine.EngineStatus
import com.arabicsubs.storage.AllFilesAccess
import com.arabicsubs.ui.theme.*

enum class WizardStepKind { ACCESS, FOLDER, MODEL }

data class WizardStep(
    val title: String,
    val hint: String,
    val kind: WizardStepKind
)

/**
 * Three real steps, all inside the app: grant access, choose the media folder,
 * then download the model. Nothing here asks for a command or a terminal — the
 * engine runs as a foreground service.
 */
fun buildWizardSteps(): List<WizardStep> = listOf(
    WizardStep(
        title = "١ — السماح بالوصول إلى ملفاتك",
        hint = "يحتاج التطبيق إلى «الوصول إلى جميع الملفات» ليقرأ أفلامك ويكتب ملف الترجمة بجانبها على الجهاز.",
        kind = WizardStepKind.ACCESS
    ),
    WizardStep(
        title = "٢ — اختر مجلد الأفلام",
        hint = "اختر مجلد الأفلام أو المسلسلات. يمكنك إضافة أكثر من مجلد من الشاشة الرئيسية.",
        kind = WizardStepKind.FOLDER
    ),
    WizardStep(
        title = "٣ — نزّل النموذج",
        hint = "ينزّل نموذج الترجمة والنسخ الصوتي (~١٫٢ جيجابايت) إلى مجلد ArabicSubs. يستغرق بضع دقائق حسب سرعة الاتصال.",
        kind = WizardStepKind.MODEL
    )
)

@Composable
fun SetupWizard(
    mediaPaths: List<String>,
    onPickFolders: () -> Unit = {},
    onDismiss: () -> Unit,
    onCompleted: () -> Unit = {}
) {
    val context = LocalContext.current
    val steps = remember { buildWizardSteps() }
    var index by remember { mutableStateOf(0) }
    val step = steps[index]
    val isLast = index == steps.lastIndex
    val status by EngineService.status.collectAsState()

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = DarkSurface,
        shape = RoundedCornerShape(20.dp),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "الإعداد خطوة بخطوة",
                    color = AccentText,
                    fontWeight = FontWeight.Black,
                    fontSize = 19.sp
                )
                Spacer(modifier = Modifier.weight(1f))
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "إغلاق", tint = TextSecondary)
                }
            }
        },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {

                LinearProgressIndicator(
                    progress = (index + 1f) / steps.size,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp)),
                    color = Accent,
                    trackColor = DarkCardHigh
                )

                Spacer(modifier = Modifier.height(Space.sm))
                Text(
                    "الخطوة ${index + 1} من ${steps.size}",
                    color = TextMuted,
                    fontSize = 12.sp
                )

                // more room above the heading than below it
                Spacer(modifier = Modifier.height(Space.lg))
                Text(step.title, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Spacer(modifier = Modifier.height(Space.xs))
                Text(step.hint, color = TextSecondary, fontSize = 13.sp, lineHeight = 19.sp)

                Spacer(modifier = Modifier.height(Space.lg))

                when (step.kind) {
                    WizardStepKind.ACCESS -> AccessStep(context)
                    WizardStepKind.FOLDER -> FolderStep(mediaPaths, onPickFolders)
                    WizardStepKind.MODEL -> ModelStep(context, mediaPaths, status)
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (index > 0) {
                    OutlinedButton(
                        onClick = { index-- },
                        shape = RoundedCornerShape(10.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                    ) {
                        Text("السابق", color = TextSecondary, fontWeight = FontWeight.Bold)
                    }
                }
                Button(
                    onClick = {
                        if (isLast) {
                            onCompleted()
                            onDismiss()
                        } else {
                            index++
                        }
                    },
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = if (isLast) SuccessGreen else Gold500)
                ) {
                    Text(if (isLast) "تم ✓" else "التالي", color = DarkBg, fontWeight = FontWeight.Bold)
                }
            }
        }
    )
}

@Composable
private fun AccessStep(context: Context) {
    // AllFilesAccess is not Compose state, so re-read it on demand
    var refresh by remember { mutableStateOf(0) }
    val granted = remember(refresh) { AllFilesAccess.granted(context) }

    StatusLine(
        color = if (granted) SuccessGreen else WarnAmber,
        text = if (granted) "تم منح الوصول إلى الملفات" else "لم يُمنح الوصول بعد"
    )

    Spacer(modifier = Modifier.height(Space.md))

    Button(
        onClick = { context.startActivity(AllFilesAccess.settingsIntent(context)) },
        modifier = Modifier.fillMaxWidth().height(Space.touch),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Accent)
    ) {
        Icon(Icons.Default.Settings, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.width(Space.sm))
        Text("فتح إعدادات الوصول", color = DarkBg, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }

    Spacer(modifier = Modifier.height(Space.xs))

    TextButton(onClick = { refresh++ }) {
        Icon(Icons.Default.Refresh, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(16.dp))
        Spacer(modifier = Modifier.width(Space.xs))
        Text("تحقّق مرة أخرى بعد المنح", color = TextSecondary, fontSize = 13.sp)
    }
}

@Composable
private fun FolderStep(mediaPaths: List<String>, onPickFolders: () -> Unit) {
    Button(
        onClick = onPickFolders,
        modifier = Modifier.fillMaxWidth().height(Space.touch),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Gold500)
    ) {
        Icon(Icons.Default.Movie, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.width(Space.sm))
        Text("اختيار مجلد أفلام / مسلسلات", color = DarkBg, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }

    Spacer(modifier = Modifier.height(Space.md))

    if (mediaPaths.isEmpty()) {
        Text("لم تختر مجلداً بعد.", color = TextMuted, fontSize = 12.sp)
    } else {
        mediaPaths.forEach { path ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = Space.xxs),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Default.Check, contentDescription = null, tint = SuccessGreen, modifier = Modifier.size(15.dp))
                Spacer(modifier = Modifier.width(Space.sm))
                Text(
                    path,
                    color = TextSecondary,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun ModelStep(context: Context, mediaPaths: List<String>, status: EngineStatus) {
    val running = status.running

    Button(
        onClick = {
            when {
                mediaPaths.isEmpty() ->
                    Toast.makeText(context, "اختر مجلداً أولاً", Toast.LENGTH_SHORT).show()
                !AllFilesAccess.granted(context) -> {
                    Toast.makeText(context, "امنح الوصول إلى الملفات أولاً", Toast.LENGTH_SHORT).show()
                    context.startActivity(AllFilesAccess.settingsIntent(context))
                }
                else -> EngineService.start(context, EngineMode.Setup(mediaPaths.first()))
            }
        },
        enabled = !running,
        modifier = Modifier.fillMaxWidth().height(Space.touch),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen)
    ) {
        Icon(Icons.Default.Download, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.width(Space.sm))
        Text(
            if (running) "جاري التنزيل..." else "نزّل النموذج",
            color = DarkBg,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold
        )
    }

    Spacer(modifier = Modifier.height(Space.md))

    when {
        running -> {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
                color = Accent,
                trackColor = DarkCardHigh
            )
            Spacer(modifier = Modifier.height(Space.sm))
            Text(
                status.lastLine ?: status.stage ?: "جاري تجهيز التنزيل...",
                color = TextSecondary,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
        status.failedToStart != null ->
            StatusLine(ErrorRose, "تعذّر البدء: ${status.failedToStart}")
        status.exitCode == 0 ->
            StatusLine(SuccessGreen, "تم تنزيل النموذج بنجاح")
        status.exitCode != null ->
            StatusLine(ErrorRose, "انتهى التنزيل بخطأ (رمز ${status.exitCode})")
        else ->
            Text("لم يبدأ التنزيل بعد.", color = TextMuted, fontSize = 12.sp)
    }
}

@Composable
private fun StatusLine(color: Color, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(modifier = Modifier.size(10.dp).background(color, CircleShape))
        Spacer(modifier = Modifier.width(Space.sm))
        Text(text, color = color, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}
