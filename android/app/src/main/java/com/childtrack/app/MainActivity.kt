package com.childtrack.app

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.security.MessageDigest

class MainActivity : AppCompatActivity() {

    private val permsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        if (result.values.all { it }) startTracking() else status(getString(R.string.status_perms_denied))
    }

    private val bgLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* user choice; tracking still works in foreground */ }

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) applyProvision(result.contents)
        else status(getString(R.string.status_scan_bad))
    }

    private lateinit var etServer: EditText
    private lateinit var etToken: EditText
    private lateinit var etInterval: EditText
    private lateinit var etPin: EditText
    private lateinit var tvStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        etServer   = findViewById(R.id.etServer)
        etToken    = findViewById(R.id.etToken)
        etInterval = findViewById(R.id.etInterval)
        etPin      = findViewById(R.id.etPin)
        tvStatus   = findViewById(R.id.tvStatus)

        val sp = Prefs.get(this)
        etServer.setText(sp.getString(Prefs.KEY_SERVER, ""))
        etToken.setText(sp.getString(Prefs.KEY_TOKEN, ""))
        etInterval.setText(sp.getInt(Prefs.KEY_PERIOD, 60).toString())

        findViewById<Button>(R.id.btnStart).setOnClickListener { onStartClicked() }
        findViewById<Button>(R.id.btnStop).setOnClickListener { onStopClicked() }
        findViewById<Button>(R.id.btnSos).setOnClickListener { onSosClicked() }
        findViewById<Button>(R.id.btnScan).setOnClickListener { startQrScan() }

        if (sp.getBoolean(Prefs.KEY_RUNNING, false)) status(getString(R.string.status_running))
        else applyBuiltinProvision()
    }

    // QR setup from the parent's panel (Devices -> Setup QR): {"server":..., "token":..., "device":...}
    private fun startQrScan() {
        val opts = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt(getString(R.string.scan_prompt))
            .setCameraId(0)
            .setBeepEnabled(false)
            .setOrientationLocked(false)
        scanLauncher.launch(opts)
    }

    private fun applyProvision(raw: String) {
        try {
            val o = JSONObject(raw)
            val server = o.optString("server", "").trimEnd('/')
            val token = o.optString("token", "")
            if (!server.startsWith("https://") || token.isEmpty()) {
                status(getString(R.string.status_scan_bad)); return
            }
            etServer.setText(server)
            etToken.setText(token)
            status(getString(R.string.status_provisioned))
        } catch (_: Exception) {
            status(getString(R.string.status_scan_bad))
        }
    }

    // Auto-built APKs carry assets/provision.json (written by the CI pipeline) — fill the form once.
    private fun applyBuiltinProvision() {
        try {
            val raw = assets.open("provision.json").bufferedReader().use { it.readText() }
            val o = JSONObject(raw)
            val server = o.optString("server", "").trimEnd('/')
            val token = o.optString("token", "")
            if (server.startsWith("https://") && token.isNotEmpty() &&
                etServer.text.isNullOrEmpty() && etToken.text.isNullOrEmpty()
            ) {
                etServer.setText(server)
                etToken.setText(token)
                status(getString(R.string.status_provisioned))
            }
        } catch (_: Exception) { /* no built-in provision — normal for manual builds */ }
    }

    private fun onStartClicked() {
        val server = etServer.text.toString().trim().trimEnd('/')
        val token  = etToken.text.toString().trim()
        val period = etInterval.text.toString().toIntOrNull()?.coerceIn(10, 3600) ?: 60
        val pin    = etPin.text.toString().trim()
        if (server.isEmpty() || !server.startsWith("https://")) { status(getString(R.string.status_bad_url)); return }
        if (token.isEmpty()) { status(getString(R.string.status_no_token)); return }
        if (pin.isNotEmpty() && !Regex("\\d{4,6}").matches(pin)) { status(getString(R.string.status_bad_pin)); return }

        Prefs.get(this).edit()
            .putString(Prefs.KEY_SERVER, server)
            .putString(Prefs.KEY_TOKEN, token)
            .putInt(Prefs.KEY_PERIOD, period)
            .putBoolean(Prefs.KEY_RUNNING, true)
            .apply()
        if (pin.isNotEmpty()) {
            Prefs.get(this).edit().putString(Prefs.KEY_PIN_HASH, sha256(pin)).apply()
            etPin.text?.clear()
        }

        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) needed += Manifest.permission.POST_NOTIFICATIONS
        val missing = needed.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) permsLauncher.launch(missing.toTypedArray())
        else startTracking()
    }

    private fun onStopClicked() {
        val stored = Prefs.get(this).getString(Prefs.KEY_PIN_HASH, null)
        if (stored != null) {
            val input = EditText(this).apply {
                hint = getString(R.string.pin_hint)
                inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
            }
            AlertDialog.Builder(this)
                .setTitle(R.string.pin_title)
                .setView(input)
                .setPositiveButton(R.string.pin_ok) { _, _ ->
                    if (sha256(input.text.toString()) == stored) doStop()
                    else status(getString(R.string.status_wrong_pin))
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        } else {
            doStop()
        }
    }

    private fun doStop() {
        stopService(Intent(this, LocationService::class.java))
        WorkFlusher.cancel(this)
        Prefs.get(this).edit().putBoolean(Prefs.KEY_RUNNING, false).apply()
        status(getString(R.string.status_stopped))
    }

    private fun startTracking() {
        requestBatteryExemption()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        ContextCompat.startForegroundService(this, Intent(this, LocationService::class.java))
        WorkFlusher.schedule(this)
        status(getString(R.string.status_running))
    }

    private fun requestBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            )
        } catch (_: Exception) { /* user can set it manually */ }
    }

    private fun onSosClicked() {
        val input = EditText(this).apply { hint = getString(R.string.sos_note_hint) }
        AlertDialog.Builder(this)
            .setTitle(R.string.sos_title)
            .setView(input)
            .setPositiveButton(R.string.sos_send) { _, _ ->
                val sp = Prefs.get(this)
                if (sp.getString(Prefs.KEY_SERVER, "").isNullOrEmpty() ||
                    sp.getString(Prefs.KEY_TOKEN, "").isNullOrEmpty()) {
                    status(getString(R.string.status_need_config)); return@setPositiveButton
                }
                val intent = Intent(this, LocationService::class.java).apply {
                    action = LocationService.ACTION_SOS
                    putExtra(LocationService.EXTRA_NOTE, input.text.toString())
                }
                ContextCompat.startForegroundService(this, intent)
                status(getString(R.string.status_sos_sent))
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun status(msg: String) { tvStatus.text = msg }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }
}
