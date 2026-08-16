# ChildTrack

Self-hosted, free GPS tracker for your kids' Android phone, synced to your own Debian VPS.

## Features

- Live map (Leaflet + OpenStreetMap) with marker clustering and heatmap.
- Geofences (circle or polygon) drawn on the map; enter / leave alerts.
- **Dwell alerts** — notify if the child stays inside a zone longer than N minutes.
- **Schedule alerts** — e.g. "should be at school by 16:00", per day-of-week window.
- Speed alerts (configurable km/h threshold).
- Low-battery and "device offline" alerts.
- **History view** — animated route playback + per-day distance/points stats.
- Trips view (auto-segmented routes with distance + duration) and CSV/GPX export.
- Notification channels: ntfy, Telegram bot (pick any/all).
- Parent-initiated "Request location now" (polled, no Google FCM needed).
- Child-initiated SOS button in the app.
- Reverse geocoding via Nominatim (cached, rate-limited).
- Multi-user dashboard with cookie sessions and `admin`/`parent` roles.
- **TOTP 2FA** (Google Authenticator / Aegis), password change, session management.
- Per-device, time-limited public share links (`/s/<token>`).
- **PWA dashboard** — installable, works offline for static assets.
- Hardening: helmet + CSP, rate limiting, fail2ban filter, nightly SQLite backup,
  data retention (default 90 days), Docker / docker-compose packaging.
- **Tests** (`node --test`, 25 tests) + GitHub Actions CI (lint + tests).

## Android app reliability

- GPS points are **persisted in a Room database** on the device — nothing is lost
  if the service or app is killed (bounded queue, drops oldest beyond 2000).
- **WorkManager fallback** keeps flushing the queue and polling for commands every
  15 min even if the OS kills the foreground service.
- **No-Google-Services fallback**: devices without Play Services use the platform
  `LocationManager` instead of the fused provider.
- Foreground notification shows live status (last upload time, queued count).
- Auto-starts after reboot and app update; requests battery-optimization exemption.
- Optional 4–6 digit **PIN lock** protecting the Stop button (set by the parent).
- Visible, transparent tracking: persistent notification + in-app "what's shared" info.

## Layout

- `server/` — Node.js + SQLite REST API and web dashboard.
- `android/` — Kotlin app with foreground service.

## Get started

1. Deploy the server: [server/README.md](server/README.md).
2. Build the app: [android/README.md](android/README.md).

## Security & ethics

- All tracking is **visible** to the device user (persistent notification, app icon).
- Use only on devices you legally supervise (your own minor children).
- Always run the dashboard behind HTTPS.
- Each device has its own long random Bearer token; rotate via `.env` if leaked.
- No mic/camera capture — this project only tracks location.
