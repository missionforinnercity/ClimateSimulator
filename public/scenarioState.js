// Only explicit, non-personal controls may cross the URL/export boundary.
export const SCENARIO_VERSION = 1;
export const TOOLS = ['tools', 'heat', 'sun', 'wind', 'traffic', 'transport'];
export const CONTROL_IDS = [
  'building-appearance', 'heat-metric', 'heat-date', 'heat-time',
  'sun-date', 'sun-time', 'sun-analysis-surfaces', 'sun-start-time', 'sun-end-time',
  'sun-step-time', 'sun-surface-resolution', 'sun-domain-size',
  'wind-direction', 'wind-forcing-mode', 'wind-speed', 'wind-cfd-field',
  'wind-cfd-ground-height', 'wind-slice-plane', 'wind-slice-position', 'wind-slice-width',
  'wind-slice-height', 'wind-slice-center-x', 'wind-slice-center-y', 'wind-size',
  'wind-flow-box-height', 'wind-season', 'wind-stability',
  'traffic-scenario', 'traffic-demand', 'traffic-control-model', 'traffic-duration',
  'transport-event-date', 'transport-event-start', 'transport-event-end',
  'transport-event-attendance', 'transport-event-walk', 'transport-event-buffer',
  'transport-event-dispersal', 'transport-event-share',
];
export const MODES = {
  'sun-mode': ['shadows', 'hours'], 'wind-lens': ['direction', 'comfort'],
  'cfd-view': ['ground', 'flow', 'slice', 'facade'], 'wind-direction': ['135', '315'],
  'transport-mode': ['both', 'bus', 'train'],
};

export function validControlValue(value, rule) {
  if (typeof value !== 'string' || value.length > 100 || !rule) return false;
  if (rule.options) return rule.options.includes(value);
  if (rule.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
      && value >= '1900-01-01' && value <= '2100-12-31';
  }
  if (rule.type === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!value.trim()) return false;
  const number = Number(value);
  if (!Number.isFinite(number) || number < rule.min || number > rule.max) return false;
  return !rule.step || Math.abs((number - (rule.min || 0)) / rule.step - Math.round((number - (rule.min || 0)) / rule.step)) < 1e-7;
}

export function validateScenario(raw, rules = {}) {
  if (!raw || raw.version !== SCENARIO_VERSION || !TOOLS.includes(raw.tool)) return null;
  const result = { version: SCENARIO_VERSION, tool: raw.tool, controls: {}, modes: {} };
  for (const id of CONTROL_IDS) {
    if (validControlValue(raw.controls?.[id], rules[id])) result.controls[id] = raw.controls[id];
  }
  for (const [mode, choices] of Object.entries(MODES)) {
    if (choices.includes(raw.modes?.[mode])) result.modes[mode] = raw.modes[mode];
  }
  const c = raw.camera;
  if (c && ['azimuth', 'elevation', 'distance', 'x', 'y', 'z'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k]))
      && Math.abs(c.azimuth) <= Math.PI * 4 && c.elevation >= 0.1 && c.elevation <= 1.5
      && c.distance >= 100 && c.distance <= 8000 && Math.abs(c.x) <= 5000 && Math.abs(c.z) <= 5000 && Math.abs(c.y) <= 500) {
    result.camera = Object.fromEntries(['azimuth', 'elevation', 'distance', 'x', 'y', 'z'].map(k => [k, c[k]]));
  }
  const p = raw.location;
  if (p && typeof p.x === 'number' && typeof p.z === 'number' && Number.isFinite(p.x) && Number.isFinite(p.z)
      && Math.abs(p.x) <= 5000 && Math.abs(p.z) <= 5000) result.location = { x: p.x, z: p.z };
  return result;
}

export function readScenarioURL(search, rules) {
  const params = new URLSearchParams(search);
  const encoded = params.get('scenario');
  if (!encoded || encoded.length > 12000) return null;
  try { return validateScenario(JSON.parse(encoded), rules); } catch { return null; }
}

export function scenarioURL(base, scenario) {
  const url = new URL(base);
  // Drop arbitrary query strings (especially any old API/auth configuration).
  url.search = '';
  url.hash = '';
  url.searchParams.set('tool', scenario.tool);
  url.searchParams.set('scenario', JSON.stringify(scenario));
  return url.href;
}

export function compareScenarios(before, after) {
  const flatten = s => ({ tool: s.tool, ...s.controls, ...s.modes,
    camera: JSON.stringify(s.camera || null), location: JSON.stringify(s.location || null) });
  const a = flatten(before), b = flatten(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map(key => ({
    key, before: a[key] ?? 'Not captured', after: b[key] ?? 'Not captured', changed: a[key] !== b[key],
  }));
}
