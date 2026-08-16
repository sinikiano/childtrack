// Geometry helpers: Haversine distance + point-in-polygon.

const R = 6371000; // meters

export function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// points: [[lat,lon], ...]
export function pointInPolygon(pt, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [yi, xi] = points[i];
    const [yj, xj] = points[j];
    const intersect = ((xi > pt.lon) !== (xj > pt.lon)) &&
      (pt.lat < (yj - yi) * (pt.lon - xi) / ((xj - xi) || 1e-12) + yi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isInsideZone(zone, pt) {
  const g = JSON.parse(zone.geo);
  if (zone.kind === 'circle') {
    const d = haversineMeters({ lat: g.lat, lon: g.lon }, pt);
    return d <= (g.radius_m || 0);
  }
  if (zone.kind === 'polygon') {
    return pointInPolygon(pt, g.points || []);
  }
  return false;
}
