let canvas = document.querySelector('#scene');
const windCanvas = document.querySelector('#wind-overlay');
const windContext = windCanvas.getContext('2d');
const status = document.querySelector('#status');

function freshCanvas() {
  const replacement = canvas.cloneNode(false);
  canvas.replaceWith(replacement);
  canvas = replacement;
}

async function loadScene() {
  status.textContent = 'Loading scene…';
  const guide = document.querySelector('#wind-box-guide');
  if (guide) guide.hidden = false;
  try {
    const module = await import('./webglRenderer.js?v=13');
    await module.startWebGLScene(canvas, status);
  } catch (webglError) {
    console.warn('WebGL renderer unavailable; loading Canvas fallback:', webglError);
    status.textContent = 'GPU renderer unavailable · loading compatibility view…';
    freshCanvas();
    try {
      const module = await import('./sceneRenderer.js?v=53');
      await module.startScene(canvas, status);
    } catch (fallbackError) {
      console.error(fallbackError);
      status.textContent = `Viewer failed: ${fallbackError.message}`;
      return;
    }
  }
  const currentGuide = document.querySelector('#wind-box-guide');
  if (currentGuide) currentGuide.hidden = true;
  windContext.clearRect(0, 0, windCanvas.width, windCanvas.height);
  setupCurrentConditions();
  setupStreetView();
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

freshCanvas();
loadScene();
