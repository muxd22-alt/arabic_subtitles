package com.arabicsubs.engine

import android.content.res.AssetManager
import java.io.File

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

private interface AssetSource {
    fun copyInto(dest: File)
}

private class FileAssetSource(private val root: File) : AssetSource {
    override fun copyInto(dest: File) {
        copyTree(File(root, "bin"), File(dest, "bin"))
        copyTree(File(root, "src"), File(dest, "src"))
        val packageJson = File(root, "package.json")
        if (packageJson.isFile) copyFile(packageJson, File(dest, "package.json"))
    }
}

private class AssetManagerSource(
    private val assets: AssetManager,
    private val base: String
) : AssetSource {
    override fun copyInto(dest: File) {
        copyAssetTree("$base/bin", File(dest, "bin"))
        copyAssetTree("$base/src", File(dest, "src"))
        val entries = runCatching { assets.list(base)?.toList() }.getOrDefault(emptyList())
        if (entries.contains("package.json")) {
            copyAssetFile("$base/package.json", File(dest, "package.json"))
        }
    }

    private fun copyAssetTree(assetPath: String, dest: File) {
        val children = runCatching { assets.list(assetPath)?.toList() }.getOrNull()
        if (children.isNullOrEmpty()) {
            copyAssetFile(assetPath, dest)
            return
        }
        dest.mkdirs()
        for (name in children) copyAssetTree("$assetPath/$name", File(dest, name))
    }

    private fun copyAssetFile(assetPath: String, dest: File) {
        dest.parentFile?.mkdirs()
        assets.open(assetPath).use { input ->
            dest.outputStream().use { output -> input.copyTo(output) }
        }
    }
}

private fun copyFile(source: File, dest: File) {
    dest.parentFile?.mkdirs()
    source.copyTo(dest, overwrite = true)
}

private fun copyTree(source: File, dest: File) {
    if (source.isDirectory) {
        dest.mkdirs()
        source.listFiles()?.forEach { copyTree(it, File(dest, it.name)) }
    } else if (source.isFile) {
        copyFile(source, dest)
    }
}
