import { haversineMeters } from './geofence.js';

// Group a sorted list of points into trips. A trip ends when we have
// `idleMinutes` minutes of being within `idleRadiusM` of a stop centroid,
// or a gap of `gapMinutes` with no data.
export function computeTrips(points, {
  idleMinutes = 5,
  idleRadiusM = 60,
  gapMinutes  = 15,
} = {}) {
  const trips = [];
  if (points.length === 0) return trips;

  let cur = newTrip(points[0]);
  for (let i = 1; i < points.length; i++) {
    const p = points[i], prev = points[i-1];
    const dt = (p.ts - prev.ts) / 60000;
    const d  = haversineMeters(prev, p);

    if (dt > gapMinutes) {
      pushTrip(trips, cur);
      cur = newTrip(p);
      continue;
    }

    cur.points.push(p);
    cur.distance += d;
    cur.end = p;

    // detect idle/stop: last N minutes within idleRadius
    const stopStart = findStopStart(cur.points, idleRadiusM, idleMinutes);
    if (stopStart !== -1 && stopStart < cur.points.length - 1) {
      // Trim trailing idle points → close trip at stop start, start new
      const stopPt = cur.points[stopStart];
      cur.end = stopPt;
      cur.distance = recomputeDist(cur.points.slice(0, stopStart + 1));
      cur.points = cur.points.slice(0, stopStart + 1);
      pushTrip(trips, cur);
      cur = newTrip(p);
    }
  }
  pushTrip(trips, cur);
  return trips;
}

function newTrip(p) { return { start: p, end: p, distance: 0, points: [p] }; }
function recomputeDist(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineMeters(pts[i-1], pts[i]);
  return d;
}
function pushTrip(trips, t) {
  if (t.points.length < 2 || t.distance < 50) return;
  trips.push({
    start_ts: t.start.ts,
    end_ts:   t.end.ts,
    distance_m: Math.round(t.distance),
    duration_s: Math.round((t.end.ts - t.start.ts) / 1000),
    start:    { lat: t.start.lat, lon: t.start.lon },
    end:      { lat: t.end.lat,   lon: t.end.lon },
    points:   t.points,
  });
}
function findStopStart(pts, radius, minutes) {
  // walk backwards while points stay within radius of last point; if span >= minutes, return idx
  if (pts.length < 2) return -1;
  const last = pts[pts.length - 1];
  let i = pts.length - 2;
  while (i >= 0 && haversineMeters(pts[i], last) <= radius) i--;
  const startIdx = i + 1;
  const span = (last.ts - pts[startIdx].ts) / 60000;
  return span >= minutes ? startIdx : -1;
}
