import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'ct-api-'));
const PORT = 8123 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'testtoken123';
let server;

before(async () => {
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: path.join(dir, 'test.db'),
      DEVICES: `alice:${TOKEN}`,
      DASH_USER: 'admin',
      DASH_PASS: 'testpass',
      TRUST_PROXY: '0',
      RETENTION_DAYS: '90',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errTail = '';
  server.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
  // wait for readiness
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server failed to start:\n${errTail}`);
});

after(() => {
  server?.kill('SIGTERM');
});

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpass' }),
  });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('health endpoint', async () => {
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
});

test('ingest rejects without token', async () => {
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: 1, lon: 1 }),
  });
  assert.equal(r.status, 401);
});

test('ingest accepts valid points and stores them', async () => {
  const now = Date.now();
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      points: [
        { ts: now - 60_000, lat: 40.7128, lon: -74.0060, accuracy: 5, battery: 88 },
        { ts: now, lat: 40.7130, lon: -74.0058, accuracy: 4, battery: 87 },
      ],
    }),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.stored, 2);
});

test('ingest rejects invalid coordinates', async () => {
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ lat: 999, lon: 0 }),
  });
  assert.equal(r.status, 400);
});

test('login with wrong password fails', async () => {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'nope' }),
  });
  assert.equal(r.status, 401);
});

test('dashboard: devices, locations, stats, zones CRUD', async () => {
  const cookie = await login();
  const headers = { Cookie: cookie };

  const devs = await (await fetch(`${BASE}/api/devices`, { headers })).json();
  assert.deepEqual(devs, ['alice']);

  const locs = await (await fetch(`${BASE}/api/locations?device=alice&since=0`, { headers })).json();
  assert.equal(locs.length, 2);

  const stats = await (await fetch(`${BASE}/api/stats?device=alice&since=0`, { headers })).json();
  assert.equal(stats.points, 2);
  assert.ok(stats.distance_m > 0);

  // zones
  const zr = await fetch(`${BASE}/api/zones`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Home', kind: 'circle', geo: { lat: 40.71, lon: -74.0, radius_m: 500 }, dwell_minutes: 30 }),
  });
  assert.equal(zr.status, 200);
  await zr.json();
  const zones = await (await fetch(`${BASE}/api/zones`, { headers })).json();
  assert.equal(zones.length, 1);
  assert.equal(zones[0].dwell_minutes, 30);

  // schedules
  const sr = await fetch(`${BASE}/api/schedules`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: 'alice', day_of_week: -1, start_ms: 8 * 3600_000, end_ms: 9 * 3600_000 }),
  });
  assert.equal(sr.status, 200);
  const scheds = await (await fetch(`${BASE}/api/schedules`, { headers })).json();
  assert.equal(scheds.length, 1);

  // password change
  const pr = await fetch(`${BASE}/api/password`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old: 'testpass', new: 'newpass123' }),
  });
  assert.equal(pr.status, 200);
  // old password no longer works
  const oldLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpass' }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'newpass123' }),
  });
  assert.equal(newLogin.status, 200);
  // restore for the remaining tests
  const back = await fetch(`${BASE}/api/password`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old: 'newpass123', new: 'testpass' }),
  });
  assert.equal(back.status, 200);
});

test('ingest dedups identical points and clamps future timestamps', async () => {
  const now = Date.now();
  const body = {
    points: [
      { ts: now - 30_000, lat: 51.5001, lon: -0.1201, accuracy: 5 },
      { ts: now - 30_000, lat: 51.5001, lon: -0.1201, accuracy: 5 }, // exact duplicate
      { ts: now + 86400_000, lat: 51.5002, lon: -0.1202 },           // 24h in the future
    ],
  };
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.stored, 2); // duplicate dropped, future point clamped (still stored)

  const cookie = await login();
  const locs = await (await fetch(`${BASE}/api/locations?device=alice&since=${now - 120_000}`, {
    headers: { Cookie: cookie },
  })).json();
  const dupes = locs.filter(l => Math.abs(l.lat - 51.5001) < 1e-9 && Math.abs(l.ts - (now - 30_000)) < 1000);
  assert.equal(dupes.length, 1, 'identical point stored exactly once');
  assert.ok(locs.every(l => l.ts <= now + 60_000), 'no stored point is far in the future');
});

test('zones can be renamed and dwell updated', async () => {
  const cookie = await login();
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const zr = await fetch(`${BASE}/api/zones`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'School', kind: 'circle', geo: { lat: 51.5, lon: -0.12, radius_m: 300 } }),
  });
  const { id } = await zr.json();
  const ur = await fetch(`${BASE}/api/zones/${id}`, {
    method: 'PUT', headers,
    body: JSON.stringify({ name: 'School (new)', dwell_minutes: 15 }),
  });
  assert.equal(ur.status, 200);
  const zones = await (await fetch(`${BASE}/api/zones`, { headers })).json();
  const z = zones.find(x => x.id === id);
  assert.equal(z.name, 'School (new)');
  assert.equal(z.dwell_minutes, 15);
  const missing = await fetch(`${BASE}/api/zones/999999`, { method: 'PUT', headers });
  assert.equal(missing.status, 404);
});

test('parent commands queue for the device', async () => {
  const cookie = await login();
  await fetch(`${BASE}/api/devices/alice/locate`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  const r = await fetch(`${BASE}/api/poll`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const cmds = await r.json();
  assert.ok(cmds.some(c => c.kind === 'locate_now'));
});

test('share link flow', async () => {
  const cookie = await login();
  const r = await fetch(`${BASE}/api/shares`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: 'alice', hours: 1 }),
  });
  const { token } = await r.json();
  const sh = await fetch(`${BASE}/api/share/${token}`);
  assert.equal(sh.status, 200);
  const j = await sh.json();
  assert.equal(j.device, 'alice');
  assert.ok(j.points.length >= 2);
  const bad = await fetch(`${BASE}/api/share/definitelynotatoken`);
  assert.equal(bad.status, 404);
});

test('rate limiter trips on login flood', async () => {
  const before = Date.now();
  for (let i = 0; i < 25; i++) {
    await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
  }
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  assert.equal(r.status, 429);
  assert.ok(Date.now() - before < 20_000);
});
