package com.arabicsubs.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class EnginePathsTest {

    @Test
    fun reports_tools_missing_from_native_dir() {
        val dir = Files.createTempDirectory("nat").toFile()
        File(dir, "libffmpeg.so").writeText("x")

        assertEquals(
            listOf("llama-server", "whisper-cli", "ffprobe", "node"),
            EnginePaths.missingToolsIn(dir)
        )
    }

    @Test
    fun splits_on_spaces_and_arabic_without_a_shell() {
        assertEquals(
            "/storage/emulated/0/Movies/فيلم بنات.2024.mkv",
            EnginePaths.mediaPath("primary:Movies/فيلم بنات.2024.mkv")
        )
        assertEquals(
            "/storage/emulated/0/Movies",
            EnginePaths.mediaPath("/storage/emulated/0/Movies")
        )
    }

    @Test
    fun rejects_sd_card_paths() {
        assertFalse(EnginePaths.isSupportedMediaPath("/storage/1234-5678/Movies"))
        assertTrue(EnginePaths.isSupportedMediaPath("/storage/emulated/0/Movies"))
    }

    @Test
    fun home_lives_inside_the_media_folder() {
        assertEquals(
            "/storage/emulated/0/Movies/ArabicSubs",
            EnginePaths.homeFor("/storage/emulated/0/Movies")
        )
    }
}
