package com.childtrack.app

import android.content.Context
import android.os.BatteryManager
import com.childtrack.app.db.AppDatabase
import com.childtrack.app.db.PointEntity
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Shared network + persistence logic used by LocationService and WorkFlusher. */
object Sync {

    private const val MAX_QUEUE = 2000
    private const val DROP_WHEN_OVERFLOW = 500
    private const val BATCH_SIZE = 200

    @Volatile var lastUploadSuccessAt: Long = 0
    @Volatile var lastUploadError: String? = null

    /** Upload oldest queued points; returns how many were stored on the server. */
    suspend fun flushBatch(ctx: Context): Int {
        val dao = AppDatabase.get(ctx).pointDao()
        val rows = dao.getOldest(BATCH_SIZE)
        if (rows.isEmpty()) return 0
        val base = Prefs.get(ctx).getString(Prefs.KEY_SERVER, null) ?: return 0
        val token = Prefs.get(ctx).getString(Prefs.KEY_TOKEN, null) ?: return 0

        val batch = JSONArray()
        for (r in rows) batch.put(r.toJson())
        val body = JSONObject().put("points", batch).toString().toByteArray(Charsets.UTF_8)
        val code = httpPost("$base/api/ingest", token, body)
        if (code !in 200..299) {
            if (code > 0) lastUploadError = "HTTP $code"
            return 0
        }
        dao.deleteByIds(rows.map { it.id })
        lastUploadSuccessAt = System.currentTimeMillis()
        lastUploadError = null
        val pending = dao.count()
        if (pending > MAX_QUEUE) dao.dropOldest(DROP_WHEN_OVERFLOW)
        return rows.size
    }

    /** Poll for parent commands (locate_now, set_interval). */
    suspend fun poll(ctx: Context): Boolean {
        val base = Prefs.get(ctx).getString(Prefs.KEY_SERVER, null) ?: return false
        val token = Prefs.get(ctx).getString(Prefs.KEY_TOKEN, null) ?: return false
        val resp = httpGet("$base/api/poll", token) ?: return false
        return try {
            val dao = AppDatabase.get(ctx).pointDao()
            val arr = JSONArray(resp)
            for (i in 0 until arr.length()) {
                val cmd = arr.getJSONObject(i)
                when (cmd.optString("kind")) {
                    "locate_now" -> {
                        val loc = kotlinx.coroutines.withTimeoutOrNull(10_000) {
                            LocationSourceProvider.get(ctx).let { src ->
                                var fix: android.location.Location? = null
                                kotlinx.coroutines.suspendCancellableCoroutine { cont ->
                                    src.singleFix { loc ->
                                        fix = loc
                                        try { cont.resume(Unit) { } } catch (_: Throwable) {}
                                    }
                                }
                                fix
                            }
                        }
                        if (loc != null) {
                            dao.insert(PointEntity(
                                ts = loc.time,
                                lat = loc.latitude,
                                lon = loc.longitude,
                                accuracy = loc.accuracy,
                                altitude = if (loc.hasAltitude()) loc.altitude else null,
                                speed = if (loc.hasSpeed()) loc.speed else null,
                                bearing = if (loc.hasBearing()) loc.bearing else null,
                                battery = batteryPercent(ctx),
                            ))
                        }
                    }
                    "set_interval" -> {
                        val sec = cmd.optJSONObject("payload")?.optInt("seconds", 0) ?: 0
                        if (sec in 10..3600) {
                            Prefs.get(ctx).edit().putInt(Prefs.KEY_PERIOD, sec).apply()
                            CommandBus.onIntervalChanged(sec)
                        }
                    }
                }
            }
            true
        } catch (_: Throwable) { false }
    }

    fun batteryPercent(ctx: Context): Int = try {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    } catch (_: Throwable) { -1 }

    fun httpPost(urlStr: String, token: String, body: ByteArray): Int {
        return try {
            val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; doOutput = true
                connectTimeout = 15_000; readTimeout = 20_000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
            }
            try {
                conn.outputStream.use { it.write(body) }
                conn.responseCode
            } finally { conn.disconnect() }
        } catch (_: Exception) { -1 }
    }

    fun httpGet(urlStr: String, token: String): String? {
        return try {
            val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000; readTimeout = 20_000
                setRequestProperty("Authorization", "Bearer $token")
            }
            try {
                if (conn.responseCode in 200..299)
                    conn.inputStream.bufferedReader().use { it.readText() }
                else null
            } finally { conn.disconnect() }
        } catch (_: Exception) { null }
    }
}

/** Simple bus so LocationService can react to interval changes from WorkManager. */
object CommandBus {
    @Volatile private var listener: ((Int) -> Unit)? = null
    fun setListener(fn: (Int) -> Unit) { listener = fn }
    fun onIntervalChanged(sec: Int) { listener?.invoke(sec) }
}

fun PointEntity.toJson(): JSONObject = JSONObject().apply {
    put("ts", ts)
    put("lat", lat)
    put("lon", lon)
    if (accuracy != null) put("accuracy", accuracy)
    if (altitude != null) put("altitude", altitude)
    if (speed != null) put("speed", speed)
    if (bearing != null) put("bearing", bearing)
    if (battery != null && battery >= 0) put("battery", battery)
}
