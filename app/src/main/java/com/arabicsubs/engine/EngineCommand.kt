package com.arabicsubs.engine

object EngineCommand {

    private const val DEFAULT_MEDIA = "/storage/emulated/0/Movies"

    fun run(script: String, mediaPaths: List<String>): List<String> {
        val folders = if (mediaPaths.isEmpty()) listOf(DEFAULT_MEDIA) else mediaPaths
        return listOf(script, "run", "--media") + folders + "--yes"
    }

    fun setup(script: String): List<String> = listOf(script, "setup", "--yes")

    fun process(script: String, file: String): List<String> = listOf(script, "process", file, "--yes")
}
