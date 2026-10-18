package com.arabicsubs.engine

sealed interface EngineEvent {
    data class Stage(val file: String, val stage: String, val source: String?, val cueCount: Int?) : EngineEvent
    data class Asr(val done: Int, val total: Int) : EngineEvent
    data class Translate(val done: Int, val total: Int?) : EngineEvent
    data class Queue(val marker: Char, val file: String, val detail: String?) : EngineEvent
    data class Raw(val line: String) : EngineEvent
}

class EngineOutput {

    private var buffer: String = ""

    private val stageLine = Regex("""^\[Stage\]\s+(.*?)\s+→\s+(.*)$""")
    private val stageCues = Regex("""\((\d+)\s+cues\)\s*$""")
    private val stageSource = Regex("""\(([^()]*)\)\s*$""")

    private val asrLine = Regex("""^\[ASR\]\s+(\d+)\s*/\s*(\d+)(?:\s+chunks)?$""")

    private val translateDone = Regex("""^\[Translate\]\s+(\d+)\s+lines done$""")
    private val translateRatio = Regex("""^\[Translate\]\s+(\d+)\s*/\s*(\d+)\s+lines$""")

    private val queueLine = Regex("""^\[Queue\]\s+([→✓✗])\s+(.*)$""")

    fun feed(chunk: String): List<EngineEvent> {
        val text = buffer + chunk
        val events = mutableListOf<EngineEvent>()
        var start = 0
        for (i in text.indices) {
            val c = text[i]
            if (c == '\n' || c == '\r') {
                parseSegment(text.substring(start, i))?.let { events.add(it) }
                start = i + 1
            }
        }
        buffer = text.substring(start)
        return events
    }

    private fun parseSegment(segment: String): EngineEvent? {
        val line = segment.trim()
        if (line.isEmpty()) return null
        return parse(line) ?: EngineEvent.Raw(line)
    }

    private fun parse(line: String): EngineEvent? {
        parseStage(line)?.let { return it }
        asrLine.matchEntire(line)?.let {
            return EngineEvent.Asr(it.groupValues[1].toInt(), it.groupValues[2].toInt())
        }
        translateDone.matchEntire(line)?.let {
            return EngineEvent.Translate(it.groupValues[1].toInt(), null)
        }
        translateRatio.matchEntire(line)?.let {
            return EngineEvent.Translate(it.groupValues[1].toInt(), it.groupValues[2].toInt())
        }
        parseQueue(line)?.let { return it }
        return null
    }

    private fun parseStage(line: String): EngineEvent.Stage? {
        val match = stageLine.matchEntire(line) ?: return null
        val file = match.groupValues[1].trim()
        var rest = match.groupValues[2].trim()

        var cueCount: Int? = null
        stageCues.find(rest)?.let {
            cueCount = it.groupValues[1].toInt()
            rest = rest.substring(0, it.range.first).trim()
        }

        var source: String? = null
        stageSource.find(rest)?.let {
            source = it.groupValues[1].trim().ifEmpty { null }
            rest = rest.substring(0, it.range.first).trim()
        }

        return EngineEvent.Stage(file, rest, source, cueCount)
    }

    private fun parseQueue(line: String): EngineEvent.Queue? {
        val match = queueLine.matchEntire(line) ?: return null
        val marker = match.groupValues[1][0]
        val rest = match.groupValues[2].trim()
        if (rest.isEmpty()) return null

        return when (marker) {
            '→' -> {
                val m = Regex("""^(\S+)\s*\(([^()]*)\)\s*$""").find(rest)
                if (m != null) EngineEvent.Queue(marker, m.groupValues[1], m.groupValues[2].trim())
                else EngineEvent.Queue(marker, rest, null)
            }
            '✗' -> {
                val m = Regex("""^([^:]+):\s*(.*)$""").find(rest)
                if (m != null) {
                    EngineEvent.Queue(marker, m.groupValues[1].trim(), m.groupValues[2].trim().ifEmpty { null })
                } else {
                    EngineEvent.Queue(marker, rest, null)
                }
            }
            else -> {
                val m = Regex("""^(\S+)\s*(.*)$""").find(rest)
                if (m != null) {
                    EngineEvent.Queue(marker, m.groupValues[1], m.groupValues[2].trim().ifEmpty { null })
                } else {
                    EngineEvent.Queue(marker, rest, null)
                }
            }
        }
    }
}
