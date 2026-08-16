#!/usr/bin/env bash
# ChildTrack server auto-installer for Debian (12 / 11).
#
# Usage:
#   1. Copy the whole server/ folder to the VPS and run as root:
#        scp -r server/ root@YOUR_VPS:/tmp/childtrack
#        ssh root@YOUR_VPS "bash /tmp/childtrack/deploy/install.sh"
#   2. Or run locally on the VPS with the repo already present:
#        sudo bash server/deploy/install.sh
#
# Installs: Node.js 20, nginx, systemd unit, HTTPS via certbot,
#           optional fail2ban + nightly SQLite backup cron.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=/opt/childtrack/server
DATA_DIR="$INSTALL_DIR/data"
SERVICE=childtrack

say()  { echo; echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
ask()  { local v; read -r -p "$1" v; printf '%s' "$v"; }
ask_optional() { # $1 prompt, $2 default; prints answer or default if empty
  local v; read -r -p "$1" v
  printf '%s' "${v:-$2}"
}

[ -f "$SRC_DIR/package.json" ] && [ -f "$SRC_DIR/.env.example" ] \
  || die "install.sh must be run from server/deploy/ (cannot find server files near $SRC_DIR)"

# ---- 0. Confirm install ----------------------------------------------------
DOMAIN="$(ask 'Domain (DNS A record must already point here, e.g. track.example.com): ')"
[ -n "$DOMAIN" ] || die "domain is required"
DASH_USER="$(ask_optional 'Dashboard admin username [parent]: ' parent)"
while :; do
  read -r -s -p 'Dashboard admin password (min 8 chars): ' DASH_PASS; echo
  [ ${#DASH_PASS} -ge 8 ] && break
  echo "Password too short." >&2
done
DEVICE_NAME="$(ask_optional 'Device name to register (e.g. kids-phone): ' phone)"
DEVICE_TOKEN="$(openssl rand -hex 32)"
NTFY_URL="$(ask_optional 'ntfy topic URL (optional, e.g. https://ntfy.sh/childtrack-xyz): ' '')"
TG_TOKEN="$(ask_optional 'Telegram bot token (optional): ' '')"
TG_CHAT="$(ask_optional 'Telegram chat id (optional): ' '')"
SMTP_URI="$(ask_optional 'SMTP URI smtps://user:pass@host:465 (optional): ' '')"
CONTACT="$(ask_optional 'Your email (used as Nominatim UA, optional): ' "$DASH_USER@$DOMAIN")"

DO_CERTBOT="$(ask_optional 'Install Let'\''s Encrypt certificate with certbot? [Y/n]: ' Y)"
DO_FAIL2BAN="$(ask_optional 'Install fail2ban (blocks brute-force)? [Y/n]: ' Y)"
DO_BACKUP="$(ask_optional 'Install nightly SQLite backup cron? [Y/n]: ' Y)"
DO_UFW="$(ask_optional 'Configure ufw firewall (allow 22, 80, 443)? [Y/n]: ' Y)"

# ---- 1. System packages ----------------------------------------------------
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg build-essential python3 \
  nginx sqlite3 rsync ufw openssl

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Installing Node.js 20 from nodesource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "need Node >= 20"

# ---- 2. Service user + files ----------------------------------------------
say "Creating system user and installing files to $INSTALL_DIR"
id childtrack >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin childtrack
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude data \
  --exclude test --exclude '*.db*' --exclude '*.log' \
  "$SRC_DIR"/ "$INSTALL_DIR"/
chown -R childtrack:childtrack /opt/childtrack

# ---- 3. npm install --------------------------------------------------------
say "Installing Node dependencies"
sudo -u childtrack -H env HOME=/home/childtrack \
  npm install --omit=dev --no-fund --no-audit --prefix "$INSTALL_DIR"

# ---- 4. .env ---------------------------------------------------------------
say "Writing $INSTALL_DIR/.env"
{
  echo "PORT=8080"
  echo "HOST=127.0.0.1"
  echo "DB_PATH=./data/childtrack.db"
  echo "RETENTION_DAYS=90"
  echo "DEVICES=$DEVICE_NAME:$DEVICE_TOKEN"
  echo "DASH_USER=$DASH_USER"
  echo "DASH_PASS=$DASH_PASS"
  echo "SESSION_DAYS=30"
  echo "TRUST_PROXY=1"
  echo "NOTIFY_NTFY_URL=$NTFY_URL"
  echo "NOTIFY_TELEGRAM_BOT_TOKEN=$TG_TOKEN"
  echo "NOTIFY_TELEGRAM_CHAT_ID=$TG_CHAT"
  echo "NOTIFY_EMAIL_SMTP=$SMTP_URI"
  echo "NOTIFY_EMAIL_FROM=ChildTrack <$CONTACT>"
  echo "NOTIFY_EMAIL_TO=$CONTACT"
  echo "NOMINATIM_URL=https://nominatim.openstreetmap.org"
  echo "NOMINATIM_UA=ChildTrack/0.2 ($CONTACT)"
} > "$INSTALL_DIR/.env"
chown childtrack:childtrack "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

# ---- 5. systemd ------------------------------------------------------------
say "Installing systemd service"
sed "s|/opt/childtrack/server|$INSTALL_DIR|g" "$SRC_DIR/deploy/childtrack.service" \
  > /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable --now $SERVICE
sleep 1
systemctl --no-pager --quiet status $SERVICE || true
curl -fsS http://127.0.0.1:8080/api/health >/dev/null \
  || die "service did not come up — check: journalctl -u $SERVICE -n 50"

# ---- 6. nginx + HTTPS ------------------------------------------------------
say "Configuring nginx for $DOMAIN"
sed "s/track\.example\.com/$DOMAIN/g" "$SRC_DIR/deploy/nginx.conf" \
  > /etc/nginx/sites-available/childtrack
ln -sf /etc/nginx/sites-available/childtrack /etc/nginx/sites-enabled/childtrack
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

case "${DO_CERTBOT,,}" in
  y|yes|'')
    say "Installing Let's Encrypt certificate"
    apt-get install -y -qq certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --redirect --agree-tos -m "$CONTACT" -n
    systemctl reload nginx
    ;;
  *) echo "(skipping certbot — HTTPS not configured; dashboard will run over plain HTTP)" ;;
esac

# ---- 7. Optional extras ----------------------------------------------------
if [[ "${DO_FAIL2BAN,,}" =~ ^(y|yes|)$ ]]; then
  say "Installing fail2ban"
  apt-get install -y -qq fail2ban
  cp "$SRC_DIR/deploy/fail2ban/childtrack.conf" /etc/fail2ban/filter.d/childtrack.conf
  grep -q '^\[childtrack\]' /etc/fail2ban/jail.local 2>/dev/null \
    || cat "$SRC_DIR/deploy/fail2ban/jail.local.snippet" >> /etc/fail2ban/jail.local
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban
fi

if [[ "${DO_BACKUP,,}" =~ ^(y|yes|)$ ]]; then
  say "Installing nightly backup cron"
  install -m755 "$SRC_DIR/deploy/backup.sh" /usr/local/bin/childtrack-backup
  ( crontab -l 2>/dev/null | grep -v childtrack-backup
    echo "0 3 * * *  DB_PATH=$DATA_DIR/childtrack.db /usr/local/bin/childtrack-backup"
  ) | crontab -
fi

if [[ "${DO_UFW,,}" =~ ^(y|yes|)$ ]]; then
  say "Configuring ufw"
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  echo y | ufw enable >/dev/null
fi

# ---- 8. Summary ------------------------------------------------------------
say "Done. Summary:"
echo "  Dashboard:   https://$DOMAIN/   (user: $DASH_USER)"
echo "  Device token (put into the Android app, after 'Start'):"
echo "      $DEVICE_TOKEN"
echo "  DEVICES env for later reference:"
echo "      $DEVICE_NAME:$DEVICE_TOKEN"
echo
echo "  Server:   $INSTALL_DIR        Logs: journalctl -u $SERVICE -f"
echo "  Backup:   /var/backups/childtrack (daily 03:00)"
echo "  Health:   curl https://$DOMAIN/api/health"
echo
echo "Next: build the Android app (android/README.md) and enter the token above."
