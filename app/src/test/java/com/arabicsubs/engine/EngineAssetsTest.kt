package com.arabicsubs.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class EngineAssetsTest {

    @Test
    fun extracts_once_and_rewrites_on_new_stamp() {
        val src = Files.createTempDirectory("src").toFile().apply {
            File(this, "bin").mkdirs()
            File(this, "bin/arabic-subs.js").writeText("//x")
            File(this, "src").mkdirs()
            File(this, "src/config.js").writeText("//c")
        }
        val dest = Files.createTempDirectory("dest").toFile()

        val a = EngineAssets(src, "2.3.0")
        val root = a.ensureExtracted(dest)
        assertTrue(File(root, "bin/arabic-subs.js").exists())

        File(root, "bin/arabic-subs.js").writeText("//edited")
        a.ensureExtracted(dest)
        assertEquals("//edited", File(root, "bin/arabic-subs.js").readText()) // same stamp -> no rewrite

        EngineAssets(src, "2.3.1").ensureExtracted(dest)
        assertEquals("//x", File(root, "bin/arabic-subs.js").readText()) // new stamp -> re-extract
    }

    @Test
    fun new_stamp_extraction_never_touches_models() {
        val src = Files.createTempDirectory("src").toFile().apply {
            File(this, "bin").mkdirs()
            File(this, "bin/arabic-subs.js").writeText("//x")
        }
        val dest = Files.createTempDirectory("dest").toFile()
        File(dest, "models").mkdirs()
        File(dest, "models/keep.bin").writeText("model")

        EngineAssets(src, "1.0.0").ensureExtracted(dest)
        assertTrue(File(dest, "models/keep.bin").exists())

        File(dest, "models/keep.bin").writeText("model-edited")
        EngineAssets(src, "1.0.1").ensureExtracted(dest)
        assertTrue(File(dest, "models/keep.bin").exists())
        assertEquals("model-edited", File(dest, "models/keep.bin").readText())
    }

    @Test
    fun main_script_is_bin_arabic_subs_js_under_the_extracted_root() {
        val src = Files.createTempDirectory("src").toFile().apply {
            File(this, "bin").mkdirs()
            File(this, "bin/arabic-subs.js").writeText("//x")
        }
        val dest = Files.createTempDirectory("dest").toFile()

        val a = EngineAssets(src, "2.3.0")
        val root = a.ensureExtracted(dest)

        assertEquals(File(root, "bin/arabic-subs.js"), a.mainScript())
        assertTrue(a.mainScript().exists())
    }

    @Test
    fun copies_package_json_at_the_assets_root() {
        val src = Files.createTempDirectory("src").toFile().apply {
            File(this, "bin").mkdirs()
            File(this, "bin/arabic-subs.js").writeText("//x")
            File(this, "package.json").writeText("{\"name\":\"arabic-subs\"}")
        }
        val dest = Files.createTempDirectory("dest").toFile()

        EngineAssets(src, "2.3.0").ensureExtracted(dest)

        assertEquals("{\"name\":\"arabic-subs\"}", File(dest, "package.json").readText())
    }

    @Test
    fun copies_nested_subdirectories_under_bin() {
        val src = Files.createTempDirectory("src").toFile().apply {
            File(this, "bin/lib").mkdirs()
            File(this, "bin/arabic-subs.js").writeText("//x")
            File(this, "bin/lib/helper.js").writeText("//h")
        }
        val dest = Files.createTempDirectory("dest").toFile()

        EngineAssets(src, "2.3.0").ensureExtracted(dest)

        assertEquals("//h", File(dest, "bin/lib/helper.js").readText())
    }
}
