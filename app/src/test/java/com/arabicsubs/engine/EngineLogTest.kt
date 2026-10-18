package com.arabicsubs.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineLogTest {

    @Test fun renders_each_event_the_way_the_cli_prints_it() {
        assertEquals(
            "[Stage] a.mkv → translate (subtitle) (812 cues)",
            EngineLog.render(EngineEvent.Stage("a.mkv", "translate", "subtitle", 812))
        )
        assertEquals(
            "[Stage] b.mkv → transcribe",
            EngineLog.render(EngineEvent.Stage("b.mkv", "transcribe", null, null))
        )
        assertEquals("[ASR] 3/9", EngineLog.render(EngineEvent.Asr(3, 9)))
        assertEquals("[Translate] 40/120", EngineLog.render(EngineEvent.Translate(40, 120)))
        assertEquals("[Translate] 7", EngineLog.render(EngineEvent.Translate(7, null)))
        assertEquals("[Queue] ✗ a.mkv: boom", EngineLog.render(EngineEvent.Queue('✗', "a.mkv", "boom")))
        assertEquals("plain noise", EngineLog.render(EngineEvent.Raw("plain noise")))
    }

    @Test fun append_drops_consecutive_duplicates() {
        var log = emptyList<String>()
        log = EngineLog.append(log, "one")
        log = EngineLog.append(log, "one")
        log = EngineLog.append(log, "  one  ")
        log = EngineLog.append(log, "two")
        assertEquals(listOf("one", "two"), log)
    }

    @Test fun append_ignores_blank_lines() {
        assertEquals(emptyList<String>(), EngineLog.append(emptyList(), ""))
        assertEquals(emptyList<String>(), EngineLog.append(emptyList(), "   "))
    }

    @Test fun append_keeps_only_the_newest_lines() {
        var log = emptyList<String>()
        repeat(EngineLog.MAX_LINES + 25) { log = EngineLog.append(log, "line $it") }
        assertEquals(EngineLog.MAX_LINES, log.size)
        assertEquals("line ${EngineLog.MAX_LINES + 24}", log.last())
        assertFalse(log.contains("line 0"))
    }

    @Test fun flags_real_errors_but_not_ordinary_progress() {
        assertTrue(EngineLog.isError("[Queue] ✗ a.mkv: boom"))
        assertTrue(EngineLog.isError("Error: whisper binary not found"))
        assertTrue(EngineLog.isError("تعذّر تشغيل المحرك"))
        assertFalse(EngineLog.isError("[ASR] 3/9"))
        assertFalse(EngineLog.isError("[Stage] a.mkv → translate (subtitle)"))
        assertFalse(EngineLog.isError("[Queue] ✓ a.mkv: translated"))
    }
}
