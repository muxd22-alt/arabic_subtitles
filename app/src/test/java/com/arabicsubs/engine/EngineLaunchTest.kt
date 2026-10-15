package com.arabicsubs.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class EngineLaunchTest {
    @Test fun run_uses_node_binary_and_sets_env() {
        val l = EngineLaunch.describe(
            EngineMode.Run(listOf("/v"), slots = 4, threads = 2),
            nativeDir = "/lib", nodeScript = "/files/node/bin/arabic-subs.js",
            home = "/storage/emulated/0/ArabicSubs")
        assertEquals("/lib/libnode.so", l.binary)
        assertEquals(listOf("/files/node/bin/arabic-subs.js", "run", "--media", "/v", "--yes"), l.argv)
        assertEquals("4", l.env["TRANSLATE_CONCURRENCY"])
        assertEquals("4", l.env["LLAMA_PARALLEL"])
        assertEquals("2", l.env["THREADS"])
        assertEquals("1", l.env["JOB_CONCURRENCY"])
    }
    @Test fun setup_uses_setup_argv_and_has_no_slot_keys() {
        val l = EngineLaunch.describe(
            EngineMode.Setup("/storage/emulated/0/Movies"),
            nativeDir = "/lib", nodeScript = "/files/node/bin/arabic-subs.js",
            home = "/storage/emulated/0/Movies/ArabicSubs")
        assertEquals(listOf("/files/node/bin/arabic-subs.js", "setup", "--yes"), l.argv)
        assertFalse(l.env.containsKey("TRANSLATE_CONCURRENCY"))
        assertEquals("q4_k_m", l.env["HYMT_MODEL_FLAVOR"])
    }
}
