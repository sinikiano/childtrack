import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const { authenticator } = require('otplib');

import { openDb } from './db.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';
import { notify, notifyConfigured } from './notify.js';
import { isInsideZone, haversineMeters } from './geofence.js';
import { computeTrips } from './trips.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || './data/childtrack.db';
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);
const TRUST_PROXY = parseInt(process.env.TRUST_PROXY || '1', 10);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const NOMINATIM_UA = process.env.NOMINATIM_UA || 'ChildTrack/0.2';

// ---- Devices from env ----------------------------------------------------
const tokenToDevice = new Map();
const deviceToToken = new Map();
const deviceList = [];
for (const pair of (process.env.DEVICES || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const i = pair.indexOf(':');
  if (i < 0) continue;
  const name = pair.slice(0, i).trim();
  const tok  = pair.slice(i + 1).trim();
  if (name && tok) { tokenToDevice.set(tok, name); deviceToToken.set(name, tok); deviceList.push(name); }
}
const devices = [...new Set(deviceList)].sort();
if (devices.length === 0) console.warn('[childtrack] No DEVICES configured.');

// In-memory event bus for real-time pushes to the dashboard (SSE)
const eventsBus = new EventEmitter();

// ---- DB & bootstrap ------------------------------------------------------
const db = openDb(DB_PATH);

// Seed bootstrap admin
{
  const u = process.env.DASH_USER, p = process.env.DASH_PASS;
  const has = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (has === 0 && u && p) {
    const { hash, salt } = hashPassword(p);
    db.prepare('INSERT INTO users(username,pass_hash,pass_salt,role,created) VALUES(?,?,?,?,?)')
      .run(u, hash, salt, 'admin', Date.now());
    console.log(`[childtrack] Seeded admin user "${u}" from env.`);
  }
}

// Ensure device_meta rows
for (const d of devices) {
  db.prepare('INSERT OR IGNORE INTO device_meta(device) VALUES(?)').run(d);
}

// Prepared statements
const stmt = {
  insertLoc: db.prepare(`
    INSERT OR IGNORE INTO locations (device, ts, received, lat, lon, accuracy, altitude, speed, bearing, battery)
    VALUES (@device, @ts, @received, @lat, @lon, @accuracy, @altitude, @speed, @bearing, @battery)
  `),
  updateMeta: db.prepare(`
    UPDATE device_meta
    SET last_seen=@ts, last_battery=COALESCE(@battery,last_battery), last_lat=@lat, last_lon=@lon
    WHERE device=@device
  `),
  getMeta: db.prepare('SELECT * FROM device_meta WHERE device=?'),
  setMetaFlag: (col) => db.prepare(`UPDATE device_meta SET ${col}=? WHERE device=?`),
  zonesForDevice: db.prepare("SELECT * FROM zones WHERE device=? OR device='*'"),
  getZoneState: db.prepare('SELECT * FROM zone_state WHERE zone_id=? AND device=?'),
  setZoneState: db.prepare(`
    INSERT INTO zone_state(zone_id, device, inside, since) VALUES(?,?,?,?)
    ON CONFLICT(zone_id, device) DO UPDATE SET inside=excluded.inside, since=excluded.since
  `),
  setDwellSent: db.prepare('UPDATE zone_state SET dwell_sent=? WHERE zone_id=? AND device=?'),
  insertAlert: db.prepare('INSERT INTO alerts(ts,device,kind,message,data) VALUES(?,?,?,?,?)'),
  queueCommand: db.prepare('INSERT INTO commands(device,kind,payload,created) VALUES(?,?,?,?)'),
  pollCommands: db.prepare('SELECT id,kind,payload FROM commands WHERE device=? AND delivered IS NULL ORDER BY id ASC LIMIT 20'),
  ackCommand: db.prepare('UPDATE commands SET delivered=? WHERE id=?'),
  getShare: db.prepare('SELECT * FROM share_links WHERE token=? AND expires>?'),
};
const insertManyLocs = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows) inserted += stmt.insertLoc.run(r).changes;
  return inserted;
});

// ---- App -----------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': null, // allow plain-HTTP local dev; prod runs behind HTTPS
      'script-src': ["'self'", 'https://unpkg.com'],
      'style-src':  ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      'img-src':    ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com'],
      'connect-src': ["'self'", 'https://nominatim.openstreetmap.org', 'https://*.tile.openstreetmap.org'],
    },
  },
}));
app.set('trust proxy', TRUST_PROXY);
app.use(morgan('tiny'));
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());

const ingestLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
const loginLimiter  = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
const apiLimiter    = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
const shareLimiter  = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

// ---- Maintenance ----------------------------------------------------------
const MaintDayMs = 24 * 3600_000;
async function runMaintenance() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * MaintDayMs;
    const purged = db.prepare('DELETE FROM locations WHERE ts<?').run(cutoff);
    const cachePurged = db.prepare('DELETE FROM geocode_cache WHERE fetched<?').run(cutoff);
    const sessions = db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const shares = db.prepare('DELETE FROM share_links WHERE expires<?').run(Date.now());
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`[childtrack] maintenance: purged ${purged.changes} locations, ${cachePurged.changes} geocode rows, ${sessions.changes} sessions, ${shares.changes} share links`);
  } catch (e) {
    console.warn('[childtrack] maintenance failed:', e.message);
  }
}
runMaintenance();
setInterval(runMaintenance, MaintDayMs).unref();

// ---- Device auth (Bearer) ------------------------------------------------
function authDevice(req, res, next) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1].trim() : '';
  const device = token && tokenToDevice.get(token);
  if (!device) return res.status(401).json({ error: 'unauthorized' });
  req.device = device;
  next();
}

// ---- User session auth ---------------------------------------------------
function getSessionUser(req) {
  const t = req.cookies?.ct_sess;
  if (!t) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, s.expires
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token=? AND s.expires>?
  `).get(t, Date.now());
  return row || null;
}
function requireUser(req, res, next) {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'login required' });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    next();
  });
}

// ---- Geofence + alert evaluation -----------------------------------------
async function logAlert(device, kind, message, data) {
  stmt.insertAlert.run(Date.now(), device, kind, message, data ? JSON.stringify(data) : null);
  eventsBus.emit('alert', { device, kind, message, ts: Date.now() });
  if (notifyConfigured()) {
    notify({ title: `${device}: ${kind}`, message, priority: kind === 'sos' ? 'urgent' : 'high', tag: kind })
      .catch(e => console.warn('[notify]', e.message));
  }
}

async function evaluatePoint(device, p) {
  const now = Date.now();

  // Geofences
  const zones = stmt.zonesForDevice.all(device);
  for (const z of zones) {
    const inside = isInsideZone(z, p) ? 1 : 0;
    const prev = stmt.getZoneState.get(z.id, device)?.inside;
    if (prev === undefined || prev !== inside) {
      stmt.setZoneState.run(z.id, device, inside, now);
      stmt.setDwellSent.run(0, z.id, device);
      if (inside && z.notify_enter) await logAlert(device, 'enter', `Entered zone "${z.name}"`, { zone: z.name });
      if (!inside && z.notify_leave) await logAlert(device, 'leave', `Left zone "${z.name}"`,    { zone: z.name });
      continue;
    }
    // Continuous stay inside → dwell alert
    if (inside && z.dwell_minutes > 0) {
      const st = stmt.getZoneState.get(z.id, device);
      const dwelled = st && st.since && (now - st.since) >= z.dwell_minutes * 60_000;
      if (dwelled && !st.dwell_sent) {
        stmt.setDwellSent.run(1, z.id, device);
        await logAlert(device, 'dwell', `Inside "${z.name}" for ${z.dwell_minutes}+ min`, { zone: z.name });
      }
    }
  }

  // Speed (m/s -> km/h)
  const meta = stmt.getMeta.get(device);
  if (meta && p.speed != null) {
    const kmh = p.speed * 3.6;
    if (kmh > (meta.speed_limit_kmh || 130)) {
      if (!meta.speed_alert_active) {
        stmt.setMetaFlag('speed_alert_active').run(1, device);
        await logAlert(device, 'speed', `Speed ${kmh.toFixed(0)} km/h (limit ${meta.speed_limit_kmh})`, { kmh });
      }
    } else if (meta.speed_alert_active && kmh < (meta.speed_limit_kmh * 0.7)) {
      stmt.setMetaFlag('speed_alert_active').run(0, device);
    }
  }

  // Battery
  if (meta && p.battery != null) {
    if (p.battery <= (meta.battery_low_pct || 15) && !meta.battery_alert_sent) {
      stmt.setMetaFlag('battery_alert_sent').run(1, device);
      await logAlert(device, 'battery', `Battery low: ${p.battery}%`, { pct: p.battery });
    } else if (p.battery > (meta.battery_low_pct || 15) + 10 && meta.battery_alert_sent) {
      stmt.setMetaFlag('battery_alert_sent').run(0, device);
    }
  }

  // back-online recovery
  if (meta && meta.offline_alert_sent) {
    stmt.setMetaFlag('offline_alert_sent').run(0, device);
    await logAlert(device, 'back-online', `Back online`, {});
  }
}

// Offline watchdog
function insideZoneById(id, pt) {
  if (!id) return false;
  const z = db.prepare('SELECT * FROM zones WHERE id=?').get(id);
  return z ? isInsideZone(z, pt) : false;
}

setInterval(async () => {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM device_meta').all();
  for (const m of rows) {
    if (!m.last_seen) continue;
    const ageSec = (now - m.last_seen) / 1000;
    if (ageSec > (m.offline_after_sec || 900) && !m.offline_alert_sent) {
      stmt.setMetaFlag('offline_alert_sent').run(1, m.device);
      await logAlert(m.device, 'offline', `Offline for ${Math.round(ageSec/60)} min`, { ageSec });
    }
  }

  // Schedule checks ("should be at X by 16:00")
  for (const s of db.prepare('SELECT * FROM schedules').all()) {
    if (!devices.includes(s.device)) continue;
    const d = new Date();
    if (s.day_of_week !== -1 && s.day_of_week !== d.getDay()) continue;
    const minsMs = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 1000;
    if (minsMs < s.start_ms || minsMs >= s.end_ms) continue;
    const meta = stmt.getMeta.get(s.device);
    const noFix = !meta || meta.last_seen == null || (now - meta.last_seen) > 15 * 60_000;
    const outOfZone = !noFix && s.zone_id && !insideZoneById(s.zone_id, { lat: meta.last_lat, lon: meta.last_lon });
    if (!noFix && !outOfZone) continue;
    const windowId = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if ((s.last_fired || 0) === windowId) continue;
    db.prepare('UPDATE schedules SET last_fired=? WHERE id=?').run(windowId, s.id);
    const startTxt = `${Math.floor(s.start_ms/3600000).toString().padStart(2,'0')}:${Math.floor(s.start_ms%3600000/60000).toString().padStart(2,'0')}`;
    await logAlert(s.device, 'schedule',
      s.message || `Expected at ${startTxt} but not at the expected place`, { schedule: s.id });
  }
}, 60_000).unref();

// ---- Ingest --------------------------------------------------------------
function sanitize(p, device, now) {
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // Clamp implausible future timestamps (device clock ahead) to "now"
  const tsRaw = Number.isFinite(+p.ts) ? +p.ts : now;
  const ts = tsRaw > now + 5 * 60_000 ? now : tsRaw;
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  const intOrNull = (v) => (Number.isFinite(+v) ? Math.round(+v) : null);
  return {
    device, ts, received: now, lat, lon,
    accuracy: num(p.accuracy), altitude: num(p.altitude),
    speed:    num(p.speed),    bearing:  num(p.bearing),
    battery:  intOrNull(p.battery),
  };
}

app.post('/api/ingest', ingestLimiter, authDevice, async (req, res) => {
  const body = req.body || {};
  const points = Array.isArray(body.points) ? body.points.slice(0, 500) : [body];
  const now = Date.now();
  const rows = points.map(p => sanitize(p, req.device, now)).filter(Boolean);
  if (rows.length === 0) return res.status(400).json({ error: 'no valid points' });
  const inserted = insertManyLocs(rows);
  const last = rows[rows.length - 1];
  stmt.updateMeta.run(last);
  for (const r of rows) {
    try { await evaluatePoint(req.device, r); } catch (e) { console.warn('[eval]', e.message); }
  }
  eventsBus.emit('point', {
    device: req.device, ts: last.ts, lat: last.lat, lon: last.lon,
    accuracy: last.accuracy, battery: last.battery,
  });
  res.json({ ok: true, stored: inserted });
});

// Device polls for parent commands (e.g. locate_now)
app.get('/api/poll', ingestLimiter, authDevice, (req, res) => {
  const rows = stmt.pollCommands.all(req.device);
  const now = Date.now();
  for (const r of rows) stmt.ackCommand.run(now, r.id);
  res.json(rows.map(r => ({ id: r.id, kind: r.kind, payload: r.payload ? JSON.parse(r.payload) : null })));
});

// Child SOS (signed with device token)
app.post('/api/sos', ingestLimiter, authDevice, async (req, res) => {
  const b = req.body || {};
  const note = String(b.note || '').slice(0, 500);
  const lat = Number(b.lat), lon = Number(b.lon);
  const link = (Number.isFinite(lat) && Number.isFinite(lon))
    ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`
    : null;
  const msg = note ? `SOS: ${note}` : 'SOS triggered';
  await logAlert(req.device, 'sos', link ? `${msg}\n${link}` : msg, { lat, lon, note });
  res.json({ ok: true });
});

// ---- Auth endpoints ------------------------------------------------------
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password, code } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !verifyPassword(password, u.pass_hash, u.pass_salt)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (u.totp_enabled) {
    if (!u.totp_secret || !authenticator.check(String(code || ''), u.totp_secret)) {
      return res.status(401).json({ error: '2fa code required or invalid' });
    }
  }
  const token = newToken();
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  db.prepare('INSERT INTO sessions(token,user_id,expires,created) VALUES(?,?,?,?)').run(token, u.id, expires, Date.now());
  res.cookie('ct_sess', token, {
    httpOnly: true, sameSite: 'lax', secure: TRUST_PROXY === 1,
    maxAge: SESSION_DAYS * 86400_000, path: '/',
  });
  res.json({ ok: true, user: { username: u.username, role: u.role, totp_enabled: u.totp_enabled } });
});

app.post('/api/logout', (req, res) => {
  const t = req.cookies?.ct_sess;
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.clearCookie('ct_sess', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'login required' });
  const row = db.prepare('SELECT username, role, totp_enabled FROM users WHERE id=?').get(u.id);
  res.json({
    id: u.id, username: row.username, role: row.role, totp_enabled: row.totp_enabled,
    notify_configured: notifyConfigured(),
  });
});

app.post('/api/password', requireUser, (req, res) => {
  const { old: oldP, new: newP } = req.body || {};
  if (!oldP || !newP) return res.status(400).json({ error: 'missing fields' });
  if (String(newP).length < 8) return res.status(400).json({ error: 'new password must be at least 8 characters' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(String(oldP), u.pass_hash, u.pass_salt)) {
    return res.status(401).json({ error: 'current password is wrong' });
  }
  const { hash, salt } = hashPassword(String(newP));
  db.prepare('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?').run(hash, salt, u.id);
  const cur = req.cookies?.ct_sess;
  if (cur) db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, cur);
  res.json({ ok: true });
});

app.get('/api/sessions', requireUser, (req, res) => {
  const cur = req.cookies?.ct_sess;
  const rows = db.prepare('SELECT token, expires, created FROM sessions WHERE user_id=? ORDER BY created DESC')
    .all(req.user.id);
  res.json(rows.map(s => ({
    token: s.token.slice(0, 8) + '…',
    expires: s.expires,
    created: s.created,
    current: s.token === cur,
  })));
});

app.post('/api/sessions/revoke', requireUser, (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  if (token === req.cookies?.ct_sess) return res.status(400).json({ error: 'cannot revoke current session' });
  const info = db.prepare('DELETE FROM sessions WHERE token LIKE ? AND user_id=?').run(token + '%', req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'session not found' });
  res.json({ ok: true });
});

// TOTP 2FA
app.post('/api/2fa/setup', requireUser, async (req, res) => {
  const secret = authenticator.generateSecret();
  db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(secret, req.user.id);
  const otpauth = authenticator.keyuri(req.user.username, 'ChildTrack', secret);
  const qr = await QRCode.toDataURL(otpauth);
  res.json({ otpauth, qr });
});
app.post('/api/2fa/verify', requireUser, (req, res) => {
  const { code } = req.body || {};
  const u = db.prepare('SELECT totp_secret FROM users WHERE id=?').get(req.user.id);
  if (!u?.totp_secret || !authenticator.check(String(code || ''), u.totp_secret)) {
    return res.status(400).json({ error: 'invalid code' });
  }
  db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});
app.post('/api/2fa/disable', requireUser, (req, res) => {
  const { code } = req.body || {};
  const u = db.prepare('SELECT totp_secret FROM users WHERE id=?').get(req.user.id);
  if (!u?.totp_secret || !authenticator.check(String(code || ''), u.totp_secret)) {
    return res.status(400).json({ error: 'invalid code' });
  }
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});

// Admin: list/add/delete users
app.get('/api/users', requireAdmin, (_req, res) => {
  res.json(db.prepare('SELECT id, username, role, created FROM users ORDER BY id').all());
});
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role = 'parent' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const { hash, salt } = hashPassword(password);
  try {
    db.prepare('INSERT INTO users(username,pass_hash,pass_salt,role,created) VALUES(?,?,?,?,?)')
      .run(username, hash, salt, role, Date.now());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot delete self' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Dashboard data ------------------------------------------------------
app.use('/api', apiLimiter);

app.get('/api/devices', requireUser, (_req, res) => res.json(devices));

app.get('/api/devices/meta', requireUser, (_req, res) => {
  res.json(db.prepare('SELECT * FROM device_meta').all());
});

app.put('/api/devices/:device/meta', requireUser, (req, res) => {
  const { speed_limit_kmh, offline_after_sec, battery_low_pct } = req.body || {};
  const d = req.params.device;
  if (!devices.includes(d)) return res.status(404).json({ error: 'unknown device' });
  db.prepare(`UPDATE device_meta
    SET speed_limit_kmh=COALESCE(?,speed_limit_kmh),
        offline_after_sec=COALESCE(?,offline_after_sec),
        battery_low_pct=COALESCE(?,battery_low_pct)
    WHERE device=?`).run(
      Number.isFinite(+speed_limit_kmh) ? +speed_limit_kmh : null,
      Number.isFinite(+offline_after_sec) ? +offline_after_sec : null,
      Number.isFinite(+battery_low_pct) ? +battery_low_pct : null,
      d
  );
  res.json({ ok: true });
});

app.get('/api/locations', requireUser, (req, res) => {
  const device = String(req.query.device || '');
  const since  = parseInt(String(req.query.since  || '0'), 10) || 0;
  const until  = parseInt(String(req.query.until  || '0'), 10) || Date.now();
  const limit  = Math.min(parseInt(String(req.query.limit || '5000'), 10) || 5000, 50000);
  const downsample = parseInt(String(req.query.downsample || '0'), 10) || 0;
  if (!device) return res.status(400).json({ error: 'device required' });
  let rows = db.prepare(`
    SELECT ts, lat, lon, accuracy, altitude, speed, bearing, battery
    FROM locations
    WHERE device=? AND ts>=? AND ts<=?
    ORDER BY ts ASC LIMIT ?
  `).all(device, since, until, limit);
  if (downsample && rows.length > 4000) {
    const step = Math.ceil(rows.length / 4000);
    rows = rows.filter((r, i) => i % step === 0 || i === rows.length - 1);
  }
  res.json(rows);
});

app.get('/api/stats', requireUser, (req, res) => {
  const device = String(req.query.device || '');
  const since  = parseInt(String(req.query.since || '0'), 10) || 0;
  const until  = parseInt(String(req.query.until || '0'), 10) || Date.now();
  if (!device) return res.status(400).json({ error: 'device required' });
  const rows = db.prepare('SELECT ts, lat, lon FROM locations WHERE device=? AND ts>=? AND ts<=? ORDER BY ts ASC')
    .all(device, since, until);
  let distance = 0;
  const perDay = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) distance += haversineMeters(rows[i - 1], rows[i]);
    const day = new Date(rows[i].ts).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  const activeMs = rows.length > 1 ? rows[rows.length - 1].ts - rows[0].ts : 0;
  res.json({
    distance_m: Math.round(distance),
    points: rows.length,
    active_s: Math.round(activeMs / 1000),
    per_day: [...perDay.entries()].map(([date, pts]) => ({ date, points: pts })),
  });
});

app.get('/api/latest', requireUser, (_req, res) => {
  const rows = db.prepare(`
    SELECT l.device, l.ts, l.lat, l.lon, l.accuracy, l.battery
    FROM locations l
    JOIN (SELECT device, MAX(ts) mts FROM locations GROUP BY device) m
      ON m.device=l.device AND m.mts=l.ts
  `).all();
  res.json(rows);
});

// Device provisioning: QR payload consumed by the Android app's "Scan QR" setup.
// Only admins — exposes the device token.
app.get('/api/provision/:device', requireAdmin, async (req, res) => {
  const d = req.params.device;
  const token = deviceToToken.get(d);
  if (!token) return res.status(404).json({ error: 'unknown device' });
  const server = `${req.protocol}://${req.get('host')}`;
  const payload = { server, token, device: d };
  const qr = await QRCode.toDataURL(JSON.stringify(payload), { width: 260, margin: 1 });
  res.json({ qr, payload });
});

// Server-Sent Events: real-time points + alerts. Client falls back to polling.
app.get('/api/events', requireUser, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (name, data) => {
    try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
  };
  const onPoint = (p) => send('point', p);
  const onAlert = (a) => send('alert', a);
  eventsBus.on('point', onPoint);
  eventsBus.on('alert', onAlert);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
  req.on('close', () => {
    clearInterval(hb);
    eventsBus.off('point', onPoint);
    eventsBus.off('alert', onAlert);
  });
});

app.get('/api/alerts', requireUser, (req, res) => {
  const since = parseInt(String(req.query.since || '0'), 10) || 0;
  const rows = db.prepare(`
    SELECT id, ts, device, kind, message, data
    FROM alerts WHERE ts>=? ORDER BY ts DESC LIMIT 500
  `).all(since);
  res.json(rows);
});

// Zones CRUD
app.get('/api/zones', requireUser, (_req, res) => {
  res.json(db.prepare('SELECT * FROM zones ORDER BY name').all().map(z => ({ ...z, geo: JSON.parse(z.geo) })));
});
app.post('/api/zones', requireUser, (req, res) => {
  const { name, device = '*', kind, geo, notify_enter = 1, notify_leave = 1, dwell_minutes = 0 } = req.body || {};
  if (!name || !['circle','polygon'].includes(kind) || !geo) {
    return res.status(400).json({ error: 'name, kind, geo required' });
  }
  if (kind === 'circle'  && !(Number.isFinite(+geo.lat) && Number.isFinite(+geo.lon) && +geo.radius_m > 0)) {
    return res.status(400).json({ error: 'circle needs lat/lon/radius_m' });
  }
  if (kind === 'polygon' && !(Array.isArray(geo.points) && geo.points.length >= 3)) {
    return res.status(400).json({ error: 'polygon needs >=3 points' });
  }
  const dwell = Math.max(0, Math.min(parseInt(String(dwell_minutes), 10) || 0, 24 * 60));
  const info = db.prepare(`INSERT INTO zones(name,device,kind,geo,notify_enter,notify_leave,dwell_minutes,created)
    VALUES(?,?,?,?,?,?,?,?)`).run(name, device, kind, JSON.stringify(geo),
      notify_enter ? 1 : 0, notify_leave ? 1 : 0, dwell, Date.now());
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/zones/:id', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM zones WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'zone not found' });
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 100) : cur.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  const dwell = b.dwell_minutes !== undefined
    ? Math.max(0, Math.min(parseInt(String(b.dwell_minutes), 10) || 0, 24 * 60))
    : cur.dwell_minutes;
  const notifyEnter = b.notify_enter !== undefined ? (b.notify_enter ? 1 : 0) : cur.notify_enter;
  const notifyLeave = b.notify_leave !== undefined ? (b.notify_leave ? 1 : 0) : cur.notify_leave;
  db.prepare('UPDATE zones SET name=?, dwell_minutes=?, notify_enter=?, notify_leave=? WHERE id=?')
    .run(name, dwell, notifyEnter, notifyLeave, id);
  res.json({ ok: true });
});
app.delete('/api/zones/:id', requireUser, (req, res) => {
  db.prepare('DELETE FROM zones WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Schedules CRUD ("should be at X by 16:00")
app.get('/api/schedules', requireUser, (_req, res) => {
  res.json(db.prepare('SELECT * FROM schedules ORDER BY start_ms').all());
});
app.post('/api/schedules', requireUser, (req, res) => {
  const { device, day_of_week = -1, start_ms, end_ms, zone_id = null, message = '' } = req.body || {};
  if (!devices.includes(device)) return res.status(404).json({ error: 'unknown device' });
  const day = parseInt(String(day_of_week), 10);
  const start = parseInt(String(start_ms), 10), end = parseInt(String(end_ms), 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 86400_000 || start >= end) {
    return res.status(400).json({ error: 'start_ms/end_ms invalid (0..86400000, start<end)' });
  }
  if (day < -1 || day > 6) return res.status(400).json({ error: 'day_of_week must be -1..6' });
  const zone = zone_id ? db.prepare('SELECT id FROM zones WHERE id=?').get(zone_id) : null;
  if (zone_id && !zone) return res.status(404).json({ error: 'unknown zone' });
  const info = db.prepare(`INSERT INTO schedules(device,day_of_week,start_ms,end_ms,zone_id,message,created)
    VALUES(?,?,?,?,?,?,?)`).run(device, day, start, end, zone_id || null, String(message).slice(0, 300), Date.now());
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/schedules/:id', requireUser, (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Parent commands
app.post('/api/devices/:device/locate', requireUser, (req, res) => {
  const d = req.params.device;
  if (!devices.includes(d)) return res.status(404).json({ error: 'unknown device' });
  stmt.queueCommand.run(d, 'locate_now', null, Date.now());
  res.json({ ok: true });
});
app.post('/api/devices/:device/interval', requireUser, (req, res) => {
  const d = req.params.device;
  const sec = parseInt(String(req.body?.seconds || '0'), 10);
  if (!devices.includes(d)) return res.status(404).json({ error: 'unknown device' });
  if (!(sec >= 10 && sec <= 3600)) return res.status(400).json({ error: 'seconds must be 10..3600' });
  stmt.queueCommand.run(d, 'set_interval', JSON.stringify({ seconds: sec }), Date.now());
  res.json({ ok: true });
});

// Trips
app.get('/api/trips', requireUser, (req, res) => {
  const device = String(req.query.device || '');
  const since  = parseInt(String(req.query.since || '0'), 10) || 0;
  const until  = parseInt(String(req.query.until || '0'), 10) || Date.now();
  if (!device) return res.status(400).json({ error: 'device required' });
  const pts = db.prepare(`
    SELECT ts, lat, lon, speed FROM locations
    WHERE device=? AND ts>=? AND ts<=? ORDER BY ts ASC
  `).all(device, since, until);
  res.json(computeTrips(pts));
});

// Export (CSV/GPX)
const xmlEscape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
app.get('/api/export.:fmt', requireUser, (req, res) => {
  const device = String(req.query.device || '');
  const since  = parseInt(String(req.query.since || '0'), 10) || 0;
  const until  = parseInt(String(req.query.until || '0'), 10) || Date.now();
  if (!device) return res.status(400).send('device required');
  const rows = db.prepare(`
    SELECT ts, lat, lon, accuracy, altitude, speed, bearing, battery
    FROM locations WHERE device=? AND ts>=? AND ts<=? ORDER BY ts ASC
  `).all(device, since, until);
  if (req.params.fmt === 'csv') {
    res.type('text/csv').attachment(`${device}.csv`);
    res.write('ts_iso,lat,lon,accuracy_m,altitude_m,speed_mps,bearing_deg,battery_pct\n');
    for (const r of rows) {
      res.write(`${new Date(r.ts).toISOString()},${r.lat},${r.lon},${r.accuracy ?? ''},${r.altitude ?? ''},${r.speed ?? ''},${r.bearing ?? ''},${r.battery ?? ''}\n`);
    }
    res.end();
  } else if (req.params.fmt === 'gpx') {
    res.type('application/gpx+xml').attachment(`${device}.gpx`);
    res.write(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ChildTrack" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${xmlEscape(device)}</name><trkseg>\n`);
    for (const r of rows) {
      res.write(`<trkpt lat="${r.lat}" lon="${r.lon}"><time>${new Date(r.ts).toISOString()}</time>${r.altitude != null ? `<ele>${r.altitude}</ele>` : ''}</trkpt>\n`);
    }
    res.write('</trkseg></trk></gpx>\n');
    res.end();
  } else {
    res.status(400).send('format must be csv or gpx');
  }
});

// Reverse geocoding (cached, throttled).
let lastGeocode = 0;
app.get('/api/geocode', requireUser, async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat/lon required' });
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = db.prepare('SELECT address FROM geocode_cache WHERE key=?').get(key);
  if (cached) return res.json({ address: cached.address, cached: true });
  const wait = Math.max(0, 1100 - (Date.now() - lastGeocode));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();
  try {
    const r = await fetch(`${NOMINATIM_URL}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18`, {
      headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'en' },
    });
    const j = await r.json();
    const addr = j.display_name || '';
    db.prepare('INSERT OR REPLACE INTO geocode_cache(key,address,fetched) VALUES(?,?,?)')
      .run(key, addr, Date.now());
    res.json({ address: addr, cached: false });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Share links
app.post('/api/shares', requireUser, (req, res) => {
  const { device, hours = 24 } = req.body || {};
  if (!devices.includes(device)) return res.status(404).json({ error: 'unknown device' });
  const h = Math.min(Math.max(parseInt(hours,10) || 24, 1), 24 * 365);
  const token = newToken(16);
  const now = Date.now();
  db.prepare('INSERT INTO share_links(token,device,expires,created,created_by) VALUES(?,?,?,?,?)')
    .run(token, device, now + h * 3600_000, now, req.user.username);
  res.json({ token, url: `/s/${token}`, expires: now + h * 3600_000 });
});
app.get('/api/shares', requireUser, (_req, res) => {
  res.json(db.prepare('SELECT token,device,expires,created,created_by FROM share_links WHERE expires>? ORDER BY created DESC')
    .all(Date.now()));
});
app.delete('/api/shares/:token', requireUser, (req, res) => {
  db.prepare('DELETE FROM share_links WHERE token=?').run(req.params.token);
  res.json({ ok: true });
});

// ---- Public share view (read-only, last 24h) ------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), now: Date.now() });
});

app.get('/s/:token', shareLimiter, (req, res) => {
  const s = stmt.getShare.get(req.params.token, Date.now());
  if (!s) return res.status(404).send('Link expired or not found.');
  res.sendFile(path.join(__dirname, '..', 'public', 'share.html'));
});
app.get('/api/share/:token', shareLimiter, (req, res) => {
  const s = stmt.getShare.get(req.params.token, Date.now());
  if (!s) return res.status(404).json({ error: 'not found' });
  const since = Date.now() - 24 * 3600_000;
  const pts = db.prepare(`SELECT ts,lat,lon,accuracy,battery FROM locations
    WHERE device=? AND ts>=? ORDER BY ts ASC`).all(s.device, since);
  res.json({ device: s.device, expires: s.expires, points: pts });
});

// ---- Static dashboard ----------------------------------------------------
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

// Gate dashboard (HTML) behind session — redirect to /login otherwise
app.get('/', (req, res, next) => {
  if (!getSessionUser(req)) return res.redirect('/login');
  next();
});

app.use('/', express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

const server = app.listen(PORT, HOST, () => {
  console.log(`[childtrack] listening on http://${HOST}:${PORT}`);
});

function shutdown(sig) {
  console.log(`[childtrack] ${sig} received, shutting down`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
