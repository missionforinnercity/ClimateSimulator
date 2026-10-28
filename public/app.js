import { setupExplorerExperience } from './explorerExperience.js?v=23';
import { setupWalkingRoutes } from './walkingRoutes.js?v=3';
import { scopedFetch as fetch } from './requestClient.js';

const canvas = document.querySelector('#scene');
const windCanvas = document.querySelector('#wind-overlay');
const windContext = windCanvas.getContext('2d');
const status = document.querySelector('#status');

function setupMenuNavigation() {
  const tabs = [...document.querySelectorAll('[data-menu-target]')];
  const panels = [...document.querySelectorAll('[data-menu-panel]')];
  const explorerPanel = document.querySelector('.panel');
  const panelToggle = document.querySelector('#panel-toggle');
  const sceneModeTitle = document.querySelector('#scene-mode-title');
  const sceneModeDetail = document.querySelector('#scene-mode-detail');
  const panelContextValue = document.querySelector('#panel-context-value');
  const panelBody = document.querySelector('#explorer-panel-body');
  if (!tabs.length || !panels.length) return;

  const toolLabels = { tools: 'CITY MODEL', heat: 'URBAN HEAT', walking: 'WALK ROUTES', sun: 'SUNLIGHT', viewshed: '3D VIEWSHED', wind: 'WIND FLOW', traffic: 'TRAFFIC', transport: 'TRANSIT' };
  const selectedLabel = selector => document.querySelector(`${selector} option:checked`)?.textContent.trim() || '';
  const inputValue = selector => document.querySelector(selector)?.value?.trim() || '';
  const textValue = selector => document.querySelector(selector)?.textContent.trim() || '';
  const updatePanelContext = name => {
    if (!panelContextValue) return;
    let context = 'City model · base layers';
    if (name === 'tools') {
      const visible = [...document.querySelectorAll('[data-layer]')].filter(input => input.checked).length;
      context = `City model · ${visible} map layers visible`;
    } else if (name === 'heat') {
      const metric = document.querySelector('#heat-metric');
      const metricLabel = metric?.selectedOptions[0]?.textContent.trim() || 'Heat view';
      let time = 'Source period';
      if (['utci_c', 'tmrt_c'].includes(metric?.value)) {
        const aggregate = inputValue('#heat-climate-aggregate');
        const climateScope = aggregate === 'month' ? textValue('#heat-climate-month-label')
          : aggregate === 'season' ? selectedLabel('#heat-climate-season') : 'All months';
        time = document.querySelector('#heat-period')?.value === 'climatology'
          ? `${selectedLabel('#heat-climate-aggregate')} · ${climateScope} · ${textValue('#heat-climate-hour-label') || '12:00'}`
          : textValue('#heat-forecast-label') || 'Near-live forecast';
      } else if (['pedestrian_priority_score', 'shade_deficit_score'].includes(metric?.value)) {
        time = `${inputValue('#heat-date')} · ${selectedLabel('#heat-time')}`;
      }
      context = `${metricLabel} · ${time}`;
    } else if (name === 'sun') {
      const mode = document.querySelector('[data-sun-mode].active')?.textContent.trim() || 'Shadows';
      const date = mode.toLowerCase().includes('hours') ? inputValue('#sun-analysis-date') : inputValue('#sun-date');
      const time = mode.toLowerCase().includes('hours')
        ? `${selectedLabel('#sun-start-time')}–${selectedLabel('#sun-end-time')}`
        : textValue('#sun-time-value') || '12:00';
      context = `${mode} · ${date} · ${time}`;
    } else if (name === 'wind') {
      const lens = document.querySelector('[data-wind-lens].active')?.textContent.trim() || 'Direction';
      const direction = selectedLabel('#wind-direction');
      const season = selectedLabel('#wind-season');
      const trafficPollution = document.querySelector('#pollution-source-type')?.value === 'traffic';
      context = lens.toLowerCase().includes('pollutant')
        ? (trafficPollution
          ? [lens, selectedLabel('#pollution-traffic-scenario'), selectedLabel('#pollution-class'), selectedLabel('#pollution-direction')].filter(Boolean).join(' · ')
          : [lens, selectedLabel('#pollution-class'), selectedLabel('#pollution-height'), selectedLabel('#pollution-direction')].filter(Boolean).join(' · '))
        : [lens, direction, season].filter(Boolean).join(' · ');
    } else if (name === 'traffic') {
      context = `${selectedLabel('#traffic-scenario') || 'Street simulation'} · ${selectedLabel('#traffic-demand') || 'Current demand'}`;
    } else if (name === 'transport') {
      context = `${selectedLabel('#transport-service-day') || 'Weekday'} · ${textValue('#transport-time-value') || 'Service timetable'}`;
    } else if (name === 'walking') {
      context = `Walking routes · ${inputValue('#walking-date') || 'Select date'} · ${inputValue('#walking-time') || 'Select time'}`;
    } else if (name === 'viewshed') {
      const shape = document.querySelector('#viewshed-shape')?.selectedOptions[0]?.textContent || '3D cone';
      const heading = inputValue('#viewshed-heading') || '0';
      context = `${shape} · ${heading}° heading · ${inputValue('#viewshed-radius') || 500} m range`;
    }
    panelContextValue.textContent = context;
  };

  let contextTimer = null;
  const schedulePanelContext = name => {
    window.clearTimeout(contextTimer);
    contextTimer = window.setTimeout(() => updatePanelContext(name), 120);
  };
  const updateSceneMode = name => {
    if (!sceneModeTitle || !sceneModeDetail) return;
    sceneModeTitle.textContent = toolLabels[name] || name.toUpperCase();
    updatePanelContext(name);
    if (name === 'tools') {
      sceneModeDetail.textContent = 'City layers · drag to orbit';
      return;
    }
    if (name === 'walking') {
      sceneModeDetail.textContent = 'Pedestrian routes · pick two map points';
      document.querySelector('.scene-mode')?.classList.add('is-active');
      return;
    }
    if (name === 'viewshed') {
      sceneModeDetail.textContent = 'Click terrain · map buildings + ridges block view';
      document.querySelector('.scene-mode')?.classList.add('is-active');
      return;
    }
    const toggle = document.querySelector(`#${name}-toggle`);
    const active = Boolean(toggle?.checked);
    let modeDetail = active ? 'Map layer active' : 'Map layer hidden';
    if (name === 'heat') modeDetail = `${document.querySelector('#heat-metric option:checked')?.textContent || 'Heat'} · ${active ? 'visible' : 'hidden'}`;
    if (name === 'sun') modeDetail = `Solar view · ${active ? 'visible' : 'hidden'}`;
    if (name === 'wind') modeDetail = `${document.querySelector('[data-wind-lens].active')?.textContent.trim() || 'Direction'} · ${active ? 'visible' : 'hidden'}`;
    if (name === 'traffic') modeDetail = `Street simulation · ${active ? 'visible' : 'hidden'}`;
    if (name === 'transport') modeDetail = `Bus + rail network · ${active ? 'visible' : 'hidden'}`;
    sceneModeDetail.textContent = modeDetail;
    document.querySelector('.scene-mode')?.classList.toggle('is-active', active);
  };

  const setPanelCollapsed = collapsed => {
    explorerPanel?.classList.toggle('panel-collapsed', collapsed);
    panelToggle?.setAttribute('aria-expanded', String(!collapsed));
    if (panelToggle) panelToggle.textContent = collapsed ? 'Show controls' : 'Map view';
  };

  panelToggle?.addEventListener('click', () => {
    setPanelCollapsed(!explorerPanel?.classList.contains('panel-collapsed'));
  });

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
    if (name === 'sun' || name === 'viewshed') {
      const editor = document.querySelector('#scenario-design-editor');
      const host = document.querySelector(`#${name}-scenario-editor-host`);
      if (editor && host && editor.parentElement !== host) host.append(editor);
    }
    document.querySelector('.scene-mode')?.classList.toggle('is-active', name === 'tools' || Boolean(document.querySelector(`#${name}-toggle`)?.checked));
    dispatchEvent(new CustomEvent('climate-menu-change', { detail: { name } }));
    // Panel listeners may enable or disable their visualization as they open.
    // Read the settled control state so the map badge describes what is
    // actually visible after those synchronous state changes.
    updateSceneMode(name);
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      setPanelCollapsed(false);
      activate(tab.dataset.menuTarget);
    });
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

  ['heat-toggle', 'sun-toggle', 'wind-toggle', 'traffic-toggle', 'transport-toggle', 'heat-metric'].forEach(id => {
    document.querySelector(`#${id}`)?.addEventListener('change', () => {
      const current = tabs.find(tab => tab.classList.contains('active'))?.dataset.menuTarget || 'tools';
      updateSceneMode(current);
      document.querySelector('.scene-mode')?.classList.toggle('is-active', current === 'tools' || Boolean(document.querySelector(`#${current}-toggle`)?.checked));
    });
  });
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', () => {
    document.querySelector(`[data-legend-layer="${input.dataset.layer}"]`)?.classList.toggle('is-hidden', !input.checked);
  }));
  panelBody?.addEventListener('input', () => {
    const current = tabs.find(tab => tab.classList.contains('active'))?.dataset.menuTarget || 'tools';
    schedulePanelContext(current);
  });
  panelBody?.addEventListener('change', () => {
    const current = tabs.find(tab => tab.classList.contains('active'))?.dataset.menuTarget || 'tools';
    schedulePanelContext(current);
  });
  const contextTextObserver = new MutationObserver(changes => {
    if (!changes.length) return;
    const current = tabs.find(tab => tab.classList.contains('active'))?.dataset.menuTarget || 'tools';
    updatePanelContext(current);
  });
  ['#heat-forecast-label', '#heat-climate-month-label', '#heat-climate-hour-label', '#sun-time-value', '#transport-time-value'].forEach(selector => {
    const node = document.querySelector(selector);
    if (node) contextTextObserver.observe(node, { childList: true, characterData: true, subtree: true });
  });
  document.querySelectorAll('[data-wind-lens]').forEach(button => button.addEventListener('click', () => {
    if (tabs.find(tab => tab.classList.contains('active'))?.dataset.menuTarget === 'wind') updateSceneMode('wind');
  }));
  const requested = new URLSearchParams(location.search).get('tool');
  const initial = tabs.some(tab => tab.dataset.menuTarget === requested)
    ? requested
    : tabs.find(tab => tab.classList.contains('active'))?.dataset.menuTarget || tabs[0].dataset.menuTarget;
  activate(initial);
}

function setupHeatViewSelector() {
  const metric = document.querySelector('#heat-metric');
  const period = document.querySelector('#heat-period');
  const wheel = document.querySelector('#heat-spin');
  const output = document.querySelector('#heat-spin-value');
  const groups = [...document.querySelectorAll('[data-heat-view-group]')];
  if (!metric || !wheel || !output) return;
  const options = {
    current: ['utci_c', 'tmrt_c'],
    history: ['utci_c', 'tmrt_c'],
    screening: ['heat_model_lst_c', 'pedestrian_priority_score', 'pedestrian_heat_exposure_c', 'shade_deficit_score', 'rooftop_temperature_c'],
  };
  const labels = Object.fromEntries([...metric.options].map(option => [option.value, option.textContent.trim()]));
  let activeGroup = metric.value.startsWith('utci') || metric.value === 'tmrt_c' ? 'current' : 'screening';
  let selectionTimer = null;
  const groupForMetric = value => options.screening.includes(value) ? 'screening'
    : period?.value === 'climatology' ? 'history' : 'current';
  const refresh = () => {
    output.textContent = labels[metric.value] || 'Heat view';
    groups.forEach(button => {
      const selected = button.dataset.heatViewGroup === activeGroup;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('active', selected);
    });
  };
  const selectMetric = value => {
    if (value === metric.value) return;
    metric.value = value;
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => metric.dispatchEvent(new Event('change', { bubbles: true })), 140);
  };
  groups.forEach(button => button.addEventListener('click', () => {
    activeGroup = button.dataset.heatViewGroup;
    let periodChanged = false;
    if (period && activeGroup !== 'screening') {
      const nextPeriod = activeGroup === 'history' ? 'climatology' : 'forecast';
      if (period.value !== nextPeriod) {
        period.value = nextPeriod;
        periodChanged = true;
      }
    }
    const allowed = options[activeGroup];
    if (!allowed.includes(metric.value)) selectMetric(allowed[0]);
    else if (periodChanged) period.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
  }));
  const spin = direction => {
    const allowed = options[activeGroup];
    const current = allowed.indexOf(metric.value);
    const next = current < 0 ? 0 : (current + direction + allowed.length) % allowed.length;
    wheel.classList.remove('is-spinning');
    requestAnimationFrame(() => wheel.classList.add('is-spinning'));
    selectMetric(allowed[next]);
    refresh();
  };
  wheel.addEventListener('click', () => spin(1));
  document.querySelector('#heat-spin-previous')?.addEventListener('click', () => spin(-1));
  document.querySelector('#heat-spin-next')?.addEventListener('click', () => spin(1));
  metric.addEventListener('change', () => {
    window.clearTimeout(selectionTimer);
    activeGroup = groupForMetric(metric.value);
    refresh();
  });
  period?.addEventListener('change', () => {
    if (activeGroup !== 'screening') activeGroup = period.value === 'climatology' ? 'history' : 'current';
    refresh();
  });
  refresh();
}

function setupFullscreenControls() {
  const enterButton = document.querySelector('#fullscreen-enter');
  const exitButton = document.querySelector('#fullscreen-exit');
  if (!enterButton || !exitButton) return;

  const supported = Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen);
  const syncControls = () => {
    const active = Boolean(document.fullscreenElement);
    enterButton.hidden = active;
    enterButton.setAttribute('aria-pressed', String(active));
    exitButton.hidden = !active;
  };

  let requestPending = false;
  let retryListening = false;
  const removeRetryListeners = () => {
    if (!retryListening) return;
    document.removeEventListener('pointerdown', retryOnInteraction, true);
    document.removeEventListener('keydown', retryOnInteraction, true);
    retryListening = false;
  };
  const installRetryListeners = () => {
    if (!supported || document.fullscreenElement || retryListening) return;
    document.addEventListener('pointerdown', retryOnInteraction, true);
    document.addEventListener('keydown', retryOnInteraction, true);
    retryListening = true;
  };
  const enterFullscreen = async () => {
    if (!supported || document.fullscreenElement || requestPending) return Boolean(document.fullscreenElement);

    requestPending = true;
    try {
      await document.documentElement.requestFullscreen();
      enterButton.removeAttribute('title');
      return true;
    } catch (error) {
      console.warn('Could not enter full screen:', error);
      enterButton.title = 'Click Full screen to enter; this browser requires a user interaction';
      return false;
    } finally {
      requestPending = false;
    }
  };
  const retryOnInteraction = (event) => {
    if (document.fullscreenElement) {
      removeRetryListeners();
      return;
    }
    if (event.type === 'keydown' && event.key === 'Escape') return;
    if (requestPending) return;
    if (event.target === enterButton || enterButton.contains(event.target)) {
      removeRetryListeners();
      return;
    }
    removeRetryListeners();
    void enterFullscreen().then(entered => {
      if (!entered && !document.fullscreenElement) installRetryListeners();
    });
  };

  if (!supported) {
    enterButton.disabled = true;
    enterButton.title = 'Full screen is not supported by this browser';
  }

  enterButton.addEventListener('click', enterFullscreen);

  exitButton.addEventListener('click', async () => {
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch (error) {
      console.warn('Could not exit full screen:', error);
    }
  });

  document.addEventListener('fullscreenchange', () => {
    syncControls();
    if (document.fullscreenElement) removeRetryListeners();
  });
  syncControls();

  if (supported && !document.fullscreenElement) {
    installRetryListeners();
    void enterFullscreen().then(entered => {
      if (entered) removeRetryListeners();
    });
  }
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
        : 'Preparing mapped geometry';
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
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
  const startedAt = performance.now();
  startupLoader?.classList.add('is-finishing');
  if (startupStage) startupStage.textContent = 'Finalising climate model';

  const completeFill = now => {
    const elapsed = duration === 0 ? 1 : Math.min(1, (now - startedAt) / duration);
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
    }, 80);
  };
  requestAnimationFrame(completeFill);
}

async function loadScene() {
  startStartupProgress();
  status.textContent = 'Loading scene…';
  const guide = document.querySelector('#wind-box-guide');
  if (guide) guide.hidden = false;
  try {
    if (!window.WebGL2RenderingContext) throw new Error('WebGL 2 is unavailable');
    setStartupProgress(20, 'Loading 3D renderer');
    const module = await import('./webglRenderer.js?v=306');
    setStartupProgress(30, 'Building Cape Town model');
    await module.startWebGLScene(canvas, status);
  } catch (error) {
    console.error('WebGL 2 viewer could not start:', error);
    if (guide) guide.hidden = true;
    status.setAttribute('role', 'alert');
    status.textContent = !window.WebGL2RenderingContext || /webgl.*context|webgl 2 is unavailable/i.test(String(error?.message ?? error))
      ? 'This viewer requires WebGL 2. Enable WebGL and hardware acceleration in your browser, or try a current browser that supports WebGL 2, then reload.'
      : 'The 3D viewer could not load. Check your connection and reload the page.';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = 'Reload viewer';
    retry.addEventListener('click', () => location.reload());
    status.after(retry);
    finishStartupProgress(true);
    return;
  }
  const currentGuide = document.querySelector('#wind-box-guide');
  if (currentGuide) currentGuide.hidden = true;
  windContext.clearRect(0, 0, windCanvas.width, windCanvas.height);
  setupCurrentConditions();
  setupStreetView();
  performance.mark('climate-viewer-ready');
  dispatchEvent(new CustomEvent('climate-viewer-ready'));
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
  const provenance = document.querySelector('#current-provenance');
  if (!apply || apply.dataset.ready) return;
  apply.dataset.ready = 'true';
  let latest = null;

  const renderWeather = payload => {
    latest = payload;
    freshness.textContent = payload.stale ? 'Stale' : 'Fresh';
    freshness.classList.toggle('stale', Boolean(payload.stale));
    const valid = new Date(payload.valid_at);
    const stationObserved = Boolean(payload.station_observation);
    statusElement.textContent = `${stationObserved ? `Observed at ${payload.station_observation.id} · ${payload.observation_age_minutes} min old` : weatherDescription(payload.weather_code)} · valid ${Number.isNaN(valid.getTime()) ? payload.valid_at : valid.toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}`;
    if (provenance) {
      const age = Number(payload.stale_age_seconds);
      const staleNote = payload.stale
        ? `Cached response${Number.isFinite(age) ? ` · ${Math.floor(age / 60)} min old` : ''}; live refresh failed.`
        : stationObserved
          ? `${payload.provider} · airport observation; feels-like and solar radiation remain modelled.`
          : `Open-Meteo modelled current conditions · fetched ${new Date(payload.fetched_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })} SAST`;
      provenance.textContent = `${staleNote} · ${payload.attribution || 'Weather data by Open-Meteo'}`;
      provenance.hidden = false;
    }
    metrics.hidden = false;
    metrics.innerHTML = `
      <span><b>${payload.temperature_2m_c.toFixed(1)}°C</b>Air</span>
      <span><b>${payload.apparent_temperature_c.toFixed(1)}°C</b>${stationObserved ? 'Feels like · model' : 'Feels like'}</span>
      <span><b>${payload.wind_speed_10m_mps.toFixed(1)} m/s</b>Wind · ${Math.round(payload.wind_direction_10m_deg)}°</span>
      <span><b>${Math.round(payload.relative_humidity_2m_pct)}%</b>Humidity</span>
      ${payload.cloud_cover_pct == null ? '' : `<span><b>${Math.round(payload.cloud_cover_pct)}%</b>Cloud cover</span>`}`;
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
      const payload = await response.json();
      renderWeather(payload);
      // Keep the scene sky in sync with the live conditions as soon as they
      // load, including on the initial automatic fetch.
      dispatchEvent(new CustomEvent('climate-weather-sky', { detail: payload }));
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

function windReportSpeed(value, digits = 2) {
  const speed = Number(value);
  return Number.isFinite(speed)
    ? `${windReportNumber(speed, digits, ' m/s')} · ${windReportNumber(speed * 3.6, 1, ' km/h')}`
    : '—';
}

function windReportQuantile(values, probability) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
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

function windReportFieldMap(field, sharedRange = null) {
  const sourceColumns = field.width, sourceRows = field.height;
  const columns = Math.min(64, sourceColumns), rows = Math.min(48, sourceRows);
  const width = 820;
  const domainRatio = (sourceRows * field.dz) / Math.max(sourceColumns * field.dx, 1);
  const height = Math.round(Math.max(280, Math.min(500, width * domainRatio)));
  const values = field.speed || [];
  const comfortMode = field.analysis_mode === 'comfort' && field.comfort_category?.length;
  const comfortColors = ['#287f69', '#55aa70', '#a8c84c', '#e5bd3f', '#df8039', '#c7473f'];
  let localMinimum = Infinity, localMaximum = -Infinity;
  values.forEach((value, index) => { if (Number.isFinite(value) && (!field.valid || field.valid[index])) { localMinimum = Math.min(localMinimum, value); localMaximum = Math.max(localMaximum, value); } });
  const minimum = sharedRange?.minimum ?? localMinimum;
  const maximum = sharedRange?.maximum ?? localMaximum;
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
          const sourceIndex = row * sourceColumns + column;
          if (field.valid && !field.valid[sourceIndex]) continue;
          total += Number(values[sourceIndex]) || 0;
          count += 1;
        }
      }
      if (!count) continue;
      const speed = total / Math.max(count, 1);
      const x = targetColumn * width / columns, y = targetRow * height / rows;
      const sampleRow = Math.min(sourceRows - 1, Math.floor((rowStart + rowEnd - 1) / 2));
      const sampleColumn = Math.min(sourceColumns - 1, Math.floor((columnStart + columnEnd - 1) / 2));
      const fill = comfortMode
        ? comfortColors[field.comfort_category[sampleRow * sourceColumns + sampleColumn] ?? 5]
        : windReportColor(speed, minimum, maximum);
      cells.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(width / columns + 0.35).toFixed(2)}" height="${(height / rows + 0.35).toFixed(2)}" fill="${fill}"/>`);
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
      ${comfortMode ? '' : `<g stroke="#fff" fill="#fff" stroke-width="4" stroke-linecap="round">
        <line x1="${arrowStartX}" y1="${arrowStartY}" x2="${arrowEndX}" y2="${arrowEndY}" marker-end="url(#wind-arrow)"/>
        <defs><marker id="wind-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"/></marker></defs>
      </g>
      <text x="${width - 150}" y="115" fill="#fff" font-size="15" font-family="system-ui" font-weight="700">FROM ${Math.round(bearing)}°</text>`}
      <text x="18" y="28" fill="#fff" font-size="15" font-family="system-ui" font-weight="800">${windReportEscape(field.height_m)} m ${comfortMode ? 'wind comfort' : 'pedestrian wind'}</text>
      <text x="18" y="49" fill="#e1eef4" font-size="11" font-family="system-ui">${windReportEscape(field.width)} × ${windReportEscape(field.height)} cells · ${windReportNumber(field.dx, 1, ' m')} resolution</text>
      <text x="18" y="${height - 17}" fill="#fff" font-size="11" font-family="system-ui">N ↑ · viewer-local x east / z south</text>
    </svg>
    <div class="wind-report-map-meta">
      <span>${comfortMode ? 'Long sitting → uncomfortable' : `${windReportSpeed(minimum, 1)} <i class="wind-report-gradient"></i> ${windReportSpeed(maximum, 1)}`}</span>
      <span>Cell colours show ${comfortMode ? 'wind-rose-weighted comfort class' : 'modelled mean speed'}</span>
    </div>
  </div>`;
}

function setupWindResults() {
  const results = document.querySelector('#wind-results');
  const explorer = document.querySelector('#wind-explorer');
  const explorerCount = document.querySelector('#wind-explorer-count');
  const explorerNote = document.querySelector('#wind-explorer-note');
  const focusStatus = document.querySelector('#wind-focus-status');
  const hotAreas = document.querySelector('#wind-hot-areas');
  const hotStreets = document.querySelector('#wind-hot-streets');
  const reportButton = document.querySelector('#wind-report');
  const reportDialog = document.querySelector('#wind-report-dialog');
  const reportDocument = document.querySelector('#wind-report-document');
  const reportClose = document.querySelector('#wind-report-close');
  const reportPrint = document.querySelector('#wind-report-print');
  if (!results || results.dataset.ready) return;
  results.dataset.ready = 'true';
  let latestField = null;
  let baseline = null;
  const saveBaseline = document.querySelector('#wind-save-baseline');
  const clearBaseline = document.querySelector('#wind-clear-baseline');
  const compareStatus = document.querySelector('#wind-compare-status');
  const compareResult = document.querySelector('#wind-comparison-result');
  const categoryColors = ['#287f69', '#55aa70', '#a8c84c', '#e5bd3f', '#df8039', '#c7473f'];
  const describeField = field => `${field.analysis_mode === 'comfort'
    ? `Comfort · ${field.season || 'annual'} · ${field.stability || 'neutral'} · ${field.height_m ?? '?'} m`
    : `Direction · ${Math.round(field.direction_deg ?? 0)}° · ${field.season || 'annual'} · ${field.height_m ?? '?'} m`}${field.case_label ? ` · ${field.case_label}` : ''}`;
  const distribution = field => {
    const categories = field.comfort_categories || [];
    const valid = index => !field.valid || Boolean(field.valid[index]);
    const total = field.comfort_category.reduce((sum, _, index) => sum + Number(valid(index)), 0);
    return categories.map(category => {
      const count = field.comfort_category.reduce((sum, code, index) => sum + Number(valid(index) && code === category.code), 0);
      return { ...category, share: total ? count * 100 / total : 0 };
    });
  };
  const renderComparison = () => {
    if (!baseline || !latestField) {
      compareResult.hidden = true;
      compareStatus.textContent = baseline ? 'Baseline saved. Run another study to compare.' : 'Run a wind study to start a comparison.';
      return;
    }
    if (baseline.field.analysis_mode !== latestField.analysis_mode) {
      compareResult.innerHTML = '<p>Choose results from the same analysis mode to compare them. Comfort and single-direction results use different interpretations.</p>';
      compareResult.hidden = false;
      compareStatus.textContent = 'Analysis modes differ; run a matching type of study.';
      return;
    }
    if (latestField.analysis_mode === 'direction') {
      const first = baseline.field, second = latestField;
      const firstSpeeds = first.speed.filter((_, index) => !first.valid || first.valid[index]);
      const secondSpeeds = second.speed.filter((_, index) => !second.valid || second.valid[index]);
      const firstMean = firstSpeeds.reduce((sum, value) => sum + value, 0) / Math.max(firstSpeeds.length, 1);
      const secondMean = secondSpeeds.reduce((sum, value) => sum + value, 0) / Math.max(secondSpeeds.length, 1);
      const sameGrid = first.width === second.width && first.height === second.height && first.dx === second.dx && first.dz === second.dz
        && JSON.stringify(first.origin) === JSON.stringify(second.origin)
        && JSON.stringify(first.basis_xz) === JSON.stringify(second.basis_xz)
        && JSON.stringify(first.basis_z) === JSON.stringify(second.basis_z);
      let pairedCount = 0, increased = 0, decreased = 0, deltaSum = 0, cells = '', beforeAfterMaps = '';
      if (sameGrid) {
        let sharedMinimum = Infinity, sharedMaximum = -Infinity;
        for (const field of [first, second]) field.speed.forEach((value, index) => { if (Number.isFinite(value) && (!field.valid || field.valid[index])) { sharedMinimum = Math.min(sharedMinimum, value); sharedMaximum = Math.max(sharedMaximum, value); } });
        const sharedRange = { minimum: Number.isFinite(sharedMinimum) ? sharedMinimum : 0, maximum: Number.isFinite(sharedMaximum) ? sharedMaximum : 1 };
        beforeAfterMaps = `<div class="wind-before-after"><section><h4>Before · ${windReportEscape(baseline.label)}</h4>${windReportFieldMap(first, sharedRange)}</section><section><h4>After · ${windReportEscape(describeField(second))}</h4>${windReportFieldMap(second, sharedRange)}</section></div>`;
        const columns = Math.min(44, first.width), rows = Math.min(32, first.height);
        const deltas = [];
        for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
          const x = Math.min(first.width - 1, Math.floor((column + .5) * first.width / columns));
          const y = Math.min(first.height - 1, Math.floor((row + .5) * first.height / rows));
          const index = y * first.width + x;
          if ((first.valid && !first.valid[index]) || (second.valid && !second.valid[index])) continue;
          const delta = second.speed[index] - first.speed[index];
          pairedCount += 1; deltaSum += delta; deltas.push({ column, row, delta });
          if (delta > .25) increased += 1;
          if (delta < -.25) decreased += 1;
        }
        const scale = Math.max(.5, ...deltas.map(item => Math.abs(item.delta)));
        const rects = deltas.map(item => `<rect x="${item.column}" y="${item.row}" width="1.05" height="1.05" fill="${item.delta < 0 ? '#4eb58b' : item.delta > 0 ? '#dc795e' : '#777b7a'}" fill-opacity="${Math.max(.25, Math.abs(item.delta) / scale).toFixed(2)}"/>`).join('');
        cells = `<div class="wind-difference-map"><b>Pedestrian speed change</b><svg viewBox="0 0 ${columns} ${rows}" role="img" aria-label="Green areas became slower; red areas became faster">${rects}</svg><small><i class="better"></i>Slower <i class="same"></i>Little change <i class="worse"></i>Faster</small></div>`;
      }
      const meanDelta = pairedCount ? deltaSum / pairedCount : secondMean - firstMean;
      const diffPp = pairedCount ? `${(increased * 100 / pairedCount).toFixed(1)}% faster · ${(decreased * 100 / pairedCount).toFixed(1)}% slower` : 'No shared grid';
      compareResult.innerHTML = `${beforeAfterMaps}${cells}<div class="wind-direction-compare-stats"><span>Baseline mean<strong>${windReportSpeed(firstMean)}</strong></span><span>Current mean<strong>${windReportSpeed(secondMean)}</strong></span><span>Mean change<strong>${meanDelta > 0 ? '+' : ''}${windReportNumber(meanDelta, 2, ' m/s')} · ${windReportNumber(meanDelta * 3.6, 1, ' km/h')}</strong></span></div><p>${diffPp} across paired pedestrian cells. Directional steady-state comparison; this is not a comfort classification.</p>`;
      compareResult.hidden = false;
      compareStatus.textContent = `${baseline.label} compared with ${describeField(latestField)}.`;
      return;
    }
    const first = distribution(baseline.field), second = distribution(latestField);
    const canPair = baseline.field.width === latestField.width && baseline.field.height === latestField.height
      && baseline.field.dx === latestField.dx && baseline.field.dz === latestField.dz
      && JSON.stringify(baseline.field.origin) === JSON.stringify(latestField.origin);
    const valid = field => field.comfort_category.reduce((sum, _, index) => sum + Number(!field.valid || Boolean(field.valid[index])), 0);
    const paired = canPair ? baseline.field.comfort_category.reduce((sum, _, index) => sum + Number((!baseline.field.valid || baseline.field.valid[index]) && (!latestField.valid || latestField.valid[index])), 0) : 0;
    const rows = first.map((category, index) => {
      const next = second[index];
      const delta = next.share - category.share;
      return `<div class="wind-compare-row"><i style="background:${categoryColors[index]}"></i><span>${windReportEscape(category.label)}</span><b>${category.share.toFixed(1)}%</b><span class="wind-compare-delta ${delta > .05 ? 'up' : delta < -.05 ? 'down' : ''}">${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp</span><b>${next.share.toFixed(1)}%</b></div>`;
    }).join('');
    let differenceMap = '';
    if (canPair) {
      const columns = Math.min(44, baseline.field.width), rowsCount = Math.min(32, baseline.field.height);
      const rects = [];
      for (let y = 0; y < rowsCount; y += 1) for (let x = 0; x < columns; x += 1) {
        const sourceX = Math.min(baseline.field.width - 1, Math.floor((x + .5) * baseline.field.width / columns));
        const sourceY = Math.min(baseline.field.height - 1, Math.floor((y + .5) * baseline.field.height / rowsCount));
        const index = sourceY * baseline.field.width + sourceX;
        if ((baseline.field.valid && !baseline.field.valid[index]) || (latestField.valid && !latestField.valid[index])) continue;
        const delta = latestField.comfort_category[index] - baseline.field.comfort_category[index];
        const fill = delta < 0 ? '#4eb58b' : delta > 0 ? '#dc795e' : '#777b7a';
        rects.push(`<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="${fill}"/>`);
      }
      differenceMap = `<div class="wind-difference-map"><b>Comfort class change</b><svg viewBox="0 0 ${columns} ${rowsCount}" role="img" aria-label="Green areas move toward more comfortable categories; red areas move toward less comfortable categories">${rects.join('')}</svg><small><i class="better"></i>More comfortable <i class="same"></i>No change <i class="worse"></i>Less comfortable</small></div>`;
    }
    compareResult.innerHTML = `${differenceMap}<div class="wind-compare-head"><span>Comfort class</span><b>Baseline</b><span>Change</span><b>Current</b></div>${rows}<p>${canPair ? `${paired.toLocaleString()} cells are valid in both results (${valid(latestField).toLocaleString()} current cells). The map shows category changes on shared valid cells.` : 'Grid extents differ, so category shares are compared without a cell-by-cell map difference.'}</p>`;
    compareResult.hidden = false;
    compareStatus.textContent = `${baseline.label} compared with ${describeField(latestField)}.`;
  };
  saveBaseline?.addEventListener('click', () => {
    if (!latestField) return;
    baseline = { field: structuredClone(latestField), label: describeField(latestField) };
    clearBaseline.hidden = false;
    dispatchEvent(new CustomEvent('climate-wind-baseline-saved', { detail: baseline }));
    renderComparison();
  });
  clearBaseline?.addEventListener('click', () => {
    baseline = null;
    clearBaseline.hidden = true;
    dispatchEvent(new CustomEvent('climate-wind-baseline-cleared'));
    renderComparison();
  });
  addEventListener('climate-design-geometry-change', () => {
    latestField = null;
    renderComparison();
  });

  const validationStatus = document.querySelector('#wind-validation-status');
  const validationResult = document.querySelector('#wind-validation-result');
  const validationButton = document.querySelector('#wind-validate-button');
  const fileInput = document.querySelector('#wind-observation-file');
  const observationsInput = document.querySelector('#wind-observation-json');
  const validationTarget = document.querySelector('#wind-validation-target');
  let windValidationInputSource = null;
  // Convert CSV values explicitly so numeric validation errors are readable.
  const csvObservations = source => {
    const lines = source.trim().split(/\r?\n/).filter(Boolean);
    const split = line => { const values = []; let cell = '', quote = false; for (let i = 0; i < line.length; i += 1) { if (line[i] === '"' && line[i + 1] === '"' && quote) { cell += '"'; i++; } else if (line[i] === '"') quote = !quote; else if (line[i] === ',' && !quote) { values.push(cell.trim()); cell = ''; } else cell += line[i]; } values.push(cell.trim()); return values; };
    const headers = split(lines.shift() || '').map(item => item.toLowerCase());
    if (!['x', 'z', 'speed_mps'].every(header => headers.includes(header))) throw new Error('CSV needs x, z and speed_mps columns.');
    return lines.map((line, rowIndex) => {
      const cells = split(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
      const numeric = name => row[name] === '' || row[name] == null ? undefined : Number(row[name]);
      const observation = {
        id: row.id || undefined, site_name: row.site_name || undefined,
        sensor_id: row.sensor_id || undefined, sensor_model: row.sensor_model || undefined,
        calibration_date: row.calibration_date || undefined,
        x: numeric('x'), z: numeric('z'), speed_mps: numeric('speed_mps'),
        height_m: numeric('height_m'), observed_at: row.observed_at || undefined,
        wind_direction_deg: numeric('wind_direction_deg'),
        reference_speed_mps: numeric('reference_speed_mps'),
        reference_direction_deg: numeric('reference_direction_deg'),
        reference_height_m: numeric('reference_height_m'),
        averaging_period_s: numeric('averaging_period_s'), split: row.split || undefined,
        split_group: row.split_group || undefined,
        sensor_calibration: row.sensor_calibration || [row.sensor_id, row.sensor_model, row.calibration_date].filter(Boolean).join(' · ') || undefined,
        measurement_notes: row.measurement_notes || undefined,
      };
      if (![observation.x, observation.z, observation.speed_mps, observation.height_m,
        observation.reference_speed_mps, observation.reference_direction_deg,
        observation.reference_height_m, observation.averaging_period_s].every(Number.isFinite)) {
        throw new Error(`CSV row ${rowIndex + 2} is missing a required coordinate, speed, sensor height, direction or averaging period.`);
      }
      if (!observation.observed_at || !/(Z|[+-]\d{2}:?\d{2})$/i.test(observation.observed_at)) {
        throw new Error(`CSV row ${rowIndex + 2} needs observed_at with a timezone (UTC Z or an explicit offset).`);
      }
      if (!observation.split_group) throw new Error(`CSV row ${rowIndex + 2} needs a split_group for its complete site or period unit, such as site:church-square.`);
      return observation;
    });
  };
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    try {
      if (file.size > 10_000_000) throw new Error('Observation file must be 10 MB or smaller.');
      const sourceText = await file.text();
      const observations = csvObservations(sourceText);
      observationsInput.value = JSON.stringify(observations, null, 2);
      windValidationInputSource = { filename: file.name, format: 'csv', text: sourceText };
      validationStatus.textContent = `${observations.length} observations loaded from ${file.name}.`;
    }
    catch (error) { validationStatus.textContent = error.message; }
  });
  observationsInput?.addEventListener('input', () => { windValidationInputSource = null; });
  validationButton?.addEventListener('click', async () => {
    validationButton.disabled = true;
    const target = validationTarget?.value || 'openfoam';
    validationStatus.textContent = target === 'openfoam' ? 'Sampling the selected OpenFOAM pedestrian field…' : 'Comparing observations with the screening model…';
    validationResult.hidden = true;
    try {
      const rawInput = observationsInput.value.trim();
      if (rawInput.length > 10_000_000) throw new Error('Observation input must be 10 MB or smaller.');
      const observations = rawInput.startsWith('[')
        ? JSON.parse(rawInput)
        : csvObservations(rawInput);
      const sourceInput = windValidationInputSource || {
        filename: null, format: rawInput.startsWith('[') ? 'json' : 'csv', text: rawInput,
      };
      if (!Array.isArray(observations) || observations.length < 3) throw new Error('Add at least three observations.');
      const direction = Number(document.querySelector('#wind-validation-direction').value);
      let endpoint = '/api/wind/validate';
      let payload = {
        scenario: {
          center_local: [Number(document.querySelector('#wind-validation-center-x').value), Number(document.querySelector('#wind-validation-center-z').value)],
          size_m: Number(document.querySelector('#wind-validation-size').value),
          direction_deg: Number(document.querySelector('#wind-validation-direction').value),
          season: document.querySelector('#wind-season')?.value || 'annual',
          stability: document.querySelector('#wind-stability')?.value || 'neutral',
          reference_speed_mps: Number(document.querySelector('#wind-validation-speed').value),
          reference_height_m: 10, height_m: 2, resolution_m: 5,
          exceedance_threshold_mps: 6, forcing_mode: 'manual',
        }, observations,
      };
      if (target === 'openfoam') {
        const caseNames = { 0: 'cbd_n_full', 22.5: 'cbd_22p5_full', 45: 'cbd_ne_full', 67.5: 'cbd_67p5_full', 90: 'cbd_e_full', 112.5: 'cbd_112p5_full', 135: 'cbd_se_full', 157.5: 'cbd_157p5_full', 180: 'cbd_s_full', 202.5: 'cbd_202p5_full', 225: 'cbd_sw_full', 247.5: 'cbd_247p5_full', 270: 'cbd_w_full', 292.5: 'cbd_292p5_full', 315: 'cbd_nw_full', 337.5: 'cbd_337p5_full' };
        const caseId = caseNames[direction];
        if (!caseId) throw new Error('No OpenFOAM case is registered for this direction.');
        endpoint = '/api/wind/validate-openfoam';
        payload = { case_id: caseId, direction_tolerance_deg: 11.25, observations };
      }
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) {
        const detail = Array.isArray(body.detail)
          ? body.detail.map(item => `${(item.loc || []).slice(-1)[0] || 'Input'}: ${item.msg}`).join(' ')
          : body.detail;
        throw new Error(detail || `Request failed (${response.status}).`);
      }
      const validation = target === 'openfoam' ? body : body.validation;
      const samples = target === 'openfoam'
        ? validation.pairs.map(sample => `<tr><td>${windReportEscape(sample.id)}</td><td>${windReportEscape(sample.split)}</td><td>${Number(sample.predicted_speed_mps).toFixed(2)}</td><td>${Number(sample.observed_speed_mps).toFixed(2)}</td><td>${Number(sample.speed_error_mps) > 0 ? '+' : ''}${Number(sample.speed_error_mps).toFixed(2)}</td></tr>`).join('')
        : validation.samples.map(sample => `<tr><td>${windReportEscape(sample.id || '—')}</td><td>—</td><td>${Number(sample.predicted_speed_mps).toFixed(2)}</td><td>${Number(sample.height_adjusted_observed_speed_mps).toFixed(2)}</td><td>${Number(sample.error_mps) > 0 ? '+' : ''}${Number(sample.error_mps).toFixed(2)}</td></tr>`).join('');
      if (target === 'openfoam') {
        const holdout = validation.metrics.holdout;
        const calibration = validation.metrics.calibration;
        validationResult.innerHTML = `<b>OpenFOAM · ${windReportEscape(validation.status.replaceAll('_', ' '))}</b><div class="wind-validation-metrics"><span>Holdout n <strong>${holdout.n}</strong></span><span>Holdout bias <strong>${holdout.bias_mps == null ? '—' : `${holdout.bias_mps.toFixed(2)} m/s`}</strong></span><span>Holdout MAE <strong>${holdout.mae_mps == null ? '—' : `${holdout.mae_mps.toFixed(2)} m/s`}</strong></span><span>Holdout RMSE <strong>${holdout.rmse_mps == null ? '—' : `${holdout.rmse_mps.toFixed(2)} m/s`}</strong></span></div><p>Calibration: n=${calibration.n}, MAE ${calibration.mae_mps == null ? '—' : `${calibration.mae_mps.toFixed(2)} m/s`}. Holdout direction MAE: ${holdout.direction_mae_deg == null ? 'not recorded' : `${holdout.direction_mae_deg.toFixed(1)}°`}. ${validation.counts.excluded} rows excluded.</p><div class="wind-validation-table-wrap"><table><thead><tr><th>Sensor</th><th>Split</th><th>CFD m/s</th><th>Observed m/s</th><th>Error</th></tr></thead><tbody>${samples}</tbody></table></div><small>CFD speeds are scaled by each row’s simultaneous upstream reference speed. This is a holdout score for the sampled case and conditions, not a global validation or certification.</small>`;
        dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'wind_validation', metadata: {
          clientOnly: true,
          description: `OpenFOAM observation score · ${validation.status.replaceAll('_', ' ')} · ${validation.counts.holdout} holdout rows · diagnostic, not validated.`,
          validation_status: validation.status,
          case_id: validation.case.case_id,
          asset_hashes: validation.case.asset_hashes,
          source_provenance: validation.case.supporting_asset_hashes,
          validation: {
            counts: validation.counts, metrics: validation.metrics,
            metrics_by_split_group: validation.metrics_by_split_group,
            provenance: validation.provenance, method: validation.method,
          },
          kpis: {
            holdout_n: holdout.n, holdout_bias_mps: holdout.bias_mps,
            holdout_mae_mps: holdout.mae_mps, holdout_rmse_mps: holdout.rmse_mps,
          },
          result_data: { ...validation, source_input: sourceInput },
        } } }));
      } else {
        const distances = validation.distance_to_observation_m || [];
        const within = distances.filter(distance => distance <= 25).length / Math.max(1, distances.length) * 100;
        validationResult.innerHTML = `<b>Benchmark only · screening model</b><div class="wind-validation-metrics"><span>Bias <strong>${validation.metrics.bias_mps.toFixed(2)} m/s</strong></span><span>MAE <strong>${validation.metrics.mae_mps.toFixed(2)} m/s</strong></span><span>RMSE <strong>${validation.metrics.rmse_mps.toFixed(2)} m/s</strong></span><span>Grid within 25 m of a sensor <strong>${within.toFixed(1)}%</strong></span></div><div class="wind-validation-table-wrap"><table><thead><tr><th>Sensor</th><th>Split</th><th>Model</th><th>Observed*</th><th>Error</th></tr></thead><tbody>${samples}</tbody></table></div><small>*Observed speed adjusted to 2 m using the selected stability profile. Sparse coverage limits interpretation.</small>`;
      }
      validationResult.hidden = false;
      validationStatus.textContent = target === 'openfoam'
        ? `${validation.counts.paired} paired · ${validation.counts.holdout} holdout · ${validation.counts.excluded} excluded.`
        : `${validation.observation_count} observations · ${validation.status.replaceAll('_', ' ')}.`;
    } catch (error) { validationStatus.textContent = error.message || 'Could not compare observations.'; }
    finally { validationButton.disabled = false; }
  });

  const thermalValidationAttach = document.querySelector('#thermal-validation-attach');
  const thermalValidationStatus = document.querySelector('#thermal-validation-import-status');
  thermalValidationAttach?.addEventListener('click', async () => {
    thermalValidationAttach.disabled = true;
    try {
      const resultFile = document.querySelector('#thermal-validation-result-file')?.files?.[0];
      const sourceFile = document.querySelector('#thermal-validation-source-file')?.files?.[0];
      if (!resultFile || !sourceFile) throw new Error('Choose both the thermal validation JSON and the CSV it scored.');
      if (resultFile.size > 20_000_000 || sourceFile.size > 10_000_000) throw new Error('Validation JSON must be ≤20 MB and observations CSV ≤10 MB.');
      const validation = JSON.parse(await resultFile.text());
      if (validation.schema !== 'conditions-thermal-observation-validation/1') throw new Error('This is not a supported thermal observation-validation report.');
      if (!validation.run_id || !validation.provenance?.manifest_sha256 || !Array.isArray(validation.pairs) || !validation.pairs.length) {
        throw new Error('The thermal report needs a run ID, manifest hash, and at least one paired row.');
      }
      const sourceBytes = await sourceFile.arrayBuffer();
      const sourceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      if (sourceHash !== validation.provenance.observations_sha256) throw new Error('The selected CSV hash does not match the validation report.');
      const frameHashes = validation.provenance.frame_sha256_by_id || {};
      const frames = [...new Map(validation.pairs.map(pair => [pair.frame_id, {
        id: pair.frame_id, valid_at: pair.frame_at, sha256: pair.frame_sha256 || frameHashes[pair.frame_id],
      }])).values()];
      if (frames.some(frame => !frame.id || !frame.sha256)) throw new Error('A paired model frame is missing its hash. Re-run validation with a current thermal report.');
      const sourceBytesArray = new Uint8Array(sourceBytes);
      const base64Chunks = [];
      for (let index = 0; index < sourceBytesArray.length; index += 0x8000) {
        base64Chunks.push(String.fromCharCode(...sourceBytesArray.subarray(index, index + 0x8000)));
      }
      const sourceInput = {
        format: 'base64', filename: sourceFile.name, data: btoa(base64Chunks.join('')),
        sha256: sourceHash,
      };
      const metrics = validation.metrics_by_split || {};
      dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'thermal_validation', metadata: {
        clientOnly: true,
        description: `Thermal observation score · ${validation.validation_status.replaceAll('_', ' ')} · ${validation.paired_count} paired rows · diagnostic, not validated.`,
        run_id: validation.run_id,
        validation_status: validation.validation_status,
        provenance: validation.provenance,
        validation: {
          paired_count: validation.paired_count, excluded_count: validation.excluded_count,
          counts_by_split: validation.counts_by_split, metrics_by_split: validation.metrics_by_split,
          metrics_model_minus_observed: validation.metrics_model_minus_observed,
        },
        kpis: {
          holdout_air_temp_mae_c: metrics.holdout?.air_temp_2m_c?.mae,
          holdout_relative_humidity_mae_pct: metrics.holdout?.relative_humidity_pct?.mae,
          holdout_tmrt_mae_c: metrics.holdout?.tmrt_c?.mae,
          holdout_wind_mae_mps: metrics.holdout?.wind_10m_mps?.mae,
          holdout_utci_mae_c: metrics.holdout?.utci_c?.mae,
        },
        result_data: { ...validation, source_input: sourceInput },
      } } }));
      thermalValidationStatus.textContent = `Attached ${validation.paired_count} paired rows from ${sourceFile.name} to the next climate report export.`;
    } catch (error) {
      thermalValidationStatus.textContent = error.message || 'Could not attach thermal validation report.';
    } finally {
      thermalValidationAttach.disabled = false;
    }
  });

  const invalidate = () => {
    results.hidden = true;
    if (explorer) explorer.hidden = true;
    if (focusStatus) focusStatus.textContent = 'Click a ranked result to highlight it on the map.';
    dispatchEvent(new CustomEvent('climate-wind-focus-clear'));
    latestField = null;
    if (reportButton) reportButton.disabled = true;
    if (saveBaseline) saveBaseline.disabled = true;
    renderComparison();
  };
  const renderWindRankings = field => {
    if (!explorer || !hotAreas || !hotStreets) return;
    const rankings = field.wind_rankings || { areas: [], streets: [] };
    const directional = field.analysis_mode === 'direction';
    explorer.hidden = false;
    explorerCount.textContent = directional
      ? `${Math.round(field.direction_deg)}° direction`
      : `${field.direction_count || '—'} sectors · partial`;
    explorerNote.textContent = directional
      ? `Street averages sample the ${Math.round(field.direction_deg)}° OpenFOAM pedestrian field at ${field.height_m.toFixed(1)} m.`
      : `Wind-rose-weighted mean speed among solved directions at ${field.height_m.toFixed(1)} m · ${(Number(field.coverage_fraction || 0) * 100).toFixed(1)}% of seasonal wind hours covered.`;
    const renderList = (target, items, emptyMessage) => {
      target.replaceChildren();
      if (!items.length) {
        const item = document.createElement('li');
        item.textContent = emptyMessage;
        target.append(item);
        return;
      }
      items.forEach((entry, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', `Focus map on ${entry.name}, ${entry.value.toFixed(2)} metres per second`);
        const rank = document.createElement('small'); rank.textContent = String(index + 1).padStart(2, '0');
        const name = document.createElement('span'); name.textContent = entry.name;
        const value = document.createElement('b'); value.textContent = `${entry.value.toFixed(2)} m/s · ${(entry.value * 3.6).toFixed(1)} km/h`;
        button.append(rank, name, value);
        button.addEventListener('click', () => {
          if (focusStatus) focusStatus.textContent = `Highlighted ${entry.name} · ${entry.value.toFixed(2)} m/s (${(entry.value * 3.6).toFixed(1)} km/h).`;
          dispatchEvent(new CustomEvent('climate-wind-focus', {
            detail: { x: entry.x, z: entry.z, name: entry.name, speed: entry.value, focusCamera: true },
          }));
        });
        item.append(button);
        target.append(item);
      });
    };
    renderList(hotAreas, rankings.areas || [], 'No high-wind spots are available.');
    renderList(hotStreets, rankings.streets || [], 'No named streets intersect solved cells.');
  };
  document.querySelector('#wind-simulate')?.addEventListener('click', () => {
    if (!explorer) return;
    if (focusStatus) focusStatus.textContent = 'Click a ranked result to highlight it on the map.';
    dispatchEvent(new CustomEvent('climate-wind-focus-clear'));
    explorer.hidden = false;
    explorerCount.textContent = 'Loading…';
    explorerNote.textContent = 'Updating high-wind locations for the selected study…';
    for (const list of [hotAreas, hotStreets]) {
      if (!list) continue;
      const item = document.createElement('li'); item.textContent = 'Updating…'; list.replaceChildren(item);
    }
  });
  ['wind-direction', 'wind-season', 'wind-stability', 'wind-comfort-criterion', 'wind-size', 'wind-cfd-ground-height', 'wind-cfd-field']
    .forEach(id => {
      document.querySelector(`#${id}`)?.addEventListener('input', invalidate);
      document.querySelector(`#${id}`)?.addEventListener('change', invalidate);
    });
  document.querySelectorAll('[data-wind-direction]').forEach(button => button.addEventListener('click', invalidate));
  document.querySelectorAll('[data-wind-lens="direction"], [data-wind-lens="comfort"]').forEach(button => button.addEventListener('click', invalidate));
  addEventListener('climate-wind-result', event => {
    const field = event.detail;
    const directionResult = field?.analysis_mode === 'direction'
      && (Array.isArray(field.speed) || ArrayBuffer.isView(field.speed));
    if (!directionResult && (!field?.comfort_category || !field?.exceedance?.probability)) {
      invalidate();
      return;
    }
    latestField = field;
    renderWindRankings(field);
    if (reportButton) reportButton.disabled = directionResult;
    if (saveBaseline) saveBaseline.disabled = false;
    if (directionResult) {
      const speeds = field.speed.filter((_, index) => !field.valid || field.valid[index]);
      const mean = speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : NaN;
      const coverage = field.speed.length ? speeds.length / field.speed.length * 100 : 0;
      const meanKmh = mean * 3.6, percentile95 = windReportQuantile(speeds, .95);
      results.innerHTML = `<div class="wind-result-highlights"><span><b>${windReportNumber(mean, 2, ' m/s')} · ${windReportNumber(meanKmh, 1, ' km/h')}</b>mean pedestrian speed · ${field.height_m.toFixed(1)} m</span><span><b>${windReportNumber(percentile95, 2, ' m/s')} · ${windReportNumber(percentile95 * 3.6, 1, ' km/h')}</b>95th spatial percentile</span></div><details class="wind-result-evidence"><summary>Evidence &amp; coverage</summary><div class="wind-result-facts"><span><b>${coverage.toFixed(1)}%</b>${speeds.length.toLocaleString()} of ${field.speed.length.toLocaleString()} sampled cells resolved</span><span><b>${Math.round(field.direction_deg)}° · ${field.season}</b>Steady OpenFOAM direction</span><span><b>${windReportEscape(String(field.validation_status || 'not reported').replaceAll('_', ' '))}</b>Validation status</span><span><b>${field.dx.toFixed(1)} × ${field.dz.toFixed(1)} m</b>Sample spacing</span></div></details>`;
      results.hidden = false;
      renderComparison();
      return;
    }
    if (reportButton) reportButton.disabled = false;
    // Cells the source field never actually sampled (field.valid[i] === 0)
    // must not silently count as "comfortable" in these stats — they're
    // absent from the CFD-solved area entirely, not a calm measurement.
    const isValid = index => !field.valid || field.valid[index];
    const counts = new Map();
    field.comfort_category.forEach((code, index) => {
      if (!isValid(index)) return;
      counts.set(code, (counts.get(code) || 0) + 1);
    });
    const dominantCode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const category = field.comfort_categories.find(item => item.code === dominantCode);
    const probabilities = (field.exceedance.probability || []).filter((_, index) => isValid(index));
    const meanExceedance = probabilities.reduce((sum, value) => sum + value, 0) / Math.max(1, probabilities.length);
    const speedScale = field.coverage_fraction > 0 ? 1 / field.coverage_fraction : 1;
    const speeds = (field.speed || []).filter((_, index) => isValid(index)).map(value => value * speedScale);
    const meanSpeed = speeds.reduce((sum, value) => sum + value, 0) / Math.max(1, speeds.length);
    const relative = (field.uncertainty?.relative_fraction || 0) * 100;
    const totalCells = Math.max([...counts.values()].reduce((sum, value) => sum + value, 0), 1);
    const categoryShares = field.comfort_categories.map(item => ({
      ...item,
      share: (counts.get(item.code) || 0) * 100 / totalCells,
    }));
    const lowerSpeedActivityArea = categoryShares.slice(0, 2).reduce((sum, item) => sum + item.share, 0);
    const highestWindClassesArea = categoryShares.slice(-2).reduce((sum, item) => sum + item.share, 0);
    const worstExceedance = Math.max(...probabilities, 0) * 100;
    const cellCount = (field.speed || []).length;
    const validCellCount = speeds.length;
    const validCoverage = cellCount ? validCellCount / cellCount * 100 : 0;
    const sectorCoverage = Number.isFinite(field.coverage_fraction) ? `${(field.coverage_fraction * 100).toFixed(1)}% of wind hours in resolved sectors` : 'Not applicable';
    const archiveCoverage = field.forcing_coverage
      ? `${(field.forcing_coverage.hourly_coverage_fraction * 100).toFixed(1)}% hourly coverage · ${Number(field.forcing_coverage.records).toLocaleString()} records`
      : 'Not reported';
    const criterion = field.comfort_criterion || {};
    const comfortColors = ['#287f69', '#55aa70', '#a8c84c', '#e5bd3f', '#df8039', '#c7473f'];
    const breakdown = categoryShares.filter(item => item.share >= 0.05).map(item =>
      `<i style="flex:${item.share};background:${comfortColors[item.code]}" title="${windReportEscape(item.label)} · ${item.share.toFixed(1)}%"></i>`
    ).join('');
    const forcingLabel = field.analysis_mode === 'comfort'
      ? `${field.direction_count || 16} ${(field.direction_count || 16) === 1 ? 'direction' : 'directions'} resolved · ${field.season} wind rose`
      : field.era5_profile
      ? `ERA5 ${field.era5_profile.sector.toUpperCase()} · ${(field.era5_profile.frequency_fraction * 100).toFixed(1)}% sampled group hours`
      : 'Manual mean forcing';
    results.innerHTML = `
      <div class="wind-result-highlights"><span><b>${lowerSpeedActivityArea.toFixed(1)}%</b>lowest-speed activity classes</span><span><b>${category?.label || '—'}</b>most common class</span></div>
      <div class="wind-comfort-mini" aria-label="Comfort category distribution">${breakdown}</div>
      <details class="wind-result-evidence"><summary>Evidence, coverage &amp; assumptions</summary><div class="wind-result-facts">
        <span><b>${meanSpeed.toFixed(1)} m/s · ${(meanSpeed * 3.6).toFixed(1)} km/h</b>Mean speed at ${field.height_m.toFixed(1)} m</span>
        <span><b>${(meanExceedance * 100).toFixed(1)}%</b>Mean exceedance above ${field.exceedance.threshold_mps} m/s</span>
        <span><b>${highestWindClassesArea.toFixed(1)}%</b>Highest-speed activity classes</span>
        <span><b>${windReportEscape(criterion.name || field.comfort_standard || 'Not reported')} · v${windReportEscape(criterion.version || '—')}</b>Selected comfort criterion</span>
        <span><b>${windReportEscape(criterion.exceedance_probability == null ? '—' : `${Number(criterion.exceedance_probability) * 100}%`)}</b>Criterion exceedance limit</span>
        <span><b>${windReportEscape(criterion.gust_treatment || 'Not reported')}</b>Gust treatment</span>
        <span><b>${worstExceedance.toFixed(1)}%</b>Worst-cell exceedance</span>
        <span><b>±${relative.toFixed(0)}%</b>Screening uncertainty</span>
        <span><b>${validCoverage.toFixed(1)}%</b>${validCellCount.toLocaleString()} of ${cellCount.toLocaleString()} model cells resolved</span>
        <span><b>${windReportEscape(forcingLabel)}</b>Forcing source · ${windReportEscape(sectorCoverage)}</span>
        <span><b>${windReportEscape(archiveCoverage)}</b>ERA5 archive time coverage · ${windReportEscape(field.forcing_dataset_version || '')}</span>
        <span><b>${windReportEscape(String(field.validation_status || 'not reported').replaceAll('_', ' '))}</b>Validation status</span>
      </div></details>`;
    results.hidden = false;
    renderComparison();
  });

  reportButton?.addEventListener('click', () => {
    if (!latestField || !reportDocument || !reportDialog) return;
    const field = latestField;
    const isValidCell = index => !field.valid || Boolean(field.valid[index]);
    const speedScale = field.analysis_mode === 'comfort' && field.coverage_fraction > 0 ? 1 / field.coverage_fraction : 1;
    const speeds = (field.speed || []).filter((_, index) => isValidCell(index)).map(value => Number(value) * speedScale);
    const probabilities = (field.exceedance?.probability || []).filter((_, index) => isValidCell(index)).map(Number);
    const totalCells = Math.max((field.comfort_category || []).reduce((count, _, index) => count + Number(isValidCell(index)), 0), 1);
    const comfort = field.comfort_categories.map(category => ({
      ...category,
      count: field.comfort_category.filter((code, index) => isValidCell(index) && code === category.code).length,
    })).map(category => ({ ...category, percentage: category.count / totalCells * 100 }));
    const dominant = comfort.slice().sort((a, b) => b.count - a.count)[0];
    const uncomfortable = comfort.at(-1)?.percentage || 0;
    const restricted = comfort.slice(-2).reduce((sum, category) => sum + category.percentage, 0);
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
    const criterion = field.comfort_criterion || {};
    const signature = `${field.version}|${criterion.id || field.comfort_standard}|${field.direction_deg}|${field.season}|${field.height_m}|${field.origin?.join(',')}`;
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
    const isComfortStudy = field.analysis_mode === 'comfort';
    const directionDescription = isComfortStudy
      ? `${field.direction_count || 16} direction sectors, wind-rose weighted`
      : `${field.direction_name?.replaceAll('_', ' ').toUpperCase() || ''} · from ${windReportNumber(field.direction_deg, 0, '°')}`;
    const forcingDescription = isComfortStudy ? 'ERA5 all-direction seasonal profiles'
      : era5 ? `ERA5 ${windReportEscape(era5.sector.toUpperCase())} conditional profile` : 'Manual mean wind';
    reportDocument.innerHTML = `
      <header class="report-header">
        <div><p class="report-kicker">Cape Town CBD Conditions</p><h1 id="wind-report-title">Pedestrian wind analysis report</h1></div>
        <div class="report-header-meta"><b>${reference}</b>Generated ${windReportEscape(generated)}<br>${windReportEscape(String(field.analysis_mode || 'preview').toUpperCase())} · screening assessment</div>
      </header>
      <section class="report-verdict ${severity}"><div><h2>${windReportEscape(headline)}</h2><p>${windReportNumber(uncomfortable, 1, '%')} of the analysed grid falls in the top ${windReportEscape(criterion.name || 'criterion')} class and ${windReportNumber(restricted, 1, '%')} in its two highest-wind classes. The most common class is ${windReportEscape(dominant?.label || 'unknown')}.</p></div></section>
      <section class="report-section"><div class="report-section-heading"><h2>Scenario definition</h2><span>Boundary conditions and domain</span></div><div class="report-scenario-grid">
        <div class="report-fact"><span>Wind direction</span><strong>${windReportEscape(directionDescription)}</strong></div>
        <div class="report-fact"><span>Season / stability</span><strong>${windReportEscape(field.season)} · ${windReportEscape(field.stability?.label || field.stability?.key)}</strong></div>
        <div class="report-fact"><span>Comfort criterion</span><strong>${windReportEscape(criterion.name || field.comfort_standard || 'Not reported')} · v${windReportEscape(criterion.version || '—')}</strong></div>
        <div class="report-fact"><span>Result height</span><strong>${windReportNumber(field.height_m, 1, ' m')} pedestrian layer</strong></div>
        <div class="report-fact"><span>Analysis domain</span><strong>${windReportNumber(field.width * field.dx, 0, ' m')} × ${windReportNumber(field.height * field.dz, 0, ' m')}</strong></div>
        <div class="report-fact"><span>Forcing</span><strong>${forcingDescription}</strong></div>
        <div class="report-fact"><span>Reference wind</span><strong>${windReportSpeed(field.reference_speed_mps)} at ${windReportNumber(field.reference_height_m, 1, ' m')}</strong></div>
        <div class="report-fact"><span>Height profile</span><strong>Exponent ${windReportNumber(field.height_profile_exponent, 3)}</strong></div>
        <div class="report-fact"><span>Flow model</span><strong>${windReportEscape(String(field.model_kind).replaceAll('_', ' '))}</strong></div>
      </div></section>
      ${sceneImage ? `<section class="report-section"><div class="report-section-heading"><h2>Simulation view</h2><span>Visual context</span></div>${sceneImage}</section>` : ''}
      <section class="report-section"><div class="report-section-heading"><h2>Pedestrian wind field</h2><span>Mean speed at ${windReportNumber(field.height_m, 1, ' m')}</span></div>${windReportFieldMap(field)}</section>
      <section class="report-section"><div class="report-section-heading"><h2>Headline indicators</h2><span>Spatial summary</span></div><div class="report-stat-grid">
        <div class="report-stat"><span>Spatial mean speed</span><strong>${windReportSpeed(meanSpeed)}</strong><small>Across ${speeds.length.toLocaleString('en-ZA')} model cells</small></div>
        <div class="report-stat"><span>95th spatial speed</span><strong>${windReportSpeed(windReportQuantile(speeds, .95))}</strong><small>Upper spatial tail of mean wind</small></div>
        <div class="report-stat"><span>Maximum cell speed</span><strong>${windReportSpeed(Math.max(...speeds))}</strong><small>Modelled grid maximum</small></div>
        <div class="report-stat"><span>Mean threshold exceedance</span><strong>${windReportNumber(meanExceedance * 100, 1, '%')}</strong><small>Above ${windReportSpeed(field.exceedance.threshold_mps, 1)}</small></div>
        <div class="report-stat"><span>Area over 5% exceedance</span><strong>${windReportNumber(exceedanceArea, 1, '%')}</strong><small>Share of analysis cells</small></div>
        <div class="report-stat"><span>Screening uncertainty</span><strong>±${windReportNumber((field.uncertainty?.relative_fraction || 0) * 100, 0, '%')}</strong><small>Epistemic interval</small></div>
      </div></section>
      <section class="report-section"><div class="report-section-heading"><h2>Wind-comfort classification</h2><span>${windReportEscape(field.comfort_standard)}</span></div>
        <div class="wind-comfort-bar" aria-label="Wind comfort category proportions">${comfortBar}</div><div class="wind-comfort-legend">${comfortLegend}</div>
      </section>
      <section class="report-section report-two-column">
        <div><div class="report-section-heading"><h2>ERA5 forcing evidence</h2><span>${isComfortStudy ? 'All 16 sector profiles' : era5 ? 'Selected sector profile' : 'Not used'}</span></div>${isComfortStudy ? `<div class="report-note">The comfort result combines ${field.direction_count || 16} directional fields. Each field is weighted by its normalized ${windReportEscape(field.season)} ERA5 sector frequency and fitted Weibull exceedance curve.</div>` : era5 ? `<ul class="report-list">
          <li><b>Profile sample</b><span>${windReportNumber(era5.sample_count, 0)} records</span></li><li><b>Mean direction</b><span>${windReportNumber(era5.mean_direction_deg, 1, '°')}</span></li>
          <li><b>95th wind speed</b><span>${windReportSpeed(era5.p95_speed_mps)}</span></li><li><b>95th gust</b><span>${windReportSpeed(era5.p95_gust_mps)}</span></li>
          <li><b>Weibull shape</b><span>${windReportNumber(era5.weibull_shape, 3)}</span></li><li><b>Sector frequency</b><span>${windReportNumber(era5.frequency_fraction * 100, 1, '%')}</span></li>
        </ul>` : '<div class="report-note">This scenario used a manually supplied mean wind speed.</div>'}</div>
        <div><div class="report-section-heading"><h2>Data quality</h2><span>Provenance and coverage</span></div><ul class="report-list">
          <li><b>Field version</b><span>${windReportEscape(field.version)}</span></li><li><b>Validation status</b><span>${windReportEscape(String(field.validation_status).replaceAll('_', ' '))}</span></li>
          <li><b>ERA5 temporal coverage</b><span>${coverage ? windReportNumber(coverage.hourly_coverage_fraction * 100, 1, '%') : 'Not applicable'}</span></li><li><b>ERA5 records</b><span>${coverage ? windReportNumber(coverage.records, 0) : '—'}</span></li>
          <li><b>Uncertainty drivers</b><span>${windReportEscape(uncertaintyDrivers || 'Not reported')}</span></li>
        </ul></div>
      </section>
      <section class="report-section"><div class="report-section-heading"><h2>Method and interpretation</h2><span>Read before decision-making</span></div><div class="report-two-column">
        <div class="report-note"><b>Method.</b> ${windReportEscape(criterion.wind_speed_basis || 'Wind categories use a declared screening method.')} ${windReportEscape(criterion.averaging_period || '')} Gust treatment: ${windReportEscape(criterion.gust_treatment || 'not reported')} ${isComfortStudy ? 'Solved directional exceedance fields are weighted by the selected period wind rose.' : 'The displayed exceedance is conditional on the selected direction.'}</div>
        <div class="report-note"><b>Source.</b> ${windReportEscape(criterion.source?.citation || 'Criterion source not recorded.')}${criterion.source?.url ? ` <a href="${windReportEscape(criterion.source.url)}" rel="noreferrer">Source document</a>.` : ''}</div>
        <div class="report-note"><b>Limitations.</b> This is an unvalidated screening result, not certified CFD, wind-tunnel evidence or a local measurement. ERA5 is regional reanalysis; its active 2021–2025 archive has complete hourly coverage but is not independent local validation. The selected criterion's gust and safety coverage is stated above. Building wakes and turbulence need independent benchmarks and pedestrian-anemometer validation.</div>
      </div></section>
      <footer class="report-footer">Cape Town CBD Conditions · ${reference} · ${windReportEscape(field.crs)} · Analysis mode: ${windReportEscape(field.analysis_mode)} · Source layer: ${windReportEscape(field.source_layer || 'generated field')}</footer>`;
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

setupExplorerExperience();
setupMenuNavigation();
setupHeatViewSelector();
setupWalkingRoutes();
setupFullscreenControls();
setupWindResults();
loadScene();
