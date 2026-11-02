import { CONTROL_IDS, MODES, validateScenario, readScenarioURL } from './scenarioState.js';
import { cancelRequests } from './requestClient.js';
import { buildClimateReportHtml } from './climateReport.js?v=10';

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
    status: 'Modelled · CBD only', method: 'Routes use the checked-in OpenStreetMap pedestrian network with mapped buildings and canopy. Shade is sampled along each route; UTCI and pedestrian wind use the nearest complete hourly forecast frame when available. Each route also receives a matched cohort of 100 synthetic walkers.',
    sources: 'Checked-in OSM XML, mapped city geometry, and the published thermal forecast.',
    supports: 'Compare estimated walking time, direct sun, modelled heat load, and pedestrian wind across route alternatives.',
    limits: 'OSM access and sidewalk tags can be incomplete; forecast layers are not street observations. Mapped steps remain in the network. Walkers are synthetic and do not model crowds or demographics; results do not establish safety or wheelchair accessibility.',
    legend: 'Walking time assumes 4.8 km/h. Heat load is cumulative UTCI above 26°C. Missing street tags remain unknown.',
  },
  sun: {
    method: 'Exploratory modelled estimates use solar geometry, mapped building/canopy shadows, and clear-sky direct-sun sampling.',
    sources: 'Mapped hybrid building geometry and canopy; 2025 LiDAR terrain. Roof shapes and coarse terrain contain inferred geometry.',
    supports: 'Compare direct sunlight and shade at a selected date, time, and area.',
    limits: 'These are exploratory modelled comparisons, not measured irradiance, PV yield, diffuse/reflected light, or a certified daylight assessment.',
    legend: 'Hours (h) show sampled direct sun in the chosen time window. More sun is not always better; the intended use and season matter.',
  },
  wind: {
    method: 'The selected-square report uses a multi-direction wind comfort screen. The live 3D wind view displays solved OpenFOAM fields where available.',
    sources: 'Seasonal ERA5 wind patterns and mapped terrain and buildings inform the area comfort screen. ERA5 is regional context, not a street measurement.',
    supports: 'Inspect possible exposed areas, flow patterns, and questions for a validated wind study.',
    limits: 'Wind fields are exploratory and unvalidated, not measured street conditions or certified wind-safety evidence. They have not passed domain, mesh-sensitivity or local field-validation gates.',
    legend: 'The map groups locations by suitable outdoor activity. A category is not a guarantee of safety or comfort for every person.',
  },
  viewshed: {
    method: 'This screening tool estimates mapped line-of-sight visibility from one observer point against mapped terrain and building massing.',
    sources: 'Mapped terrain and building footprints/heights; trees and small unmapped objects do not block the calculation.',
    supports: 'Identify visible and screened ground within the selected distance and viewing direction.',
    limits: 'This is not a surveyed sightline. Sub-grid terrain, unmapped structures, trees and atmospheric refraction are not represented.',
    legend: 'Visible share is the portion of valid sampled ground cells with a clear line of sight.',
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
    method: 'SUMO compares a closure run with a paired baseline using the same demand and random seeds.',
    sources: 'OSM/SUMO network, mapped signal settings, synthetic demand. Provider traffic freshness is shown separately.',
    supports: 'Explore rerouting trade-offs for a specified closure and demand assumption.',
    limits: 'Results are not a calibrated traffic forecast or closure approval. Emissions and noise are modelled, not measured; report reliability gates still apply.',
    legend: 'Vehicle speed uses km/h. Diversion gains/losses refer to modelled traffic relative to the same baseline; colour alone is not a recommendation.',
  },
};
const $ = selector => document.querySelector(selector);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className = 'secondary') {
  const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node;
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
  let camera = null, picked = null, areaSelection = null, ready = false, applying = false;
  const resultMetadata = {}, requestSettings = {}, activeRequests = {};
  // Older cached viewer shells used only `.panel-body`. Supporting that shell
  // prevents a newly revalidated module from stopping the entire renderer
  // before the user gets a chance to reload.
  const root = $('#explorer-panel-body') || $('.panel-body');
  if (!root) {
    console.warn('Explorer experience controls unavailable: panel body is missing.');
    return;
  }
  const workspace = el('details', undefined, 'scenario-workspace report-workspace');
  workspace.open = true;
  workspace.append(el('summary', 'Climate report'));
  const summary = el('p', 'Create a readable report from the completed analyses in this session.', 'scenario-context');
  workspace.append(summary);
  const locationText = el('p', 'No area selected. Draw a square, then drag its corner handle to resize it.');
  workspace.append(locationText);
  const feedback = el('p', '', 'experience-feedback'); feedback.setAttribute('role', 'status');
  const actions = el('div', undefined, 'experience-actions');
  workspace.append(actions, feedback);
  ($('#menu-tools') || root).prepend(workspace);
  const notify = text => { feedback.textContent = text; };

  function capture() {
    dispatchEvent(new CustomEvent('climate-capture-view'));
    const controls = Object.fromEntries(CONTROL_IDS.map(id => [id, document.getElementById(id)?.value]));
    const modes = Object.fromEntries(Object.keys(MODES).map(name => [name, modeValue(name)]));
    return validateScenario({ version: 1, tool: activeTool(), controls, modes, camera, location: picked }, rulesFromDOM());
  }
  function refresh() {
    summary.textContent = 'Select a square, then create a report with fresh results and charts for that area.';
    selectAreaButton.textContent = areaSelection ? 'Draw another square' : 'Draw square area';
    locationText.textContent = areaSelection
      ? `Selected square: ${Math.round(areaSelection.size_m)} m × ${Math.round(areaSelection.size_m)} m. Drag the corner handle to resize, or drag inside to move; generating the report locks it while results are calculated.`
      : 'No area selected. Draw a square, then drag its corner handle to resize it.';
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
    if (node) node.textContent = `${metadata.label || 'Result received'} · ${timeLabel(metadata.receivedAt || new Date())}${metadata.requestId ? ` · Reference ${metadata.requestId}` : ''}. The result will be included in the HTML report.`;
  }

  for (const [tool, evidence] of Object.entries(EVIDENCE)) {
    if (tool === 'heat' || tool === 'walking' || tool === 'sun' || tool === 'viewshed' || tool === 'wind'
      || tool === 'traffic') continue;
    const panel = $(`#menu-${tool}`);
    if (!panel) continue;
    const card = el('section', undefined, 'evidence-card'); card.setAttribute('aria-label', `${tool} evidence`);
    card.append(el('p', evidence.status, 'evidence-badge'), el('p', evidence.limits, 'evidence-limit'));
    const result = el('p', 'No completed result recorded in this session.', 'evidence-result'); result.id = `evidence-result-${tool}`;
    const request = el('p', '', 'request-state'); request.id = `request-state-${tool}`; request.setAttribute('role', 'status');
    const details = el('details'); details.append(el('summary', 'Evidence & result detail'));
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
    const methodSection = panel.querySelector(':scope > .panel-method');
    if (methodSection) panel.insertBefore(card, methodSection);
    else panel.append(card);
  }

  const selectAreaButton = button('Draw square area', () => {
    if (!ready) return notify('Wait for the scene to finish loading.');
    dispatchEvent(new CustomEvent('climate-report-area-pick', { detail: { enabled: true } }));
    notify('Click and drag across the map to draw a square. Then pull its corner handle to resize it, or drag inside to move it. Press Esc to cancel drawing.');
  });
  const generateReportButton = el('button', 'Generate HTML report', 'primary');
  generateReportButton.type = 'button';
  actions.append(selectAreaButton, generateReportButton);
  function reportEvidence() {
    return Object.fromEntries(Object.entries(resultMetadata).map(([tool, value]) => {
      const { settings, result_data: resultData, ...summary } = value;
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
        retention: 'Summary findings and proposal geometry/settings are included with this report; an exact rerun requires the matching app, heat-zone data, scene geometry and method version.',
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
        retention: 'Per-row observations, residuals, holdout results and the imported observation source are included with this report. Exact replay also needs matching wind, terrain, scene and code versions.',
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
          retention: 'Paired measurements, residuals and summary results are included with this report. The original CSV and referenced frames are included in an archive when available; replay still requires matching code and environment.',
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
      return [tool, { summary, reference, settings: settings || null,
        ...(resultData ? { result_data: resultData } : {}) }];
    }));
  }
  function areaDistribution(samples, title, unit, areaWeighted = false) {
    const valid = samples.filter(sample => Number.isFinite(Number(sample.value))
      && (!areaWeighted || Number(sample.area_m2) > 0));
    if (!valid.length) return null;
    const values = valid.map(sample => Number(sample.value));
    const minimum = Math.min(...values), maximum = Math.max(...values);
    const constant = maximum === minimum;
    const range = maximum - minimum;
    const binCount = constant ? 1 : Math.min(5, Math.max(1, valid.length));
    const bins = Array.from({ length: binCount }, (_, index) => ({
      lower: constant ? minimum : minimum + range * index / binCount,
      upper: constant ? maximum : minimum + range * (index + 1) / binCount,
      weight: 0,
    }));
    let totalWeight = 0;
    for (const sample of valid) {
      const weight = areaWeighted ? Number(sample.area_m2) : 1;
      const index = constant ? 0 : Math.min(binCount - 1, Math.floor((Number(sample.value) - minimum) / range * binCount));
      bins[index].weight += weight;
      totalWeight += weight;
    }
    const digits = unit === '°C' || unit === 'h' || unit === 'm/s' ? 1 : 0;
    const number = value => Number(value).toFixed(digits);
    return {
      type: 'distribution', title, unit,
      axis_label: areaWeighted ? 'Share of mapped area' : 'Share of sampled locations',
      bins: bins.map(bin => ({
        label: constant ? `${number(bin.lower)} ${unit}` : `${number(bin.lower)}–${number(bin.upper)} ${unit}`,
        share_pct: totalWeight ? bin.weight / totalWeight * 100 : 0,
        sample_count: valid.length,
      })),
    };
  }
  async function requestAreaZoneAnalysis(tool, bounds, requestId) {
    dispatchEvent(new CustomEvent('climate-report-area-progress', {
      detail: { requestId, tool, message: tool === 'heat' ? 'Measuring heat across the square…' : 'Calculating sunlight across the square…' },
    }));
    const apiBase = (new URLSearchParams(location.search).get('windApi') || '/api').replace(/\/$/, '');
    const date = tool === 'sun'
      ? $('#sun-analysis-date')?.value || $('#sun-date')?.value || '2026-01-15'
      : $('#heat-date')?.value || '2026-01-15';
    const minutes = Number($('#heat-time')?.value) || 720;
    const params = new URLSearchParams({
      metric: tool === 'sun' ? 'cumulative_sun_hours' : 'heat_model_lst_c',
      date, minutes: String(minutes),
      min_x: String(bounds.min_x), min_z: String(bounds.min_z),
      max_x: String(bounds.max_x), max_z: String(bounds.max_z),
    });
    if (tool === 'sun') {
      params.set('start_minutes', $('#sun-start-time')?.value || '480');
      params.set('end_minutes', $('#sun-end-time')?.value || '1080');
      params.set('step_minutes', $('#sun-step-time')?.value || '60');
    }
    const timeout = new AbortController();
    const timeoutId = setTimeout(() => timeout.abort(new DOMException('Area analysis timed out.', 'TimeoutError')), 5 * 60 * 1000);
    try {
      const response = await fetch(`${apiBase}/heat/zones?${params}`, { signal: timeout.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `${tool} data request failed (${response.status}).`);
      const samples = (payload.features || []).map(feature => ({
        value: Number(feature.value), area_m2: Number(feature.area_m2),
        surface_type: feature.surface_type || null, nearest_road_name: feature.nearest_road_name || null,
        geometry: feature.geometry || null,
      })).filter(sample => Number.isFinite(sample.value) && sample.area_m2 > 0);
      const totalArea = samples.reduce((sum, sample) => sum + sample.area_m2, 0);
      if (!samples.length || !totalArea) throw new Error(`No ${tool} source data overlaps the selected square.`);
      const mean = Number(payload.summary?.area_weighted_mean);
      const maximum = Number(payload.summary?.maximum);
      const average = Number.isFinite(mean) ? mean : samples.reduce((sum, sample) => sum + sample.value * sample.area_m2, 0) / totalArea;
      const peak = Number.isFinite(maximum) ? maximum : Math.max(...samples.map(sample => sample.value));
      const unit = tool === 'heat' ? '°C' : 'h';
      const chart = areaDistribution(samples, tool === 'heat' ? 'Surface temperature in the selected area' : 'Direct sunlight in the selected area', unit, true);
      const kpis = tool === 'heat' ? {
        average_surface_temperature_c: average, highest_surface_temperature_c: peak,
        mapped_area_m2: totalArea, mapped_zone_count: samples.length,
        area_above_hotspot_threshold_pct: (() => {
          const ordered = [...samples].sort((a, b) => a.value - b.value);
          const threshold = ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * 0.9))]?.value;
          return threshold === undefined ? null : samples.reduce((area, sample) => area + (sample.value >= threshold ? sample.area_m2 : 0), 0) / totalArea * 100;
        })(),
      } : {
        average_direct_sun_hours: average, highest_direct_sun_hours: peak,
        mapped_area_m2: totalArea, mapped_zone_count: samples.length,
      };
      return {
        status: 'ready',
        summary: {
          description: tool === 'heat'
            ? `Average mapped surface temperature in the square is ${average.toFixed(1)} °C.`
            : `The square receives an area-weighted average of ${average.toFixed(1)} hours of direct sunlight during the selected study window.`,
          kpis, scenario: { date, ...(tool === 'sun' ? {
            start_minutes: Number(params.get('start_minutes')), end_minutes: Number(params.get('end_minutes')),
            step_minutes: Number(params.get('step_minutes')),
          } : { time: minutes }) },
          source: payload.source, period: payload.window?.label || null,
          validation_status: tool === 'heat' ? 'satellite_surface_heat_screening' : 'clear_sky_direct_sun_model',
        },
        chart,
        samples,
        method: tool === 'heat'
          ? 'Area-weighted mapped surface-temperature screen, clipped to this square. Surface temperature is not air temperature or outdoor comfort.'
          : 'Area-weighted direct-sun duration from the mapped surface-temperature zone geometry, clipped to this square. Clouds, diffuse light and reflected light are not included.',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
  function requestRendererAreaAnalysis(bounds, requestId, onProgress) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        removeEventListener('climate-report-area-analysis-result', onResult);
        removeEventListener('climate-report-area-progress', onProgress);
        reject(new Error('Wind comfort and visibility analysis timed out.'));
      }, 45 * 60 * 1000);
      const onResult = event => {
        if (event.detail?.requestId !== requestId) return;
        clearTimeout(timeoutId);
        removeEventListener('climate-report-area-analysis-result', onResult);
        removeEventListener('climate-report-area-progress', onProgress);
        resolve(event.detail.results || {});
      };
      addEventListener('climate-report-area-analysis-result', onResult);
      addEventListener('climate-report-area-progress', onProgress);
      dispatchEvent(new CustomEvent('climate-report-area-analysis-request', { detail: { requestId, bounds } }));
    });
  }
  function captureMapImage() {
    const canvas = $('#scene');
    if (!canvas) return { status: 'unavailable', reason: 'Scene canvas is missing.' };
    try {
      let sourceLeft = 0, sourceTop = 0, sourceWidth = canvas.width, sourceHeight = canvas.height;
      const viewport = canvas.getBoundingClientRect();
      const panel = document.querySelector('.panel');
      const panelRect = panel?.getBoundingClientRect();
      if (panelRect && getComputedStyle(panel).display !== 'none') {
        const verticalOverlap = Math.min(viewport.bottom, panelRect.bottom) - Math.max(viewport.top, panelRect.top);
        const horizontalOverlap = Math.min(viewport.right, panelRect.right) - Math.max(viewport.left, panelRect.left);
        if (verticalOverlap > viewport.height * 0.6 && panelRect.left >= (viewport.left + viewport.right) / 2
          && panelRect.right >= viewport.right - 4) {
          sourceWidth = Math.round(canvas.width * (panelRect.left - viewport.left) / viewport.width);
        } else if (verticalOverlap > viewport.height * 0.6 && panelRect.right <= (viewport.left + viewport.right) / 2
          && panelRect.left <= viewport.left + 4) {
          const croppedWidth = Math.round(canvas.width * (panelRect.right - viewport.left) / viewport.width);
          sourceLeft = croppedWidth; sourceWidth -= croppedWidth;
        } else if (horizontalOverlap > viewport.width * 0.6 && panelRect.top >= (viewport.top + viewport.bottom) / 2
          && panelRect.bottom >= viewport.bottom - 4) {
          sourceHeight = Math.round(canvas.height * (panelRect.top - viewport.top) / viewport.height);
        }
      }
      sourceWidth = Math.max(1, Math.min(canvas.width - sourceLeft, sourceWidth));
      sourceHeight = Math.max(1, Math.min(canvas.height - sourceTop, sourceHeight));
      const image = document.createElement('canvas');
      image.width = sourceWidth; image.height = sourceHeight;
      const context = image.getContext('2d');
      context.drawImage(canvas, sourceLeft, sourceTop, sourceWidth, sourceHeight, 0, 0, image.width, image.height);
      const overlay = $('#wind-overlay');
      if (overlay && overlay.width && getComputedStyle(overlay).visibility !== 'hidden' && getComputedStyle(overlay).display !== 'none') {
        context.globalAlpha = Number.parseFloat(getComputedStyle(overlay).opacity) || 1;
        const scaleX = overlay.width / canvas.width, scaleY = overlay.height / canvas.height;
        context.drawImage(overlay, sourceLeft * scaleX, sourceTop * scaleY, sourceWidth * scaleX, sourceHeight * scaleY,
          0, 0, image.width, image.height);
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
  function settleAreaResult(result, tool) {
    return result.status === 'fulfilled'
      ? result.value
      : { status: 'unavailable', message: result.reason?.message || `${tool} analysis is unavailable.` };
  }
  async function generateAreaReport() {
    if (!areaSelection) {
      notify('Draw a square on the map before generating the report.');
      return;
    }
    const bounds = {
      min_x: areaSelection.min_x, min_z: areaSelection.min_z,
      max_x: areaSelection.max_x, max_z: areaSelection.max_z,
      size_m: areaSelection.size_m, center: areaSelection.center,
    };
    const requestId = globalThis.crypto?.randomUUID?.() || `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const progressListener = event => {
      if (event.detail?.requestId === requestId && event.detail.message) notify(event.detail.message);
    };
    selectAreaButton.disabled = true;
    generateReportButton.disabled = true;
    dispatchEvent(new CustomEvent('climate-report-area-lock'));
    addEventListener('climate-report-area-progress', progressListener);
    notify('Starting heat, sunlight, viewshed and wind comfort analysis inside the selected square…');
    try {
      const [heatResult, sunResult, localResult] = await Promise.allSettled([
        requestAreaZoneAnalysis('heat', bounds, requestId),
        requestAreaZoneAnalysis('sun', bounds, requestId),
        requestRendererAreaAnalysis(bounds, requestId, progressListener),
      ]);
      const local = settleAreaResult(localResult, 'map-based');
      const areaResults = {
        heat: settleAreaResult(heatResult, 'heat'),
        sun: settleAreaResult(sunResult, 'sunlight'),
        viewshed: local.viewshed || { status: 'unavailable', message: 'Viewshed did not return an area result.' },
        wind: local.wind || { status: 'unavailable', message: 'Wind did not return an area result.' },
      };
      if (areaResults.wind.status === 'ready') {
        const wind = areaResults.wind;
        wind.chart = areaDistribution(
          (wind.speed_values_mps || []).map(value => ({ value: value * 3.6, area_m2: 1 })),
          'Typical pedestrian wind speed inside the selected square', 'km/h', false,
        );
        wind.summary = {
          description: wind.description,
          kpis: wind.kpis,
          scenario: { season: wind.season, height_m: wind.height_m, comfort_standard: wind.comfort_standard, direction_count: wind.direction_count },
          validation_status: wind.validation_status,
        };
        delete wind.speed_values_mps;
      }
      if (areaResults.viewshed.status === 'ready') {
        const viewshed = areaResults.viewshed;
        viewshed.chart = {
          type: 'share', title: 'Visible and screened ground in the selected area',
          segments: [
            { label: 'Visible', value: viewshed.kpis.visible_ground_pct, color: '#23875e' },
            { label: 'Screened', value: viewshed.kpis.hidden_ground_pct, color: '#cb6658' },
          ],
        };
        viewshed.summary = {
          description: viewshed.description,
          kpis: viewshed.kpis,
          scenario: { observer: viewshed.observer_label, shape: 'Full 360° view' },
        };
      }
      const report = {
        schema: 'conditions-climate-report/1', generatedAt: new Date().toISOString(),
        application: { origin: location.origin },
        project: { name: 'Climate area report', location: 'Cape Town CBD, South Africa' },
        studyArea: {
          bounds: { min_x: bounds.min_x, min_z: bounds.min_z, max_x: bounds.max_x, max_z: bounds.max_z },
          size_m: bounds.size_m, area_m2: bounds.size_m * bounds.size_m,
        },
        areaAnalysis: {
          size_m: bounds.size_m,
          area_m2: bounds.size_m * bounds.size_m,
          results: areaResults,
        },
        results: reportEvidence(), evidence: EVIDENCE, map: captureMapImage(),
        limitations: 'The maps and charts summarize data sampled or clipped inside the selected square. Heat is mapped surface temperature, not air temperature. Wind comfort is an exploratory screen using seasonal patterns and mapped terrain and buildings; it is not measured or certified street-level evidence. Viewshed visibility is measured from an open point near the square centre. Read each topic’s method and limits before using the results.',
      };
      downloadBlob('conditions-climate-report.html', buildClimateReportHtml(report), 'text/html');
      const unavailable = Object.entries(areaResults).filter(([, result]) => result.status !== 'ready').map(([tool]) => tool);
      const directionalWindFallback = areaResults.wind.status === 'ready' && areaResults.wind.result_source === 'single-direction-fallback';
      notify(unavailable.length
        ? `HTML report generated. Some area analyses were unavailable: ${unavailable.join(', ')}.`
        : directionalWindFallback
          ? 'HTML report generated. The full wind comfort study could not finish, so the wind map uses one solved direction.'
          : 'HTML report generated with fresh charts and findings for the selected square.');
    } catch (error) {
      notify(`Could not generate the area report (${error.message || 'analysis failed'}).`);
    } finally {
      removeEventListener('climate-report-area-progress', progressListener);
      dispatchEvent(new CustomEvent('climate-report-area-unlock'));
      selectAreaButton.disabled = false;
      generateReportButton.disabled = false;
    }
  }
  generateReportButton.addEventListener('click', generateAreaReport);

  const hints = {
    'wind-stability': 'Screening atmospheric profile. The existing CFD cases use neutral inlet assumptions.',
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
    if (!event.target.closest('[data-sun-mode], [data-wind-lens], [data-wind-direction]')) return;
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
  addEventListener('climate-scene-state', event => { camera = event.detail.camera; });
  addEventListener('climate-streetview-point', event => {
    const location = validateScenario({ version: 1, tool: activeTool(), location: event.detail }, {}).location;
    if (location) { picked = location; refresh(); notify('Mapped location selected for the report.'); }
  });
  addEventListener('climate-report-area-selected', event => {
    const bounds = event.detail || {};
    const operation = bounds.operation || 'draw';
    const width = Number(bounds.max_x) - Number(bounds.min_x);
    const depth = Number(bounds.max_z) - Number(bounds.min_z);
    if (![bounds.min_x, bounds.min_z, bounds.max_x, bounds.max_z].every(value => Number.isFinite(Number(value)))
      || width < 99 || depth < 99 || Math.abs(width - depth) > 1) {
      notify('That square could not be read. Draw it again on mapped ground.');
      return;
    }
    areaSelection = {
      min_x: Number(bounds.min_x), min_z: Number(bounds.min_z),
      max_x: Number(bounds.max_x), max_z: Number(bounds.max_z),
      size_m: (width + depth) / 2,
      center: bounds.center && Number.isFinite(bounds.center.x) && Number.isFinite(bounds.center.z)
        ? { x: Number(bounds.center.x), z: Number(bounds.center.z) }
        : { x: (Number(bounds.min_x) + Number(bounds.max_x)) / 2, z: (Number(bounds.min_z) + Number(bounds.max_z)) / 2 },
    };
    refresh();
    notify(`${operation === 'draw' ? 'Square selected' : 'Square updated'} · ${Math.round(areaSelection.size_m)} m on each side.`);
  });
  addEventListener('climate-report-area-pick-cancelled', event => {
    if (event.detail?.reason === 'drag-too-short') notify('Drag across the map to draw a square at least 100 m wide.');
    else if (event.detail?.reason === 'escape') notify('Area selection cancelled.');
    else if (event.detail?.reason === 'pointer-cancelled') notify('Area selection interrupted. Draw the square again.');
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
    const speeds = (field.speed || []).filter((speed, index) => {
      const valid = !field.valid || Boolean(field.valid[index]);
      return valid && Number.isFinite(Number(speed)) && Number(speed) >= 0;
    }).map(Number);
    const sortedSpeeds = [...speeds].sort((a, b) => a - b);
    const meanSpeed = speeds.length ? speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length : null;
    const categoryShares = {};
    if (field.comfort_category && field.comfort_categories?.length) {
      const counts = new Map();
      for (let index = 0; index < field.comfort_category.length; index += 1) {
        if (field.valid && !field.valid[index]) continue;
        const code = Number(field.comfort_category[index]);
        counts.set(code, (counts.get(code) || 0) + 1);
      }
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      for (const category of field.comfort_categories) {
        const name = category.label || `Class ${category.code}`;
        categoryShares[name] = total ? (counts.get(Number(category.code)) || 0) / total * 100 : 0;
      }
    }
    const comfortMode = field.analysis_mode === 'comfort';
    const direction = Number.isFinite(Number(field.direction_deg)) ? `${Math.round(Number(field.direction_deg))}°` : '';
    const coverage = Number(field.coverage_fraction ?? field.coverage);
    const description = comfortMode
      ? `${field.comfort_standard || 'Wind comfort screen'} · ${field.season || 'selected season'}; ${(Number.isFinite(coverage) ? coverage * 100 : 0).toFixed(1)}% of seasonal wind hours are represented by solved directions.`
      : `Steady pedestrian wind from ${direction || 'the selected direction'} · ${meanSpeed === null ? 'mean speed not available' : `${meanSpeed.toFixed(1)} m/s average`} at ${Number(field.height_m || 1.5).toFixed(1)} m above ground.`;
    record('wind', {
      receivedAt: new Date().toISOString(), label: 'Wind result ready', description,
      analysis_mode: field.analysis_mode || 'direction', comfort_standard: field.comfort_standard,
      model_kind: field.model_kind, validation_status: field.validation_status || field.validation,
      coverage_fraction: Number.isFinite(coverage) ? coverage : null,
      forcing_coverage: field.forcing_coverage || null,
      version: field.version, direction_deg: field.direction_deg, height_m: field.height_m,
      season: field.season, stability: field.stability, direction_count: field.direction_count,
      kpis: {
        mean_speed_mps: meanSpeed,
        p95_speed_mps: sortedSpeeds.length ? sortedSpeeds[Math.floor((sortedSpeeds.length - 1) * 0.95)] : null,
        maximum_speed_mps: sortedSpeeds.length ? sortedSpeeds.at(-1) : null,
        valid_cell_count: speeds.length,
        grid_coverage_pct: field.valid?.length ? speeds.length / field.valid.length * 100 : null,
        comfort_class_share_pct: Object.keys(categoryShares).length ? categoryShares : null,
      },
    });
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
  });
  refresh();
}
