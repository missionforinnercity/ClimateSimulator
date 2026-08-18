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

function roundedBox(THREE, width, height, length, color, position) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(length, height, width, 2, 1, 1),
    new THREE.MeshPhongMaterial({ color, shininess: 55 }),
  );
  mesh.position.set(...position);
  return mesh;
}

function addVehicleBeacon(THREE, vehicle, color, height, radius) {
  const beacon = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.92, depthTest: false, depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.55, 8, 24), material);
  ring.rotation.x = Math.PI / 2;
  const core = new THREE.Mesh(new THREE.SphereGeometry(2.0, 10, 7), material);
  core.position.y = 1.6;
  const pointer = new THREE.Mesh(new THREE.ConeGeometry(2.7, 6.5, 10), material);
  pointer.rotation.z = Math.PI;
  pointer.position.y = -4;
  beacon.add(ring, core, pointer);
  beacon.position.y = height;
  for (const mesh of [ring, core, pointer]) mesh.renderOrder = 32;
  vehicle.add(beacon);
  vehicle.userData.beacon = beacon;
  vehicle.userData.beaconMaterial = material;
}

function makeBus(THREE) {
  const vehicle = new THREE.Group();
  vehicle.add(roundedBox(THREE, 2.45, 2.45, 9.6, 0x0869a7, [0, 1.65, 0]));
  vehicle.add(roundedBox(THREE, 2.49, 0.85, 8.5, 0xc8d1d5, [-0.15, 1.25, 0]));
  vehicle.add(roundedBox(THREE, 2.5, 0.78, 8.35, 0x17252f, [-0.12, 2.28, 0]));
  vehicle.add(roundedBox(THREE, 2.52, 0.18, 7.2, 0xe5333f, [-0.45, 1.04, 0]));
  vehicle.add(roundedBox(THREE, 2.25, 1.25, 0.16, 0x15242d, [4.86, 2.18, 0]));
  const wheelGeometry = new THREE.CylinderGeometry(0.55, 0.55, 0.32, 14);
  wheelGeometry.rotateX(Math.PI / 2);
  const wheelMaterial = new THREE.MeshLambertMaterial({ color: 0x151719 });
  for (const x of [-3.1, 3.05]) for (const z of [-1.22, 1.22]) {
    const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
    wheel.position.set(x, 0.63, z);
    vehicle.add(wheel);
  }
  const lightMaterial = new THREE.MeshBasicMaterial({ color: 0xffefb0 });
  for (const z of [-0.75, 0.75]) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 5), lightMaterial);
    light.position.set(4.98, 1.34, z);
    vehicle.add(light);
  }
  vehicle.scale.setScalar(1.25);
  addVehicleBeacon(THREE, vehicle, 0xff73c7, 9.5, 8.5);
  vehicle.userData.kind = 'bus';
  return vehicle;
}

function makeTrain(THREE) {
  const vehicle = new THREE.Group();
  const carriageMaterial = new THREE.MeshPhongMaterial({ color: 0xe4eaec, shininess: 85 });
  const windowMaterial = new THREE.MeshPhongMaterial({ color: 0x172935, shininess: 100 });
  for (let carriage = 0; carriage < 3; carriage += 1) {
    const offset = (carriage - 1) * 12.4;
    const body = new THREE.Mesh(new THREE.BoxGeometry(11.7, 3.2, 2.9), carriageMaterial);
    body.position.set(offset, 2.05, 0);
    vehicle.add(body);
    const windows = new THREE.Mesh(new THREE.BoxGeometry(9.8, 1.15, 2.96), windowMaterial);
    windows.position.set(offset, 2.55, 0);
    vehicle.add(windows);
    const blue = new THREE.Mesh(new THREE.BoxGeometry(11.75, 0.55, 3.0), new THREE.MeshPhongMaterial({ color: 0x00a9df }));
    blue.position.set(offset, 0.9, 0);
    vehicle.add(blue);
  }
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.42, 1.2, 12, 1, false, 0, Math.PI), carriageMaterial);
  nose.rotation.z = Math.PI / 2;
  nose.rotation.y = Math.PI / 2;
  nose.position.set(18.1, 2.05, 0);
  vehicle.add(nose);
  addVehicleBeacon(THREE, vehicle, 0xffce62, 11, 11.5);
  vehicle.userData.kind = 'train';
  return vehicle;
}

export async function createTransportLayer({
  THREE, scene, terrainHeightAt, terrainValidAt, requestRender, frameBounds,
  requestGroundPick, addScenePickHandler,
}) {
  const response = await fetch('assets/transport.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Transport asset HTTP ${response.status}`);
  const data = await response.json();
  const group = new THREE.Group();
  const trackGroup = new THREE.Group();
  const routeGroup = new THREE.Group();
  const stopGroup = new THREE.Group();
  const vehicleGroup = new THREE.Group();
  const eventGroup = new THREE.Group();
  group.add(trackGroup, routeGroup, stopGroup, eventGroup, vehicleGroup);
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
  const walkNodes = data.walkNetwork?.nodes || [];
  const walkEdges = data.walkNetwork?.edges || [];
  const walkAdjacency = walkNodes.map(() => []);
  for (const [a, b, length] of walkEdges) {
    walkAdjacency[a]?.push([b, length]);
    walkAdjacency[b]?.push([a, length]);
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
  const stopWalkTargets = new Map(data.stops.map(stop => [stop.id, walkTarget(stop.point)]));
  const hubWalkTargets = (hubEntrances.length ? hubEntrances : hubStation ? [{ point: hubStation.point }] : [])
    .map(entrance => ({ ...entrance, ...walkTarget(entrance.point) }));
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
  const sharedRailLine = (data.railTracks || [])
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
    .sort((a, b) => b.endpointReach - a.endpointReach || b.metric.length - a.metric.length)[0]?.points || null;
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
  for (const rail of data.rail) {
    // Use every through-running line that actually reaches the visible hub,
    // excluding disconnected platform/yard loops carried in the source GIS.
    rail._movementLines = (rail.lines || []).filter(isVisibleServiceApproach);
    if (!rail._movementLines.length && sharedRailLine) rail._movementLines = [sharedRailLine];
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
    const runs = [];
    let run = [];
    for (const point of draped) {
      if (terrainValidAt(...point)) run.push(point);
      else if (run.length) { if (run.length > 1) runs.push(run); run = []; }
    }
    if (run.length > 1) runs.push(run);
    for (const visible of runs) {
      const vertices = [], indices = [];
      for (let index = 0; index < visible.length; index += 1) {
        const [x, z] = visible[index];
        const previous = visible[Math.max(0, index - 1)], next = visible[Math.min(visible.length - 1, index + 1)];
        const dx = next[0] - previous[0], dz = next[1] - previous[1];
        const length = Math.hypot(dx, dz) || 1;
        const normalX = -dz / length, normalZ = dx / length;
        vertices.push(
          x + normalX * (lateralOffset + width / 2), terrainHeightAt(x + normalX * (lateralOffset + width / 2), z + normalZ * (lateralOffset + width / 2)) + elevation, z + normalZ * (lateralOffset + width / 2),
          x + normalX * (lateralOffset - width / 2), terrainHeightAt(x + normalX * (lateralOffset - width / 2), z + normalZ * (lateralOffset - width / 2)) + elevation, z + normalZ * (lateralOffset - width / 2),
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
      mesh.renderOrder = target === trackGroup ? 18 : 20;
      target.add(mesh);
    }
  }

  const now = new Date();
  const state = {
    enabled: elements['transport-toggle'].checked, playing: true,
    minute: clamp(now.getHours() * 60 + now.getMinutes(), 0, 1439), serviceDate: now,
    lastFrame: performance.now(), mode: 'both', picking: false,
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
  const stopMarkerGeometry = new THREE.CylinderGeometry(7, 7, 1.6, 16);
  const stationMarkerGeometry = new THREE.CylinderGeometry(14, 14, 2.0, 24);
  const stopPostGeometry = new THREE.CylinderGeometry(1.1, 1.1, 16, 8);
  const stationPostGeometry = new THREE.CylinderGeometry(1.8, 1.8, 22, 8);
  const stopMaterials = {
    stop: markerMaterial(0xf2f2ee, 0x3a3a3a),
    served: markerMaterial(0x63d7a2, 0x14503a),
    station: markerMaterial(0xf2f2ee, 0x1b4d5c),
    stationServed: markerMaterial(0x7fd8ec, 0x11485c),
    post: markerMaterial(0x8d9296, 0x1a1a1a),
  };

  function addMarker(point, kind, material, pick) {
    if (!terrainValidAt(...point)) return;
    const station = kind === 'station';
    const height = terrainHeightAt(...point);
    const postHeight = station ? 22 : 16;
    const marker = new THREE.Mesh(station ? stationMarkerGeometry : stopMarkerGeometry, material);
    marker.position.set(point[0], height + postHeight, point[1]);
    const post = new THREE.Mesh(station ? stationPostGeometry : stopPostGeometry, stopMaterials.post);
    post.position.set(point[0], height + postHeight / 2, point[1]);
    for (const mesh of [marker, post]) {
      mesh.renderOrder = 26;
      mesh.userData.pick = pick;
      stopGroup.add(mesh);
    }
  }

  function rebuildMap() {
    trackGroup.clear();
    routeGroup.clear();
    stopGroup.clear();
    const routes = selectedRoutes();
    if (elements['transport-routes-toggle'].checked) {
      // Physical track first, so the station throat reads as track rather than
      // as any one service being painted across the whole yard.
      if (state.mode !== 'bus') {
        const infrastructureColor = state.mode === 'train' ? 0x76556d : 0x6f7377;
        const infrastructureOpacity = state.mode === 'train' ? 0.28 : 0.42;
        for (const track of data.railTracks || []) addRibbon(track, infrastructureColor, 2.0, infrastructureOpacity, 0.7, trackGroup);
      }
      if (state.mode !== 'train') routes.forEach(route => {
        const featured = !state.eventRouteIds.size || state.eventRouteIds.has(route.id);
        route.lines.forEach(line => addRibbon(line, route._color, featured ? 5.0 : 2.0, featured ? 0.95 : 0.24));
      });
      if (state.mode !== 'bus') {
        const railRoutes = state.mode === 'train' ? data.rail : activeRail();
        railRoutes.forEach((rail, index) => {
          const featured = !state.eventRailIds.size || state.eventRailIds.has(rail.id);
          const usesSharedApproach = !(rail.lines || []).length && sharedRailLine;
          const lines = rail._movementLines || [];
          if (!lines.length) return;
          // Corridors without unique geometry share the Cape Town approach.
          // Parallel offsets keep each service colour readable instead of
          // stacking nine colours on exactly the same pixels.
          const offset = usesSharedApproach ? (index - (railRoutes.length - 1) / 2) * 2.25 : 0;
          const width = state.mode === 'train' ? (usesSharedApproach ? 1.8 : 3.2) : (featured ? 5.0 : 2.6);
          for (const line of lines) addRibbon(line, rail.color, width, featured ? 0.94 : 0.24, 1.02, routeGroup, offset);
        });
      }
    }
    if (elements['transport-stops-toggle'].checked) {
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
  function activeProgress(service, minute, reverse = false, serviceTimes = service._departures, kind = 'bus', duration = service._duration) {
    const progress = [];
    for (const serviceTime of serviceTimes) {
      for (const shiftedTime of [serviceTime - 1440, serviceTime, serviceTime + 1440]) {
        // A short platform dwell makes scheduled trains visible at the
        // terminus without inventing an extra movement.
        if (kind === 'train' && !reverse && minute >= shiftedTime - 3 && minute < shiftedTime) progress.push(0);
        if (kind === 'train' && reverse && minute > shiftedTime && minute <= shiftedTime + 3) progress.push(1);
        const base = reverse ? shiftedTime - duration : shiftedTime;
        const amount = (minute - base) / duration;
        if (amount >= 0 && amount <= 1) progress.push(amount);
      }
    }
    return progress.slice(0, 3);
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
    for (const { service, kind, reverse, serviceTimes, movementMetric, movementDuration } of state.services || []) {
      const metric = movementMetric || service._metric;
      if (!metric) continue;
      for (let raw of activeProgress(service, state.minute, reverse, serviceTimes, kind, movementDuration || service._duration)) {
        let amount = reverse ? 1 - raw : raw;
        if (kind === 'bus' && service._stopFractions.length) {
          const nearest = service._stopFractions.reduce(
            (best, stop) => Math.abs(stop.fraction - amount) < Math.abs((best?.fraction ?? 9) - amount) ? stop : best, null);
          if (nearest && Math.abs(nearest.fraction - amount) < 0.012 && (state.minute * 60) % 36 < 9) amount = nearest.fraction;
        }
        const point = sampleLine(metric, amount);
        if (!terrainValidAt(point.x, point.z)) continue;
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
        vehicle.userData.beaconMaterial?.color.set(service._color || service.color || (kind === 'bus' ? 0xff73c7 : 0xffce62));
        vehicle.position.set(point.x, terrainHeightAt(point.x, point.z) + 0.32, point.z);
        vehicle.rotation.y = -Math.atan2(point.dz, point.dx) + (reverse ? Math.PI : 0);
        if (vehicle.userData.beacon) {
          const pulse = 1 + Math.sin(performance.now() / 320 + used[kind]) * 0.1;
          vehicle.userData.beacon.scale.setScalar(pulse);
        }
      }
    }
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
    elements['transport-event-venue-label'].textContent = venue
      ? `${venue.name} · ${Math.round(venue.point[0])}, ${Math.round(venue.point[1])} m`
      : 'No venue set';
    drawVenue();
  }

  function drawVenue() {
    eventGroup.clear();
    if (!state.venue) return requestRender();
    const radius = Number(elements['transport-event-walk'].value);
    const [vx, vz] = state.venue.point;
    const walkNetwork = walkNetworkFrom(state.venue.point);
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

  function analyseEvent() {
    const venue = state.venue;
    if (!venue) {
      elements['transport-event-venue-label'].textContent = 'Choose a hub or pick a point on the map first.';
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
      title: `Nominal scheduled capacity is short by about ${capacityGap.toLocaleString('en-ZA')} outbound trips`,
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
    elements['transport-event-areas'].textContent = String(connectedAreas.size);
    elements['transport-event-arrivals'].textContent = String(arrivals);
    elements['transport-event-returns'].textContent = String(returns);
    elements['transport-event-cover'].textContent = `${Math.round(coverage * 100)}%`;
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
        <p class="transport-card-meta">${serving.length ? `Routes ${serving.map(escapeHtml).join(', ')}` : 'No modelled route matched to this stop'}</p>
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
    group.visible = state.enabled;
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
  return {
    active: () => state.enabled && group.visible,
    setPanelActive(active) {
      group.visible = active && state.enabled;
      if (!group.visible) hideStopCard();
      requestRender();
    },
    update(now) {
      if (!state.enabled || !group.visible) return false;
      const elapsed = Math.min(0.1, Math.max(0, (now - state.lastFrame) / 1000));
      state.lastFrame = now;
      if (state.playing) {
        state.minute = (state.minute + elapsed * Number(elements['transport-speed'].value || 1)) % 1440;
        updateVehicles();
      }
      return state.playing;
    },
  };
}
