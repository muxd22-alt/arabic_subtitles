package com.arabicsubs.engine

import org.junit.Assert.assertEquals
import org.junit.Test

class EngineCommandTest {
    @Test fun run_passes_first_dir_as_media_and_the_rest_as_positionals() {
        val argv = EngineCommand.run("/files/node/bin/arabic-subs.js",
            listOf("/storage/emulated/0/Movies", "/storage/emulated/0/فيلم مع مسافات"))
        assertEquals(listOf("run", "--media", "/storage/emulated/0/Movies",
            "/storage/emulated/0/فيلم مع مسافات", "--yes"), argv.drop(1))
        assertEquals("/files/node/bin/arabic-subs.js", argv[0])
    }
    @Test fun run_defaults_to_movies_when_no_path_is_given() {
        assertEquals(listOf("run", "--media", "/storage/emulated/0/Movies", "--yes"),
            EngineCommand.run("/x/bin/arabic-subs.js", emptyList()).drop(1))
    }
    @Test fun setup_is_non_interactive() {
        assertEquals(listOf("setup", "--yes"), EngineCommand.setup("/x/bin/arabic-subs.js").drop(1))
    }
    @Test fun process_targets_one_file() {
        assertEquals(listOf("process", "/v/a.mkv", "--yes"),
            EngineCommand.process("/x/bin/arabic-subs.js", "/v/a.mkv").drop(1))
    }
}
