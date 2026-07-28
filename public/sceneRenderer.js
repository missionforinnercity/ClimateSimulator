const COLORS = {
  background: '#1b2125',
  terrain: '#424a4d',
  terrainEdge: '#111619',
  grass: '#50745a',
  wall: '#565e63',
  wallDark: '#42494e',
  roof: '#969da0',
  roofEdge: '#3d4447',
  trunk: '#60452f',
  canopy: '#2d653f',
  road: '#5d6669',
  roadMajor: '#c39b50',
  roadSecondary: '#6c94a0',
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const normalize = vector => {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const convexGroundHull = points => {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  if (sorted.length <= 3) return sorted;
  const turn = (origin, a, b) => (a[0] - origin[0]) * (b[2] - origin[2]) - (a[2] - origin[2]) * (b[0] - origin[0]);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
};
const simplifyShadowRing = (ring, tolerance = 1) => {
  let points = ring.slice();
  const toleranceSquared = tolerance * tolerance;
  // Building footprints contain many nearly collinear survey vertices. Three
  // conservative passes remove sub-metre deviations while retaining corners
  // and the original vertex order.
  for (let pass = 0; pass < 3 && points.length > 3; pass += 1) {
    const simplified = [];
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index + points.length - 1) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const dx = next[0] - previous[0];
      const dz = next[1] - previous[1];
      const lengthSquared = dx * dx + dz * dz;
      const amount = lengthSquared
        ? clamp(((current[0] - previous[0]) * dx + (current[1] - previous[1]) * dz) / lengthSquared, 0, 1)
        : 0;
      const nearestX = previous[0] + dx * amount;
      const nearestZ = previous[1] + dz * amount;
      const distanceSquared = (current[0] - nearestX) ** 2 + (current[1] - nearestZ) ** 2;
      if (distanceSquared > toleranceSquared) simplified.push(current);
    }
    if (simplified.length < 3 || simplified.length === points.length) break;
    points = simplified;
  }
  return points;
};

export async function startScene(canvas, status) {
  const mainContext = canvas.getContext('2d', { alpha: false });
  if (!mainContext) throw new Error('Canvas 2D is unavailable.');
  // The city/roads/buildings/trees layer only changes with the camera or a
  // layer toggle, but wind particles animate every frame. Redrawing ~10k
  // static shapes 60 times a second just to move a few hundred particles is
  // the main source of jank, so that layer is cached to an offscreen canvas
  // and only re-rendered when something that affects it actually changes;
  // `context` is swapped to point at it for the duration of renderStatic().
  const sceneCanvas = document.createElement('canvas');
  const sceneContext = sceneCanvas.getContext('2d', { alpha: false });
  let context = mainContext;

  const [manifest, scene, canopyAsset] = await Promise.all([
    fetch('assets/manifest.json').then(response => response.json()),
    fetch('assets/fallback.json').then(response => {
      if (!response.ok) throw new Error('fallback scene asset is missing');
      return response.json();
    }),
    fetch('assets/canopy.json').then(response => response.ok ? response.json() : { canopies: [] }).catch(() => ({ canopies: [] })),
  ]);
  const camera = { azimuth: 0.75, elevation: 0.68, distance: 1600, target: [0, 20, 0] };
  const visibility = { terrain: true, grass: true, roads: true, buildings: true, trees: true };
  const buildings = scene.buildings.map(value => {
    const [ground, height, ring] = value;
    const x = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
    const z = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
    const minX = Math.min(...ring.map(point => point[0]));
    const maxX = Math.max(...ring.map(point => point[0]));
    const minZ = Math.min(...ring.map(point => point[1]));
    const maxZ = Math.max(...ring.map(point => point[1]));
    return {
      kind: 'building', value,
      x, z, ground, height,
      radius: Math.max(...ring.map(point => Math.hypot(point[0] - x, point[1] - z))),
      ring, shadowRing: simplifyShadowRing(ring), minX, maxX, minZ, maxZ,
    };
  });
  const buildingGridSize = 80;
  const buildingGrid = new Map();
  const gridKey = (column, row) => `${column}:${row}`;
  for (let id = 0; id < buildings.length; id += 1) {
    const building = buildings[id];
    const minColumn = Math.floor((building.minX - 18) / buildingGridSize);
    const maxColumn = Math.floor((building.maxX + 18) / buildingGridSize);
    const minRow = Math.floor((building.minZ - 18) / buildingGridSize);
    const maxRow = Math.floor((building.maxZ + 18) / buildingGridSize);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const key = gridKey(column, row);
        const values = buildingGrid.get(key) || [];
        values.push(id);
        buildingGrid.set(key, values);
      }
    }
  }
  const trees = scene.trees.map((value, id) => ({
    kind: 'tree', value, id, x: value[0], z: value[2],
    radius: Math.max(value[3], value[5], value[4] * 0.35),
    // A handful of canopy records overlap footprint polygons. They are
    // usually LiDAR returns from roof gardens or edge noise, and rendering
    // them as free-standing trees makes them appear to grow on rooftops.
    onBuilding: containingBuilding(value[0], value[2]) !== null,
  }));
  const canopies = (canopyAsset.canopies || []).map(record => {
    const [, ground, crownBase, crownTop, seed, rings] = record;
    const outer = rings[0] || [];
    const x = outer.reduce((sum, point) => sum + point[0], 0) / Math.max(1, outer.length);
    const z = outer.reduce((sum, point) => sum + point[1], 0) / Math.max(1, outer.length);
    return { record, ground, crownBase, crownTop, seed, rings, x, z };
  });
  const treeGridSize = 60;
  const treeGrid = new Map();
  for (let id = 0; id < trees.length; id += 1) {
    const tree = trees[id];
    const reach = tree.radius + 20;
    const minColumn = Math.floor((tree.x - reach) / treeGridSize);
    const maxColumn = Math.floor((tree.x + reach) / treeGridSize);
    const minRow = Math.floor((tree.z - reach) / treeGridSize);
    const maxRow = Math.floor((tree.z + reach) / treeGridSize);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const key = gridKey(column, row);
        const values = treeGrid.get(key) || [];
        values.push(id);
        treeGrid.set(key, values);
      }
    }
  }
  const roads = (scene.roads || []).map(value => {
    const points = value[2];
    const minX = Math.min(...points.map(point => point[0]));
    const maxX = Math.max(...points.map(point => point[0]));
    const minZ = Math.min(...points.map(point => point[1]));
    const maxZ = Math.max(...points.map(point => point[1]));
    const x = (minX + maxX) * 0.5;
    const z = (minZ + maxZ) * 0.5;
    return { width: value[0], highway: value[1], points, x, z, radius: Math.hypot(maxX - minX, maxZ - minZ) * 0.5 };
  });
  const grass = (scene.grass || []).map(points => {
    const minX = Math.min(...points.map(point => point[0]));
    const maxX = Math.max(...points.map(point => point[0]));
    const minZ = Math.min(...points.map(point => point[1]));
    const maxZ = Math.max(...points.map(point => point[1]));
    const x = (minX + maxX) * 0.5;
    const z = (minZ + maxZ) * 0.5;
    return { points, x, z, radius: Math.hypot(maxX - minX, maxZ - minZ) * 0.5 };
  });
  const terrain = scene.terrain;
  let drag = null;
  let dirty = true;
  let frame = 0;
  let interactionUntil = 0;
  let settleTimer = 0;
  let shadowGenerationToken = 0;
  const query = new URLSearchParams(location.search);
  const windApi = query.get('windApi') || '/api';
  const windToggle = document.querySelector('#wind-toggle');
  const windDirection = document.querySelector('#wind-direction');
  const windSeason = document.querySelector('#wind-season');
  const windSpeed = document.querySelector('#wind-speed');
  const windSize = document.querySelector('#wind-size');
  const windSpeedValue = document.querySelector('#wind-speed-value');
  const windSizeValue = document.querySelector('#wind-size-value');
  const windStatus = document.querySelector('#wind-status');
  const windSimulate = document.querySelector('#wind-simulate');
  const windMoveDomain = document.querySelector('#wind-move-domain');
  const windLegendMin = document.querySelector('#wind-legend-min');
  const windLegendMax = document.querySelector('#wind-legend-max');
  let windDrag = null;
  const windState = {
    enabled: true,
    field: null,
    center: [0, 0],
    size: Number(windSize.value) || 250,
    direction: Number(windDirection.value) || 135,
    season: windSeason.value || 'annual',
    speed: Number(windSpeed.value) || 10,
    referenceHeight: 2,
    particles: [],
    moveMode: false,
    lastTime: performance.now(),
  };
  const heatToggle = document.querySelector('#heat-toggle');
  const heatMetric = document.querySelector('#heat-metric');
  const heatStatus = document.querySelector('#heat-status');
  const heatLegendMin = document.querySelector('#heat-legend-min');
  const heatLegendMax = document.querySelector('#heat-legend-max');
  const sunToggle = document.querySelector('#sun-toggle');
  const sunDate = document.querySelector('#sun-date');
  const sunTime = document.querySelector('#sun-time');
  const sunTimeValue = document.querySelector('#sun-time-value');
  const sunGenerate = document.querySelector('#sun-generate');
  const sunStatus = document.querySelector('#sun-status');
  const mitigationMethod = document.querySelector('#mitigation-method');
  const mitigationAdd = document.querySelector('#mitigation-add');
  const mitigationStatus = document.querySelector('#mitigation-status');
  const mitigationList = document.querySelector('#mitigation-list');
  const mitigationRun = document.querySelector('#mitigation-run');
  const mitigationClear = document.querySelector('#mitigation-clear');
  const mitigationCompare = document.querySelector('#mitigation-compare');
  const mitigationResults = document.querySelector('#mitigation-results');
  const heatState = {
    enabled: Boolean(heatToggle?.checked),
    metric: heatMetric?.value || 'heat_model_lst_c',
    data: null,
    baselineData: null,
  };
  const mitigationState = { drawing: false, points: [], interventions: [], result: null, afterData: null };
  const streetViewState = { placing: false, point: null };
  const shadowState = {
    enabled: Boolean(sunToggle?.checked),
    date: sunDate?.value || '2026-07-27',
    minutes: Number(sunTime?.value) || 720,
    generated: null,
  };
  const savedVisibility = { ...visibility };

  function setHeatMode(enabled) {
    heatState.enabled = enabled;
    document.body.classList.toggle('heat-mode', enabled);
    if (enabled) {
      shadowState.enabled = false;
      if (sunToggle) sunToggle.checked = false;
      document.body.classList.remove('sun-mode');
      Object.assign(savedVisibility, visibility);
      visibility.terrain = false;
      visibility.grass = false;
      visibility.roads = false;
      visibility.trees = true;
      visibility.buildings = true;
      windState.enabled = false;
      windToggle.checked = false;
    } else {
      Object.assign(visibility, savedVisibility);
      windState.enabled = windToggle.checked;
    }
    document.querySelectorAll('[data-layer]').forEach(input => {
      input.checked = visibility[input.dataset.layer];
    });
    requestRender();
  }

  function setShadowMode(enabled) {
    shadowState.enabled = enabled;
    if (sunToggle) sunToggle.checked = enabled;
    document.body.classList.toggle('sun-mode', enabled);
    if (enabled) {
      if (heatState.enabled) {
        heatToggle.checked = false;
        setHeatMode(false);
      }
      Object.assign(savedVisibility, visibility);
      // Keep the shadow study focused on the terrain and building footprints;
      // removing the extra overlays makes the shade boundary easier to read.
      visibility.terrain = true;
      visibility.grass = false;
      visibility.roads = false;
      visibility.buildings = true;
      visibility.trees = true;
    } else {
      Object.assign(visibility, savedVisibility);
      windState.enabled = windToggle.checked;
    }
    document.querySelectorAll('[data-layer]').forEach(input => {
      input.checked = visibility[input.dataset.layer];
    });
    updateSunStatus();
    requestRender();
  }

  function requestRender() {
    dirty = true;
    if (!frame) frame = requestAnimationFrame(render);
  }

  // Keeps the particle-animation loop going without marking the cached
  // static layer (terrain/roads/buildings/trees) dirty — only the wind
  // overlay needs to redraw every frame.
  function scheduleFrame() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function nearbyBuildings(x, z) {
    return buildingGrid.get(gridKey(Math.floor(x / buildingGridSize), Math.floor(z / buildingGridSize))) || [];
  }

  function nearbyTrees(x, z) {
    return treeGrid.get(gridKey(Math.floor(x / treeGridSize), Math.floor(z / treeGridSize))) || [];
  }

  function pointInPolygon(x, z, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
      const [xi, zi] = ring[index];
      const [xj, zj] = ring[previous];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
    }
    return inside;
  }

  function nearestBoundary(x, z, ring) {
    let best = { distance: Number.POSITIVE_INFINITY, x, z };
    for (let index = 0; index < ring.length; index += 1) {
      const [ax, az] = ring[index];
      const [bx, bz] = ring[(index + 1) % ring.length];
      const dx = bx - ax, dz = bz - az;
      const lengthSquared = dx * dx + dz * dz || 1;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / lengthSquared, 0, 1);
      const px = ax + dx * t, pz = az + dz * t;
      const distance = Math.hypot(x - px, z - pz);
      if (distance < best.distance) best = { distance, x: px, z: pz };
    }
    return best;
  }

  function containingBuilding(x, z) {
    for (const id of nearbyBuildings(x, z)) {
      const building = buildings[id];
      if (x < building.minX || x > building.maxX || z < building.minZ || z > building.maxZ) continue;
      if (pointInPolygon(x, z, building.ring)) return building;
    }
    return null;
  }

  function spawnParticle(field, distributed = false) {
    const angle = windState.direction * Math.PI / 180;
    // windState.direction is the compass bearing wind blows FROM, so flow
    // points the opposite way (matches fallbackWindField below).
    const flowX = -Math.sin(angle), flowZ = Math.cos(angle);
    const minX = field.origin[0], maxX = minX + field.width * field.dx;
    const minZ = field.origin[1], maxZ = minZ + field.height * field.dz;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      let x, z;
      if (distributed) {
        x = minX + Math.random() * (maxX - minX);
        z = minZ + Math.random() * (maxZ - minZ);
      } else if (Math.abs(flowX) > Math.abs(flowZ)) {
        x = flowX > 0 ? minX + 1 : maxX - 1;
        z = minZ + Math.random() * (maxZ - minZ);
      } else {
        x = minX + Math.random() * (maxX - minX);
        z = flowZ > 0 ? minZ + 1 : maxZ - 1;
      }
      if (!containingBuilding(x, z)) return { x, z, previousX: x, previousZ: z, age: distributed ? Math.random() * 8 : 0, trail: [[x, z]] };
    }
    const x = field.origin[0], z = field.origin[1];
    return { x, z, previousX: x, previousZ: z, age: 0, trail: [[x, z]] };
  }

  function resetWindParticles() {
    windState.particles = [];
    if (!windState.field) return;
    const particleCount = Math.round(clamp(windState.size * 1.15, 320, 600));
    for (let index = 0; index < particleCount; index += 1) windState.particles.push(spawnParticle(windState.field, true));
  }

  function updateWindLegend() {
    const values = windState.field?.speed || [];
    const minimum = values.length ? Math.min(...values) : 0;
    const maximum = values.length ? Math.max(...values) : windState.speed;
    windLegendMin.textContent = Number.isFinite(minimum) ? minimum.toFixed(1) : '—';
    windLegendMax.textContent = Number.isFinite(maximum) ? maximum.toFixed(1) : '—';
  }

  function setMoveMode(enabled) {
    windState.moveMode = enabled;
    windMoveDomain.classList.toggle('active', enabled);
    windMoveDomain.setAttribute('aria-pressed', String(enabled));
    windMoveDomain.textContent = enabled ? 'Done moving' : 'Move / resize domain';
    canvas.style.cursor = enabled ? 'move' : 'grab';
    windStatus.textContent = enabled
      ? 'Drag inside the box to move it, or drag the orange handle to resize.'
      : (windState.field ? 'Existing simulation shown · click Simulate wind to refresh.' : 'Domain positioned · click Simulate wind.');
    requestRender();
  }

  function fallbackWindField() {
    const resolution = 5;
    const width = Math.ceil(windState.size / resolution);
    const height = width;
    const angle = windState.direction * Math.PI / 180;
    // windState.direction is the compass bearing wind blows FROM.
    const flowX = -Math.sin(angle);
    const flowZ = Math.cos(angle);
    const u = [], v = [], speed = [];
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const corridor = 0.62 + 0.32 * (0.5 + 0.5 * Math.sin(column * 0.32 + row * 0.17));
        const localSpeed = windState.speed * corridor;
        speed.push(localSpeed);
        u.push(flowX * localSpeed);
        v.push(flowZ * localSpeed);
      }
    }
    return {
      version: 'browser-fallback',
      model_kind: 'directional_speed_proxy',
      origin: [windState.center[0] - windState.size / 2, windState.center[1] - windState.size / 2],
      width, height, dx: resolution, dz: resolution, u, v, speed,
    };
  }

  async function simulateWind() {
    windSimulate.disabled = true;
    windSimulate.textContent = 'Simulating…';
    windStatus.textContent = 'Loading the database-backed wind field…';
    const payload = {
      center_local: [...windState.center],
      size_m: windState.size,
      direction_deg: windState.direction,
      season: windState.season,
      reference_speed_mps: windState.speed,
      reference_height_m: windState.referenceHeight,
      height_m: 2,
      resolution_m: 5,
    };
    try {
      const response = await fetch(`${windApi}/wind/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { message = (await response.json()).detail || message; } catch { /* non-JSON response */ }
        throw new Error(message);
      }
      windState.field = await response.json();
      const sourceNote = windState.field.source_layer ? ` · ${windState.field.source_layer}` : '';
      windStatus.textContent = `${windState.field.polygon_count || 0} wind zones${sourceNote} · exploratory model`;
    } catch (error) {
      console.warn('Wind API unavailable; using local preview:', error);
      windState.field = fallbackWindField();
      windStatus.textContent = `Local animated preview · API unavailable (${error.message})`;
    } finally {
      windSimulate.disabled = false;
      windSimulate.textContent = 'Simulate wind';
    }
    windState.lastTime = performance.now();
    resetWindParticles();
    updateWindLegend();
    requestRender();
  }

  function sampleWind(x, z) {
    const field = windState.field;
    const columnValue = clamp((x - field.origin[0]) / field.dx, 0, field.width - 1);
    const rowValue = clamp((z - field.origin[1]) / field.dz, 0, field.height - 1);
    const column = Math.floor(columnValue), row = Math.floor(rowValue);
    const nextColumn = Math.min(column + 1, field.width - 1);
    const nextRow = Math.min(row + 1, field.height - 1);
    const tx = columnValue - column, tz = rowValue - row;
    const interpolate = values => {
      const top = (values[row * field.width + column] || 0) * (1 - tx) + (values[row * field.width + nextColumn] || 0) * tx;
      const bottom = (values[nextRow * field.width + column] || 0) * (1 - tx) + (values[nextRow * field.width + nextColumn] || 0) * tx;
      return top * (1 - tz) + bottom * tz;
    };
    return { u: interpolate(field.u), v: interpolate(field.v), speed: interpolate(field.speed) };
  }

  function flowVelocity(x, z, now) {
    const sampled = sampleWind(x, z);
    const speed = Math.max(0.1, Math.hypot(sampled.u, sampled.v));
    let dx = sampled.u / speed;
    let dz = sampled.v / speed;
    // A very small, stable curl keeps neighbouring traces visually distinct.
    // Kept small now that the field itself carries real terrain-driven
    // direction/speed variation -- it used to be the only source of visual
    // structure over an otherwise perfectly uniform field.
    const curl = Math.sin(x * 0.018 + z * 0.011 + now * 0.0007) * 0.04;
    [dx, dz] = normalize([dx - dz * curl, dz + dx * curl]);
    const lookDistance = clamp(speed * 2.2, 10, 24);
    const lookX = x + dx * lookDistance;
    const lookZ = z + dz * lookDistance;
    let strongest = 0;
    let steerX = dx;
    let steerZ = dz;
    for (const id of nearbyBuildings(lookX, lookZ)) {
      const building = buildings[id];
      const inside = pointInPolygon(lookX, lookZ, building.ring);
      const boundary = nearestBoundary(lookX, lookZ, building.ring);
      const influence = 18;
      if (!inside && boundary.distance >= influence) continue;
      let outwardX = inside ? boundary.x - lookX : lookX - boundary.x;
      let outwardZ = inside ? boundary.z - lookZ : lookZ - boundary.z;
      const outwardLength = Math.hypot(outwardX, outwardZ) || 1;
      outwardX /= outwardLength;
      outwardZ /= outwardLength;
      let tangentX = -outwardZ;
      let tangentZ = outwardX;
      if (tangentX * dx + tangentZ * dz < 0) { tangentX = -tangentX; tangentZ = -tangentZ; }
      const strength = inside ? 1 : clamp((influence - boundary.distance) / influence, 0, 1);
      if (strength <= strongest) continue;
      strongest = strength;
      const blended = normalize([
        dx * (1 - strength) + tangentX * strength * 1.35 + outwardX * strength * 0.5,
        dz * (1 - strength) + tangentZ * strength * 1.35 + outwardZ * strength * 0.5,
      ]);
      steerX = blended[0];
      steerZ = blended[1];
    }
    let adjustedSpeed = sampled.speed || speed;

    // Tree crowns are porous obstacles: particles pass through them, but slow
    // and spread around the canopy and through a short downstream wake.
    for (const id of nearbyTrees(x, z)) {
      const tree = trees[id];
      const relativeX = x - tree.x, relativeZ = z - tree.z;
      const downstream = relativeX * steerX + relativeZ * steerZ;
      const crosswind = relativeX * -steerZ + relativeZ * steerX;
      const canopy = Math.max(tree.radius, 3);
      const inCanopy = Math.hypot(relativeX, relativeZ) < canopy;
      const inWake = downstream > 0 && downstream < canopy * 4 && Math.abs(crosswind) < canopy * (1 + downstream / (canopy * 4));
      if (!inCanopy && !inWake) continue;
      const drag = inCanopy ? 0.48 : 0.72 + 0.22 * downstream / (canopy * 4);
      adjustedSpeed *= drag;
      const side = crosswind >= 0 ? 1 : -1;
      const spread = inCanopy ? 0.22 : 0.12 * (1 - downstream / (canopy * 4));
      [steerX, steerZ] = normalize([steerX - steerZ * side * spread, steerZ + steerX * side * spread]);
    }

    // Add a bounded, deterministic recirculation cue immediately downstream
    // of nearby buildings. Solid collision handling remains below in advection.
    for (const id of nearbyBuildings(x, z)) {
      const building = buildings[id];
      const relativeX = x - building.x, relativeZ = z - building.z;
      const downstream = relativeX * steerX + relativeZ * steerZ;
      const crosswind = relativeX * -steerZ + relativeZ * steerX;
      const reach = clamp(building.radius * 2.4, 18, 70);
      if (downstream <= building.radius * 0.35 || downstream >= reach || Math.abs(crosswind) >= building.radius * 1.2) continue;
      const wake = (1 - downstream / reach) * (1 - Math.abs(crosswind) / (building.radius * 1.2));
      const side = crosswind >= 0 ? 1 : -1;
      adjustedSpeed *= 1 - wake * 0.55;
      [steerX, steerZ] = normalize([
        steerX * (1 - wake * 0.22) - steerZ * side * wake * 0.62,
        steerZ * (1 - wake * 0.22) + steerX * side * wake * 0.62,
      ]);
    }
    return { u: steerX * adjustedSpeed, v: steerZ * adjustedSpeed, speed: adjustedSpeed };
  }

  function windVolume() {
    const half = windState.size * 0.5;
    const bottom = [[windState.center[0] - half, terrainHeightAt(windState.center[0] - half, windState.center[1] - half) + 2, windState.center[1] - half], [windState.center[0] + half, terrainHeightAt(windState.center[0] + half, windState.center[1] - half) + 2, windState.center[1] - half], [windState.center[0] + half, terrainHeightAt(windState.center[0] + half, windState.center[1] + half) + 2, windState.center[1] + half], [windState.center[0] - half, terrainHeightAt(windState.center[0] - half, windState.center[1] + half) + 2, windState.center[1] + half]];
    const top = bottom.map(([x, y, z]) => [x, y + 45, z]);
    return [...bottom, ...top];
  }

  function windBoxScreenBounds(project) {
    const points = windVolume().map(project).filter(Boolean);
    if (!points.length) return null;
    return {
      left: Math.min(...points.map(point => point[0])),
      right: Math.max(...points.map(point => point[0])),
      top: Math.min(...points.map(point => point[1])),
      bottom: Math.max(...points.map(point => point[1])),
    };
  }

  function windResizeHandle(project) {
    return project(windVolume()[6]);
  }

  function drawWindBox(project, projectPolygon) {
    if (!windState.enabled) return;
    const volume = windVolume();
    const vertices = volume.map(project);
    const faces = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const domainAlpha = windState.field && !windState.moveMode ? 0.035 : 0.25;
    context.fillStyle = `rgba(242, 164, 73, ${domainAlpha})`;
    for (const face of faces) {
      const points = projectPolygon(face.map(index => volume[index]));
      if (path(points)) context.fill();
    }
    const editingDomain = windState.moveMode || !windState.field;
    context.strokeStyle = editingDomain ? 'rgba(255, 255, 255, 0.96)' : 'rgba(255, 255, 255, 0.34)';
    context.lineWidth = editingDomain ? 2.4 : 1.2;
    context.setLineDash([]);
    for (const [from, to] of edges) {
      if (!vertices[from] || !vertices[to]) continue;
      context.beginPath();
      context.moveTo(vertices[from][0], vertices[from][1]);
      context.lineTo(vertices[to][0], vertices[to][1]);
      context.stroke();
    }
    const label = vertices[4] || vertices[0];
    if (label) { context.fillStyle = '#ffffff'; context.font = '12px system-ui'; context.fillText(windState.moveMode ? 'domain editing · drag to move' : 'wind analysis domain', label[0] + 8, label[1] - 8); }
    const handle = vertices[6];
    if (handle && windState.moveMode) {
      context.fillStyle = '#f4a84f';
      context.strokeStyle = '#ffffff';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(handle[0], handle[1], 7, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.fillStyle = '#ffffff';
      context.fillText('resize', handle[0] + 11, handle[1] + 4);
    }
  }

  function windHeatColor(value, minimum, maximum, alpha) {
    const stops = [
      [0.00, [32, 85, 214]],
      [0.25, [34, 199, 238]],
      [0.50, [61, 213, 121]],
      [0.75, [244, 218, 69]],
      [1.00, [239, 59, 45]],
    ];
    const t = clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
    let upper = 1;
    while (upper < stops.length - 1 && t > stops[upper][0]) upper += 1;
    const lower = upper - 1;
    const amount = (t - stops[lower][0]) / Math.max(stops[upper][0] - stops[lower][0], 0.001);
    const color = stops[lower][1].map((channel, index) => Math.round(channel + (stops[upper][1][index] - channel) * amount));
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
  }

  function heatColor(value, minimum, maximum, alpha) {
    const stops = [
      [0.00, [43, 80, 190]],
      [0.20, [45, 174, 222]],
      [0.42, [116, 207, 72]],
      [0.64, [255, 226, 65]],
      [0.82, [255, 150, 25]],
      [1.00, [224, 48, 32]],
    ];
    const t = clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
    let upper = 1;
    while (upper < stops.length - 1 && t > stops[upper][0]) upper += 1;
    const lower = upper - 1;
    const amount = (t - stops[lower][0]) / Math.max(stops[upper][0] - stops[lower][0], 0.001);
    const color = stops[lower][1].map((channel, index) => Math.round(channel + (stops[upper][1][index] - channel) * amount));
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
  }

  function drawHeatGeometry(geometry, project, value, minimum, maximum) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const polygon of polygons) {
      const rings = polygon.map(ring => ring.map(([x, z]) => project([x, terrainHeightAt(x, z) + 0.3, z])));
      if (!rings.length || rings[0].some(point => !point)) continue;
      context.beginPath();
      for (const ring of rings) {
        if (ring.some(point => !point)) continue;
        context.moveTo(ring[0][0], ring[0][1]);
        for (let index = 1; index < ring.length; index += 1) context.lineTo(ring[index][0], ring[index][1]);
        context.closePath();
      }
      context.fillStyle = heatColor(value, minimum, maximum, 0.78);
      context.fill('evenodd');
    }
  }

  function drawHeatmap(project, projectPolygon) {
    if (shadowState.enabled) return;
    const data = heatState.enabled ? heatState.data : null;
    if (!data?.features?.length || !data.range) return;
    context.save();
    const colorRange = data.color_range || data.range;
    const [left, bottom, right, top] = manifest.bounds;
    const boundary = [[left, terrainHeightAt(left, -top) + 0.25, -top], [right, terrainHeightAt(right, -top) + 0.25, -top], [right, terrainHeightAt(right, -bottom) + 0.25, -bottom], [left, terrainHeightAt(left, -bottom) + 0.25, -bottom]];
    const clipped = projectPolygon(boundary);
    if (path(clipped)) {
      context.clip();
      // The source product can contain small no-data holes between adjacent
      // zones. Paint a continuous neutral heat base first so those holes do
      // not expose the dark scene background at oblique camera angles.
      const baseValue = (colorRange.min + colorRange.max) * 0.5;
      context.fillStyle = heatColor(baseValue, colorRange.min, colorRange.max, 0.94);
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    const paths = Array.from({ length: 64 }, () => new Path2D());
    for (const feature of data.features) {
      const value = feature.value;
      if (value == null) continue;
      const bin = clamp(Math.floor((value - colorRange.min) / Math.max(colorRange.max - colorRange.min, 0.001) * 63), 0, 63);
      const pathValue = paths[bin];
      const polygons = feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
      for (const polygon of polygons) {
        for (const ring of polygon) {
          const points = ring.map(([x, z]) => project([x, terrainHeightAt(x, z) + 0.3, z]));
          if (points.some(point => !point)) continue;
          pathValue.moveTo(points[0][0], points[0][1]);
          for (let index = 1; index < points.length; index += 1) pathValue.lineTo(points[index][0], points[index][1]);
          pathValue.closePath();
        }
      }
    }
    // Vector zones keep boundaries crisp and avoid the slow, blurry raster
    // pass. A fine 64-bin ramp still gives a continuous-looking heat scale.
    for (let bin = 0; bin < paths.length; bin += 1) {
      const value = colorRange.min + (bin + 0.5) / paths.length * (colorRange.max - colorRange.min);
      context.fillStyle = heatColor(value, colorRange.min, colorRange.max, 0.84);
      context.fill(paths[bin], 'evenodd');
    }
    context.restore();
  }

  async function loadHeat(metric = heatState.metric) {
    heatState.metric = metric;
    heatStatus.textContent = 'Loading heat zones…';
    try {
      const response = await fetch(`${windApi}/heat/zones?metric=${encodeURIComponent(metric)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      heatState.data = await response.json();
      heatState.baselineData = heatState.data;
      const range = heatState.data.color_range || heatState.data.range;
      const scale = heatState.data.color_scale || {};
      heatLegendMin.textContent = range
        ? `${scale.bottom_band_label || 'Bottom 10%'} ≤ ${Number(range.min).toFixed(1)}°C`
        : 'Bottom 10%';
      heatLegendMax.textContent = range
        ? `${scale.top_band_label || 'Top 10%'} ≥ ${Number(range.max).toFixed(1)}°C`
        : 'Top 10%';
      const window = heatState.data.window?.label || 'current product';
      heatStatus.textContent = heatState.data.count
        ? `${heatState.data.count} heat zones · ${window} · percentile colour scale`
        : 'No surface-temperature values in this product.';
    } catch (error) {
      heatState.data = null;
      heatLegendMin.textContent = '—';
      heatLegendMax.textContent = '—';
      heatStatus.textContent = `Heat data unavailable (${error.message})`;
    }
    requestRender();
  }

  function drawWindHeatmap(project, projectPolygon) {
    if (shadowState.enabled) return;
    const field = windState.enabled ? windState.field : null;
    if (!field?.speed?.length) return;
    const minimum = Math.min(...field.speed);
    const maximum = Math.max(...field.speed, windState.speed * 0.1, 0.1);
    const stride = Math.max(1, Math.ceil(Math.max(field.width, field.height) / 20));
    const domain = windVolume().slice(0, 4).map(([x, , z]) => [x, terrainHeightAt(x, z) + 1.0, z]);
    const clippedDomain = projectPolygon(domain);
    if (!path(clippedDomain)) return;
    context.save();
    context.clip();
    context.globalCompositeOperation = 'source-over';
    for (let row = 0; row < field.height; row += stride) {
      for (let column = 0; column < field.width; column += stride) {
        const x = field.origin[0] + (column + 0.5) * field.dx;
        const z = field.origin[1] + (row + 0.5) * field.dz;
        const center = project([x, terrainHeightAt(x, z) + 1.0, z]);
        const xEdge = project([x + field.dx * stride * 1.5, terrainHeightAt(x + field.dx * stride * 1.5, z) + 1.0, z]);
        const zEdge = project([x, terrainHeightAt(x, z + field.dz * stride * 1.5) + 1.0, z + field.dz * stride * 1.5]);
        if (!center || !xEdge || !zEdge) continue;
        const radius = Math.max(5, Math.max(Math.hypot(xEdge[0] - center[0], xEdge[1] - center[1]), Math.hypot(zEdge[0] - center[0], zEdge[1] - center[1])));
        const value = sampleWind(x, z).speed;
        const gradient = context.createRadialGradient(center[0], center[1], 0, center[0], center[1], radius);
        gradient.addColorStop(0, windHeatColor(value, minimum, maximum, 0.68));
        gradient.addColorStop(0.58, windHeatColor(value, minimum, maximum, 0.48));
        gradient.addColorStop(1, windHeatColor(value, minimum, maximum, 0.16));
        context.fillStyle = gradient;
        context.fillRect(center[0] - radius, center[1] - radius, radius * 2, radius * 2);
      }
    }
    context.restore();
  }

  function drawWindParticles(project) {
    if (!windState.enabled || !windState.field) return;
    const now = performance.now();
    const elapsed = Math.min(0.08, (now - windState.lastTime) / 1000);
    windState.lastTime = now;
    const field = windState.field;
    const minX = field.origin[0], maxX = minX + field.width * field.dx;
    const minZ = field.origin[1], maxZ = minZ + field.height * field.dz;
    context.save();
    context.globalCompositeOperation = 'lighter';
    for (const particle of windState.particles) {
      const sampled = flowVelocity(particle.x, particle.z, now);
      particle.previousX = particle.x;
      particle.previousZ = particle.z;
      const midX = particle.x + sampled.u * elapsed * 3.25;
      const midZ = particle.z + sampled.v * elapsed * 3.25;
      const midpoint = flowVelocity(midX, midZ, now + elapsed * 500);
      const nextX = particle.x + midpoint.u * elapsed * 6.5;
      const nextZ = particle.z + midpoint.v * elapsed * 6.5;
      if (containingBuilding(nextX, nextZ)) {
        // Never allow traces to pool inside solid geometry. Steering normally
        // bends them around a facade; a missed corner is recycled somewhere
        // else in the domain (not always back at the inflow edge) so traces
        // stay spread through the whole box instead of piling up upstream.
        Object.assign(particle, spawnParticle(field, true));
      } else {
        particle.x = nextX;
        particle.z = nextZ;
        particle.age += elapsed;
      }
      if (particle.age > 10 || particle.x < minX || particle.x > maxX || particle.z < minZ || particle.z > maxZ) {
        Object.assign(particle, spawnParticle(field, true));
      }
      particle.trail.push([particle.x, particle.z]);
      if (particle.trail.length > 32) particle.trail.shift();
      const projectedTrail = particle.trail.map(([x, z]) => project([x, terrainHeightAt(x, z) + 4, z])).filter(Boolean);
      if (projectedTrail.length < 2) continue;
      const speedAlpha = clamp(midpoint.speed / Math.max(windState.speed, 0.1), 0.08, 1.35);
      const hue = 205 - clamp(speedAlpha, 0, 1) * 155;
      context.strokeStyle = `hsla(${hue}, 94%, 66%, ${0.42 + clamp(speedAlpha, 0, 1) * 0.52})`;
      context.lineWidth = 1.25 + clamp(speedAlpha, 0, 1) * 1.55;
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(projectedTrail[0][0], projectedTrail[0][1]);
      for (let index = 1; index < projectedTrail.length; index += 1) context.lineTo(projectedTrail[index][0], projectedTrail[index][1]);
      context.stroke();
      const head = projectedTrail[projectedTrail.length - 1];
      context.fillStyle = 'rgba(241, 255, 255, 0.9)';
      context.fillRect(head[0] - 1, head[1] - 1, 2, 2);
    }
    context.restore();
    scheduleFrame();
  }

  function drawWindDirection(project) {
    if (!windState.enabled || !windState.field) return;
    const angle = windState.direction * Math.PI / 180;
    // Arrow points the way the flow actually travels (opposite the FROM bearing).
    const dx = -Math.sin(angle), dz = Math.cos(angle);
    const length = clamp(windState.size * 0.16, 30, 90);
    const y = terrainHeightAt(windState.center[0], windState.center[1]) + 9;
    const start = project([windState.center[0] - dx * length * 0.5, y, windState.center[1] - dz * length * 0.5]);
    const end = project([windState.center[0] + dx * length * 0.5, y, windState.center[1] + dz * length * 0.5]);
    if (!start || !end) return;
    const screenAngle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    context.strokeStyle = '#ff5d4a';
    context.fillStyle = '#ff5d4a';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(start[0], start[1]);
    context.lineTo(end[0], end[1]);
    context.stroke();
    context.beginPath();
    context.moveTo(end[0], end[1]);
    context.lineTo(end[0] - Math.cos(screenAngle - 0.55) * 10, end[1] - Math.sin(screenAngle - 0.55) * 10);
    context.lineTo(end[0] - Math.cos(screenAngle + 0.55) * 10, end[1] - Math.sin(screenAngle + 0.55) * 10);
    context.closePath();
    context.fill();
    context.font = 'bold 11px system-ui';
    context.fillText(`${Math.round(windState.direction)}°`, start[0], start[1] - 7);
  }

  addEventListener('climate-wind-settings', event => {
    Object.assign(windState, event.detail || {});
    requestRender();
  });
  addEventListener('climate-wind-field', event => {
    Object.assign(windState, event.detail || {});
    resetWindParticles();
    updateWindLegend();
    requestRender();
  });

  function markInteraction() {
    interactionUntil = performance.now() + 140;
    clearTimeout(settleTimer);
    // Render once more at full detail when scrolling has stopped.
    settleTimer = setTimeout(requestRender, 155);
  }

  function fitScene() {
    camera.target = [0, 20, 0];
    camera.distance = Math.max(500, Math.min(2500, Math.hypot(manifest.bounds[2] - manifest.bounds[0], manifest.bounds[3] - manifest.bounds[1]) * 0.82));
    camera.elevation = 0.68;
    requestRender();
  }

  function applyViewFromUrl() {
    const parameters = new URLSearchParams(location.search);
    for (const property of ['distance', 'elevation', 'azimuth']) {
      const value = Number(parameters.get(property));
      if (parameters.has(property) && Number.isFinite(value)) camera[property] = value;
    }
  }

  function resize() {
    // A 1x canvas is intentional here: this is the non-GPU compatibility
    // renderer, so avoiding high-DPI overdraw keeps interaction responsive.
    const ratio = 1;
    const width = Math.floor(innerWidth * ratio);
    const height = Math.floor(innerHeight * ratio);
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    sceneCanvas.width = width;
    sceneCanvas.height = height;
    return true;
  }

  function terrainHeightAt(x, z) {
    const [left, bottom, right, top] = manifest.bounds;
    const u = clamp((x - left) / (right - left), 0, 1) * (terrain.columns - 1);
    const v = clamp((z + top) / (top - bottom), 0, 1) * (terrain.rows - 1);
    const column = Math.min(terrain.columns - 2, Math.floor(u));
    const row = Math.min(terrain.rows - 2, Math.floor(v));
    const tx = u - column;
    const ty = v - row;
    const at = (r, c) => terrain.heights[r * terrain.columns + c];
    const topValue = at(row, column) * (1 - tx) + at(row, column + 1) * tx;
    const bottomValue = at(row + 1, column) * (1 - tx) + at(row + 1, column + 1) * tx;
    return topValue * (1 - ty) + bottomValue * ty;
  }

  // NOAA's compact solar-position approximation, evaluated for Cape Town
  // (SAST, UTC+2). The renderer's local axes are east (x), up (y), and south
  // (z), hence the negated north component below.
  function sunPosition() {
    const [year, month, day] = shadowState.date.split('-').map(Number);
    const date = new Date(Date.UTC(year || 2026, (month || 7) - 1, day || 27));
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
    const hour = shadowState.minutes / 60;
    const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (hour - 12) / 24);
    const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const latitude = -33.9249 * Math.PI / 180;
    const solarMinutes = shadowState.minutes + equation + 4 * 18.4241 - 120;
    const hourAngle = (solarMinutes / 4 - 180) * Math.PI / 180;
    const cosineZenith = clamp(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle), -1, 1);
    const altitude = Math.asin(cosineZenith);
    const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) + Math.PI) % (2 * Math.PI);
    return {
      altitude,
      azimuth,
      vector: [Math.sin(azimuth) * Math.cos(altitude), Math.sin(altitude), -Math.cos(azimuth) * Math.cos(altitude)],
    };
  }

  function updateSunStatus() {
    if (!sunStatus) return;
    const sun = sunPosition();
    const hours = String(Math.floor(shadowState.minutes / 60)).padStart(2, '0');
    const minutes = String(shadowState.minutes % 60).padStart(2, '0');
    if (sunTimeValue) sunTimeValue.textContent = `${hours}:${minutes}`;
    sunStatus.textContent = sun.altitude <= 0
      ? 'Sun is below the horizon at this time.'
      : `Sun altitude ${Math.round(sun.altitude * 180 / Math.PI)}° · click Generate shadows when ready.`;
  }

  function shadowGroundPoint(x, y, z, sun) {
    // Intersect a ray from the elevated point toward the LiDAR DTM. Two small
    // correction passes make the projected end follow sloping terrain rather
    // than dropping every shadow onto a flat plane.
    let distance = Math.max(0, (y - terrainHeightAt(x, z)) / Math.max(sun.vector[1], 0.03));
    let targetX = x - sun.vector[0] * distance;
    let targetZ = z - sun.vector[2] * distance;
    for (let pass = 0; pass < 2; pass += 1) {
      distance = Math.max(0, (y - terrainHeightAt(targetX, targetZ)) / Math.max(sun.vector[1], 0.03));
      targetX = x - sun.vector[0] * distance;
      targetZ = z - sun.vector[2] * distance;
    }
    return [targetX, terrainHeightAt(targetX, targetZ) + 0.35, targetZ];
  }

  async function generateShadows() {
    if (!shadowState.enabled) setShadowMode(true);
    const sun = sunPosition();
    if (sun.altitude <= 0.008) {
      shadowState.generated = null;
      updateSunStatus();
      requestRender();
      return;
    }
    const generationToken = ++shadowGenerationToken;
    sunGenerate.disabled = true;
    sunGenerate.textContent = 'Generating…';
    // Let the disabled/generating state paint before beginning the geometry
    // work, then yield between batches so the browser event loop stays live.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (generationToken !== shadowGenerationToken) return;
    // Geometry is generated in world space once. Subsequent orbit/zoom frames
    // only project these already-computed polygons, which keeps interaction
    // responsive even with thousands of source features.
    const buildingPolygons = [];
    for (let buildingIndex = 0; buildingIndex < buildings.length; buildingIndex += 1) {
      const building = buildings[buildingIndex];
      const [, height] = building.value;
      const ring = building.shadowRing;
      const ground = ring.map(([x, z]) => [x, terrainHeightAt(x, z) + 0.35, z]);
      const cast = ring.map(([x, z]) => shadowGroundPoint(x, building.ground + height, z, sun));
      // Use one conservative outer ground silhouette per caster. This avoids
      // drawing one overlapping quad per footprint edge on every settled
      // camera frame while retaining a clean hard shade boundary.
      const points = convexGroundHull(ground.concat(cast));
      const minX = Math.min(...points.map(point => point[0]));
      const maxX = Math.max(...points.map(point => point[0]));
      const minZ = Math.min(...points.map(point => point[2]));
      const maxZ = Math.max(...points.map(point => point[2]));
      const centerX = (minX + maxX) * 0.5;
      const centerZ = (minZ + maxZ) * 0.5;
      buildingPolygons.push({
        points,
        x: centerX,
        z: centerZ,
        y: terrainHeightAt(centerX, centerZ) + 0.35,
        radius: Math.hypot(maxX - minX, maxZ - minZ) * 0.5,
      });
      if (buildingIndex && buildingIndex % 600 === 0) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (generationToken !== shadowGenerationToken) return;
      }
    }
    if (generationToken !== shadowGenerationToken) return;
    const canopyPolygons = [];
    for (const canopy of canopies) {
      const rings = canopy.rings.map(ring => ring.map(([x, z]) => shadowGroundPoint(x, canopy.crownTop, z, sun)));
      if (rings[0]?.length >= 3) canopyPolygons.push({ rings, x: canopy.x, z: canopy.z });
    }
    shadowState.generated = { sun, buildingPolygons, canopyPolygons };
    sunGenerate.disabled = false;
    sunGenerate.textContent = 'Regenerate shadows';
    sunStatus.textContent = `${buildingPolygons.length} building + ${canopyPolygons.length} canopy shadows · ${Math.round(sun.altitude * 180 / Math.PI)}° sun altitude.`;
    requestRender();
  }

  function appendSolidPolygon(target, points) {
    if (points.length < 3 || points.some(point => !point)) return;
    // Footprint winding varies in the source data. Normalizing every subpath
    // prevents overlapping facade sweeps from cancelling one another and
    // punching false sunlit gaps into an otherwise continuous shadow.
    let signedArea = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      signedArea += current[0] * next[1] - next[0] * current[1];
    }
    const ordered = signedArea < 0 ? points.slice().reverse() : points;
    target.moveTo(ordered[0][0], ordered[0][1]);
    for (let index = 1; index < ordered.length; index += 1) target.lineTo(ordered[index][0], ordered[index][1]);
    target.closePath();
  }

  function appendRawPolygon(target, points) {
    if (points.length < 3 || points.some(point => !point)) return;
    target.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) target.lineTo(points[index][0], points[index][1]);
    target.closePath();
  }

  function drawGeneratedShadows(project, focal, simplified) {
    const generated = shadowState.enabled ? shadowState.generated : null;
    // Each caster is now a compact outer silhouette, so it is inexpensive
    // enough to reproject during camera movement without a stale screen cache.
    if (!generated) return;
    // The scene's terrain is already clipped to the CBD boundary. Do not
    // apply another projected clip here: at steep camera angles that second
    // path can discard valid ground polygons even though they are in view.
    context.save();
    const groundShadows = new Path2D();
    for (const polygon of generated.buildingPolygons) {
      const center = project([polygon.x, polygon.y, polygon.z]);
      if (!center) continue;
      const screenRadius = Math.max(1, polygon.radius * focal / center[2]);
      if (center[0] < -screenRadius || center[0] > canvas.width + screenRadius
        || center[1] < -screenRadius || center[1] > canvas.height + screenRadius) continue;
      // During interaction, very small distant shadows cost the same path and
      // projection work as prominent ones but contribute little visually.
      // Keep the large anchors live; the complete set returns on settle.
      if (simplified && screenRadius < 35) continue;
      appendSolidPolygon(groundShadows, polygon.points.map(project));
    }
    for (const canopy of generated.canopyPolygons || []) {
      for (const ring of canopy.rings) appendRawPolygon(groundShadows, ring.map(project));
    }
    context.fillStyle = 'rgba(10, 18, 24, 0.76)';
    context.fill(groundShadows, 'nonzero');
    context.restore();
  }

  // Reject features whose conservative screen bounds are outside the canvas
  // before projecting their individual vertices or adding them to the depth sort.
  function isInView(x, y, z, radius, project, focal) {
    const point = project([x, y, z]);
    if (!point) return true;
    const screenRadius = Math.max(20, radius * focal / point[2]);
    return point[0] >= -screenRadius && point[0] <= canvas.width + screenRadius
      && point[1] >= -screenRadius && point[1] <= canvas.height + screenRadius;
  }

  function cameraProjection() {
    const horizontal = Math.cos(camera.elevation) * camera.distance;
    const eye = [
      camera.target[0] + Math.cos(camera.azimuth) * horizontal,
      camera.target[1] + Math.sin(camera.elevation) * camera.distance,
      camera.target[2] + Math.sin(camera.azimuth) * horizontal,
    ];
    const forward = normalize(camera.target.map((value, index) => value - eye[index]));
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const focal = canvas.height * 1.18;
    const toCamera = point => {
      const relative = point.map((value, index) => value - eye[index]);
      return [dot(relative, right), dot(relative, up), dot(relative, forward)];
    };
    const projectCamera = ([x, y, depth]) => [
      canvas.width * 0.5 + x * focal / depth,
      canvas.height * 0.52 - y * focal / depth,
      depth,
    ];
    const project = point => {
      const cameraPoint = toCamera(point);
      if (cameraPoint[2] <= 1) return null;
      return projectCamera(cameraPoint);
    };
    const screenToPlane = (screenX, screenY, planeY) => {
      const cameraX = (screenX - canvas.width * 0.5) / focal;
      const cameraY = -(screenY - canvas.height * 0.52) / focal;
      const direction = normalize([
        right[0] * cameraX + up[0] * cameraY + forward[0],
        right[1] * cameraX + up[1] * cameraY + forward[1],
        right[2] * cameraX + up[2] * cameraY + forward[2],
      ]);
      if (Math.abs(direction[1]) < 1e-6) return null;
      const distance = (planeY - eye[1]) / direction[1];
      if (distance <= 0) return null;
      return [eye[0] + direction[0] * distance, eye[2] + direction[2] * distance];
    };
    const projectPolygon = points => {
      const source = points.map(toCamera);
      const clipped = [];
      let previous = source[source.length - 1];
      for (const current of source) {
        const previousInside = previous[2] > 1;
        const currentInside = current[2] > 1;
        if (previousInside !== currentInside) {
          const ratio = (1 - previous[2]) / (current[2] - previous[2]);
          clipped.push(previous.map((value, index) => value + (current[index] - value) * ratio));
        }
        if (currentInside) clipped.push(current);
        previous = current;
      }
      return clipped.length >= 3 ? clipped.map(projectCamera) : [];
    };
    return { eye, forward, project, projectPolygon, screenToPlane, focal };
  }

  function path(points) {
    if (!points.length || points.some(point => !point)) return false;
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1]);
    context.closePath();
    return true;
  }

  // Kept for reference/debugging: the normal renderer below batches the same
  // geometry into depth buckets, so it does not need one fill per building.
  function drawBuilding(building, project) {
    const [ground, height, ring] = building;
    const base = ring.map(([x, z]) => project([x, ground, z]));
    const roof = ring.map(([x, z]) => project([x, ground + height, z]));
    if (base.some(point => !point) || roof.some(point => !point)) return;
    const screenHeight = Math.max(...base.map((point, index) => Math.abs(point[1] - roof[index][1])));
    if (screenHeight > 2.2) {
      for (let index = 0; index < ring.length; index += 1) {
        const next = (index + 1) % ring.length;
        if (!path([base[index], base[next], roof[next], roof[index]])) continue;
        const shade = 48 + ((index * 17 + ring.length * 7) % 16);
        context.fillStyle = `rgb(${shade}, ${shade + 5}, ${shade + 10})`;
        context.fill();
      }
    }
    if (path(roof)) {
      context.fillStyle = COLORS.roof;
      context.fill();
      if (screenHeight > 2.8) {
        context.strokeStyle = COLORS.roofEdge;
        context.lineWidth = 0.8;
        context.stroke();
      }
    }
  }

  // Drag/zoom redraws every visible building each frame; even a single
  // batched fill() per building (~2 calls x ~2300 buildings) is enough
  // draw-call overhead to feel janky on Canvas 2D. This collapses the
  // *entire* visible skyline into four coarse wall-light paths plus one roof
  // path, while still
  // normalizing each wall quad's winding so overlapping quads (from the
  // same or different buildings, common at oblique angles) reinforce
  // instead of cancelling under the nonzero fill rule. Depth ordering
  // against trees is sacrificed for this one frame, which is invisible
  // during fast camera motion and gets corrected on the settled redraw.
  function drawBuildingsBatched(buildingList, project, forward) {
    const sun = shadowState.generated?.sun || sunPosition();
    const wallPaths = Array.from({ length: 4 }, () => new Path2D());
    const roofRings = [];
    for (const building of buildingList) {
      const [ground, height] = building.value;
      const ring = building.shadowRing || building.value[2];
      const roof = ring.map(([x, z]) => project([x, ground + height, z]));
      if (roof.some(point => !point)) continue;
      const centerBase = project([building.x, ground, building.z]);
      const centerRoof = project([building.x, ground + height, building.z]);
      if (!centerBase || !centerRoof) continue;
      const screenHeight = Math.abs(centerBase[1] - centerRoof[1]);
      if (screenHeight > 2.2) {
        const base = [];
        for (let index = 0; index < ring.length; index += 1) {
          const next = (index + 1) % ring.length;
          const dx = ring[next][0] - ring[index][0];
          const dz = ring[next][1] - ring[index][1];
          const midpointX = (ring[index][0] + ring[next][0]) * 0.5;
          const midpointZ = (ring[index][1] + ring[next][1]) * 0.5;
          let normalX = dz;
          let normalZ = -dx;
          if ((midpointX - building.x) * normalX + (midpointZ - building.z) * normalZ < 0) {
            normalX = -normalX;
            normalZ = -normalZ;
          }
          // Back-facing facade quads are completely hidden by the building.
          // Avoid projecting and path-building them in the first place.
          if (normalX * -forward[0] + normalZ * -forward[2] <= 0) continue;
          base[index] ||= project([ring[index][0], ground, ring[index][1]]);
          base[next] ||= project([ring[next][0], ground, ring[next][1]]);
          if (!base[index] || !base[next]) continue;
          const quad = [base[index], base[next], roof[next], roof[index]];
          const direct = Math.max(
            0,
            (normalX * sun.vector[0] + normalZ * sun.vector[2]) / (Math.hypot(normalX, normalZ) || 1),
          );
          const shadeBand = Math.min(wallPaths.length - 1, Math.floor(direct * wallPaths.length));
          appendSolidPolygon(wallPaths[shadeBand], quad);
        }
      }
      roofRings.push(roof);
    }
    const wallColors = ['#aab1b4', '#bec5c8', '#d2dadd', '#e6ecee'];
    for (let band = 0; band < wallPaths.length; band += 1) {
      context.fillStyle = wallColors[band];
      context.fill(wallPaths[band]);
    }
    context.beginPath();
    for (const roof of roofRings) {
      context.moveTo(roof[0][0], roof[0][1]);
      for (let i = 1; i < roof.length; i += 1) context.lineTo(roof[i][0], roof[i][1]);
      context.closePath();
    }
    context.fillStyle = shadowState.enabled ? '#f2f4f3' : COLORS.roof;
    context.fill();
  }

  function drawBuildingsDuringInteraction(buildingList, project) {
    // Use tiny extruded screen-space blocks instead of center lines. This is
    // still only two projections per building, but preserves height and mass
    // in low-angle views while the accurate mesh waits for camera settle.
    const wallPaths = [new Path2D(), new Path2D(), new Path2D()];
    const roofPath = new Path2D();
    for (const building of buildingList) {
      const [ground, height] = building.value;
      const base = project([building.x, ground, building.z]);
      const roof = project([building.x, ground + height, building.z]);
      if (!base || !roof) continue;
      const halfWidth = clamp(building.radius * canvas.height * 1.18 / roof[2] * 0.72, 1.5, 28);
      const wallBand = height > 45 ? 2 : height > 18 ? 1 : 0;
      const top = Math.min(base[1], roof[1]);
      const screenHeight = Math.max(1.5, Math.abs(base[1] - roof[1]));
      const left = (base[0] + roof[0]) * 0.5 - halfWidth;
      wallPaths[wallBand].rect(left, top, halfWidth * 2, screenHeight);
      roofPath.rect(roof[0] - halfWidth, roof[1] - 1, halfWidth * 2, 2);
    }
    const wallColors = ['#aeb5b8', '#c5cdd0', '#dce2e4'];
    for (let band = 0; band < wallPaths.length; band += 1) {
      context.fillStyle = wallColors[band];
      context.fill(wallPaths[band]);
    }
    context.fillStyle = '#f2f4f3';
    context.fill(roofPath);
  }

  // Canvas 2D spends much more time processing thousands of tiny fill() calls
  // than it does processing one larger path. Keep the full walls and roofs,
  // but batch them into coarse depth layers. Eight layers are enough to keep
  // trees and nearby buildings in the right visual order while reducing the
  // building draw-call count from thousands to a manageable few hundred.
  function drawBuildingsByDepth(buildingList, project, treeFeatures) {
    const sun = null;
    const buckets = Array.from({ length: 128 }, () => ({ buildings: [], trees: [] }));
    const features = buildingList.concat(treeFeatures);
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const feature of features) {
      minimum = Math.min(minimum, feature.depth);
      maximum = Math.max(maximum, feature.depth);
    }
    const span = Math.max(1, maximum - minimum);
    const bucketFor = depth => clamp(Math.floor((depth - minimum) / span * buckets.length), 0, buckets.length - 1);
    for (const building of buildingList) buckets[bucketFor(building.depth)].buildings.push(building);
    for (const tree of treeFeatures) buckets[bucketFor(tree.depth)].trees.push(tree);

    for (let bucketIndex = buckets.length - 1; bucketIndex >= 0; bucketIndex -= 1) {
      const bucket = buckets[bucketIndex];
      if (bucket.buildings.length) {
        const wallPaths = new Map();
        const roofPath = new Path2D();
        for (const building of bucket.buildings) {
          const [ground, height, ring] = building.value;
          const base = ring.map(([x, z]) => project([x, ground, z]));
          const roof = ring.map(([x, z]) => project([x, ground + height, z]));
          if (base.some(point => !point) || roof.some(point => !point)) continue;
          const screenHeight = Math.max(...base.map((point, index) => Math.abs(point[1] - roof[index][1])));
          if (screenHeight > 2.2) {
            for (let index = 0; index < ring.length; index += 1) {
              const next = (index + 1) % ring.length;
              let quad = [base[index], base[next], roof[next], roof[index]];
              let area = 0;
              for (let point = 0; point < quad.length; point += 1) {
                const [x1, y1] = quad[point];
                const [x2, y2] = quad[(point + 1) % quad.length];
                area += x1 * y2 - x2 * y1;
              }
              if (area < 0) quad = quad.reverse();
              const shade = 48 + ((index * 17 + ring.length * 7) % 16);
              const dx = ring[next][0] - ring[index][0];
              const dz = ring[next][1] - ring[index][1];
              const midpointX = (ring[index][0] + ring[next][0]) * 0.5;
              const midpointZ = (ring[index][1] + ring[next][1]) * 0.5;
              let normalX = dz, normalZ = -dx;
              if ((midpointX - building.x) * normalX + (midpointZ - building.z) * normalZ < 0) {
                normalX = -normalX;
                normalZ = -normalZ;
              }
              const normalLength = Math.hypot(normalX, normalZ) || 1;
              const direct = sun && sun.altitude > 0
                ? Math.max(0, (normalX * sun.vector[0] + normalZ * sun.vector[2]) / normalLength) * Math.cos(sun.altitude)
                : 0;
              const litShade = shadowState.enabled ? Math.round(172 + direct * 78) : shade;
              const key = shadowState.enabled ? `rgb(${litShade}, ${litShade + 5}, ${litShade + 10})` : shade;
              let wallPath = wallPaths.get(key);
              if (!wallPath) {
                wallPath = new Path2D();
                wallPaths.set(key, wallPath);
              }
              wallPath.moveTo(quad[0][0], quad[0][1]);
              for (let point = 1; point < quad.length; point += 1) wallPath.lineTo(quad[point][0], quad[point][1]);
              wallPath.closePath();
            }
          }
          roofPath.moveTo(roof[0][0], roof[0][1]);
          for (let point = 1; point < roof.length; point += 1) roofPath.lineTo(roof[point][0], roof[point][1]);
          roofPath.closePath();
        }
        for (const [shade, wallPath] of wallPaths) {
          context.fillStyle = heatState.enabled ? '#c9cbc7' : (shadowState.enabled ? shade : `rgb(${shade}, ${shade + 5}, ${shade + 10})`);
          context.fill(wallPath);
        }
        const roofLight = sun && sun.altitude > 0 ? 0.55 + 0.45 * Math.sin(sun.altitude) : 0.55;
        const roofChannel = shadowState.enabled ? Math.round(212 + 35 * Math.sin(sun?.altitude || 0)) : Math.round(150 * roofLight);
        context.fillStyle = heatState.enabled ? '#f1f1ed' : shadowState.enabled ? `rgb(${roofChannel}, ${roofChannel + 5}, ${roofChannel + 8})` : COLORS.roof;
        context.fill(roofPath);
      }
      // Keep tree-to-tree ordering exact inside each depth slice. This avoids
      // a nearby crown suddenly covering a farther one during camera motion.
      bucket.trees.sort((a, b) => b.depth - a.depth);
      for (const tree of bucket.trees) drawTree(tree.value, project, tree.focal);
    }
  }

  function drawTree(tree, project, focal) {
    const [x, ground, z, crownX, height, crownZ] = tree;
    const base = project([x, ground, z]);
    const crown = project([x, ground + height * 0.68, z]);
    if (!base || !crown) return;
    const radius = clamp(Math.sqrt(crownX * crownZ) * 1.4 * focal / crown[2], 1.4, 22);
    const radiusY = radius * 0.86;
    if (crown[0] < -radius || crown[0] > canvas.width + radius || crown[1] < -radiusY || crown[1] > canvas.height + radiusY) return;
    if (radius < 2.2) {
      context.fillStyle = shadowState.enabled ? '#ffffff' : COLORS.canopy;
      context.fillRect(crown[0] - 1, crown[1] - 1, 2, 2);
      return;
    }
    if (radius > 4) {
      context.strokeStyle = shadowState.enabled ? '#d2d2d2' : COLORS.trunk;
      context.lineWidth = clamp(radius * 0.13, 0.7, 2.5);
      context.beginPath();
      context.moveTo(base[0], base[1]);
      context.lineTo(crown[0], crown[1] + radiusY * 0.42);
      context.stroke();
    }
    // Two compact, near-circular layers give the 2D fallback a rounded crown.
    context.fillStyle = shadowState.enabled ? '#dedede' : (heatState.enabled ? '#4fae35' : '#1d4b2e');
    context.beginPath();
    context.ellipse(crown[0] + radius * 0.08, crown[1] + radiusY * 0.13, radius * 0.92, radiusY * 0.92, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = shadowState.enabled ? '#ffffff' : (heatState.enabled ? '#86df45' : COLORS.canopy);
    context.beginPath();
    context.ellipse(crown[0] - radius * 0.08, crown[1] - radiusY * 0.11, radius * 0.88, radiusY * 0.88, 0, 0, Math.PI * 2);
    context.fill();
  }

  function drawCanopyFootprints(project, forward) {
    if (!visibility.trees || !canopies.length) return;
    const buckets = Array.from({ length: 64 }, () => []);
    const depths = canopies.map(canopy => canopy.x * forward[0] + canopy.z * forward[2]);
    const minimum = Math.min(...depths);
    const span = Math.max(1, Math.max(...depths) - minimum);
    canopies.forEach((canopy, index) => {
      const bucket = clamp(Math.floor((depths[index] - minimum) / span * 63), 0, 63);
      buckets[bucket].push(canopy);
    });
    context.fillStyle = shadowState.enabled ? '#eef2ea' : (heatState.enabled ? '#55a84e' : '#2d653f');
    context.strokeStyle = shadowState.enabled ? '#cad4c8' : '#183d28';
    context.lineWidth = 0.5;
    for (let bucket = buckets.length - 1; bucket >= 0; bucket -= 1) {
      if (!buckets[bucket].length) continue;
      const path = new Path2D();
      for (const canopy of buckets[bucket]) {
        for (const ring of canopy.rings) {
          const points = ring.map(([x, z]) => project([x, canopy.crownTop, z]));
          appendRawPolygon(path, points);
        }
      }
      context.fill(path, 'nonzero');
      context.stroke(path);
    }
  }

  function drawTerrain(projectPolygon) {
    const [left, bottom, right, top] = manifest.bounds;
    const minZ = -top;
    const maxZ = -bottom;
    const point = (column, row, elevation) => [left + (right - left) * column / (terrain.columns - 1), elevation, minZ + (maxZ - minZ) * row / (terrain.rows - 1)];
    // Vertical perimeter faces turn the terrain into a shallow physical plinth.
    context.fillStyle = shadowState.enabled ? '#d6d6d2' : '#30383b';
    // Draw the outer rim directly from grid elevations to avoid terrain gaps.
    const edgePoint = (column, row) => point(column, row, terrain.heights[row * terrain.columns + column]);
    const side = (a, b) => {
      if (path(projectPolygon([a, b, [b[0], terrain.base, b[2]], [a[0], terrain.base, a[2]]]))) context.fill();
    };
    for (let column = 0; column < terrain.columns - 1; column += 1) {
      side(edgePoint(column, 0), edgePoint(column + 1, 0));
      side(edgePoint(column + 1, terrain.rows - 1), edgePoint(column, terrain.rows - 1));
    }
    for (let row = 0; row < terrain.rows - 1; row += 1) {
      side(edgePoint(0, row + 1), edgePoint(0, row));
      side(edgePoint(terrain.columns - 1, row), edgePoint(terrain.columns - 1, row + 1));
    }
    context.fillStyle = shadowState.enabled ? '#f5f5f0' : COLORS.terrain;
    context.beginPath();
    for (let row = 0; row < terrain.rows - 1; row += 1) {
      for (let column = 0; column < terrain.columns - 1; column += 1) {
        const points = projectPolygon([edgePoint(column, row), edgePoint(column + 1, row), edgePoint(column + 1, row + 1), edgePoint(column, row + 1)]);
        if (points.length < 3) continue;
        context.moveTo(points[0][0], points[0][1]);
        for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1]);
        context.closePath();
      }
    }
    context.fill();
  }

  function drawGrass(projectPolygon, project, focal, simplified) {
    context.fillStyle = COLORS.grass;
    for (const grassArea of grass) {
      if (!isInView(grassArea.x, terrainHeightAt(grassArea.x, grassArea.z) + 0.12, grassArea.z, grassArea.radius, project, focal)) continue;
      if (simplified && grassArea.radius < 18) continue;
      if (path(projectPolygon(grassArea.points.map(([x, z]) => [x, terrainHeightAt(x, z) + 0.12, z])))) context.fill();
    }
  }

  function roadStyle(highway) {
    const major = ['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link'];
    const secondary = ['secondary', 'secondary_link', 'tertiary'];
    return { color: major.includes(highway) ? COLORS.roadMajor : secondary.includes(highway) ? COLORS.roadSecondary : COLORS.road };
  }

  function drawRoads(project, focal, simplified) {
    const groups = new Map();
    for (const road of roads) {
      if ((road.highway === 'footway' || road.highway === 'path') && camera.distance > 1000 && !shadowState.enabled) continue;
      if (simplified && !['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary'].includes(road.highway)) continue;
      if (!isInView(road.x, terrainHeightAt(road.x, road.z) + 0.22, road.z, road.radius + road.width, project, focal)) continue;
      const points = road.points.map(([x, z]) => project([x, terrainHeightAt(x, z) + 0.22, z]));
      if (points.length < 2 || points.some(point => !point)) continue;
      const group = groups.get(road.highway) || { roads: [], width: road.width, ...roadStyle(road.highway) };
      group.roads.push(points);
      groups.set(road.highway, group);
    }
    context.lineJoin = 'round';
    context.lineCap = 'round';
    for (const group of groups.values()) {
      const width = clamp(group.width * focal / camera.distance, 0.7, 12);
      context.beginPath();
      for (const points of group.roads) {
        context.moveTo(points[0][0], points[0][1]);
        for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1]);
      }
      context.lineWidth = width + 1.3;
      context.strokeStyle = '#343b3d';
      context.stroke();
      context.lineWidth = width;
      context.strokeStyle = group.color;
      context.stroke();
    }
  }

  // Draws everything except the wind overlay into sceneCanvas. Only called
  // when `dirty` (camera moved, layer toggled, resized, wind box edited) —
  // never on every particle-animation frame.
  function renderStatic() {
    context = sceneContext;
    try {
      context.fillStyle = COLORS.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const { forward, project, projectPolygon, focal } = cameraProjection();
      const simplified = Boolean(drag) || performance.now() < interactionUntil;
      if (visibility.terrain) drawTerrain(projectPolygon);
      const [left, bottom, right, top] = manifest.bounds;
      const boundary = [[left, terrainHeightAt(left, -top), -top], [right, terrainHeightAt(right, -top), -top], [right, terrainHeightAt(right, -bottom), -bottom], [left, terrainHeightAt(left, -bottom), -bottom]];
      const clippedBoundary = projectPolygon(boundary);
      const clipped = path(clippedBoundary);
      if (clipped) context.save();
      if (clipped) context.clip();
      if (visibility.grass) drawGrass(projectPolygon, project, focal, simplified);
      if (visibility.roads) {
        drawRoads(project, focal, simplified);
      }
      drawGeneratedShadows(project, focal, simplified);
      // Keep ground features inside the CBD footprint, but restore the canvas
      // before drawing vertical geometry. An edge building must remain whole
      // when its wall or roof is exposed by an oblique camera angle.
      if (clipped) context.restore();
      // Render the continuous scalar result on the ground before vertical
      // geometry so buildings and trees correctly occlude the heat layer.
      drawHeatmap(project, projectPolygon);
      drawWindHeatmap(project, projectPolygon);
      const visibleBuildings = [];
      const visibleTrees = [];
      if (visibility.buildings) {
        for (const building of buildings) {
          if (!isInView(building.x, building.ground + building.height * 0.5, building.z, building.radius + building.height * 0.5, project, focal)) continue;
          visibleBuildings.push({
            value: building.value,
            x: building.x,
            z: building.z,
            radius: building.radius,
            shadowRing: building.shadowRing,
            depth: building.x * forward[0] + building.z * forward[2],
          });
        }
      }
      if (visibleBuildings.length || visibleTrees.length) {
        // Shadow study mode uses four batched facade-light bands plus a roof
        // fill, preserving useful building depth without per-wall draw calls.
        if (shadowState.enabled && simplified) drawBuildingsDuringInteraction(visibleBuildings, project);
        else if (shadowState.enabled) drawBuildingsBatched(visibleBuildings, project, forward);
        else drawBuildingsByDepth(visibleBuildings, project, visibleTrees);
      }
      drawCanopyFootprints(project, forward);
    } finally {
      context = mainContext;
    }
  }

  function render() {
    frame = 0;
    if (resize()) dirty = true;
    const animating = windState.enabled && Boolean(windState.field);
    if (!dirty && !animating) return;
    if (dirty) {
      renderStatic();
      dirty = false;
    }
    context.drawImage(sceneCanvas, 0, 0);
    const { project, projectPolygon } = cameraProjection();
    drawWindParticles(project);
    drawWindDirection(project);
    drawWindBox(project, projectPolygon);
    if (mitigationState.drawing && mitigationState.points.length) {
      const points = mitigationState.points.map(([x, z]) => project([x, terrainHeightAt(x, z) + 1, z])).filter(Boolean);
      mainContext.strokeStyle = '#f5b85f';
      mainContext.fillStyle = '#ffd28f';
      mainContext.lineWidth = 2;
      mainContext.beginPath();
      points.forEach((point, index) => index ? mainContext.lineTo(point[0], point[1]) : mainContext.moveTo(point[0], point[1]));
      mainContext.stroke();
      for (const point of points) {
        mainContext.beginPath();
        mainContext.arc(point[0], point[1], 3, 0, Math.PI * 2);
        mainContext.fill();
      }
    }
    if (streetViewState.point) {
      const [x, z] = streetViewState.point;
      const base = project([x, terrainHeightAt(x, z) + 0.8, z]);
      const head = project([x, terrainHeightAt(x, z) + 13, z]);
      if (base && head) {
        mainContext.strokeStyle = '#249ee9';
        mainContext.lineWidth = 4;
        mainContext.beginPath();
        mainContext.moveTo(base[0], base[1]);
        mainContext.lineTo(head[0], head[1]);
        mainContext.stroke();
        mainContext.fillStyle = '#70c7ff';
        mainContext.strokeStyle = '#e5f6ff';
        mainContext.lineWidth = 2;
        mainContext.beginPath();
        mainContext.arc(head[0], head[1], 7, 0, Math.PI * 2);
        mainContext.fill();
        mainContext.stroke();
      }
    }
  }

  const mitigationLabel = method => ({
    added_canopy: 'Added canopy', constructed_shade: 'Constructed shade',
    cool_pavement: 'Cool pavement', green_roof: 'Green roof',
    canopy_protection: 'Protect canopy',
  }[method] || method);

  function renderMitigationList() {
    mitigationList.innerHTML = '';
    mitigationState.interventions.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'mitigation-item';
      const value = ['added_canopy', 'constructed_shade'].includes(item.method) ? item.height_m : item.target_albedo;
      row.innerHTML = `<span><label><input type="checkbox" ${item.visible ? 'checked' : ''}> ${mitigationLabel(item.method)}</label></span>
        <input type="number" min="0.1" max="30" step="0.1" value="${value}">
        <span><button type="button" data-action="duplicate">＋</button><button type="button" data-action="remove">×</button></span>`;
      const checkbox = row.querySelector('input[type="checkbox"]');
      const number = row.querySelector('input[type="number"]');
      checkbox.addEventListener('change', () => { item.visible = checkbox.checked; mitigationRun.disabled = !mitigationState.interventions.some(entry => entry.visible); });
      number.addEventListener('change', () => {
        if (['added_canopy', 'constructed_shade'].includes(item.method)) item.height_m = Number(number.value);
        else item.target_albedo = Number(number.value);
      });
      row.addEventListener('click', event => {
        if (event.target.dataset.action === 'remove') mitigationState.interventions.splice(index, 1);
        if (event.target.dataset.action === 'duplicate') mitigationState.interventions.splice(index + 1, 0, {
          ...item, id: `intervention-${Date.now()}`, geometry: JSON.parse(JSON.stringify(item.geometry)),
        });
        renderMitigationList();
      });
      mitigationList.append(row);
    });
    mitigationRun.disabled = !mitigationState.interventions.some(item => item.visible);
  }

  function finishMitigationDrawing() {
    if (mitigationState.points.length < 3) {
      mitigationStatus.textContent = 'Add at least three points before closing.';
      return;
    }
    const method = mitigationMethod.value;
    mitigationState.interventions.push({
      id: `intervention-${Date.now()}`, method, visible: true,
      height_m: method === 'added_canopy' ? 8 : method === 'constructed_shade' ? 3 : 0,
      target_albedo: 0.35,
      geometry: { type: 'Polygon', coordinates: [[...mitigationState.points, mitigationState.points[0]]] },
    });
    mitigationState.drawing = false;
    mitigationState.points = [];
    mitigationAdd.classList.remove('active');
    mitigationAdd.setAttribute('aria-pressed', 'false');
    mitigationAdd.textContent = 'Draw intervention';
    mitigationStatus.textContent = `${mitigationLabel(method)} added · compare when ready.`;
    renderMitigationList();
    requestRender();
  }

  async function runMitigationPreview() {
    const interventions = mitigationState.interventions.filter(item => item.visible);
    if (!interventions.length) return;
    mitigationRun.disabled = true;
    mitigationRun.textContent = 'Estimating…';
    try {
      const response = await fetch(`${windApi}/mitigations/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ interventions, sun_date: shadowState.date, sun_minutes: shadowState.minutes, baseline_metric: 'heat_model_lst_c' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      mitigationState.result = payload;
      mitigationState.afterData = {
        ...(heatState.baselineData || {}),
        features: payload.zones.map(zone => ({ geometry: zone.geometry, value: zone.estimates.central.surface_temperature_c })),
        count: payload.zones.length,
      };
      const central = payload.summary.estimates.central;
      mitigationResults.hidden = false;
      mitigationResults.innerHTML = `<span><b>${Math.round(payload.summary.treated_area_m2).toLocaleString()} m²</b>Treated</span>
        <span><b>${Math.round(payload.summary.affected_area_m2).toLocaleString()} m²</b>Affected</span>
        <span><b>${central.mean_surface_reduction_c.toFixed(1)}°C</b>Surface relief</span>
        <span><b>${central.mean_pedestrian_reduction_c.toFixed(1)}°C</b>Pedestrian relief</span>`;
      mitigationStatus.textContent = payload.warnings.length ? payload.warnings.join(' ') : `${payload.summary.affected_zone_count} affected heat zones · ${payload.version}`;
      mitigationCompare.value = 'after';
      heatState.data = mitigationState.afterData;
      heatToggle.checked = true;
      setHeatMode(true);
    } catch (error) {
      mitigationStatus.textContent = `Impact estimate unavailable (${error.message})`;
    } finally {
      mitigationRun.disabled = false;
      mitigationRun.textContent = 'Compare impact';
    }
  }

  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    if (streetViewState.placing && event.button === 0) {
      const { screenToPlane } = cameraProjection();
      const ground = screenToPlane(event.clientX, event.clientY, terrainHeightAt(camera.target[0], camera.target[2]));
      if (ground) {
        streetViewState.placing = false;
        streetViewState.point = [Number(ground[0].toFixed(3)), Number(ground[1].toFixed(3))];
        dispatchEvent(new CustomEvent('climate-streetview-point', {
          detail: { x: streetViewState.point[0], z: streetViewState.point[1] },
        }));
        requestRender();
      }
      return;
    }
    if (mitigationState.drawing && event.button === 0) {
      const { screenToPlane } = cameraProjection();
      const ground = screenToPlane(event.clientX, event.clientY, terrainHeightAt(camera.target[0], camera.target[2]));
      if (ground) {
        mitigationState.points.push([Number(ground[0].toFixed(2)), Number(ground[1].toFixed(2))]);
        mitigationStatus.textContent = `${mitigationState.points.length} points · double-click to close.`;
        requestRender();
      }
      return;
    }
    if (windState.enabled && windState.moveMode) {
      const { project, screenToPlane } = cameraProjection();
      const bounds = windBoxScreenBounds(project);
      const handle = windResizeHandle(project);
      const planeY = terrainHeightAt(windState.center[0], windState.center[1]) + 2;
      const ground = screenToPlane(event.clientX, event.clientY, planeY);
      const onHandle = handle && Math.hypot(event.clientX - handle[0], event.clientY - handle[1]) <= 18;
      const inBounds = bounds && event.clientX >= bounds.left - 12 && event.clientX <= bounds.right + 12 && event.clientY >= bounds.top - 12 && event.clientY <= bounds.bottom + 12;
      if ((onHandle || inBounds) && ground) {
        canvas.setPointerCapture(event.pointerId);
        windDrag = {
          mode: onHandle ? 'resize' : 'move',
          planeY,
          center: [...windState.center],
          offset: [windState.center[0] - ground[0], windState.center[1] - ground[1]],
        };
        // The existing flow is only valid for the old position/size, so
        // carrying it across a move/resize would show a stale, mismatched
        // pattern. Clear it and require a fresh Simulate wind instead.
        windState.field = null;
        windState.particles = [];
        updateWindLegend();
        windStatus.textContent = onHandle ? 'Resizing domain · click Simulate wind when done.' : 'Moving domain · click Simulate wind when done.';
        requestRender();
        return;
      }
    }
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, azimuth: camera.azimuth, elevation: camera.elevation, target: [...camera.target], pan: event.shiftKey || event.button !== 0 };
    markInteraction();
  });
  canvas.addEventListener('pointermove', event => {
    if (windDrag) {
      const { screenToPlane } = cameraProjection();
      const ground = screenToPlane(event.clientX, event.clientY, windDrag.planeY);
      if (!ground) return;
      if (windDrag.mode === 'resize') {
        windState.size = Math.round(clamp(2 * Math.max(Math.abs(ground[0] - windState.center[0]), Math.abs(ground[1] - windState.center[1])), 100, 1200) / 25) * 25;
        windSize.value = String(windState.size);
        windSizeValue.textContent = String(windState.size);
      } else {
        const [left, bottom, right, top] = manifest.bounds;
        const half = windState.size * 0.5;
        const nextX = clamp(ground[0] + windDrag.offset[0], left + half, right - half);
        const nextZ = clamp(ground[1] + windDrag.offset[1], -top + half, -bottom - half);
        windState.center[0] = nextX;
        windState.center[1] = nextZ;
      }
      requestRender();
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.pan) {
      const scale = camera.distance / 850;
      const right = [Math.sin(drag.azimuth), 0, -Math.cos(drag.azimuth)];
      const forward = [-Math.cos(drag.azimuth), 0, -Math.sin(drag.azimuth)];
      camera.target[0] = drag.target[0] - right[0] * dx * scale + forward[0] * dy * scale;
      camera.target[2] = drag.target[2] - right[2] * dx * scale + forward[2] * dy * scale;
    } else {
      camera.azimuth = drag.azimuth - dx * 0.006;
      camera.elevation = clamp(drag.elevation - dy * 0.006, 0.16, 1.35);
    }
    requestRender();
  });
  for (const name of ['pointerup', 'pointercancel']) canvas.addEventListener(name, () => {
    if (windDrag) windStatus.textContent = `Domain updated · click Simulate wind for the ${windState.size} m domain.`;
    drag = null;
    windDrag = null;
    interactionUntil = 0;
    requestRender();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    camera.distance = clamp(camera.distance * Math.exp(event.deltaY * 0.0008), 80, 7000);
    markInteraction();
    requestRender();
  }, { passive: false });
  canvas.addEventListener('dblclick', event => {
    if (mitigationState.drawing) {
      event.preventDefault();
      if (mitigationState.points.length > 3) {
        const last = mitigationState.points.at(-1), previous = mitigationState.points.at(-2);
        if (Math.hypot(last[0] - previous[0], last[1] - previous[1]) < 2) mitigationState.points.pop();
      }
      finishMitigationDrawing();
    } else {
      fitScene();
    }
  });
  document.querySelector('#fit').addEventListener('click', fitScene);
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', event => {
    visibility[event.target.dataset.layer] = event.target.checked;
    requestRender();
  }));

  windToggle.addEventListener('change', event => {
    windState.enabled = event.target.checked;
    windStatus.textContent = windState.enabled ? '3D domain ready · drag it, then simulate.' : 'Wind display hidden.';
    requestRender();
  });
  windDirection.addEventListener('change', event => {
    windState.direction = Number(event.target.value);
    windState.referenceHeight = 2;
    windState.field = null;
    windState.particles = [];
    windStatus.textContent = 'Direction changed · click Simulate wind.';
    requestRender();
  });
  windSeason.addEventListener('change', event => {
    windState.season = event.target.value;
    windState.field = null;
    windState.particles = [];
    windStatus.textContent = 'Season changed · click Simulate wind.';
    requestRender();
  });
  windSpeed.addEventListener('input', event => {
    windState.speed = Number(event.target.value);
    windState.referenceHeight = 2;
    windSpeedValue.textContent = windState.speed.toFixed(1);
  });
  windSize.addEventListener('input', event => {
    windState.size = Number(event.target.value);
    windSizeValue.textContent = String(windState.size);
    windState.field = null;
    windState.particles = [];
    windStatus.textContent = 'Domain resized · click Simulate wind.';
    requestRender();
  });
  windMoveDomain.addEventListener('click', () => setMoveMode(!windState.moveMode));
  windSimulate.addEventListener('click', simulateWind);

  heatToggle?.addEventListener('change', event => {
    setHeatMode(event.target.checked);
  });
  heatMetric?.addEventListener('change', event => loadHeat(event.target.value));
  sunToggle?.addEventListener('change', event => setShadowMode(event.target.checked));
  sunDate?.addEventListener('change', event => {
    shadowState.date = event.target.value || shadowState.date;
    shadowState.generated = null;
    shadowGenerationToken += 1;
    sunGenerate.disabled = false;
    sunGenerate.textContent = 'Generate shadows';
    updateSunStatus();
    requestRender();
  });
  sunTime?.addEventListener('input', event => {
    shadowState.minutes = Number(event.target.value);
    shadowState.generated = null;
    shadowGenerationToken += 1;
    sunGenerate.disabled = false;
    sunGenerate.textContent = 'Generate shadows';
    updateSunStatus();
  });
  // Redraw once on release to remove the previous result. The continuous
  // input handler above deliberately performs no canvas work.
  sunTime?.addEventListener('change', requestRender);
  sunGenerate?.addEventListener('click', generateShadows);
  mitigationAdd?.addEventListener('click', () => {
    mitigationState.drawing = !mitigationState.drawing;
    mitigationState.points = [];
    mitigationAdd.classList.toggle('active', mitigationState.drawing);
    mitigationAdd.setAttribute('aria-pressed', String(mitigationState.drawing));
    mitigationAdd.textContent = mitigationState.drawing ? 'Cancel drawing' : 'Draw intervention';
    mitigationStatus.textContent = mitigationState.drawing ? 'Click terrain points, then double-click to close.' : 'Drawing cancelled.';
    requestRender();
  });
  mitigationRun?.addEventListener('click', runMitigationPreview);
  mitigationClear?.addEventListener('click', () => {
    mitigationState.drawing = false;
    mitigationState.points = [];
    mitigationState.interventions = [];
    mitigationState.result = null;
    mitigationState.afterData = null;
    mitigationList.innerHTML = '';
    mitigationResults.hidden = true;
    mitigationRun.disabled = true;
    mitigationCompare.value = 'before';
    heatState.data = heatState.baselineData;
    mitigationStatus.textContent = 'Choose a method, draw at least three points, then double-click to close.';
    requestRender();
  });
  mitigationCompare?.addEventListener('change', () => {
    if (mitigationCompare.value === 'after' && !mitigationState.afterData) {
      mitigationCompare.value = 'before';
      mitigationStatus.textContent = 'Run Compare impact before switching to the after map.';
    }
    heatState.data = mitigationCompare.value === 'after' ? mitigationState.afterData : heatState.baselineData;
    requestRender();
  });
  addEventListener('climate-streetview-mode', event => {
    streetViewState.placing = Boolean(event.detail?.enabled);
    if (streetViewState.placing && mitigationState.drawing) {
      mitigationState.drawing = false;
      mitigationState.points = [];
      mitigationAdd.classList.remove('active');
      mitigationAdd.setAttribute('aria-pressed', 'false');
      mitigationAdd.textContent = 'Draw intervention';
    }
    canvas.style.cursor = streetViewState.placing ? 'crosshair' : 'grab';
    requestRender();
  });
  addEventListener('climate-streetview-clear', () => {
    streetViewState.placing = false;
    streetViewState.point = null;
    canvas.style.cursor = 'grab';
    requestRender();
  });
  addEventListener('climate-current-weather', event => {
    const weather = event.detail || {};
    const valid = new Date(weather.valid_at);
    if (!Number.isNaN(valid.getTime())) {
      shadowState.date = valid.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(valid);
      const hour = Number(parts.find(part => part.type === 'hour')?.value || 12);
      const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
      shadowState.minutes = Math.round((hour * 60 + minute) / 10) * 10;
      sunDate.value = shadowState.date;
      sunTime.value = String(clamp(shadowState.minutes, Number(sunTime.min), Number(sunTime.max)));
      shadowState.minutes = Number(sunTime.value);
    }
    windState.direction = Number(weather.wind_direction_10m_deg) || 0;
    windState.speed = Math.max(0, Number(weather.wind_speed_10m_mps) || 0);
    windState.referenceHeight = 10;
    windSpeed.value = String(clamp(windState.speed, Number(windSpeed.min), Number(windSpeed.max)));
    windSpeedValue.textContent = windState.speed.toFixed(1);
    shadowState.generated = null;
    shadowGenerationToken += 1;
    sunGenerate.disabled = false;
    sunGenerate.textContent = 'Generate shadows';
    updateSunStatus();
    windState.field = null;
    windState.particles = [];
    updateWindLegend();
    windStatus.textContent = `Current forcing set · ${windState.speed.toFixed(1)} m/s from ${Math.round(windState.direction)}° · click Simulate wind.`;
    requestRender();
  });

  addEventListener('resize', requestRender);

  fitScene();
  applyViewFromUrl();
  status.textContent = `${scene.buildings.length} buildings · ${canopies.length} canopy footprints · ${roads.length} OSM roads · Canvas 2D compatibility`;
  windToggle.checked = true;
  windStatus.textContent = 'Choose Move / resize domain to position the orange box.';
  requestRender();
  setHeatMode(heatState.enabled);
  updateSunStatus();
  loadHeat();
}
