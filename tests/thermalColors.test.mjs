import test from 'node:test';
import assert from 'node:assert/strict';
import { percentileColorPosition, utciPalette } from '../public/thermalColors.js';
const rgb = hex => [hex >> 16 & 255, hex >> 8 & 255, hex & 255];

test('16–18°C stays blue/green with visible local contrast', () => {
  const { stops } = utciPalette(16, 18);
  for (const [, hex] of stops) {
    const [r, g, b] = rgb(hex);
    assert.ok(g > r && (b > r || g > b));
  }
  assert.ok(stops.length >= 4, 'cool frames should expose the widened blue-to-green span');
  assert.notEqual(stops[0][1], stops.at(-1)[1]);
});
test('28–32°C uses warmer tones and retains local contrast', () => {
  const { stops } = utciPalette(28, 32);
  for (const [, hex] of stops) {
    const [r, g, b] = rgb(hex);
    assert.ok(r > b && g > b);
  }
  assert.ok(rgb(stops.at(-1)[1])[0] > rgb(stops.at(-1)[1])[1], 'hot frames should reach a deeper orange-red');
  assert.notEqual(stops[0][1], stops.at(-1)[1]);
});
test('a mild 17.7–19.3°C frame uses a broad cool-only priority scale', () => {
  const { stops } = utciPalette(17.7, 19.3);
  const [lowR, lowG, lowB] = rgb(stops[0][1]);
  const [highR, highG, highB] = rgb(stops.at(-1)[1]);
  assert.ok(stops.length >= 5);
  assert.ok(lowB > lowG && highG > highB && highG > highR);
});
test('mixed cold/hot fields preserve both ends and share map/legend stops', () => {
  const { stops, gradient } = utciPalette(0, 38);
  assert.ok(rgb(stops[0][1])[2] > rgb(stops[0][1])[0]);
  assert.ok(rgb(stops.at(-1)[1])[0] > rgb(stops.at(-1)[1])[2]);
  for (const [t, hex] of stops) {
    assert.ok(gradient.includes(`#${hex.toString(16).padStart(6, '0')} ${(t * 100).toFixed(3)}%`));
  }
});
test('uniform fields do not acquire artificial hotspots; invalid ranges rejected', () => {
  const { stops } = utciPalette(18, 18);
  assert.equal(stops[0][1], stops.at(-1)[1]);
  assert.throws(() => utciPalette(NaN, 18));
  assert.throws(() => utciPalette(20, 18));
});

test('percentile color position expands skewed values by their local rank', () => {
  const thresholds = [0, 1, 2, 3, 4, 50, 60, 70, 80, 100];
  assert.equal(percentileColorPosition(4, thresholds), 4 / 9);
  assert.equal(percentileColorPosition(-5, thresholds), 0);
  assert.equal(percentileColorPosition(120, thresholds), 1);
});

test('ties share a stable rank and flat fields stay neutral', () => {
  assert.equal(percentileColorPosition(1, [0, 1, 1, 1, 3]), 0.5);
  assert.equal(percentileColorPosition(8, [8, 8, 8]), 0.5);
});
