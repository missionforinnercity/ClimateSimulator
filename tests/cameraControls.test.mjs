import test from 'node:test';
import assert from 'node:assert/strict';
import { orbitFromDrag, panFromDrag } from '../public/cameraControls.js';

test('right and down drags increase the matching orbit axes', () => {
  assert.deepEqual(orbitFromDrag({ azimuth: 1, elevation: 0.5 }, 20, 10), {
    azimuth: 1.12,
    elevation: 0.56,
  });
});

test('orbit elevation remains inside the supported camera range', () => {
  assert.equal(orbitFromDrag({ azimuth: 0, elevation: 1 }, 0, 1000).elevation, 1.35);
  assert.equal(orbitFromDrag({ azimuth: 0, elevation: 1 }, 0, -1000).elevation, 0.16);
});

test('mouse and touch pan signs come from one direct-drag calculation', () => {
  assert.deepEqual(panFromDrag(850, 25, 15), { right: 25, forward: -15 });
});
