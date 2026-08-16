import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, pointInPolygon, isInsideZone } from '../src/geofence.js';

test('haversine distance NYC -> London ~5570 km', () => {
  const d = haversineMeters(
    { lat: 40.7128, lon: -74.0060 },
    { lat: 51.5074, lon: -0.1278 }
  );
  assert.ok(d > 5_500_000 && d < 5_650_000, `got ${d}`);
});

test('haversine zero distance', () => {
  assert.equal(haversineMeters({ lat: 10, lon: 20 }, { lat: 10, lon: 20 }), 0);
});

test('circle zone: inside, outside, and exact edge', () => {
  const zone = { kind: 'circle', geo: JSON.stringify({ lat: 0, lon: 0, radius_m: 1000 }) };
  assert.equal(isInsideZone(zone, { lat: 0.005, lon: 0 }), true);   // ~556 m
  assert.equal(isInsideZone(zone, { lat: 0.02, lon: 0 }), false);   // ~2224 m
  const edge = haversineMeters({ lat: 0, lon: 0 }, { lat: 0.008983, lon: 0 });
  assert.ok(Math.abs(edge - 999.3) < 2);
  assert.equal(isInsideZone(zone, { lat: 0.008983, lon: 0 }), true); // <= radius
});

test('polygon: ray-cast inside/outside/concave', () => {
  const square = [[0, 0], [0, 1], [1, 1], [1, 0]];
  assert.equal(pointInPolygon({ lat: 0.5, lon: 0.5 }, square), true);
  assert.equal(pointInPolygon({ lat: 2, lon: 2 }, square), false);
  assert.equal(pointInPolygon({ lat: 0.5, lon: -0.5 }, square), false);
  // square with a notch: lat 1..2, lon 0..1 is removed
  const concave = [[0, 0], [0, 3], [3, 3], [3, 0], [2, 0], [2, 1], [1, 1], [1, 0]];
  assert.equal(pointInPolygon({ lat: 0.5, lon: 0.5 }, concave), true);
  assert.equal(pointInPolygon({ lat: 1.5, lon: 0.5 }, concave), false); // the notch
  assert.equal(pointInPolygon({ lat: 2.5, lon: 2.5 }, concave), true);
  assert.equal(pointInPolygon({ lat: 5, lon: 5 }, concave), false);
});

test('isInsideZone polygon path', () => {
  const zone = { kind: 'polygon', geo: JSON.stringify({ points: [[0, 0], [0, 1], [1, 1], [1, 0]] }) };
  assert.equal(isInsideZone(zone, { lat: 0.5, lon: 0.5 }), true);
  assert.equal(isInsideZone(zone, { lat: 5, lon: 5 }), false);
});
