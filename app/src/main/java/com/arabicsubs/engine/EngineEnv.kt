package com.arabicsubs.engine

object EngineEnv {

    private const val MODEL_FLAVOR = "q4_k_m"
    private const val WHISPER_MODEL_NAME = "base"

    fun forRun(home: String, nativeDir: String, translationSlots: Int, threads: Int): Map<String, String> =
        base(home, nativeDir) + mapOf(
            "TRANSLATE_CONCURRENCY" to translationSlots.toString(),
            "LLAMA_PARALLEL" to translationSlots.toString(),
            "THREADS" to threads.toString(),
            "JOB_CONCURRENCY" to "1"
        )

    fun forSetup(home: String, nativeDir: String): Map<String, String> = base(home, nativeDir)

    private fun base(home: String, nativeDir: String): Map<String, String> = mapOf(
        "ARABIC_SUBS_HOME" to home,
        "ARABIC_SUBS_MODELS" to "$home/models",
        "ARABIC_SUBS_LOG" to "$home/logs/decisions.jsonl",
        "TMPDIR" to "$home/tmp",
        "LLAMA_SERVER_BIN" to "$nativeDir/libllama-server.so",
        "WHISPER_BIN" to "$nativeDir/libwhisper-cli.so",
        "FFMPEG_BIN" to "$nativeDir/libffmpeg.so",
        "FFPROBE_BIN" to "$nativeDir/libffprobe.so",
        "LD_LIBRARY_PATH" to nativeDir,
        "HYMT_MODEL_FLAVOR" to MODEL_FLAVOR,
        "WHISPER_MODEL" to WHISPER_MODEL_NAME
    )
}
