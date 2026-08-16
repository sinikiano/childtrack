# ChildTrack server

Node.js 20 + Express + SQLite. Stateless except for the SQLite file in `data/`.

## One-command deploy on a fresh Debian VPS

From your PC, after pointing the domain's A record at the VPS:

```bash
scp -r server/ root@YOUR_VPS:/tmp/childtrack
ssh root@YOUR_VPS "bash /tmp/childtrack/deploy/install.sh"
```

The script installs Node 20 + nginx, creates the `childtrack` user, copies the
files to `/opt/childtrack/server`, generates `.env` (random device token),
starts the systemd service, sets up HTTPS via certbot, and optionally fail2ban,
ufw and the nightly backup cron. See `deploy/install.sh` for details.

## Quick deploy on Debian (bare metal, manual)

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg build-essential nginx sqlite3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

sudo useradd --system --create-home --shell /usr/sbin/nologin childtrack
sudo mkdir -p /opt/childtrack
sudo chown childtrack:childtrack /opt/childtrack
# copy this `server/` directory to /opt/childtrack/server (scp / rsync / git clone)

cd /opt/childtrack/server
sudo -u childtrack npm install --omit=dev
sudo -u childtrack cp .env.example .env
sudo -u childtrack openssl rand -hex 32   # one per child device
sudo -u childtrack nano .env              # set DEVICES, DASH_USER, DASH_PASS, RETENTION_DAYS, notifications

sudo cp deploy/childtrack.service /etc/systemd/system/childtrack.service
sudo systemctl daemon-reload
sudo systemctl enable --now childtrack
```

### nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/childtrack
sudo ln -s /etc/nginx/sites-available/childtrack /etc/nginx/sites-enabled/
# edit server_name to your domain
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d track.example.com
```

## Quick deploy with Docker

```bash
cp .env.example .env
nano .env    # same as above
docker compose up -d
# put it behind nginx the same way
```

## First login

The first start auto-creates an admin user from `DASH_USER` / `DASH_PASS`.
Open `https://track.example.com/`, sign in, then add more users in **Users**
or via CLI:

```bash
sudo -u childtrack node src/cli-user.js alice 'strong-pass'        # parent
sudo -u childtrack node src/cli-user.js admin2 'strong-pass' admin
```

## Tests

```bash
npm test        # 25 tests: geofence math, trips, auth, full HTTP API (temp DB)
npm run lint    # ESLint (src, test, public)
```

## Notifications

In `.env` set any combination:

```ini
# ntfy (self-host on your VPS or use https://ntfy.sh/<random-topic>)
NOTIFY_NTFY_URL=https://ntfy.sh/childtrack-some-random-topic

# Telegram (create bot via @BotFather, then /start it, then read chat id from
#   https://api.telegram.org/bot<TOKEN>/getUpdates )
NOTIFY_TELEGRAM_BOT_TOKEN=123:abc
NOTIFY_TELEGRAM_CHAT_ID=987654321

# SMTP
NOTIFY_EMAIL_SMTP=smtps://user:pass@smtp.example.com:465
NOTIFY_EMAIL_FROM=ChildTrack <track@example.com>
NOTIFY_EMAIL_TO=parent@example.com
```

Restart: `sudo systemctl restart childtrack`.

## 2FA

Each dashboard user can enable TOTP 2FA in **Devices → Account**: scan the QR
with Google Authenticator / Aegis. After that, logins require a 6-digit code.

## Backups

```bash
sudo install -m755 deploy/backup.sh /usr/local/bin/childtrack-backup
sudo crontab -e
#  0 3 * * *  DB_PATH=/opt/childtrack/server/data/childtrack.db /usr/local/bin/childtrack-backup
```

For off-site, install `rclone` and uncomment the line in `backup.sh`.

## fail2ban

```bash
sudo cp deploy/fail2ban/childtrack.conf /etc/fail2ban/filter.d/childtrack.conf
sudo sh -c 'cat deploy/fail2ban/jail.local.snippet >> /etc/fail2ban/jail.local'
sudo systemctl reload fail2ban
```

## Operations

- `GET /api/health` — uptime probe (used by the Docker healthcheck).
- Daily maintenance: purges expired sessions/share links, deletes location and
  geocode-cache rows older than `RETENTION_DAYS` (default 90), WAL checkpoint.
- Graceful shutdown on SIGTERM/SIGINT.

## API quick reference

Device (uses Bearer device token):
- `POST /api/ingest`  — JSON `{lat,lon,ts,accuracy,altitude,speed,bearing,battery}` or `{points:[...]}` (max 500)
- `GET  /api/poll`    — returns pending parent commands (`locate_now`, `set_interval`)
- `POST /api/sos`     — `{note,lat,lon}`

Dashboard (cookie session):
- `POST /api/login` (+ optional `code` for 2FA), `POST /api/logout`, `GET /api/me`
- `GET  /api/devices`, `GET /api/devices/meta`, `PUT /api/devices/:device/meta`
- `GET  /api/locations?device=&since=&until=&limit=&downsample=`
- `GET  /api/stats?device=&since=&until=` — distance, active time, per-day points
- `GET  /api/latest`, `GET /api/alerts`
- `GET /api/zones`, `POST /api/zones` (+ `dwell_minutes`), `PUT /api/zones/:id`, `DELETE /api/zones/:id`
- `GET /api/schedules`, `POST /api/schedules`, `DELETE /api/schedules/:id`
- `POST /api/devices/:device/locate`, `POST /api/devices/:device/interval`
- `GET /api/trips?device=&since=&until=`
- `GET /api/export.csv?...`, `GET /api/export.gpx?...`
- `GET /api/geocode?lat=&lon=`
- `POST /api/shares {device,hours}`, `GET /api/shares`, `DELETE /api/shares/:token`
- `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id` (admin only)
- `POST /api/password {old,new}` — change password, logs out other sessions
- `POST /api/2fa/setup`, `POST /api/2fa/verify {code}`, `POST /api/2fa/disable {code}`
- `GET /api/sessions`, `POST /api/sessions/revoke {token}`

Public:
- `GET /s/:token` — read-only shared map (last 24 h).
