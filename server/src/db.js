import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device     TEXT    NOT NULL,
      ts         INTEGER NOT NULL,
      received   INTEGER NOT NULL,
      lat        REAL    NOT NULL,
      lon        REAL    NOT NULL,
      accuracy   REAL,
      altitude   REAL,
      speed      REAL,
      bearing    REAL,
      battery    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_loc_device_ts ON locations(device, ts);
    CREATE INDEX IF NOT EXISTS idx_loc_received ON locations(received);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loc_uniq ON locations(device, ts, lat, lon);

    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'parent',
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token    TEXT PRIMARY KEY,
      user_id  INTEGER NOT NULL,
      expires  INTEGER NOT NULL,
      created  INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS zones (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      device        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      geo           TEXT NOT NULL,
      notify_enter  INTEGER NOT NULL DEFAULT 1,
      notify_leave  INTEGER NOT NULL DEFAULT 1,
      dwell_minutes INTEGER NOT NULL DEFAULT 0,
      created       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_zones_device ON zones(device);

    CREATE TABLE IF NOT EXISTS zone_state (
      zone_id    INTEGER NOT NULL,
      device     TEXT NOT NULL,
      inside     INTEGER NOT NULL,
      since      INTEGER NOT NULL,
      dwell_sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (zone_id, device),
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device      TEXT NOT NULL,
      day_of_week INTEGER NOT NULL DEFAULT -1,
      start_ms    INTEGER NOT NULL,
      end_ms      INTEGER NOT NULL,
      zone_id     INTEGER,
      message     TEXT,
      last_fired  INTEGER,
      created     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_device ON schedules(device);

    CREATE TABLE IF NOT EXISTS alerts (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      device  TEXT NOT NULL,
      kind    TEXT NOT NULL,
      message TEXT NOT NULL,
      data    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
    CREATE INDEX IF NOT EXISTS idx_alerts_device_ts ON alerts(device, ts DESC);

    CREATE TABLE IF NOT EXISTS device_meta (
      device              TEXT PRIMARY KEY,
      last_seen           INTEGER,
      last_battery        INTEGER,
      last_lat            REAL,
      last_lon            REAL,
      speed_limit_kmh     REAL    DEFAULT 130,
      offline_after_sec   INTEGER DEFAULT 900,
      battery_low_pct     INTEGER DEFAULT 15,
      speed_alert_active  INTEGER DEFAULT 0,
      offline_alert_sent  INTEGER DEFAULT 0,
      battery_alert_sent  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS commands (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device    TEXT NOT NULL,
      kind      TEXT NOT NULL,
      payload   TEXT,
      created   INTEGER NOT NULL,
      delivered INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cmd_device ON commands(device, delivered);

    CREATE TABLE IF NOT EXISTS share_links (
      token      TEXT PRIMARY KEY,
      device     TEXT NOT NULL,
      expires    INTEGER NOT NULL,
      created    INTEGER NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS geocode_cache (
      key     TEXT PRIMARY KEY,
      address TEXT,
      fetched INTEGER NOT NULL
    );
  `);

  // Lightweight migrations for existing databases (safe no-ops if column exists)
  const migrations = [
    "ALTER TABLE users ADD COLUMN totp_secret TEXT",
    "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN created INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE zones ADD COLUMN dwell_minutes INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE zone_state ADD COLUMN dwell_sent INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  return db;
}
