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
import java.util.concurrent.TimeUnit

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

    // One lock guards the process handle, the worker thread, the run generation
    // and the latest startId, and is the single writer lock for `_status`
    // (see updateStatus). Every start/stop transition and every foreground
    // hand-off happens inside it, so a superseded or stopped run can neither
    // leak a child process nor clobber the current run's state.
    private val lock = Any()

    private var process: Process? = null
    private var worker: Thread? = null
    private var runGeneration = 0
    private var lastStartId = 0

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopCurrent()
            return Service.START_NOT_STICKY
        }

        val mode = parseMode(intent)
        if (mode == null) {
            // No launch will be built, but the start-foreground contract still
            // applies: show the notification, then stop this start.
            synchronized(lock) {
                runGeneration++
                lastStartId = startId
                startForegroundSafe(PREPARING)
                updateStatus(null) { EngineStatus(failedToStart = "Missing engine mode") }
                stopSelf(startId)
            }
            return Service.START_NOT_STICKY
        }

        var gen = 0
        var previousWorker: Thread? = null
        synchronized(lock) {
            gen = ++runGeneration
            lastStartId = startId
            previousWorker = worker
            val previous = process
            process = null
            worker = null
            // Show the foreground notification before any bounded teardown wait,
            // so we always beat the 5s start-foreground deadline.
            startForegroundSafe(PREPARING)
            updateStatus(null) { EngineStatus(running = true, stage = PREPARING) }
            previous?.let { terminate(it) }
        }
        previousWorker?.let { joinQuietly(it) }
        Thread({ runEngine(mode, gen) }, "engine").start()
        return Service.START_NOT_STICKY
    }

    override fun onDestroy() {
        synchronized(lock) {
            runGeneration++
            val current = process
            process = null
            worker = null
            current?.let { terminate(it) }
        }
        stopForegroundCompat()
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

    private fun runEngine(mode: EngineMode, gen: Int) {
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
            synchronized(lock) {
                if (gen == runGeneration) {
                    process = null
                    worker = null
                    updateStatus(gen) { EngineStatus(failedToStart = e.message ?: e.toString()) }
                    stopForegroundCompat()
                    stopSelf(lastStartId)
                }
            }
            return
        }

        if (!installCurrent(started, gen)) {
            // superseded while we were preparing: never leave this child behind
            terminate(started)
            return
        }
        readStream(started, gen)
    }

    private fun installCurrent(proc: Process, gen: Int): Boolean {
        synchronized(lock) {
            if (gen != runGeneration) return false
            process = proc
            worker = Thread.currentThread()
        }
        return true
    }

    private fun readStream(proc: Process, gen: Int) {
        val output = EngineOutput()
        try {
            proc.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val buffer = CharArray(8192)
                var read = reader.read(buffer)
                while (read >= 0) {
                    if (read > 0) {
                        for (event in output.feed(String(buffer, 0, read))) applyEvent(gen, event)
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

        synchronized(lock) {
            if (gen == runGeneration) {
                process = null
                worker = null
                updateStatus(gen) { it.copy(running = false, exitCode = exit) }
                stopForegroundCompat()
                stopSelf(lastStartId)
            }
        }
    }

    private fun applyEvent(gen: Int, event: EngineEvent) {
        when (event) {
            is EngineEvent.Stage -> {
                if (updateStatus(gen) { it.copy(stage = event.stage, lastLine = event.file) }) {
                    getSystemService(NotificationManager::class.java)
                        ?.notify(NOTIFICATION_ID, buildNotification(event.stage))
                }
            }
            is EngineEvent.Asr ->
                updateStatus(gen) { it.copy(lastLine = "ASR ${event.done}/${event.total}") }
            is EngineEvent.Translate ->
                updateStatus(gen) {
                    it.copy(
                        lastLine = if (event.total == null) {
                            "Translate ${event.done}"
                        } else {
                            "Translate ${event.done}/${event.total}"
                        }
                    )
                }
            is EngineEvent.Queue ->
                updateStatus(gen) { it.copy(lastLine = event.file) }
            is EngineEvent.Raw ->
                updateStatus(gen) { it.copy(lastLine = event.line) }
        }
    }

    private fun stopCurrent() {
        synchronized(lock) {
            runGeneration++
            val current = process
            process = null
            worker = null
            updateStatus(null) { it.copy(running = false) }
            current?.let { terminate(it) }
            stopForegroundCompat()
            stopSelf(lastStartId)
        }
    }

    private fun terminate(proc: Process) {
        proc.destroy()
        try {
            if (!proc.waitFor(DESTROY_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                proc.destroyForcibly()
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            proc.destroyForcibly()
        }
    }

    private fun joinQuietly(target: Thread) {
        try {
            target.join(WORKER_JOIN_MS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    // The single place `_status` is ever assigned. A non-null `gen` publishes
    // only while that run is still the current generation, so a superseded or
    // stopped run can never resurrect `running = true`.
    private fun updateStatus(gen: Int?, transform: (EngineStatus) -> EngineStatus): Boolean {
        synchronized(lock) {
            if (gen != null && gen != runGeneration) return false
            _status.value = transform(_status.value)
        }
        return true
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
        private const val DESTROY_TIMEOUT_MS = 2000L
        private const val WORKER_JOIN_MS = 1000L

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
