// Request lifetimes include body decoding. Never automatically replay simulations.
const pending = new Map();
const cheapReads = new Set(['/api/health', '/api/heat/metrics', '/api/traffic/roads', '/api/wind/scenarios']);
const toolFor = path => path.includes('/sunlight/') ? 'sun' : path.includes('/heat/') ? 'heat'
  : path.includes('/wind/') || path.includes('/cfd/') ? 'wind' : path.includes('/traffic/') ? 'traffic'
    : path.includes('transport.json') ? 'transport' : 'tools';
function announce(detail) {
  if (typeof globalThis.CustomEvent === 'function' && globalThis.dispatchEvent) {
    globalThis.dispatchEvent(new CustomEvent('climate-request-status', { detail }));
  }
}

// randomUUID() is restricted to secure browser contexts. The application is
// also commonly opened directly from a VM over plain HTTP, so sunlight jobs
// need an identifier that does not depend on HTTPS being configured first.
export function createAnalysisId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues === 'function') {
    const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }
  return `sun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
export function cancelRequests(tool) {
  for (const entry of pending.values()) if (entry.tool === tool) entry.controller.abort();
}
export function requestError(status) {
  if (status === 429 || status === 503) return 'The service is busy. Wait briefly, then try again.';
  if (status === 401) return 'This deployment requires API access. Contact its operator.';
  if (status === 404) return 'This data or service is unavailable in this deployment.';
  if (status === 422) return 'These analysis settings are invalid. Check the date, time window and supported ranges.';
  return `Request failed (HTTP ${status}). Try again or check service availability.`;
}

export async function scopedFetch(input, options = {}) {
  const url = new URL(input, globalThis.location?.href || 'http://localhost');
  const api = url.pathname.startsWith('/api/');
  const tool = url.searchParams.get('metric') === 'cumulative_sun_hours' ? 'sun' : toolFor(url.pathname);
  const method = (options.method || 'GET').toUpperCase();
  const isCancel = url.pathname.endsWith('/cancel');
  const metric = url.searchParams.get('metric') || '';
  const key = options.requestKey || (api && !isCancel ? `${url.pathname}:${metric}` : url.href);
  const previous = pending.get(key);
  previous?.controller.abort();
  const controller = new AbortController();
  const entry = { controller, tool };
  pending.set(key, entry);
  const { timeoutMs = api ? 120000 : 60000, requestKey, ...nativeOptions } = options;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const detail = { tool, key, path: url.pathname, state: 'loading' };
  const observable = (api || url.pathname.includes('/cfd/')) && !isCancel;
  if (observable) announce(detail);
  const finish = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (pending.get(key) === entry) pending.delete(key);
  };
  const check = () => {
    if (controller.signal.aborted || pending.get(key) !== entry) {
      throw new DOMException(timedOut ? 'Request timed out. Try a smaller analysis area or retry.' : 'Request cancelled or superseded.', 'AbortError');
    }
  };
  const fail = error => {
    const current = pending.get(key) === entry;
    finish();
    if (current && observable) announce({ ...detail, state: 'error',
      message: timedOut ? 'Request timed out. Try a smaller area or retry.' : error.name === 'AbortError' ? 'Request cancelled.' : error.message });
    throw error;
  };
  try {
    check();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await globalThis.fetch(input, { ...nativeOptions, signal: controller.signal });
      check();
      if (!(attempt === 0 && method === 'GET' && cheapReads.has(url.pathname) && [502, 504].includes(response.status))) break;
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 400));
      check();
    }
    detail.requestId = response.headers.get('X-Request-ID');
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(requestError(response.status));
    }
    if (isCancel) { finish(); return response; }
    // Returning a Response proxy preserves existing response.ok and headers callers.
    return new Proxy(response, {
      get(target, property) {
        if (['json', 'arrayBuffer', 'text', 'blob'].includes(property)) return async () => {
          try {
            const value = await target[property]();
            check();
            if (observable) announce({ ...detail, state: 'ready', receivedAt: new Date().toISOString() });
            finish();
            return value;
          } catch (error) { return fail(error); }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  } catch (error) { return fail(error); }
}

export function assertManifest(manifest) {
  if (manifest?.version !== 3 || !Array.isArray(manifest.bounds) || manifest.bounds.length !== 4
      || !manifest.bounds.every(Number.isFinite) || !manifest.assets?.fallback
      || !manifest.layers?.fallback?.cache_key) {
    throw new Error('Scene assets are incompatible. Reload after the operator rebuilds the scene.');
  }
  if (typeof globalThis.CustomEvent === 'function' && globalThis.dispatchEvent) {
    dispatchEvent(new CustomEvent('climate-manifest', { detail: manifest }));
  }
  return manifest;
}
