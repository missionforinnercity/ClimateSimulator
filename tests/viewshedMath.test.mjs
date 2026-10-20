import test from 'node:test';
import assert from 'node:assert/strict';
import { rayFootprintIntervals, addVerticalOccluder, blockedByVerticalOccluder, terrainRayDistances, viewshedRingDistances } from '../public/viewshedMath.js';

const square = (left, bottom, right, top) => [
  [left, bottom], [right, bottom], [right, top], [left, top],
];

test('ray crossings respect building edges and interior courtyards', () => {
  assert.deepEqual(rayFootprintIntervals(0, 0, 1, 0, 20, square(5, -3, 15, 3)), [[5, 15]]);
  assert.deepEqual(rayFootprintIntervals(0, 0, 1, 0, 20,
    square(5, -3, 15, 3), [square(8, -1, 12, 1)]), [[5, 8], [12, 15]]);
});

test('ground sightline passes below an elevated underpass and a high bridge', () => {
  const intervals = [];
  addVerticalOccluder(intervals, 5, 12, 1.7, 5, 15);
  const groundAngle = Math.atan2(-1.7, 20);
  assert.equal(blockedByVerticalOccluder(intervals, groundAngle), false);
  assert.equal(blockedByVerticalOccluder(intervals, Math.atan2(8 - 1.7, 20)), true);
});

test('ground level building blocks ground behind it but not before its wall', () => {
  const intervals = [];
  assert.equal(blockedByVerticalOccluder(intervals, Math.atan2(-1.7, 4)), false);
  addVerticalOccluder(intervals, 0, 12, 1.7, 5, 15);
  assert.equal(blockedByVerticalOccluder(intervals, Math.atan2(-1.7, 20)), true);
});

test('terrain sightline checks grid edges, triangle diagonals and output rings', () => {
  assert.deepEqual(terrainRayDistances(2, 2, 1, 0, 20, 0, 0, 10, 10, [0, 4, 8, 12, 16, 20]).map(value => Math.round(value * 1e6) / 1e6),
    [4, 6, 8, 12, 16, 18, 20]);
});

test('output rings preserve one metre detail around the observer', () => {
  const rings = viewshedRingDistances(150);
  assert.deepEqual(rings.slice(0, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(rings.slice(29, 33), [29, 30, 32, 34]);
  assert.deepEqual(rings.slice(-3), [144, 148, 150]);
});
