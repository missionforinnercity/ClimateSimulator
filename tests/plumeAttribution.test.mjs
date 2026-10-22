import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSourceResidence, summarizeSourceResidence } from '../public/plumeAttribution.js';

test('source roads reconcile with receiving-area residence and exclude cells outside it', () => {
  const byEdge = new Map();
  const total = new Float64Array(4);
  for (const [edge, cell, weight] of [['road-a', 0, 2], ['road-b', 0, 1], ['road-a', 1, 4], ['road-b', 3, 10]]) {
    recordSourceResidence(byEdge, edge, cell, weight, 4);
    total[cell] += weight;
  }
  const result = summarizeSourceResidence(byEdge, total, { x: 0.5, z: 0.5, radiusM: 0.8 },
    { left: 0, minZ: 0, right: 2, maxZ: 2, columns: 2, rows: 2 });
  assert.equal(result.areaTotal, 3);
  assert.equal(result.sourceTotal, 3);
  assert.equal(result.difference, 0);
  assert.equal(result.cellCount, 1);
  assert.deepEqual(result.sources.map(item => [item.edgeId, item.residence, item.share]),
    [['road-a', 2, 2 / 3], ['road-b', 1, 1 / 3]]);
});
