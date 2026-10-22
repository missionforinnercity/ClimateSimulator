import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlaceFeatures,
  describePlaceSearchResult,
  isMappedPickPoint,
  nearestPlaceFeature,
} from '../public/placeInspector.js';

const road = (id, points, attributes = {}) => ({
  highway: 'residential', points, attributes: { ...attributes, ...(id ? { osmId: id } : {}) },
});

test('duplicate street names remain distinguishable by source ID and mapped centre', () => {
  const features = buildPlaceFeatures([], [
    road('way-101', [[0, 0], [20, 0]], { name: 'Market Street' }),
    road('way-202', [[0, 100], [20, 100]], { name: 'Market Street' }),
  ]);

  assert.equal(features.length, 2);
  const [first, second] = features.map(describePlaceSearchResult);
  assert.equal(first.title, second.title);
  assert.match(first.identity, /ID way-101/);
  assert.match(second.identity, /ID way-202/);
  assert.notEqual(first.location, second.location);
});

test('features without source IDs are labeled explicitly and keep their mapped centre', () => {
  const [feature] = buildPlaceFeatures([], [road('', [[10, 20], [30, 20]], { name: 'Unnamed Lane' })]);
  const result = describePlaceSearchResult(feature);

  assert.match(result.identity, /ID not recorded/);
  assert.equal(result.location, 'Mapped centre · x 20 m, z 20 m');
});

test('a point outside the mapped feature search radius has no selection candidate', () => {
  const features = buildPlaceFeatures([], [road('way-303', [[0, 0], [20, 0]], { name: 'Harbour Road' })]);

  assert.equal(nearestPlaceFeature(features, 1000, 1000, 40), null);
});

test('a renderer pick with no mapped coordinates is rejected as outside terrain', () => {
  assert.equal(isMappedPickPoint({}), false);
  assert.equal(isMappedPickPoint({ x: 1, z: Number.NaN }), false);
  assert.equal(isMappedPickPoint({ x: 1, z: 2 }), true);
});
