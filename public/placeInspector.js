const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const roadWidth = attributes => {
  const match = String(attributes.width ?? '').match(/[\d.]+/);
  const value = match ? Number(match[0]) : null;
  return Number.isFinite(value) && value > 0 ? value : null;
};

function makeFeatures(buildingRecords, roadRecords) {
  const features = [];
  for (const record of buildingRecords || []) {
    const value = record.value || record;
    const ring = value[2] || record.ring || [];
    if (ring.length < 3) continue;
    const attributes = value[14] || record.attributes || {};
    const xs = ring.map(point => Number(point[0])), zs = ring.map(point => Number(point[1]));
    const bounds = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    const sourceId = String(value[3] || '');
    const osmId = String(attributes['osm:id'] || sourceId.match(/osm-(?:way|relation)-([\w-]+)/)?.[1] || '');
    const name = String(attributes.name || attributes['name:en'] || '').trim();
    const x = (bounds[0] + bounds[2]) * 0.5, z = (bounds[1] + bounds[3]) * 0.5;
    const label = name || `Unnamed building${osmId ? ` · OSM ${osmId}` : ''}`;
    const roofCoverage = Number(value[7]);
    const metadata = [
      ['Feature', 'Building footprint'],
      ['Source', value[11] || 'OpenStreetMap building part'],
      ...(value[12] != null ? [['Source period', String(value[12])]] : [['Source period', 'Not recorded']]),
      ['Source ID', sourceId || 'Not recorded'],
      ...(osmId ? [['OSM ID', osmId]] : []),
      ['Mapped height', Number.isFinite(Number(value[1])) ? `${Number(value[1]).toFixed(1)} m` : 'Unknown'],
      ['Height source', String(value[4] || 'Unknown')],
      ['Roof representation', String(value[8] || 'Height extrusion')],
      ...(Number.isFinite(roofCoverage) ? [['LiDAR roof coverage', `${(roofCoverage * 100).toFixed(0)}%`]] : []),
      ['Geometry confidence', value[6] ? 'Roof geometry available; source and coverage shown above' : 'Height extrusion; roof geometry unavailable'],
    ];
    const searchText = normalize([name, sourceId, osmId, attributes['building:levels'], attributes.building].join(' '));
    features.push({ kind: 'building', name: label, searchText, x, z, bounds, ring, value, attributes, metadata, osmId });
  }

  for (const record of roadRecords || []) {
    const isCompact = Array.isArray(record);
    const attributes = isCompact
      ? (record[4] && typeof record[4] === 'object' ? record[4] : record[3] || {})
      : (record.attributes || {});
    const points = isCompact ? record[2] : record.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const xs = points.map(point => Number(point[0])), zs = points.map(point => Number(point[1]));
    const bounds = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    let length = 0;
    for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    let remaining = length * 0.5, x = points[0][0], z = points[0][1];
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1], b = points[index], segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (remaining <= segment || index === points.length - 1) {
        const amount = segment > 0 ? Math.min(1, remaining / segment) : 0;
        x = a[0] + (b[0] - a[0]) * amount;
        z = a[1] + (b[1] - a[1]) * amount;
        break;
      }
      remaining -= segment;
    }
    const highway = String(isCompact ? record[1] : record.highway || record.road?.highway || 'road');
    const osmId = String(attributes.osmId || attributes['osm:id'] || '');
    const name = String(attributes.name || attributes['name:en'] || '').trim();
    const label = name || `Unnamed ${highway.replaceAll('_', ' ')}${osmId ? ` · OSM ${osmId}` : ''}`;
    const mappedWidth = roadWidth(attributes);
    const surface = attributes.surface || attributes.renderSurface || null;
    const metadata = [
      ['Feature', 'Street centreline'],
      ['Source', 'OpenStreetMap'],
      ['Source date', 'Not recorded in compact scene'],
      ...(osmId ? [['OSM ID', osmId]] : []),
      ['Road class', highway.replaceAll('_', ' ')],
      ['Mapped width tag', mappedWidth == null ? 'Unknown' : `${mappedWidth.toFixed(1)} m`],
      ['Rendered width', Number.isFinite(Number(isCompact ? record[0] : record.width)) ? `${Number(isCompact ? record[0] : record.width).toFixed(1)} m (display estimate)` : 'Unknown'],
      ['Mapped surface tag', surface ? String(surface) : 'Unknown'],
      ['Mapped lanes', attributes.lanes || 'Unknown'],
      ['Lighting tag', attributes.lit || 'Unknown'],
      ['Sidewalk tag', attributes.sidewalk || 'Unknown'],
    ];
    const searchText = normalize([name, highway, osmId, surface, attributes.ref].join(' '));
    features.push({ kind: 'street', name: label, searchText, x, z, bounds, points, attributes, metadata, osmId, highway });
  }
  return features;
}

function pointSegmentDistance(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const amount = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(dx * dx + dz * dz, 1e-9)));
  return Math.hypot(x - a[0] - dx * amount, z - a[1] - dz * amount);
}

function insideRing(x, z, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, zi] = ring[index], [xj, zj] = ring[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function distanceToFeature(feature, x, z) {
  if (feature.kind === 'building') {
    if (insideRing(x, z, feature.ring)) return 0;
    let distance = Infinity;
    for (let index = 0; index < feature.ring.length; index += 1) {
      distance = Math.min(distance, pointSegmentDistance(x, z, feature.ring[index], feature.ring[(index + 1) % feature.ring.length]));
    }
    return distance;
  }
  let distance = Infinity;
  for (let index = 1; index < feature.points.length; index += 1) distance = Math.min(distance, pointSegmentDistance(x, z, feature.points[index - 1], feature.points[index]));
  return distance;
}

export function attachPlaceInspector({ buildings, roads, onSelect, onPickMode }) {
  const input = document.querySelector('#place-search');
  const results = document.querySelector('#place-search-results');
  const status = document.querySelector('#place-inspector-status');
  const pickButton = document.querySelector('#place-inspector-pick');
  const card = document.querySelector('#place-inspector-card');
  if (!input || !results || !status || !pickButton || !card) return null;

  const cellSize = 100;
  let features = null;
  let grid = null;
  const key = (x, z) => `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
  const ensureIndex = () => {
    if (features) return;
    features = makeFeatures(buildings, roads);
    grid = new Map();
    for (const feature of features) {
      const [minX, minZ, maxX, maxZ] = feature.bounds;
      for (let column = Math.floor(minX / cellSize); column <= Math.floor(maxX / cellSize); column += 1) {
        for (let row = Math.floor(minZ / cellSize); row <= Math.floor(maxZ / cellSize); row += 1) {
          const cell = key(column * cellSize, row * cellSize);
          if (!grid.has(cell)) grid.set(cell, []);
          grid.get(cell).push(feature);
        }
      }
    }
    status.textContent = `${features.length.toLocaleString()} mapped buildings and street segments are searchable by name or OSM ID.`;
  };
  let selected = null;
  let pickActive = false;

  const row = (label, value) => {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = String(value ?? 'Unknown');
    return [dt, dd];
  };
  const setPickActive = active => {
    pickActive = Boolean(active);
    pickButton.setAttribute('aria-pressed', String(pickActive));
    pickButton.textContent = pickActive ? 'Click a building or street… (Esc to cancel)' : 'Pick a place on the map';
    onPickMode?.(pickActive);
  };
  const select = (feature, focus = true, returnFocus = false) => {
    selected = feature;
    document.querySelector('#place-inspector-name').textContent = feature.name;
    document.querySelector('#place-inspector-type').textContent = feature.kind === 'building' ? 'Building' : 'Street';
    const detailList = document.querySelector('#place-inspector-details');
    detailList.replaceChildren(...feature.metadata.flatMap(([label, value]) => row(label, value)));
    card.hidden = false;
    status.textContent = `Selected ${feature.kind}: ${feature.name}.`;
    setPickActive(false);
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    onSelect?.(feature, { focus });
    if (returnFocus) input.focus({ preventScroll: true });
  };
  const addResult = feature => {
    const item = document.createElement('div'); item.setAttribute('role', 'listitem');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'place-search-result';
    const title = document.createElement('span'); title.textContent = feature.name;
    const sourceId = feature.osmId || (feature.kind === 'building' ? feature.value[3] : '');
    const subtitle = document.createElement('small'); subtitle.textContent = feature.kind === 'building'
      ? `Building · ${sourceId ? `ID ${sourceId}` : 'ID not recorded'}`
      : `${feature.highway.replaceAll('_', ' ')} · ${sourceId ? `ID ${sourceId}` : 'ID not recorded'}`;
    const location = document.createElement('small');
    location.textContent = `Mapped centre · x ${feature.x.toFixed(0)} m, z ${feature.z.toFixed(0)} m`;
    button.append(title, subtitle, location);
    button.addEventListener('click', event => select(feature, true, event.detail === 0));
    item.append(button); return item;
  };
  const search = () => {
    ensureIndex();
    const query = normalize(input.value);
    results.replaceChildren();
    if (!query) {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      status.textContent = `${features.length.toLocaleString()} mapped buildings and street segments are searchable by name or OSM ID.`;
      return;
    }
    const matches = features.filter(feature => feature.searchText.includes(query)).slice(0, 8);
    results.replaceChildren(...matches.map(addResult));
    results.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(matches.length > 0));
    status.textContent = matches.length
      ? `Showing ${matches.length} match${matches.length === 1 ? '' : 'es'}; refine the search if needed.`
      : 'No mapped building or street matches that name or ID.';
  };
  const selectAt = (x, z) => {
    ensureIndex();
    const column = Math.floor(x / cellSize), rowIndex = Math.floor(z / cellSize);
    const candidates = new Set();
    for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) {
      for (const feature of grid.get(`${column + dx}:${rowIndex + dz}`) || []) candidates.add(feature);
    }
    let nearest = null, nearestDistance = 40;
    for (const feature of candidates) {
      const distance = distanceToFeature(feature, x, z);
      if (distance < nearestDistance) { nearest = feature; nearestDistance = distance; }
    }
    if (!nearest) {
      status.textContent = 'No mapped building or street within 40 m of that point.';
      return false;
    }
    select(nearest, false);
    return true;
  };

  input.addEventListener('focus', ensureIndex, { once: true });
  input.addEventListener('input', search);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !results.hidden) {
      event.preventDefault(); results.querySelector('button')?.focus();
    } else if (event.key === 'Escape') {
      if (!results.hidden) {
        results.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      } else {
        input.value = '';
        input.setAttribute('aria-expanded', 'false');
        setPickActive(false);
      }
    } else if (event.key === 'Enter' && !results.hidden) {
      results.querySelector('button')?.click();
    }
  });
  results.addEventListener('keydown', event => {
    const buttons = [...results.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' && index >= 0) {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    } else if (event.key === 'ArrowUp' && index >= 0) {
      event.preventDefault();
      if (index === 0) input.focus();
      else buttons[index - 1]?.focus();
    } else if (event.key === 'Home' && buttons.length) {
      event.preventDefault(); buttons[0].focus();
    } else if (event.key === 'End' && buttons.length) {
      event.preventDefault(); buttons.at(-1).focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.focus();
    }
  });
  pickButton.addEventListener('click', () => { ensureIndex(); setPickActive(!pickActive); });
  addEventListener('climate-place-inspector-picked', event => {
    if (pickActive && Number.isFinite(event.detail?.x) && Number.isFinite(event.detail?.z)) selectAt(event.detail.x, event.detail.z);
    else if (pickActive) status.textContent = 'That point is outside the mapped terrain. Try again inside the visible model.';
    setPickActive(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && pickActive) setPickActive(false);
  });
  document.querySelectorAll('[data-place-use]').forEach(button => button.addEventListener('click', () => {
    if (!selected) return;
    const tool = button.dataset.placeUse;
    document.querySelector(`[data-menu-target="${tool}"]`)?.click();
    dispatchEvent(new CustomEvent('climate-use-location', { detail: { tool, x: selected.x, z: selected.z } }));
  }));
  status.textContent = 'Search by street, building name or OSM ID, or pick a place on the map.';
  return { features: () => features || [], selected: () => selected };
}
