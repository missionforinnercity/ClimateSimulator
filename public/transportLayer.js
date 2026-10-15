import { scopedFetch as fetch } from './requestClient.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

// Planning constants. Every one of these is an assumption, not an observation,
// and the panel says so wherever a number derived from them is shown.
const WALK_SPEED_M_PER_MIN = 80;       // 4.8 km/h, the usual pedestrian planning speed.
const BUS_SPEED_M_PER_MIN = 300;       // 18 km/h in mixed CBD traffic.
const RAIL_SPEED_M_PER_MIN = 667;      // 40 km/h approaching a terminus.
// Nominal scheduled capacity per departure, not a measured or validated
// occupancy figure: no real ridership/occupancy data is used anywhere here.
// Treat every derived "coverage" or "capacity gap" number as an event-demand
// proxy for planning discussion, and verify it with the operator.
const BUS_PLACES_PER_DEPARTURE = 60;
const RAIL_PLACES_PER_DEPARTURE = 800;

function minuteLabel(value) {
  const minute = ((Math.round(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function colorHex(color) {
  return typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : color;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]
  ));
}

function lineMetrics(points) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
  }
  return { points, cumulative, length: cumulative.at(-1) || 1 };
}

function sampleLine(metric, amount) {
  const distance = clamp(amount, 0, 1) * metric.length;
  let index = 1;
  while (index < metric.cumulative.length - 1 && metric.cumulative[index] < distance) index += 1;
  const startDistance = metric.cumulative[index - 1];
  const segmentLength = Math.max(metric.cumulative[index] - startDistance, 0.001);
  const mix = clamp((distance - startDistance) / segmentLength, 0, 1);
  const start = metric.points[index - 1], end = metric.points[index];
  return {
    x: start[0] + (end[0] - start[0]) * mix,
    z: start[1] + (end[1] - start[1]) * mix,
    dx: end[0] - start[0], dz: end[1] - start[1],
  };
}

function nearestFraction(metric, point) {
  let best = { distance: Infinity, fraction: 0 };
  for (let index = 1; index < metric.points.length; index += 1) {
    const a = metric.points[index - 1], b = metric.points[index];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const lengthSquared = dx * dx + dz * dz || 1;
    const mix = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared, 0, 1);
    const x = a[0] + dx * mix, z = a[1] + dz * mix;
    const distance = Math.hypot(point[0] - x, point[1] - z);
    if (distance < best.distance) best = {
      distance, fraction: (metric.cumulative[index - 1] + Math.sqrt(lengthSquared) * mix) / metric.length,
    };
  }
  return best;
}

const vehicleModelCache = new WeakMap();

function roundedBoxGeometry(THREE, width, height, depth, radius = 0.08) {
  const geometry = new THREE.BoxGeometry(width, height, depth, 4, 2, 2);
  const positions = geometry.getAttribute('position');
  const innerX = width * 0.5 - radius;
  const innerY = height * 0.5 - radius;
  const innerZ = depth * 0.5 - radius;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    const cx = clamp(x, -innerX, innerX), cy = clamp(y, -innerY, innerY), cz = clamp(z, -innerZ, innerZ);
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > 0) positions.setXYZ(index, cx + dx * radius / distance, cy + dy * radius / distance, cz + dz * radius / distance);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function mergeVehicleParts(THREE, parts) {
  const vertices = [], normals = [], colours = [];
  for (const part of parts) {
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    geometry.applyMatrix4(part.matrix);
    const positions = geometry.getAttribute('position');
    const vertexNormals = geometry.getAttribute('normal');
    const color = new THREE.Color(part.color);
    for (let index = 0; index < positions.count; index += 1) {
      vertices.push(positions.getX(index), positions.getY(index), positions.getZ(index));
      normals.push(vertexNormals.getX(index), vertexNormals.getY(index), vertexNormals.getZ(index));
      colours.push(color.r, color.g, color.b);
    }
    geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  merged.computeBoundingSphere();
  return merged;
}

function createVehicleModel(THREE, kind) {
  let cache = vehicleModelCache.get(THREE);
  if (!cache) {
    cache = new Map();
    vehicleModelCache.set(THREE, cache);
  }
  if (cache.has(kind)) return cache.get(kind);

  const parts = [];
  const accentParts = [];
  const addBox = (size, position, color, radius = 0.035) => {
    const geometry = roundedBoxGeometry(THREE, ...size, radius);
    const matrix = new THREE.Matrix4().makeTranslation(...position);
    parts.push({ geometry, matrix, color });
  };
  const addAccentBox = (size, position, color, radius = 0.045) => {
    const geometry = roundedBoxGeometry(THREE, ...size, radius);
    const matrix = new THREE.Matrix4().makeTranslation(...position);
    accentParts.push({ geometry, matrix, color });
  };
  const addCylinder = (radius, depth, position, color, segments = 14) => {
    const geometry = new THREE.CylinderGeometry(radius, radius, depth, segments, 1);
    geometry.rotateX(Math.PI / 2);
    const matrix = new THREE.Matrix4().makeTranslation(...position);
    parts.push({ geometry, matrix, color });
  };

  if (kind === 'bus') {
    // A compact Cape Town MyCiTi inspired low-floor bus, with a white roof,
    // blue lower body, red belt and properly separated glazing.
    addBox([10.8, 0.54, 2.52], [0, 0.58, 0], 0x30383a, 0.08);
    addBox([10.72, 1.08, 2.58], [0, 1.34, 0], 0x087da9, 0.14);
    addBox([10.58, 1.08, 2.52], [-0.03, 2.42, 0], 0xf1eee3, 0.16);
    addBox([9.4, 0.18, 2.34], [-0.08, 3.05, 0], 0xd7e0de, 0.08);
    // Fleet-blue roof panel makes the bus read clearly from the miniature
    // city view while retaining its white upper body and red belt.
    addAccentBox([9.5, 0.24, 2.65], [-0.42, 3.31, 0], 0x078fc4);
    for (const side of [-1, 1]) {
      const z = side * 1.305;
      addBox([8.62, 0.84, 0.055], [-0.05, 2.45, z], 0x203b46, 0.025);
      addBox([10.65, 0.15, 0.07], [0, 0.9, side * 1.31], 0xe04b47, 0.025);
      for (let pillar = 0; pillar <= 7; pillar += 1) {
        addBox([0.085, 0.93, 0.075], [-4.05 + pillar * 1.14, 2.46, side * 1.34], 0xc3d1cf, 0.02);
      }
      addBox([0.92, 1.36, 0.075], [2.95, 1.98, side * 1.34], 0x315763, 0.035);
      addBox([0.10, 1.52, 0.085], [2.47, 1.98, side * 1.35], 0xc3d1cf, 0.02);
      addBox([0.10, 1.52, 0.085], [3.43, 1.98, side * 1.35], 0xc3d1cf, 0.02);
    }
    addBox([0.065, 0.94, 1.65], [5.43, 2.48, 0], 0x1c343e, 0.035);
    addBox([0.075, 0.24, 1.20], [5.45, 3.05, 0], 0x203b46, 0.02);
    addBox([0.22, 0.30, 2.30], [5.43, 0.55, 0], 0x4b5353, 0.035);
    addBox([0.22, 0.30, 2.30], [-5.43, 0.55, 0], 0x4b5353, 0.035);
    for (const side of [-1, 1]) {
      for (const x of [-3.25, 3.35]) {
        addCylinder(0.43, 0.25, [x, 0.44, side * 1.25], 0x202426);
        addCylinder(0.20, 0.27, [x, 0.44, side * 1.34], 0xaab3b3, 12);
      }
    }
    for (const z of [-0.84, 0.84]) {
      addBox([0.10, 0.17, 0.28], [5.49, 1.05, z], 0xffe7ac, 0.035);
      addBox([0.08, 0.17, 0.24], [-5.49, 1.02, z], 0xe34d47, 0.03);
    }
  } else {
    // Three clean commuter carriages with visible bogies, framed windows,
    // cyan beltwork and cab glazing at both ends.
    for (let carriage = 0; carriage < 3; carriage += 1) {
      const offset = (carriage - 1) * 12.25;
      addBox([11.95, 2.64, 2.82], [offset, 1.92, 0], 0xe6e9e6, 0.20);
      addBox([11.72, 0.42, 2.91], [offset, 0.94, 0], 0x078fb6, 0.07);
      addBox([11.50, 0.16, 2.45], [offset, 3.34, 0], 0xc6cfcd, 0.07);
      // The cool enamel roof panel gives each carriage a clear top-down
      // silhouette and separates it from the neutral mapped roofs.
      addAccentBox([10.4, 0.22, 2.7], [offset, 3.57, 0], 0x08c5dc);
      for (const side of [-1, 1]) {
        for (let window = 0; window < 5; window += 1) {
          const x = offset - 4.45 + window * 2.22;
          addBox([1.46, 0.92, 0.065], [x, 2.36, side * 1.445], 0x203943, 0.055);
          addBox([0.075, 1.02, 0.08], [x - 0.78, 2.35, side * 1.45], 0xc9d3d1, 0.02);
        }
        for (const x of [offset - 2.9, offset + 2.9]) {
          addBox([0.76, 1.84, 0.07], [x, 1.98, side * 1.45], 0x355967, 0.05);
          addBox([0.08, 1.95, 0.085], [x - 0.42, 1.98, side * 1.46], 0xc9d3d1, 0.02);
          addBox([0.08, 1.95, 0.085], [x + 0.42, 1.98, side * 1.46], 0xc9d3d1, 0.02);
        }
      }
      for (const x of [offset - 3.75, offset + 3.75]) {
        addBox([1.35, 0.25, 2.52], [x, 0.60, 0], 0x353c3e, 0.035);
        for (const side of [-1, 1]) addCylinder(0.43, 0.24, [x, 0.43, side * 1.23], 0x202426);
      }
    }
    for (const end of [-1, 1]) {
      addBox([0.10, 1.08, 1.72], [end * 18.43, 2.43, 0], 0x1c343e, 0.06);
      addBox([0.12, 0.18, 0.28], [end * 18.50, 1.38, -0.78], 0xffe3a2, 0.035);
      addBox([0.12, 0.18, 0.28], [end * 18.50, 1.38, 0.78], 0xffe3a2, 0.035);
      addBox([0.12, 0.18, 0.26], [end * 18.50, 0.88, -0.78], 0xe34d47, 0.03);
      addBox([0.12, 0.18, 0.26], [end * 18.50, 0.88, 0.78], 0xe34d47, 0.03);
    }
  }

  const model = {
    geometry: mergeVehicleParts(THREE, parts),
    material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.06 }),
    accentGeometry: mergeVehicleParts(THREE, accentParts),
    accentMaterial: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  };
  cache.set(kind, model);
  return model;
}

function makeBus(THREE) {
  const model = createVehicleModel(THREE, 'bus');
  const vehicle = new THREE.Group();
  const body = new THREE.Mesh(model.geometry, model.material);
  // Extend the bus along its travel axis for a legible articulated-city
  // silhouette while preserving its realistic road width.
  vehicle.scale.set(2.15, 1.35, 1.7);
  body.castShadow = true;
  body.receiveShadow = true;
  vehicle.add(body);
  const roofAccent = new THREE.Mesh(model.accentGeometry, model.accentMaterial);
  roofAccent.castShadow = false;
  roofAccent.receiveShadow = false;
  vehicle.add(roofAccent);
  vehicle.userData.kind = 'bus';
  return vehicle;
}

function makeTrain(THREE) {
  const model = createVehicleModel(THREE, 'train');
  const vehicle = new THREE.Group();
  const body = new THREE.Mesh(model.geometry, model.material);
    // Three carriage meshes represent a full-size commuter consist in the
    // miniature scene, so scale them to the mapped track width and readable
    // city-view size.
  vehicle.scale.set(2.05, 1.35, 1.7);
  body.castShadow = true;
  body.receiveShadow = true;
  vehicle.add(body);
  const roofAccent = new THREE.Mesh(model.accentGeometry, model.accentMaterial);
  roofAccent.castShadow = false;
  roofAccent.receiveShadow = false;
  vehicle.add(roofAccent);
  vehicle.userData.kind = 'train';
  return vehicle;
}

export async function createTransportLayer({
  THREE, scene, terrainHeightAt, terrainValidAt, requestRender, frameBounds,
  requestGroundPick, addScenePickHandler, layerVisible = () => true,
}) {
  const response = await fetch('/assets/transport.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Transport asset HTTP ${response.status}`);
  const data = await response.json();
  const group = new THREE.Group();
  const routeGroup = new THREE.Group();
  const stopGroup = new THREE.Group();
  const vehicleGroup = new THREE.Group();
  const eventGroup = new THREE.Group();
  group.add(routeGroup, stopGroup, eventGroup, vehicleGroup);
  scene.add(group);
  group.visible = false;

  const elements = Object.fromEntries([
    'transport-toggle', 'transport-routes-toggle', 'transport-stops-toggle',
    'transport-route', 'transport-time', 'transport-time-value', 'transport-play', 'transport-speed',
    'transport-vehicle-count', 'transport-status', 'transport-fit', 'transport-now', 'transport-next-rail',
    'transport-service-day', 'transport-data-source',
    'transport-event-name', 'transport-event-date', 'transport-event-start', 'transport-event-end',
    'transport-event-venue', 'transport-event-pick', 'transport-event-venue-label',
    'transport-event-walk', 'transport-event-buffer', 'transport-event-dispersal',
    'transport-event-share', 'transport-event-share-value',
    'transport-event-attendance', 'transport-event-attendance-value', 'transport-event-analyse',
    'transport-event-results', 'transport-event-grade', 'transport-event-areas',
    'transport-event-arrivals', 'transport-event-returns', 'transport-event-cover',
    'transport-demand-value', 'transport-capacity-value', 'transport-gap-value',
    'transport-coverage-chart', 'transport-arrival-bar', 'transport-return-bar',
    'transport-results-close', 'transport-results-title',
    'transport-event-recommendation', 'transport-event-actions',
    'transport-event-services', 'transport-event-area-list',
    'transport-stop-card',
  ].map(id => [id, document.querySelector(`#${id}`)]));
  if (!elements['transport-toggle']) return { update: () => false, active: () => false };

  const stopById = new Map(data.stops.map(stop => [stop.id, stop]));
  const railStationById = new Map((data.railStations || []).map(stop => [stop.id, stop]));
  const hubStation = railStationById.get(data.hubStationId);
  const hubFootprints = data.hubFootprints || [];
  const hubEntrances = data.hubEntrances || [];
  const railById = new Map(data.rail.map(rail => [rail.id, rail]));
  let walkNodes = [];
  let walkEdges = [];
  let walkAdjacency = null;
  let stopWalkTargets = null;
  let hubWalkTargets = null;
  let walkNetworkPromise = null;

  function ensureWalkNetwork() {
    if (walkAdjacency) return Promise.resolve();
    if (walkNetworkPromise) return walkNetworkPromise;
    walkNetworkPromise = (async () => {
      let network = data.walkNetwork;
      if (!network) {
        const asset = data.walkNetworkAsset || 'transport_walk_network.json';
        const response = await fetch(`/assets/${encodeURIComponent(asset)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Pedestrian network HTTP ${response.status}`);
        network = await response.json();
      }
      walkNodes = Array.isArray(network.nodes) ? network.nodes : [];
      walkEdges = Array.isArray(network.edges) ? network.edges : [];
      if (!walkNodes.length || !walkEdges.length) throw new Error('Pedestrian network is empty or invalid');
      walkAdjacency = walkNodes.map(() => []);
      for (const [a, b, length] of walkEdges) {
        walkAdjacency[a]?.push([b, length]);
        walkAdjacency[b]?.push([a, length]);
      }
      stopWalkTargets = new Map(data.stops.map(stop => [stop.id, walkTarget(stop.point)]));
      hubWalkTargets = (hubEntrances.length ? hubEntrances : hubStation ? [{ point: hubStation.point }] : [])
        .map(entrance => ({ ...entrance, ...walkTarget(entrance.point) }));
      data.walkNetwork = network;
    })().catch(error => {
      walkNodes = [];
      walkEdges = [];
      walkAdjacency = null;
      stopWalkTargets = null;
      hubWalkTargets = null;
      walkNetworkPromise = null;
      throw error;
    });
    return walkNetworkPromise;
  }

  const nearestWalkNode = point => {
    let bestNode = -1, bestDistance = Infinity;
    for (let index = 0; index < walkNodes.length; index += 1) {
      const distance = Math.hypot(point[0] - walkNodes[index][0], point[1] - walkNodes[index][1]);
      if (distance < bestDistance) { bestNode = index; bestDistance = distance; }
    }
    return { node: bestNode, offset: bestDistance };
  };

  function walkNetworkFrom(point) {
    const origin = nearestWalkNode(point);
    const distances = new Float64Array(walkNodes.length);
    distances.fill(Infinity);
    if (origin.node < 0) return { origin, distances };
    distances[origin.node] = 0;
    const heap = [[0, origin.node]];
    const push = item => {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent][0] <= item[0]) break;
        heap[index] = heap[parent]; index = parent;
      }
      heap[index] = item;
    };
    const pop = () => {
      const first = heap[0], last = heap.pop();
      if (heap.length && last) {
        let index = 0;
        while (true) {
          let child = index * 2 + 1;
          if (child >= heap.length) break;
          if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child += 1;
          if (heap[child][0] >= last[0]) break;
          heap[index] = heap[child]; index = child;
        }
        heap[index] = last;
      }
      return first;
    };
    while (heap.length) {
      const [distance, node] = pop();
      if (distance !== distances[node]) continue;
      for (const [next, length] of walkAdjacency[node]) {
        const candidate = distance + length;
        if (candidate >= distances[next]) continue;
        distances[next] = candidate;
        push([candidate, next]);
      }
    }
    return { origin, distances };
  }

  const walkTarget = point => ({ point, ...nearestWalkNode(point) });
  const networkDistance = (network, target) => target?.node >= 0
    ? network.origin.offset + network.distances[target.node] + target.offset
    : Infinity;
  const distanceToHub = network => Math.min(...hubWalkTargets.map(target => networkDistance(network, target)), Infinity);

  const dayKey = date => date.getDay() === 0 ? 'sunday' : date.getDay() === 6 ? 'saturday' : 'weekday';
  const dayLabel = date => date.getDay() === 0 ? 'Sunday service' : date.getDay() === 6 ? 'Saturday service' : 'Weekday service';
  const scheduledRailTimes = (rail, date = state?.serviceDate || new Date()) => {
    const schedule = rail.schedule?.[dayKey(date)];
    const fallback = rail.fallbackDepartures || rail.departures || [];
    const outbound = schedule?.outboundDepartures?.length ? schedule.outboundDepartures : fallback;
    const inbound = schedule?.inboundArrivals?.length ? schedule.inboundArrivals : fallback;
    return { outbound, inbound, published: Boolean(schedule?.outboundDepartures?.length || schedule?.inboundArrivals?.length) };
  };

  const routeColors = [0x00a7d9, 0xe33f3f, 0x08a45b, 0xf0b735, 0x8d5da7, 0xe56e2e];
  const colorForRoute = route => routeColors[[...route.number].reduce((sum, character) => sum + character.charCodeAt(0), 0) % routeColors.length];

  // Each bus route direction is placed on its longest visible run, and the run
  // is crossed at a plausible street speed. The source PDFs only give trip
  // endpoints, so the departure cadence is real but the moment a vehicle
  // enters the modelled view is an interpolation.
  for (const route of data.routes) {
    const metrics = route.lines.map(lineMetrics);
    route._metric = metrics.reduce((best, item) => !best || item.length > best.length ? item : best, null);
    route._departures = route.trips.map(trip => trip[0]).sort((a, b) => a - b);
    route._duration = Math.max(0.8, route._metric.length / BUS_SPEED_M_PER_MIN);
    route._color = colorForRoute(route);
    route._label = `MyCiTi ${route.number}`;
    route._stopFractions = route.stopIds.map(id => {
      const stop = stopById.get(id);
      return stop ? { id, ...nearestFraction(route._metric, stop.point) } : null;
    }).filter(item => item && item.distance < 55).sort((a, b) => a.fraction - b.fraction);
  }
  // Corridors whose own mapped geometry never enters the modelled CBD extent
  // (they leave the scene almost immediately) still need a physical track to
  // run on. Instead of every one of them collapsing onto a single shared
  // line -- which piles half the fleet onto one alignment and reads as
  // z-fighting where colours overlap -- collect every distinct physical
  // approach into the hub and hand them out round-robin, so unmapped
  // corridors spread across the real track fan instead of stacking.
  const serviceApproaches = (data.railTracks || [])
    .map(points => {
      const metric = lineMetrics(points);
      const hubDistance = hubStation ? nearestFraction(metric, hubStation.point).distance : 0;
      const endpointReach = hubStation
        ? Math.max(Math.hypot(points[0][0] - hubStation.point[0], points[0][1] - hubStation.point[1]),
          Math.hypot(points.at(-1)[0] - hubStation.point[0], points.at(-1)[1] - hubStation.point[1]))
        : metric.length;
      return { points, metric, hubDistance, endpointReach };
    })
    // Reject station-yard loops whose two endpoints stay beside the hub. A
    // shared service approach must visibly lead away from Cape Town Station.
    .filter(item => item.hubDistance < 90 && item.endpointReach > 150)
    .sort((a, b) => b.endpointReach - a.endpointReach || b.metric.length - a.metric.length)
    .map(item => item.points);
  const sharedRailLine = serviceApproaches[0] || null;
  const isVisibleServiceApproach = line => {
    if (!line?.length || !hubStation) return Boolean(line?.length);
    const metric = lineMetrics(line);
    const hubDistance = nearestFraction(metric, hubStation.point).distance;
    const endpointReach = Math.max(
      Math.hypot(line[0][0] - hubStation.point[0], line[0][1] - hubStation.point[1]),
      Math.hypot(line.at(-1)[0] - hubStation.point[0], line.at(-1)[1] - hubStation.point[1]),
    );
    return hubDistance < 100 && endpointReach > 150;
  };
  let unmappedCorridorIndex = 0;
  for (const rail of data.rail) {
    // Use every through-running line that actually reaches the visible hub,
    // excluding disconnected platform/yard loops carried in the source GIS.
    rail._movementLines = (rail.lines || []).filter(isVisibleServiceApproach);
    if (!rail._movementLines.length && serviceApproaches.length) {
      rail._movementLines = [serviceApproaches[unmappedCorridorIndex % serviceApproaches.length]];
      unmappedCorridorIndex += 1;
    }
    rail._metrics = rail._movementLines.map(lineMetrics);
    rail._metric = rail._metrics[0] || null;
    rail._departures = rail.departures || rail.trips.map(trip => trip[0]);
    // A kilometre-scale CBD approach otherwise flashes past in under a minute.
    // Four minutes retains the published departure time while keeping the
    // timetable-derived train legible at normal playback speed.
    rail._duration = rail._metric ? Math.max(4, rail._metric.length / RAIL_SPEED_M_PER_MIN) : 1;
    rail._label = `Rail · ${rail.name}`;
    rail._color = rail.color;
  }

  // Which route directions call at a given stop, for the stop info card.
  const routesByStop = new Map();
  for (const route of data.routes) {
    for (const entry of route._stopFractions) {
      if (!routesByStop.has(entry.id)) routesByStop.set(entry.id, []);
      routesByStop.get(entry.id).push({ route, fraction: entry.fraction });
    }
  }

  function stopDepartures(stopId, fromMinute, limit = 6) {
    const times = [];
    for (const { route, fraction } of routesByStop.get(stopId) || []) {
      for (const trip of route.trips) {
        const time = trip[0] + fraction * (trip[1] - trip[0]);
        times.push({ time: time % 1440, wait: ((time - fromMinute) % 1440 + 1440) % 1440, route });
      }
    }
    return times.sort((a, b) => a.wait - b.wait).slice(0, limit);
  }

  function addRibbon(points, color, width = 2.6, opacity = 0.9, elevation = 0.82, target = routeGroup, lateralOffset = 0) {
    // Source route geometry can contain very long segments. Densify before
    // draping so a route cannot pass through a terrain ridge or disappear
    // beneath the road between two source vertices.
    const draped = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index], end = points[index + 1];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const sections = Math.max(1, Math.ceil(length / 4));
      for (let section = 0; section < sections; section += 1) {
        const amount = section / sections;
        draped.push([
          start[0] + (end[0] - start[0]) * amount,
          start[1] + (end[1] - start[1]) * amount,
        ]);
      }
    }
    if (points.length) draped.push(points.at(-1));
    // The terrain mask has isolated holes inside the modelled footprint. A
    // track should bridge those short gaps, but it must stop where the city
    // surface genuinely ends. Keep track of clipped ends so those edges can
    // taper away instead of terminating as blunt rectangles.
    const runs = [];
    let runStart = -1, lastValid = -1, gapStart = -1;
    const maxBridgedSamples = 3; // at most 12 m at the 4 m sample spacing
    const finishRun = clippedEnd => {
      if (runStart >= 0 && lastValid - runStart > 0) {
        runs.push({ points: draped.slice(runStart, lastValid + 1), clippedStart: runStart > 0, clippedEnd });
      }
      runStart = -1;
      lastValid = -1;
      gapStart = -1;
    };
    for (let index = 0; index < draped.length; index += 1) {
      if (terrainValidAt(...draped[index])) {
        if (runStart < 0) runStart = index;
        else if (gapStart >= 0 && index - gapStart > maxBridgedSamples) {
          finishRun(true);
          runStart = index;
        }
        lastValid = index;
        gapStart = -1;
      } else if (runStart >= 0 && gapStart < 0) gapStart = index;
    }
    if (runStart >= 0) finishRun(lastValid < draped.length - 1);
    for (const run of runs) {
      const visible = run.points;
      const cumulative = [0];
      for (let index = 1; index < visible.length; index += 1) {
        cumulative.push(cumulative[index - 1] + Math.hypot(
          visible[index][0] - visible[index - 1][0], visible[index][1] - visible[index - 1][1],
        ));
      }
      const runLength = cumulative.at(-1) || 0;
      const taperLength = Math.min(20, runLength * 0.42);
      const smoothstep = value => {
        const t = clamp(value, 0, 1);
        return t * t * (3 - 2 * t);
      };
      const vertices = [], indices = [];
      for (let index = 0; index < visible.length; index += 1) {
        const [x, z] = visible[index];
        const previous = visible[Math.max(0, index - 1)], next = visible[Math.min(visible.length - 1, index + 1)];
        const dx = next[0] - previous[0], dz = next[1] - previous[1];
        const length = Math.hypot(dx, dz) || 1;
        const normalX = -dz / length, normalZ = dx / length;
        const distanceToStart = run.clippedStart ? smoothstep(cumulative[index] / taperLength) : 1;
        const distanceToEnd = run.clippedEnd ? smoothstep((runLength - cumulative[index]) / taperLength) : 1;
        const halfWidth = width * Math.min(distanceToStart, distanceToEnd) / 2;
        vertices.push(
          x + normalX * (lateralOffset + halfWidth), terrainHeightAt(x + normalX * (lateralOffset + halfWidth), z + normalZ * (lateralOffset + halfWidth)) + elevation, z + normalZ * (lateralOffset + halfWidth),
          x + normalX * (lateralOffset - halfWidth), terrainHeightAt(x + normalX * (lateralOffset - halfWidth), z + normalZ * (lateralOffset - halfWidth)) + elevation, z + normalZ * (lateralOffset - halfWidth),
        );
        if (index) {
          const left = index * 2, right = left + 1, previousLeft = left - 2, previousRight = left - 1;
          indices.push(previousLeft, previousRight, left, previousRight, right, left);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthTest: true, depthWrite: false,
        side: THREE.DoubleSide,
        // Bias overlays toward the camera only within their existing depth.
        // Buildings still occlude routes, while coplanar roads cannot erase them.
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      }));
      mesh.renderOrder = 20;
      target.add(mesh);
    }
  }

  const now = new Date();
  const state = {
    enabled: elements['transport-toggle'].checked, playing: true,
    minute: clamp(now.getHours() * 60 + now.getMinutes(), 0, 1439), serviceDate: now,
    lastFrame: performance.now(), mode: 'both', picking: false,
    ambientDisplay: false, panelActive: false, movingVehicles: 0,
    eventRouteIds: new Set(), eventRailIds: new Set(),
    servedStopIds: new Set(), venue: null, analysis: null,
    busPool: [], trainPool: [],
  };

  function selectedRoutes() {
    const selected = elements['transport-route'].value;
    if (state.mode === 'train') return [];
    let routes = selected === 'all' ? data.routes : data.routes.filter(route => route.number === selected);
    if (state.eventRouteIds.size && selected === 'all') {
      routes = [...routes].sort((a, b) => Number(state.eventRouteIds.has(b.id)) - Number(state.eventRouteIds.has(a.id)));
    }
    return routes.slice(0, selected === 'all' ? 24 : 4);
  }

  function activeRail() {
    if (state.mode === 'bus') return [];
    return data.rail.filter(rail => rail._metric);
  }

  // Markers are map pins, not scale models. They are drawn with depth testing
  // off so a stop behind a tower is still visible and still clickable, and
  // sized so they survive being framed on a whole walk catchment.
  const markerMaterial = (color, emissive) => new THREE.MeshPhongMaterial({
    color, emissive, depthTest: false, depthWrite: false,
  });
  const stationMarkerGeometry = new THREE.CylinderGeometry(14, 14, 2.0, 24);
  const stopPostGeometry = new THREE.CylinderGeometry(0.45, 0.62, 5.4, 8);
  const stationPostGeometry = new THREE.CylinderGeometry(1.8, 1.8, 22, 8);
  const makeBusSignMaterial = color => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(9, 9, 110, 110, 24);
    context.fill();
    context.strokeStyle = '#f8fbfc';
    context.lineWidth = 7;
    context.stroke();
    // A compact front-on bus pictogram stays legible at map scale.
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.roundRect(36, 25, 56, 63, 11);
    context.fill();
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(43, 33, 42, 21, 5);
    context.fill();
    context.fillStyle = '#ffffff';
    context.fillRect(43, 60, 42, 7);
    context.fillRect(45, 73, 8, 7);
    context.fillRect(75, 73, 8, 7);
    context.fillStyle = color;
    context.beginPath();
    context.arc(48, 88, 5, 0, Math.PI * 2);
    context.arc(76, 88, 5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffffff';
    context.font = 'bold 17px sans-serif';
    context.textAlign = 'center';
    context.fillText('BUS', 64, 108);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  };
  const stopMaterials = {
    stop: makeBusSignMaterial('#1686a6'),
    served: makeBusSignMaterial('#19996b'),
    station: markerMaterial(0xf2f2ee, 0x1b4d5c),
    stationServed: markerMaterial(0x7fd8ec, 0x11485c),
    post: markerMaterial(0x8d9296, 0x1a1a1a),
  };

  function addMarker(point, kind, material, pick) {
    if (!terrainValidAt(...point)) return;
    const station = kind === 'station';
    const height = terrainHeightAt(...point);
    if (!station) {
      const pole = new THREE.Mesh(stopPostGeometry, stopMaterials.post);
      pole.position.set(point[0], height + 2.7, point[1]);
      const sign = new THREE.Sprite(material);
      sign.position.set(point[0], height + 6.9, point[1]);
      sign.scale.set(6.8, 6.8, 1);
      for (const mesh of [pole, sign]) {
        mesh.renderOrder = 26;
        mesh.userData.pick = pick;
        stopGroup.add(mesh);
      }
      return;
    }
    const marker = new THREE.Mesh(stationMarkerGeometry, material);
    marker.position.set(point[0], height + 22, point[1]);
    const post = new THREE.Mesh(stationPostGeometry, stopMaterials.post);
    post.position.set(point[0], height + 11, point[1]);
    for (const mesh of [marker, post]) {
      mesh.renderOrder = 26;
      mesh.userData.pick = pick;
      stopGroup.add(mesh);
    }
  }

  function rebuildMap() {
    routeGroup.clear();
    stopGroup.clear();
    const routes = selectedRoutes();
    if (state.panelActive && elements['transport-routes-toggle'].checked) {
      // The city rail layer now carries the actual rails, sleepers and
      // ballast. Avoid covering those details with a broad, floating ribbon.
      if (state.mode !== 'train') routes.forEach(route => {
        const featured = !state.eventRouteIds.size || state.eventRouteIds.has(route.id);
        route.lines.forEach(line => addRibbon(line, route._color, featured ? 5.0 : 2.0, featured ? 0.95 : 0.24));
      });
      if (state.mode !== 'bus') {
        const railRoutes = state.mode === 'train' ? data.rail : activeRail();
        // Several corridors can end up pointing at the exact same physical
        // approach track (there are more corridors than distinct mapped
        // tracks). Only those literal duplicates need a parallel offset and
        // an elevation stagger -- corridors already running on their own
        // geometry, or on a track nobody else is using, stay put so they
        // aren't nudged off the real alignment.
        const usersOfLine = new Map();
        for (const rail of railRoutes) for (const line of rail._movementLines || []) {
          usersOfLine.set(line, (usersOfLine.get(line) || 0) + 1);
        }
        const seenForLine = new Map();
        railRoutes.forEach(rail => {
          const featured = !state.eventRailIds.size || state.eventRailIds.has(rail.id);
          const lines = rail._movementLines || [];
          if (!lines.length) return;
          for (const line of lines) {
            const shareCount = usersOfLine.get(line) || 1;
            const shared = shareCount > 1;
            const seen = seenForLine.get(line) || 0;
            seenForLine.set(line, seen + 1);
            // Parallel horizontal offset plus a small elevation stagger keeps
            // each service colour on its own pixels instead of z-fighting
            // where several corridors share one mapped track.
            const offset = shared ? (seen - (shareCount - 1) / 2) * 1.2 : 0;
            const elevation = 0.38 + (shared ? seen * 0.012 : 0);
            const width = state.mode === 'train' ? (shared ? 0.42 : 0.72) : (featured ? 0.86 : 0.52);
            addRibbon(line, rail.color, width, featured ? 0.94 : 0.24, elevation, routeGroup, offset);
          }
        });
      }
    }
    if (state.panelActive && elements['transport-stops-toggle'].checked) {
      if (state.mode !== 'train') {
        const visibleIds = new Set(routes.flatMap(route => route.stopIds));
        for (const stop of data.stops) {
          if (!visibleIds.has(stop.id) && !state.servedStopIds.has(stop.id)) continue;
          const served = state.servedStopIds.has(stop.id);
          addMarker(stop.point, 'stop', served ? stopMaterials.served : stopMaterials.stop,
            { kind: 'stop', id: stop.id });
        }
      }
      if (state.mode !== 'bus') {
        for (const station of (data.railStations || []).filter(item => item.inView)) {
          const served = state.servedStopIds.has(station.id);
          addMarker(station.point, 'station', served ? stopMaterials.stationServed : stopMaterials.station,
            { kind: 'station', id: station.id });
        }
      }
    }
    rebuildVehicles();
    requestRender();
  }

  // Vehicles are pooled: a service shows one mesh per departure currently
  // inside the modelled view, so a 10-minute headway visibly differs from a
  // 40-minute one instead of every route showing exactly one crawling vehicle.
  // Metrorail sets hold at the platform to load and unload before departing,
  // rather than appearing already moving. Dwelling this long means several
  // sets can be waiting or arriving on one corridor at once, which is why
  // the pool below spreads them out sideways instead of stacking them.
  const PLATFORM_DWELL_MINUTES = 15;
  function activeProgress(service, minute, reverse = false, serviceTimes = service._departures, kind = 'bus', duration = service._duration) {
    const progress = [];
    for (const serviceTime of serviceTimes) {
      for (const shiftedTime of [serviceTime - 1440, serviceTime, serviceTime + 1440]) {
        if (kind === 'train' && !reverse && minute >= shiftedTime - PLATFORM_DWELL_MINUTES && minute < shiftedTime) progress.push(0);
        if (kind === 'train' && reverse && minute > shiftedTime && minute <= shiftedTime + PLATFORM_DWELL_MINUTES) progress.push(1);
        const base = reverse ? shiftedTime - duration : shiftedTime;
        const amount = (minute - base) / duration;
        if (amount >= 0 && amount <= 1) progress.push(amount);
      }
    }
    return progress.slice(0, 6);
  }

  function rebuildVehicles() {
    state.services = [
      ...(state.mode === 'train' ? [] : selectedRoutes().map(route => ({ service: route, kind: 'bus' }))),
      ...activeRail().flatMap(rail => {
        const times = scheduledRailTimes(rail, state.serviceDate);
        return rail._metrics.flatMap((metric, metricIndex) => {
          const count = rail._metrics.length;
          const outbound = times.outbound.filter((_, index) => index % count === metricIndex);
          const inbound = times.inbound.filter((_, index) => index % count === metricIndex);
          const duration = Math.max(4, metric.length / RAIL_SPEED_M_PER_MIN);
          return [
            { service: rail, kind: 'train', reverse: false, serviceTimes: outbound, movementMetric: metric, movementDuration: duration },
            { service: rail, kind: 'train', reverse: true, serviceTimes: inbound, movementMetric: metric, movementDuration: duration },
          ];
        });
      }),
    ];
    updateVehicles();
  }

  function poolFor(kind) {
    return kind === 'bus' ? state.busPool : state.trainPool;
  }

  function updateVehicles() {
    const used = { bus: 0, train: 0 };
    let visible = 0;
    let moving = 0;
    const ambientOnly = state.ambientDisplay && !state.panelActive;
    const vehicleLimit = ambientOnly ? { bus: 4, train: 2 } : { bus: Infinity, train: Infinity };
    // Several sets can dwell at the same platform end at once (see
    // PLATFORM_DWELL_MINUTES). Without a per-berth offset they would render
    // as one flickering mesh; this counts repeats of the same
    // service+direction+terminus this frame and fans them out sideways,
    // like trains standing on adjacent platform roads.
    const platformOccupancy = new Map();
    const roadsVisible = layerVisible('roads');
    const railwaysVisible = layerVisible('railways');
    for (const { service, kind, reverse, serviceTimes, movementMetric, movementDuration } of state.services || []) {
      if ((kind === 'bus' && !roadsVisible) || (kind === 'train' && !railwaysVisible)) continue;
      const metric = movementMetric || service._metric;
      if (!metric) continue;
      for (let raw of activeProgress(service, state.minute, reverse, serviceTimes, kind, movementDuration || service._duration)) {
        if (used[kind] >= vehicleLimit[kind]) break;
        let amount = reverse ? 1 - raw : raw;
        if (kind === 'bus' && service._stopFractions.length) {
          const nearest = service._stopFractions.reduce(
            (best, stop) => Math.abs(stop.fraction - amount) < Math.abs((best?.fraction ?? 9) - amount) ? stop : best, null);
          if (nearest && Math.abs(nearest.fraction - amount) < 0.012 && (state.minute * 60) % 36 < 9) amount = nearest.fraction;
        }
        const point = sampleLine(metric, amount);
        if (!terrainValidAt(point.x, point.z)) continue;
        let berthOffset = 0;
        if (kind === 'train' && (raw === 0 || raw === 1)) {
          const berthKey = `${service.id}|${reverse}|${raw}`;
          const berth = platformOccupancy.get(berthKey) || 0;
          platformOccupancy.set(berthKey, berth + 1);
          berthOffset = berth * 4.4;
        }
        const pool = poolFor(kind);
        let vehicle = pool[used[kind]];
        if (!vehicle) {
          vehicle = kind === 'bus' ? makeBus(THREE) : makeTrain(THREE);
          pool.push(vehicle);
          vehicleGroup.add(vehicle);
        }
        used[kind] += 1;
        visible += 1;
        vehicle.visible = true;
        vehicle.userData.service = service;
        const length = Math.hypot(point.dx, point.dz) || 1;
        const normalX = -point.dz / length, normalZ = point.dx / length;
        const px = point.x + normalX * berthOffset, pz = point.z + normalZ * berthOffset;
        vehicle.position.set(px, terrainHeightAt(px, pz) + 0.32, pz);
        vehicle.rotation.y = -Math.atan2(point.dz, point.dx) + (reverse ? Math.PI : 0);
        if (raw > 0.001 && raw < 0.999) moving += 1;
      }
    }
    state.movingVehicles = moving;
    for (const kind of ['bus', 'train']) {
      const pool = poolFor(kind);
      for (let index = used[kind]; index < pool.length; index += 1) pool[index].visible = false;
    }
    elements['transport-vehicle-count'].textContent = String(visible);
    elements['transport-time-value'].textContent = minuteLabel(state.minute);
    elements['transport-time'].value = String(Math.round(state.minute) % 1440);
    const railWaits = activeRail().flatMap(rail => {
      const times = scheduledRailTimes(rail, state.serviceDate);
      return [...times.outbound, ...times.inbound].map(time => ({
        time, wait: ((time - state.minute) % 1440 + 1440) % 1440,
      }));
    }).sort((a, b) => a.wait - b.wait);
    const nextRail = railWaits[0];
    state.nextRail = nextRail || null;
    elements['transport-next-rail'].hidden = Boolean(used.train || !nextRail);
    elements['transport-status'].textContent = `${used.bus} bus${used.bus === 1 ? '' : 'es'} · ${used.train} train${used.train === 1 ? '' : 's'} in view`
      + `${used.train || !nextRail ? '' : ` · next rail ${minuteLabel(nextRail.time)}`} · schedule-derived, not live GPS.`;
  }

  function populateControls() {
    const routeNumbers = [...new Set(data.routes.map(route => route.number))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    elements['transport-route'].innerHTML = '<option value="all">All CBD services</option>'
      + routeNumbers.map(number => `<option value="${escapeHtml(number)}">${escapeHtml(number)}</option>`).join('');
    const venues = [
      ...data.stops.map(stop => ({ ...stop, label: `Bus · ${stop.name}` })),
      ...(data.railStations || []).filter(stop => stop.inView).map(stop => ({ ...stop, label: `Rail · ${stop.name}` })),
    ].sort((a, b) => a.label.localeCompare(b.label));
    elements['transport-event-venue'].innerHTML = '<option value="">Custom map point…</option>'
      + venues.map(stop => `<option value="${escapeHtml(stop.id)}">${escapeHtml(stop.label)}</option>`).join('');
    const civic = data.stops.find(stop => stop.name === 'Civic Centre');
    if (civic) {
      elements['transport-event-venue'].value = civic.id;
      setVenue({ id: civic.id, name: civic.name, point: civic.point, source: 'stop' });
    }
    elements['transport-event-date'].value = now.toLocaleDateString('en-CA');
    elements['transport-time'].value = String(state.minute);
    elements['transport-time-value'].textContent = minuteLabel(state.minute);
    elements['transport-service-day'].textContent = dayLabel(state.serviceDate);
    if (elements['transport-data-source']) {
      const effective = data.prasaEffectiveDate
        ? new Date(`${data.prasaEffectiveDate}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'date not supplied';
      const published = data.rail.filter(rail => rail.confidence === 'published-timetable').length;
      elements['transport-data-source'].textContent = `PRASA CSV effective ${effective} · ${published}/${data.rail.length} rail corridors matched`;
    }
  }

  const timeValue = value => {
    const [hour, minute] = String(value || '00:00').split(':').map(Number);
    return hour * 60 + minute;
  };

  function setVenue(venue) {
    state.venue = venue;
    state.walkNetwork = null;
    elements['transport-event-venue-label'].textContent = venue
      ? `${venue.name} · ${Math.round(venue.point[0])}, ${Math.round(venue.point[1])} m`
      : 'No venue set';
    drawVenue();
  }

  async function drawVenue() {
    eventGroup.clear();
    if (!state.panelActive) return;
    if (!state.venue) return requestRender();
    const venue = state.venue;
    if (!walkAdjacency) elements['transport-event-venue-label'].textContent = 'Loading the pedestrian network for the walking catchment…';
    try {
      await ensureWalkNetwork();
    } catch (error) {
      elements['transport-event-venue-label'].textContent = `Walking catchment unavailable (${error.message}). Reopen the tab to retry.`;
      return;
    }
    if (!state.panelActive || state.venue !== venue) return;
    elements['transport-event-venue-label'].textContent = `${venue.name} · ${Math.round(venue.point[0])}, ${Math.round(venue.point[1])} m`;
    const radius = Number(elements['transport-event-walk'].value);
    const [vx, vz] = venue.point;
    const walkNetwork = state.walkNetwork || walkNetworkFrom(venue.point);
    state.walkNetwork = walkNetwork;
    const reachableVertices = [];
    for (const [a, b] of walkEdges) {
      if (walkNetwork.origin.offset + walkNetwork.distances[a] > radius
          || walkNetwork.origin.offset + walkNetwork.distances[b] > radius) continue;
      const start = walkNodes[a], end = walkNodes[b];
      if (!terrainValidAt(...start) || !terrainValidAt(...end)) continue;
      reachableVertices.push(
        new THREE.Vector3(start[0], terrainHeightAt(...start) + 1.7, start[1]),
        new THREE.Vector3(end[0], terrainHeightAt(...end) + 1.7, end[1]),
      );
    }
    if (reachableVertices.length) {
      const networkLines = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(reachableVertices),
        new THREE.LineBasicMaterial({ color: 0xc78caf, transparent: true, opacity: 0.34, depthTest: true }),
      );
      networkLines.renderOrder = 18;
      eventGroup.add(networkLines);
    }
    if (distanceToHub(walkNetwork) <= radius) {
      for (const ring of hubFootprints) {
        const footprint = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(ring.map(([x, z]) => new THREE.Vector3(x, terrainHeightAt(x, z) + 2.2, z))),
          new THREE.LineBasicMaterial({ color: 0xb84e92, transparent: true, opacity: 0.95, depthTest: false }),
        );
        footprint.renderOrder = 25;
        eventGroup.add(footprint);
      }
      const entranceMaterial = new THREE.MeshBasicMaterial({ color: 0xffd7ed, depthTest: false, depthWrite: false });
      for (const entrance of hubEntrances) {
        const marker = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 3, 12), entranceMaterial);
        marker.position.set(entrance.point[0], terrainHeightAt(...entrance.point) + 3.5, entrance.point[1]);
        marker.renderOrder = 27;
        eventGroup.add(marker);
      }
    }
    const pinMaterial = new THREE.MeshPhongMaterial({
      color: 0xf0bd54, emissive: 0x5b3d00, depthTest: false, depthWrite: false,
    });
    const base = terrainHeightAt(vx, vz);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 60, 12), pinMaterial);
    mast.position.set(vx, base + 30, vz);
    const head = new THREE.Mesh(new THREE.ConeGeometry(9, 20, 16), pinMaterial);
    head.rotation.z = Math.PI;
    head.position.set(vx, base + 68, vz);
    for (const mesh of [mast, head]) {
      mesh.renderOrder = 28;
      eventGroup.add(mesh);
    }
    requestRender();
  }

  const cleanAreaName = name => String(name || '')
    .replace(/\s+-+(\s+-+)*\s*/g, ' ').replace(/\s+/g, ' ').replace(/\s+[12]$/, '').trim();

  async function analyseEvent() {
    const venue = state.venue;
    if (!venue) {
      elements['transport-event-venue-label'].textContent = 'Choose a hub or pick a point on the map first.';
      return;
    }
    try {
      await ensureWalkNetwork();
    } catch (error) {
      elements['transport-event-venue-label'].textContent = `Event walking analysis unavailable (${error.message}). Reopen the tab to retry.`;
      return;
    }
    const start = timeValue(elements['transport-event-start'].value);
    let end = timeValue(elements['transport-event-end'].value);
    if (end <= start) end += 1440;
    const buffer = Number(elements['transport-event-buffer'].value);
    const dispersal = Number(elements['transport-event-dispersal'].value);
    const radius = Number(elements['transport-event-walk'].value);
    const attendance = Number(elements['transport-event-attendance'].value);
    const modeShare = Number(elements['transport-event-share'].value) / 100;
    const eventDate = new Date(`${elements['transport-event-date'].value}T12:00:00`);
    const weekend = eventDate.getDay() === 0 || eventDate.getDay() === 6;
    const arrivalFrom = start - buffer;
    const returnUntil = end + dispersal;
    const walkNetwork = state.walkNetwork || walkNetworkFrom(venue.point);
    const distanceToStop = stop => networkDistance(walkNetwork, stopWalkTargets.get(stop.id));

    state.eventRouteIds.clear();
    state.eventRailIds.clear();
    state.servedStopIds.clear();
    const connectedAreas = new Set();
    const services = [];

    const nearbyStops = data.stops.filter(stop => distanceToStop(stop) <= radius);
    for (const stop of nearbyStops) state.servedStopIds.add(stop.id);
    const nearbyStopIds = new Set(nearbyStops.map(stop => stop.id));

    for (const route of data.routes) {
      const boarding = route._stopFractions
        .filter(entry => nearbyStopIds.has(entry.id))
        .sort((a, b) => distanceToStop(stopById.get(a.id)) - distanceToStop(stopById.get(b.id)))[0];
      if (!boarding) continue;
      const times = route.trips.map(([tripStart, tripEnd]) => tripStart + boarding.fraction * (tripEnd - tripStart));
      const arrivals = times.filter(time => time >= arrivalFrom && time <= start);
      const returns = times.filter(time => time >= end && time <= returnUntil);
      const lastOverall = Math.max(...times);
      if (!arrivals.length && !returns.length && lastOverall < end) continue;
      state.eventRouteIds.add(route.id);
      const origins = (route.timetableStops || []).map(cleanAreaName).filter(name => name.length > 2);
      for (const name of origins) connectedAreas.add(name);
      services.push({
        id: route.id, kind: 'bus', label: route._label, detail: route.direction,
        color: route._color, arrivals: arrivals.length, returns: returns.length,
        lastOverall, places: BUS_PLACES_PER_DEPARTURE, headway: medianHeadway(times),
        origins: origins.length, confidence: route.confidence,
        stopId: boarding.id, walk: distanceToStop(stopById.get(boarding.id)),
      });
    }

    // Every Metrorail corridor terminates at Cape Town station. If the venue is
    // inside the walk catchment of that station, the whole rail network is an
    // origin catchment for the event, not only the corridors drawn in scene.
    // Measure through the walking graph to the best mapped public entrance,
    // rather than to the station's centre point or a circular buffer.
    const hubWalk = distanceToHub(walkNetwork);
    const railInCatchment = hubWalk <= radius;
    if (railInCatchment) {
      state.servedStopIds.add(hubStation.id);
      for (const rail of data.rail) {
        const railTimes = scheduledRailTimes(rail, eventDate);
        const arrivals = railTimes.inbound.filter(time => time >= arrivalFrom && time <= start);
        const returns = railTimes.outbound.filter(time => time >= end && time <= returnUntil);
        const lastOverall = Math.max(...railTimes.outbound, 0);
        if (!arrivals.length && !returns.length && lastOverall < end) continue;
        state.eventRailIds.add(rail.id);
        const origins = (rail.stationIds || [])
          .map(id => railStationById.get(id))
          .filter(station => station && !station.inView)
          .map(station => cleanAreaName(station.name));
        for (const name of origins) connectedAreas.add(name);
        services.push({
          id: rail.id, kind: 'rail', label: rail._label, detail: `${origins.length} stations`,
          color: rail.color, arrivals: arrivals.length, returns: returns.length,
          lastOverall, places: RAIL_PLACES_PER_DEPARTURE, headway: medianHeadway(railTimes.outbound),
          origins: origins.length, confidence: railTimes.published ? 'published-timetable' : 'planning-estimate',
          stopId: hubStation.id, walk: hubWalk,
        });
      }
    }

    const arrivals = services.reduce((sum, service) => sum + service.arrivals, 0);
    const returns = services.reduce((sum, service) => sum + service.returns, 0);
    const publicTransportTrips = Math.round(attendance * modeShare);
    const returnPlaces = services.reduce((sum, service) => sum + service.returns * service.places, 0);
    const arrivalPlaces = services.reduce((sum, service) => sum + service.arrivals * service.places, 0);
    const coverage = publicTransportTrips ? clamp(returnPlaces / publicTransportTrips, 0, 1) : 1;
    const capacityGap = Math.max(0, publicTransportTrips - returnPlaces);

    // A service only helps dispersal if it still runs once the crowd has
    // walked out, so the test is against the end of the dispersal window.
    const lateServices = services
      .filter(service => service.lastOverall < returnUntil)
      .map(service => ({
        ...service,
        shortfall: returnUntil - service.lastOverall,
        extraTrips: Math.max(1, Math.round((returnUntil - service.lastOverall) / Math.max(service.headway, 10))),
      }))
      .sort((a, b) => b.origins - a.origins || b.shortfall - a.shortfall);

    const actions = [];
    if (lateServices.length) {
      const railLate = lateServices.filter(service => service.kind === 'rail');
      const busLate = lateServices.filter(service => service.kind === 'bus');
      if (railLate.length) actions.push({
        priority: 'high',
        title: `Extend ${railLate.length} rail corridor${railLate.length === 1 ? '' : 's'} to ${minuteLabel(returnUntil)}`,
        body: `${railLate.slice(0, 4).map(service => service.label.replace('Rail · ', '')).join(', ')}`
          + `${railLate.length > 4 ? ` and ${railLate.length - 4} more` : ''}. `
          + `Last modelled departure is ${minuteLabel(Math.max(...railLate.map(service => service.lastOverall)))}; `
          + `about ${railLate.reduce((sum, service) => sum + service.extraTrips, 0)} extra trips in total. `
          + `These carry the largest origin catchments (${railLate.reduce((sum, service) => sum + service.origins, 0)} stations).`,
      });
      if (busLate.length) actions.push({
        priority: 'high',
        title: `Extend ${busLate.length} MyCiTi route direction${busLate.length === 1 ? '' : 's'} to ${minuteLabel(returnUntil)}`,
        body: `Target first: ${busLate.slice(0, 5).map(service => service.label.replace('MyCiTi ', '')).join(', ')}`
          + `${busLate.length > 5 ? ` (+${busLate.length - 5})` : ''}. `
          + `About ${busLate.reduce((sum, service) => sum + service.extraTrips, 0)} extra bus trips at current headways.`,
      });
    }
    if (capacityGap > 0) actions.push({
      priority: capacityGap > publicTransportTrips * 0.4 ? 'high' : 'medium',
      title: `Nominal scheduled capacity is short by about ${capacityGap.toLocaleString('en-ZA')} places`,
      body: `Return services in the ${dispersal}-minute dispersal window supply roughly `
        + `${returnPlaces.toLocaleString('en-ZA')} nominal scheduled places against an event-demand proxy of `
        + `${publicTransportTrips.toLocaleString('en-ZA')} public-transport trips (${Math.round(modeShare * 100)}% of `
        + `${attendance.toLocaleString('en-ZA')} attendees). No real occupancy or ridership data is used; verify with `
        + `the operator before committing resources. That is ${Math.ceil(capacityGap / RAIL_PLACES_PER_DEPARTURE)} extra `
        + `train sets or ${Math.ceil(capacityGap / BUS_PLACES_PER_DEPARTURE)} extra bus departures at nominal capacity.`,
    });
    if (arrivalPlaces < publicTransportTrips) actions.push({
      priority: 'medium',
      title: 'Arrival window is tighter than the crowd',
      body: `The ${buffer}-minute pre-event window supplies about ${arrivalPlaces.toLocaleString('en-ZA')} nominal `
        + `scheduled places. Open doors earlier or advertise a longer arrival spread so demand is not concentrated `
        + `in the last 30 minutes.`,
    });
    if (!railInCatchment && hubStation) actions.push({
      priority: 'medium',
      title: 'Rail is outside the walk catchment',
      body: `The nearest mapped entrance to ${hubStation.name} is ${Math.round(hubWalk)} m from the venue `
        + `(about ${Math.round(hubWalk / WALK_SPEED_M_PER_MIN)} min walk), beyond the ${radius} m catchment. `
        + `A shuttle or a signed walking route from the station would connect the whole rail network to this venue.`,
    });
    const unservedStops = nearbyStops.filter(stop => !(routesByStop.get(stop.id) || []).length);
    if (unservedStops.length) actions.push({
      priority: 'low',
      title: `${unservedStops.length} stop${unservedStops.length === 1 ? '' : 's'} in the catchment have no matched route`,
      body: `${unservedStops.slice(0, 6).map(stop => stop.name).join(', ')}. These are infrastructure without a modelled `
        + `service — confirm against the operator's current network before publishing travel advice.`,
    });
    if (weekend) actions.push({
      priority: 'medium',
      title: 'Confirm weekend MyCiTi operations',
      body: 'PRASA weekend times are selected from the supplied CSV, but the encoded MyCiTi tables are weekday schedules. '
        + 'Treat bus availability as an optimistic upper bound and confirm it with the operator.',
    });
    if (!actions.length) actions.push({
      priority: 'good',
      title: 'No intervention indicated by the modelled supply',
      body: `Scheduled operations cover arrival and the ${dispersal}-minute dispersal window, and nominal scheduled `
        + 'capacity clears the event-demand proxy. This is an uncalibrated planning proxy, not a real occupancy '
        + 'measurement or an allocation guarantee — confirm with the operator.',
    });

    const grade = !services.length ? 'Limited'
      : actions.some(action => action.priority === 'high') ? 'Action needed'
      : actions.some(action => action.priority === 'medium') ? 'Review' : 'Covered';

    elements['transport-event-results'].hidden = false;
    dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'transport', metadata: {
      description: `${arrivals} scheduled arrivals, ${returns} scheduled returns; ${Math.round(coverage * 100)}% nominal capacity coverage. Not measured occupancy.`,
      arrivals, returns, coverage, date: elements['transport-event-date'].value, clientOnly: true,
    } } }));
    elements['transport-event-areas'].textContent = String(connectedAreas.size);
    elements['transport-event-arrivals'].textContent = String(arrivals);
    elements['transport-event-returns'].textContent = String(returns);
    elements['transport-event-cover'].textContent = `${Math.round(coverage * 100)}%`;
    elements['transport-demand-value'].textContent = publicTransportTrips.toLocaleString('en-ZA');
    elements['transport-capacity-value'].textContent = returnPlaces.toLocaleString('en-ZA');
    elements['transport-gap-value'].textContent = capacityGap
      ? `${capacityGap.toLocaleString('en-ZA')} short` : 'No gap in proxy';
    elements['transport-coverage-chart'].style.setProperty('--coverage', `${Math.round(coverage * 360)}deg`);
    const largestServiceCount = Math.max(arrivals, returns, 1);
    elements['transport-arrival-bar'].style.width = `${Math.round(arrivals / largestServiceCount * 100)}%`;
    elements['transport-return-bar'].style.width = `${Math.round(returns / largestServiceCount * 100)}%`;
    elements['transport-results-title'].textContent = elements['transport-event-name'].value.trim() || 'Your transport plan';
    elements['transport-event-grade'].textContent = grade;
    elements['transport-event-grade'].dataset.grade = grade.toLowerCase().replace(' ', '-');

    const recommendation = elements['transport-event-recommendation'];
    recommendation.classList.toggle('good', grade === 'Covered');
    recommendation.textContent = !services.length
      ? `No scheduled service was found within ${radius} m along the walking network in the selected windows. `
        + 'Plan dedicated shuttles from the nearest served hub and verify transfer options before publishing travel advice.'
      : `${services.length} service direction${services.length === 1 ? '' : 's'} reach this venue, connecting `
        + `${connectedAreas.size} named origin areas. Nominal scheduled return capacity covers ${Math.round(coverage * 100)}% `
        + `of the event-demand proxy of ${publicTransportTrips.toLocaleString('en-ZA')} public-transport trips in the `
        + `${dispersal}-minute dispersal window. This is a planning proxy, not measured occupancy — verify with the operator.`;

    elements['transport-event-actions'].innerHTML = actions.map(action => `
      <div class="transport-action" data-priority="${action.priority}">
        <b>${escapeHtml(action.title)}</b><span>${escapeHtml(action.body)}</span>
      </div>`).join('');

    const displayServices = [...services].sort((a, b) =>
      (b.kind === 'rail') - (a.kind === 'rail') || b.origins - a.origins || b.returns - a.returns);
    elements['transport-event-services'].innerHTML = displayServices.slice(0, 12).map(service => `
      <div class="transport-service-row">
        <i style="background:${colorHex(service.color)}"></i>
        <div><b>${escapeHtml(service.label)}</b><span>${service.arrivals} in · ${service.returns} out · ${Math.round(service.walk)} m walk · ${escapeHtml(String(service.confidence).replaceAll('-', ' '))}</span></div>
        <strong>last ${minuteLabel(service.lastOverall)}</strong>
      </div>`).join('');

    const areaNames = [...connectedAreas].sort((a, b) => a.localeCompare(b));
    elements['transport-event-area-list'].textContent = areaNames.length
      ? `Origins reachable without a transfer: ${areaNames.slice(0, 24).join(' · ')}`
        + `${areaNames.length > 24 ? ` · +${areaNames.length - 24} more` : ''}. `
        + `Walk catchment follows the mapped pedestrian/street network for ${radius} m (about ${Math.round(radius / WALK_SPEED_M_PER_MIN)} min).`
      : 'No direct origin areas were resolved for this point.';

    state.analysis = { services, actions, returnUntil, radius };
    state.serviceDate = eventDate;
    elements['transport-service-day'].textContent = dayLabel(state.serviceDate);
    state.minute = clamp(arrivalFrom % 1440, 0, 1439);
    state.playing = false;
    renderPlayButton();
    rebuildMap();
    drawVenue();
    // frameBounds works off the box diagonal, so a square the size of the
    // catchment would sit the camera far enough out to lose the stop markers.
    const frame = radius * 0.62;
    frameBounds([
      venue.point[0] - frame, venue.point[1] - frame,
      venue.point[0] + frame, venue.point[1] + frame,
    ], { elevation: 0.48 });
  }

  function medianHeadway(times) {
    if (times.length < 2) return 60;
    const sorted = [...times].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((time, index) => time - sorted[index]).sort((a, b) => a - b);
    return Math.max(5, gaps[Math.floor(gaps.length / 2)]);
  }

  function hideStopCard() {
    elements['transport-stop-card'].hidden = true;
  }

  function showStopCard(pick, event) {
    const card = elements['transport-stop-card'];
    const isStation = pick.kind === 'station';
    const record = isStation ? railStationById.get(pick.id) : stopById.get(pick.id);
    if (!record) return;
    let body;
    if (isStation) {
      const corridors = (record.corridors || []).map(id => railById.get(id)).filter(Boolean);
      const linked = corridors.length ? corridors : data.rail;
      const accessDetail = record.id === hubStation?.id && hubEntrances.length
        ? ` · ${hubEntrances.length} mapped public entrances`
        : '';
      body = `
        <p class="transport-card-meta">Metrorail station · ${linked.length} corridor${linked.length === 1 ? '' : 's'} terminate here${accessDetail}</p>
        <ul class="transport-card-list">${linked.slice(0, 9).map(rail => `
          <li><i style="background:${colorHex(rail.color)}"></i>${escapeHtml(rail.name)}
          <em>${scheduledRailTimes(rail).published ? 'published' : 'estimated'} · next ${minuteLabel(scheduledRailTimes(rail).outbound.find(time => time >= state.minute) ?? scheduledRailTimes(rail).outbound[0] ?? 0)}</em></li>`).join('')}</ul>
        <p class="transport-card-note">Times use ${dayLabel(state.serviceDate).toLowerCase()} from the supplied schedule dataset. Positions are not live.</p>`;
    } else {
      const upcoming = stopDepartures(record.id, state.minute);
      const serving = [...new Set((routesByStop.get(record.id) || []).map(entry => entry.route.number))];
      body = `
        <p class="transport-card-meta">${escapeHtml(record.kind === 'station' ? 'Bus station' : 'Bus stop')} · ${escapeHtml(record.shelter)}</p>
        <p class="transport-card-meta">${serving.length ? 'Select a route to focus it on the map:' : 'No modelled route matched to this stop'}</p>
        ${serving.length ? `<div class="transport-card-routes">${serving.map(number => `<button type="button" class="transport-card-route" data-route="${escapeHtml(number)}">${escapeHtml(number)}</button>`).join('')}</div>` : ''}
        ${upcoming.length ? `<ul class="transport-card-list">${upcoming.map(entry => `
          <li><i style="background:${colorHex(entry.route._color)}"></i>${escapeHtml(entry.route.number)}
          <em>${minuteLabel(entry.time)} · ${Math.round(entry.wait)} min</em></li>`).join('')}</ul>`
          : '<p class="transport-card-note">No timetable departures are modelled at this stop.</p>'}
        <p class="transport-card-note">Departures are interpolated from supplied weekday trip endpoints, from the model clock at ${minuteLabel(state.minute)}.</p>`;
    }
    card.innerHTML = `
      <button class="transport-card-close" type="button" aria-label="Close">×</button>
      <b>${escapeHtml(record.name)}</b>
      ${body}
      <button class="transport-card-venue" type="button">Use as event venue</button>`;
    card.hidden = false;
    const width = 260;
    card.style.left = `${clamp(event.clientX + 14, 8, innerWidth - width - 8)}px`;
    card.style.top = `${clamp(event.clientY - 20, 8, innerHeight - 240)}px`;
    card.querySelector('.transport-card-close').addEventListener('click', hideStopCard);
    card.querySelectorAll('.transport-card-route').forEach(button => button.addEventListener('click', () => {
      state.mode = 'bus';
      elements['transport-route'].value = button.dataset.route;
      document.querySelectorAll('[data-transport-mode]').forEach(tab => {
        const active = tab.dataset.transportMode === 'bus';
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-pressed', String(active));
      });
      rebuildMap();
      requestRender();
    }));
    card.querySelector('.transport-card-venue').addEventListener('click', () => {
      elements['transport-event-venue'].value = record.id;
      setVenue({ id: record.id, name: record.name, point: record.point, source: pick.kind });
      hideStopCard();
    });
  }

  addScenePickHandler?.(({ raycaster, event }) => {
    if (!state.enabled || !group.visible) return false;
    const hit = raycaster.intersectObjects(stopGroup.children, false)[0];
    if (!hit?.object.userData.pick) {
      hideStopCard();
      return false;
    }
    showStopCard(hit.object.userData.pick, event);
    return true;
  });

  elements['transport-event-pick'].addEventListener('click', () => {
    if (!requestGroundPick) return;
    state.picking = true;
    hideStopCard();
    elements['transport-event-pick'].classList.add('active');
    elements['transport-event-venue-label'].textContent = 'Click the map to place the venue · Esc to cancel';
    requestGroundPick((x, z) => {
      state.picking = false;
      elements['transport-event-pick'].classList.remove('active');
      if (x === null) return setVenue(state.venue);
      elements['transport-event-venue'].value = '';
      setVenue({
        name: elements['transport-event-name'].value.trim() || 'Custom map point',
        point: [Number(x.toFixed(1)), Number(z.toFixed(1))], source: 'map',
      });
    });
  });

  elements['transport-event-venue'].addEventListener('change', () => {
    const id = elements['transport-event-venue'].value;
    if (!id) return;
    const record = stopById.get(id) || railStationById.get(id);
    if (record) setVenue({ id, name: record.name, point: record.point, source: 'stop' });
  });

  elements['transport-toggle'].addEventListener('change', () => {
    state.enabled = elements['transport-toggle'].checked;
    syncVisibility();
    if (!state.enabled) hideStopCard();
    state.lastFrame = performance.now();
    requestRender();
  });
  for (const id of ['transport-routes-toggle', 'transport-stops-toggle', 'transport-route']) {
    elements[id].addEventListener('change', rebuildMap);
  }
  elements['transport-event-walk'].addEventListener('change', drawVenue);
  const renderPlayButton = () => {
    elements['transport-play'].innerHTML = state.playing
      ? '<span aria-hidden="true">Ⅱ</span> Pause'
      : '<span aria-hidden="true">▶</span> Play';
    elements['transport-play'].setAttribute('aria-pressed', String(state.playing));
  };
  for (const button of document.querySelectorAll('[data-transport-mode]')) {
    button.addEventListener('click', () => {
      state.mode = button.dataset.transportMode;
      document.querySelectorAll('[data-transport-mode]').forEach(candidate => {
        const active = candidate === button;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-pressed', String(active));
      });
      rebuildMap();
    });
  }
  elements['transport-time'].addEventListener('input', () => {
    state.minute = Number(elements['transport-time'].value);
    state.playing = false;
    renderPlayButton();
    updateVehicles();
    requestRender();
  });
  elements['transport-play'].addEventListener('click', () => {
    state.playing = !state.playing;
    state.lastFrame = performance.now();
    renderPlayButton();
    requestRender();
  });
  elements['transport-now'].addEventListener('click', () => {
    state.serviceDate = new Date();
    state.minute = state.serviceDate.getHours() * 60 + state.serviceDate.getMinutes();
    state.playing = true;
    elements['transport-event-date'].value = state.serviceDate.toLocaleDateString('en-CA');
    elements['transport-service-day'].textContent = dayLabel(state.serviceDate);
    renderPlayButton();
    rebuildVehicles();
    requestRender();
  });
  elements['transport-next-rail'].addEventListener('click', () => {
    if (!state.nextRail) return;
    state.minute = state.nextRail.time;
    state.playing = false;
    renderPlayButton();
    updateVehicles();
    requestRender();
  });
  elements['transport-event-date'].addEventListener('change', () => {
    const chosen = new Date(`${elements['transport-event-date'].value}T12:00:00`);
    if (Number.isNaN(chosen.getTime())) return;
    state.serviceDate = chosen;
    elements['transport-service-day'].textContent = dayLabel(chosen);
    rebuildVehicles();
  });
  elements['transport-event-attendance'].addEventListener('input', () => {
    elements['transport-event-attendance-value'].textContent = Number(elements['transport-event-attendance'].value).toLocaleString('en-ZA');
  });
  elements['transport-event-share'].addEventListener('input', () => {
    elements['transport-event-share-value'].textContent = `${elements['transport-event-share'].value}%`;
  });
  elements['transport-event-analyse'].addEventListener('click', analyseEvent);
  elements['transport-results-close'].addEventListener('click', () => {
    elements['transport-event-results'].hidden = true;
  });
  addEventListener('climate-menu-change', event => {
    elements['transport-event-results'].classList.toggle('menu-hidden', event.detail?.name !== 'transport');
  });
  elements['transport-fit'].addEventListener('click', () => {
    const points = [
      ...selectedRoutes().flatMap(route => route.lines.flat()),
      ...activeRail().flatMap(rail => rail.lines.flat()),
    ];
    if (!points.length) return;
    frameBounds([
      Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
      Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1])),
    ], { elevation: 0.42 });
  });

  populateControls();
  rebuildMap();
  function syncVisibility() {
    const showLayer = state.enabled && (state.panelActive || state.ambientDisplay);
    group.visible = showLayer;
    routeGroup.visible = state.enabled && state.panelActive;
    stopGroup.visible = state.enabled && state.panelActive;
    eventGroup.visible = state.enabled && state.panelActive;
    vehicleGroup.visible = showLayer;
  }
  return {
    active: () => state.enabled && group.visible,
    setPanelActive(active) {
      state.panelActive = Boolean(active);
      syncVisibility();
      if (state.panelActive) {
        rebuildMap();
        drawVenue();
      } else {
        hideStopCard();
      }
      requestRender();
    },
    setAmbientDisplay(active) {
      state.ambientDisplay = Boolean(active);
      syncVisibility();
      updateVehicles();
      requestRender();
    },
    refreshLayerVisibility() {
      updateVehicles();
      requestRender();
    },
    needsIdleTick() {
      return state.enabled && group.visible && state.playing && state.movingVehicles === 0;
    },
    animating() {
      return state.enabled && group.visible && state.playing && state.movingVehicles > 0;
    },
    update(now) {
      if (!state.enabled || !group.visible) return false;
      const elapsed = Math.min(0.5, Math.max(0, (now - state.lastFrame) / 1000));
      state.lastFrame = now;
      if (state.playing) {
        // One model minute takes one real second per 1× of playback. The
        // service geometry and the planning speeds are both expressed in
        // real metres and minutes, so this keeps the vehicles at their
        // intended 18 km/h bus and 40 km/h rail speeds at real-time playback.
        state.minute = (state.minute + elapsed * Number(elements['transport-speed'].value || 1) / 60) % 1440;
        updateVehicles();
      }
      return state.playing && state.movingVehicles > 0;
    },
  };
}
