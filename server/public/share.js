const map = L.map('shareMap').setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
const token = location.pathname.split('/').pop();
const track  = L.polyline([], { color: '#1976d2', weight: 4 }).addTo(map);
const marker = L.marker([0, 0]).addTo(map);
async function load() {
  const r = await fetch('/api/share/' + token);
  if (!r.ok) { document.body.innerHTML = '<p style="padding:20px">Link expired or invalid.</p>'; return; }
  const data = await r.json();
  const ll = data.points.map(p => [p.lat, p.lon]);
  track.setLatLngs(ll);
  if (ll.length) {
    const last = data.points[data.points.length - 1];
    marker.setLatLng([last.lat, last.lon])
      .bindPopup(`<b>${data.device}</b><br>${new Date(last.ts).toLocaleString()}<br>\u00b1${Math.round(last.accuracy||0)} m`);
    map.fitBounds(track.getBounds().pad(0.2), { maxZoom: 17 });
  }
}
load();
setInterval(load, 30_000);
