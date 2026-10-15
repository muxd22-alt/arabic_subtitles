package com.arabicsubs.engine

import android.content.Context
import java.io.File

object EnginePaths {

    private const val PRIMARY_ROOT = "/storage/emulated/0/"

    private val TOOL_NAMES = listOf("llama-server", "whisper-cli", "ffmpeg", "ffprobe", "node")

    fun missingToolsIn(dir: File): List<String> =
        TOOL_NAMES.filter { !File(dir, "lib$it.so").exists() }

    fun missingTools(context: Context): List<String> =
        missingToolsIn(File(context.applicationInfo.nativeLibraryDir))

    fun mediaPath(docId: String): String =
        if (docId.startsWith("primary:")) PRIMARY_ROOT + docId.removePrefix("primary:") else docId

    fun isSupportedMediaPath(path: String): Boolean = path.startsWith(PRIMARY_ROOT)

    fun homeFor(mediaPath: String): String = "$mediaPath/ArabicSubs"
}
