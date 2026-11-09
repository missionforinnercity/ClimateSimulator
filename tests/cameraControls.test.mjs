import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MIN_ELEVATION, orbitFromDrag, panFromDrag } from '../public/cameraControls.js';

test('the scene follows the pointer during orbit drags', () => {
  assert.deepEqual(orbitFromDrag({ azimuth: 1, elevation: 0.5 }, 20, 10), {
    azimuth: 0.88,
    elevation: 0.44,
  });
});

test('orbit elevation remains inside the supported camera range', () => {
  assert.equal(orbitFromDrag({ azimuth: 0, elevation: 1 }, 0, -1000).elevation, 1.35);
  assert.equal(orbitFromDrag({ azimuth: 0, elevation: 1 }, 0, 1000).elevation, CAMERA_MIN_ELEVATION);
});

test('mouse and touch pan follow screen-space drags with perspective scaling', () => {
  const pan = panFromDrag(850, 25, 15);
  assert.ok(pan.right < 0);
  assert.ok(pan.forward < 0);
  assert.ok(Math.abs(pan.right) > 0);
  assert.ok(Math.abs(pan.forward) > 0);
});
