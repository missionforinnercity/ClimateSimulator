import { CONTROL_IDS, MODES, TOOLS, validateScenario, readScenarioURL, scenarioURL, compareScenarios } from './scenarioState.js';
import { cancelRequests } from './requestClient.js';

const EVIDENCE = {
  heat: {
    status: 'Experimental · Modelled', method: 'Near-live and historical UTCI combine weather, wind and radiant heat; separate screening layers use satellite-derived surface heat and mapped shade.',
    sources: 'Each result reports its source window and model inputs. Terrain uses 2025 LiDAR with a lower-resolution SRTM supplement.',
    supports: 'Explore modelled outdoor comfort, compare planning periods, and identify areas for field investigation.',
    limits: 'No co-located CBD observations yet. Results are not measured pedestrian conditions, a heat-health forecast, or a verified intervention benefit.',
    legend: 'UTCI is an outdoor comfort index. Satellite surface temperature and shade-priority scores are separate screening measures, not UTCI.',
  },
  design_heat: {
    status: 'Screening · matched proposal geometry',
    method: 'Matched baseline/proposal heat-zone shade deficit and priority screen. Proposed shadows are recalculated; the summer surface-temperature input remains fixed.',
    sources: 'Mapped heat-zone polygons, scene buildings/canopy, selected date and time, and proposal geometry hash.',
    supports: 'Compare relative shade and screening-score changes for one proposal geometry at one selected time.',
    limits: 'Not proposal UTCI/Tmrt, a rerun of SUEWS/SOLWEIG, measured heat risk, or a validated intervention outcome. Zone-level output is not retained.',
    legend: 'Shade deficit is percent of a zone not shaded; lower is more shade. Priority score is /100 and is a screening rank, not a health-risk measure.',
  },
  walking: {
    status: 'Modelled · CBD only', method: 'OSM pedestrian graph routing with mapped building/canopy shade and hourly UTCI/pedestrian wind where available. One hundred seeded matched synthetic walkers are sampled per route.',
    sources: 'Checked-in OSM XML, mapped city geometry, and the published thermal forecast. Optional NOx context is a separate SUMO/HBEFA road-source estimate.',
    supports: 'Compare estimated walking time, direct sun, modelled heat load, and pedestrian wind across route alternatives.',
    limits: 'OSM foot-access attributes can be incomplete; forecast layers are not street observations. Steps remain in the graph, and no wheelchair-accessibility, personal dose, or crowd-interaction claim is made.',
    legend: 'Minutes are estimated at 4.8 km/h. Heat load is cumulative UTCI above 26°C. Road NOx is not pedestrian concentration or dose.',
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
  wind_validation: {
    status: 'Diagnostic · measured observations',
    method: 'Site/period split observations are sampled against one converted OpenFOAM case and scaled by concurrent upstream speed.',
    sources: 'Imported observation file, OpenFOAM volume, terrain DEM and scene manifest; source hashes are included.',
    supports: 'Review calibration and holdout residuals for the measured sites, sector and conditions.',
    limits: 'A holdout score does not establish global accuracy, mesh independence, gust safety or engineering suitability.',
    legend: 'Residual sign is predicted minus observed. Preserve the imported source and keep holdout groups untouched.',
  },
  thermal_validation: {
    status: 'Diagnostic · measured observations',
    method: 'Measured component values and UTCI are compared with the nearest retained hourly thermal frame.',
    sources: 'Imported thermal score JSON and exact source CSV; run manifest and sampled frame hashes are included.',
    supports: 'Review component errors and holdout metrics by site or evaluation group.',
    limits: 'Air temperature and humidity compare with weather forcing, not spatial SUEWS output. A holdout score does not establish overall model validity.',
    legend: 'Residual sign is model minus observed. Preserve the source CSV and do not tune against holdout groups.',
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
  ['Navigate the city', 'Drag to orbit. Pinch or scroll to zoom; two fingers pan.'],
  ['Choose a lens', 'Choose Heat, Walk, Sun, Wind, Traffic or Transport. Each answers a different question using its own model and assumptions.'],
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
  let serverHealthSnapshot = { status: 'pending' };
  fetch('/api/health', { headers: { Accept: 'application/json' } })
    .then(async response => {
      serverHealthSnapshot = response.ok
        ? await response.json()
        : { status: 'unavailable', httpStatus: response.status };
    })
    .catch(() => { serverHealthSnapshot = { status: 'unavailable' }; });
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
  const REPORT_META_KEY = 'conditions-climate-report-metadata-v1';
  const reportMetadata = {
    projectName: 'Conditions · Cape Town CBD', client: '', projectReference: '', preparedBy: '',
    location: 'Cape Town, South Africa', periodStart: '', periodEnd: '', notes: '',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(REPORT_META_KEY) || '{}');
    for (const key of Object.keys(reportMetadata)) {
      if (typeof saved?.[key] === 'string' && saved[key].length <= (key === 'notes' ? 2000 : 200)) reportMetadata[key] = saved[key];
    }
  } catch { /* report metadata remains editable if storage is unavailable */ }
  const reportDetails = el('details', undefined, 'report-metadata');
  reportDetails.append(el('summary', 'Client report details'));
  reportDetails.append(el('p', 'These labels are saved with the exported report. They do not alter model inputs or imply validation; model dates remain in each result’s scenario settings.'));
  const reportFields = el('div', undefined, 'report-metadata-grid');
  const addReportField = (key, labelText, type = 'text', maxLength = 200) => {
    const label = el('label', labelText);
    const input = el('input'); input.type = type; input.value = reportMetadata[key];
    if (type === 'text') input.maxLength = maxLength;
    input.autocomplete = 'off'; input.setAttribute('aria-label', labelText);
    input.addEventListener('input', () => {
      reportMetadata[key] = input.value;
      try { localStorage.setItem(REPORT_META_KEY, JSON.stringify(reportMetadata)); } catch { /* still included in this export */ }
    });
    label.append(input); reportFields.append(label);
  };
  addReportField('projectName', 'Project / report name');
  addReportField('client', 'Client / organization');
  addReportField('projectReference', 'Project reference');
  addReportField('preparedBy', 'Prepared by');
  addReportField('location', 'Study location');
  addReportField('periodStart', 'Reporting period starts', 'date');
  addReportField('periodEnd', 'Reporting period ends', 'date');
  const notesLabel = el('label', 'Report notes');
  const notesInput = el('textarea'); notesInput.rows = 3; notesInput.maxLength = 2000;
  notesInput.value = reportMetadata.notes; notesInput.setAttribute('aria-label', 'Report notes');
  notesInput.addEventListener('input', () => {
    reportMetadata.notes = notesInput.value;
    try { localStorage.setItem(REPORT_META_KEY, JSON.stringify(reportMetadata)); } catch { /* still included in this export */ }
  });
  notesLabel.append(notesInput); reportFields.append(notesLabel);
  reportDetails.append(reportFields); workspace.append(reportDetails);
  const feedback = el('p', '', 'experience-feedback'); feedback.setAttribute('role', 'status');
  const actions = el('div', undefined, 'experience-actions');
  const notesPanel = el('section', undefined, 'local-notes');
  notesPanel.setAttribute('aria-label', 'Local map notes');
  notesPanel.append(el('h3', 'Map notes · this browser only'));
  notesPanel.append(el('p', 'Notes stay in this browser and are not included in settings links or scenario exports. This is not public feedback or voting.'));
  const notesForm = el('form', undefined, 'local-note-form');
  const noteInput = el('textarea');
  noteInput.maxLength = 500;
  noteInput.rows = 3;
  noteInput.required = true;
  noteInput.setAttribute('aria-label', 'Map note');
  noteInput.placeholder = 'Add a note for this location (up to 500 characters)';
  const saveNote = el('button', 'Save note'); saveNote.type = 'submit';
  notesForm.append(noteInput, saveNote);
  notesForm.hidden = true;
  const notesList = el('ul', undefined, 'local-note-list');
  notesPanel.append(notesForm, notesList);
  workspace.append(actions, feedback, notesPanel);
  root.prepend(workspace);
  const notify = text => { feedback.textContent = text; };
  const NOTE_KEY = 'conditions-local-notes-v1';
  const NOTE_LIMIT = 50;
  let notes = [];
  let pendingNoteLocation = null;
  try {
    const saved = JSON.parse(localStorage.getItem(NOTE_KEY) || '[]');
    if (Array.isArray(saved)) notes = saved.filter(note => note && typeof note.text === 'string'
      && note.text.trim() && note.text.length <= 500 && Number.isFinite(note.x) && Number.isFinite(note.z)
      && typeof note.id === 'string' && typeof note.createdAt === 'string').slice(-NOTE_LIMIT);
  } catch { /* Local notes are optional when storage is unavailable. */ }
  function persistNotes(previousNotes) {
    try {
      localStorage.setItem(NOTE_KEY, JSON.stringify(notes));
      dispatchEvent(new CustomEvent('climate-local-notes', { detail: notes }));
      renderNotes();
      return true;
    } catch {
      notes = previousNotes;
      renderNotes();
      notify('Browser storage is unavailable; the note was not saved.');
      return false;
    }
  }
  function renderNotes() {
    notesList.replaceChildren();
    for (const note of notes) {
      const item = el('li');
      const content = el('span', `${note.text} · ${note.x.toFixed(0)} m east, ${note.z.toFixed(0)} m viewer z`);
      const remove = button('Delete', () => {
        const previous = notes;
        notes = notes.filter(candidate => candidate.id !== note.id);
        persistNotes(previous);
      });
      item.append(content, remove);
      notesList.append(item);
    }
    dispatchEvent(new CustomEvent('climate-local-notes', { detail: notes }));
  }
  notesForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = noteInput.value.trim();
    if (!pendingNoteLocation || !text) return;
    if (notes.length >= NOTE_LIMIT) return notify(`This browser already has ${NOTE_LIMIT} notes. Delete one before adding another.`);
    const previous = notes;
    notes = [...notes, { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString(), ...pendingNoteLocation, text }];
    pendingNoteLocation = null; notesForm.hidden = true; noteInput.value = '';
    if (persistNotes(previous)) notify('Map note saved in this browser.');
  });
  renderNotes();

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
    resultMetadata[tool] = { ...(metadata.clientOnly ? {} : resultMetadata[tool]), ...metadata, settings, stale: false };
    const node = $(`#evidence-result-${tool}`);
    if (node) node.textContent = `${metadata.label || 'Result received'} · ${timeLabel(metadata.receivedAt || new Date())}${metadata.requestId ? ` · Reference ${metadata.requestId}` : ''}. Settings are included in the scenario export.`;
  }

  for (const [tool, evidence] of Object.entries(EVIDENCE)) {
    const panel = $(`#menu-${tool}`);
    if (!panel) continue;
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
  actions.append(button('Add map note', () => {
    if (!ready) return notify('Wait for the scene to finish loading.');
    pendingNoteLocation = null;
    notesForm.hidden = true;
    dispatchEvent(new CustomEvent('climate-local-note-pick-mode', { detail: { enabled: true } }));
    notify('Click a mapped ground position for the note. Press Esc to cancel.');
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
  function snapshot(includeMap = false) {
    return {
      settings: capture(), createdAt: new Date().toISOString(), evidence: structuredClone(resultMetadata), manifest: manifestIdentity(),
      ...(includeMap ? { map: captureMapImage(), resultReferences: reportEvidence() } : {}),
    };
  }
  for (const slot of ['Before', 'After']) actions.append(button(`Save ${slot}`, () => {
    if (!ready) return notify('Wait for the scene to finish loading.');
    if (slot === 'Before') before = snapshot(true); else after = snapshot(true);
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
      assets: manifest.assets,
      buildInputs: manifest.buildInputs || {},
      layers: Object.fromEntries(Object.entries(manifest.layers || {}).map(([k, v]) => [k, { cache_key: v.cache_key, bytes: v.bytes, resolution_m: v.resolution_m }])) };
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
    const scenarioSnapshot = value => {
      if (!value) return null;
      const { map: _capturedMap, ...settingsSnapshot } = value;
      return settingsSnapshot;
    };
    const data = { schema: 'conditions-scenario/1', ...snapshot(), before: scenarioSnapshot(before), after: scenarioSnapshot(after),
      sources: EVIDENCE, limitations: 'Settings and evidence metadata only; no result arrays, traffic closure geometry, event names, credentials or personal data.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = el('a'); anchor.href = url; anchor.download = 'conditions-scenario.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Scenario exported. Results must be recomputed against the recorded data release.');
  }));
  function reportEvidence() {
    const summaryKeys = ['description', 'label', 'receivedAt', 'requestId', 'analysis_id', 'run_id', 'frame_id', 'valid_at',
      'run_generated_at', 'manifest_sha256', 'frame_sha256', 'model_versions', 'models', 'grid', 'channels', 'wind_sector',
      'climatology', 'manifest_generated_at', 'aggregate', 'month', 'season', 'local_hour', 'source_frames',
      'validation_status', 'validation', 'provenance', 'weather_warnings', 'weather_inputs', 'scenario', 'meanSunHours', 'pairedBeforeMeanSunHours',
      'pairedAfterMeanSunHours', 'pairedChangeMeanSunHours', 'pairedGroundCellCount', 'localChangeMeanSunHours',
      'solver', 'worker', 'direction', 'case_id', 'spacing', 'asset_hashes', 'source_provenance', 'kpis',
      'arrivals', 'returns', 'coverage', 'date', 'job_id', 'reference', 'result_data', 'caveat', 'stale'];
    return Object.fromEntries(Object.entries(resultMetadata).map(([tool, value]) => {
      const summary = Object.fromEntries(summaryKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
      const absoluteAssetUrl = path => new URL(`/${String(path).replace(/^\/+/, '')}`, location.origin).href;
      let reference = { type: 'session-result', retrievable: false, replayable: false, retention: 'Browser session only; rerun from the recorded settings.' };
      if (tool === 'heat' && value.run_id && value.frame_id) reference = {
        type: 'thermal-frame', run_id: value.run_id, frame_id: value.frame_id,
        url: absoluteAssetUrl(`api/thermal/frames/${encodeURIComponent(value.run_id)}/${encodeURIComponent(value.frame_id)}`),
        manifest_url: absoluteAssetUrl(`api/thermal/runs/${encodeURIComponent(value.run_id)}/source-manifest`),
        frame_sha256: value.frame_sha256 || null, manifest_sha256: value.manifest_sha256 || null,
        model_versions: value.model_versions || null, worker: value.worker || null, grid: value.grid || null,
        run_generated_at: value.run_generated_at || null, validation_status: value.validation_status || null,
        retrievable: true, replayable: false,
        retention: 'The exact frame can be retrieved while retained; the worker keeps only its latest three runs. The URL is not a durable archive.',
      };
      if (tool === 'design_heat' && value.reference?.type === 'design-heat-shade-screen') reference = {
        ...value.reference,
        endpoint: '/api/heat/design-comparison',
        retrievable: false, replayable: false,
        retention: 'Summary KPIs and proposal geometry/settings are embedded in this report; exact rerun requires the matching app, heat-zone data, scene geometry and method version.',
      };
      if (tool === 'heat' && value.climatology && Array.isArray(value.source_frames)) reference = {
        type: 'thermal-climatology-composite',
        manifest_url: absoluteAssetUrl('api/thermal/climatology/source-manifest'),
        manifest_generated_at: value.manifest_generated_at || null,
        manifest_sha256: value.manifest_sha256 || null,
        source_frames: value.source_frames.map(frame => ({
          id: frame.id, valid_at: frame.valid_at, sha256: frame.sha256, bytes: frame.bytes,
          url: absoluteAssetUrl(`api/thermal/climatology/frames/${encodeURIComponent(frame.id)}`),
        })),
        model_versions: value.models || null, grid: value.grid || null,
        settings: { aggregate: value.aggregate, month: value.month, season: value.season, local_hour: value.local_hour, metric: value.metric },
        retrievable: true, replayable: false,
        retention: 'Source frames and manifest are retrievable from the current product release; hashes identify the captured product, but the release is not permanently archived.',
      };
      if (tool === 'wind' && value.case_id && value.manifest_url) reference = {
        type: 'openfoam-volume', case_id: value.case_id, manifest_url: absoluteAssetUrl(value.manifest_url),
        asset_version: value.asset_version, asset_hashes: value.asset_hashes || null, retrievable: true, replayable: false,
        retention: 'The volume can be retrieved while this exact release remains deployed; the reference does not archive or rerun the solver.',
      };
      if (tool === 'wind_validation' && value.case_id) reference = {
        type: 'openfoam-observation-validation', case_id: value.case_id,
        observation_payload_sha256: value.validation?.provenance?.observation_payload_sha256 || null,
        asset_hashes: value.asset_hashes || null,
        supporting_asset_hashes: value.source_provenance || null,
        result_embedded_in_report: true, retrievable: false, replayable: false,
        retention: 'Per-row observations, residuals, holdout metrics and the imported observation source are embedded in report JSON. Exact replay also needs matching CFD, terrain, scene and code versions.',
      };
      if (tool === 'thermal_validation' && value.run_id && value.provenance?.manifest_sha256) {
        const pairs = value.result_data?.pairs || [];
        const frames = [...new Map(pairs.map(pair => [pair.frame_id, {
          id: pair.frame_id, valid_at: pair.frame_at,
          sha256: pair.frame_sha256 || value.provenance.frame_sha256_by_id?.[pair.frame_id],
        }])).values()];
        reference = {
          type: 'thermal-observation-validation', run_id: value.run_id,
          manifest_url: absoluteAssetUrl(`api/thermal/runs/${encodeURIComponent(value.run_id)}/source-manifest`),
          manifest_sha256: value.provenance.manifest_sha256,
          observations_sha256: value.provenance.observations_sha256,
          model_versions: value.provenance.model_versions || null,
          worker: value.provenance.worker || null,
          utci_implementation: value.provenance.utci_implementation || null,
          source_frames: frames.map(frame => ({
            ...frame,
            url: absoluteAssetUrl(`api/thermal/frames/${encodeURIComponent(value.run_id)}/${encodeURIComponent(frame.id)}`),
          })),
          result_embedded_in_report: true, retrievable: true, replayable: false,
          retention: 'Paired measurements, residuals and metrics are embedded in report JSON. The original CSV and referenced frames are included in an archive when available; replay still requires matching code and environment.',
        };
      }
      if (tool === 'traffic' && value.job_id) reference = {
        type: 'traffic-job', job_id: value.job_id, url: absoluteAssetUrl(`api/traffic/closure-preview/jobs/${encodeURIComponent(value.job_id)}`),
        request_id: value.requestId, retrievable: true, replayable: false,
        retention: 'Job results are held in memory for 15 minutes by default (configurable); the report stores settings and reference, not trip arrays.',
      };
      if (tool === 'sun' && value.scenario?.design_geometry_hash) reference = {
        type: 'design-sunlight-comparison', analysis_id: value.analysis_id || value.requestId,
        geometry_hash: value.scenario.design_geometry_hash, endpoint: '/api/sunlight/design-comparison',
        retrievable: false, replayable: false,
        retention: 'Summary KPIs, proposal geometry and settings are embedded in this report; exact rerun requires the matching app, scene assets and method version.',
      };
      else if (tool === 'sun' && (value.requestId || value.analysis_id)) reference = {
        type: 'sunlight-analysis', analysis_id: value.analysis_id || value.requestId, retrievable: false, replayable: false,
        retention: 'The server does not retain the raster result; rerun with the recorded scenario and current assets.',
      };
      return [tool, { summary, reference, settings: value.settings || null,
        ...(value.result_data ? { result_data: value.result_data } : {}) }];
    }));
  }
  function reportKpiComparisons() {
    if (!before || !after) return [];
    const flatten = value => {
      const output = {};
      const visit = (node, prefix) => {
        if (typeof node === 'number' && Number.isFinite(node)) output[prefix] = node;
        else if (node && typeof node === 'object' && !Array.isArray(node)) {
          for (const [key, child] of Object.entries(node)) visit(child, prefix ? `${prefix}.${key}` : key);
        }
      };
      visit(value, '');
      return output;
    };
    const rows = [];
    for (const [tool, left] of Object.entries(before.evidence || {})) {
      const right = after.evidence?.[tool];
      if (!right || left.stale || right.stale) continue;
      const beforeKpis = flatten(left.kpis || {});
      const afterKpis = flatten(right.kpis || {});
      for (const [metric, beforeValue] of Object.entries(beforeKpis)) {
        if (afterKpis[metric] === undefined) continue;
        const unit = metric.endsWith('_pct') || metric.includes('share_pct') || metric.includes('completion_share') ? '%'
          : metric.includes('sun_hours') ? 'h'
            : metric.endsWith('_deg') ? '°'
              : metric.endsWith('_m2') ? 'm²'
                : metric === 'mean' || metric === 'maximum' ? '°C'
                  : metric.includes('queue') ? 'vehicles'
                    : metric.includes('count') || metric.includes('cells') || metric.includes('arrivals') || metric.includes('returns') ? 'count'
                      : metric.endsWith('_m') ? 'm' : '';
        rows.push({ tool, metric, before: beforeValue, after: afterKpis[metric], change: afterKpis[metric] - beforeValue, unit });
      }
    }
    return rows;
  }
  function captureMapImage() {
    const canvas = $('#scene');
    if (!canvas) return { status: 'unavailable', reason: 'Scene canvas is missing.' };
    try {
      const image = document.createElement('canvas');
      image.width = canvas.width; image.height = canvas.height;
      const context = image.getContext('2d');
      context.drawImage(canvas, 0, 0);
      const overlay = $('#wind-overlay');
      if (overlay && overlay.width && getComputedStyle(overlay).visibility !== 'hidden' && getComputedStyle(overlay).display !== 'none') {
        context.globalAlpha = Number.parseFloat(getComputedStyle(overlay).opacity) || 1;
        context.drawImage(overlay, 0, 0, image.width, image.height);
      }
      const dataUrl = image.toDataURL('image/png');
      if (!dataUrl.startsWith('data:image/png') || dataUrl.length < 5000) return { status: 'unavailable', reason: 'The browser did not provide a rendered map image. Use the live app to inspect the map.' };
      if (dataUrl.length > 12_000_000) return { status: 'omitted', reason: 'Map image exceeded the 9 MB report limit.' };
      return { status: 'embedded', mimeType: 'image/png', dataUrl };
    } catch {
      return { status: 'unavailable', reason: 'The browser could not capture the WebGL canvas.' };
    }
  }
  function downloadBlob(name, contents, type) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const anchor = el('a'); anchor.href = url; anchor.download = name; anchor.hidden = true;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function reportHealthSnapshot() {
    const health = serverHealthSnapshot;
    if (!health || !health.checks) return { status: health?.status || 'pending' };
    return {
      status: health.status,
      application_version: health.application_version || null,
      runtime_source: health.runtime_source || null,
      field_version: health.field_version,
      checks: Object.fromEntries(Object.entries(health.checks).map(([name, check]) => [name, {
        status: check.status, required: check.required,
        manifest_version: check.manifest_version,
      }])),
    };
  }
  function reportHtml(report) {
    const safeJson = JSON.stringify(report).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conditions climate report</title>
      <style>body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#18242e}h1,h2{line-height:1.2}header,.card{border:1px solid #ccd6dc;border-radius:10px;padding:1rem;margin:1rem 0}small,.muted{color:#536574}img{max-width:100%;height:auto;border:1px solid #ccd6dc}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d7e0e5;padding:.55rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f7;padding:.75rem;border-radius:6px;font-size:12px}.actions{position:sticky;top:0;background:#fff;padding:.5rem}@media print{.actions{display:none}body{margin:0;max-width:none}.card,header{break-inside:avoid}}</style>
      <main><div class="actions"><button onclick="print()">Print / Save PDF</button> <a download="conditions-climate-report.json" id="json-download">Download report data</a></div><header><h1 id="report-title"></h1><p id="generated"></p><p>This report records model outputs and their provenance. It does not imply that an unvalidated field has passed scientific validation.</p></header><section class="card"><h2>Map</h2><div id="map"></div></section><section class="card" id="before-map-card" hidden><h2>Scene view at Before</h2><div id="before-map"></div></section><section class="card" id="after-map-card" hidden><h2>Scene view at After</h2><div id="after-map"></div></section><section class="card"><h2>Project metadata</h2><div id="project"></div></section><section class="card"><h2>Scenario settings</h2><div id="scenario"></div></section><section class="card"><h2>Completed results</h2><div id="results"></div></section><section class="card"><h2>Before / After KPI comparison</h2><div id="comparisons"></div></section><section class="card"><h2>Data release and validation status</h2><div id="provenance"></div></section><section class="card"><h2>Evidence, assumptions and limitations</h2><div id="limitations"></div></section></main>
      <script id="report-data" type="application/json">${safeJson}</script><script>(()=>{const d=JSON.parse(document.querySelector('#report-data').textContent);const pre=(parent,v)=>{const n=document.createElement('pre');n.textContent=JSON.stringify(v,null,2);parent.append(n)};const table=(parent,rows)=>{const t=document.createElement('table');for(const [k,v] of rows){const tr=t.insertRow();const th=document.createElement('th');th.textContent=k.replaceAll('_',' ');const td=document.createElement('td');td.textContent=typeof v==='object'?JSON.stringify(v):String(v??'—');tr.append(th,td);t.append(tr)}parent.append(t)};document.title=(d.project.name||'Conditions climate report');document.querySelector('#report-title').textContent=d.project.name||'Conditions climate report';document.querySelector('#generated').textContent='Generated '+d.generatedAt+' · '+(d.project.location||'');table(document.querySelector('#project'),Object.entries(d.project.details||{}));const drawMap=(parentId,map,label)=>{const parent=document.querySelector(parentId);if(map?.status==='embedded'){const i=document.createElement('img');i.src=map.dataUrl;i.alt=label;parent.append(i);return true}return false};const m=document.querySelector('#map');if(!drawMap('#map',d.map,'Current captured application map')){const p=document.createElement('p');p.className='muted';p.textContent=d.map.reason||'No map image was captured.';m.append(p)}if(drawMap('#before-map',d.before?.map,'Scene view captured with Before settings'))document.querySelector('#before-map-card').hidden=false;if(drawMap('#after-map',d.after?.map,'Scene view captured with After settings'))document.querySelector('#after-map-card').hidden=false;table(document.querySelector('#scenario'),[['Current analysis settings',d.settings]]);if(d.before||d.after){const b=document.createElement('details');b.innerHTML='<summary>Saved before and after settings</summary>';pre(b,{before:d.before&&{createdAt:d.before.createdAt,settings:d.before.settings,resultReferences:d.before.resultReferences},after:d.after&&{createdAt:d.after.createdAt,settings:d.after.settings,resultReferences:d.after.resultReferences}});document.querySelector('#scenario').append(b)}const r=document.querySelector('#results');for(const [tool,item] of Object.entries(d.results)){const a=document.createElement('article');const h=document.createElement('h3');h.textContent=tool;r.append(a);a.append(h);table(a,Object.entries(item.summary));const details=document.createElement('details');details.innerHTML='<summary>Result reference, run settings and embedded result data</summary>';pre(details,{resultReference:item.reference,settings:item.settings,resultData:item.result_data});a.append(details)}if(!Object.keys(d.results).length)r.textContent='No completed analyses were recorded in this browser session.';const c=document.querySelector('#comparisons');if(d.kpiComparisons?.length)table(c,d.kpiComparisons.map(x=>[x.tool+' · '+x.metric, x.before+' '+x.unit+' → '+x.after+' '+x.unit+' (change '+x.change+' '+x.unit+')']));else c.textContent='Save Before and After with comparable completed results to create KPI comparisons.';pre(document.querySelector('#provenance'),{application:d.application,sceneManifest:d.provenance.sceneManifest});pre(document.querySelector('#limitations'),d.evidence);const blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});document.querySelector('#json-download').href=URL.createObjectURL(blob)})();</script></html>`;
  }
  actions.append(button('Export climate report', () => {
    if (reportMetadata.periodStart && reportMetadata.periodEnd && reportMetadata.periodEnd < reportMetadata.periodStart) {
      notify('The report period end date must be on or after its start date.');
      reportDetails.open = true;
      return;
    }
    const report = {
      schema: 'conditions-climate-report/1', generatedAt: new Date().toISOString(),
      project: {
        name: reportMetadata.projectName.trim() || 'Conditions · Cape Town CBD',
        location: reportMetadata.location.trim() || 'Cape Town, South Africa',
        details: {
          client: reportMetadata.client.trim() || null,
          project_reference: reportMetadata.projectReference.trim() || null,
          prepared_by: reportMetadata.preparedBy.trim() || null,
          reporting_period_start: reportMetadata.periodStart || null,
          reporting_period_end: reportMetadata.periodEnd || null,
          notes: reportMetadata.notes.trim() || null,
          analysis_bounds_local_metres: manifest?.bounds || null,
        },
      },
      application: {
        origin: location.origin,
        clientEntry: document.querySelector('script[src*="/app.js"]')?.src || null,
        serverHealthUrl: `${location.origin}/api/health`,
        serverHealth: reportHealthSnapshot(),
      },
      settings: capture(), before, after,
      provenance: { sceneManifest: manifestIdentity(), resultReferences: reportEvidence() },
      results: reportEvidence(), kpiComparisons: reportKpiComparisons(), evidence: EVIDENCE, map: captureMapImage(),
      limitations: 'Values are model outputs with the status shown above. Wind and thermal fields have not been validated against held-out local CBD observations. See the linked validation methods for required evidence.',
    };
    const json = JSON.stringify(report, null, 2);
    downloadBlob('conditions-climate-report.json', json, 'application/json');
    downloadBlob('conditions-climate-report.html', reportHtml(report), 'text/html');
    notify('Climate report exported as HTML and JSON. The HTML is printable; references state whether each result can still be replayed.');
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
    if (event.target.id === 'wind-toggle') return;
    if (tool && !applying) { cancelRequests(tool); markDirty(tool); }
  }, true);
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-sun-mode], [data-wind-lens], [data-wind-direction], [data-transport-mode]')) return;
    const tool = event.target.closest('[data-menu-panel]')?.dataset.menuPanel;
    if (tool) markDirty(tool);
  }, true);
  document.addEventListener('change', event => {
    const tool = event.target.closest('[data-menu-panel]')?.dataset.menuPanel;
    if (event.target.id === 'wind-toggle') return;
    if (tool && !applying) cancelRequests(tool);
  }, true);
  document.addEventListener('change', event => {
    const tool = event.target.closest('[data-menu-panel]')?.dataset.menuPanel;
    if (event.target.id === 'wind-toggle') return;
    if (tool) markDirty(tool); refresh();
  });
  addEventListener('climate-menu-change', refresh);
  addEventListener('climate-manifest', event => { manifest = event.detail; });
  addEventListener('climate-scene-state', event => { camera = event.detail.camera; });
  addEventListener('climate-streetview-point', event => {
    const location = validateScenario({ version: 1, tool: activeTool(), location: event.detail }, {}).location;
    if (location) { picked = location; refresh(); notify('Mapped location selected. Choose sun or wind to use this analysis centre.'); }
  });
  addEventListener('climate-local-note-point', event => {
    const x = Number(event.detail?.x), z = Number(event.detail?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    pendingNoteLocation = { x, z };
    notesForm.hidden = false;
    noteInput.focus();
    notify(`Location selected (${x.toFixed(0)} m east, ${z.toFixed(0)} m viewer z). Add a short local note.`);
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
    dispatchEvent(new CustomEvent('climate-local-notes', { detail: notes }));
    const restored = readScenarioURL(location.search, rulesFromDOM());
    if (restored) { apply(restored); notify('Shared settings restored. Run analyses as needed. Data versions may differ from the sender’s; drawn closures are not included.'); }
    else if (new URLSearchParams(location.search).has('scenario')) notify('Invalid or unsupported scenario link ignored.');
    refresh();
  });
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    dispatchEvent(new CustomEvent('climate-streetview-mode', { detail: { enabled: false } }));
    dispatchEvent(new CustomEvent('climate-local-note-pick-mode', { detail: { enabled: false } }));
    if (pendingNoteLocation) { pendingNoteLocation = null; notesForm.hidden = true; notify('Map note cancelled.'); }
    const close = $('#transport-results-close');
    if (!$('#transport-event-results')?.hidden) { close?.click(); $('#transport-event-analyse')?.focus(); }
  });
  refresh();
}
