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
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
    val runsEngine: Boolean = false
)

/**
 * The onboarding script: one command per step, always LTR.
 *
 * Every command is idempotent — running the wizard a second time (or the same
 * step twice) reports "already done" instead of prompting again, so the flow
 * never looks different from what the user saw the first time.
 * The last step is rebuilt from whatever folders the user picked.
 */
fun buildWizardSteps(mediaPaths: List<String>): List<WizardStep> {
    val media = (if (mediaPaths.isEmpty()) listOf("/sdcard/Movies") else mediaPaths)
        .joinToString(" ") { "--media \"$it\"" }

    return listOf(
        WizardStep(
            title = "منح إذن التخزين",
            hint = "مرة واحدة فقط. إن رأيت \"directory '~/storage' already exists\" اكتب n — الإذن ممنوح أصلاً.",
            command = "[ -e ~/storage/shared ] && echo \"storage: already linked\" || termux-setup-storage"
        ),
        WizardStep(
            title = "تثبيت الحزم المطلوبة",
            hint = "Node.js لتشغيل المحرك و ffmpeg لاستخراج الصوت — يتجاهل ما هو مثبت بالفعل.",
            command = "pkg install -y nodejs ffmpeg"
        ),
        WizardStep(
            title = "تحميل المشروع",
            hint = "ينسخ الكود أول مرة، ويجري git pull لتحديثه في المرة القادمة، ثم يثبّت الحزم.",
            command = "if [ ! -d ~/arabic_subtitles ]; then git clone https://github.com/muxd22-alt/arabic_subtitles.git; fi; cd ~/arabic_subtitles && git pull --ff-only; npm install"
        ),
        WizardStep(
            title = "الأدوات والنماذج",
            hint = "يثبّت llama-server و whisper وينزّل النماذج (~590MB) بعد موافقتك — يتخطّى ما هو جاهز.",
            command = "cd ~/arabic_subtitles && bash scripts/setup-termux.sh"
        ),
        WizardStep(
            title = "تشغيل المحرك",
            hint = "يبدأ الفحص والترجمة التلقائية لمجلداتك المختارة.",
            command = "cd ~/arabic_subtitles && node bin/arabic-subs.js run $media",
            runsEngine = true
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

@Composable
fun SetupWizard(
    mediaPaths: List<String>,
    autoCopy: Boolean,
    onAutoCopyChange: (Boolean) -> Unit,
    onDismiss: () -> Unit,
    onCompleted: () -> Unit = {}
) {
    val context = LocalContext.current
    val steps = remember(mediaPaths) { buildWizardSteps(mediaPaths) }
    var index by remember { mutableStateOf(0) }
    var copied by remember { mutableStateOf(false) }
    var launchedTermux by remember { mutableStateOf(false) }
    val step = steps[index]
    val isLast = index == steps.lastIndex

    // auto-copy: every time a step is shown, its command lands on the clipboard
    LaunchedEffect(index, autoCopy) {
        copied = false
        if (autoCopy) {
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
                    color = Gold500,
                    fontWeight = FontWeight.Black,
                    fontSize = 19.sp
                )
                Spacer(modifier = Modifier.weight(1f))
                IconButton(onClick = onDismiss, modifier = Modifier.size(30.dp)) {
                    Icon(Icons.Default.Close, contentDescription = "إغلاق", tint = TextMuted)
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
                    color = Gold500,
                    trackColor = DarkCardHigh
                )

                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    "الخطوة ${index + 1} من ${steps.size}",
                    color = TextMuted,
                    fontSize = 12.sp
                )

                Spacer(modifier = Modifier.height(14.dp))
                Text(step.title, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Spacer(modifier = Modifier.height(6.dp))
                Text(step.hint, color = TextSecondary, fontSize = 13.sp, lineHeight = 19.sp)

                Spacer(modifier = Modifier.height(14.dp))

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
                        maxLines = 4,
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
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedButton(
                        onClick = {
                            copyCommand(context, step.command)
                            copied = true
                        },
                        modifier = Modifier.weight(1f).height(44.dp),
                        shape = RoundedCornerShape(10.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                    ) {
                        Text("نسخ", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    }

                    Button(
                        onClick = {
                            val ok = runInTermux(context, step.command)
                            if (ok) {
                                launchedTermux = true
                                Toast.makeText(context, "🚀 تم إرسال الأمر إلى تيرمكس", Toast.LENGTH_SHORT).show()
                            } else {
                                copyCommand(context, step.command)
                                copied = true
                                val launch = context.packageManager.getLaunchIntentForPackage("com.termux")
                                if (launch != null) {
                                    context.startActivity(launch)
                                    Toast.makeText(context, "📋 نُسخ الأمر — افتح تيرمكس والصقه", Toast.LENGTH_LONG).show()
                                } else {
                                    Toast.makeText(context, "❌ ثبّت تيرمكس من F-Droid أولاً", Toast.LENGTH_LONG).show()
                                }
                            }
                        },
                        modifier = Modifier.weight(1.4f).height(44.dp),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = if (step.runsEngine) SuccessGreen else Gold500)
                    ) {
                        Icon(Icons.Default.PlayArrow, contentDescription = null, tint = DarkBg, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(4.dp))
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
