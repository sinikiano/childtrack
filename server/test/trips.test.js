import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrips } from '../src/trips.js';

const T0 = 1_700_000_000_000;
const pt = (i, lat = 0, lon = 0, dtMin = 1) => ({
  ts: T0 + i * dtMin * 60_000,
  lat, lon, speed: 8,
});

test('single continuous trip is returned', () => {
  const pts = [];
  for (let i = 0; i < 6; i++) pts.push(pt(i, 0, i * 0.002)); // ~222m apart
  const trips = computeTrips(pts);
  assert.equal(trips.length, 1);
  assert.ok(trips[0].distance_m > 1000, `distance ${trips[0].distance_m}`);
  assert.equal(trips[0].points.length, 6);
});

test('gap > 15 min splits trips', () => {
  const a = [pt(0, 0, 0), pt(1, 0, 0.002)];
  const b = [pt(20, 1, 1), pt(21, 1, 1.002)];
  const trips = computeTrips([...a, ...b]);
  assert.equal(trips.length, 2);
  assert.ok(trips[0].start_ts < trips[1].start_ts);
});

test('long idle stop closes a trip and starts a new one', () => {
  const pts = [];
  // travel 10 points
  for (let i = 0; i < 10; i++) pts.push(pt(i, 0, i * 0.002));
  // stay ~still for 10 points
  for (let i = 10; i < 20; i++) pts.push(pt(i, 0, 10 * 0.002));
  // travel again
  for (let i = 20; i < 30; i++) pts.push(pt(i, 0, 10 * 0.002 + (i - 20) * 0.002));
  const trips = computeTrips(pts);
  assert.equal(trips.length, 2);
  const t1 = trips[0];
  assert.ok(t1.distance_m > 2000, `trip1 distance ${t1.distance_m}`);
});

test('tiny movement (< 50 m total) is filtered out', () => {
  const pts = [pt(0, 0, 0), pt(1, 0, 0.0002), pt(2, 0, 0.0004)];
  assert.equal(computeTrips(pts).length, 0);
});

test('empty input yields no trips', () => {
  assert.deepEqual(computeTrips([]), []);
});
