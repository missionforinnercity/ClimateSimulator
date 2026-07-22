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

export async function startFallback(canvas, status) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas 2D is unavailable.');

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
    return {
      kind: 'building', value,
      x, z, ground, height,
      radius: Math.max(...ring.map(point => Math.hypot(point[0] - x, point[1] - z))),
    };
  });
  const trees = scene.trees.map((value, id) => ({
    kind: 'tree', value, id, x: value[0], z: value[2],
    radius: Math.max(value[3], value[5], value[4] * 0.35),
  }));
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

  function requestRender() {
    dirty = true;
    if (!frame) frame = requestAnimationFrame(render);
  }

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
    return { eye, forward, project, projectPolygon, focal };
  }

  function path(points) {
    if (!points.length || points.some(point => !point)) return false;
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1]);
    context.closePath();
    return true;
  }

  function drawBuilding(building, project, simplified) {
    const [ground, height, ring] = building;
    const base = ring.map(([x, z]) => project([x, ground, z]));
    const roof = ring.map(([x, z]) => project([x, ground + height, z]));
    if (base.some(point => !point) || roof.some(point => !point)) return;
    const screenHeight = Math.max(...base.map((point, index) => Math.abs(point[1] - roof[index][1])));
    if (screenHeight > 2.2) {
      if (simplified) context.fillStyle = '#42494e';
      for (let index = 0; index < ring.length; index += 1) {
        const next = (index + 1) % ring.length;
        if (!path([base[index], base[next], roof[next], roof[index]])) continue;
        if (!simplified) {
          const shade = 48 + ((index * 17 + ring.length * 7) % 16);
          context.fillStyle = `rgb(${shade}, ${shade + 5}, ${shade + 10})`;
        }
        context.fill();
      }
    }
    if (path(roof)) {
      context.fillStyle = COLORS.roof;
      context.fill();
      if (!simplified && screenHeight > 2.8) {
        context.strokeStyle = COLORS.roofEdge;
        context.lineWidth = 0.8;
        context.stroke();
      }
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

  function render() {
    frame = 0;
    if (resize()) dirty = true;
    if (!dirty) return;
    dirty = false;
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
      const features = [];
      if (visibility.buildings) {
        for (const building of buildings) {
          if (!isInView(building.x, building.ground + building.height * 0.5, building.z, building.radius + building.height * 0.5, project, focal)) continue;
          features.push({ ...building, depth: building.x * forward[0] + building.z * forward[2] });
        }
      }
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
        if (feature.kind === 'building') drawBuilding(feature.value, project, simplified);
        else drawTree(feature.value, project, focal);
      }
  }

  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, azimuth: camera.azimuth, elevation: camera.elevation, target: [...camera.target], pan: event.shiftKey || event.button !== 0 };
    markInteraction();
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.pan) {
      const scale = camera.distance / 850;
      const right = [-Math.sin(drag.azimuth), 0, Math.cos(drag.azimuth)];
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
    drag = null;
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

  addEventListener('resize', requestRender);

  fitScene();
  applyViewFromUrl();
  status.textContent = `${scene.buildings.length} buildings · ${scene.trees.length} trees · ${roads.length} OSM roads · Canvas 2D compatibility`;
  requestRender();
}
