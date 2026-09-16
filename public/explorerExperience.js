import { CONTROL_IDS, MODES, TOOLS, validateScenario, readScenarioURL, scenarioURL, compareScenarios } from './scenarioState.js';
import { cancelRequests } from './requestClient.js';

const EVIDENCE = {
  heat: {
    status: 'Screening · Modelled', method: 'Summer thermal baseline with mapped building and canopy shade.',
    sources: 'Heat-zone source window is reported with each response. Terrain uses 2025 LiDAR with a lower-resolution SRTM supplement.',
    supports: 'Identify streets and public spaces to investigate for cooling and shade.',
    limits: 'Not measured pedestrian temperature, UTCI/PET, a heat-health forecast, or a verified intervention benefit.',
    legend: 'Higher scores (0–100) mean more intervention priority or shade deficit. °C surface estimates and °C exposure deltas are different quantities.',
  },
  sun: {
    status: 'Modelled · Exploratory', method: 'Solar geometry, mapped building/canopy shadows, and clear-sky direct-sun sampling.',
    sources: 'Mapped hybrid building geometry and canopy; 2025 LiDAR terrain. Roof shapes and coarse terrain contain inferred geometry.',
    supports: 'Compare direct sunlight and shade at a selected date, time, and area.',
    limits: 'Not measured irradiance, PV yield, diffuse/reflected light, or a certified daylight assessment.',
    legend: 'Hours (h) show sampled direct sun in the chosen time window. More sun is not always better; the intended use and season matter.',
  },
  wind: {
    status: 'Exploratory · Unvalidated', method: 'WebGL: solved OpenFOAM volumes. Compatibility view: separate horizontal screening proxy.',
    sources: 'Only solved CFD directions contribute to the WebGL comfort study. ERA5 supplies regional wind frequencies, not street measurements.',
    supports: 'Inspect possible exposed areas, flow patterns, and questions for a validated wind study.',
    limits: 'Comfort is a lower bound over solved sectors, not a complete annual study. No certification or field validation; unsolved directions are excluded.',
    legend: 'Speed is m/s; pressure/turbulence units follow the selected diagnostic. Comfort categories describe activity thresholds, not a safety guarantee.',
  },
  traffic: {
    status: 'Exploratory · Modelled', method: 'Paired SUMO baseline and closure runs with a synthetic representative fleet.',
    sources: 'OSM/SUMO network, mapped signal settings, synthetic demand. Provider traffic freshness is shown separately.',
    supports: 'Explore rerouting trade-offs for a specified closure and demand assumption.',
    limits: 'Not a calibrated traffic forecast, measured emissions/noise, or an operational closure approval. Existing report reliability gates still apply.',
    legend: 'Vehicle speed uses km/h. Diversion gains/losses refer to modelled traffic relative to the same baseline; colour alone is not a recommendation.',
  },
  transport: {
    status: 'Scheduled proxy · Inferred', method: 'Timetable-derived vehicle positions, walking catchments, and event access estimates.',
    sources: 'MyCiTi and matched PRASA schedules; unmatched services are estimates. Source dates and service validity depend on the delivered timetable.',
    supports: 'Discuss event timing, connected areas, and additional scheduled services with operators.',
    limits: 'Not live GPS, actual occupancy, guaranteed service, or accessible-route certification. Capacity assumes 60 bus / 800 train places per departure.',
    legend: 'Departures are scheduled services; places are nominal capacity. Coverage compares scheduled capacity to an assumed event-demand proxy.',
  },
};
const GUIDE = [
  ['Navigate the city', 'Mouse and one-finger drags orbit in the same direction. Shift, middle/right mouse, or two fingers pan; wheel or pinch zooms. Arrow keys, + / − and Home also work.'],
  ['Choose a lens', 'Choose Heat, Sun, Wind, Traffic or Transport. Each answers a different question using its own model and assumptions.'],
  ['Choose the scenario', 'Set the date, time and available controls. Sun, wind and traffic have explicit run actions. A picked map location can be passed to the sun or wind analysis area.'],
  ['Read the evidence', 'Read the units, evidence status and limitations before using a result. Save Before and After settings to compare assumptions, or share a settings link.'],
];
const $ = selector => document.querySelector(selector);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action) {
  const node = el('button', text, 'secondary'); node.type = 'button'; node.addEventListener('click', action); return node;
}
function rulesFromDOM() {
  return Object.fromEntries(CONTROL_IDS.map(id => {
    const input = document.getElementById(id);
    if (!input) return [id, null];
    return [id, input.tagName === 'SELECT'
      ? { options: [...input.options].filter(o => !o.disabled).map(o => o.value) }
      : { type: input.type, min: input.min ? Number(input.min) : -Infinity,
        max: input.max ? Number(input.max) : Infinity, step: Number(input.step) || 0 }];
  }));
}
function modeValue(name) { return document.querySelector(`[data-${name}].active`)?.getAttribute(`data-${name}`); }
function activeTool() { return $('[data-menu-target].active')?.dataset.menuTarget || 'tools'; }
function timeLabel(date) { return new Date(date).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }); }

export function setupExplorerExperience() {
  let manifest = null, camera = null, picked = null, ready = false, applying = false;
  let guideIndex = 0, before = null, after = null;
  const resultMetadata = {}, requestSettings = {}, activeRequests = {};
  // Older cached viewer shells used only `.panel-body`. Supporting that shell
  // prevents a newly revalidated module from stopping the entire renderer
  // before the user gets a chance to reload.
  const root = $('#explorer-panel-body') || $('.panel-body');
  if (!root) {
    console.warn('Explorer experience controls unavailable: panel body is missing.');
    return;
  }
  const workspace = el('details', undefined, 'scenario-workspace');
  workspace.append(el('summary', 'Scenario · save, compare & share'));
  const summary = el('p', 'Current controls; no saved scenario.', 'scenario-context');
  workspace.append(summary);
  const locationText = el('p', 'Location: current view. Use “Pick location” for a shared analysis centre.');
  workspace.append(locationText);
  const feedback = el('p', '', 'experience-feedback'); feedback.setAttribute('role', 'status');
  const actions = el('div', undefined, 'experience-actions');
  workspace.append(actions, feedback);
  root.prepend(workspace);
  const notify = text => { feedback.textContent = text; };

  function capture() {
    dispatchEvent(new CustomEvent('climate-capture-view'));
    const controls = Object.fromEntries(CONTROL_IDS.map(id => [id, document.getElementById(id)?.value]));
    const modes = Object.fromEntries(Object.keys(MODES).map(name => [name, modeValue(name)]));
    return validateScenario({ version: 1, tool: activeTool(), controls, modes, camera, location: picked }, rulesFromDOM());
  }
  function refresh() {
    const tool = activeTool();
    const label = $(`[data-menu-target="${tool}"]`)?.textContent.trim() || tool;
    const date = $(`#${tool === 'transport' ? 'transport-event' : tool}-date`)?.value;
    const metric = tool === 'heat' ? $('#heat-metric')?.selectedOptions[0]?.textContent : tool === 'wind' ? modeValue('wind-lens') : '';
    summary.textContent = `${label}${date ? ` · ${date}` : ''}${metric ? ` · ${metric}` : ''}. ${EVIDENCE[tool]?.status || 'Map context'}.`;
    locationText.textContent = picked ? `Picked local position: ${picked.x.toFixed(0)} m east, ${picked.z.toFixed(0)} m viewer z.` : 'Location: current view. Use “Pick location” for a shared analysis centre.';
  }
  function markDirty(tool) {
    if (applying || !resultMetadata[tool]) return;
    const node = $(`#evidence-result-${tool}`);
    if (node) node.textContent = 'Controls changed. The previous result may not describe these settings; run the analysis again.';
    resultMetadata[tool].stale = true;
  }
  function apply(scenario) {
    applying = true;
    const changed = [];
    // Set all values before notifying the model; restoring never clicks Run.
    for (const [id, value] of Object.entries(scenario.controls)) {
      const input = document.getElementById(id);
      if (input && input.value !== value) { input.value = value; changed.push(id); }
    }
    for (const [name, value] of Object.entries(scenario.modes)) {
      const control = document.querySelector(`[data-${name}="${value}"]`);
      if (control && !control.disabled && !control.classList.contains('active')) control.click();
    }
    for (const id of changed) {
      const input = document.getElementById(id);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (scenario.camera) dispatchEvent(new CustomEvent('climate-restore-view', { detail: { camera: scenario.camera } }));
    if (scenario.location) picked = scenario.location;
    $(`[data-menu-target="${scenario.tool}"]`)?.click();
    if (picked && ['sun', 'wind'].includes(scenario.tool)) dispatchEvent(new CustomEvent('climate-use-location', { detail: { tool: scenario.tool, ...picked } }));
    applying = false;
    Object.keys(resultMetadata).forEach(markDirty);
    refresh();
  }
  function record(tool, metadata) {
    if (!EVIDENCE[tool]) return;
    const settings = metadata.clientOnly ? capture() : requestSettings[tool] || capture();
    resultMetadata[tool] = { ...metadata, settings, stale: false };
    const node = $(`#evidence-result-${tool}`);
    if (node) node.textContent = `${metadata.label || 'Result received'} · ${timeLabel(metadata.receivedAt || new Date())}${metadata.requestId ? ` · Reference ${metadata.requestId}` : ''}. Settings are included in the scenario export.`;
  }

  for (const [tool, evidence] of Object.entries(EVIDENCE)) {
    const panel = $(`#menu-${tool}`);
    const card = el('section', undefined, 'evidence-card'); card.setAttribute('aria-label', `${tool} evidence`);
    card.append(el('p', evidence.status, 'evidence-badge'), el('p', evidence.limits, 'evidence-limit'));
    const result = el('p', 'No completed result recorded in this session.', 'evidence-result'); result.id = `evidence-result-${tool}`;
    const request = el('p', '', 'request-state'); request.id = `request-state-${tool}`; request.setAttribute('role', 'status');
    const details = el('details'); details.append(el('summary', 'About this result'));
    for (const [title, text] of [['Method', evidence.method], ['Sources & dates', evidence.sources], ['Can support', evidence.supports], ['Legend & units', evidence.legend]]) {
      const p = el('p'); p.append(el('strong', `${title}. `), document.createTextNode(text)); details.append(p);
    }
    const facts = el('p', 'Exact source dates/resolution not supplied are unknown, not assumed current.'); facts.id = `evidence-facts-${tool}`;
    details.append(facts, result);
    const link = el('a', 'Read the method'); link.href = `/docs#${tool}`; details.append(link);
    const cancel = button('Cancel request', () => {
      cancelRequests(tool);
      dispatchEvent(new CustomEvent('climate-cancel-analysis', { detail: { tool } }));
      notify(`${tool} request cancelled. Server computation may finish independently.`);
    });
    cancel.hidden = true; cancel.id = `request-cancel-${tool}`;
    const retry = button('Retry', () => dispatchEvent(new CustomEvent('climate-retry-analysis', { detail: { tool } })));
    retry.hidden = true; retry.id = `request-retry-${tool}`;
    card.append(details, request, cancel, retry);
    panel.append(card);
  }

  actions.append(button('Pick location', () => {
    if (!ready) return notify('Wait for the scene to finish loading.');
    dispatchEvent(new CustomEvent('climate-streetview-mode', { detail: { enabled: true } }));
    notify('Click a mapped ground position. Press Esc to cancel.');
  }));
  for (const tool of ['sun', 'wind']) actions.append(button(`Use location in ${tool}`, () => {
    if (!picked) return notify('Pick a mapped location first.');
    $(`[data-menu-target="${tool}"]`)?.click();
    dispatchEvent(new CustomEvent('climate-use-location', { detail: { tool, ...picked } }));
    markDirty(tool);
    notify(tool === 'wind'
      ? 'Wind flow box moved to this location. Comfort still covers the solved domain; select Flow to inspect the local box.'
      : 'Sunlight analysis centre updated. Calculate sun hours to obtain a new local result.');
  }));
  const comparison = el('div', undefined, 'scenario-comparison'); workspace.append(comparison);
  function showComparison() {
    comparison.replaceChildren();
    if (!before || !after) return;
    const rows = compareScenarios(before.settings, after.settings);
    comparison.append(el('p', `${rows.filter(r => r.changed).length} changed settings. This compares captured settings, not simulated intervention benefits. Drawn traffic closures are not restored by this version.`));
    const table = el('table'); table.append(el('caption', 'Before / After settings'));
    const header = el('tr'); for (const label of ['Setting', 'Before', 'After']) { const th = el('th', label); th.scope = 'col'; header.append(th); }
    const head = el('thead'); head.append(header); table.append(head);
    const body = el('tbody');
    for (const row of rows.filter(r => r.changed)) {
      const tr = el('tr'); tr.append(el('th', row.key), el('td', row.before), el('td', row.after)); body.append(tr);
    }
    table.append(body); comparison.append(table);
    const unchanged = el('details'); unchanged.append(el('summary', `${rows.filter(r => !r.changed).length} settings held constant`));
    for (const row of rows.filter(r => !r.changed)) unchanged.append(el('p', `${row.key}: ${row.before}`));
    comparison.append(unchanged);
  }
  function snapshot() { return { settings: capture(), createdAt: new Date().toISOString(), evidence: structuredClone(resultMetadata), manifest: manifestIdentity() }; }
  for (const slot of ['Before', 'After']) actions.append(button(`Save ${slot}`, () => {
    if (!ready) return notify('Wait for the scene to finish loading.');
    if (slot === 'Before') before = snapshot(); else after = snapshot();
    showComparison(); notify(`${slot} captured in this tab. Export to keep a copy; refreshing clears these snapshots.`);
  }));
  for (const slot of ['Before', 'After']) actions.append(button(`Restore ${slot}`, () => {
    const saved = slot === 'Before' ? before : after;
    if (!saved) return notify(`Save ${slot} first.`);
    apply(saved.settings); notify(`${slot} settings restored. Run analyses again; drawn closures and result arrays are not restored.`);
  }));
  function manifestIdentity() {
    if (!manifest) return null;
    return { version: manifest.version, crs: manifest.crs, bounds: manifest.bounds,
      assets: manifest.assets, layers: Object.fromEntries(Object.entries(manifest.layers || {}).map(([k, v]) => [k, { cache_key: v.cache_key, bytes: v.bytes, resolution_m: v.resolution_m }])) };
  }
  actions.append(button('Copy settings link', async () => {
    const url = scenarioURL(location.href, capture());
    try { await navigator.clipboard.writeText(url); notify('Settings link copied. It uses the recipient’s current data release and does not include completed simulations or drawn closures.'); }
    catch {
      const field = el('textarea'); field.value = url; field.readOnly = true; field.setAttribute('aria-label', 'Settings link');
      feedback.replaceChildren(el('span', 'Copy this settings link: '), field); field.focus(); field.select();
    }
  }));
  actions.append(button('Export scenario JSON', () => {
    const data = { schema: 'conditions-scenario/1', ...snapshot(), before, after,
      sources: EVIDENCE, limitations: 'Settings and evidence metadata only; no result arrays, traffic closure geometry, event names, credentials or personal data.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = el('a'); anchor.href = url; anchor.download = 'conditions-scenario.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Scenario exported. Results must be recomputed against the recorded data release.');
  }));
  actions.append(button('Reset view & controls', () => {
    const url = new URL(location.href); url.search = ''; url.hash = ''; location.assign(url.href);
  }));

  const guide = el('section', undefined, 'explorer-guide'); guide.setAttribute('aria-label', 'Getting started');
  const guideTitle = el('h2'), guideText = el('p'), guideActions = el('div', undefined, 'experience-actions');
  function renderGuide() { guideTitle.textContent = `${guideIndex + 1}/4 · ${GUIDE[guideIndex][0]}`; guideText.textContent = GUIDE[guideIndex][1]; }
  const dismiss = () => { guide.hidden = true; try { localStorage.setItem('climate-guide-v1', 'dismissed'); } catch { /* private browsing */ } };
  guideActions.append(button('Next step', () => { if (guideIndex === 3) dismiss(); else { guideIndex++; renderGuide(); } }), button('Dismiss guide', dismiss));
  guide.append(guideTitle, guideText, guideActions); root.prepend(guide); renderGuide();
  try { guide.hidden = localStorage.getItem('climate-guide-v1') === 'dismissed'; } catch { /* no persistent preference */ }
  actions.append(button('Getting started', () => { guideIndex = 0; renderGuide(); guide.hidden = false; root.scrollTop = 0; guideTitle.tabIndex = -1; guideTitle.focus(); }));

  const hints = {
    'wind-cfd-ground-height': 'Sampling height above local terrain; this does not change the solved CFD mesh.',
    'wind-stability': 'Screening atmospheric profile. The existing CFD cases use neutral inlet assumptions.',
    'traffic-demand': 'Multiplier on synthetic demand, not an observed vehicle count.',
    'traffic-seed-count': 'Repeats the paired open/closed simulation and reports the median plus its range.',
    'transport-event-share': 'Assumed proportion of attendees using public transport; actual behaviour is unknown.',
    'sun-surface-resolution': 'Coarser grids run faster and cannot resolve fine details.',
  };
  for (const [id, text] of Object.entries(hints)) {
    const control = document.getElementById(id); if (!control) continue;
    const hint = el('small', text, 'control-hint'); hint.id = `${id}-help`; control.closest('label')?.append(hint);
    control.setAttribute('aria-describedby', hint.id);
  }
  // Group only controls whose parent visibility is not managed by the renderer.
  for (const [panelId, ids] of [['#sun-window-controls', ['sun-step-time', 'sun-surface-resolution']], ['#wind-slice-controls', ['wind-slice-width', 'wind-slice-height', 'wind-slice-center-x', 'wind-slice-center-y']]]) {
    const parent = $(panelId); if (!parent) continue;
    const details = el('details', undefined, 'experience-advanced'); details.append(el('summary', 'Advanced settings'));
    ids.forEach(id => { const label = document.getElementById(id)?.closest('label'); if (label) details.append(label); }); parent.append(details);
  }
  for (const node of document.querySelectorAll('[id$="status"], #status')) { node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); }
  document.addEventListener('input', event => {
    const tool = event.target.closest('[data-menu-panel]')?.dataset.menuPanel;
    if (tool && !applying) { cancelRequests(tool); markDirty(tool); }
  }, true);
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-sun-mode], [data-wind-lens], [data-wind-direction], [data-transport-mode]')) return;
    const tool = event.target.closest('[data-menu-panel]')?.dataset.menuPanel;
    if (tool) markDirty(tool);
  }, true);
  document.addEventListener('change', event => {
    const tool = event.target.closest('[data-menu-panel]')?.dataset.menuPanel;
    if (tool && !applying) cancelRequests(tool);
  }, true);
  document.addEventListener('change', event => {
    const tool = event.target.closest('[data-menu-panel]')?.dataset.menuPanel;
    if (tool) markDirty(tool); refresh();
  });
  addEventListener('climate-menu-change', refresh);
  addEventListener('climate-manifest', event => { manifest = event.detail; });
  addEventListener('climate-scene-state', event => { camera = event.detail.camera; });
  addEventListener('climate-streetview-point', event => {
    const location = validateScenario({ version: 1, tool: activeTool(), location: event.detail }, {}).location;
    if (location) { picked = location; refresh(); notify('Mapped location selected. Choose sun or wind to use this analysis centre.'); }
  });
  addEventListener('climate-request-status', event => {
    const d = event.detail;
    const state = $(`#request-state-${d.tool}`), cancel = $(`#request-cancel-${d.tool}`);
    const active = activeRequests[d.tool] ||= new Set();
    if (d.state === 'loading') { requestSettings[d.tool] = capture(); active.add(d.key); }
    else active.delete(d.key);
    if (state) state.textContent = d.state === 'error' ? d.message : active.size ? 'Loading data…' : '';
    if (cancel) cancel.hidden = active.size === 0;
    const retry = $(`#request-retry-${d.tool}`);
    if (retry) retry.hidden = d.state !== 'error';
    if (d.state === 'ready' && !d.path.includes('/roads') && !d.path.includes('/live') && !d.path.includes('/sectors')) {
      record(d.tool, { requestId: d.requestId, receivedAt: d.receivedAt, label: 'Data received' });
    }
  });
  addEventListener('climate-analysis-result', event => {
    const { tool, metadata = {} } = event.detail;
    const prior = metadata.clientOnly ? {} : resultMetadata[tool];
    record(tool, { ...prior, ...metadata, receivedAt: new Date().toISOString(), label: 'Result ready' });
    const facts = $(`#evidence-facts-${tool}`);
    if (facts && metadata.description) facts.textContent = metadata.description;
  });
  addEventListener('climate-wind-result', event => {
    const field = event.detail;
    if (!field) return;
    record('wind', { receivedAt: new Date().toISOString(), label: 'Wind result ready', model: field.model_kind, validation: field.validation_status, coverage: field.coverage_fraction ?? field.coverage, version: field.version });
  });
  addEventListener('climate-viewer-ready', () => {
    ready = true;
    const restored = readScenarioURL(location.search, rulesFromDOM());
    if (restored) { apply(restored); notify('Shared settings restored. Run analyses as needed. Data versions may differ from the sender’s; drawn closures are not included.'); }
    else if (new URLSearchParams(location.search).has('scenario')) notify('Invalid or unsupported scenario link ignored.');
    refresh();
  });
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    dispatchEvent(new CustomEvent('climate-streetview-mode', { detail: { enabled: false } }));
    const close = $('#transport-results-close');
    if (!$('#transport-event-results')?.hidden) { close?.click(); $('#transport-event-analyse')?.focus(); }
  });
  refresh();
}
