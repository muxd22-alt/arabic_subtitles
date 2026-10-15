package com.arabicsubs.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arabicsubs.ui.theme.*

data class WizardStep(
    val title: String,
    val hint: String,
    val command: String,
    val runsEngine: Boolean = false,
    val opensPicker: Boolean = false,
    val actions: List<WizardAction> = emptyList()
)

/** One tappable function: what it does, and the two ways to fire it. */
data class WizardAction(
    val title: String,
    val subtitle: String,
    val command: String,
    val icon: ImageVector,
    val accent: Color,
    val enabled: Boolean = true,
    val runsEngine: Boolean = false
)

const val SETUP_ONE_LINER =
    "pkg install -y curl; " +
        "curl -fsSL -o ArabicSubs.sh https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/ArabicSubs.sh; " +
        "bash ArabicSubs.sh"

/**
 * Three steps, that's all: one command in Termux that does everything, then
 * back here to choose the folders, then three functions to actually use the app.
 *
 * Everything in step 1 is idempotent, so running it again reports
 * "already … — skipping" instead of prompting through the same questions.
 *
 * Step 3 never asks anyone to compile llama.cpp: the engine is a verified
 * 16 MB prebuilt that setup downloads, so "fix the engine" is one command and
 * a few seconds. ARABIC_SUBS_FORCE_LLAMA_BUILD=1 still exists for the rare
 * phone that needs a source build, but the app never suggests it.
 *
 * No `||` and no pipe: a couple of Android clipboards have been observed
 * eating those tokens while copying, which turned `A || B` into `A  B`.
 */
fun buildWizardSteps(mediaPaths: List<String>, suggestedFile: String? = null): List<WizardStep> {
    val media = (if (mediaPaths.isEmpty()) listOf("/sdcard/Movies") else mediaPaths)
        .joinToString(" ") { "--media \"$it\"" }

    val actions = listOf(
        WizardAction(
            title = "تثبيت / إصلاح المحرك",
            subtitle = "ينزّل محرك llama-server الجاهز (16MB، متحقق من sha256) ويشغّله — بدون أي بناء على الهاتف.",
            command = "cd ~/arabic_subtitles && git pull --ff-only 2>/dev/null; bash scripts/setup-termux.sh",
            icon = Icons.Default.Build,
            accent = InfoCyan
        ),
        WizardAction(
            title = "تشغيل قائمة الانتظار",
            subtitle = "يترجم كل ما هو بانتظار الترجمة في مجلداتك، ملفاً ملفاً.",
            command = "cd ~/arabic_subtitles && node bin/arabic-subs.js run $media",
            icon = Icons.Default.PlayArrow,
            accent = SuccessGreen,
            runsEngine = true
        ),
        WizardAction(
            title = "ترجمة ملف واحد",
            subtitle = if (suggestedFile != null) {
                "يشغّل أول ملف بانتظار الترجمة مباشرة."
            } else {
                "لا يوجد ملف بانتظار الترجمة — أضف مجلداً أو نظّف القائمة أولاً."
            },
            command = if (suggestedFile != null) {
                "cd ~/arabic_subtitles && node bin/arabic-subs.js process \"$suggestedFile\""
            } else {
                ""
            },
            icon = Icons.Default.Movie,
            accent = Accent,
            enabled = suggestedFile != null,
            runsEngine = true
        )
    )

    return listOf(
        WizardStep(
            title = "١ — أمر واحد في تيرمكس",
            hint = "ينزّل ملف ArabicSubs.sh ويشغّله: الحزم، الكود، محرك الترجمة الجاهز، whisper — ثم يسأل قبل تنزيل النموذجين معاً (~1.2 جيجابايت). يستغرق ٥ إلى ١٥ دقيقة، ويعاد تشغيله بأمان.",
            command = SETUP_ONE_LINER
        ),
        WizardStep(
            title = "٢ — اختر مجلداتك",
            hint = "عد إلى الشاشة الرئيسية وأضف مجلد الأفلام أو المسلسلات — أو اضغط الزر بالأسفل الآن. يمكنك إضافة أكثر من مجلد.",
            command = "",
            opensPicker = true
        ),
        WizardStep(
            title = "٣ — ثلاثة أزرار بدل أمر واحد",
            hint = "المحرك جاهز الآن. اختر ما تريد فعله: تثبيته أو إصلاحه، تشغيل القائمة كاملة، أو ترجمة ملف واحد.",
            command = "",
            actions = actions
        )
    )
}

fun runInTermux(context: Context, command: String): Boolean {
    return try {
        val intent = Intent("com.termux.RUN_COMMAND").apply {
            setClassName("com.termux", "com.termux.app.RunCommandService")
            putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", command))
            putExtra("com.termux.RUN_COMMAND_BACKGROUND", false)
        }
        context.startService(intent)
        true
    } catch (e: Exception) {
        false
    }
}

fun copyCommand(context: Context, command: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Arabic Subs", command))
}

/** One function in step 3: what it does, and the two ways to fire it. */
@Composable
fun WizardActionCard(
    action: WizardAction,
    onRun: () -> Unit,
    onCopy: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (action.enabled) DarkCard else DarkCard.copy(alpha = 0.45f)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .border(
                    1.dp,
                    if (action.enabled) action.accent.copy(alpha = 0.30f) else DarkBorder,
                    RoundedCornerShape(16.dp)
                )
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .background(
                        if (action.enabled) action.accent.copy(alpha = 0.15f) else DarkCardHigh,
                        RoundedCornerShape(12.dp)
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    action.icon,
                    contentDescription = null,
                    tint = if (action.enabled) action.accent else TextMuted,
                    modifier = Modifier.size(20.dp)
                )
            }

            Spacer(modifier = Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    action.title,
                    color = if (action.enabled) TextPrimary else TextMuted,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp
                )
                Spacer(modifier = Modifier.height(3.dp))
                Text(
                    action.subtitle,
                    color = TextSecondary,
                    fontSize = 12.sp,
                    lineHeight = 17.sp
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            if (action.enabled) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(
                        onClick = onCopy,
                        modifier = Modifier.size(Space.touch),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(0.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                    ) {
                        Icon(
                            Icons.Default.ContentCopy,
                            contentDescription = "نسخ أمر ${action.title}",
                            tint = TextSecondary,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                    Spacer(modifier = Modifier.width(Space.sm))
                    Button(
                        onClick = onRun,
                        modifier = Modifier.height(Space.touch),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = Space.md),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (action.runsEngine) action.accent else DarkCardHigh
                        )
                    ) {
                        Icon(
                            Icons.Default.PlayArrow,
                            contentDescription = null,
                            tint = DarkBg,
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(Space.xs))
                        Text("تشغيل", color = DarkBg, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
fun SetupWizard(
    mediaPaths: List<String>,
    autoCopy: Boolean,
    onAutoCopyChange: (Boolean) -> Unit,
    onPickFolders: () -> Unit = {},
    onDismiss: () -> Unit,
    onCompleted: () -> Unit = {},
    suggestedFile: String? = null
) {
    val context = LocalContext.current
    val steps = remember(mediaPaths, suggestedFile) { buildWizardSteps(mediaPaths, suggestedFile) }
    var index by remember { mutableStateOf(0) }
    var copied by remember { mutableStateOf(false) }
    var launchedTermux by remember { mutableStateOf(false) }
    val step = steps[index]
    val isLast = index == steps.lastIndex

    // auto-copy: every time a step shows a command, it lands on the clipboard
    LaunchedEffect(index, autoCopy) {
        copied = false
        if (autoCopy && step.command.isNotEmpty()) {
            copyCommand(context, step.command)
            copied = true
        }
    }

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

                if (step.opensPicker) {
                    // this step has no command — the app itself opens the folder picker
                    Button(
                        onClick = onPickFolders,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Gold500)
                    ) {
                        Icon(
                            Icons.Default.Movie,
                            contentDescription = null,
                            tint = DarkBg,
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(Space.sm))
                        Text(
                            "اختيار مجلد أفلام / مسلسلات",
                            color = DarkBg,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "أو من الشاشة الرئيسية: «إضافة مجلد» — أضف ما تشاء ثم عد إلى هذه النافذة.",
                        color = TextMuted,
                        fontSize = 12.sp,
                        lineHeight = 18.sp
                    )
                } else if (step.actions.isNotEmpty()) {
                    // step 3: three functions, each its own card with run / copy
                    step.actions.forEach { action ->
                        WizardActionCard(
                            action = action,
                            onRun = {
                                val ok = runInTermux(context, action.command)
                                if (ok) {
                                    Toast.makeText(context, "تم إرسال «${action.title}» إلى تيرمكس", Toast.LENGTH_SHORT).show()
                                } else {
                                    copyCommand(context, action.command)
                                    val launch = context.packageManager.getLaunchIntentForPackage("com.termux")
                                    if (launch != null) {
                                        context.startActivity(launch)
                                        Toast.makeText(context, "نُسخ الأمر — افتح تيرمكس والصقه", Toast.LENGTH_LONG).show()
                                    } else {
                                        Toast.makeText(context, "ثبّت تيرمكس من F-Droid أولاً", Toast.LENGTH_LONG).show()
                                    }
                                }
                            },
                            onCopy = {
                                copyCommand(context, action.command)
                                Toast.makeText(context, "نُسخ أمر «${action.title}»", Toast.LENGTH_SHORT).show()
                            }
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                    }
                    Text(
                        "«تثبيت / إصلاح المحرك» تكفي مرة واحدة — بعدها زر التشغيل يشتغل مباشرة.",
                        color = TextMuted,
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        modifier = Modifier.padding(top = 2.dp)
                    )
                } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(
                        checked = autoCopy,
                        onCheckedChange = onAutoCopyChange,
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = DarkBg,
                            checkedTrackColor = Gold500
                        )
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Text("نسخ تلقائي للأمر", color = TextSecondary, fontSize = 13.sp)
                }

                Spacer(modifier = Modifier.height(10.dp))

                // the single command line for this step
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(DarkBg, RoundedCornerShape(12.dp))
                        .border(1.dp, DarkBorder, RoundedCornerShape(12.dp))
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        step.command,
                        color = SuccessGreen,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.weight(1f),
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                AnimatedVisibility(visible = copied, enter = fadeIn(), exit = fadeOut()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Check, contentDescription = null, tint = SuccessGreen, modifier = Modifier.size(14.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("تم نسخ الأمر — الصقه في تيرمكس", color = SuccessGreen, fontSize = 12.sp)
                    }
                }

                Spacer(modifier = Modifier.height(6.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm)
                ) {
                    OutlinedButton(
                        onClick = {
                            copyCommand(context, step.command)
                            copied = true
                        },
                        modifier = Modifier.weight(1f).height(Space.touch),
                        shape = RoundedCornerShape(12.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                    ) {
                        Icon(
                            Icons.Default.ContentCopy,
                            contentDescription = null,
                            tint = TextPrimary,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(Space.xs))
                        Text("نسخ", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    }

                    Button(
                        onClick = {
                            val ok = runInTermux(context, step.command)
                            if (ok) {
                                launchedTermux = true
                                Toast.makeText(context, "تم إرسال الأمر إلى تيرمكس", Toast.LENGTH_SHORT).show()
                            } else {
                                copyCommand(context, step.command)
                                copied = true
                                val launch = context.packageManager.getLaunchIntentForPackage("com.termux")
                                if (launch != null) {
                                    context.startActivity(launch)
                                    Toast.makeText(context, "نُسخ الأمر — افتح تيرمكس والصقه", Toast.LENGTH_LONG).show()
                                } else {
                                    Toast.makeText(context, "ثبّت تيرمكس من F-Droid أولاً", Toast.LENGTH_LONG).show()
                                }
                            }
                        },
                        modifier = Modifier.weight(1.4f).height(Space.touch),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = if (step.runsEngine) SuccessGreen else Accent)
                    ) {
                        Icon(Icons.Default.PlayArrow, contentDescription = null, tint = DarkBg, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(Space.xs))
                        Text(
                            if (step.runsEngine) "تشغيل المحرك" else "تشغيل في تيرمكس",
                            color = DarkBg,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                if (launchedTermux) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "انتظر انتهاء الأمر ثم انتقل للخطوة التالية.",
                        color = WarnAmber,
                        fontSize = 12.sp
                    )
                }
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (index > 0) {
                    OutlinedButton(
                        onClick = { index--; launchedTermux = false },
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
                            launchedTermux = false
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
