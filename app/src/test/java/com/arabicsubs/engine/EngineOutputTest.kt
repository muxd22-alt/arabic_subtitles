package com.arabicsubs.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineOutputTest {
    private val out = EngineOutput()

    @Test fun reads_stage_lines() {
        val e = out.feed("[Stage] a.mkv → translate (subtitle) (812 cues)\n").single() as EngineEvent.Stage
        assertEquals("a.mkv", e.file)
        assertEquals("translate", e.stage)
        assertEquals("subtitle", e.source)
        assertEquals(812, e.cueCount)
    }

    @Test fun stage_without_source_still_reads_the_cue_count() {
        val e = out.feed("[Stage] b.mkv → translate (400 cues)\n").single() as EngineEvent.Stage
        assertEquals("translate", e.stage)
        assertEquals(null, e.source)
        assertEquals(400, e.cueCount)
    }

    @Test fun stage_without_source_or_count_has_nulls() {
        val e = out.feed("[Stage] c.mkv → extract\n").single() as EngineEvent.Stage
        assertEquals("extract", e.stage)
        assertEquals(null, e.source)
        assertEquals(null, e.cueCount)
    }

    @Test fun reads_asr_chunk_progress() {
        val e = out.feed("[ASR] 12/41 chunks\n").single() as EngineEvent.Asr
        assertEquals(12, e.done)
        assertEquals(41, e.total)
    }

    @Test fun reads_translate_progress_with_and_without_total() {
        assertEquals(EngineEvent.Translate(30, null), out.feed("[Translate] 30 lines done\n").single())
        assertEquals(EngineEvent.Translate(30, 50), out.feed("[Translate] 30/50 lines\n").single())
    }

    @Test fun reads_queue_events_for_each_marker() {
        assertEquals(
            EngineEvent.Queue('✓', "a.mkv", "[ok]"),
            out.feed("[Queue] ✓ a.mkv [ok]\n").single()
        )
        assertEquals(
            EngineEvent.Queue('→', "a.mkv", "2 waiting"),
            out.feed("[Queue] → a.mkv (2 waiting)\n").single()
        )
        assertEquals(
            EngineEvent.Queue('✗', "a.mkv", "boom"),
            out.feed("[Queue] ✗ a.mkv: boom\n").single()
        )
    }

    @Test fun carriage_return_updates_and_partial_lines_buffer() {
        assertTrue(out.feed("\r[ASR] 1/").isEmpty())
        val events = out.feed("41 chunks\r[ASR] 2/41 chunks\r")
        assertEquals(listOf(EngineEvent.Asr(1, 41), EngineEvent.Asr(2, 41)), events)
    }

    @Test fun unknown_lines_are_raw() {
        assertTrue(out.feed("some llama-server noise\n").single() is EngineEvent.Raw)
        assertEquals(EngineEvent.Raw("some llama-server noise"), out.feed("some llama-server noise\n").single())
    }
}
