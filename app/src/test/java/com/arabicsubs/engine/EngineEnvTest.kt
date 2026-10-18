package com.arabicsubs.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineEnvTest {

    @Test
    fun points_node_at_bundled_tools_and_media_home() {
        val env = EngineEnv.forRun("/storage/emulated/0/ArabicSubs", "/data/app/lib/arm64", 4, 8)
        assertEquals("/storage/emulated/0/ArabicSubs", env["ARABIC_SUBS_HOME"])
        assertEquals("/storage/emulated/0/ArabicSubs/models", env["ARABIC_SUBS_MODELS"])
        assertEquals("/data/app/lib/arm64/libllama-server.so", env["LLAMA_SERVER_BIN"])
        assertEquals("/data/app/lib/arm64/libwhisper-cli.so", env["WHISPER_BIN"])
        assertEquals("/data/app/lib/arm64/libffmpeg.so", env["FFMPEG_BIN"])
        assertEquals("/data/app/lib/arm64/libffprobe.so", env["FFPROBE_BIN"])
        assertEquals("/data/app/lib/arm64", env["LD_LIBRARY_PATH"])
        assertEquals("4", env["TRANSLATE_CONCURRENCY"])
        assertEquals("4", env["LLAMA_PARALLEL"])
        assertEquals("8", env["THREADS"])
        assertEquals("1", env["JOB_CONCURRENCY"])
    }

    @Test
    fun temp_dir_is_under_the_home() {
        val env = EngineEnv.forRun("/storage/emulated/0/ArabicSubs", "/lib", 2, 4)
        assertTrue(env.getValue("ARABIC_SUBS_HOME").let { env["TMPDIR"]!!.startsWith(it) })
    }

    @Test
    fun setup_omits_slot_and_thread_keys() {
        val env = EngineEnv.forSetup("/storage/emulated/0/ArabicSubs", "/data/app/lib/arm64")
        assertFalse(env.containsKey("TRANSLATE_CONCURRENCY"))
        assertFalse(env.containsKey("LLAMA_PARALLEL"))
        assertFalse(env.containsKey("THREADS"))
        assertFalse(env.containsKey("JOB_CONCURRENCY"))
        assertEquals("/storage/emulated/0/ArabicSubs", env["ARABIC_SUBS_HOME"])
        assertEquals("/data/app/lib/arm64/libllama-server.so", env["LLAMA_SERVER_BIN"])
    }
}
