package com.arabicsubs.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.arabicsubs.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.io.IOException

sealed interface EngineMode {
    data class Run(val mediaPaths: List<String>, val slots: Int, val threads: Int) : EngineMode
    data class Setup(val mediaPath: String) : EngineMode
}

data class Launch(val binary: String, val argv: List<String>, val env: Map<String, String>)

object EngineLaunch {

    fun describe(mode: EngineMode, nativeDir: String, nodeScript: String, home: String): Launch =
        when (mode) {
            is EngineMode.Run -> Launch(
                binary = "$nativeDir/libnode.so",
                argv = EngineCommand.run(nodeScript, mode.mediaPaths),
                env = EngineEnv.forRun(home, nativeDir, mode.slots, mode.threads)
            )
            is EngineMode.Setup -> Launch(
                binary = "$nativeDir/libnode.so",
                argv = EngineCommand.setup(nodeScript),
                env = EngineEnv.forSetup(home, nativeDir)
            )
        }
}

data class EngineStatus(
    val running: Boolean = false,
    val stage: String? = null,
    val lastLine: String? = null,
    val exitCode: Int? = null,
    val failedToStart: String? = null
)

class EngineService : Service() {

    @Volatile
    private var process: Process? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEngine()
            return Service.START_NOT_STICKY
        }

        val mode = parseMode(intent)
        if (mode == null) {
            _status.value = EngineStatus(failedToStart = "Missing engine mode")
            stopSelf()
            return Service.START_NOT_STICKY
        }

        _status.value = EngineStatus(running = true, stage = PREPARING)
        startForegroundSafe(PREPARING)
        Thread({ runEngine(mode) }, "engine").start()
        return Service.START_NOT_STICKY
    }

    override fun onDestroy() {
        destroyProcess()
        super.onDestroy()
    }

    private fun parseMode(intent: Intent?): EngineMode? {
        if (intent == null) return null
        return when (intent.getStringExtra(EXTRA_MODE)) {
            MODE_RUN -> EngineMode.Run(
                mediaPaths = intent.getStringArrayListExtra(EXTRA_MEDIA_PATHS) ?: emptyList(),
                slots = intent.getIntExtra(EXTRA_SLOTS, 1),
                threads = intent.getIntExtra(EXTRA_THREADS, 1)
            )
            MODE_SETUP -> intent.getStringExtra(EXTRA_MEDIA_PATH)?.let { EngineMode.Setup(it) }
            else -> null
        }
    }

    private fun homeFor(mode: EngineMode): String = when (mode) {
        is EngineMode.Run -> EnginePaths.homeFor(mode.mediaPaths.firstOrNull() ?: DEFAULT_MEDIA)
        is EngineMode.Setup -> EnginePaths.homeFor(mode.mediaPath)
    }

    private fun extractEngine(): String {
        val stamp = packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
        val assets = EngineAssets.fromAssets(applicationContext.assets, stamp)
        assets.ensureExtracted(File(filesDir, "engine"))
        return assets.mainScript().absolutePath
    }

    private fun runEngine(mode: EngineMode) {
        val home = homeFor(mode)
        File(home).mkdirs()

        val started: Process
        try {
            val script = extractEngine()
            val launch = EngineLaunch.describe(mode, applicationInfo.nativeLibraryDir, script, home)
            val builder = ProcessBuilder(listOf(launch.binary) + launch.argv)
            builder.environment().putAll(launch.env)
            builder.directory(File(home))
            builder.redirectErrorStream(true)
            started = builder.start()
        } catch (e: Exception) {
            _status.value = EngineStatus(failedToStart = e.message ?: e.toString())
            stopForegroundCompat()
            stopSelf()
            return
        }

        process = started
        readStream(started)
    }

    private fun readStream(proc: Process) {
        val output = EngineOutput()
        try {
            proc.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val buffer = CharArray(8192)
                var read = reader.read(buffer)
                while (read >= 0) {
                    if (read > 0) {
                        for (event in output.feed(String(buffer, 0, read))) applyEvent(event)
                    }
                    read = reader.read(buffer)
                }
            }
        } catch (e: IOException) {
            // the stream closes when the child process dies
        }

        val exit = try {
            proc.waitFor()
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            -1
        }
        _status.value = _status.value.copy(running = false, exitCode = exit)
        stopForegroundCompat()
        stopSelf()
    }

    private fun applyEvent(event: EngineEvent) {
        when (event) {
            is EngineEvent.Stage -> {
                _status.value = _status.value.copy(stage = event.stage, lastLine = event.file)
                getSystemService(NotificationManager::class.java)
                    ?.notify(NOTIFICATION_ID, buildNotification(event.stage))
            }
            is EngineEvent.Asr ->
                _status.value = _status.value.copy(lastLine = "ASR ${event.done}/${event.total}")
            is EngineEvent.Translate ->
                _status.value = _status.value.copy(
                    lastLine = if (event.total == null) {
                        "Translate ${event.done}"
                    } else {
                        "Translate ${event.done}/${event.total}"
                    }
                )
            is EngineEvent.Queue ->
                _status.value = _status.value.copy(lastLine = event.file)
            is EngineEvent.Raw ->
                _status.value = _status.value.copy(lastLine = event.line)
        }
    }

    private fun stopEngine() {
        stopForegroundCompat()
        _status.value = _status.value.copy(running = false)
        destroyProcess()
        stopSelf()
    }

    private fun destroyProcess() {
        val current = process
        process = null
        current?.destroy()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Engine", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun startForegroundSafe(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.arabicsubs_icon)
            .setContentTitle("ArabicSubs")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    companion object {
        private const val ACTION_START = "com.arabicsubs.engine.action.START"
        private const val ACTION_STOP = "com.arabicsubs.engine.action.STOP"

        private const val EXTRA_MODE = "mode"
        private const val EXTRA_MEDIA_PATHS = "media_paths"
        private const val EXTRA_MEDIA_PATH = "media_path"
        private const val EXTRA_SLOTS = "slots"
        private const val EXTRA_THREADS = "threads"

        private const val MODE_RUN = "run"
        private const val MODE_SETUP = "setup"

        private const val CHANNEL_ID = "engine"
        private const val NOTIFICATION_ID = 1
        private const val PREPARING = "Preparing"
        private const val DEFAULT_MEDIA = "/storage/emulated/0/Movies"

        private val _status = MutableStateFlow(EngineStatus())
        val status: StateFlow<EngineStatus> = _status.asStateFlow()

        fun start(context: Context, mode: EngineMode) {
            context.startForegroundService(startIntent(context, mode))
        }

        fun stop(context: Context) {
            try {
                context.startService(stopIntent(context))
            } catch (e: IllegalStateException) {
                context.stopService(Intent(context, EngineService::class.java))
            }
        }

        private fun startIntent(context: Context, mode: EngineMode): Intent {
            val intent = Intent(context, EngineService::class.java)
                .setAction(ACTION_START)
                .putExtra(
                    EXTRA_MODE,
                    when (mode) {
                        is EngineMode.Run -> MODE_RUN
                        is EngineMode.Setup -> MODE_SETUP
                    }
                )
            when (mode) {
                is EngineMode.Run -> intent
                    .putStringArrayListExtra(EXTRA_MEDIA_PATHS, ArrayList(mode.mediaPaths))
                    .putExtra(EXTRA_SLOTS, mode.slots)
                    .putExtra(EXTRA_THREADS, mode.threads)
                is EngineMode.Setup -> intent.putExtra(EXTRA_MEDIA_PATH, mode.mediaPath)
            }
            return intent
        }

        private fun stopIntent(context: Context): Intent =
            Intent(context, EngineService::class.java).setAction(ACTION_STOP)
    }
}
