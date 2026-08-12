let canvas = document.querySelector('#scene');
const windCanvas = document.querySelector('#wind-overlay');
const windContext = windCanvas.getContext('2d');
const status = document.querySelector('#status');

function setupMenuNavigation() {
  const tabs = [...document.querySelectorAll('[data-menu-target]')];
  const panels = [...document.querySelectorAll('[data-menu-panel]')];
  if (!tabs.length || !panels.length) return;

  const activate = (name, focus = false) => {
    tabs.forEach(tab => {
      const selected = tab.dataset.menuTarget === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    panels.forEach(panel => {
      const selected = panel.dataset.menuPanel === name;
      panel.classList.toggle('menu-active', selected);
      panel.hidden = !selected;
    });
    dispatchEvent(new CustomEvent('climate-menu-change', { detail: { name } }));
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab.dataset.menuTarget));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      activate(tabs[next].dataset.menuTarget, true);
    });
  });
  activate(tabs.find(tab => tab.classList.contains('active'))?.dataset.menuTarget || tabs[0].dataset.menuTarget);
}

function freshCanvas() {
  const replacement = canvas.cloneNode(false);
  canvas.replaceWith(replacement);
  canvas = replacement;
}

const startupLoader = document.querySelector('#startup-loader');
const startupProgress = document.querySelector('#startup-loader-progress');
const startupPercent = document.querySelector('#startup-loader-percent');
const startupStage = document.querySelector('#startup-loader-stage');
let startupValue = 8;
let startupTimer = null;
let startupFinishing = false;

function setStartupProgress(value, label) {
  startupValue = Math.max(startupValue, Math.min(100, Math.round(value)));
  startupLoader?.style.setProperty('--load-progress', `${startupValue}%`);
  startupProgress?.style.setProperty('--load-progress', `${startupValue}%`);
  startupProgress?.setAttribute('aria-valuenow', String(startupValue));
  if (startupPercent) startupPercent.textContent = `${startupValue}%`;
  if (label && startupStage) startupStage.textContent = label;
}

function startStartupProgress() {
  const startedAt = performance.now();
  setStartupProgress(12, 'Starting climate engine');
  startupTimer = window.setInterval(() => {
    const elapsed = performance.now() - startedAt;
    const next = Math.min(88, 12 + 76 * (1 - Math.exp(-elapsed / 2600)));
    const stage = elapsed < 900 ? 'Loading city geometry'
      : elapsed < 2400 ? 'Preparing simulation layers'
        : 'Calibrating 3D environment';
    setStartupProgress(next, stage);
  }, 180);
}

function finishStartupProgress(failed = false) {
  if (startupFinishing) return;
  startupFinishing = true;
  if (startupTimer) window.clearInterval(startupTimer);
  if (failed) {
    setStartupProgress(100, 'Viewer unavailable');
    document.body.removeAttribute('aria-busy');
    window.setTimeout(() => {
      startupLoader?.classList.add('is-complete');
      startupLoader?.setAttribute('aria-hidden', 'true');
    }, 240);
    return;
  }

  const initialValue = startupValue;
  const duration = Math.max(900, (100 - initialValue) * 16);
  const startedAt = performance.now();
  startupLoader?.classList.add('is-finishing');
  if (startupStage) startupStage.textContent = 'Finalising climate model';

  const completeFill = now => {
    const elapsed = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - elapsed, 3);
    setStartupProgress(initialValue + (100 - initialValue) * eased);
    if (elapsed < 1) {
      requestAnimationFrame(completeFill);
      return;
    }
    setStartupProgress(100, 'Climate engine ready');
    document.body.removeAttribute('aria-busy');
    window.setTimeout(() => {
      startupLoader?.classList.add('is-complete');
      startupLoader?.setAttribute('aria-hidden', 'true');
    }, 450);
  };
  requestAnimationFrame(completeFill);
}

async function loadScene() {
  startStartupProgress();
  status.textContent = 'Loading scene…';
  const guide = document.querySelector('#wind-box-guide');
  if (guide) guide.hidden = false;
  try {
    setStartupProgress(20, 'Loading 3D renderer');
    const module = await import('./webglRenderer.js?v=52');
    setStartupProgress(30, 'Building Cape Town model');
    await module.startWebGLScene(canvas, status);
  } catch (webglError) {
    console.warn('WebGL renderer unavailable; loading Canvas fallback:', webglError);
    status.textContent = 'GPU renderer unavailable · loading compatibility view…';
    setStartupProgress(72, 'Switching to compatibility engine');
    freshCanvas();
    try {
      const module = await import('./sceneRenderer.js?v=60');
      await module.startScene(canvas, status);
    } catch (fallbackError) {
      console.error(fallbackError);
      status.textContent = `Viewer failed: ${fallbackError.message}`;
      finishStartupProgress(true);
      return;
    }
  }
  const currentGuide = document.querySelector('#wind-box-guide');
  if (currentGuide) currentGuide.hidden = true;
  windContext.clearRect(0, 0, windCanvas.width, windCanvas.height);
  setupCurrentConditions();
  setupStreetView();
  finishStartupProgress();
}

function weatherDescription(code) {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  return 'Thunderstorms';
}

function setupCurrentConditions() {
  const apply = document.querySelector('#current-apply');
  const refresh = document.querySelector('#current-refresh');
  const statusElement = document.querySelector('#current-status');
  const freshness = document.querySelector('#current-freshness');
  const metrics = document.querySelector('#current-metrics');
  if (!apply || apply.dataset.ready) return;
  apply.dataset.ready = 'true';
  let latest = null;

  const renderWeather = payload => {
    latest = payload;
    freshness.textContent = payload.stale ? 'Stale' : 'Fresh';
    freshness.classList.toggle('stale', Boolean(payload.stale));
    const valid = new Date(payload.valid_at);
    statusElement.textContent = `${weatherDescription(payload.weather_code)} · valid ${Number.isNaN(valid.getTime()) ? payload.valid_at : valid.toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}`;
    metrics.hidden = false;
    metrics.innerHTML = `
      <span><b>${payload.temperature_2m_c.toFixed(1)}°C</b>Air</span>
      <span><b>${payload.apparent_temperature_c.toFixed(1)}°C</b>Feels like</span>
      <span><b>${payload.wind_speed_10m_mps.toFixed(1)} m/s</b>Wind · ${Math.round(payload.wind_direction_10m_deg)}°</span>
      <span><b>${Math.round(payload.relative_humidity_2m_pct)}%</b>Humidity</span>`;
  };
  const load = async force => {
    apply.disabled = true;
    refresh.disabled = true;
    statusElement.textContent = force ? 'Refreshing current conditions…' : 'Loading current conditions…';
    try {
      const response = await fetch(`/api/weather/current${force ? '?refresh=true' : ''}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || `HTTP ${response.status}`);
      }
      renderWeather(await response.json());
      return latest;
    } catch (error) {
      statusElement.textContent = `Current conditions unavailable (${error.message})`;
      return null;
    } finally {
      apply.disabled = false;
      refresh.disabled = false;
    }
  };
  apply.addEventListener('click', async () => {
    const payload = latest || await load(false);
    if (payload) dispatchEvent(new CustomEvent('climate-current-weather', { detail: payload }));
  });
  refresh.addEventListener('click', async () => {
    const payload = await load(true);
    if (payload) dispatchEvent(new CustomEvent('climate-current-weather', { detail: payload }));
  });
  load(false);
}

function setupStreetView() {
  const drop = document.querySelector('#streetview-drop');
  const clear = document.querySelector('#streetview-clear');
  const statusElement = document.querySelector('#streetview-status');
  const link = document.querySelector('#streetview-link');
  if (!drop || drop.dataset.ready) return;
  drop.dataset.ready = 'true';
  const query = new URLSearchParams(location.search);
  const api = query.get('windApi') || '/api';
  let placing = false;

  const setPlacing = enabled => {
    placing = enabled;
    drop.classList.toggle('active', enabled);
    drop.setAttribute('aria-pressed', String(enabled));
    drop.textContent = enabled ? 'Cancel pin' : 'Drop pin';
    statusElement.textContent = enabled
      ? 'Click the terrain where you want the Street View link.'
      : (link.hidden ? 'Drop a pin on the terrain to create a Street View link.' : statusElement.textContent);
    dispatchEvent(new CustomEvent('climate-streetview-mode', { detail: { enabled } }));
  };

  drop.addEventListener('click', () => setPlacing(!placing));
  clear.addEventListener('click', () => {
    setPlacing(false);
    link.hidden = true;
    link.removeAttribute('href');
    clear.disabled = true;
    statusElement.textContent = 'Drop a pin on the terrain to create a Street View link.';
    dispatchEvent(new CustomEvent('climate-streetview-clear'));
  });
  addEventListener('climate-streetview-point', async event => {
    const { x, z } = event.detail || {};
    setPlacing(false);
    clear.disabled = false;
    link.hidden = true;
    statusElement.textContent = 'Converting the selected scene point…';
    try {
      const response = await fetch(`${api}/location/streetview?x=${encodeURIComponent(x)}&z=${encodeURIComponent(z)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      link.href = payload.streetview_url;
      link.hidden = false;
      statusElement.textContent = `${payload.latitude.toFixed(6)}, ${payload.longitude.toFixed(6)}`;
    } catch (error) {
      statusElement.textContent = `Street View link unavailable (${error.message})`;
    }
  });
}

function windReportEscape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function windReportNumber(value, digits = 1, unit = '') {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${number.toLocaleString('en-ZA', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit}`
    : '—';
}

function windReportQuantile(values, probability) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

function windReportColor(value, minimum, maximum) {
  const stops = [[32, 85, 214], [34, 199, 238], [61, 213, 121], [244, 218, 69], [239, 59, 45]];
  const normalized = Math.max(0, Math.min(1, (value - minimum) / Math.max(maximum - minimum, 0.001)));
  const position = normalized * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const mix = position - index;
  return `rgb(${stops[index].map((channel, channelIndex) => Math.round(channel + (stops[index + 1][channelIndex] - channel) * mix)).join(',')})`;
}

function windReportFieldMap(field) {
  const sourceColumns = field.width, sourceRows = field.height;
  const columns = Math.min(64, sourceColumns), rows = Math.min(48, sourceRows);
  const width = 820;
  const domainRatio = (sourceRows * field.dz) / Math.max(sourceColumns * field.dx, 1);
  const height = Math.round(Math.max(280, Math.min(500, width * domainRatio)));
  const values = field.speed || [];
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const cells = [];
  for (let targetRow = 0; targetRow < rows; targetRow += 1) {
    const rowStart = Math.floor(targetRow * sourceRows / rows);
    const rowEnd = Math.max(rowStart + 1, Math.floor((targetRow + 1) * sourceRows / rows));
    for (let targetColumn = 0; targetColumn < columns; targetColumn += 1) {
      const columnStart = Math.floor(targetColumn * sourceColumns / columns);
      const columnEnd = Math.max(columnStart + 1, Math.floor((targetColumn + 1) * sourceColumns / columns));
      let total = 0, count = 0;
      for (let row = rowStart; row < rowEnd; row += 1) {
        for (let column = columnStart; column < columnEnd; column += 1) {
          total += Number(values[row * sourceColumns + column]) || 0;
          count += 1;
        }
      }
      const speed = total / Math.max(count, 1);
      const x = targetColumn * width / columns, y = targetRow * height / rows;
      cells.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(width / columns + 0.35).toFixed(2)}" height="${(height / rows + 0.35).toFixed(2)}" fill="${windReportColor(speed, minimum, maximum)}"/>`);
    }
  }
  const bearing = Number(field.direction_deg) || 0;
  const angle = bearing * Math.PI / 180;
  const flowX = -Math.sin(angle), flowY = Math.cos(angle);
  const arrowStartX = width - 88 - flowX * 30, arrowStartY = 64 - flowY * 30;
  const arrowEndX = width - 88 + flowX * 30, arrowEndY = 64 + flowY * 30;
  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const x = index * width / 4, y = index * height / 4;
    return `<path d="M ${x} 0 V ${height} M 0 ${y} H ${width}" stroke="#ffffff" stroke-opacity=".12" stroke-width="1"/>`;
  }).join('');
  return `<div class="wind-report-field-map">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Pedestrian wind speed field">
      <rect width="${width}" height="${height}" fill="#12202a"/>
      ${cells.join('')}${gridLines}
      <g stroke="#fff" fill="#fff" stroke-width="4" stroke-linecap="round">
        <line x1="${arrowStartX}" y1="${arrowStartY}" x2="${arrowEndX}" y2="${arrowEndY}" marker-end="url(#wind-arrow)"/>
        <defs><marker id="wind-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"/></marker></defs>
      </g>
      <text x="${width - 150}" y="115" fill="#fff" font-size="15" font-family="system-ui" font-weight="700">FROM ${Math.round(bearing)}°</text>
      <text x="18" y="28" fill="#fff" font-size="15" font-family="system-ui" font-weight="800">${windReportEscape(field.height_m)} m pedestrian wind</text>
      <text x="18" y="49" fill="#e1eef4" font-size="11" font-family="system-ui">${windReportEscape(field.width)} × ${windReportEscape(field.height)} cells · ${windReportNumber(field.dx, 1, ' m')} resolution</text>
      <text x="18" y="${height - 17}" fill="#fff" font-size="11" font-family="system-ui">N ↑ · viewer-local x east / z south</text>
    </svg>
    <div class="wind-report-map-meta">
      <span>${windReportNumber(minimum, 1, ' m/s')} <i class="wind-report-gradient"></i> ${windReportNumber(maximum, 1, ' m/s')}</span>
      <span>Cell colours show modelled mean speed</span>
    </div>
  </div>`;
}

function setupWindResults() {
  const results = document.querySelector('#wind-results');
  const reportButton = document.querySelector('#wind-report');
  const reportDialog = document.querySelector('#wind-report-dialog');
  const reportDocument = document.querySelector('#wind-report-document');
  const reportClose = document.querySelector('#wind-report-close');
  const reportPrint = document.querySelector('#wind-report-print');
  if (!results || results.dataset.ready) return;
  results.dataset.ready = 'true';
  let latestField = null;

  const invalidate = () => {
    results.hidden = true;
    latestField = null;
    if (reportButton) reportButton.disabled = true;
  };
  ['wind-direction', 'wind-season', 'wind-stability', 'wind-height', 'wind-exceedance-threshold', 'wind-forcing-mode', 'wind-speed', 'wind-size']
    .forEach(id => document.querySelector(`#${id}`)?.addEventListener('input', invalidate));
  addEventListener('climate-wind-result', event => {
    const field = event.detail;
    if (!field?.comfort_category || !field?.exceedance?.probability) {
      invalidate();
      return;
    }
    latestField = field;
    if (reportButton) reportButton.disabled = false;
    const counts = new Map();
    field.comfort_category.forEach(code => counts.set(code, (counts.get(code) || 0) + 1));
    const dominantCode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const category = field.comfort_categories.find(item => item.code === dominantCode);
    const probabilities = field.exceedance.probability;
    const meanExceedance = probabilities.reduce((sum, value) => sum + value, 0) / Math.max(1, probabilities.length);
    const speeds = field.speed || [];
    const meanSpeed = speeds.reduce((sum, value) => sum + value, 0) / Math.max(1, speeds.length);
    const relative = (field.uncertainty?.relative_fraction || 0) * 100;
    const forcingLabel = field.era5_profile
      ? `ERA5 ${field.era5_profile.sector.toUpperCase()} · ${(field.era5_profile.frequency_fraction * 100).toFixed(1)}% sampled group hours`
      : 'Manual mean forcing';
    results.innerHTML = `
      <span><b>${field.height_m.toFixed(1)} m</b>Result height</span>
      <span><b>${meanSpeed.toFixed(1)} m/s</b>Mean spatial speed</span>
      <span><b>${category?.label || '—'}</b>Most common comfort class</span>
      <span><b>${(meanExceedance * 100).toFixed(1)}%</b>Mean area exceedance · ${field.exceedance.threshold_mps} m/s</span>
      <span><b>±${relative.toFixed(0)}%</b>Screening uncertainty</span>
      <span><b>${forcingLabel}</b>Forcing source</span>
      <span><b>${field.analysis_mode.toUpperCase()}</b>${field.validation_status.replaceAll('_', ' ')}</span>`;
    results.hidden = false;
  });

  reportButton?.addEventListener('click', () => {
    if (!latestField || !reportDocument || !reportDialog) return;
    const field = latestField;
    const speeds = (field.speed || []).map(Number);
    const probabilities = (field.exceedance?.probability || []).map(Number);
    const totalCells = Math.max(field.comfort_category?.length || 0, 1);
    const comfort = field.comfort_categories.map(category => ({
      ...category,
      count: field.comfort_category.filter(code => code === category.code).length,
    })).map(category => ({ ...category, percentage: category.count / totalCells * 100 }));
    const dominant = comfort.slice().sort((a, b) => b.count - a.count)[0];
    const uncomfortable = comfort.filter(category => category.code === 5)[0]?.percentage || 0;
    const restricted = comfort.filter(category => category.code >= 4).reduce((sum, category) => sum + category.percentage, 0);
    const severity = uncomfortable > 10 ? 'poor' : uncomfortable > 1 || restricted > 20 ? 'caution' : 'good';
    const headline = severity === 'poor' ? 'Material pedestrian wind discomfort is indicated'
      : severity === 'caution' ? 'Local wind-comfort constraints require attention'
        : `The domain is predominantly suitable for ${dominant?.label?.toLowerCase() || 'pedestrian activity'}`;
    const meanSpeed = speeds.reduce((sum, value) => sum + value, 0) / Math.max(speeds.length, 1);
    const meanExceedance = probabilities.reduce((sum, value) => sum + value, 0) / Math.max(probabilities.length, 1);
    const exceedanceArea = probabilities.filter(value => value > 0.05).length / Math.max(probabilities.length, 1) * 100;
    const generated = new Intl.DateTimeFormat('en-ZA', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Johannesburg',
    }).format(new Date());
    const signature = `${field.version}|${field.direction_deg}|${field.season}|${field.height_m}|${field.origin?.join(',')}`;
    const hash = [...signature].reduce((value, character) => ((value * 31 + character.charCodeAt(0)) >>> 0), 2166136261);
    const reference = `WND-${hash.toString(16).toUpperCase().padStart(8, '0')}`;
    const comfortColors = ['#287f69', '#55aa70', '#a8c84c', '#e5bd3f', '#df8039', '#c7473f'];
    const comfortBar = comfort.map(item => `<i style="width:${item.percentage.toFixed(3)}%;background:${comfortColors[item.code]}"></i>`).join('');
    const comfortLegend = comfort.filter(item => item.percentage >= 0.05).map(item => `
      <span><i style="background:${comfortColors[item.code]}"></i><b>${windReportEscape(item.label)}</b> · ${item.percentage.toFixed(1)}%</span>`).join('');
    const era5 = field.era5_profile;
    const coverage = era5?.coverage;
    let sceneImage = '';
    try {
      const imageUrl = canvas?.toDataURL('image/jpeg', 0.9);
      if (imageUrl?.length > 2000) sceneImage = `<figure class="wind-report-scene"><img src="${imageUrl}" alt="Current 3D wind simulation view"><figcaption>Interactive scene at report generation time. The reproducible field map below is generated directly from the returned simulation grid.</figcaption></figure>`;
    } catch { /* A field-derived report remains available if canvas capture is restricted. */ }
    const uncertaintyDrivers = (field.uncertainty?.drivers || []).map(value => String(value).replaceAll('_', ' ')).join(' · ');
    reportDocument.innerHTML = `
      <header class="report-header">
        <div><p class="report-kicker">Cape Town CBD Climate Explorer</p><h1 id="wind-report-title">Pedestrian wind analysis report</h1></div>
        <div class="report-header-meta"><b>${reference}</b>Generated ${windReportEscape(generated)}<br>${windReportEscape(String(field.analysis_mode || 'preview').toUpperCase())} · screening assessment</div>
      </header>
      <section class="report-verdict ${severity}"><div><h2>${windReportEscape(headline)}</h2><p>${windReportNumber(uncomfortable, 1, '%')} of the analysed grid is classified as uncomfortable and ${windReportNumber(restricted, 1, '%')} is limited to business walking or worse. The most common category is ${windReportEscape(dominant?.label || 'unknown')}.</p></div></section>
      <section class="report-section"><div class="report-section-heading"><h2>Scenario definition</h2><span>Boundary conditions and domain</span></div><div class="report-scenario-grid">
        <div class="report-fact"><span>Wind direction</span><strong>${windReportEscape(field.direction_name?.replaceAll('_', ' ').toUpperCase() || '')} · from ${windReportNumber(field.direction_deg, 0, '°')}</strong></div>
        <div class="report-fact"><span>Season / stability</span><strong>${windReportEscape(field.season)} · ${windReportEscape(field.stability?.label || field.stability?.key)}</strong></div>
        <div class="report-fact"><span>Result height</span><strong>${windReportNumber(field.height_m, 1, ' m')} pedestrian layer</strong></div>
        <div class="report-fact"><span>Analysis domain</span><strong>${windReportNumber(field.width * field.dx, 0, ' m')} × ${windReportNumber(field.height * field.dz, 0, ' m')}</strong></div>
        <div class="report-fact"><span>Forcing</span><strong>${era5 ? `ERA5 ${windReportEscape(era5.sector.toUpperCase())} conditional profile` : 'Manual mean wind'}</strong></div>
        <div class="report-fact"><span>Reference wind</span><strong>${windReportNumber(field.reference_speed_mps, 2, ' m/s')} at ${windReportNumber(field.reference_height_m, 1, ' m')}</strong></div>
        <div class="report-fact"><span>Height profile</span><strong>Exponent ${windReportNumber(field.height_profile_exponent, 3)}</strong></div>
        <div class="report-fact"><span>Flow model</span><strong>${windReportEscape(String(field.model_kind).replaceAll('_', ' '))}</strong></div>
      </div></section>
      ${sceneImage ? `<section class="report-section"><div class="report-section-heading"><h2>Simulation view</h2><span>Visual context</span></div>${sceneImage}</section>` : ''}
      <section class="report-section"><div class="report-section-heading"><h2>Pedestrian wind field</h2><span>Mean speed at ${windReportNumber(field.height_m, 1, ' m')}</span></div>${windReportFieldMap(field)}</section>
      <section class="report-section"><div class="report-section-heading"><h2>Headline indicators</h2><span>Spatial summary</span></div><div class="report-stat-grid">
        <div class="report-stat"><span>Spatial mean speed</span><strong>${windReportNumber(meanSpeed, 2, ' m/s')}</strong><small>Across ${speeds.length.toLocaleString('en-ZA')} model cells</small></div>
        <div class="report-stat"><span>95th spatial speed</span><strong>${windReportNumber(windReportQuantile(speeds, .95), 2, ' m/s')}</strong><small>Upper spatial tail of mean wind</small></div>
        <div class="report-stat"><span>Maximum cell speed</span><strong>${windReportNumber(Math.max(...speeds), 2, ' m/s')}</strong><small>Modelled grid maximum</small></div>
        <div class="report-stat"><span>Mean threshold exceedance</span><strong>${windReportNumber(meanExceedance * 100, 1, '%')}</strong><small>Above ${windReportNumber(field.exceedance.threshold_mps, 1, ' m/s')}</small></div>
        <div class="report-stat"><span>Area over 5% exceedance</span><strong>${windReportNumber(exceedanceArea, 1, '%')}</strong><small>Share of analysis cells</small></div>
        <div class="report-stat"><span>Screening uncertainty</span><strong>±${windReportNumber((field.uncertainty?.relative_fraction || 0) * 100, 0, '%')}</strong><small>Epistemic interval</small></div>
      </div></section>
      <section class="report-section"><div class="report-section-heading"><h2>Wind-comfort classification</h2><span>${windReportEscape(field.comfort_standard)}</span></div>
        <div class="wind-comfort-bar" aria-label="Wind comfort category proportions">${comfortBar}</div><div class="wind-comfort-legend">${comfortLegend}</div>
      </section>
      <section class="report-section report-two-column">
        <div><div class="report-section-heading"><h2>ERA5 forcing evidence</h2><span>${era5 ? 'Selected sector profile' : 'Not used'}</span></div>${era5 ? `<ul class="report-list">
          <li><b>Profile sample</b><span>${windReportNumber(era5.sample_count, 0)} records</span></li><li><b>Mean direction</b><span>${windReportNumber(era5.mean_direction_deg, 1, '°')}</span></li>
          <li><b>95th wind speed</b><span>${windReportNumber(era5.p95_speed_mps, 2, ' m/s')}</span></li><li><b>95th gust</b><span>${windReportNumber(era5.p95_gust_mps, 2, ' m/s')}</span></li>
          <li><b>Weibull shape</b><span>${windReportNumber(era5.weibull_shape, 3)}</span></li><li><b>Sector frequency</b><span>${windReportNumber(era5.frequency_fraction * 100, 1, '%')}</span></li>
        </ul>` : '<div class="report-note">This scenario used a manually supplied mean wind speed.</div>'}</div>
        <div><div class="report-section-heading"><h2>Data quality</h2><span>Provenance and coverage</span></div><ul class="report-list">
          <li><b>Field version</b><span>${windReportEscape(field.version)}</span></li><li><b>Validation status</b><span>${windReportEscape(String(field.validation_status).replaceAll('_', ' '))}</span></li>
          <li><b>ERA5 temporal coverage</b><span>${coverage ? windReportNumber(coverage.hourly_coverage_fraction * 100, 1, '%') : 'Not applicable'}</span></li><li><b>ERA5 records</b><span>${coverage ? windReportNumber(coverage.records, 0) : '—'}</span></li>
          <li><b>Uncertainty drivers</b><span>${windReportEscape(uncertaintyDrivers || 'Not reported')}</span></li>
        </ul></div>
      </section>
      <section class="report-section"><div class="report-section-heading"><h2>Method and interpretation</h2><span>Read before decision-making</span></div><div class="report-two-column">
        <div class="report-note"><b>Method.</b> ERA5 or manual boundary forcing is adjusted to pedestrian height, then combined with the directional terrain field, building-resolved CBD field and available ventilation factors. Conditional exceedance uses the reported Weibull distribution. Comfort categories use five-percent-exceedance activity thresholds.</div>
        <div class="report-note"><b>Limitations.</b> This is a preview screening result, not certified CFD, wind-tunnel evidence or a local measurement. ERA5 is regional-scale; the current attached archive is temporally incomplete. Building wakes, turbulence and façade effects require independent OpenFOAM/WindNinja benchmarks and pedestrian anemometer validation.</div>
      </div></section>
      <footer class="report-footer">Cape Town CBD Climate Explorer · ${reference} · ${windReportEscape(field.crs)} · Analysis mode: ${windReportEscape(field.analysis_mode)} · Source layer: ${windReportEscape(field.source_layer || 'generated field')}</footer>`;
    reportDocument.scrollTop = 0;
    if (typeof reportDialog.showModal === 'function') reportDialog.showModal();
    else reportDialog.setAttribute('open', '');
  });
  reportClose?.addEventListener('click', () => reportDialog?.close());
  reportPrint?.addEventListener('click', () => {
    document.body.classList.add('printing-wind-report');
    try { window.print(); } finally { setTimeout(() => document.body.classList.remove('printing-wind-report'), 0); }
  });
  reportDialog?.addEventListener('click', event => {
    if (event.target === reportDialog) reportDialog.close();
  });
}

setupMenuNavigation();
setupWindResults();
freshCanvas();
loadScene();
