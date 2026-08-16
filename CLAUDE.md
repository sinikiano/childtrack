# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ChildTrack is a self-hosted GPS tracking system consisting of:
- **Server**: Node.js 20 + Express + SQLite REST API with web dashboard (PWA)
- **Android App**: Kotlin foreground service with Room database for reliable location tracking

The system enables parents to track their children's Android devices via a web dashboard, with geofencing alerts, trip history, and multiple notification channels (ntfy, Telegram, SMTP).

## Development Commands

### Server (Node.js)

```bash
cd server
npm install                    # Install dependencies
npm run dev                    # Run with --watch for auto-reload
npm start                      # Production start
npm test                       # Run all tests (25 tests using node --test)
npm run lint                   # ESLint on src, test, and public directories
node src/cli-user.js <username> <password> [admin]  # Add dashboard user
```

### Android App (Kotlin)

```bash
cd android
gradle assembleRelease         # Build release APK
gradle testDebugUnitTest       # Run unit tests
```

Open `android/` in Android Studio (Hedgehog 2023.1+, AGP 8.7.3, Kotlin 1.9.24, SDK 35) for development.

## Architecture

### Server Structure (`server/src/`)

- **index.js** (37KB) — Main Express app with all API routes, middleware setup (helmet, rate limiting), session management, WebSocket-like polling, and daily maintenance cron. This is the central orchestrator.
- **db.js** — SQLite database schema and queries (better-sqlite3). Tables: users, sessions, devices, locations, zones, schedules, alerts, geocode_cache, trips, shares. Handles migrations, maintenance, and data retention.
- **auth.js** — Password hashing (crypto.scrypt), TOTP 2FA verification (otplib).
- **notify.js** — Multi-channel notifications (ntfy, Telegram, SMTP via nodemailer). Fires on geofence/speed/battery/dwell/schedule alerts and SOS.
- **geofence.js** — Point-in-polygon and point-in-circle math for geofence alerts.
- **trips.js** — Auto-segments location history into trips (stationary vs. moving), calculates distances.
- **cli-user.js** — CLI tool to add dashboard users (admin or parent role).

### Frontend (`server/public/`)

- **app.js** — Main dashboard SPA: Leaflet map with clustering/heatmap, geofence drawing, trip playback, device management, user/session admin, 2FA setup.
- **login.js** — Login page with TOTP 2FA support.
- **share.js** — Public read-only map for share links.
- **sw.js** + **register-sw.js** — Service worker for PWA offline caching.

### Android Structure (`android/app/src/main/java/com/childtrack/app/`)

- **MainActivity.kt** — Settings UI (server URL, device token, interval, lock PIN), start/stop controls.
- **LocationService.kt** — Foreground service that samples GPS at configured intervals, persists to Room DB, triggers uploads and polling.
- **LocationSource.kt** — Abstraction over FusedLocationProvider (Google Play Services) and platform LocationManager (no-GMS fallback).
- **Sync.kt** — Batches up to 200 points from Room DB and POSTs to `/api/ingest`, polls `/api/poll` for parent commands.
- **WorkFlusher.kt** — WorkManager background job (every 15 min) that flushes the queue and polls even if the foreground service is killed.
- **BootReceiver.kt** — BroadcastReceiver that auto-starts tracking after device reboot or app update.
- **db/** — Room database (AppDatabase, PointEntity, PointDao) for persistent GPS point queue (max 2000, FIFO).
- **Prefs.kt** — SharedPreferences wrapper for app configuration.

### Key Integration Points

1. **Device Ingest**: Android app → `POST /api/ingest` with `{points:[{lat,lon,ts,accuracy,altitude,speed,bearing,battery}]}` (max 500 per request). Uses Bearer token auth.
2. **Command Polling**: Android app → `GET /api/poll` every 20s, server returns `{commands:[{type:'locate_now'|'set_interval', value}]}`.
3. **SOS Flow**: Android grabs fresh high-accuracy fix → `POST /api/sos {note,lat,lon}` → server fires notify.js to all configured channels.
4. **Geofence Alerts**: New location triggers geofence.js checks against zones table → alert saved to DB → notify.js sends notification → dashboard polls `/api/alerts`.

## Testing

- **Server**: Uses Node's built-in test runner (`node --test`). Files in `test/` directory: `api.test.js` (full HTTP API with supertest), `auth.test.js`, `geofence.test.js`, `trips.test.js`. Tests use an in-memory temporary database.
- **Android**: JUnit unit tests in `android/app/src/test/`. Run via `gradle testDebugUnitTest`.
- **CI**: GitHub Actions runs `npm test` and `npm run lint` on push.

## Database Schema (SQLite)

Primary tables:
- **locations**: GPS points (device, lat, lon, ts, accuracy, altitude, speed, bearing, battery, created_at)
- **devices**: Device metadata (name, last_seen, battery, speed_threshold, custom location commands)
- **zones**: Geofences (name, type=circle|polygon, coords JSON, dwell_minutes, created_by)
- **schedules**: Time-based location alerts (device, day_of_week, start_time, end_time, zone_id, created_by)
- **alerts**: History of triggered alerts (type, device, message, lat, lon, ts, dismissed)
- **users**: Dashboard users (username, password_hash, role=admin|parent, totp_secret)
- **sessions**: Cookie sessions (token, user_id, expires_at, user_agent, ip)
- **trips**: Auto-segmented routes (device, start_ts, end_ts, distance, duration, points JSON)
- **shares**: Time-limited public share links (token, device, expires_at)
- **geocode_cache**: Nominatim reverse geocoding cache (lat_lon_key, address, cached_at)

## Configuration

Server uses `.env` (copy from `.env.example`):
- `DEVICES` — JSON array of `{name, token}` objects (one per child device)
- `DASH_USER`, `DASH_PASS` — First admin user (auto-created on startup)
- `SESSION_SECRET` — Cookie signing key
- `RETENTION_DAYS` — Auto-delete locations older than N days (default 90)
- `NOTIFY_NTFY_URL`, `NOTIFY_TELEGRAM_BOT_TOKEN`, `NOTIFY_EMAIL_SMTP` — Notification channels (optional, can use any/all)

Android app stores config in SharedPreferences (set via MainActivity UI).

## Deployment

Server deploys via:
1. **One-command VPS deploy**: `scp` + `ssh root@VPS "bash /tmp/childtrack/deploy/install.sh"` (Debian, sets up Node, nginx, HTTPS, systemd, fail2ban, backups)
2. **Docker**: `docker compose up -d` (uses `server/Dockerfile`)
3. **Manual**: systemd service (`deploy/childtrack.service`), nginx reverse proxy (`deploy/nginx.conf`)

Android app: Build signed APK and sideload (see `android/README.md`).

## Security Notes

- All dashboard routes require cookie session auth (except `/api/login`, `/s/:token`).
- Device routes (`/api/ingest`, `/api/poll`, `/api/sos`) use Bearer token auth.
- helmet + CSP headers, rate limiting (express-rate-limit), fail2ban filter for login attempts.
- TOTP 2FA optional per user (otplib + qrcode).
- Password changes revoke all other sessions.
- Data retention auto-purges old locations (GDPR-friendly).

## Common Development Tasks

### Add a new API endpoint
1. Add route in `server/src/index.js` (around line 200–800, grouped by function)
2. Add database queries in `server/src/db.js` if needed
3. Update tests in `server/test/api.test.js`
4. If adding to dashboard, update `server/public/app.js`

### Add a new alert type
1. Extend alert logic in `server/src/index.js` (search for `db.saveAlert`)
2. Update `server/src/notify.js` message formatting
3. Add UI handling in `server/public/app.js` (alerts panel)

### Modify Android tracking behavior
1. Sampling interval/logic: `LocationService.kt`
2. Upload batching: `Sync.kt`
3. Persistent queue: `db/PointEntity.kt`, `db/PointDao.kt`
4. Fallback worker: `WorkFlusher.kt`

### Run single test file
```bash
cd server
node --test test/geofence.test.js
```
