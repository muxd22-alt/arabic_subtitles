package com.arabicsubs.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arabicsubs.engine.EngineLog
import com.arabicsubs.engine.EngineStatus
import com.arabicsubs.ui.theme.*

/**
 * The engine output window: a collapsible terminal that shows what the engine is
 * doing right now, and every error it has reported, without leaving the app.
 */
@Composable
fun EngineLogCard(status: EngineStatus, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    val log = status.log
    val errors = log.count { EngineLog.isError(it) }
    val scroll = rememberScrollState()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    // Follow the tail while it grows, but only when the window is open.
    LaunchedEffect(log.size, expanded) {
        if (expanded && scroll.maxValue > 0) scroll.scrollTo(scroll.maxValue)
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = DarkSurface),
        shape = RoundedCornerShape(12.dp)
    ) {
        Column(modifier = Modifier.padding(Space.md)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    Icons.Default.Terminal,
                    contentDescription = null,
                    tint = AccentText,
                    modifier = Modifier.size(16.dp)
                )
                Spacer(modifier = Modifier.width(Space.sm))
                Text("سجل المحرك", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)

                Spacer(modifier = Modifier.weight(1f))

                if (errors > 0) {
                    Box(
                        modifier = Modifier
                            .background(ErrorRose.copy(alpha = 0.16f), RoundedCornerShape(6.dp))
                            .padding(horizontal = Space.sm, vertical = Space.xxs)
                    ) {
                        Text(
                            "$errors أخطاء",
                            color = ErrorRose,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Spacer(modifier = Modifier.width(Space.sm))
                }

                Text("${log.size} سطر", color = TextMuted, fontSize = 11.sp)

                if (log.isNotEmpty()) {
                    val errorLines = log.filter { EngineLog.isError(it) }
                    IconButton(onClick = {
                        // Prefer just the errors: they are what gets reported back
                        // to whoever is fixing the engine.
                        clipboard.setText(
                            AnnotatedString(
                                (if (errorLines.isNotEmpty()) errorLines else log).joinToString("\n")
                            )
                        )
                        Toast.makeText(
                            context,
                            if (errorLines.isNotEmpty()) "تم نسخ ${errorLines.size} سطر خطأ" else "تم نسخ السجل",
                            Toast.LENGTH_SHORT
                        ).show()
                    }) {
                        Icon(
                            Icons.Default.ContentCopy,
                            contentDescription = if (errors > 0) "نسخ الأخطاء" else "نسخ السجل",
                            tint = if (errors > 0) ErrorRose else TextSecondary
                        )
                    }
                }

                IconButton(onClick = { expanded = !expanded }) {
                    Icon(
                        if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                        contentDescription = if (expanded) "إخفاء السجل" else "إظهار السجل",
                        tint = TextSecondary
                    )
                }
            }

            if (expanded) {
                Spacer(modifier = Modifier.height(Space.sm))
                if (log.isEmpty()) {
                    Text(
                        "لا يوجد سجل بعد — شغّل الترجمة لعرض التقدم والأخطاء هنا.",
                        color = TextMuted,
                        fontSize = 11.sp
                    )
                } else {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 220.dp)
                            .background(DarkBg, RoundedCornerShape(8.dp))
                            .padding(Space.sm)
                            .verticalScroll(scroll)
                    ) {
                        log.forEach { line ->
                            Text(
                                line,
                                color = logLineColor(line),
                                fontFamily = FontFamily.Monospace,
                                fontSize = 10.sp,
                                lineHeight = 15.sp
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun logLineColor(line: String): Color = when {
    EngineLog.isError(line) -> ErrorRose
    line.contains("✓") -> SuccessGreen
    line.startsWith("[Stage]") -> AccentText
    line.startsWith("[Queue]") -> InfoCyan
    else -> TextSecondary
}
