package com.childtrack.app

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
import com.childtrack.app.db.AppDatabase
import com.childtrack.app.db.PointEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class LocationService : Service() {

    companion object {
        const val ACTION_SOS = "com.childtrack.app.SOS"
        const val EXTRA_NOTE = "note"
        private const val CHANNEL_ID = "childtrack_loc"
        private const val NOTIF_ID = 1001
    }

    private lateinit var source: LocationSource
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = mutableListOf<Job>()
    @Volatile private var lastFix: android.location.Location? = null

    private val onFix: (android.location.Location) -> Unit = { loc ->
        lastFix = loc
        val ctx = this
        scope.launch {
            AppDatabase.get(ctx).pointDao().insert(loc.toEntity(Sync.batteryPercent(ctx)))
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startInForeground()
        source = LocationSourceProvider.get(this)
        val period = Prefs.get(this).getInt(Prefs.KEY_PERIOD, 60).coerceAtLeast(10)
        source.start(period, onFix)
        jobs += scope.launch { flusherLoop() }
        jobs += scope.launch { pollLoop() }
        jobs += scope.launch { notifLoop() }
        CommandBus.setListener { sec ->
            source.stop()
            source.start(sec, onFix)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_SOS) {
            val note = intent.getStringExtra(EXTRA_NOTE) ?: ""
            scope.launch { sendSos(note) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        source.stop()
        jobs.forEach { it.cancel() }
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---- foreground ------------------------------------------------------

    private fun startInForeground() {
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text))
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private suspend fun updateNotification() {
        val pending = runCatching { AppDatabase.get(this).pointDao().count() }.getOrDefault(0)
        val last = Sync.lastUploadSuccessAt
        val lastTxt = if (last == 0L) getString(R.string.notif_no_upload)
            else getString(R.string.notif_last_upload, java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(last))
        val err = Sync.lastUploadError
        val text = if (err != null) getString(R.string.notif_failing, err) else lastTxt
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText("$text \u00b7 ${getString(R.string.notif_queued, pending)}")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .build()
        runCatching {
            getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notif)
        }
    }

    // ---- loops -----------------------------------------------------------

    private suspend fun flusherLoop() {
        while (true) {
            try { Sync.flushBatch(this) } catch (_: Throwable) {}
            delay(30_000)
        }
    }

    private suspend fun pollLoop() {
        while (true) {
            try { Sync.poll(this) } catch (_: Throwable) {}
            delay(20_000)
        }
    }

    private suspend fun notifLoop() {
        while (true) {
            updateNotification()
            delay(60_000)
        }
    }

    private suspend fun sendSos(note: String) {
        val ctx = this
        // grab a fresh fix before sending
        val fix = kotlinx.coroutines.withTimeoutOrNull(10_000) {
            kotlinx.coroutines.suspendCancellableCoroutine { cont ->
                source.singleFix { loc ->
                    try { cont.resume(loc) { } } catch (_: Throwable) {}
                }
            }
        } ?: lastFix
        val loc = fix
        if (loc != null) {
            AppDatabase.get(ctx).pointDao().insert(loc.toEntity(Sync.batteryPercent(ctx)))
        }
        delay(1000)
        val base = Prefs.get(this).getString(Prefs.KEY_SERVER, null) ?: return
        val token = Prefs.get(this).getString(Prefs.KEY_TOKEN, null) ?: return
        val obj = org.json.JSONObject().put("note", note)
        if (loc != null) obj.put("lat", loc.latitude).put("lon", loc.longitude)
        Sync.httpPost("$base/api/sos", token, obj.toString().toByteArray(Charsets.UTF_8))
    }
}

fun android.location.Location.toEntity(battery: Int): PointEntity = PointEntity(
    ts = time,
    lat = latitude,
    lon = longitude,
    accuracy = if (hasAccuracy()) accuracy else null,
    altitude = if (hasAltitude()) altitude else null,
    speed = if (hasSpeed()) speed else null,
    bearing = if (hasBearing()) bearing else null,
    battery = if (battery >= 0) battery else null,
)
