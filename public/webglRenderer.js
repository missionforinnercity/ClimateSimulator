import * as THREE from './vendor/three.module.min.js';

const COLORS = {
  background: 0x1b2125,
  terrain: 0x424a4d,
  terrainSun: 0xf4f3ee,
  grass: 0x50745a,
  wall: 0x657076,
  wallSun: 0xffffff,
  roof: 0xaeb5b8,
  roofSun: 0xffffff,
  road: 0x465257,
  roadMajor: 0xb08b4f,
  roadSecondary: 0x557d89,
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export async function startWebGLScene(canvas, status) {
  if (!window.WebGL2RenderingContext) throw new Error('WebGL 2 is unavailable');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(COLORS.background, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const [manifest, data] = await Promise.all([
    fetch('assets/manifest.json').then(response => response.json()),
    fetch('assets/fallback.json').then(response => {
      if (!response.ok) throw new Error('fallback scene asset is missing');
      return response.json();
    }),
  ]);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);
  const camera = new THREE.PerspectiveCamera(46, 1, 1, 12000);
  const cameraState = {
    azimuth: 0.75,
    elevation: 0.68,
    distance: 1600,
    target: new THREE.Vector3(0, 20, 0),
  };
  const layerGroups = {
    terrain: new THREE.Group(),
    grass: new THREE.Group(),
    roads: new THREE.Group(),
    buildings: new THREE.Group(),
    trees: new THREE.Group(),
  };
  Object.values(layerGroups).forEach(group => scene.add(group));

  const ambient = new THREE.HemisphereLight(0xeaf5ff, 0x364147, 1.65);
  scene.add(ambient);
  const sunLight = new THREE.DirectionalLight(0xfff3d6, 3.25);
  sunLight.castShadow = true;
  sunLight.visible = false;
  sunLight.shadow.bias = 0.00015;
  sunLight.shadow.normalBias = 0.18;
  sunLight.shadow.radius = 0;
  const maxShadowMap = renderer.capabilities.maxTextureSize;
  const shadowMapSize = Math.min(4096, maxShadowMap);
  sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  scene.add(sunLight);
  scene.add(sunLight.target);

  const terrain = data.terrain;
  const [left, bottom, right, top] = manifest.bounds;
  const minZ = -top;
  const maxZ = -bottom;
  const terrainWidth = right - left;
  const terrainDepth = maxZ - minZ;

  function terrainHeightAt(x, z) {
    const u = clamp((x - left) / terrainWidth, 0, 1) * (terrain.columns - 1);
    const v = clamp((z - minZ) / terrainDepth, 0, 1) * (terrain.rows - 1);
    const column = Math.min(terrain.columns - 2, Math.floor(u));
    const row = Math.min(terrain.rows - 2, Math.floor(v));
    const tx = u - column;
    const tz = v - row;
    const at = (r, c) => terrain.heights[r * terrain.columns + c];
    const a = at(row, column) * (1 - tx) + at(row, column + 1) * tx;
    const b = at(row + 1, column) * (1 - tx) + at(row + 1, column + 1) * tx;
    return a * (1 - tz) + b * tz;
  }

  function makeTerrain() {
    const positions = [];
    const indices = [];
    for (let row = 0; row < terrain.rows; row += 1) {
      for (let column = 0; column < terrain.columns; column += 1) {
        const x = left + terrainWidth * column / (terrain.columns - 1);
        const z = minZ + terrainDepth * row / (terrain.rows - 1);
        positions.push(x, terrain.heights[row * terrain.columns + column], z);
      }
    }
    for (let row = 0; row < terrain.rows - 1; row += 1) {
      for (let column = 0; column < terrain.columns - 1; column += 1) {
        const a = row * terrain.columns + column;
        const b = a + 1;
        const c = a + terrain.columns;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ color: COLORS.terrain, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    // Keep the ground colour independent from the shadow itself. A dedicated
    // ShadowMaterial overlay below produces one clean, solid shade colour
    // instead of mixing the shadow with ambient terrain lighting.
    mesh.receiveShadow = false;
    mesh.userData.normalColor = COLORS.terrain;
    mesh.userData.sunColor = COLORS.terrainSun;
    const shadowCatcher = new THREE.Mesh(geometry, new THREE.ShadowMaterial({
      color: 0x101820,
      opacity: 0.84,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }));
    shadowCatcher.position.y = 0.12;
    shadowCatcher.receiveShadow = true;
    shadowCatcher.visible = false;
    shadowCatcher.name = 'ground-shadow-catcher';
    shadowCatcher.renderOrder = 4;
    layerGroups.terrain.add(mesh, shadowCatcher);
    return { mesh, shadowCatcher };
  }

  function triangulateRing(ring) {
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    return THREE.ShapeUtils.triangulateShape(contour, []);
  }

  function makeBuildings() {
    const wallPositions = [];
    const roofPositions = [];
    for (const [ground, height, ring] of data.buildings) {
      const roofY = ground + height;
      for (let index = 0; index < ring.length; index += 1) {
        const next = (index + 1) % ring.length;
        const [x1, z1] = ring[index];
        const [x2, z2] = ring[next];
        wallPositions.push(
          x1, ground, z1, x2, ground, z2, x2, roofY, z2,
          x1, ground, z1, x2, roofY, z2, x1, roofY, z1,
        );
      }
      for (const face of triangulateRing(ring)) {
        const a = ring[face[0]];
        let b = ring[face[1]], c = ring[face[2]];
        const normalY = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
        if (normalY < 0) [b, c] = [c, b];
        roofPositions.push(a[0], roofY, a[1], b[0], roofY, b[1], c[0], roofY, c[1]);
      }
    }
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
    wallGeometry.computeVertexNormals();
    const roofGeometry = new THREE.BufferGeometry();
    roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
    roofGeometry.computeVertexNormals();
    const wallMaterial = new THREE.MeshLambertMaterial({ color: COLORS.wall, side: THREE.DoubleSide });
    const roofMaterial = new THREE.MeshLambertMaterial({ color: COLORS.roof, side: THREE.DoubleSide });
    const walls = new THREE.Mesh(wallGeometry, wallMaterial);
    const roofs = new THREE.Mesh(roofGeometry, roofMaterial);
    for (const mesh of [walls, roofs]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      layerGroups.buildings.add(mesh);
    }
    walls.userData.normalColor = COLORS.wall;
    walls.userData.sunColor = COLORS.wallSun;
    walls.userData.normalMaterial = wallMaterial;
    walls.userData.sunMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      emissive: 0x202428,
      emissiveIntensity: 0.28,
      side: THREE.DoubleSide,
      shadowSide: THREE.BackSide,
    });
    roofs.userData.normalColor = COLORS.roof;
    roofs.userData.sunColor = COLORS.roofSun;
    roofs.userData.normalMaterial = roofMaterial;
    roofs.userData.sunMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      emissive: 0x202428,
      emissiveIntensity: 0.28,
      side: THREE.DoubleSide,
      shadowSide: THREE.BackSide,
    });
    return { walls, roofs };
  }

  function makeGrass() {
    const positions = [];
    for (const ring of data.grass || []) {
      for (const face of triangulateRing(ring)) {
        for (const index of face) {
          const [x, z] = ring[index];
          positions.push(x, terrainHeightAt(x, z) + 0.18, z);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: COLORS.grass, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    layerGroups.grass.add(mesh);
  }

  function makeRoads() {
    const positionsByStyle = [[], [], []];
    const major = new Set(['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link']);
    const secondary = new Set(['secondary', 'secondary_link', 'tertiary']);
    for (const [, highway, points] of data.roads || []) {
      const target = major.has(highway) ? positionsByStyle[1] : secondary.has(highway) ? positionsByStyle[2] : positionsByStyle[0];
      if (points.length > 1) target.push(points);
    }
    const colors = [COLORS.road, COLORS.roadMajor, COLORS.roadSecondary];
    const widths = [0.78, 1.12, 0.94];
    const buildRibbon = (roads, styleIndex, outer = false) => {
      const vertices = [];
      const indices = [];
      const halfWidth = (outer ? 4.7 : 3.35) * widths[styleIndex];
      for (const road of roads) {
        const base = vertices.length / 3;
        for (let index = 0; index < road.length; index += 1) {
          const [x, z] = road[index];
          const previous = road[Math.max(0, index - 1)];
          const next = road[Math.min(road.length - 1, index + 1)];
          const dx = next[0] - previous[0];
          const dz = next[1] - previous[1];
          const length = Math.hypot(dx, dz) || 1;
          const nx = -dz / length * halfWidth;
          const nz = dx / length * halfWidth;
          const y = terrainHeightAt(x, z) + 0.32;
          vertices.push(x + nx, y, z + nz, x - nx, y, z - nz);
          if (index > 0) {
            const left = base + (index - 1) * 2;
            const right = left + 1;
            const nextLeft = base + index * 2;
            const nextRight = nextLeft + 1;
            indices.push(left, right, nextLeft, right, nextRight, nextLeft);
          }
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const material = new THREE.MeshBasicMaterial({
        color: outer ? 0x293337 : colors[styleIndex],
        transparent: false,
        opacity: 1,
        depthWrite: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = outer ? 1 : 2;
      return mesh;
    };
    positionsByStyle.forEach((roads, index) => {
      if (!roads.length) return;
      layerGroups.roads.add(buildRibbon(roads, index, true));
      layerGroups.roads.add(buildRibbon(roads, index, false));
    });
  }

  function makeTrees() {
    const visibleTrees = data.trees.filter((_, index) => index % 2 === 0);
    const crownGeometry = new THREE.IcosahedronGeometry(1, 1);
    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.3, 1, 5);
    const crowns = new THREE.InstancedMesh(crownGeometry, new THREE.MeshLambertMaterial({ color: 0x4c8a5d }), visibleTrees.length);
    const trunks = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshLambertMaterial({ color: 0x6b4d35 }), visibleTrees.length);
    const matrix = new THREE.Matrix4();
    visibleTrees.forEach(([x, ground, z, crownX, height, crownZ], index) => {
      matrix.compose(
        new THREE.Vector3(x, ground + height * 0.68, z),
        new THREE.Quaternion(),
        new THREE.Vector3(crownX, Math.max(1.5, height * 0.34), crownZ),
      );
      crowns.setMatrixAt(index, matrix);
      matrix.compose(
        new THREE.Vector3(x, ground + height * 0.28, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, Math.max(2, height * 0.56), 1),
      );
      trunks.setMatrixAt(index, matrix);
    });
    crowns.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    layerGroups.trees.add(trunks, crowns);
  }

  status.textContent = 'Building GPU scene…';
  const { mesh: terrainMesh, shadowCatcher } = makeTerrain();
  const buildingMeshes = makeBuildings();
  makeGrass();
  makeRoads();
  makeTrees();

  const heatGroup = new THREE.Group();
  const windGroup = new THREE.Group();
  scene.add(heatGroup, windGroup);

  const heatToggle = document.querySelector('#heat-toggle');
  const heatStatus = document.querySelector('#heat-status');
  const heatLegendMin = document.querySelector('#heat-legend-min');
  const heatLegendMax = document.querySelector('#heat-legend-max');
  const sunToggle = document.querySelector('#sun-toggle');
  const sunDate = document.querySelector('#sun-date');
  const sunTime = document.querySelector('#sun-time');
  const sunTimeValue = document.querySelector('#sun-time-value');
  const sunGenerate = document.querySelector('#sun-generate');
  const sunStatus = document.querySelector('#sun-status');
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
  const query = new URLSearchParams(location.search);
  const windApi = query.get('windApi') || '/api';

  const shadowState = {
    enabled: Boolean(sunToggle?.checked),
    date: sunDate?.value || '2026-07-27',
    minutes: Number(sunTime?.value) || 720,
    generated: false,
  };
  let liveShadowTimer = 0;
  const windState = {
    enabled: Boolean(windToggle?.checked),
    center: [0, 0],
    size: Number(windSize?.value) || 250,
    direction: Number(windDirection?.value) || 135,
    season: windSeason?.value || 'annual',
    speed: Number(windSpeed?.value) || 10,
    field: null,
    particles: [],
    moveMode: false,
    lastTime: performance.now(),
  };
  let heatMesh = null;
  let windHeatMesh = null;
  let windPoints = null;
  let windBox = null;
  let windEdges = null;
  let windHandle = null;
  const windTrailPoints = 5;
  let animationFrame = 0;
  let renderRequested = true;
  let drag = null;
  let windDrag = null;
  const windBuildingCellSize = 60;
  const windBuildingGrid = new Map();
  const savedVisibility = Object.fromEntries(
    Object.entries(layerGroups).map(([name, group]) => [name, group.visible]),
  );

  function rememberNormalVisibility() {
    for (const [name, group] of Object.entries(layerGroups)) savedVisibility[name] = group.visible;
  }

  function restoreNormalVisibility() {
    for (const [name, group] of Object.entries(layerGroups)) group.visible = savedVisibility[name];
  }

  function windCellKey(column, row) {
    return `${column}:${row}`;
  }

  function pointInWindRing(x, z, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [xi, zi] = ring[index];
      const [xj, zj] = ring[previous];
      const intersects = ((zi > z) !== (zj > z))
        && x < (xj - xi) * (z - zi) / ((zj - zi) || Number.EPSILON) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  // Build a coarse spatial index once. Particle collision checks then inspect
  // only nearby footprints instead of all 2,322 buildings every frame.
  for (const [, , ring] of data.buildings) {
    if (!ring?.length) continue;
    const minX = Math.min(...ring.map(point => point[0]));
    const maxX = Math.max(...ring.map(point => point[0]));
    const minZ = Math.min(...ring.map(point => point[1]));
    const maxZ = Math.max(...ring.map(point => point[1]));
    const centroid = ring.reduce((sum, [x, z]) => [sum[0] + x, sum[1] + z], [0, 0]);
    centroid[0] /= ring.length;
    centroid[1] /= ring.length;
    const building = { ring, minX, maxX, minZ, maxZ, centroid };
    const minColumn = Math.floor(minX / windBuildingCellSize);
    const maxColumn = Math.floor(maxX / windBuildingCellSize);
    const minRow = Math.floor(minZ / windBuildingCellSize);
    const maxRow = Math.floor(maxZ / windBuildingCellSize);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const key = windCellKey(column, row);
        if (!windBuildingGrid.has(key)) windBuildingGrid.set(key, []);
        windBuildingGrid.get(key).push(building);
      }
    }
  }

  function windPointInsideBuilding(x, z) {
    const column = Math.floor(x / windBuildingCellSize);
    const row = Math.floor(z / windBuildingCellSize);
    const candidates = windBuildingGrid.get(windCellKey(column, row)) || [];
    return candidates.some(building => (
      x >= building.minX && x <= building.maxX
      && z >= building.minZ && z <= building.maxZ
      && pointInWindRing(x, z, building.ring)
    ));
  }

  function nearestWindBoundary(x, z) {
    const column = Math.floor(x / windBuildingCellSize);
    const row = Math.floor(z / windBuildingCellSize);
    const candidates = new Set();
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        for (const building of windBuildingGrid.get(windCellKey(column + columnOffset, row + rowOffset)) || []) candidates.add(building);
      }
    }
    let nearest = null;
    for (const building of candidates) {
      if (x < building.minX - 30 || x > building.maxX + 30 || z < building.minZ - 30 || z > building.maxZ + 30) continue;
      for (let index = 0; index < building.ring.length; index += 1) {
        const [ax, az] = building.ring[index];
        const [bx, bz] = building.ring[(index + 1) % building.ring.length];
        const edgeX = bx - ax;
        const edgeZ = bz - az;
        const lengthSquared = edgeX * edgeX + edgeZ * edgeZ || 1;
        const amount = clamp(((x - ax) * edgeX + (z - az) * edgeZ) / lengthSquared, 0, 1);
        const pointX = ax + edgeX * amount;
        const pointZ = az + edgeZ * amount;
        const distance = Math.hypot(x - pointX, z - pointZ);
        if (!nearest || distance < nearest.distance) {
          nearest = { building, pointX, pointZ, edgeX, edgeZ, distance };
        }
      }
    }
    return nearest;
  }

  function redirectWindFlow(x, z, flow, force = false) {
    const boundary = nearestWindBoundary(x, z);
    if (!boundary || (!force && boundary.distance > 24)) return flow;
    const speed = Math.max(0.1, Math.hypot(flow.u, flow.v));
    let normalX = x - boundary.pointX;
    let normalZ = z - boundary.pointZ;
    let normalLength = Math.hypot(normalX, normalZ);
    if (normalLength < 0.001) {
      normalX = x - boundary.building.centroid[0];
      normalZ = z - boundary.building.centroid[1];
      normalLength = Math.hypot(normalX, normalZ) || 1;
    }
    normalX /= normalLength;
    normalZ /= normalLength;
    let tangentX = -normalZ;
    let tangentZ = normalX;
    const incomingTangent = flow.u * tangentX + flow.v * tangentZ;
    if (incomingTangent < 0) {
      tangentX = -tangentX;
      tangentZ = -tangentZ;
    }
    const incomingNormal = flow.u * normalX + flow.v * normalZ;
    const proximity = clamp((24 - boundary.distance) / 24, 0, 1);
    const inside = windPointInsideBuilding(x, z);
    const tangentialSpeed = Math.abs(incomingTangent) > speed * 0.08
      ? Math.abs(incomingTangent)
      : speed * 0.32;
    const outwardSpeed = inside || force
      ? speed * 0.78
      : Math.max(0, incomingNormal) + (incomingNormal < 0 ? speed * 0.72 * proximity : 0);
    const length = Math.hypot(tangentialSpeed, outwardSpeed) || 1;
    return {
      u: (tangentX * tangentialSpeed + normalX * outwardSpeed) * speed / length,
      v: (tangentZ * tangentialSpeed + normalZ * outwardSpeed) * speed / length,
      speed,
    };
  }

  function pushWindPointOutsideBuilding(x, z) {
    const boundary = nearestWindBoundary(x, z);
    if (!boundary) return [x, z];
    let normalX = x - boundary.pointX;
    let normalZ = z - boundary.pointZ;
    const length = Math.hypot(normalX, normalZ);
    if (length < 0.001) {
      normalX = x - boundary.building.centroid[0];
      normalZ = z - boundary.building.centroid[1];
    }
    const normalLength = Math.hypot(normalX, normalZ) || 1;
    return [boundary.pointX + normalX / normalLength * 1.5, boundary.pointZ + normalZ / normalLength * 1.5];
  }

  function requestRender() {
    renderRequested = true;
    if (!animationFrame) animationFrame = requestAnimationFrame(render);
  }

  function updateCamera() {
    const horizontal = Math.cos(cameraState.elevation) * cameraState.distance;
    camera.position.set(
      cameraState.target.x + Math.cos(cameraState.azimuth) * horizontal,
      cameraState.target.y + Math.sin(cameraState.elevation) * cameraState.distance,
      cameraState.target.z + Math.sin(cameraState.azimuth) * horizontal,
    );
    camera.lookAt(cameraState.target);
    requestRender();
  }

  function resize() {
    const width = innerWidth;
    const height = innerHeight;
    const pixelRatio = renderer.getPixelRatio();
    const needsResize = canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio);
    if (!needsResize) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  }

  function fitScene() {
    cameraState.target.set(0, 20, 0);
    cameraState.distance = Math.max(500, Math.min(2800, Math.hypot(terrainWidth, terrainDepth) * 0.82));
    cameraState.elevation = 0.68;
    updateCamera();
  }

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
    const altitude = Math.asin(clamp(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle), -1, 1));
    const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) + Math.PI) % (2 * Math.PI);
    return {
      altitude,
      vector: new THREE.Vector3(Math.sin(azimuth) * Math.cos(altitude), Math.sin(altitude), -Math.cos(azimuth) * Math.cos(altitude)),
    };
  }

  function updateSunStatus(message = null) {
    const sun = sunPosition();
    const hours = String(Math.floor(shadowState.minutes / 60)).padStart(2, '0');
    const minutes = String(shadowState.minutes % 60).padStart(2, '0');
    if (sunTimeValue) sunTimeValue.textContent = `${hours}:${minutes}`;
    if (sunStatus) {
      sunStatus.textContent = message || (sun.altitude <= 0
        ? 'Sun is below the horizon at this time.'
        : `Sun altitude ${Math.round(sun.altitude * 180 / Math.PI)}° · click Generate shadows when ready.`);
    }
  }

  function queueLiveShadowUpdate() {
    if (!shadowState.enabled) {
      updateSunStatus();
      return;
    }
    if (liveShadowTimer) clearTimeout(liveShadowTimer);
    updateSunStatus(shadowState.generated ? 'Updating shadows…' : 'Preparing shadows…');
    liveShadowTimer = setTimeout(() => {
      liveShadowTimer = 0;
      generateShadows();
    }, 160);
  }

  function setSunMaterials(enabled) {
    // Hiding the light removes its last depth texture from normal/heat/wind
    // modes. While sunlight mode is active, camera movement can safely reuse it.
    sunLight.visible = enabled && shadowState.generated;
    shadowCatcher.visible = enabled && shadowState.generated;
    ambient.intensity = enabled ? 0.5 : 1.65;
    terrainMesh.material.color.setHex(enabled ? terrainMesh.userData.sunColor : terrainMesh.userData.normalColor);
    for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs]) {
      mesh.material = enabled ? mesh.userData.sunMaterial : mesh.userData.normalMaterial;
    }
  }

  function setShadowMode(enabled) {
    const wasInStudyMode = shadowState.enabled || heatGroup.visible;
    if (enabled && !wasInStudyMode) rememberNormalVisibility();
    shadowState.enabled = enabled;
    if (sunToggle) sunToggle.checked = enabled;
    document.body.classList.toggle('sun-mode', enabled);
    if (enabled) {
      if (heatToggle) heatToggle.checked = false;
      setHeatMode(false);
      heatGroup.visible = false;
      if (windToggle) windToggle.checked = false;
      windState.enabled = false;
      windGroup.visible = false;
      layerGroups.terrain.visible = true;
      layerGroups.grass.visible = false;
      layerGroups.roads.visible = false;
      layerGroups.buildings.visible = true;
      layerGroups.trees.visible = false;
    } else {
      restoreNormalVisibility();
      heatGroup.visible = Boolean(heatToggle?.checked);
      windState.enabled = Boolean(windToggle?.checked);
      windGroup.visible = windState.enabled;
    }
    setSunMaterials(enabled);
    syncLayerControls();
    updateSunStatus();
    requestRender();
  }

  function generateShadows() {
    if (liveShadowTimer) {
      clearTimeout(liveShadowTimer);
      liveShadowTimer = 0;
    }
    if (!shadowState.enabled) setShadowMode(true);
    const sun = sunPosition();
    if (sun.altitude <= 0.008) {
      shadowState.generated = false;
      sunLight.visible = false;
      shadowCatcher.visible = false;
      setSunMaterials(true);
      updateSunStatus();
      requestRender();
      return;
    }
    const extent = Math.max(terrainWidth, terrainDepth) * 0.56;
    const shadowCamera = sunLight.shadow.camera;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = 1;
    shadowCamera.far = 6000;
    shadowCamera.updateProjectionMatrix();
    const target = new THREE.Vector3((left + right) * 0.5, 20, (minZ + maxZ) * 0.5);
    sunLight.target.position.copy(target);
    sunLight.position.copy(target).addScaledVector(sun.vector, 3000);
    sunLight.target.updateMatrixWorld();
    shadowState.generated = true;
    sunLight.visible = true;
    shadowCatcher.visible = true;
    setSunMaterials(true);
    sunLight.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
    if (sunGenerate) sunGenerate.textContent = 'Regenerate shadows';
    updateSunStatus(`GPU shadow map ready · ${Math.round(sun.altitude * 180 / Math.PI)}° sun altitude · ${shadowMapSize}px.`);
    requestRender();
  }

  function syncLayerControls() {
    document.querySelectorAll('[data-layer]').forEach(input => {
      const group = layerGroups[input.dataset.layer];
      if (group) input.checked = group.visible;
    });
  }

  function heatColor(value, minimum, maximum) {
    const color = new THREE.Color();
    const t = clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
    const stops = [
      [0, 0x2b50be], [0.2, 0x2daede], [0.42, 0x74cf48],
      [0.64, 0xffe241], [0.82, 0xff9619], [1, 0xe03020],
    ];
    let upper = 1;
    while (upper < stops.length - 1 && t > stops[upper][0]) upper += 1;
    const lower = upper - 1;
    const amount = (t - stops[lower][0]) / (stops[upper][0] - stops[lower][0]);
    return color.setHex(stops[lower][1]).lerp(new THREE.Color(stops[upper][1]), amount);
  }

  function buildHeatMesh(payload) {
    heatGroup.clear();
    const range = payload.color_range || payload.range;
    if (!payload.features?.length || !range) return;
    const positions = [];
    const colors = [];
    const toVectorRing = ring => {
      const points = ring.map(([x, z]) => new THREE.Vector2(x, z));
      if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();
      return points;
    };
    for (const feature of payload.features) {
      if (feature.value == null) continue;
      const polygons = feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
      const color = heatColor(feature.value, range.min, range.max);
      for (const polygon of polygons) {
        const contour = toVectorRing(polygon[0] || []);
        if (contour.length < 3) continue;
        const holes = polygon.slice(1).map(toVectorRing).filter(ring => ring.length >= 3);
        const vertices = contour.concat(...holes);
        for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
          for (const index of face) {
            const point = vertices[index];
            positions.push(point.x, terrainHeightAt(point.x, point.y) + 0.48, point.y);
            colors.push(color.r, color.g, color.b);
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    heatMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    heatGroup.add(heatMesh);
  }

  async function loadHeat() {
    if (!heatStatus) return;
    heatStatus.textContent = 'Loading heat zones…';
    try {
      const response = await fetch(`${windApi}/heat/zones?metric=heat_model_lst_c`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      buildHeatMesh(payload);
      const range = payload.color_range || payload.range;
      heatLegendMin.textContent = range ? Number(range.min).toFixed(1) : '—';
      heatLegendMax.textContent = range ? Number(range.max).toFixed(1) : '—';
      heatStatus.textContent = `${payload.count || payload.features?.length || 0} GPU heat zones`;
    } catch (error) {
      heatStatus.textContent = `Heat data unavailable (${error.message})`;
    }
    setHeatMode(Boolean(heatToggle?.checked));
  }

  function setHeatMode(enabled) {
    const wasInStudyMode = shadowState.enabled || heatGroup.visible;
    if (enabled && !wasInStudyMode) rememberNormalVisibility();
    heatGroup.visible = enabled;
    document.body.classList.toggle('heat-mode', enabled);
    if (enabled) {
      shadowState.enabled = false;
      if (sunToggle) sunToggle.checked = false;
      document.body.classList.remove('sun-mode');
      layerGroups.terrain.visible = false;
      layerGroups.grass.visible = false;
      layerGroups.roads.visible = false;
      layerGroups.buildings.visible = true;
      layerGroups.trees.visible = true;
      windState.enabled = false;
      if (windToggle) windToggle.checked = false;
      windGroup.visible = false;
      setSunMaterials(false);
    } else if (!shadowState.enabled) {
      restoreNormalVisibility();
      windState.enabled = Boolean(windToggle?.checked);
      windGroup.visible = windState.enabled;
    }
    syncLayerControls();
    requestRender();
  }

  function fallbackWindField() {
    const resolution = 5;
    const width = Math.ceil(windState.size / resolution);
    const angle = windState.direction * Math.PI / 180;
    const flowX = -Math.sin(angle);
    const flowZ = Math.cos(angle);
    const u = [], v = [], speed = [];
    for (let row = 0; row < width; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const localSpeed = windState.speed * (0.68 + 0.22 * Math.sin(column * 0.32 + row * 0.17));
        u.push(flowX * localSpeed);
        v.push(flowZ * localSpeed);
        speed.push(localSpeed);
      }
    }
    return {
      origin: [windState.center[0] - windState.size / 2, windState.center[1] - windState.size / 2],
      width, height: width, dx: resolution, dz: resolution, u, v, speed,
    };
  }

  function sampleWind(x, z) {
    const field = windState.field;
    const columnValue = clamp((x - field.origin[0]) / field.dx - 0.5, 0, field.width - 1);
    const rowValue = clamp((z - field.origin[1]) / field.dz - 0.5, 0, field.height - 1);
    const column = Math.floor(columnValue);
    const row = Math.floor(rowValue);
    const nextColumn = Math.min(column + 1, field.width - 1);
    const nextRow = Math.min(row + 1, field.height - 1);
    const tx = columnValue - column;
    const tz = rowValue - row;
    const interpolate = values => {
      const top = (values[row * field.width + column] || 0) * (1 - tx)
        + (values[row * field.width + nextColumn] || 0) * tx;
      const bottom = (values[nextRow * field.width + column] || 0) * (1 - tx)
        + (values[nextRow * field.width + nextColumn] || 0) * tx;
      return top * (1 - tz) + bottom * tz;
    };
    return { u: interpolate(field.u), v: interpolate(field.v), speed: interpolate(field.speed) };
  }

  function windColor(value, minimum, maximum) {
    const stops = [
      [0, 0x2055d6],
      [0.25, 0x22c7ee],
      [0.5, 0x3dd579],
      [0.75, 0xf4da45],
      [1, 0xef3b2d],
    ];
    const t = clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
    let upper = 1;
    while (upper < stops.length - 1 && t > stops[upper][0]) upper += 1;
    const lower = upper - 1;
    const amount = (t - stops[lower][0]) / (stops[upper][0] - stops[lower][0]);
    return new THREE.Color(stops[lower][1]).lerp(new THREE.Color(stops[upper][1]), amount);
  }

  function disposeObject(object) {
    if (!object) return;
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
    else object.material?.dispose();
  }

  function clearWindSimulation() {
    for (const object of [windHeatMesh, windPoints]) {
      if (!object) continue;
      windGroup.remove(object);
      disposeObject(object);
    }
    windHeatMesh = null;
    windPoints = null;
    windState.particles = [];
  }

  function buildWindHeatmap() {
    if (windHeatMesh) {
      windGroup.remove(windHeatMesh);
      disposeObject(windHeatMesh);
    }
    const field = windState.field;
    if (!field?.speed?.length) {
      windHeatMesh = null;
      return;
    }
    const minimum = Math.min(...field.speed);
    const maximum = Math.max(...field.speed, windState.speed * 0.1, 0.1);
    const positions = [];
    const colors = [];
    const indices = [];
    for (let row = 0; row <= field.height; row += 1) {
      for (let column = 0; column <= field.width; column += 1) {
        const x = field.origin[0] + column * field.dx;
        const z = field.origin[1] + row * field.dz;
        const sampled = sampleWind(x, z);
        const color = windColor(sampled.speed, minimum, maximum);
        positions.push(x, terrainHeightAt(x, z) + 1.05, z);
        colors.push(color.r, color.g, color.b);
      }
    }
    const rowWidth = field.width + 1;
    for (let row = 0; row < field.height; row += 1) {
      for (let column = 0; column < field.width; column += 1) {
        const a = row * rowWidth + column;
        const b = a + 1;
        const c = a + rowWidth;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    windHeatMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.76,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }));
    windHeatMesh.name = 'wind-speed-heatmap';
    windHeatMesh.renderOrder = 2;
    windGroup.add(windHeatMesh);
  }

  function spawnWindParticle(field) {
    const makeParticle = (x, z, age) => ({
      x, z, age, u: 0, v: 0,
      trail: Array.from({ length: windTrailPoints }, () => [x, z]),
    });
    const minX = field.origin[0];
    const maxX = minX + field.width * field.dx;
    const minZ = field.origin[1];
    const maxZ = minZ + field.height * field.dz;
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      if (!windPointInsideBuilding(x, z)) return makeParticle(x, z, Math.random() * 8);
    }
    // A deterministic fallback keeps the particle count stable even if a very
    // small analysis box happens to be mostly occupied by a large footprint.
    const fallbackX = clamp(windState.center[0], minX, maxX);
    const fallbackZ = clamp(windState.center[1], minZ, maxZ);
    return makeParticle(fallbackX, fallbackZ, 0);
  }

  function resetWindParticles() {
    const count = Math.round(clamp(windState.size * 2, 500, 1200));
    windState.particles = Array.from({ length: count }, () => spawnWindParticle(windState.field));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * (windTrailPoints - 1) * 6), 3));
    if (windPoints) {
      windGroup.remove(windPoints);
      disposeObject(windPoints);
    }
    windPoints = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.86,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    windPoints.name = 'wind-gusts';
    windPoints.renderOrder = 3;
    windGroup.add(windPoints);
  }

  function updateWindBox() {
    if (!windBox) {
      const geometry = new THREE.BoxGeometry(1, 45, 1);
      windBox = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0xf4a449,
        transparent: true,
        depthWrite: false,
      }));
      windEdges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
      windHandle = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf4a449, depthTest: false }));
      windHandle.name = 'wind-resize-handle';
      windGroup.add(windBox, windEdges, windHandle);
    }
    windBox.scale.set(windState.size, 1, windState.size);
    windBox.material.opacity = windState.moveMode ? 0.14 : 0.035;
    const y = terrainHeightAt(windState.center[0], windState.center[1]) + 24;
    windBox.position.set(windState.center[0], y, windState.center[1]);
    windEdges.position.copy(windBox.position);
    windEdges.scale.copy(windBox.scale);
    const half = windState.size * 0.5;
    windHandle.position.set(windState.center[0] + half, y + 22, windState.center[1] + half);
    windHandle.visible = windState.moveMode;
    requestRender();
  }

  async function simulateWind() {
    windSimulate.disabled = true;
    windSimulate.textContent = 'Simulating…';
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      windState.field = await response.json();
      windStatus.textContent = `${windState.field.polygon_count || 0} wind zones · GPU heatmap + white gusts`;
    } catch (error) {
      windState.field = fallbackWindField();
      windStatus.textContent = `Local GPU preview · API unavailable (${error.message})`;
    }
    windSimulate.disabled = false;
    windSimulate.textContent = 'Simulate wind';
    const values = windState.field.speed || [];
    windLegendMin.textContent = values.length ? Math.min(...values).toFixed(1) : '—';
    windLegendMax.textContent = values.length ? Math.max(...values).toFixed(1) : '—';
    windState.lastTime = performance.now();
    buildWindHeatmap();
    resetWindParticles();
    requestRender();
  }

  function updateWindParticles(now) {
    if (!windState.enabled || !windState.field || !windPoints) return;
    const elapsed = Math.min(0.06, (now - windState.lastTime) / 1000);
    windState.lastTime = now;
    const half = windState.size * 0.5;
    const positions = windPoints.geometry.attributes.position.array;
    windState.particles.forEach((particle, index) => {
      const target = redirectWindFlow(particle.x, particle.z, sampleWind(particle.x, particle.z));
      // Relax toward the redirected vector over several frames. Instant
      // reflections look like teleports at corners; this gives each gust a
      // short, stable turn radius while preserving the field's speed.
      const blend = 1 - Math.exp(-elapsed * 7);
      particle.u += (target.u - particle.u) * blend;
      particle.v += (target.v - particle.v) * blend;
      let sampled = { u: particle.u, v: particle.v, speed: Math.hypot(particle.u, particle.v) };
      const nextX = particle.x + sampled.u * elapsed * 5.5;
      const nextZ = particle.z + sampled.v * elapsed * 5.5;
      particle.age += elapsed;
      const outsideDomain = Math.abs(nextX - windState.center[0]) > half || Math.abs(nextZ - windState.center[1]) > half;
      const midpointBlocked = windPointInsideBuilding((particle.x + nextX) * 0.5, (particle.z + nextZ) * 0.5);
      if (outsideDomain || particle.age > 9) {
        Object.assign(particle, spawnWindParticle(windState.field));
        const respawnTarget = redirectWindFlow(particle.x, particle.z, sampleWind(particle.x, particle.z));
        particle.u = respawnTarget.u;
        particle.v = respawnTarget.v;
        sampled = { u: particle.u, v: particle.v, speed: Math.hypot(particle.u, particle.v) };
      } else if (windPointInsideBuilding(nextX, nextZ) || midpointBlocked) {
        // Reflect the attempted step into a wall onto the nearest facade
        // tangent, then push the point just outside the footprint. This is a
        // stable pedestrian-height collision response rather than a respawn.
        sampled = redirectWindFlow(particle.x, particle.z, sampled, true);
        particle.u += (sampled.u - particle.u) * blend;
        particle.v += (sampled.v - particle.v) * blend;
        sampled = { u: particle.u, v: particle.v, speed: Math.hypot(particle.u, particle.v) };
        const redirectedX = particle.x + sampled.u * elapsed * 5.5;
        const redirectedZ = particle.z + sampled.v * elapsed * 5.5;
        if (windPointInsideBuilding(redirectedX, redirectedZ)) {
          [particle.x, particle.z] = pushWindPointOutsideBuilding(particle.x, particle.z);
        } else {
          particle.x = redirectedX;
          particle.z = redirectedZ;
        }
        particle.trail = Array.from({ length: windTrailPoints }, () => [particle.x, particle.z]);
      } else {
        particle.x = nextX;
        particle.z = nextZ;
      }
      particle.trail.shift();
      particle.trail.push([particle.x, particle.z]);
      const baseOffset = index * (windTrailPoints - 1) * 6;
      for (let trailIndex = 0; trailIndex < windTrailPoints - 1; trailIndex += 1) {
        const [tailX, tailZ] = particle.trail[trailIndex];
        const [headX, headZ] = particle.trail[trailIndex + 1];
        const offset = baseOffset + trailIndex * 6;
        positions[offset] = tailX;
        positions[offset + 1] = terrainHeightAt(tailX, tailZ) + 5;
        positions[offset + 2] = tailZ;
        positions[offset + 3] = headX;
        positions[offset + 4] = terrainHeightAt(headX, headZ) + 5;
        positions[offset + 5] = headZ;
      }
    });
    windPoints.geometry.attributes.position.needsUpdate = true;
  }

  function pointerGround(event) {
    const pointer = new THREE.Vector2(event.clientX / innerWidth * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -terrainHeightAt(windState.center[0], windState.center[1]));
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  function windHandleScreenPoint() {
    if (!windHandle?.visible) return null;
    const projected = windHandle.position.clone().project(camera);
    return {
      x: (projected.x * 0.5 + 0.5) * innerWidth,
      y: (-projected.y * 0.5 + 0.5) * innerHeight,
    };
  }

  function capturePointer(event) {
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic validation events do not have an active pointer; real
      // pointerdown events still use capture normally.
    }
  }

  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    if (windState.enabled && windState.moveMode) {
      const point = pointerGround(event);
      if (point) {
        const half = windState.size * 0.5;
        const handleScreen = windHandleScreenPoint();
        const handleDistance = handleScreen
          ? Math.hypot(event.clientX - handleScreen.x, event.clientY - handleScreen.y)
          : Infinity;
        const handleTolerance = 20;
        windDrag = {
          mode: handleDistance <= handleTolerance ? 'resize' : 'move',
          start: point,
          center: [...windState.center],
          size: windState.size,
        };
        windState.field = null;
        clearWindSimulation();
        windStatus.textContent = windDrag.mode === 'resize'
          ? 'Resizing domain · release, then simulate wind.'
          : 'Moving domain · release, then simulate wind.';
        capturePointer(event);
        return;
      }
    }
    drag = {
      x: event.clientX,
      y: event.clientY,
      azimuth: cameraState.azimuth,
      elevation: cameraState.elevation,
      target: cameraState.target.clone(),
      pan: event.shiftKey || event.button !== 0,
    };
    capturePointer(event);
  });
  canvas.addEventListener('pointermove', event => {
    if (windDrag) {
      const point = pointerGround(event);
      if (!point) return;
      if (windDrag.mode === 'resize') {
        const requested = Math.max(Math.abs(point.x - windDrag.center[0]), Math.abs(point.z - windDrag.center[1])) * 2;
        const maximum = Math.min(1200,
          2 * (windDrag.center[0] - left), 2 * (right - windDrag.center[0]),
          2 * (windDrag.center[1] - minZ), 2 * (maxZ - windDrag.center[1]));
        windState.size = Math.round(clamp(requested, 100, maximum) / 25) * 25;
        if (windSize) windSize.value = String(windState.size);
        if (windSizeValue) windSizeValue.textContent = String(windState.size);
      } else {
        windState.center[0] = clamp(windDrag.center[0] + point.x - windDrag.start.x, left + windState.size / 2, right - windState.size / 2);
        windState.center[1] = clamp(windDrag.center[1] + point.z - windDrag.start.z, minZ + windState.size / 2, maxZ - windState.size / 2);
      }
      windState.field = null;
      updateWindBox();
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.pan) {
      const scale = cameraState.distance / 850;
      const rightVector = new THREE.Vector3(Math.sin(drag.azimuth), 0, -Math.cos(drag.azimuth));
      const forwardVector = new THREE.Vector3(-Math.cos(drag.azimuth), 0, -Math.sin(drag.azimuth));
      cameraState.target.copy(drag.target).addScaledVector(rightVector, -dx * scale).addScaledVector(forwardVector, dy * scale);
    } else {
      cameraState.azimuth = drag.azimuth - dx * 0.006;
      cameraState.elevation = clamp(drag.elevation - dy * 0.006, 0.16, 1.35);
    }
    updateCamera();
  });
  for (const name of ['pointerup', 'pointercancel']) canvas.addEventListener(name, () => {
    drag = null;
    if (windDrag && windState.moveMode) {
      windStatus.textContent = windDrag.mode === 'resize'
        ? `Domain resized to ${windState.size} m · click Simulate wind.`
        : 'Domain moved · click Simulate wind.';
    }
    windDrag = null;
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    cameraState.distance = clamp(cameraState.distance * Math.exp(event.deltaY * 0.0008), 80, 7000);
    updateCamera();
  }, { passive: false });
  canvas.addEventListener('dblclick', fitScene);
  document.querySelector('#fit')?.addEventListener('click', fitScene);
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', event => {
    const group = layerGroups[event.target.dataset.layer];
    if (group) {
      group.visible = event.target.checked;
      if (!shadowState.enabled && !heatGroup.visible) savedVisibility[event.target.dataset.layer] = group.visible;
    }
    requestRender();
  }));

  heatToggle?.addEventListener('change', event => setHeatMode(event.target.checked));
  sunToggle?.addEventListener('change', event => setShadowMode(event.target.checked));
  sunDate?.addEventListener('change', event => {
    shadowState.date = event.target.value || shadowState.date;
    queueLiveShadowUpdate();
  });
  sunTime?.addEventListener('input', event => {
    shadowState.minutes = Number(event.target.value);
    queueLiveShadowUpdate();
  });
  sunGenerate?.addEventListener('click', generateShadows);

  windToggle?.addEventListener('change', event => {
    if (event.target.checked && heatGroup.visible) {
      if (heatToggle) heatToggle.checked = false;
      setHeatMode(false);
    }
    if (event.target.checked && shadowState.enabled) setShadowMode(false);
    windState.enabled = event.target.checked;
    windGroup.visible = windState.enabled;
    windStatus.textContent = windState.enabled
      ? (windState.field ? 'Existing wind heatmap and gusts shown.' : '3D domain ready · position it, then simulate.')
      : 'Wind display hidden.';
    requestRender();
  });
  windDirection?.addEventListener('change', event => {
    windState.direction = Number(event.target.value);
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = 'Direction changed · click Simulate wind.';
    requestRender();
  });
  windSeason?.addEventListener('change', event => {
    windState.season = event.target.value;
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = 'Season changed · click Simulate wind.';
    requestRender();
  });
  windSpeed?.addEventListener('input', event => {
    windState.speed = Number(event.target.value);
    windSpeedValue.textContent = windState.speed.toFixed(1);
  });
  windSize?.addEventListener('input', event => {
    windState.size = Number(event.target.value);
    windSizeValue.textContent = String(windState.size);
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = 'Domain resized · click Simulate wind.';
    updateWindBox();
  });
  windMoveDomain?.addEventListener('click', () => {
    windState.moveMode = !windState.moveMode;
    windMoveDomain.classList.toggle('active', windState.moveMode);
    windMoveDomain.setAttribute('aria-pressed', String(windState.moveMode));
    windMoveDomain.textContent = windState.moveMode ? 'Done moving' : 'Move / resize domain';
    updateWindBox();
  });
  windSimulate?.addEventListener('click', simulateWind);

  function render(now = performance.now()) {
    animationFrame = 0;
    resize();
    updateWindParticles(now);
    renderer.render(scene, camera);
    renderRequested = false;
    if (windState.enabled && windState.field) animationFrame = requestAnimationFrame(render);
  }

  addEventListener('resize', requestRender);
  fitScene();
  updateWindBox();
  windGroup.visible = windState.enabled;
  status.textContent = `${data.buildings.length} buildings · ${data.trees.length} trees · WebGL GPU renderer`;
  updateSunStatus();
  loadHeat();
  setHeatMode(Boolean(heatToggle?.checked));
  requestRender();

  return { renderer, scene, camera };
}
