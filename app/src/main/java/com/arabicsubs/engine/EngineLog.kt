package com.arabicsubs.engine

/**
 * The engine's rolling log, kept for the in-app terminal window.
 *
 * Deliberately pure data with no Android dependencies, so the capping and the
 * "is this line an error" rules can be unit tested on the JVM.
 */
object EngineLog {

    /** Hard cap on retained lines: the terminal is a window, not a file. */
    const val MAX_LINES = 300

    /** One readable line per engine event, in the same shape the CLI prints. */
    fun render(event: EngineEvent): String = when (event) {
        is EngineEvent.Stage -> buildString {
            append("[Stage] ")
            append(event.file)
            append(" → ")
            append(event.stage)
            if (event.source != null) append(" (").append(event.source).append(")")
            if (event.cueCount != null) append(" (").append(event.cueCount).append(" cues)")
        }
        is EngineEvent.Asr -> "[ASR] ${event.done}/${event.total}"
        is EngineEvent.Translate ->
            if (event.total == null) "[Translate] ${event.done}" else "[Translate] ${event.done}/${event.total}"
        is EngineEvent.Queue -> buildString {
            append("[Queue] ").append(event.marker).append(' ').append(event.file)
            if (event.detail != null) append(": ").append(event.detail)
        }
        is EngineEvent.Raw -> event.line
    }

    /**
     * Appends a line, dropping the oldest once [MAX_LINES] is reached. Consecutive
     * duplicates are collapsed: a `\r` progress bar would otherwise fill the
     * whole buffer with the same counter.
     */
    fun append(log: List<String>, line: String): List<String> {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return log
        if (log.lastOrNull() == trimmed) return log
        val kept = if (log.size >= MAX_LINES) log.drop(log.size - MAX_LINES + 1) else log
        return kept + trimmed
    }

    /** Errors worth surfacing: failures the engine reported in its own words. */
    fun isError(line: String): Boolean =
        line.contains("✗") ||
            line.contains("Error") ||
            line.contains("error") ||
            line.contains("تعذّر") ||
            line.contains("failed")
}
