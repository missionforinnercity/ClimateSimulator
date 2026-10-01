import { scopedFetch as fetch, cancelRequests } from './requestClient.js';

const API = (new URLSearchParams(location.search).get('windApi') || '/api').replace(/\/$/, '');
const ROUTE_LABELS = {
  fastest: 'Fastest',
  least_sun: 'Least direct sun',
  lowest_heat: 'Lowest modelled heat load',
};
const COLORS = { fastest: '#b99cff', least_sun: '#42d8cf', lowest_heat: '#ff8465' };
const localDateTime = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value || '00';
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: clock };
};
const number = (value, digits = 1, suffix = '') => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? `${Number(value).toLocaleString('en-ZA', { maximumFractionDigits: digits, minimumFractionDigits: digits })}${suffix}` : 'Unavailable';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const coverageText = (percent, metric) => percent !== null && percent !== undefined && percent !== '' && Number.isFinite(Number(percent))
  ? `${metric} coverage ${number(percent, 0, '%')}` : `${metric} unavailable`;
const finite = value => value === null || value === undefined || value === '' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const difference = (value, baseline, unit) => {
  const current = finite(value);
  const reference = finite(baseline);
  if (current === null || reference === null) return '';
  const delta = current - reference;
  return `${delta > 0 ? '+' : ''}${number(delta, 1, ` ${unit}`)}`;
};

function routeCard(route, activeId, fastest, scales) {
  const m = route.metrics || {};
  const a = route.agent_summary || {};
  const selected = route.id === activeId;
  const agentReady = Number(a.count) > 0;
  const heat = a.heat_load_degree_minutes_p50 == null ? 'No walker UTCI result'
    : `${number(a.heat_load_degree_minutes_p50, 0)} °C·min median · P90 ${number(a.heat_load_degree_minutes_p90, 0)}`;
  const streetNames = route.street_names?.length ? route.street_names.slice(0, 5).join(', ') : 'Street names unavailable';
  return `<button class="walking-route-card${selected ? ' selected' : ''}" type="button" data-walking-route="${escape(route.id)}" aria-pressed="${selected}" style="--route-color:${COLORS[route.id] || '#ddd'}">
    <span class="walking-route-title"><i></i><b>${escape(ROUTE_LABELS[route.id] || route.label)}</b><span>${number(m.distance_m, 0, ' m')}</span></span>
    <span class="walking-route-kpis"><span><b>${number(m.estimated_walking_minutes, 1)}</b><small>minutes walking</small></span><span><b>${number(m.direct_sun_minutes, 1)}</b><small>minutes in sun</small></span><span><b>${number(m.heat_load_degree_minutes, 0)}</b><small>°C·min above 26°C</small></span></span>
    <span class="walking-route-detail">${route.id === 'fastest' ? 'Baseline for walking time and exposure' : `${escape(difference(m.estimated_walking_minutes, fastest?.metrics?.estimated_walking_minutes, 'min'))} walking · ${escape(difference(m.direct_sun_minutes, fastest?.metrics?.direct_sun_minutes, 'min'))} direct sun vs fastest`}</span>
    ${agentReady ? `<span class="walking-distribution"><span>Matched walkers · sun P50 ${number(a.direct_sun_minutes_p50, 1)} / P90 ${number(a.direct_sun_minutes_p90, 1)} min</span><i style="--bar:${Math.min(100, 100 * (finite(a.direct_sun_minutes_p90) || 0) / scales.sun).toFixed(1)}%;--median:${Math.min(100, 100 * (finite(a.direct_sun_minutes_p50) || 0) / scales.sun).toFixed(1)}%;--route-color:${COLORS[route.id] || '#ddd'}"></i><span>${escape(heat)}</span>${a.heat_load_degree_minutes_p90 == null ? '' : `<i style="--bar:${Math.min(100, 100 * (finite(a.heat_load_degree_minutes_p90) || 0) / scales.heat).toFixed(1)}%;--median:${Math.min(100, 100 * (finite(a.heat_load_degree_minutes_p50) || 0) / scales.heat).toFixed(1)}%;--route-color:${COLORS[route.id] || '#ddd'}"></i>`}</span>` : '<span class="walking-route-agents">Matched walkers calculating in the background…</span>'}
    <span class="walking-route-detail">${m.mean_utci_c == null && m.mean_pedestrian_wind_mps == null ? 'UTCI and pedestrian wind unavailable for this departure' : `Mean UTCI ${number(m.mean_utci_c, 1, ' °C')} · Wind ${number(m.mean_pedestrian_wind_mps, 1, ' m/s')} · ${coverageText(m.thermal_coverage_percent, 'UTCI')} · ${coverageText(m.wind_coverage_percent, 'Wind')}`}</span>
    ${route.same_path_as?.length ? `<span class="walking-route-detail">Same mapped path as ${route.same_path_as.map(id => escape(ROUTE_LABELS[id] || id)).join(', ')} for this departure.</span>` : ''}
    <span class="walking-route-detail">${number(m.access_tag_unknown_percent, 0, '%')} uncertain pedestrian mapping · ${number(m.steps_distance_m, 0, ' m')} mapped steps · ${escape(streetNames)}</span>
  </button>`;
}

function traceSvg(trace, key, title, className, width = 280, height = 62) {
  const values = trace.map(row => finite(row[key]));
  const available = values.filter(value => value !== null);
  if (!available.length) return '<p class="walking-trace-empty">Unavailable for this departure.</p>';
  const low = Math.min(...available);
  const span = Math.max(1, Math.max(...available) - low);
  const runs = [];
  let points = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (points.length) runs.push(points);
      points = [];
    } else {
      points.push(`${(index / Math.max(1, values.length - 1) * width).toFixed(1)},${(height - 4 - (value - low) / span * (height - 10)).toFixed(1)}`);
    }
  });
  if (points.length) runs.push(points);
  const lines = runs.map(run => run.length > 1 ? `<polyline points="${run.join(' ')}"/>` : `<circle cx="${run[0].split(',')[0]}" cy="${run[0].split(',')[1]}" r="2"/>`).join('');
  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(title)}">${lines}<line class="walking-chart-cursor" data-replay-cursor x1="0" x2="0" y1="0" y2="${height}"/></svg>`;
}

function traceMarkup(route) {
  const trace = route?.agent_summary?.representative_trace || [];
  if (!trace.length) return '<p class="walking-trace-empty">Representative walker trace will appear when the matched cohort finishes.</p>';
  const hasHeat = trace.some(row => finite(row.cumulative_heat_load_degree_minutes) !== null);
  const title = hasHeat ? 'Cumulative heat load' : 'Cumulative direct sun';
  const winds = trace.map(row => finite(row.wind_1p5m_mps)).filter(value => value !== null);
  const utcis = trace.map(row => finite(row.utci_c)).filter(value => value !== null);
  const representative = route.agents?.find(agent => agent.agent_id === route.agent_summary.representative_agent_id);
  return `<div class="walking-trace"><div><b>Representative walker</b><button id="walking-replay" type="button">Play trip →</button></div><small>Agent ${Number(route.agent_summary.representative_agent_id) + 1} · ${title} · 18-second replay</small>${traceSvg(trace, hasHeat ? 'cumulative_heat_load_degree_minutes' : 'cumulative_direct_sun_minutes', `${title} along route`, 'walking-sun-trace')}<small>Trip progress → cumulative exposure</small><div><span>UTCI along route</span><span>${utcis.length ? `${number(Math.min(...utcis), 1)}–${number(Math.max(...utcis), 1)} °C` : 'Unavailable'}</span></div>${traceSvg(trace, 'utci_c', 'UTCI samples along route', 'walking-utci-trace')}<div><span>Pedestrian wind at samples</span><span>${number(representative?.mean_pedestrian_wind_mps, 2, ' m/s')} mean</span></div>${traceSvg(trace, 'wind_1p5m_mps', 'Pedestrian wind samples along route', 'walking-wind-trace')}<small>${winds.length ? `${number(Math.min(...winds), 2)}–${number(Math.max(...winds), 2)} m/s sampled` : 'Wind unavailable'}</small></div>`;
}

export function setupWalkingRoutes() {
  const panel = document.querySelector('#menu-walking');
  if (!panel || panel.dataset.ready) return;
  panel.dataset.ready = 'true';
  const dateInput = panel.querySelector('#walking-date');
  const timeInput = panel.querySelector('#walking-time');
  const status = panel.querySelector('#walking-status');
  const results = panel.querySelector('#walking-results');
  const find = panel.querySelector('#walking-find');
  const clear = panel.querySelector('#walking-clear');
  const trafficButton = panel.querySelector('#walking-traffic-run');
  const trafficStatus = panel.querySelector('#walking-traffic-status');
  const endpoints = { origin: null, destination: null };
  const defaults = localDateTime();
  dateInput.value = defaults.date;
  timeInput.value = defaults.time;
  let routePayload = null;
  let activeRoute = 'fastest';
  let picking = null;
  let requestToken = 0;
  let replayFrame = 0;
  let replayStart = 0;
  let trafficToken = 0;
  const stopReplay = () => {
    if (replayFrame) cancelAnimationFrame(replayFrame);
    replayFrame = 0;
    replayStart = 0;
    dispatchEvent(new CustomEvent('climate-walking-progress', { detail: { point: null } }));
  };
  const invalidateResult = message => {
    requestToken += 1;
    trafficToken += 1;
    cancelRequests('walking');
    stopReplay();
    routePayload = null;
    results.replaceChildren();
    results.hidden = true;
    trafficButton.disabled = true;
    trafficStatus.textContent = 'Available after route comparison.';
    status.textContent = message;
    dispatchEvent(new CustomEvent('climate-walking-routes-clear'));
    refreshEndpoints();
  };
  for (const control of [dateInput, timeInput]) {
    for (const eventName of ['input', 'change']) {
      control.addEventListener(eventName, () => invalidateResult('Departure changed. Compare routes for the selected time.'));
    }
  }

  const refreshEndpoints = () => {
    for (const key of Object.keys(endpoints)) {
      const point = endpoints[key];
      const label = document.querySelector(`#walking-${key}-label`);
      const button = document.querySelector(`#walking-pick-${key}`);
      label.textContent = point ? `${point.x.toFixed(1)} m east · ${point.z.toFixed(1)} m south` : 'Not set';
      button.classList.toggle('active', picking === key);
      button.textContent = picking === key ? 'Cancel' : 'Pick';
    }
    find.disabled = !endpoints.origin || !endpoints.destination || Boolean(picking);
    dispatchEvent(new CustomEvent('climate-walking-points', { detail: { ...endpoints } }));
  };
  const startPick = key => {
    picking = picking === key ? null : key;
    refreshEndpoints();
    status.textContent = picking ? `Click the map to set the ${picking}.` : 'Map pick cancelled.';
    dispatchEvent(new CustomEvent('climate-route-pick-request', { detail: { role: picking } }));
  };
  panel.querySelector('#walking-pick-origin').addEventListener('click', () => startPick('origin'));
  panel.querySelector('#walking-pick-destination').addEventListener('click', () => startPick('destination'));
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !picking) return;
    picking = null;
    dispatchEvent(new CustomEvent('climate-route-pick-request', { detail: { role: null } }));
    status.textContent = 'Map pick cancelled.';
    refreshEndpoints();
  });
  addEventListener('climate-route-point', event => {
    if (!picking) return;
    const { x, z } = event.detail || {};
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) return;
    endpoints[picking] = { x: Number(x), z: Number(z) };
    const role = picking;
    picking = null;
    invalidateResult(`${role === 'origin' ? 'Start' : 'Destination'} changed. Compare routes for these points.`);
    refreshEndpoints();
  });
  find.addEventListener('click', async () => {
    if (!endpoints.origin || !endpoints.destination) return;
    invalidateResult('Building route alternatives and sampling shade, UTCI and wind…');
    const token = ++requestToken;
    find.disabled = true;
    trafficButton.disabled = true;
    const requestedDate = dateInput.value;
    const requestedTime = timeInput.value;
    try {
      const response = await fetch(`${API}/walking/routes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: endpoints.origin,
          destination: endpoints.destination,
          departure_at: `${requestedDate}T${requestedTime}:00`,
        }),
        timeoutMs: 180000,
      });
      const payload = await response.json();
      if (token !== requestToken) return;
      routePayload = payload;
      activeRoute = payload.routes?.some(route => route.id === 'fastest') ? 'fastest' : payload.routes?.[0]?.id;
      render(payload);
      dispatchEvent(new CustomEvent('climate-walking-routes', { detail: payload }));
      trafficButton.disabled = false;
      const start = payload.origin?.snap_distance_m;
      const finish = payload.destination?.snap_distance_m;
      const thermal = payload.conditions?.thermal;
      const coverage = thermal?.channel_coverage
        ? `UTCI ${number(thermal.channel_coverage.utci_c?.coverage_percent, 0, '%')}, wind ${number(thermal.channel_coverage.wind_1p5m_mps?.coverage_percent, 0, '%')} coverage`
        : `thermal coverage ${thermal?.status || 'unavailable'}`;
      status.textContent = `${payload.routes?.length || 0} route alternatives · snapped ${number(start, 0, ' m')} / ${number(finish, 0, ' m')} · ${coverage}. Walkers are calculating separately.`;
      trafficStatus.textContent = 'Optional synthetic road-emissions context; it does not change route scores.';
      if (payload.agent_job_id) void pollAgents(payload.agent_job_id, token);
      else status.textContent += ' Matched walker service is busy.';
    } catch (error) {
      if (token !== requestToken) return;
      status.textContent = error.detail || error.message || 'Route calculation failed.';
      results.hidden = true;
      dispatchEvent(new CustomEvent('climate-walking-routes-clear'));
    } finally {
      if (token === requestToken) refreshEndpoints();
    }
  });

  function render(payload) {
    const routes = payload.routes || [];
    const fastest = routes.find(route => route.id === 'fastest');
    const scales = {
      sun: Math.max(1, ...routes.map(route => finite(route.agent_summary?.direct_sun_minutes_p90) || 0)),
      heat: Math.max(1, ...routes.map(route => finite(route.agent_summary?.heat_load_degree_minutes_p90) || 0)),
    };
    const heatNotice = routes.some(route => route.id === 'lowest_heat') ? ''
      : '<div class="walking-network-provenance">Lowest-heat route unavailable: no usable UTCI forecast covers this departure window. Other route comparisons remain available.</div>';
    results.innerHTML = `${routes.map(route => routeCard(route, activeRoute, fastest, scales)).join('') || '<p>No connected pedestrian routes were found.</p>'}${heatNotice}
      <div class="walking-network-provenance">OSM network: ${Number(payload.network?.node_count || 0).toLocaleString()} nodes · ${Number(payload.network?.edge_count || 0).toLocaleString()} directed segments · matched walkers ${escape(payload.route_generation?.agent_status || 'pending')}.</div>
      ${traceMarkup(routes.find(route => route.id === activeRoute) || routes[0])}`;
    results.hidden = false;
    results.querySelectorAll('[data-walking-route]').forEach(button => button.addEventListener('click', () => {
      stopReplay();
      activeRoute = button.dataset.walkingRoute;
      render(routePayload);
      dispatchEvent(new CustomEvent('climate-walking-route-select', { detail: { routeId: activeRoute } }));
    }));
    results.querySelector('#walking-replay')?.addEventListener('click', startReplay);
  }

  async function pollAgents(jobId, token) {
    try {
      while (token === requestToken) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        if (token !== requestToken) return;
        const response = await fetch(`${API}/walking/agents/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 15000 });
        const job = await response.json();
        if (token !== requestToken || !routePayload) return;
        if (job.status === 'error') throw new Error(job.error || 'Agent calculation failed');
        if (job.status !== 'complete') continue;
        const byId = new Map((job.result?.routes || []).map(route => [route.id, route]));
        routePayload.routes = routePayload.routes.map(route => ({ ...route, ...(byId.get(route.id) || {}) }));
        routePayload.route_generation.agent_status = 'complete';
        routePayload.route_generation.agent_count_per_route = 100;
        routePayload.route_generation.sampled_agent_points = job.result?.sampled_agent_points;
        render(routePayload);
        status.textContent = `${routePayload.routes.length} route alternatives ready · 100 matched walkers per route. Select a route to replay one representative trip.`;
        return;
      }
    } catch (error) {
      if (token !== requestToken || !routePayload) return;
      routePayload.route_generation.agent_status = 'unavailable';
      render(routePayload);
      status.textContent = `Routes ready. Walker comparison unavailable: ${error.message}`;
    }
  }

  function startReplay() {
    if (replayFrame) { stopReplay(); render(routePayload); return; }
    const route = routePayload?.routes?.find(item => item.id === activeRoute);
    const trace = route?.agent_summary?.representative_trace || [];
    if (!trace.length) return;
    const button = results.querySelector('#walking-replay');
    if (button) button.textContent = 'Pause replay';
    replayStart = performance.now();
    const tick = now => {
      const fraction = Math.min(1, (now - replayStart) / 18000);
      const index = Math.min(trace.length - 1, Math.floor(fraction * trace.length));
      const sample = trace[index];
      const point = fraction >= 1 ? route.geometry?.at(-1) : [sample.x, sample.z];
      results.querySelectorAll('[data-replay-cursor]').forEach(line => {
        line.setAttribute('x1', String(280 * fraction));
        line.setAttribute('x2', String(280 * fraction));
      });
      dispatchEvent(new CustomEvent('climate-walking-progress', { detail: { routeId: activeRoute, point, progress: fraction } }));
      if (fraction < 1) replayFrame = requestAnimationFrame(tick);
      else { replayFrame = 0; if (button) button.textContent = 'Replay trip →'; }
    };
    replayFrame = requestAnimationFrame(tick);
  }

  clear.addEventListener('click', () => {
    invalidateResult('Pick a start and destination on the map.');
    endpoints.origin = null;
    endpoints.destination = null;
    picking = null;
    dispatchEvent(new CustomEvent('climate-route-pick-request', { detail: { role: null } }));
    dispatchEvent(new CustomEvent('climate-walking-clear'));
    refreshEndpoints();
  });

  trafficButton.addEventListener('click', async () => {
    if (!routePayload) return;
    const token = ++trafficToken;
    trafficButton.disabled = true;
    const hour = Number(routePayload.departure_at.slice(11, 13));
    const scenario = hour >= 6 && hour < 10 ? 'am_peak' : hour >= 10 && hour < 14 ? 'midday'
      : hour >= 14 && hour < 19 ? 'pm_peak' : 'evening';
    trafficStatus.textContent = `Starting the optional 5-minute ${scenario.replace('_', ' ')} citywide SUMO/HBEFA run…`;
    try {
      const startResponse = await fetch(`${API}/traffic/emissions-preview/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, duration_min: 5, demand_multiplier: 1, seed: 240917 }),
        timeoutMs: 15000,
      });
      const started = await startResponse.json();
      if (token !== trafficToken || !routePayload) return;
      const startedAt = Date.now();
      let job;
      do {
        await new Promise(resolve => setTimeout(resolve, 1100));
        const poll = await fetch(`${API}/traffic/emissions-preview/jobs/${encodeURIComponent(started.job_id)}`, { timeoutMs: 15000 });
        job = await poll.json();
        if (token !== trafficToken || !routePayload) return;
        if (job.status !== 'complete' && Date.now() - startedAt > 180000) throw new Error('Traffic context run timed out. Routes remain available.');
        if (job.status !== 'complete') trafficStatus.textContent = `Traffic context run ${job.status} · ${Number(job.elapsed_s || 0).toFixed(0)} s`;
      } while (job.status !== 'complete');
      const roads = job.result?.road_emissions || [];
      const byName = new Map();
      roads.forEach(road => {
        const name = String(road.road_name || '').trim();
        const key = name.toLocaleLowerCase();
        const aggregate = byName.get(key) || { road_name: name, nox_g: 0 };
        aggregate.nox_g += Number(road.nox_g || 0);
        byName.set(key, aggregate);
      });
      const used = new Set(routePayload.routes.flatMap(route => route.street_names || []).map(name => name.trim().toLocaleLowerCase()));
      const matched = [...used].map(name => byName.get(name)).filter(Boolean);
      const total = matched.reduce((sum, road) => sum + Number(road.nox_g || 0), 0);
      const names = matched.slice().sort((a, b) => Number(b.nox_g) - Number(a.nox_g)).slice(0, 6)
        .map(road => `${escape(road.road_name)} ${number(road.nox_g, 4, ' g NOx')}`).join(' · ');
      trafficStatus.textContent = matched.length
        ? `Whole-CBD ${scenario.replace('_', ' ')} model · ${number(total, 4, ' g NOx')} summed on ${matched.length} named route streets. ${names}. Road-source estimate only; not pedestrian concentration or dose.`
        : `Whole-CBD ${scenario.replace('_', ' ')} model completed, but no route street names matched its SUMO edges. This is not pedestrian concentration or dose.`;
    } catch (error) {
      if (token === trafficToken) trafficStatus.textContent = `Road-emissions context unavailable: ${error.message}. Route results remain available.`;
    } finally {
      trafficButton.disabled = token !== trafficToken || !routePayload;
    }
  });
  refreshEndpoints();
}
