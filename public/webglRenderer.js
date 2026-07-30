import * as THREE from './vendor/three.module.min.js';

const COLORS = {
  background: 0x1b2125,
  terrain: 0x424a4d,
  terrainSun: 0xf4f3ee,
  terrainEdge: 0x363d40,
  terrainEdgeDeep: 0x1c2124,
  grass: 0x50745a,
  wall: 0x657076,
  wallSun: 0xffffff,
  roof: 0xaeb5b8,
  roofSun: 0xffffff,
  road: 0x465257,
  roadMajor: 0xb08b4f,
  roadSecondary: 0x557d89,
  path: 0x858f90,
  rail: 0x929b9c,
  sleeper: 0x3f4545,
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

  const manifest = await fetch('assets/manifest.json', { cache: 'no-store' }).then(response => response.json());
  const [data, canopyAsset, roofSurfaceBuffer] = await Promise.all([
    fetch(`assets/fallback.json?v=${manifest.layers?.fallback?.bytes || 0}`).then(response => {
      if (!response.ok) throw new Error('fallback scene asset is missing');
      return response.json();
    }),
    fetch(`assets/canopy.json?v=${manifest.layers?.canopy?.bytes || 0}`).then(response => response.ok ? response.json() : { canopies: [] }).catch(() => ({ canopies: [] })),
    fetch(`assets/${manifest.assets?.roof_surface || 'roof_surface.bin'}?v=${manifest.layers?.roof_surface?.cache_key || manifest.layers?.roof_surface?.bytes || 0}`)
      .then(response => response.ok ? response.arrayBuffer() : null)
      .catch(() => null),
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
  let animationFrame = 0;
  let renderRequested = true;
  const layerGroups = {
    terrain: new THREE.Group(),
    grass: new THREE.Group(),
    railways: new THREE.Group(),
    paths: new THREE.Group(),
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

  function pointInRing(x, z, ring) {
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

  function pointInLidarFootprint(x, z) {
    if (!terrain.footprint?.length) return true;
    return terrain.footprint.some(polygon => (
      pointInRing(x, z, polygon[0])
      && !polygon.slice(1).some(hole => pointInRing(x, z, hole))
    ));
  }

  function boxInLidarFootprint(bounds) {
    const [minX, minZ, maxX, maxZ] = bounds;
    for (let row = 0; row <= 8; row += 1) {
      for (let column = 0; column <= 8; column += 1) {
        const x = minX + (maxX - minX) * column / 8;
        const z = minZ + (maxZ - minZ) * row / 8;
        if (!pointInLidarFootprint(x, z)) return false;
      }
    }
    return true;
  }

  // Edges used by exactly one triangle sit on the outer silhouette of the
  // (possibly footprint-clipped) terrain mesh — both the rectangular grid
  // border and any interior gaps eroded by pointInLidarFootprint.
  function boundaryEdgesOf(indices) {
    const counts = new Map();
    const edgeKey = (a, b) => (a < b ? a * 100000 + b : b * 100000 + a);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const key = edgeKey(p, q);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const edges = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        if (counts.get(edgeKey(p, q)) === 1) edges.push([p, q]);
      }
    }
    return edges;
  }

  // Drops a wall from every boundary edge down to a shared floor plane so the
  // terrain reads as a solid slab cut out of the land rather than a zero
  // thickness sheet floating over the background.
  function makeTerrainSkirt(positions, indices) {
    const edges = boundaryEdgesOf(indices);
    if (!edges.length) return null;
    let minHeight = Infinity;
    for (let i = 1; i < positions.length; i += 3) minHeight = Math.min(minHeight, positions[i]);
    const floorY = minHeight - 40;
    const topColor = new THREE.Color(COLORS.terrainEdge);
    const deepColor = new THREE.Color(COLORS.terrainEdgeDeep);
    const skirtPositions = [];
    const skirtColors = [];
    const pushVertex = (x, y, z, colour) => {
      skirtPositions.push(x, y, z);
      skirtColors.push(colour.r, colour.g, colour.b);
    };
    for (const [a, b] of edges) {
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      pushVertex(ax, ay, az, topColor);
      pushVertex(bx, by, bz, topColor);
      pushVertex(bx, floorY, bz, deepColor);
      pushVertex(ax, ay, az, topColor);
      pushVertex(bx, floorY, bz, deepColor);
      pushVertex(ax, floorY, az, deepColor);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(skirtColors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrain-skirt';
    return mesh;
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
        const x0 = left + terrainWidth * column / (terrain.columns - 1);
        const x1 = left + terrainWidth * (column + 1) / (terrain.columns - 1);
        const z0 = minZ + terrainDepth * row / (terrain.rows - 1);
        const z1 = minZ + terrainDepth * (row + 1) / (terrain.rows - 1);
        // Test triangle centroids against the full-resolution footprint.
        // Requiring all coarse-grid vertices to be valid eroded narrow edge
        // streets and produced visible gaps around Company's Garden.
        if (pointInLidarFootprint((x0 + x0 + x1) / 3, (z0 + z1 + z0) / 3)) {
          indices.push(a, c, b);
        }
        if (pointInLidarFootprint((x1 + x0 + x1) / 3, (z0 + z1 + z1) / 3)) {
          indices.push(b, c, d);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      color: COLORS.terrain,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Keep the ground colour independent from the shadow itself. A dedicated
    // ShadowMaterial overlay below produces one clean, solid shade colour
    // instead of mixing the shadow with ambient terrain lighting.
    mesh.receiveShadow = false;
    mesh.userData.normalColor = COLORS.terrain;
    mesh.userData.sunColor = COLORS.terrainSun;
    mesh.userData.normalMaterial = material;
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
    const skirt = makeTerrainSkirt(positions, indices);
    layerGroups.terrain.add(mesh, shadowCatcher);
    if (skirt) layerGroups.terrain.add(skirt);
    return { mesh, shadowCatcher };
  }

  function triangulateRing(ring) {
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    return THREE.ShapeUtils.triangulateShape(contour, []);
  }

  function elevationColour(height) {
    // Perceptual blue → amber ramp for massing; this is intentionally based
    // only on the measured/derived height attribute.
    const t = clamp((height - 2.5) / 80, 0, 1);
    const red = Math.round(35 + 210 * t);
    const green = Math.round(130 + 65 * (1 - Math.abs(t - 0.45) * 1.8));
    const blue = Math.round(205 - 165 * t);
    return new THREE.Color(`rgb(${red},${green},${blue})`);
  }

  function makeBuildings() {
    const wallPositions = [];
    const roofPositions = [];
    const wallColors = [];
    const roofColors = [];
    for (const [ground, height, ring, , , wallHeight = height, detailedRoof = false, , , wallProfile = null] of data.buildings) {
      const roofY = ground + wallHeight;
      const colour = elevationColour(height);
      for (let index = 0; index < ring.length; index += 1) {
        const next = (index + 1) % ring.length;
        const [x1, z1] = ring[index];
        const [x2, z2] = ring[next];
        const top1 = ground + (wallProfile?.[index] ?? wallHeight);
        const top2 = ground + (wallProfile?.[next] ?? wallHeight);
        wallPositions.push(
          x1, ground, z1, x2, ground, z2, x2, top2, z2,
          x1, ground, z1, x2, top2, z2, x1, top1, z1,
        );
        for (let vertex = 0; vertex < 6; vertex += 1) wallColors.push(colour.r, colour.g, colour.b);
      }
      // LiDAR-covered buildings receive their own simplified surface mesh.
      // Only uncovered buildings retain this authoritative height extrusion.
      if (!detailedRoof) {
        for (const face of triangulateRing(ring)) {
          const a = ring[face[0]];
          let b = ring[face[1]], c = ring[face[2]];
          const normalY = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
          if (normalY < 0) [b, c] = [c, b];
          roofPositions.push(a[0], roofY, a[1], b[0], roofY, b[1], c[0], roofY, c[1]);
          for (let vertex = 0; vertex < 3; vertex += 1) roofColors.push(colour.r, colour.g, colour.b);
        }
      }
    }
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
    wallGeometry.setAttribute('color', new THREE.Float32BufferAttribute(wallColors, 3));
    wallGeometry.computeVertexNormals();
    const roofGeometry = new THREE.BufferGeometry();
    roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
    roofGeometry.setAttribute('color', new THREE.Float32BufferAttribute(roofColors, 3));
    roofGeometry.computeVertexNormals();
    const wallMaterial = new THREE.MeshLambertMaterial({ color: COLORS.wall, vertexColors: true, side: THREE.DoubleSide });
    const roofMaterial = new THREE.MeshLambertMaterial({
      color: COLORS.roof,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
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

  function makeDetailedRoofSurface() {
    if (!roofSurfaceBuffer || roofSurfaceBuffer.byteLength < 8) return null;
    const header = new DataView(roofSurfaceBuffer, 0, 8);
    const vertexCount = header.getUint32(0, true);
    const indexCount = header.getUint32(4, true);
    const positionOffset = 8;
    const heightOffset = positionOffset + vertexCount * 3 * 4;
    const indexOffset = heightOffset + vertexCount * 4;
    if (indexOffset + indexCount * 4 > roofSurfaceBuffer.byteLength) return null;

    const positions = new Float32Array(roofSurfaceBuffer, positionOffset, vertexCount * 3);
    const heights = new Float32Array(roofSurfaceBuffer, heightOffset, vertexCount);
    const indices = new Uint32Array(roofSurfaceBuffer, indexOffset, indexCount);
    const colours = new Float32Array(vertexCount * 3);
    for (let index = 0; index < vertexCount; index += 1) {
      const colour = elevationColour(heights[index]);
      colours[index * 3] = colour.r;
      colours[index * 3 + 1] = colour.g;
      colours[index * 3 + 2] = colour.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshLambertMaterial({
      color: COLORS.roof,
      vertexColors: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.normalColor = COLORS.roof;
    mesh.userData.sunColor = COLORS.roofSun;
    mesh.userData.normalMaterial = material;
    mesh.userData.sunMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      emissive: 0x202428,
      emissiveIntensity: 0.28,
      side: THREE.DoubleSide,
      shadowSide: THREE.BackSide,
    });
    layerGroups.buildings.add(mesh);
    return mesh;
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
    const positionsByStyle = [[], [], [], []];
    const major = new Set(['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link']);
    const secondary = new Set(['secondary', 'secondary_link', 'tertiary']);
    const paths = new Set(['footway', 'path', 'cycleway', 'steps', 'corridor', 'elevator']);
    for (const [mappedWidth, highway, points] of data.roads || []) {
      const styleIndex = paths.has(highway) ? 3 : major.has(highway) ? 1 : secondary.has(highway) ? 2 : 0;
      if (points.length > 1) {
        positionsByStyle[styleIndex].push({
          points,
          width: clamp(Number(mappedWidth) || 4, paths.has(highway) ? 0.8 : 2.5, 18),
        });
      }
    }
    const colors = [COLORS.road, COLORS.roadMajor, COLORS.roadSecondary, COLORS.path];
    // Higher-priority carriageways sit a few centimetres above lower classes
    // at overlaps. This provides deterministic crossing order without visible
    // floating roads.
    const classOffsets = [0.30, 0.42, 0.36, 0.47];
    const buildRibbon = (roads, styleIndex, outer = false) => {
      const vertices = [];
      const indices = [];
      for (const road of roads) {
        const halfWidth = road.width * 0.5 + (outer ? (styleIndex === 3 ? 0.24 : 0.48) : 0);
        const elevationOffset = classOffsets[styleIndex] + (outer ? -0.10 : 0);
        const base = vertices.length / 3;
        for (let index = 0; index < road.points.length; index += 1) {
          const [x, z] = road.points[index];
          const previous = road.points[Math.max(0, index - 1)];
          const next = road.points[Math.min(road.points.length - 1, index + 1)];
          const dx = next[0] - previous[0];
          const dz = next[1] - previous[1];
          const length = Math.hypot(dx, dz) || 1;
          const nx = -dz / length * halfWidth;
          const nz = dx / length * halfWidth;
          const leftX = x + nx;
          const leftZ = z + nz;
          const rightX = x - nx;
          const rightZ = z - nz;
          // Sample both ribbon edges. A centreline-only elevation lets the
          // downhill edge enter the terrain and produces the striped tearing
          // visible on wide ramps.
          const leftY = terrainHeightAt(leftX, leftZ) + elevationOffset;
          const rightY = terrainHeightAt(rightX, rightZ) + elevationOffset;
          vertices.push(leftX, leftY, leftZ, rightX, rightY, rightZ);
          if (index > 0) {
            const left = base + (index - 1) * 2;
            const right = left + 1;
            const nextLeft = base + index * 2;
            const nextRight = nextLeft + 1;
            indices.push(left, right, nextLeft, right, nextRight, nextLeft);
          }
        }
        // OSM ways commonly split at intersections. Round endpoint caps close
        // the tiny holes between adjoining ways and remove pointed fragments.
        for (const [x, z] of [road.points[0], road.points[road.points.length - 1]]) {
          const center = vertices.length / 3;
          vertices.push(x, terrainHeightAt(x, z) + elevationOffset, z);
          const segments = 10;
          for (let segment = 0; segment < segments; segment += 1) {
            const angle = segment / segments * Math.PI * 2;
            const edgeX = x + Math.cos(angle) * halfWidth;
            const edgeZ = z + Math.sin(angle) * halfWidth;
            vertices.push(edgeX, terrainHeightAt(edgeX, edgeZ) + elevationOffset, edgeZ);
          }
          for (let segment = 0; segment < segments; segment += 1) {
            indices.push(center, center + 1 + segment, center + 1 + ((segment + 1) % segments));
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
        polygonOffset: true,
        polygonOffsetFactor: outer ? -1 : -3,
        polygonOffsetUnits: outer ? -1 : -3,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = outer ? 1 : 2;
      return mesh;
    };
    positionsByStyle.forEach((roads, index) => {
      if (!roads.length) return;
      const target = index === 3 ? layerGroups.paths : layerGroups.roads;
      target.add(buildRibbon(roads, index, true));
      target.add(buildRibbon(roads, index, false));
    });
  }

  function makeRailways() {
    const railPositions = [];
    const sleeperPositions = [];
    const gaugeHalfWidth = 0.62;
    const sleeperHalfWidth = 1.08;
    const sleeperSpacing = 4.8;
    for (const [, points] of data.railways || []) {
      for (let index = 0; index < points.length - 1; index += 1) {
        const [x1, z1] = points[index];
        const [x2, z2] = points[index + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const length = Math.hypot(dx, dz);
        if (length < 0.05) continue;
        const nx = -dz / length;
        const nz = dx / length;
        for (const offset of [-gaugeHalfWidth, gaugeHalfWidth]) {
          const railX1 = x1 + nx * offset;
          const railZ1 = z1 + nz * offset;
          const railX2 = x2 + nx * offset;
          const railZ2 = z2 + nz * offset;
          railPositions.push(
            railX1, terrainHeightAt(railX1, railZ1) + 0.20, railZ1,
            railX2, terrainHeightAt(railX2, railZ2) + 0.20, railZ2,
          );
        }
        const sleeperCount = Math.floor(length / sleeperSpacing);
        for (let sleeper = 0; sleeper <= sleeperCount; sleeper += 1) {
          const t = sleeperCount ? sleeper / sleeperCount : 0.5;
          const x = x1 + dx * t;
          const z = z1 + dz * t;
          const leftX = x - nx * sleeperHalfWidth;
          const leftZ = z - nz * sleeperHalfWidth;
          const rightX = x + nx * sleeperHalfWidth;
          const rightZ = z + nz * sleeperHalfWidth;
          sleeperPositions.push(
            leftX, terrainHeightAt(leftX, leftZ) + 0.15, leftZ,
            rightX, terrainHeightAt(rightX, rightZ) + 0.15, rightZ,
          );
        }
      }
    }
    const addSegments = (positions, color, renderOrder) => {
      if (!positions.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
      lines.renderOrder = renderOrder;
      layerGroups.railways.add(lines);
    };
    // Tracks sit below the road ribbons (+0.32 m), so roads correctly cover
    // them at level crossings and overpasses.
    addSegments(sleeperPositions, COLORS.sleeper, 0);
    addSegments(railPositions, COLORS.rail, 1);
    return (data.railways || []).length;
  }

  function makeCanopies() {
    const canopies = canopyAsset.canopies || [];
    const positions = [];
    const uvs = [];
    const hashHeight = (x, z, seed) => {
      const value = Math.sin(x * 12.9898 + z * 78.233 + seed * 0.000001) * 43758.5453;
      return value - Math.floor(value);
    };
    const pushVertex = (x, y, z) => {
      positions.push(x, y, z);
      uvs.push(x / 18, z / 18);
    };
    for (const [, , crownBase, crownTop, seed, sourceRings] of canopies) {
      const rings = sourceRings.map(ring => ring.map(([x, z]) => new THREE.Vector2(x, z)));
      const contour = rings[0] || [];
      const holes = rings.slice(1);
      if (contour.length < 3) continue;
      const vertices = contour.concat(...holes);
      const topY = point => crownTop - (0.25 + hashHeight(point.x, point.y, seed) * 0.75);
      for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        for (const index of face) {
          const point = vertices[index];
          pushVertex(point.x, topY(point), point.y);
        }
      }
      for (const ring of rings) {
        for (let index = 0; index < ring.length; index += 1) {
          const next = (index + 1) % ring.length;
          const a = ring[index], b = ring[next];
          const lowerA = crownBase + hashHeight(a.x, a.y, seed + 11) * 0.45;
          const lowerB = crownBase + hashHeight(b.x, b.y, seed + 11) * 0.45;
          pushVertex(a.x, topY(a), a.y);
          pushVertex(b.x, topY(b), b.y);
          pushVertex(b.x, lowerB, b.y);
          pushVertex(a.x, topY(a), a.y);
          pushVertex(b.x, lowerB, b.y);
          pushVertex(a.x, lowerA, a.y);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    const patternCanvas = document.createElement('canvas');
    patternCanvas.width = 64;
    patternCanvas.height = 64;
    const patternContext = patternCanvas.getContext('2d');
    const image = patternContext.createImageData(64, 64);
    for (let index = 0; index < 64 * 64; index += 1) {
      const x = index % 64, y = Math.floor(index / 64);
      const noise = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const alpha = noise - Math.floor(noise) > 0.22 ? 255 : 0;
      image.data[index * 4] = image.data[index * 4 + 1] = image.data[index * 4 + 2] = alpha;
      image.data[index * 4 + 3] = 255;
    }
    patternContext.putImageData(image, 0, 0);
    const alphaMap = new THREE.CanvasTexture(patternCanvas);
    alphaMap.wrapS = alphaMap.wrapT = THREE.RepeatWrapping;
    const crownMaterial = new THREE.MeshLambertMaterial({
      color: 0x4c8a5d,
      alphaMap,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
    });
    const crowns = new THREE.Mesh(geometry, crownMaterial);
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    crowns.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      alphaMap,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
    });

    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.3, 1, 5);
    const trunks = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshLambertMaterial({ color: 0x6b4d35 }), data.trees.length);
    const matrix = new THREE.Matrix4();
    data.trees.forEach(([x, ground, z, , height], index) => {
      matrix.compose(
        new THREE.Vector3(x, ground + height * 0.28, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, Math.max(2, height * 0.56), 1),
      );
      trunks.setMatrixAt(index, matrix);
    });
    trunks.instanceMatrix.needsUpdate = true;
    trunks.castShadow = true;
    layerGroups.trees.add(trunks, crowns);
    return canopies.length;
  }

  status.textContent = 'Building GPU scene…';
  const { mesh: terrainMesh, shadowCatcher } = makeTerrain();
  const buildingMeshes = makeBuildings();
  buildingMeshes.surface = makeDetailedRoofSurface();
  const buildingAppearance = document.querySelector('#building-appearance');
  function setBuildingAppearance(mode) {
    const coloured = mode === 'elevation';
    for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean)) {
      mesh.material.vertexColors = coloured;
      mesh.material.color.setHex(coloured ? 0xffffff : (mesh === buildingMeshes.walls ? COLORS.wall : COLORS.roof));
      mesh.material.needsUpdate = true;
    }
    requestRender();
  }
  buildingAppearance?.addEventListener('change', event => setBuildingAppearance(event.target.value));
  setBuildingAppearance(buildingAppearance?.value || 'neutral');
  makeGrass();
  const railwayCount = makeRailways();
  makeRoads();
  const canopyCount = makeCanopies();

  const heatGroup = new THREE.Group();
  const windGroup = new THREE.Group();
  const floodGroup = new THREE.Group();
  const mitigationGroup = new THREE.Group();
  const mitigationDrawingGroup = new THREE.Group();
  const streetViewGroup = new THREE.Group();
  const streetViewStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0x249ee9, depthTest: false }),
  );
  streetViewStem.position.y = 5;
  const streetViewHead = new THREE.Mesh(
    new THREE.SphereGeometry(4.2, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x70c7ff, depthTest: false }),
  );
  streetViewHead.position.y = 12;
  streetViewGroup.add(streetViewStem, streetViewHead);
  streetViewGroup.visible = false;
  streetViewGroup.renderOrder = 20;
  scene.add(heatGroup, windGroup, floodGroup, mitigationGroup, mitigationDrawingGroup, streetViewGroup);

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
  const floodToggle = document.querySelector('#flood-toggle');
  const floodRain = document.querySelector('#flood-rain');
  const floodRainValue = document.querySelector('#flood-rain-value');
  const floodDuration = document.querySelector('#flood-duration');
  const floodDurationValue = document.querySelector('#flood-duration-value');
  const floodInfiltration = document.querySelector('#flood-infiltration');
  const floodInfiltrationValue = document.querySelector('#flood-infiltration-value');
  const floodRoughness = document.querySelector('#flood-roughness');
  const floodSize = document.querySelector('#flood-size');
  const floodSizeValue = document.querySelector('#flood-size-value');
  const floodResolution = document.querySelector('#flood-resolution');
  const floodMoveDomain = document.querySelector('#flood-move-domain');
  const floodSimulate = document.querySelector('#flood-simulate');
  const floodStatus = document.querySelector('#flood-status');
  const floodLegendMax = document.querySelector('#flood-legend-max');
  const floodTime = document.querySelector('#flood-time');
  const floodResults = document.querySelector('#flood-results');
  const mitigationMethod = document.querySelector('#mitigation-method');
  const mitigationMethodNote = document.querySelector('#mitigation-method-note');
  const mitigationAdd = document.querySelector('#mitigation-add');
  const mitigationStatus = document.querySelector('#mitigation-status');
  const mitigationList = document.querySelector('#mitigation-list');
  const mitigationRun = document.querySelector('#mitigation-run');
  const mitigationClear = document.querySelector('#mitigation-clear');
  const mitigationCompare = document.querySelector('#mitigation-compare');
  const mitigationResults = document.querySelector('#mitigation-results');
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
    speed: (Number(windSpeed?.value) || 36) / 3.6,
    referenceHeight: 2,
    field: null,
    particles: [],
    moveMode: false,
    lastTime: performance.now(),
  };
  const floodState = {
    enabled: Boolean(floodToggle?.checked),
    center: [0, 0],
    size: Number(floodSize?.value) || 400,
    bounds: null,
    moveMode: false,
    validBox: true,
    field: null,
  };
  floodState.bounds = [
    -floodState.size / 2, -floodState.size / 2,
    floodState.size / 2, floodState.size / 2,
  ];
  const mitigationState = {
    drawing: false,
    stroking: false,
    pointerId: null,
    lastScreen: null,
    points: [],
    interventions: [],
    result: null,
  };
  const streetViewState = { placing: false, point: null };
  let heatMesh = null;
  let heatRange = null;
  let windHeatMesh = null;
  let windPoints = null;
  let windBox = null;
  let windEdges = null;
  let windHandle = null;
  let floodWaterMesh = null;
  let floodVelocityLines = null;
  let floodBox = null;
  let floodBoxEdges = null;
  let floodHandle = null;
  let floodAnimationFrame = 0;
  let roadsVisibleBeforeFlood = null;
  const windTrailPoints = 5;
  let drag = null;
  let windDrag = null;
  let floodDrag = null;
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

  // Roads sit ~0.3-0.5m above the terrain, which pokes through the flood
  // water surface (rendered ~0.12m above the simulated depth) and z-fights.
  // Hide them for the duration of flood mode and restore whatever the layer
  // toggle had set beforehand.
  function hideRoadsForFlood() {
    if (roadsVisibleBeforeFlood === null) roadsVisibleBeforeFlood = layerGroups.roads.visible;
    layerGroups.roads.visible = false;
    syncLayerControls();
  }

  function restoreRoadsAfterFlood() {
    if (roadsVisibleBeforeFlood === null) return;
    layerGroups.roads.visible = roadsVisibleBeforeFlood;
    roadsVisibleBeforeFlood = null;
    syncLayerControls();
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
    const incomingNormal = flow.u * normalX + flow.v * normalZ;
    // Proximity alone must not bend the flow. The old response made every
    // particle near a facade rotate tangentially, which created closed loops
    // in otherwise open courtyards. Only remove motion directed into a wall.
    if (!force && incomingNormal >= -speed * 0.06) return flow;
    let tangentX = -normalZ;
    let tangentZ = normalX;
    const incomingTangent = flow.u * tangentX + flow.v * tangentZ;
    if (incomingTangent < 0) {
      tangentX = -tangentX;
      tangentZ = -tangentZ;
    }
    const proximity = clamp((24 - boundary.distance) / 24, 0, 1);
    const inside = windPointInsideBuilding(x, z);
    const tangentialSpeed = Math.abs(incomingTangent);
    // Preserve the component parallel to the facade and add only a small
    // outward bias. This is a sliding collision response, not a vortex.
    const outwardSpeed = inside || force ? speed * 0.55 : speed * 0.35 * proximity;
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
    for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean)) {
      mesh.material = enabled ? mesh.userData.sunMaterial : mesh.userData.normalMaterial;
    }
  }

  function setShadowMode(enabled) {
    if (enabled) restoreRoadsAfterFlood();
    const wasInStudyMode = shadowState.enabled || heatGroup.visible;
    if (enabled && !wasInStudyMode) rememberNormalVisibility();
    shadowState.enabled = enabled;
    if (sunToggle) sunToggle.checked = enabled;
    document.body.classList.toggle('sun-mode', enabled);
    if (enabled) {
      if (heatToggle) heatToggle.checked = false;
      setHeatMode(false);
      if (floodState.enabled) {
        floodState.enabled = false;
        if (floodToggle) floodToggle.checked = false;
        floodGroup.visible = false;
      }
      heatGroup.visible = false;
      layerGroups.terrain.visible = true;
      layerGroups.grass.visible = false;
      layerGroups.railways.visible = false;
      layerGroups.paths.visible = false;
      layerGroups.roads.visible = false;
      layerGroups.buildings.visible = true;
      layerGroups.trees.visible = true;
      windGroup.visible = windState.enabled;
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
    for (const object of heatGroup.children) disposeObject(object);
    heatGroup.clear();
    heatMesh = null;
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
      heatRange = range;
      const scale = payload.color_scale || {};
      heatLegendMin.textContent = range
        ? `${scale.bottom_band_label || 'Bottom 10%'} ≤ ${Number(range.min).toFixed(1)}°C`
        : 'Bottom 10%';
      heatLegendMax.textContent = range
        ? `${scale.top_band_label || 'Top 10%'} ≥ ${Number(range.max).toFixed(1)}°C`
        : 'Top 10%';
      heatStatus.textContent = `${payload.count || payload.features?.length || 0} GPU heat zones · percentile colour scale`;
    } catch (error) {
      heatStatus.textContent = `Heat data unavailable (${error.message})`;
    }
    setHeatMode(Boolean(heatToggle?.checked));
  }

  function setHeatMode(enabled) {
    if (enabled) restoreRoadsAfterFlood();
    const wasInStudyMode = shadowState.enabled || heatGroup.visible;
    if (enabled && !wasInStudyMode) rememberNormalVisibility();
    heatGroup.visible = enabled && mitigationCompare?.value !== 'after';
    mitigationGroup.visible = enabled && mitigationCompare?.value === 'after' && Boolean(mitigationState.result);
    document.body.classList.toggle('heat-mode', enabled);
    if (enabled) {
      shadowState.enabled = false;
      if (sunToggle) sunToggle.checked = false;
      document.body.classList.remove('sun-mode');
      layerGroups.terrain.visible = false;
      layerGroups.grass.visible = false;
      layerGroups.railways.visible = false;
      layerGroups.paths.visible = false;
      layerGroups.roads.visible = false;
      layerGroups.buildings.visible = true;
      layerGroups.trees.visible = true;
      windState.enabled = false;
      if (windToggle) windToggle.checked = false;
      windGroup.visible = false;
      floodState.enabled = false;
      if (floodToggle) floodToggle.checked = false;
      floodGroup.visible = false;
      setSunMaterials(false);
    } else if (!shadowState.enabled) {
      restoreNormalVisibility();
      windState.enabled = Boolean(windToggle?.checked);
      windGroup.visible = windState.enabled;
      floodState.enabled = Boolean(floodToggle?.checked);
      floodGroup.visible = floodState.enabled;
    }
    syncLayerControls();
    requestRender();
  }

  function geometryPolygons(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }

  function polygonMesh(features, valueAt, range, opacity = 0.88) {
    const positions = [];
    const colors = [];
    const toRing = ring => {
      const points = ring.map(([x, z]) => new THREE.Vector2(x, z));
      if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();
      return points;
    };
    for (const feature of features) {
      const value = valueAt(feature);
      const color = heatColor(value, range.min, range.max);
      for (const polygon of geometryPolygons(feature.geometry)) {
        const contour = toRing(polygon[0] || []);
        const holes = polygon.slice(1).map(toRing).filter(ring => ring.length >= 3);
        if (contour.length < 3) continue;
        const vertices = contour.concat(...holes);
        for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
          for (const index of face) {
            const point = vertices[index];
            positions.push(point.x, terrainHeightAt(point.x, point.y) + 0.62, point.y);
            colors.push(color.r, color.g, color.b);
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }));
  }

  const mitigationMethods = {
    added_canopy: {
      label: 'Added canopy', color: 0x398a55, parameter: 'maturity_pct',
      parameterLabel: 'maturity %', defaultValue: 100, min: 20, max: 100, step: 5,
      note: 'Tree canopy casts time-dependent shade; maturity scales its estimated benefit.',
    },
    constructed_shade: {
      label: 'Constructed shade', color: 0xd49b45, parameter: 'height_m',
      parameterLabel: 'height m', defaultValue: 3, min: 1.5, max: 12, step: 0.5,
      note: 'A canopy or shelter casts shade according to its height, date and time.',
    },
    cool_pavement: {
      label: 'Cool pavement', color: 0x86b9cf, parameter: 'target_albedo',
      parameterLabel: 'target albedo', defaultValue: 0.35, min: 0.25, max: 0.65, step: 0.05,
      note: 'A more reflective ground finish lowers treated surface temperature.',
    },
    green_roof: {
      label: 'Green roof', color: 0x6ea64b, parameter: 'substrate_depth_cm',
      parameterLabel: 'soil depth cm', defaultValue: 15, min: 6, max: 60, step: 1,
      note: 'Only the portion painted over building footprints is eligible; pedestrian relief is not claimed.',
    },
    canopy_protection: {
      label: 'Protect canopy', color: 0x1e6b42, parameter: 'maturity_pct',
      parameterLabel: 'retained %', defaultValue: 100, min: 20, max: 100, step: 5,
      note: 'Only existing mapped canopy is retained and counted.',
    },
    permeable_pavement: {
      label: 'Permeable pavement', color: 0x5b91a0, parameter: 'runoff_capture_mm',
      parameterLabel: 'storm capture mm', defaultValue: 25, min: 5, max: 100, step: 5,
      note: 'Adds modest cooling and records a conceptual stormwater-capture depth.',
    },
    rain_garden: {
      label: 'Rain garden / bioswale', color: 0x3f8f78, parameter: 'influence_m',
      parameterLabel: 'cooling reach m', defaultValue: 6, min: 2, max: 20, step: 1,
      note: 'A planted drainage area cools its footprint and a configurable nearby buffer.',
    },
    depave_plant: {
      label: 'De-pave and plant', color: 0x78a84f, parameter: 'influence_m',
      parameterLabel: 'cooling reach m', defaultValue: 4, min: 1, max: 15, step: 1,
      note: 'Replaces hard ground with planting and extends cooling beyond the treated footprint.',
    },
    water_feature: {
      label: 'Water feature', color: 0x3d9ac4, parameter: 'influence_m',
      parameterLabel: 'cooling reach m', defaultValue: 8, min: 2, max: 25, step: 1,
      note: 'Models localized evaporative cooling; water demand still needs a separate feasibility check.',
    },
  };

  function flatPolygonMesh(geometry, color, opacity = 0.34) {
    const positions = [];
    for (const polygon of geometryPolygons(geometry)) {
      const contour = (polygon[0] || []).map(([x, z]) => new THREE.Vector2(x, z));
      if (contour.length > 1 && contour[0].equals(contour.at(-1))) contour.pop();
      const holes = polygon.slice(1).map(ring => {
        const points = ring.map(([x, z]) => new THREE.Vector2(x, z));
        if (points.length > 1 && points[0].equals(points.at(-1))) points.pop();
        return points;
      });
      const vertices = contour.concat(...holes);
      for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        for (const index of face) {
          const point = vertices[index];
          positions.push(point.x, terrainHeightAt(point.x, point.y) + 1.15, point.y);
        }
      }
    }
    const geometryBuffer = new THREE.BufferGeometry();
    geometryBuffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return new THREE.Mesh(geometryBuffer, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    }));
  }

  function updateMitigationDrawing() {
    mitigationDrawingGroup.clear();
    for (const item of mitigationState.interventions.filter(entry => entry.visible)) {
      const config = mitigationMethods[item.method] || { color: 0xf5b85f };
      const mesh = flatPolygonMesh(item.geometry, config.color);
      mesh.renderOrder = 12;
      mitigationDrawingGroup.add(mesh);
      for (const polygon of geometryPolygons(item.geometry)) {
        const ring = polygon[0] || [];
        const linePoints = ring.map(([x, z]) => new THREE.Vector3(x, terrainHeightAt(x, z) + 1.35, z));
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(linePoints),
          new THREE.LineBasicMaterial({ color: config.color, depthTest: false }),
        );
        line.renderOrder = 13;
        mitigationDrawingGroup.add(line);
      }
    }
    if (!mitigationState.points.length) {
      requestRender();
      return;
    }
    const points = mitigationState.points.map(([x, z]) => new THREE.Vector3(x, terrainHeightAt(x, z) + 1.0, z));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    mitigationDrawingGroup.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xf5b85f, depthTest: false })));
    if (mitigationState.points.length >= 3) {
      const ring = [...mitigationState.points, mitigationState.points[0]];
      const preview = flatPolygonMesh({ type: 'Polygon', coordinates: [ring] }, 0xf5b85f, 0.22);
      preview.renderOrder = 14;
      mitigationDrawingGroup.add(preview);
    }
    requestRender();
  }

  function methodLabel(method) {
    return mitigationMethods[method]?.label || method;
  }

  function invalidateMitigationResult() {
    mitigationState.result = null;
    mitigationGroup.clear();
    mitigationResults.hidden = true;
    mitigationCompare.value = 'before';
    if (heatToggle?.checked) setHeatMode(true);
  }

  function renderMitigationInterventions() {
    mitigationList.innerHTML = '';
    mitigationState.interventions.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'mitigation-item';
      const config = mitigationMethods[item.method] || mitigationMethods.cool_pavement;
      const parameterValue = item[config.parameter] ?? config.defaultValue;
      row.innerHTML = `
        <span><label><input type="checkbox" data-action="visible" ${item.visible ? 'checked' : ''}> ${methodLabel(item.method)}</label></span>
        <input type="number" data-action="parameter" aria-label="${config.parameterLabel}" title="${config.parameterLabel}"
          min="${config.min}" max="${config.max}" step="${config.step}" value="${parameterValue}">
        <span><button type="button" data-action="duplicate" title="Duplicate">＋</button><button type="button" data-action="remove" title="Remove">×</button></span>`;
      row.addEventListener('change', event => {
        if (event.target.dataset.action === 'visible') item.visible = event.target.checked;
        if (event.target.dataset.action === 'parameter') {
          item[config.parameter] = Number(event.target.value);
        }
        invalidateMitigationResult();
        mitigationRun.disabled = !mitigationState.interventions.some(entry => entry.visible);
        updateMitigationDrawing();
      });
      row.addEventListener('click', event => {
        if (event.target.dataset.action === 'remove') mitigationState.interventions.splice(index, 1);
        if (event.target.dataset.action === 'duplicate') {
          mitigationState.interventions.splice(index + 1, 0, {
            ...item, id: `intervention-${Date.now()}`, geometry: JSON.parse(JSON.stringify(item.geometry)),
          });
        }
        invalidateMitigationResult();
        renderMitigationInterventions();
        updateMitigationDrawing();
      });
      mitigationList.append(row);
    });
    mitigationRun.disabled = !mitigationState.interventions.some(item => item.visible);
  }

  function finishMitigationDrawing() {
    if (mitigationState.points.length < 3) {
      mitigationStatus.textContent = 'Add at least three points before closing the intervention.';
      return;
    }
    const ring = [...mitigationState.points, mitigationState.points[0]];
    const method = mitigationMethod.value;
    const config = mitigationMethods[method] || mitigationMethods.cool_pavement;
    mitigationState.interventions.push({
      id: `intervention-${Date.now()}`,
      method,
      [config.parameter]: config.defaultValue,
      height_m: method === 'added_canopy' ? 8 : method === 'constructed_shade' ? config.defaultValue : 0,
      visible: true,
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
    invalidateMitigationResult();
    mitigationState.drawing = false;
    mitigationState.stroking = false;
    mitigationState.pointerId = null;
    mitigationState.points = [];
    mitigationAdd.classList.remove('active');
    mitigationAdd.setAttribute('aria-pressed', 'false');
    mitigationAdd.textContent = 'Draw intervention';
    canvas.style.cursor = '';
    mitigationStatus.textContent = `${methodLabel(method)} added · draw another or compare impact.`;
    updateMitigationDrawing();
    renderMitigationInterventions();
  }

  function buildMitigationResult(payload) {
    mitigationGroup.clear();
    const range = heatRange || { min: 25, max: 45 };
    const mesh = polygonMesh(payload.zones, zone => zone.estimates.central.surface_temperature_c, range);
    mesh.renderOrder = 5;
    mitigationGroup.add(mesh);
    mitigationState.result = payload;
    const central = payload.summary.estimates.central;
    mitigationResults.hidden = false;
    const coBenefits = payload.summary.co_benefits || {};
    mitigationResults.innerHTML = `
      <span><b>${Math.round(payload.summary.treated_area_m2).toLocaleString()} m²</b>Treated</span>
      <span><b>${Math.round(payload.summary.affected_area_m2).toLocaleString()} m²</b>Affected / shaded</span>
      <span><b>${central.mean_surface_reduction_c.toFixed(1)}°C</b>Mean surface relief</span>
      <span><b>${central.mean_pedestrian_reduction_c.toFixed(1)}°C</b>Pedestrian relief</span>
      ${coBenefits.conceptual_runoff_capture_m3 > 0
        ? `<span><b>${coBenefits.conceptual_runoff_capture_m3.toFixed(1)} m³</b>Conceptual runoff capture</span>` : ''}
      ${coBenefits.added_canopy_m2 > 0
        ? `<span><b>${Math.round(coBenefits.added_canopy_m2)} m²</b>Added mature canopy</span>` : ''}`;
    mitigationStatus.textContent = payload.warnings.length
      ? payload.warnings.join(' ')
      : `${payload.summary.affected_zone_count} affected heat zones · ${payload.version}`;
    mitigationCompare.value = 'after';
    if (heatToggle) heatToggle.checked = true;
    setHeatMode(true);
  }

  async function runMitigationPreview() {
    const active = mitigationState.interventions.filter(item => item.visible);
    if (!active.length) return;
    mitigationRun.disabled = true;
    mitigationRun.textContent = 'Estimating…';
    mitigationStatus.textContent = 'Intersecting interventions with heat, canopy, and roof geometry…';
    try {
      const response = await fetch(`${windApi}/mitigations/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          interventions: active,
          sun_date: shadowState.date,
          sun_minutes: shadowState.minutes,
          baseline_metric: 'heat_model_lst_c',
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      buildMitigationResult(payload);
    } catch (error) {
      mitigationStatus.textContent = `Impact estimate unavailable (${error.message})`;
    } finally {
      mitigationRun.disabled = false;
      mitigationRun.textContent = 'Compare impact';
    }
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

  function updateFloodBox() {
    const [minX, minZ, maxX, maxZ] = floodState.bounds;
    const width = Math.max(1, maxX - minX);
    const depth = Math.max(1, maxZ - minZ);
    const centerX = (minX + maxX) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    const centerY = terrainHeightAt(centerX, centerZ) + 7;
    if (!floodBox) {
      const geometry = new THREE.BoxGeometry(1, 14, 1);
      floodBox = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0x32bce8,
        transparent: true,
        opacity: 0.045,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      floodBoxEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0x8de4ff, transparent: true, opacity: 0.9, depthTest: false }),
      );
      floodHandle = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), new THREE.MeshBasicMaterial({ color: 0x32bce8, depthTest: false }));
      floodHandle.name = 'flood-resize-handle';
      floodBox.renderOrder = 7;
      floodBoxEdges.renderOrder = 8;
      floodGroup.add(floodBox, floodBoxEdges, floodHandle);
    }
    floodBox.position.set(centerX, centerY, centerZ);
    floodBox.scale.set(width, 1, depth);
    floodBox.material.opacity = floodState.moveMode ? 0.12 : 0.045;
    floodBox.material.color.setHex(floodState.validBox ? 0x32bce8 : 0xe45757);
    floodBoxEdges.material.color.setHex(floodState.validBox ? 0x8de4ff : 0xff8a8a);
    floodBoxEdges.position.copy(floodBox.position);
    floodBoxEdges.scale.copy(floodBox.scale);
    floodHandle.position.set(maxX, centerY + 22, maxZ);
    floodHandle.material.color.setHex(floodState.validBox ? 0x32bce8 : 0xe45757);
    floodHandle.visible = floodState.moveMode;
    floodBox.visible = true;
    floodBoxEdges.visible = true;
    requestRender();
  }

  function stopFloodAnimation() {
    if (floodAnimationFrame) cancelAnimationFrame(floodAnimationFrame);
    floodAnimationFrame = 0;
  }

  function floodColor(depth, maximum) {
    const stops = [
      [0, 0xbdeeff],
      [0.35, 0x42bde8],
      [0.68, 0x1975c5],
      [1, 0x4437a4],
    ];
    const t = Math.sqrt(clamp(depth / Math.max(maximum, 0.01), 0, 1));
    let upper = 1;
    while (upper < stops.length - 1 && t > stops[upper][0]) upper += 1;
    const lower = upper - 1;
    const amount = (t - stops[lower][0]) / (stops[upper][0] - stops[lower][0]);
    return new THREE.Color(stops[lower][1]).lerp(new THREE.Color(stops[upper][1]), amount);
  }

  function clearFloodSimulation() {
    stopFloodAnimation();
    for (const object of [floodWaterMesh, floodVelocityLines]) {
      if (!object) continue;
      floodGroup.remove(object);
      disposeObject(object);
    }
    floodWaterMesh = null;
    floodVelocityLines = null;
    floodState.field = null;
    if (floodResults) floodResults.hidden = true;
    if (floodTime) floodTime.textContent = 'Dry · 0 min';
  }

  function buildFloodSurface(depthValues = null, showVelocity = false) {
    const field = floodState.field;
    if (!field?.max_depth?.length) return;
    for (const object of [floodWaterMesh, floodVelocityLines]) {
      if (!object) continue;
      floodGroup.remove(object);
      disposeObject(object);
    }
    floodWaterMesh = null;
    floodVelocityLines = null;
    const positions = [];
    const colors = [];
    const velocityPositions = [];
    const displayMaximum = clamp(field.summary?.max_depth_m || 0.2, 0.15, 1.5);
    const stride = Math.max(2, Math.ceil(Math.sqrt(field.width * field.height / 450)));
    for (let row = 0; row < field.height; row += 1) {
      for (let column = 0; column < field.width; column += 1) {
        const index = row * field.width + column;
        const depth = (depthValues || field.depth)[index] || 0;
        if (!field.active[index] || field.buildings[index] || depth < 0.0002) continue;
        const x0 = field.origin[0] + column * field.dx;
        const z0 = field.origin[1] + row * field.dz;
        const x1 = x0 + field.dx;
        const z1 = z0 + field.dz;
        const y = field.bed[index] + depth + 0.12;
        const color = floodColor(depth, displayMaximum);
        positions.push(
          x0, y, z0, x0, y, z1, x1, y, z0,
          x1, y, z0, x0, y, z1, x1, y, z1,
        );
        for (let vertex = 0; vertex < 6; vertex += 1) colors.push(color.r, color.g, color.b);

        if (showVelocity && row % stride === 0 && column % stride === 0 && depth >= 0.03) {
          const u = field.u[index] || 0;
          const v = field.v[index] || 0;
          const speed = Math.hypot(u, v);
          if (speed > 0.02) {
            const length = clamp(speed * 3, 1.5, field.dx * stride * 0.75);
            const centerX = x0 + field.dx * 0.5;
            const centerZ = z0 + field.dz * 0.5;
            velocityPositions.push(
              centerX, y + 0.28, centerZ,
              centerX + u / speed * length, y + 0.28, centerZ + v / speed * length,
            );
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    floodWaterMesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      shininess: 90,
      specular: 0xa8e8ff,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    floodWaterMesh.name = 'maximum-flood-depth';
    floodWaterMesh.renderOrder = 5;
    floodGroup.add(floodWaterMesh);

    if (velocityPositions.length) {
      const velocityGeometry = new THREE.BufferGeometry();
      velocityGeometry.setAttribute('position', new THREE.Float32BufferAttribute(velocityPositions, 3));
      floodVelocityLines = new THREE.LineSegments(velocityGeometry, new THREE.LineBasicMaterial({
        color: 0xe8fbff,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      }));
      floodVelocityLines.name = 'final-flood-velocity';
      floodVelocityLines.renderOrder = 6;
      floodGroup.add(floodVelocityLines);
    }
  }

  function playFloodAnimation() {
    const field = floodState.field;
    if (!field?.frames?.length) {
      buildFloodSurface(field?.depth || null, true);
      return;
    }
    stopFloodAnimation();
    const started = performance.now();
    const playbackMs = clamp(field.frames.length * 180, 2800, 6500);
    let previousFrame = -1;
    const animate = now => {
      const progress = clamp((now - started) / playbackMs, 0, 1);
      const frameIndex = Math.min(field.frames.length - 1, Math.floor(progress * field.frames.length));
      if (frameIndex !== previousFrame) {
        previousFrame = frameIndex;
        buildFloodSurface(field.frames[frameIndex], frameIndex === field.frames.length - 1);
        const minute = field.frame_times_min?.[frameIndex] ?? 0;
        if (floodTime) floodTime.textContent = `Filling · ${Number(minute).toFixed(0)} min`;
        requestRender();
      }
      if (progress < 1 && floodState.enabled) {
        floodAnimationFrame = requestAnimationFrame(animate);
      } else {
        floodAnimationFrame = 0;
        buildFloodSurface(field.depth, true);
        if (floodTime) floodTime.textContent = `Full storm · ${field.forcing.duration_min.toFixed(0)} min`;
        requestRender();
      }
    };
    floodAnimationFrame = requestAnimationFrame(animate);
  }

  async function simulateFlood() {
    floodState.validBox = boxInLidarFootprint(floodState.bounds);
    updateFloodBox();
    if (!floodState.validBox) {
      floodStatus.textContent = 'Flood box crosses outside available terrain coverage · move or resize it onto visible terrain.';
      return;
    }
    floodSimulate.disabled = true;
    floodSimulate.textContent = 'Solving…';
    floodStatus.textContent = 'Solving the closed 2D box; water cannot cross its boundary…';
    clearFloodSimulation();
    try {
      const response = await fetch(`${windApi}/flood/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bounds_local: floodState.bounds,
          center_local: floodState.center,
          size_m: Number(floodSize.value),
          resolution_m: Number(floodResolution.value),
          rainfall_mm_h: Number(floodRain.value),
          duration_min: Number(floodDuration.value),
          infiltration_mm_h: Number(floodInfiltration.value),
          manning_n: Number(floodRoughness.value),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      floodState.field = payload;
      floodState.enabled = true;
      floodGroup.visible = true;
      if (floodToggle) floodToggle.checked = true;
      hideRoadsForFlood();
      playFloodAnimation();
      const summary = payload.summary;
      floodLegendMax.textContent = `${summary.max_depth_m.toFixed(2)} m`;
      floodResults.innerHTML = `
        <span><b>${summary.max_depth_m.toFixed(2)} m</b>Maximum depth</span>
        <span><b>${summary.max_speed_mps.toFixed(2)} m/s</b>Maximum velocity</span>
        <span><b>${Math.round(summary.wet_area_m2).toLocaleString()} m²</b>Area ≥ 1 cm</span>
        <span><b>${summary.retained_water_m3.toFixed(1)} m³</b>Water retained</span>
      `;
      floodResults.hidden = false;
      const control = payload.model?.dem_control;
      floodStatus.textContent = `${payload.width} × ${payload.height} closed cells · ${summary.coarse_terrain_pct.toFixed(0)}% coarse terrain · ${control?.usable_marks || 0} survey marks checked`;
    } catch (error) {
      floodStatus.textContent = `Flood simulation unavailable (${error.message})`;
    } finally {
      floodSimulate.disabled = false;
      floodSimulate.textContent = 'Simulate flood';
      requestRender();
    }
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
        const centerX = field.origin[0] + (column + 0.5) * field.dx;
        const centerZ = field.origin[1] + (row + 0.5) * field.dz;
        if (!pointInLidarFootprint(centerX, centerZ)) continue;
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
      x, z, spawnX: x, spawnZ: z, age, u: 0, v: 0,
      trail: Array.from({ length: windTrailPoints }, () => [x, z]),
    });
    const minX = field.origin[0];
    const maxX = minX + field.width * field.dx;
    const minZ = field.origin[1];
    const maxZ = minZ + field.height * field.dz;
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      if (pointInLidarFootprint(x, z) && !windPointInsideBuilding(x, z)) {
        return makeParticle(x, z, Math.random() * 8);
      }
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
      const displacementFromSpawn = Math.hypot(particle.x - particle.spawnX, particle.z - particle.spawnZ);
      // A numerical recirculation or a narrow collision pocket should not
      // keep the same streak alive forever. Re-seed particles that have not
      // made meaningful downstream progress after several seconds.
      if (outsideDomain || particle.age > 9 || (particle.age > 6 && displacementFromSpawn < 20)) {
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
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const terrainHit = raycaster.intersectObject(terrainMesh, false)[0];
    if (terrainHit && pointInLidarFootprint(terrainHit.point.x, terrainHit.point.z)) return terrainHit.point;
    if (terrain.footprint?.length) return null;
    // The terrain mesh is finite. Retain a plane fallback for clicks just
    // outside it, but use the local target height rather than wind state.
    const plane = new THREE.Plane(
      new THREE.Vector3(0, 1, 0),
      -terrainHeightAt(cameraState.target.x, cameraState.target.z),
    );
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  function appendMitigationPoint(event, force = false) {
    const point = pointerGround(event);
    if (!point) return false;
    const screen = [event.clientX, event.clientY];
    if (!force && mitigationState.lastScreen
      && Math.hypot(screen[0] - mitigationState.lastScreen[0], screen[1] - mitigationState.lastScreen[1]) < 5) return false;
    const next = [Number(point.x.toFixed(2)), Number(point.z.toFixed(2))];
    const previous = mitigationState.points.at(-1);
    if (previous && Math.hypot(next[0] - previous[0], next[1] - previous[1]) < 0.35) return false;
    mitigationState.points.push(next);
    mitigationState.lastScreen = screen;
    mitigationStatus.textContent = `Painting ${methodLabel(mitigationMethod.value)} · release to finish.`;
    updateMitigationDrawing();
    return true;
  }

  function handleScreenPoint(handle) {
    if (!handle?.visible) return null;
    const projected = handle.position.clone().project(camera);
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
    if (streetViewState.placing && event.button === 0) {
      const point = pointerGround(event);
      if (point) {
        streetViewState.placing = false;
        streetViewState.point = [Number(point.x.toFixed(3)), Number(point.z.toFixed(3))];
        streetViewGroup.position.set(point.x, terrainHeightAt(point.x, point.z) + 0.8, point.z);
        streetViewGroup.visible = true;
        dispatchEvent(new CustomEvent('climate-streetview-point', {
          detail: { x: streetViewState.point[0], z: streetViewState.point[1] },
        }));
        requestRender();
      }
      return;
    }
    if (mitigationState.drawing && event.button === 0) {
      mitigationState.points = [];
      mitigationState.stroking = true;
      mitigationState.pointerId = event.pointerId;
      mitigationState.lastScreen = null;
      appendMitigationPoint(event, true);
      capturePointer(event);
      return;
    }
    if (floodState.enabled && floodState.moveMode && event.button === 0) {
      const point = pointerGround(event);
      if (point) {
        const handleScreen = handleScreenPoint(floodHandle);
        const handleDistance = handleScreen
          ? Math.hypot(event.clientX - handleScreen.x, event.clientY - handleScreen.y)
          : Infinity;
        const handleTolerance = 20;
        floodDrag = {
          mode: handleDistance <= handleTolerance ? 'resize' : 'move',
          start: point,
          center: [...floodState.center],
          bounds: [...floodState.bounds],
        };
        clearFloodSimulation();
        floodStatus.textContent = floodDrag.mode === 'resize'
          ? 'Resizing box · release, then simulate flood.'
          : 'Moving box · release, then simulate flood.';
        capturePointer(event);
        return;
      }
    }
    if (windState.enabled && windState.moveMode) {
      const point = pointerGround(event);
      if (point) {
        const half = windState.size * 0.5;
        const handleScreen = handleScreenPoint(windHandle);
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
    if (mitigationState.drawing && mitigationState.stroking && event.pointerId === mitigationState.pointerId) {
      appendMitigationPoint(event);
      return;
    }
    if (floodDrag) {
      const point = pointerGround(event);
      if (!point) return;
      if (floodDrag.mode === 'resize') {
        const requestedWidth = Math.abs(point.x - floodDrag.center[0]) * 2;
        const requestedHeight = Math.abs(point.z - floodDrag.center[1]) * 2;
        const maxWidth = Math.min(1200, 2 * (floodDrag.center[0] - left), 2 * (right - floodDrag.center[0]));
        const maxHeight = Math.min(1200, 2 * (floodDrag.center[1] - minZ), 2 * (maxZ - floodDrag.center[1]));
        const width = Math.round(clamp(requestedWidth, 100, maxWidth) / 25) * 25;
        const height = Math.round(clamp(requestedHeight, 100, maxHeight) / 25) * 25;
        floodState.bounds = [
          floodDrag.center[0] - width / 2, floodDrag.center[1] - height / 2,
          floodDrag.center[0] + width / 2, floodDrag.center[1] + height / 2,
        ];
        if (floodSize) floodSize.value = String(clamp(Math.max(width, height), Number(floodSize.min), Number(floodSize.max)));
        if (floodSizeValue) floodSizeValue.textContent = `${width} × ${height} m`;
      } else {
        const width = floodDrag.bounds[2] - floodDrag.bounds[0];
        const height = floodDrag.bounds[3] - floodDrag.bounds[1];
        const centerX = clamp(floodDrag.center[0] + point.x - floodDrag.start.x, left + width / 2, right - width / 2);
        const centerZ = clamp(floodDrag.center[1] + point.z - floodDrag.start.z, minZ + height / 2, maxZ - height / 2);
        floodState.bounds = [centerX - width / 2, centerZ - height / 2, centerX + width / 2, centerZ + height / 2];
      }
      floodState.center = [
        (floodState.bounds[0] + floodState.bounds[2]) / 2,
        (floodState.bounds[1] + floodState.bounds[3]) / 2,
      ];
      floodState.validBox = boxInLidarFootprint(floodState.bounds);
      updateFloodBox();
      return;
    }
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
  canvas.addEventListener('pointerup', event => {
    if (mitigationState.drawing && mitigationState.stroking && event.pointerId === mitigationState.pointerId) {
      appendMitigationPoint(event, true);
      mitigationState.stroking = false;
      mitigationState.pointerId = null;
      if (mitigationState.points.length >= 3) finishMitigationDrawing();
      else {
        mitigationState.points = [];
        mitigationStatus.textContent = 'Drag across the terrain to paint an area; a click is too small.';
        updateMitigationDrawing();
      }
      return;
    }
    drag = null;
    if (floodDrag) {
      const width = Math.round(floodState.bounds[2] - floodState.bounds[0]);
      const height = Math.round(floodState.bounds[3] - floodState.bounds[1]);
      floodState.size = Math.max(width, height);
      floodStatus.textContent = floodDrag.mode === 'resize'
        ? `Box resized to ${width} × ${height} m · click Simulate flood.`
        : 'Box moved · click Simulate flood.';
    }
    floodDrag = null;
    if (windDrag && windState.moveMode) {
      windStatus.textContent = windDrag.mode === 'resize'
        ? `Domain resized to ${windState.size} m · click Simulate wind.`
        : 'Domain moved · click Simulate wind.';
    }
    windDrag = null;
  });
  canvas.addEventListener('pointercancel', event => {
    if (event.pointerId === mitigationState.pointerId) {
      mitigationState.stroking = false;
      mitigationState.pointerId = null;
      mitigationState.points = [];
      updateMitigationDrawing();
    }
    drag = null;
    windDrag = null;
    floodDrag = null;
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    cameraState.distance = clamp(cameraState.distance * Math.exp(event.deltaY * 0.0008), 80, 7000);
    updateCamera();
  }, { passive: false });
  canvas.addEventListener('dblclick', event => {
    if (mitigationState.drawing || floodState.moveMode) {
      event.preventDefault();
    } else {
      fitScene();
    }
  });
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
    windState.enabled = event.target.checked;
    windGroup.visible = windState.enabled;
    if (windState.enabled) {
      floodState.enabled = false;
      if (floodToggle) floodToggle.checked = false;
      floodGroup.visible = false;
      restoreRoadsAfterFlood();
    }
    windStatus.textContent = windState.enabled
      ? (windState.field ? 'Existing wind heatmap and gusts shown.' : '3D domain ready · position it, then simulate.')
      : 'Wind display hidden.';
    requestRender();
  });
  windDirection?.addEventListener('change', event => {
    windState.direction = Number(event.target.value);
    windState.referenceHeight = 2;
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
    windState.speed = Number(event.target.value) / 3.6;
    windState.referenceHeight = 2;
    windSpeedValue.textContent = `${Math.round(windState.speed * 3.6)} km/h`;
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
  floodToggle?.addEventListener('change', event => {
    floodState.enabled = event.target.checked;
    floodGroup.visible = floodState.enabled;
    if (!floodState.enabled) {
      stopFloodAnimation();
      floodState.moveMode = false;
      floodMoveDomain?.classList.remove('active');
      floodMoveDomain?.setAttribute('aria-pressed', 'false');
      if (floodMoveDomain) floodMoveDomain.textContent = 'Move / resize domain';
    }
    if (floodState.enabled) {
      if (heatToggle?.checked) {
        heatToggle.checked = false;
        setHeatMode(false);
      }
      windState.enabled = false;
      if (windToggle) windToggle.checked = false;
      windGroup.visible = false;
      hideRoadsForFlood();
    } else {
      restoreRoadsAfterFlood();
    }
    floodStatus.textContent = floodState.enabled
      ? (floodState.field ? 'Animated flood result shown.' : 'Domain ready · position it, then simulate.')
      : 'Flood display hidden.';
    if (floodState.enabled) updateFloodBox();
    requestRender();
  });
  const invalidateFlood = message => {
    if (floodState.field) clearFloodSimulation();
    floodStatus.textContent = message;
    requestRender();
  };
  floodRain?.addEventListener('input', event => {
    floodRainValue.textContent = `${event.target.value} mm/h`;
    invalidateFlood('Rainfall changed · run the simulation again.');
  });
  floodDuration?.addEventListener('input', event => {
    floodDurationValue.textContent = `${event.target.value} min`;
    invalidateFlood('Storm duration changed · run the simulation again.');
  });
  floodInfiltration?.addEventListener('input', event => {
    floodInfiltrationValue.textContent = `${event.target.value} mm/h`;
    invalidateFlood('Infiltration changed · run the simulation again.');
  });
  floodRoughness?.addEventListener('change', () => invalidateFlood('Roughness changed · run the simulation again.'));
  floodResolution?.addEventListener('change', () => invalidateFlood('Grid resolution changed · run the simulation again.'));
  floodSize?.addEventListener('input', event => {
    floodState.size = Number(event.target.value);
    floodSizeValue.textContent = `${event.target.value} m`;
    const [centerX, centerZ] = floodState.center;
    const half = floodState.size / 2;
    floodState.bounds = [centerX - half, centerZ - half, centerX + half, centerZ + half];
    floodState.validBox = boxInLidarFootprint(floodState.bounds);
    updateFloodBox();
    invalidateFlood('Domain resized · simulate again, or fine-tune with Move / resize domain.');
  });
  floodMoveDomain?.addEventListener('click', () => {
    if (!floodState.moveMode && !floodState.enabled && floodToggle) {
      floodToggle.checked = true;
      floodToggle.dispatchEvent(new Event('change'));
    }
    floodState.moveMode = !floodState.moveMode;
    floodMoveDomain.classList.toggle('active', floodState.moveMode);
    floodMoveDomain.setAttribute('aria-pressed', String(floodState.moveMode));
    floodMoveDomain.textContent = floodState.moveMode ? 'Done moving' : 'Move / resize domain';
    updateFloodBox();
  });
  floodSimulate?.addEventListener('click', simulateFlood);
  mitigationAdd?.addEventListener('click', () => {
    mitigationState.drawing = !mitigationState.drawing;
    mitigationState.points = [];
    mitigationAdd.classList.toggle('active', mitigationState.drawing);
    mitigationAdd.setAttribute('aria-pressed', String(mitigationState.drawing));
    mitigationAdd.textContent = mitigationState.drawing ? 'Cancel drawing' : 'Draw intervention';
    mitigationStatus.textContent = mitigationState.drawing
      ? `Drag on the terrain to paint ${methodLabel(mitigationMethod.value)}; release to finish.`
      : 'Drawing cancelled.';
    canvas.style.cursor = mitigationState.drawing ? 'crosshair' : '';
    updateMitigationDrawing();
  });
  mitigationMethod?.addEventListener('change', () => {
    const config = mitigationMethods[mitigationMethod.value];
    if (mitigationMethodNote && config) mitigationMethodNote.textContent = config.note;
    if (mitigationState.drawing) {
      mitigationStatus.textContent = `Drag on the terrain to paint ${methodLabel(mitigationMethod.value)}; release to finish.`;
    }
  });
  mitigationRun?.addEventListener('click', runMitigationPreview);
  mitigationClear?.addEventListener('click', () => {
    mitigationState.drawing = false;
    mitigationState.points = [];
    mitigationState.interventions = [];
    mitigationState.result = null;
    mitigationGroup.clear();
    mitigationDrawingGroup.clear();
    mitigationList.innerHTML = '';
    mitigationResults.hidden = true;
    mitigationRun.disabled = true;
    mitigationCompare.value = 'before';
    mitigationStatus.textContent = 'Choose a method, then drag on the terrain to paint its area.';
    canvas.style.cursor = '';
    if (heatToggle?.checked) setHeatMode(true);
  });
  mitigationCompare?.addEventListener('change', () => {
    if (mitigationCompare.value === 'after' && !mitigationState.result) {
      mitigationCompare.value = 'before';
      mitigationStatus.textContent = 'Run Compare impact before switching to the after map.';
    }
    if (heatToggle?.checked) setHeatMode(true);
  });
  addEventListener('climate-streetview-mode', event => {
    streetViewState.placing = Boolean(event.detail?.enabled);
    if (streetViewState.placing && mitigationState.drawing) {
      mitigationState.drawing = false;
      mitigationState.points = [];
      mitigationAdd.classList.remove('active');
      mitigationAdd.setAttribute('aria-pressed', 'false');
      mitigationAdd.textContent = 'Draw intervention';
      updateMitigationDrawing();
    }
    canvas.style.cursor = streetViewState.placing ? 'crosshair' : '';
  });
  addEventListener('climate-streetview-clear', () => {
    streetViewState.placing = false;
    streetViewState.point = null;
    streetViewGroup.visible = false;
    canvas.style.cursor = '';
    requestRender();
  });
  addEventListener('climate-current-weather', event => {
    const weather = event.detail || {};
    const valid = new Date(weather.valid_at);
    if (!Number.isNaN(valid.getTime())) {
      shadowState.date = valid.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
      const timeParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(valid);
      const hour = Number(timeParts.find(part => part.type === 'hour')?.value || 12);
      const minute = Number(timeParts.find(part => part.type === 'minute')?.value || 0);
      shadowState.minutes = hour * 60 + minute;
      if (sunDate) sunDate.value = shadowState.date;
      if (sunTime) sunTime.value = String(clamp(Math.round(shadowState.minutes / 10) * 10, Number(sunTime.min), Number(sunTime.max)));
      shadowState.minutes = Number(sunTime?.value) || shadowState.minutes;
    }
    windState.direction = Number(weather.wind_direction_10m_deg) || 0;
    windState.speed = Math.max(0, Number(weather.wind_speed_10m_mps) || 0);
    windState.referenceHeight = 10;
    if (windDirection) {
      const option = Array.from(windDirection.options).reduce((best, candidate) => {
        const delta = Math.abs(((Number(candidate.value) - windState.direction + 180) % 360) - 180);
        return !best || delta < best.delta ? { candidate, delta } : best;
      }, null);
      if (option) windDirection.value = option.candidate.value;
    }
    if (windSpeed) windSpeed.value = String(clamp(windState.speed * 3.6, Number(windSpeed.min), Number(windSpeed.max)));
    if (windSpeedValue) windSpeedValue.textContent = `${Math.round(windState.speed * 3.6)} km/h`;
    shadowState.generated = false;
    sunLight.visible = false;
    shadowCatcher.visible = false;
    if (sunGenerate) sunGenerate.textContent = 'Generate shadows';
    updateSunStatus('Current Cape Town time set · generate shadows when ready.');
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = `Current forcing set · ${windState.speed.toFixed(1)} m/s from ${Math.round(windState.direction)}° · click Simulate wind.`;
    requestRender();
  });

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
  floodGroup.visible = floodState.enabled;
  floodState.validBox = boxInLidarFootprint(floodState.bounds);
  updateFloodBox();
  const roofTriangles = manifest.layers?.roof_surface?.triangles;
  status.textContent = `${data.buildings.length} buildings · ${railwayCount} railway lines · ${roofTriangles ? `${roofTriangles.toLocaleString()} detailed roof triangles · ` : ''}${canopyCount} canopy footprints`;
  updateSunStatus();
  loadHeat();
  setHeatMode(Boolean(heatToggle?.checked));
  requestRender();

  return { renderer, scene, camera };
}
