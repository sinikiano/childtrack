// ChildTrack dashboard SPA
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  return r;
};
const j = (path, opts) => api(path, opts).then(r => r.json());

let me = null, devices = [];

// ---- nav -----------------------------------------------------------------
document.querySelectorAll('header nav button').forEach(b => {
  b.onclick = () => showView(b.dataset.view);
});
function showView(v) {
  document.querySelectorAll('header nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === `view-${v}`));
  document.querySelectorAll('.view').forEach(s => s.style.display = (s.id === `view-${v}`) ? '' : 'none');
  document.getElementById(`view-${v}`).style.display = 'block';
  if (v === 'live')     setTimeout(() => map.invalidateSize(), 50);
  if (v === 'history')  setTimeout(() => histMap.invalidateSize(), 50);
  if (v === 'zones')    setTimeout(() => zonesMap.invalidateSize(), 50);
  if (v === 'trips')    setTimeout(() => tripMap.invalidateSize(), 50);
  if (v === 'alerts')   loadAlerts();
  if (v === 'shares')   loadShares();
  if (v === 'schedules') loadSchedules();
  if (v === 'settings') { loadMeta(); loadSessions(); }
  if (v === 'users')    loadUsers();
}

$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; };

// ---- init ----------------------------------------------------------------
(async () => {
  me = await j('/api/me');
  $('#who').textContent = `${me.username} (${me.role})`;
  $('#totpState').textContent = me.totp_enabled ? '2FA on' : '2FA off';
  $('#notifyState').textContent = me.notify_configured ? 'notifications on' : 'notifications off';
  if (me.role === 'admin') $('#navUsers').style.display = '';
  devices = await j('/api/devices');
  for (const sel of ['#liveDevice', '#tripDevice', '#shareDevice', '#histDevice', '#schedDevice']) {
    $(sel).innerHTML = devices.map(d => `<option>${d}</option>`).join('');
  }
  $('#zoneDevice').innerHTML = `<option value="*">All devices</option>` +
    devices.map(d => `<option>${d}</option>`).join('');
  initLive(); initZones(); initTrips(); initHistory(); initSchedules(); initAccount();
  loadLive();
  scheduleAuto();
  startEvents();
})();

function livePopupHtml(p) {
  return `<b>${esc(p.device)}</b><br>${new Date(p.ts).toLocaleString()}<br>\u00b1${Math.round(p.accuracy||0)} m \u00b7 \u{1F50B} ${p.battery ?? '?'}%`;
}

// ---- Reverse geocoding (server-cached Nominatim; ~1 req/s) ----------------
let lastGeocodeReq = 0;
async function geocodeAddress(lat, lon) {
  const now = Date.now();
  if (now - lastGeocodeReq < 1500) return '';
  lastGeocodeReq = now;
  try {
    const r = await api(`/api/geocode?lat=${lat}&lon=${lon}`);
    if (!r.ok) return '';
    const j2 = await r.json();
    return j2.address || '';
  } catch { return ''; }
}

// ---- Real-time (SSE) ------------------------------------------------------
let es = null;
function startEvents() {
  if (!('EventSource' in window) || es) return;
  es = new EventSource('/api/events');
  es.addEventListener('point', (e) => {
    try { onLivePoint(JSON.parse(e.data)); } catch { /* ignore */ }
  });
  es.addEventListener('alert', (e) => {
    try { onLiveAlert(JSON.parse(e.data)); } catch { /* ignore */ }
  });
  es.onerror = () => { // connection lost — polling fallback keeps working
    if (es) { es.close(); es = null; }
  };
}
function onLivePoint(p) {
  const v = document.getElementById('view-live');
  if (!v.classList.contains('active')) return;
  if (p.device !== $('#liveDevice').value) return;
  track.addLatLng([p.lat, p.lon]);
  liveMarker.setLatLng([p.lat, p.lon]).setOpacity(1).bindPopup(livePopupHtml(p));
  cluster.addLayer(L.circleMarker([p.lat, p.lon], { radius: 3, color: '#1976d2' }));
  $('#liveStatus').textContent = `live \u00b7 last ${new Date(p.ts).toLocaleTimeString()}`;
  geocodeAddress(p.lat, p.lon).then(addr => {
    if (!addr) return;
    liveMarker.setPopupContent(`${livePopupHtml(p)}<br>${esc(addr)}`);
    $('#liveStatus').textContent = `live \u00b7 last ${new Date(p.ts).toLocaleTimeString()} \u00b7 ${addr}`;
  });
}
function onLiveAlert(a) {
  const v = document.getElementById('view-alerts');
  if (v.classList.contains('active')) {
    $('#alertsTbl tbody').insertAdjacentHTML('afterbegin', `
      <tr>
        <td>${new Date(a.ts).toLocaleString()}</td>
        <td>${esc(a.device)}</td>
        <td class="kind-${a.kind}">${a.kind}</td>
        <td>${esc(a.message)}</td>
      </tr>`);
  } else {
    $('#liveStatus').textContent = `alert: ${a.device} ${a.kind}`;
  }
}

// ---- LIVE ----------------------------------------------------------------
const map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
const track = L.polyline([], { color: '#1976d2', weight: 4, opacity: 0.85 }).addTo(map);
const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 }).addTo(map);
const liveMarker = L.marker([0, 0]); liveMarker.addTo(map); liveMarker.setOpacity(0);
let heatLayer = null;
let autoTimer = null;

function initLive() {
  $('#liveDevice').onchange = loadLive;
  $('#liveSince').onchange = loadLive;
  $('#heat').onchange = loadLive;
  $('#auto').onchange = scheduleAuto;
  $('#locateNow').onclick = async () => {
    const d = $('#liveDevice').value;
    await api(`/api/devices/${encodeURIComponent(d)}/locate`, { method: 'POST' });
    $('#liveStatus').textContent = 'requested — phone will report on next poll';
  };
}
function scheduleAuto() {
  clearInterval(autoTimer);
  if ($('#auto').checked) autoTimer = setInterval(loadLive, 15000);
}
async function loadLive() {
  const device = $('#liveDevice').value;
  if (!device) return;
  const sinceMs = parseInt($('#liveSince').value, 10);
  const since = sinceMs ? (Date.now() - sinceMs) : 0;
  const ds = sinceMs ? '' : '&downsample=1';
  const pts = await j(`/api/locations?device=${encodeURIComponent(device)}&since=${since}${ds}`);
  const ll = pts.map(p => [p.lat, p.lon]);
  track.setLatLngs(ll);
  cluster.clearLayers();
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  if ($('#heat').checked && ll.length) {
    heatLayer = L.heatLayer(ll, { radius: 25, blur: 18 }).addTo(map);
  } else {
    for (const p of pts) cluster.addLayer(L.circleMarker([p.lat, p.lon], { radius: 3, color: '#1976d2' }));
  }
  if (ll.length) {
    const last = pts[pts.length - 1];
    liveMarker.setLatLng([last.lat, last.lon]).setOpacity(1).bindPopup(livePopupHtml(last));
    if (map.getZoom() < 4) map.setView([last.lat, last.lon], 15);
    else map.fitBounds(track.getBounds().pad(0.2), { maxZoom: 17, animate: false });
    $('#liveStatus').textContent = `${pts.length} pts \u00b7 last ${new Date(last.ts).toLocaleTimeString()}`;
    geocodeAddress(last.lat, last.lon).then(addr => {
      if (!addr) return;
      liveMarker.setPopupContent(`${livePopupHtml(last)}<br>${esc(addr)}`);
      $('#liveStatus').textContent = `${pts.length} pts \u00b7 last ${new Date(last.ts).toLocaleTimeString()} \u00b7 ${addr}`;
    });
  } else $('#liveStatus').textContent = 'no data';
}

// ---- HISTORY (playback + stats) ------------------------------------------
let histMap, histPoly, histLive, histTimer = null, histPts = [], histIdx = 0;
function initHistory() {
  histMap = L.map('histMap').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(histMap);
  histPoly = L.polyline([], { color: '#1976d2', weight: 4 }).addTo(histMap);
  histLive = L.circleMarker([0, 0], { color: '#ef4444', radius: 7 }).addTo(histMap);
  const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
  $('#histFrom').value = iso(new Date(today.getTime() - 7 * 86400_000));
  $('#histTo').value = iso(today);
  $('#histLoad').onclick = loadHistory;
  $('#histPlay').onclick = playHistory;
}
function histRange() {
  const since = new Date($('#histFrom').value).getTime();
  const until = new Date($('#histTo').value).getTime() + 86400_000 - 1;
  return { since, until, device: $('#histDevice').value };
}
async function loadHistory() {
  const { since, until, device } = histRange();
  histPts = await j(`/api/locations?device=${encodeURIComponent(device)}&since=${since}&until=${until}&downsample=1`);
  histPoly.setLatLngs(histPts.map(p => [p.lat, p.lon]));
  histLive.setLatLng(histPts.length ? [histPts[0].lat, histPts[0].lon] : [0, 0]);
  histIdx = 0; histTimer && clearInterval(histTimer);
  if (histPts.length) histMap.fitBounds(histPoly.getBounds().pad(0.2), { maxZoom: 17 });
  const st = await j(`/api/stats?device=${encodeURIComponent(device)}&since=${since}&until=${until}`);
  $('#histDist').textContent = `${(st.distance_m / 1000).toFixed(2)} km`;
  $('#histActive').textContent = `active ${fmtDur(st.active_s)}`;
  $('#histPoints').textContent = `${st.points} points`;
}
function playHistory() {
  if (histPts.length < 2) return;
  histTimer && clearInterval(histTimer);
  const step = Math.max(1, Math.floor(histPts.length / 200));
  histTimer = setInterval(() => {
    histIdx += step;
    if (histIdx >= histPts.length) {
      histIdx = histPts.length - 1;
      clearInterval(histTimer);
    }
    histLive.setLatLng([histPts[histIdx].lat, histPts[histIdx].lon]);
  }, 200);
}

// ---- ZONES ---------------------------------------------------------------
let zonesMap, drawnItems, drawControl;
function initZones() {
  zonesMap = L.map('zonesMap').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(zonesMap);
  drawnItems = new L.FeatureGroup().addTo(zonesMap);
  drawControl = new L.Control.Draw({
    draw: { circle: true, polygon: true, rectangle: false, marker: false, polyline: false, circlemarker: false },
    edit: { featureGroup: drawnItems, remove: false },
  });
  zonesMap.addControl(drawControl);
  zonesMap.on(L.Draw.Event.CREATED, async (e) => {
    const layer = e.layer;
    const name = prompt('Name for this zone?');
    if (!name) return;
    let kind, geo;
    if (e.layerType === 'circle') {
      const c = layer.getLatLng();
      kind = 'circle';
      geo = { lat: c.lat, lon: c.lng, radius_m: Math.round(layer.getRadius()) };
    } else if (e.layerType === 'polygon') {
      kind = 'polygon';
      geo = { points: layer.getLatLngs()[0].map(p => [p.lat, p.lng]) };
    } else return;
    await api('/api/zones', {
      method: 'POST',
      body: JSON.stringify({
        name, device: $('#zoneDevice').value, kind, geo,
        dwell_minutes: parseInt(prompt('Alert if the child stays inside longer than (minutes, 0 = off):', '0') || '0', 10) || 0,
      }),
    });
    loadZones();
  });
  $('#zonesRefresh').onclick = loadZones;
  loadZones();
}
async function loadZones() {
  const zones = await j('/api/zones');
  drawnItems.clearLayers();
  for (const z of zones) {
    if (z.kind === 'circle') {
      L.circle([z.geo.lat, z.geo.lon], { radius: z.geo.radius_m, color: '#22c55e' })
        .bindTooltip(z.name).addTo(drawnItems);
    } else {
      L.polygon(z.geo.points, { color: '#22c55e' }).bindTooltip(z.name).addTo(drawnItems);
    }
  }
  if (zones.length) zonesMap.fitBounds(drawnItems.getBounds().pad(0.2));
  $('#zonesTbl tbody').innerHTML = zones.map(z => `
    <tr>
      <td>${esc(z.name)}</td><td>${esc(z.device)}</td><td>${z.kind}</td>
      <td>${z.notify_enter ? '\u2713' : ''}</td><td>${z.notify_leave ? '\u2713' : ''}</td>
      <td>${z.dwell_minutes || ''}</td>
      <td>
        <button data-edit-zone="${z.id}">Edit</button>
        <button class="danger" data-del-zone="${z.id}">Delete</button>
      </td>
    </tr>`).join('');
  $('#zonesTbl').querySelectorAll('[data-edit-zone]').forEach(b => {
    b.onclick = async () => {
      const z = zones.find(x => x.id === +b.dataset.editZone);
      if (!z) return;
      const name = prompt('Zone name:', z.name);
      if (!name) return;
      const dwell = parseInt(prompt('Alert if staying inside longer than (minutes, 0 = off):', String(z.dwell_minutes || 0)), 10);
      await api('/api/zones/' + z.id, {
        method: 'PUT',
        body: JSON.stringify({ name, dwell_minutes: Number.isFinite(dwell) ? dwell : z.dwell_minutes }),
      });
      loadZones();
    };
  });
  $('#zonesTbl').querySelectorAll('[data-del-zone]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Delete zone?')) return;
      await api('/api/zones/' + b.dataset.delZone, { method: 'DELETE' });
      loadZones();
    };
  });
}

// ---- TRIPS ---------------------------------------------------------------
let tripMap, tripPolys = L.layerGroup();
function initTrips() {
  tripMap = L.map('tripMap').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(tripMap);
  tripPolys.addTo(tripMap);
  const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
  $('#tripFrom').value = iso(new Date(today.getTime() - 7 * 86400_000));
  $('#tripTo').value = iso(today);
  $('#tripLoad').onclick = loadTrips;
  $('#tripDevice').onchange = updateExportLinks;
  $('#tripFrom').onchange = updateExportLinks;
  $('#tripTo').onchange = updateExportLinks;
  updateExportLinks();
}
function tripRange() {
  const since = new Date($('#tripFrom').value).getTime();
  const until = new Date($('#tripTo').value).getTime() + 86400_000 - 1;
  return { since, until, device: $('#tripDevice').value };
}
function updateExportLinks() {
  const { since, until, device } = tripRange();
  const q = `?device=${encodeURIComponent(device)}&since=${since}&until=${until}`;
  $('#csvLink').href = '/api/export.csv' + q;
  $('#gpxLink').href = '/api/export.gpx' + q;
}
async function loadTrips() {
  const { since, until, device } = tripRange();
  updateExportLinks();
  const trips = await j(`/api/trips?device=${encodeURIComponent(device)}&since=${since}&until=${until}`);
  tripPolys.clearLayers();
  const colors = ['#1976d2','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#eab308'];
  trips.forEach((t, i) => {
    const ll = t.points.map(p => [p.lat, p.lon]);
    L.polyline(ll, { color: colors[i % colors.length], weight: 4 }).addTo(tripPolys);
    L.circleMarker(ll[0], { color: '#22c55e', radius: 5 }).bindTooltip('Start ' + new Date(t.start_ts).toLocaleTimeString()).addTo(tripPolys);
    L.circleMarker(ll[ll.length - 1], { color: '#ef4444', radius: 5 }).bindTooltip('End '   + new Date(t.end_ts).toLocaleTimeString()).addTo(tripPolys);
  });
  if (trips.length) {
    const all = trips.flatMap(t => t.points.map(p => [p.lat, p.lon]));
    tripMap.fitBounds(L.latLngBounds(all).pad(0.1));
  }
  $('#tripTbl tbody').innerHTML = trips.map(t => `
    <tr>
      <td>${new Date(t.start_ts).toLocaleString()}</td>
      <td>${new Date(t.end_ts).toLocaleString()}</td>
      <td>${(t.distance_m/1000).toFixed(2)} km</td>
      <td>${fmtDur(t.duration_s)}</td>
      <td>${t.start.lat.toFixed(5)}, ${t.start.lon.toFixed(5)}</td>
      <td>${t.end.lat.toFixed(5)}, ${t.end.lon.toFixed(5)}</td>
    </tr>`).join('');
}

// ---- ALERTS --------------------------------------------------------------
async function loadAlerts() {
  const rows = await j('/api/alerts');
  $('#alertsTbl tbody').innerHTML = rows.map(a => `
    <tr>
      <td>${new Date(a.ts).toLocaleString()}</td>
      <td>${esc(a.device)}</td>
      <td class="kind-${a.kind}">${a.kind}</td>
      <td>${esc(a.message)}</td>
    </tr>`).join('');
}
$('#alertsRefresh').onclick = loadAlerts;

// ---- SHARES --------------------------------------------------------------
async function loadShares() {
  const rows = await j('/api/shares');
  $('#sharesTbl tbody').innerHTML = rows.map(s => `
    <tr>
      <td>${esc(s.device)}</td>
      <td><a href="/s/${s.token}" target="_blank">${location.origin}/s/${s.token}</a></td>
      <td>${new Date(s.expires).toLocaleString()}</td>
      <td>${esc(s.created_by||'')}</td>
      <td><button class="danger" data-del-share="${s.token}">Revoke</button></td>
    </tr>`).join('');
  $('#sharesTbl').querySelectorAll('[data-del-share]').forEach(b => {
    b.onclick = async () => {
      await api('/api/shares/' + b.dataset.delShare, { method: 'DELETE' });
      loadShares();
    };
  });
}
$('#shareCreate').onclick = async () => {
  const device = $('#shareDevice').value;
  const hours = parseInt($('#shareHours').value, 10);
  await api('/api/shares', { method: 'POST', body: JSON.stringify({ device, hours }) });
  loadShares();
};

// ---- SETTINGS / DEVICES --------------------------------------------------
async function loadMeta() {
  const rows = await j('/api/devices/meta');
  const provBtn = me.role === 'admin'
    ? `<td><button class="meta-prov" title="Show setup QR for the ChildTrack app">Setup QR</button></td>`
    : '<td></td>';
  $('#metaTbl tbody').innerHTML = rows.map(m => `
    <tr data-d="${esc(m.device)}">
      <td>${esc(m.device)}</td>
      <td>${m.last_seen ? new Date(m.last_seen).toLocaleString() : '—'}</td>
      <td>${m.last_battery ?? '—'}</td>
      <td><input type="number" class="meta-spd" value="${m.speed_limit_kmh ?? 130}" style="width:80px" /></td>
      <td><input type="number" class="meta-off" value="${m.offline_after_sec ?? 900}" style="width:80px" /></td>
      <td><input type="number" class="meta-bat" value="${m.battery_low_pct ?? 15}" style="width:60px" /></td>
      <td><button class="primary meta-save">Save</button></td>
      ${provBtn}
    </tr>`).join('');
  $('#metaTbl').querySelectorAll('.meta-save').forEach(b => {
    b.onclick = async (e) => {
      const tr = e.target.closest('tr');
      const d = tr.dataset.d;
      await api(`/api/devices/${encodeURIComponent(d)}/meta`, {
        method: 'PUT',
        body: JSON.stringify({
          speed_limit_kmh:   +tr.querySelector('.meta-spd').value,
          offline_after_sec: +tr.querySelector('.meta-off').value,
          battery_low_pct:   +tr.querySelector('.meta-bat').value,
        }),
      });
    };
  });
  $('#metaTbl').querySelectorAll('.meta-prov').forEach(b => {
    b.onclick = async (e) => {
      const d = e.target.closest('tr').dataset.d;
      const r = await j(`/api/provision/${encodeURIComponent(d)}`);
      $('#provQr').src = r.qr;
      $('#provPayload').textContent = JSON.stringify(r.payload);
      const m = $('#provModal');
      m.style.display = 'grid';
    };
  });
}
$('#provClose').onclick = () => { $('#provModal').style.display = 'none'; };
$('#provModal').onclick = (e) => { if (e.target.id === 'provModal') $('#provModal').style.display = 'none'; };

// ---- USERS (admin) -------------------------------------------------------
async function loadUsers() {
  const rows = await j('/api/users');
  $('#usersTbl tbody').innerHTML = rows.map(u => `
    <tr>
      <td>${u.id}</td><td>${esc(u.username)}</td><td>${u.role}</td>
      <td>${new Date(u.created).toLocaleDateString()}</td>
      <td>${u.id === me.id ? '' : `<button class="danger" data-del-user="${u.id}">Delete</button>`}</td>
    </tr>`).join('');
  $('#usersTbl').querySelectorAll('[data-del-user]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Delete user?')) return;
      await api('/api/users/' + b.dataset.delUser, { method: 'DELETE' });
      loadUsers();
    };
  });
}
$('#userAdd').onclick = async () => {
  const username = $('#newUser').value.trim();
  const password = $('#newPassUser').value;
  const role = $('#newRole').value;
  if (!username || !password) return;
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) });
  $('#newUser').value = ''; $('#newPassUser').value = '';
  loadUsers();
};

// ---- SCHEDULES -----------------------------------------------------------
let schedZones = [];
function initSchedules() {
  $('#schedAdd').onclick = async () => {
    const device = $('#schedDevice').value;
    const startMs = timeToMs($('#schedStart').value), endMs = timeToMs($('#schedEnd').value);
    const body = {
      device,
      day_of_week: parseInt($('#schedDay').value, 10),
      start_ms: startMs,
      end_ms: endMs,
      zone_id: $('#schedZone').value || null,
      message: $('#schedMsg').value.trim(),
    };
    await api('/api/schedules', { method: 'POST', body: JSON.stringify(body) });
    loadSchedules();
  };
  j('/api/zones').then(z => {
    schedZones = z;
    $('#schedZone').innerHTML = '<option value="">Any (just be online)</option>' +
      z.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  });
}
function timeToMs(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return (h * 3600 + m * 60) * 1000;
}
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
async function loadSchedules() {
  const rows = await j('/api/schedules');
  const zoneName = (id) => schedZones.find(z => z.id === id)?.name || '';
  $('#schedTbl tbody').innerHTML = rows.map(s => `
    <tr>
      <td>${esc(s.device)}</td>
      <td>${s.day_of_week === -1 ? 'Every day' : DAY_NAMES[s.day_of_week]}</td>
      <td>${fmtMs(s.start_ms)} – ${fmtMs(s.end_ms)}</td>
      <td>${esc(zoneName(s.zone_id)) || '—'}</td>
      <td>${esc(s.message) || '—'}</td>
      <td><button class="danger" data-del-sched="${s.id}">Delete</button></td>
    </tr>`).join('');
  $('#schedTbl').querySelectorAll('[data-del-sched]').forEach(b => {
    b.onclick = async () => {
      await api('/api/schedules/' + b.dataset.delSched, { method: 'DELETE' });
      loadSchedules();
    };
  });
}

// ---- ACCOUNT (password / 2FA / sessions) ---------------------------------
function initAccount() {
  $('#passChange').onclick = async () => {
    const r = await api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ old: $('#oldPass').value, new: $('#newPass').value }),
    });
    const j2 = await r.json();
    alert(j2.error || 'Password changed — other sessions logged out');
    $('#oldPass').value = ''; $('#newPass').value = '';
  };
  $('#btn2fa').onclick = async () => {
    if (me.totp_enabled) { $('#totpBox').style.display = ''; $('#totpDisable').style.display = ''; return; }
    const r = await j('/api/2fa/setup', { method: 'POST' });
    $('#totpQr').src = r.qr;
    $('#totpBox').style.display = '';
  };
  $('#totpConfirm').onclick = async () => {
    const r = await api('/api/2fa/verify', { method: 'POST', body: JSON.stringify({ code: $('#totpCode').value }) });
    const j2 = await r.json();
    if (j2.error) return alert(j2.error);
    me.totp_enabled = true;
    $('#totpState').textContent = '2FA on';
    $('#totpDisable').style.display = '';
    $('#totpCode').value = '';
    alert('2FA enabled — scan QR with an authenticator app (e.g. Google Authenticator, Aegis)');
  };
  $('#totpDisable').onclick = async () => {
    const r = await api('/api/2fa/disable', { method: 'POST', body: JSON.stringify({ code: $('#totpCode').value }) });
    const j2 = await r.json();
    if (j2.error) return alert(j2.error);
    me.totp_enabled = false;
    $('#totpState').textContent = '2FA off';
    $('#totpDisable').style.display = 'none';
    $('#totpBox').style.display = 'none';
    alert('2FA disabled');
  };
}
async function loadSessions() {
  const rows = await j('/api/sessions');
  $('#sessTbl tbody').innerHTML = rows.map(s => `
    <tr>
      <td>${esc(s.token)}${s.current ? ' <b>(this device)</b>' : ''}</td>
      <td>${s.created ? new Date(s.created).toLocaleString() : '—'}</td>
      <td>${new Date(s.expires).toLocaleString()}</td>
      <td>${s.current ? '' : `<button class="danger" data-revoke="${esc(s.token)}">Revoke</button>`}</td>
    </tr>`).join('');
  $('#sessTbl').querySelectorAll('[data-revoke]').forEach(b => {
    b.onclick = async () => {
      await api('/api/sessions/revoke', { method: 'POST', body: JSON.stringify({ token: b.dataset.revoke }) });
      loadSessions();
    };
  });
}

// ---- helpers -------------------------------------------------------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtMs(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
