package com.childtrack.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/** Abstraction over FusedLocationProvider (GMS) and LocationManager (no-GMS). */
interface LocationSource {
    fun start(periodSec: Int, onFix: (Location) -> Unit)
    fun stop()
    fun singleFix(onFix: (Location?) -> Unit)
}

object LocationSourceProvider {
    fun hasGms(context: Context): Boolean {
        val result = GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(context)
        return result == ConnectionResult.SUCCESS
    }

    fun get(context: Context): LocationSource =
        if (hasGms(context)) FusedSource(context) else PlatformSource(context)
}

/** Play Services FusedLocationProviderClient. */
class FusedSource(private val ctx: Context) : LocationSource {

    private val client by lazy { LocationServices.getFusedLocationProviderClient(ctx) }
    private var callback: LocationCallback? = null

    @SuppressLint("MissingPermission")
    override fun start(periodSec: Int, onFix: (Location) -> Unit) {
        val intervalMs = periodSec * 1000L
        val req = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs / 2)
            .setMinUpdateDistanceMeters(10f)
            .build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val loc = result.lastLocation ?: return
                onFix(loc)
            }
        }
        callback = cb
        try {
            client.requestLocationUpdates(req, cb, Looper.getMainLooper())
        } catch (_: SecurityException) { }
    }

    override fun stop() {
        val cb = callback
        if (cb != null) {
            try { client.removeLocationUpdates(cb) } catch (_: Throwable) {}
            callback = null
        }
    }

    @SuppressLint("MissingPermission")
    override fun singleFix(onFix: (Location?) -> Unit) {
        try {
            client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                .addOnSuccessListener { loc -> onFix(loc) }
                .addOnFailureListener { onFix(null) }
        } catch (_: SecurityException) { onFix(null) }
    }
}

/** Fallback using the platform LocationManager (works without Google Play Services). */
class PlatformSource(private val ctx: Context) : LocationSource {

    private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var listener: LocationListener? = null

    private fun finePermission() =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private val providers: List<String>
        get() = if (!finePermission()) emptyList()
            else listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
                .filter { lm.isProviderEnabled(it) }

    @SuppressLint("MissingPermission")
    override fun start(periodSec: Int, onFix: (Location) -> Unit) {
        stop()
        if (providers.isEmpty()) return
        val minTime = periodSec * 1000L
        val minDist = 10f
        val l = LocationListener { loc -> onFix(loc) }
        listener = l
        for (p in providers) {
            try {
                lm.requestLocationUpdates(p, minTime, minDist, l, Looper.getMainLooper())
            } catch (_: Throwable) { }
        }
    }

    override fun stop() {
        val l = listener ?: return
        try { lm.removeUpdates(l) } catch (_: Throwable) {}
        listener = null
    }

    @SuppressLint("MissingPermission")
    override fun singleFix(onFix: (Location?) -> Unit) {
        if (!finePermission()) { onFix(null); return }
        val best = providers.mapNotNull { p ->
            try { lm.getLastKnownLocation(p) } catch (_: Throwable) { null }
        }.maxByOrNull { it.time } ?: lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
        onFix(best)
    }
}
