package com.childtrack.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.storage.StorageManager
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED) return

        // After a locked boot, direct-boot mode is too early for a location FGS;
        // ACTION_BOOT_COMPLETED fires again once the user unlocks the device.
        if (action == Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val sm = context.getSystemService(Context.STORAGE_SERVICE) as StorageManager
            if (!sm.isUserUnlocked) return
        }

        val sp = Prefs.get(context)
        if (!sp.getBoolean(Prefs.KEY_RUNNING, false)) return
        if (sp.getString(Prefs.KEY_SERVER, null).isNullOrEmpty()) return
        if (sp.getString(Prefs.KEY_TOKEN, null).isNullOrEmpty()) return
        ContextCompat.startForegroundService(
            context, Intent(context, LocationService::class.java)
        )
    }
}
