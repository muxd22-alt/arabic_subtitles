package com.arabicsubs.storage

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings

object AllFilesAccess {

    fun granted(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            true
        }

    fun settingsIntent(context: Context): Intent {
        val packageUri = Uri.parse("package:${context.packageName}")
        val appDetails = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)

        val candidates: List<Intent> =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                listOf(
                    Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, packageUri),
                    Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
                    appDetails,
                )
            } else {
                listOf(appDetails)
            }

        val resolvable = candidates.firstOrNull { it.resolveActivity(context.packageManager) != null }
        return (resolvable ?: appDetails).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
