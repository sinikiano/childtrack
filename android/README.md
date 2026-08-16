# ChildTrack Android app

Kotlin foreground-service app that samples GPS (FusedLocationProvider, or the
platform `LocationManager` on devices without Google Play Services), batches
uploads as JSON over HTTPS, polls your VPS for parent commands (locate-now,
change interval), and sends SOS messages on the child's request.

## Build

Open the `android/` folder in Android Studio (Hedgehog 2023.1 or newer; AGP 8.7.3,
Kotlin 1.9.24, compile/target SDK 35), or use the CLI:

```bash
cd android
gradle assembleRelease   # or ./gradlew if a wrapper is present
```

Unit tests (JVM): `gradle testDebugUnitTest` (also run in CI).

Signed APK (debug key) lands in `app/build/outputs/apk/release/` and can be
sideloaded directly. For a keystore you control, generate one once:

```bash
keytool -genkey -v -keystore childtrack.jks -keyalg RSA -keysize 2048 \
        -validity 10000 -alias childtrack
```

…then wire it into `app/build.gradle.kts` `signingConfigs { ... }` and point the
release `signingConfig` at it, then re-build.

## Install & configure on the child's phone

1. Sideload the APK (`adb install app-release.apk` or transfer & open).
2. Open ChildTrack and enter:
   - **Server**: `https://track.example.com` (HTTPS required).
   - **Device token**: the value from the server's `DEVICES` env.
   - **Interval**: seconds between GPS samples (default 60).
   - **Lock PIN (optional)**: 4–6 digits; protects the Stop button.
3. Tap **Start**, then grant:
   - Location → **Allow all the time**
   - Notifications (Android 13+)
4. The app opens the **"ignore battery optimizations"** prompt automatically —
   accept it, so the OS doesn't kill the service.

A persistent notification ("ChildTrack is on") stays visible — this is
required by Android and keeps the tracking transparent to your child.
It shows the last upload time and the number of points waiting to upload.

## Behaviour

- **Points are stored in a Room database first**, then uploaded every 30 s in
  batches of up to 200. Nothing is lost if the service dies; if more than
  2000 points pile up (long offline stretch), the oldest are dropped.
- **WorkManager safety net**: every 15 min a background worker flushes the
  queue and polls for commands, even if the OS killed the foreground service.
- Polls `/api/poll` every 20 s for parent commands:
  - `locate_now` → grabs a fresh high-accuracy fix and uploads immediately.
  - `set_interval` → changes the sampling period on the fly.
- **SOS** button in the app grabs a fresh fix and sends `{lat, lon, note}` to
  `/api/sos`, which fans out to ntfy / Telegram / email.
- Auto-restarts after reboot and after app updates (`BootReceiver` handles
  `BOOT_COMPLETED`, `MY_PACKAGE_REPLACED`, `LOCKED_BOOT_COMPLETED`).
- **No-GMS devices**: if Google Play Services is missing, tracking uses the
  platform `LocationManager` (GPS + network providers) with the same queue.

## Transparency

The app always shows: the persistent notification, the app icon, and a
"What's shared" section on the main screen explaining what is sent and when.
Use this app only on devices you legally supervise.
