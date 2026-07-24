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

  const [manifest, scene] = await Promise.all([
    fetch('assets/manifest.json').then(response => response.json()),
    fetch('assets/fallback.json').then(response => {
      if (!response.ok) throw new Error('fallback scene asset is missing');
      return response.json();
    }),
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
      ring, minX, maxX, minZ, maxZ,
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
  }));
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
    particles: [],
    moveMode: false,
    lastTime: performance.now(),
  };

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

  function drawWindHeatmap(project, projectPolygon) {
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

  // Only reached for the settled, full-detail frame — during drag/zoom
  // buildings are drawn instead by the cheaper drawBuildingsBatched pass.
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
  // *entire* visible skyline into exactly two fill() calls — one path
  // covering every wall quad, one covering every roof — while still
  // normalizing each wall quad's winding so overlapping quads (from the
  // same or different buildings, common at oblique angles) reinforce
  // instead of cancelling under the nonzero fill rule. Depth ordering
  // against trees is sacrificed for this one frame, which is invisible
  // during fast camera motion and gets corrected on the settled redraw.
  function drawBuildingsBatched(buildingList, project) {
    context.beginPath();
    const roofRings = [];
    for (const building of buildingList) {
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
          for (let i = 0; i < quad.length; i += 1) {
            const [x1, y1] = quad[i];
            const [x2, y2] = quad[(i + 1) % quad.length];
            area += x1 * y2 - x2 * y1;
          }
          if (area < 0) quad = quad.reverse();
          context.moveTo(quad[0][0], quad[0][1]);
          for (let i = 1; i < quad.length; i += 1) context.lineTo(quad[i][0], quad[i][1]);
          context.closePath();
        }
      }
      roofRings.push(roof);
    }
    context.fillStyle = '#42494e';
    context.fill();
    context.beginPath();
    for (const roof of roofRings) {
      context.moveTo(roof[0][0], roof[0][1]);
      for (let i = 1; i < roof.length; i += 1) context.lineTo(roof[i][0], roof[i][1]);
      context.closePath();
    }
    context.fillStyle = COLORS.roof;
    context.fill();
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
      context.fillStyle = COLORS.canopy;
      context.fillRect(crown[0] - 1, crown[1] - 1, 2, 2);
      return;
    }
    if (radius > 4) {
      context.strokeStyle = COLORS.trunk;
      context.lineWidth = clamp(radius * 0.13, 0.7, 2.5);
      context.beginPath();
      context.moveTo(base[0], base[1]);
      context.lineTo(crown[0], crown[1] + radiusY * 0.42);
      context.stroke();
    }
    // Two compact, near-circular layers give the 2D fallback a rounded crown.
    context.fillStyle = '#1d4b2e';
    context.beginPath();
    context.ellipse(crown[0] + radius * 0.08, crown[1] + radiusY * 0.13, radius * 0.92, radiusY * 0.92, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = COLORS.canopy;
    context.beginPath();
    context.ellipse(crown[0] - radius * 0.08, crown[1] - radiusY * 0.11, radius * 0.88, radiusY * 0.88, 0, 0, Math.PI * 2);
    context.fill();
  }

  function drawTerrain(projectPolygon) {
    const [left, bottom, right, top] = manifest.bounds;
    const minZ = -top;
    const maxZ = -bottom;
    const point = (column, row, elevation) => [left + (right - left) * column / (terrain.columns - 1), elevation, minZ + (maxZ - minZ) * row / (terrain.rows - 1)];
    // Vertical perimeter faces turn the terrain into a shallow physical plinth.
    context.fillStyle = '#30383b';
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
    context.fillStyle = COLORS.terrain;
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
      if ((road.highway === 'footway' || road.highway === 'path') && camera.distance > 1000) continue;
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
      // Keep ground features inside the CBD footprint, but restore the canvas
      // before drawing vertical geometry. An edge building must remain whole
      // when its wall or roof is exposed by an oblique camera angle.
      if (clipped) context.restore();
      // Render the continuous scalar result on the ground before vertical
      // geometry so buildings and trees correctly occlude the heat layer.
      drawWindHeatmap(project, projectPolygon);
      const features = [];
      const visibleBuildings = [];
      if (visibility.buildings) {
        for (const building of buildings) {
          if (!isInView(building.x, building.ground + building.height * 0.5, building.z, building.radius + building.height * 0.5, project, focal)) continue;
          if (simplified) visibleBuildings.push(building);
          else features.push({ kind: 'building', value: building.value, depth: building.x * forward[0] + building.z * forward[2] });
        }
      }
      if (simplified && visibleBuildings.length) drawBuildingsBatched(visibleBuildings, project);
      if (visibility.trees) {
        const stride = simplified
          ? (camera.distance > 1700 ? 8 : camera.distance > 1100 ? 6 : 4)
          : (camera.distance > 1700 ? 4 : camera.distance > 1100 ? 3 : 2);
        for (const tree of trees) {
          // Stable hash selection keeps mature-looking clusters while avoiding
          // thousands of tiny crowns in the overview.
          if (((tree.id * 1103515245 + 12345) >>> 0) % stride) continue;
          if (!isInView(tree.x, tree.value[1] + tree.value[4] * 0.5, tree.z, tree.radius, project, focal)) continue;
          features.push({ ...tree, depth: tree.x * forward[0] + tree.z * forward[2] });
        }
      }
      features.sort((a, b) => b.depth - a.depth);
      for (const feature of features) {
        if (feature.kind === 'building') drawBuilding(feature.value, project);
        else drawTree(feature.value, project, focal);
      }
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
  }

  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
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
  canvas.addEventListener('dblclick', fitScene);
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

  addEventListener('resize', requestRender);

  fitScene();
  applyViewFromUrl();
  status.textContent = `${scene.buildings.length} buildings · ${scene.trees.length} trees · ${roads.length} OSM roads · Canvas 2D compatibility`;
  windToggle.checked = true;
  windStatus.textContent = 'Choose Move / resize domain to position the orange box.';
  requestRender();
}
