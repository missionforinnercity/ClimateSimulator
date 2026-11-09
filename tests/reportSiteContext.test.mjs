import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMappedCanopy } from '../public/reportSiteContext.js';

const square = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const canopy = rings => [1, 0, 0, 0, 0, rings];
const bounds = { min_x: 0, min_z: 0, max_x: 10, max_z: 10 };

test('canopy share is clipped to the selected square and overlapping footprints count once', () => {
  const records = [canopy([square(0, 0, 4, 10)]), canopy([square(0, 0, 4, 10)]), canopy([square(20, 20, 30, 30)])];
  const result = summarizeMappedCanopy(bounds, records);
  assert.equal(result.status, 'ready');
  assert.equal(result.canopy_cover_pct, 40);
  assert.equal(result.sample_spacing_m, 2);
});

test('holes in canopy footprints remain uncovered', () => {
  const result = summarizeMappedCanopy(bounds, [canopy([square(0, 0, 10, 10), square(4, 4, 6, 6)])]);
  assert.equal(result.canopy_cover_pct, 96);
});

test('missing or invalid area data does not become a zero-cover claim', () => {
  assert.equal(summarizeMappedCanopy(bounds, null), null);
  assert.equal(summarizeMappedCanopy({ ...bounds, max_x: 0 }, []), null);
});
