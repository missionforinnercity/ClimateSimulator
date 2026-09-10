import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, validControlValue, scenarioURL, readScenarioURL, compareScenarios } from '../public/scenarioState.js';

const rules = { 'heat-date': { type: 'date' }, 'heat-time': { options: ['540', '720'] }, 'sun-time': { min: 0, max: 1430, step: 10 } };
test('scenario allow-list drops credentials, event names, unknown controls and invalid values', () => {
  const result = validateScenario({ version: 1, tool: 'heat', secret: 'secret', controls: {
    'heat-date': '2026-02-30', 'sun-time': 'NaN', 'heat-time': '720',
    'transport-event-name': 'Private event', apiKey: 'secret',
  }, modes: { 'wind-direction': '45', 'sun-mode': 'hours' } }, rules);
  assert.deepEqual(result.controls, { 'heat-time': '720' });
  assert.deepEqual(result.modes, { 'sun-mode': 'hours' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('dates, times, numeric bounds, steps and unsupported versions are checked', () => {
  assert.equal(validControlValue('2024-02-29', { type: 'date' }), true);
  assert.equal(validControlValue('2025-02-29', { type: 'date' }), false);
  assert.equal(validControlValue('24:00', { type: 'time' }), false);
  assert.equal(validControlValue('721', rules['sun-time']), false);
  assert.equal(validControlValue('1440', rules['sun-time']), false);
  assert.equal(validateScenario({ version: 99, tool: 'sun' }), null);
});
test('URL round-trip is bounded and drops unrelated query configuration', () => {
  const state = validateScenario({ version: 1, tool: 'heat', controls: { 'heat-date': '2026-01-15', 'heat-time': '720' } }, rules);
  const url = new URL(scenarioURL('https://example.test/app?apiKey=secret#private', state));
  assert.equal(url.searchParams.has('apiKey'), false);
  assert.equal(url.hash, '');
  assert.deepEqual(readScenarioURL(url.search, rules), state);
  assert.equal(readScenarioURL('?scenario=%7Bbroken', rules), null);
  assert.equal(readScenarioURL(`?scenario=${'x'.repeat(12001)}`, rules), null);
});
test('camera coordinates are finite and bounded; no arbitrary fields survive', () => {
  const camera = { azimuth: .75, elevation: .68, distance: 1600, x: 0, y: 20, z: 0 };
  assert.deepEqual(validateScenario({ version: 1, tool: 'tools', camera }, {}).camera, camera);
  assert.equal(validateScenario({ version: 1, tool: 'tools', camera: { ...camera, x: Infinity } }, {}).camera, undefined);
});
test('comparison distinguishes changed and held-constant settings', () => {
  const a = { tool: 'heat', controls: { 'heat-time': '540', 'heat-date': '2026-01-15' }, modes: {} };
  const b = { ...a, controls: { ...a.controls, 'heat-time': '720' } };
  const rows = compareScenarios(a, b);
  assert.deepEqual(rows.filter(r => r.changed).map(r => r.key), ['heat-time']);
  assert.equal(rows.find(r => r.key === 'heat-date').changed, false);
});
