package com.arabicsubs.engine

import android.content.res.AssetManager
import java.io.File
import java.io.IOException
import java.io.InputStream

class EngineAssets private constructor(
    private val source: AssetSource,
    private val stamp: String
) {
    private var root: File? = null

    constructor(assetsRoot: File, stamp: String) : this(FileAssetSource(assetsRoot), stamp)

    fun ensureExtracted(dest: File): File {
        val stampFile = File(dest, STAMP_FILE)
        if (stampFile.isFile && stampFile.readText() == stamp) {
            root = dest
            return dest
        }
        dest.mkdirs()
        File(dest, "bin").deleteRecursively()
        File(dest, "src").deleteRecursively()
        if (stampFile.exists()) stampFile.delete()
        source.copyInto(dest)
        stampFile.writeText(stamp)
        root = dest
        return dest
    }

    fun mainScript(): File = File(
        checkNotNull(root) { "ensureExtracted() must be called before mainScript()" },
        "bin/arabic-subs.js"
    )

    companion object {
        private const val STAMP_FILE = ".stamp"
        private const val ASSET_ROOT = "node"

        fun fromAssets(assets: AssetManager, stamp: String): EngineAssets =
            EngineAssets(AssetManagerSource(assets, ASSET_ROOT), stamp)
    }
}

private val MANAGED_ENTRIES = listOf("bin", "src", "package.json")

private interface AssetSource {
    fun exists(path: String): Boolean
    fun children(path: String): List<String>?
    fun open(path: String): InputStream
}

private fun AssetSource.copyInto(dest: File) {
    for (entry in MANAGED_ENTRIES) {
        if (exists(entry)) copyEntry(entry, File(dest, entry))
    }
}

private fun AssetSource.copyEntry(path: String, dest: File) {
    val children = children(path)
    if (children != null) {
        dest.mkdirs()
        for (name in children) copyEntry("$path/$name", File(dest, name))
    } else {
        dest.parentFile?.mkdirs()
        open(path).use { input ->
            dest.outputStream().use { output -> input.copyTo(output) }
        }
    }
}

private class FileAssetSource(private val root: File) : AssetSource {
    override fun exists(path: String): Boolean = File(root, path).exists()

    override fun children(path: String): List<String>? {
        val file = File(root, path)
        return if (file.isDirectory) file.listFiles()?.map { it.name } ?: emptyList() else null
    }

    override fun open(path: String): InputStream = File(root, path).inputStream()
}

private class AssetManagerSource(
    private val assets: AssetManager,
    private val base: String
) : AssetSource {
    override fun exists(path: String): Boolean {
        val full = "$base/$path"
        return list(full).isNotEmpty() || canOpen(full)
    }

    override fun children(path: String): List<String>? {
        val full = "$base/$path"
        val children = list(full)
        if (children.isNotEmpty()) return children
        return if (canOpen(full)) null else emptyList()
    }

    override fun open(path: String): InputStream = assets.open("$base/$path")

    private fun list(path: String): List<String> =
        runCatching { assets.list(path)?.toList() }.getOrDefault(emptyList())

    private fun canOpen(path: String): Boolean =
        try {
            assets.open(path).use { }
            true
        } catch (e: IOException) {
            false
        }
}
