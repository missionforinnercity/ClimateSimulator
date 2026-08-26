import * as THREE from './vendor/three.module.min.js';
import { createTransportLayer } from './transportLayer.js?v=13';

const COLORS = {
  background: 0x1b2125,
  terrain: 0x424a4d,
  terrainSun: 0xf4f3ee,
  terrainEdge: 0x363d40,
  terrainEdgeDeep: 0x1c2124,
  grass: 0x50745a,
  water: 0x2f86a6,
  wall: 0x657076,
  wallSun: 0xffffff,
  roof: 0xaeb5b8,
  roofSun: 0xffffff,
  road: 0x444746,
  roadMajor: 0xb8a04a,
  roadSecondary: 0x58656a,
  // Permanent pedestrian streets should read as context, while the brighter
  // red/orange simulation ribbons remain the attention-grabbing states.
  pedestrian: 0x657d7b,
  path: 0x858f90,
  rail: 0x929b9c,
  sleeper: 0x3f4545,
};

// Surface height and draw priority are separate concerns. The small physical
// offsets prevent z-fighting with the terrain; renderOrder below decides which
// carriageway owns a junction instead of asking the depth buffer to arbitrate
// between nearly coplanar road meshes.
const ROAD_CLASS_OFFSETS = [0.26, 0.34, 0.30, 0.16, 0.18];

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

  const manifest = await fetch('/assets/manifest.json', { cache: 'no-store' }).then(response => response.json());
  const loadRendererScene = async () => {
    // The compact scene is intentionally the normal interactive asset. The
    // full semantic model and dense roof mesh remain available for analysis,
    // but parsing them here adds substantial startup and rendering overhead.
    const expectedWater = manifest.layers?.fallback?.water || 0;
    const fallbackResponse = await fetch(
      `/assets/${manifest.assets?.fallback || 'fallback.json'}?v=${manifest.layers?.fallback?.cache_key || manifest.layers?.fallback?.bytes || 0}`,
    );
    if (!fallbackResponse.ok) throw new Error(`compact scene HTTP ${fallbackResponse.status}`);
    const fallback = await fallbackResponse.json();
    if (expectedWater && (fallback.water || []).length !== expectedWater) {
      throw new Error(`compact scene contains ${(fallback.water || []).length}/${expectedWater} water bodies`);
    }
    return fallback;
  };
  const [data, canopyAsset, roofSurfaceBuffer] = await Promise.all([
    loadRendererScene(),
    fetch(`/assets/canopy.json?v=${manifest.layers?.canopy?.cache_key || manifest.layers?.canopy?.bytes || 0}`).then(response => response.ok ? response.json() : { canopies: [] }).catch(() => ({ canopies: [] })),
    Promise.resolve(null),
  ]);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);
  // Soft distance fog gives the model atmospheric depth at city-wide zoom
  // without hiding anything at typical street/building inspection distances.
  scene.fog = new THREE.Fog(COLORS.background, 1900, 4600);
  const camera = new THREE.PerspectiveCamera(46, 1, 1, 12000);
  const cameraState = {
    azimuth: 0.75,
    elevation: 0.68,
    distance: 1600,
    target: new THREE.Vector3(0, 20, 0),
  };
  let animationFrame = 0;
  let renderRequested = true;
  let transportLayer = null;
  // Scene picking shared by overlay layers: a click that did not turn into a
  // camera drag is offered to each registered handler until one consumes it.
  let groundPickHandler = null;
  let clickCandidate = null;
  const scenePickHandlers = new Set();
  const layerGroups = {
    terrain: new THREE.Group(),
    water: new THREE.Group(),
    grass: new THREE.Group(),
    railways: new THREE.Group(),
    paths: new THREE.Group(),
    roads: new THREE.Group(),
    cityFurniture: new THREE.Group(),
    buildings: new THREE.Group(),
    trees: new THREE.Group(),
  };
  Object.values(layerGroups).forEach(group => scene.add(group));

  // Decorative and municipal lighting share the same solar switch. Thousands
  // of street lamps use one point-sprite draw call; only the handful of
  // festoon fill lights are real PointLights.
  const nightLighting = {
    streetGlow: null,
    streetBulbMaterial: null,
    festoonGlow: null,
    festoonBulbMaterial: null,
    festoonPointLights: [],
  };

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

  let shadowMinimumY = Infinity;
  let shadowMaximumY = -Infinity;
  for (const height of terrain.heights) {
    if (!Number.isFinite(height)) continue;
    shadowMinimumY = Math.min(shadowMinimumY, height);
    shadowMaximumY = Math.max(shadowMaximumY, height);
  }
  for (const [ground, height, , , , wallHeight = height] of data.buildings) {
    shadowMinimumY = Math.min(shadowMinimumY, ground);
    shadowMaximumY = Math.max(shadowMaximumY, ground + Math.max(height, wallHeight));
  }
  for (const [, , , crownTop] of canopyAsset.canopies || []) {
    if (Number.isFinite(crownTop)) shadowMaximumY = Math.max(shadowMaximumY, crownTop);
  }
  if (!Number.isFinite(shadowMinimumY)) shadowMinimumY = 0;
  if (!Number.isFinite(shadowMaximumY)) shadowMaximumY = shadowMinimumY + 100;

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

  // Roads are designed surfaces, so they should not inherit every small DTM
  // bump or seam. A local median rejects isolated spikes while retaining the
  // broader street slope and avoids twisting markings across the carriageway.
  function roadTerrainHeightAt(x, z) {
    const radius = 4;
    const samples = [
      terrainHeightAt(x, z),
      terrainHeightAt(x - radius, z), terrainHeightAt(x + radius, z),
      terrainHeightAt(x, z - radius), terrainHeightAt(x, z + radius),
      terrainHeightAt(x - radius, z - radius), terrainHeightAt(x + radius, z - radius),
      terrainHeightAt(x - radius, z + radius), terrainHeightAt(x + radius, z + radius),
    ].sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  // terrainHeightAt clamps to the grid edge, so anything asked about a point
  // beyond the terrain gets the nearest edge height and appears to float over
  // the void. This reports whether a point is actually on rendered ground.
  // Nearest-neighbour on the same grid, so it is O(1) and safe to call per
  // car per frame (the footprint ray-cast in pointInLidarFootprint is not).
  function terrainValidAt(x, z) {
    if (!terrain.valid?.length) return true;
    const u = (x - left) / terrainWidth * (terrain.columns - 1);
    const v = (z - minZ) / terrainDepth * (terrain.rows - 1);
    if (!(u >= 0 && v >= 0 && u <= terrain.columns - 1 && v <= terrain.rows - 1)) return false;
    const column = Math.round(u);
    const row = Math.round(v);
    return terrain.valid[row * terrain.columns + column] > 0;
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

  function triangulateRings(outer, holes = []) {
    const rings = [outer, ...holes.filter(ring => ring?.length >= 3)];
    const vertices = rings.flat();
    const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
    const holeVectors = rings.slice(1).map(ring => ring.map(([x, z]) => new THREE.Vector2(x, z)));
    return { vertices, faces: THREE.ShapeUtils.triangulateShape(contour, holeVectors) };
  }

  function triangulateRing(ring) {
    return triangulateRings(ring).faces;
  }

  function osmColour(value, fallback) {
    if (!value) return new THREE.Color(fallback);
    let text = String(value).split(';', 1)[0].trim().toLowerCase().replaceAll('_', '');
    if (/^[0-9a-f]{6}$/i.test(text)) text = `#${text}`;
    const palette = {
      cream: '#fffdd0', darkbrown: '#5b3a29', lightbrown: '#b58b68',
      ochre: '#b7791f', turquoise: '#40a9a3', cyan: '#36a7b7', magenta: '#a94986',
      violet: '#74558f', salmon: '#c97968', anthracite: '#3d4548', transparent: '#aeb5b8',
    };
    if (palette[text]) return new THREE.Color(palette[text]);
    const names = new Set([
      'black', 'white', 'gray', 'grey', 'red', 'brown', 'green', 'blue', 'yellow',
      'orange', 'beige', 'maroon', 'silver', 'gold', 'tan', 'pink', 'purple',
      'lightgray', 'lightgrey', 'darkgray', 'darkgrey', 'darkred', 'darkgreen', 'darkblue',
    ]);
    if (!/^#[0-9a-f]{3,8}$/i.test(text) && !names.has(text)) return new THREE.Color(fallback);
    if (text === 'grey') text = 'gray';
    if (text === 'lightgrey') text = 'lightgray';
    if (text === 'darkgrey') text = 'darkgray';
    return new THREE.Color(text);
  }

  function materialColour(material, fallback, roof = false) {
    const value = String(material || '').toLowerCase();
    if (value.includes('glass')) return 0x64858d;
    if (value.includes('brick')) return 0x8a5948;
    if (value.includes('limestone')) return 0xc7b997;
    if (value.includes('stone')) return 0x8b8578;
    if (value.includes('granite')) return 0x777a78;
    if (value.includes('wood')) return 0x876a4e;
    if (value.includes('grass')) return 0x567b51;
    if (value.includes('copper')) return 0x608274;
    if (value.includes('zinc')) return 0x8f999d;
    if (value.includes('slate')) return 0x4e5960;
    if (value.includes('paving')) return 0x8a8175;
    if (value.includes('tile')) return roof ? 0x8b5145 : 0x82756b;
    if (value.includes('metal')) return 0x879196;
    if (value.includes('concrete')) return 0x858a88;
    return fallback;
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
    const wallTriangles = [];
    const roofPositions = [];
    const wallColors = [];
    const roofColors = [];
    const wallElevationColors = [];
    const roofElevationColors = [];
    data.buildings.forEach(([ground, height, ring, , , wallHeight = height, detailedRoof = false, , , wallProfile = null, minHeight = 0, , , holes = [], attributes = {}], buildingIndex) => {
      const baseY = ground + Math.max(0, Number(minHeight) || 0);
      const simpleWallHeight = roofSurfaceBuffer ? wallHeight : height;
      const roofY = ground + simpleWallHeight;
      const colour = elevationColour(height);
      const facadeColour = new THREE.Color(COLORS.wall);
      const roofColour = new THREE.Color(COLORS.roof);
      for (const [ringIndex, wallRing] of [ring, ...holes].entries()) {
        for (let index = 0; index < wallRing.length; index += 1) {
          const next = (index + 1) % wallRing.length;
          const [x1, z1] = wallRing[index];
          const [x2, z2] = wallRing[next];
          const top1 = ground + (roofSurfaceBuffer && ringIndex === 0 ? (wallProfile?.[index] ?? wallHeight) : simpleWallHeight);
          const top2 = ground + (roofSurfaceBuffer && ringIndex === 0 ? (wallProfile?.[next] ?? wallHeight) : simpleWallHeight);
          wallPositions.push(
            x1, baseY, z1, x2, baseY, z2, x2, top2, z2,
            x1, baseY, z1, x2, top2, z2, x1, top1, z1,
          );
          wallTriangles.push(
            { sourceId: buildingIndex, edgeIndex: index, ringIndex },
            { sourceId: buildingIndex, edgeIndex: index, ringIndex },
          );
          for (let vertex = 0; vertex < 6; vertex += 1) {
            wallColors.push(facadeColour.r, facadeColour.g, facadeColour.b);
            wallElevationColors.push(colour.r, colour.g, colour.b);
          }
        }
      }
      // LiDAR-covered buildings receive their own simplified surface mesh.
      // Only uncovered buildings retain this authoritative height extrusion.
      if (!detailedRoof || !roofSurfaceBuffer) {
        const triangulated = triangulateRings(ring, holes);
        for (const face of triangulated.faces) {
          const a = triangulated.vertices[face[0]];
          let b = triangulated.vertices[face[1]], c = triangulated.vertices[face[2]];
          const normalY = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
          if (normalY < 0) [b, c] = [c, b];
          roofPositions.push(a[0], roofY, a[1], b[0], roofY, b[1], c[0], roofY, c[1]);
          for (let vertex = 0; vertex < 3; vertex += 1) {
            roofColors.push(roofColour.r, roofColour.g, roofColour.b);
            roofElevationColors.push(colour.r, colour.g, colour.b);
          }
        }
      }
    });
    const wallGeometry = new THREE.BufferGeometry();
    buildingWallGeometrySource = { positions: new Float32Array(wallPositions), triangles: wallTriangles };
    simplifiedRoofGeometrySource = { positions: new Float32Array(roofPositions) };
    wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
    wallGeometry.setAttribute('color', new THREE.Float32BufferAttribute(wallColors, 3));
    wallGeometry.userData.appearanceColors = new Float32Array(wallColors);
    wallGeometry.userData.elevationColors = new Float32Array(wallElevationColors);
    wallGeometry.computeVertexNormals();
    const roofGeometry = new THREE.BufferGeometry();
    roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
    roofGeometry.setAttribute('color', new THREE.Float32BufferAttribute(roofColors, 3));
    roofGeometry.userData.appearanceColors = new Float32Array(roofColors);
    roofGeometry.userData.elevationColors = new Float32Array(roofElevationColors);
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

  const detailedRoofHeightCellSize = 12;
  const detailedRoofHeightGrid = new Map();
  const detailedRoofCellKey = (column, row) => `${column}:${row}`;
  let detailedRoofGeometrySource = null;
  let simplifiedRoofGeometrySource = null;
  let buildingWallGeometrySource = null;

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
    detailedRoofGeometrySource = { positions, indices };
    const colours = new Float32Array(vertexCount * 3);
    const elevationColours = new Float32Array(vertexCount * 3);
    const roofColourCellSize = 50;
    const roofColourGrid = new Map();
    for (const building of data.buildings || []) {
      if (!building[6] || !building[2]?.length) continue;
      const ring = building[2];
      const bounds = [
        Math.min(...ring.map(point => point[0])), Math.min(...ring.map(point => point[1])),
        Math.max(...ring.map(point => point[0])), Math.max(...ring.map(point => point[1])),
      ];
      const roofAttributes = building[14] || {};
      const item = {
        ring, holes: building[13] || [],
        colour: osmColour(roofAttributes['roof:colour'], materialColour(roofAttributes['roof:material'], COLORS.roof, true)),
      };
      for (let row = Math.floor(bounds[1] / roofColourCellSize); row <= Math.floor(bounds[3] / roofColourCellSize); row += 1) {
        for (let column = Math.floor(bounds[0] / roofColourCellSize); column <= Math.floor(bounds[2] / roofColourCellSize); column += 1) {
          const key = `${column}:${row}`;
          if (!roofColourGrid.has(key)) roofColourGrid.set(key, []);
          roofColourGrid.get(key).push(item);
        }
      }
    }
    const mappedRoofColourAt = (x, z) => {
      const candidates = roofColourGrid.get(`${Math.floor(x / roofColourCellSize)}:${Math.floor(z / roofColourCellSize)}`) || [];
      const building = candidates.find(item => pointInRing(x, z, item.ring) && !item.holes.some(hole => pointInRing(x, z, hole)));
      return building?.colour || new THREE.Color(COLORS.roof);
    };
    for (let index = 0; index < vertexCount; index += 1) {
      const colour = elevationColour(heights[index]);
      const x = positions[index * 3];
      const y = positions[index * 3 + 1];
      const z = positions[index * 3 + 2];
      const mappedColour = mappedRoofColourAt(x, z);
      colours[index * 3] = mappedColour.r;
      colours[index * 3 + 1] = mappedColour.g;
      colours[index * 3 + 2] = mappedColour.b;
      elevationColours[index * 3] = colour.r;
      elevationColours[index * 3 + 1] = colour.g;
      elevationColours[index * 3 + 2] = colour.b;
      const key = detailedRoofCellKey(Math.floor(x / detailedRoofHeightCellSize), Math.floor(z / detailedRoofHeightCellSize));
      if (!detailedRoofHeightGrid.has(key)) detailedRoofHeightGrid.set(key, []);
      detailedRoofHeightGrid.get(key).push([x, y, z]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.userData.appearanceColors = colours;
    geometry.userData.elevationColors = elevationColours;
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshLambertMaterial({
      color: COLORS.roof,
      vertexColors: true,
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

  function detailedRoofHeightAt(x, z, fallbackY) {
    const column = Math.floor(x / detailedRoofHeightCellSize);
    const row = Math.floor(z / detailedRoofHeightCellSize);
    const nearby = [];
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        for (const vertex of detailedRoofHeightGrid.get(detailedRoofCellKey(column + columnOffset, row + rowOffset)) || []) {
          if (Math.abs(vertex[1] - fallbackY) > 10) continue;
          const distance = Math.hypot(vertex[0] - x, vertex[2] - z);
          if (distance <= 18) nearby.push([distance, vertex[1]]);
        }
      }
    }
    if (!nearby.length) return fallbackY + 0.08;
    nearby.sort((a, b) => a[0] - b[0]);
    const nearest = nearby.slice(0, 4);
    const weights = nearest.map(([distance]) => 1 / Math.max(distance, 0.35) ** 2);
    return nearest.reduce((sum, item, index) => sum + item[1] * weights[index], 0)
      / weights.reduce((sum, weight) => sum + weight, 0) + 0.08;
  }

  function buildingRoofHeightAt(x, z) {
    for (const building of data.buildings || []) {
      const ring = building[2] || [];
      const holes = building[13] || [];
      if (ring.length >= 3 && pointInRing(x, z, ring) && !holes.some(hole => pointInRing(x, z, hole))) {
        return Number(building[0]) + Number(building[1]);
      }
    }
    return terrainHeightAt(x, z) + 4;
  }

  function makeWaterAndOsmDetails() {
    const waterPositions = [];
    // Boundary-only triangulation can bridge over small terrain undulations
    // and bury the middle of a pond. Subdivide each face so the visual water
    // surface follows the same terrain sampler as the rest of the scene.
    const pushDrapedWaterTriangle = (a, b, c, depth = 0) => {
      const longest = Math.max(
        Math.hypot(a[0] - b[0], a[1] - b[1]),
        Math.hypot(b[0] - c[0], b[1] - c[1]),
        Math.hypot(c[0] - a[0], c[1] - a[1]),
      );
      if (longest > 6 && depth < 7) {
        const ab = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
        const bc = [(b[0] + c[0]) * 0.5, (b[1] + c[1]) * 0.5];
        const ca = [(c[0] + a[0]) * 0.5, (c[1] + a[1]) * 0.5];
        pushDrapedWaterTriangle(a, ab, ca, depth + 1);
        pushDrapedWaterTriangle(ab, b, bc, depth + 1);
        pushDrapedWaterTriangle(ca, bc, c, depth + 1);
        pushDrapedWaterTriangle(ab, bc, ca, depth + 1);
        return;
      }
      for (const [x, z] of [a, b, c]) waterPositions.push(x, terrainHeightAt(x, z) + 0.32, z);
    };
    for (const water of data.water || []) {
      const [outer, ...holes] = water.rings || [];
      if (!outer?.length) continue;
      const triangulated = triangulateRings(outer, holes);
      for (const face of triangulated.faces) {
        pushDrapedWaterTriangle(...face.map(index => triangulated.vertices[index]));
      }
    }
    if (waterPositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(waterPositions, 3));
      geometry.computeVertexNormals();
      // Keep mapped water legible under every sun/ambient-light state. This is
      // an unlit surface treatment, not a heat-map overlay; buildings and
      // terrain still occlude it normally through the depth buffer.
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: COLORS.water,
        transparent: true, opacity: 0.94, side: THREE.DoubleSide, depthWrite: true,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      mesh.receiveShadow = true;
      mesh.renderOrder = 4;
      layerGroups.water.add(mesh);
    }

    const solarPositions = [];
    const solarFramePositions = [];
    const pushSolarVertex = (x, z) => {
      const fallback = buildingRoofHeightAt(x, z);
      solarPositions.push(x, detailedRoofHeightAt(x, z, fallback) + 0.14, z);
    };
    const pushSolarFrame = ring => {
      for (let index = 0; index < ring.length; index += 1) {
        const [x1, z1] = ring[index], [x2, z2] = ring[(index + 1) % ring.length];
        const y1 = detailedRoofHeightAt(x1, z1, buildingRoofHeightAt(x1, z1)) + 0.18;
        const y2 = detailedRoofHeightAt(x2, z2, buildingRoofHeightAt(x2, z2)) + 0.18;
        solarFramePositions.push(x1, y1, z1, x2, y2, z2);
      }
    };
    for (const item of (data.installations || []).filter(entry => entry.class === 'roofSolarPanel')) {
      if (item.rings?.[0]?.length >= 3) {
        const [outer, ...holes] = item.rings;
        pushSolarFrame(outer);
        const triangulated = triangulateRings(outer, holes);
        for (const face of triangulated.faces) for (const index of face) {
          const [x, z] = triangulated.vertices[index];
          pushSolarVertex(x, z);
        }
      } else if (item.coordinates) {
        const [x, z] = item.coordinates;
        const ring = [[x - 0.8, z - 0.5], [x + 0.8, z - 0.5], [x + 0.8, z + 0.5], [x - 0.8, z + 0.5]];
        pushSolarFrame(ring);
        for (const [dx, dz] of [[-0.8, -0.5], [0.8, -0.5], [0.8, 0.5], [-0.8, -0.5], [0.8, 0.5], [-0.8, 0.5]]) {
          pushSolarVertex(x + dx, z + dz);
        }
      }
    }
    if (solarPositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(solarPositions, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
        color: 0x245b78, specular: 0xa8cbd5, shininess: 115, side: THREE.DoubleSide,
      }));
      mesh.castShadow = true;
      mesh.userData.semanticClass = 'roofSolarPanel';
      layerGroups.buildings.add(mesh);
      if (solarFramePositions.length) {
        const frameGeometry = new THREE.BufferGeometry();
        frameGeometry.setAttribute('position', new THREE.Float32BufferAttribute(solarFramePositions, 3));
        const frames = new THREE.LineSegments(frameGeometry, new THREE.LineBasicMaterial({ color: 0xaab8bb }));
        frames.userData.semanticClass = 'roofSolarPanelFrame';
        layerGroups.buildings.add(frames);
      }
    }

    const facadeBuildings = (data.buildings || []).map(building => {
      const ring = building[2] || [];
      return {
        ring,
        bounds: ring.length ? [
          Math.min(...ring.map(point => point[0])), Math.min(...ring.map(point => point[1])),
          Math.max(...ring.map(point => point[0])), Math.max(...ring.map(point => point[1])),
        ] : [0, 0, 0, 0],
        center: ring.length
          ? ring.reduce((sum, point) => [sum[0] + point[0] / ring.length, sum[1] + point[1] / ring.length], [0, 0])
          : [0, 0],
      };
    });
    const nearestFacade = (x, z, maximumDistance = 6) => {
      let nearest = null;
      let nearestDistanceSq = maximumDistance * maximumDistance;
      for (const building of facadeBuildings) {
        const { ring, bounds, center } = building;
        if (ring.length < 2) continue;
        if (x < bounds[0] - maximumDistance || x > bounds[2] + maximumDistance
          || z < bounds[1] - maximumDistance || z > bounds[3] + maximumDistance) continue;
        for (let index = 0; index < ring.length; index += 1) {
          const [x1, z1] = ring[index], [x2, z2] = ring[(index + 1) % ring.length];
          const dx = x2 - x1, dz = z2 - z1, lengthSq = dx * dx + dz * dz;
          if (lengthSq < 0.01) continue;
          const amount = clamp(((x - x1) * dx + (z - z1) * dz) / lengthSq, 0, 1);
          const px = x1 + dx * amount, pz = z1 + dz * amount;
          const distanceSq = (x - px) ** 2 + (z - pz) ** 2;
          if (distanceSq >= nearestDistanceSq) continue;
          const length = Math.sqrt(lengthSq);
          let nx = -dz / length, nz = dx / length;
          if (nx * (px - center[0]) + nz * (pz - center[1]) < 0) [nx, nz] = [-nx, -nz];
          nearestDistanceSq = distanceSq;
          nearest = { x: px, z: pz, nx, nz, yaw: -Math.atan2(dz, dx) };
        }
      }
      return nearest;
    };
    const entranceFrameMatrices = [];
    const entranceDoorMatrices = [];
    const entranceLightMatrices = [];
    for (const item of (data.installations || []).filter(entry => entry.class === 'buildingEntrance' && entry.coordinates)) {
      const [x, z] = item.coordinates;
      const facade = nearestFacade(x, z);
      const px = facade?.x ?? x, pz = facade?.z ?? z;
      const nx = facade?.nx ?? 0, nz = facade?.nz ?? 1;
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facade?.yaw ?? 0);
      const baseY = terrainHeightAt(px, pz) + 0.16;
      entranceFrameMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(px + nx * 0.08, baseY + 1.3, pz + nz * 0.08),
        quaternion, new THREE.Vector3(1.45, 2.6, 0.18),
      ));
      entranceDoorMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(px + nx * 0.15, baseY + 1.15, pz + nz * 0.15),
        quaternion, new THREE.Vector3(1.08, 2.2, 0.12),
      ));
      entranceLightMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(px + nx * 0.20, baseY + 2.5, pz + nz * 0.20),
        quaternion, new THREE.Vector3(0.28, 0.12, 0.16),
      ));
    }
    const addEntranceInstances = (matrices, material, semanticClass) => {
      if (!matrices.length) return;
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, matrices.length);
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.userData = { semanticClass, maxDistance: 3000 };
      layerGroups.cityFurniture.add(mesh);
    };
    addEntranceInstances(entranceFrameMatrices, new THREE.MeshLambertMaterial({ color: 0x77746d }), 'buildingEntranceFrame');
    addEntranceInstances(entranceDoorMatrices, new THREE.MeshPhongMaterial({ color: 0x26343a, specular: 0x78909a, shininess: 70 }), 'buildingEntranceDoor');
    addEntranceInstances(entranceLightMatrices, new THREE.MeshBasicMaterial({ color: 0xe5cf9d }), 'buildingEntranceLight');

    const wallMatrices = [];
    const fencePostMatrices = [];
    const fenceRailMatrices = [];
    const kerbMatrices = [];
    const segmentMatrix = (start, end, height, thickness, lift = 0) => {
      const [x1, z1] = start, [x2, z2] = end;
      const length = Math.hypot(x2 - x1, z2 - z1);
      const baseY = (terrainHeightAt(x1, z1) + terrainHeightAt(x2, z2)) * 0.5 + 0.16;
      return new THREE.Matrix4().compose(
        new THREE.Vector3((x1 + x2) * 0.5, baseY + lift + height * 0.5, (z1 + z2) * 0.5),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(z2 - z1, x2 - x1)),
        new THREE.Vector3(length, height, thickness),
      );
    };
    for (const item of (data.cityFurniture || []).filter(entry => entry.class?.startsWith('barrier:') && entry.centerline)) {
      const barrier = item.class.slice(8);
      const taggedHeight = Number.parseFloat(item.attributes?.osmTags?.height);
      const height = Number.isFinite(taggedHeight) ? clamp(taggedHeight, 0.1, 8) : (barrier === 'kerb' ? 0.15 : barrier === 'wall' ? 1.8 : 1.35);
      const points = item.centerline;
      for (let index = 0; index < points.length - 1; index += 1) {
        const [x1, z1] = points[index], [x2, z2] = points[index + 1];
        const length = Math.hypot(x2 - x1, z2 - z1);
        const subdivisions = Math.max(1, Math.ceil(length / 4));
        for (let section = 0; section < subdivisions; section += 1) {
          const startAmount = section / subdivisions, endAmount = (section + 1) / subdivisions;
          const start = [x1 + (x2 - x1) * startAmount, z1 + (z2 - z1) * startAmount];
          const end = [x1 + (x2 - x1) * endAmount, z1 + (z2 - z1) * endAmount];
          if (['fence', 'guard_rail', 'chain', 'gate', 'lift_gate', 'entrance'].includes(barrier)) {
            const railHeight = barrier === 'guard_rail' ? 0.75 : height;
            if (barrier !== 'lift_gate') fenceRailMatrices.push(segmentMatrix(start, end, 0.055, 0.055, railHeight * 0.35));
            fenceRailMatrices.push(segmentMatrix(start, end, 0.055, 0.055, railHeight * 0.82));
            const baseY = terrainHeightAt(start[0], start[1]) + 0.16;
            fencePostMatrices.push(new THREE.Matrix4().compose(
              new THREE.Vector3(start[0], baseY + railHeight * 0.5, start[1]),
              new THREE.Quaternion(), new THREE.Vector3(1, railHeight, 1),
            ));
            if (section === subdivisions - 1) {
              const endBaseY = terrainHeightAt(end[0], end[1]) + 0.16;
              fencePostMatrices.push(new THREE.Matrix4().compose(
                new THREE.Vector3(end[0], endBaseY + railHeight * 0.5, end[1]),
                new THREE.Quaternion(), new THREE.Vector3(1, railHeight, 1),
              ));
            }
          } else if (barrier === 'kerb') {
            kerbMatrices.push(segmentMatrix(start, end, height, 0.18));
          } else {
            const thickness = barrier === 'wall' || barrier === 'retaining_wall' ? 0.24 : 0.16;
            wallMatrices.push(segmentMatrix(start, end, height, thickness));
          }
        }
      }
    }
    const addBarrierInstances = (geometry, material, matrices, semanticClass) => {
      if (!matrices.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { semanticClass, maxDistance: 3000 };
      layerGroups.cityFurniture.add(mesh);
    };
    addBarrierInstances(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x777873 }), wallMatrices, 'mappedBarrierWall');
    addBarrierInstances(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x777b79 }), kerbMatrices, 'mappedBarrierKerb');
    addBarrierInstances(new THREE.CylinderGeometry(0.045, 0.055, 1, 6), new THREE.MeshPhongMaterial({ color: 0x545b5b, shininess: 45 }), fencePostMatrices, 'mappedFencePost');
    addBarrierInstances(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhongMaterial({ color: 0x5b6261, shininess: 45 }), fenceRailMatrices, 'mappedFenceRail');
    const barrierPointMatrices = [];
    for (const item of (data.cityFurniture || []).filter(entry => entry.class?.startsWith('barrier:') && entry.coordinates)) {
      const [x, z] = item.coordinates;
      const barrier = item.class.slice(8);
      const isGate = barrier.includes('gate');
      barrierPointMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(x, terrainHeightAt(x, z) + (isGate ? 0.7 : 0.6), z),
        new THREE.Quaternion(), isGate ? new THREE.Vector3(0.22, 1.4, 0.22) : new THREE.Vector3(0.18, 1.2, 0.18),
      ));
    }
    if (barrierPointMatrices.length) {
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhongMaterial({ color: 0x59605f, shininess: 45 }), barrierPointMatrices.length,
      );
      barrierPointMatrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.userData = { semanticClass: 'mappedBarrierPoint', maxDistance: 3000 };
      layerGroups.cityFurniture.add(mesh);
    }
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
    const textureSize = 64;
    const textureData = new Uint8Array(textureSize * textureSize * 4);
    for (let y = 0; y < textureSize; y += 1) {
      for (let x = 0; x < textureSize; x += 1) {
        const index = (y * textureSize + x) * 4;
        const noise = Math.sin(x * 91.73 + y * 37.19 + x * y * 0.17) * 43758.5453;
        const grain = noise - Math.floor(noise);
        const aggregate = grain > 0.975 ? 204 : 231 + Math.round(grain * 16);
        textureData[index] = aggregate;
        textureData[index + 1] = aggregate;
        textureData[index + 2] = aggregate;
        textureData[index + 3] = 255;
      }
    }
    const asphaltTexture = new THREE.DataTexture(textureData, textureSize, textureSize, THREE.RGBAFormat);
    asphaltTexture.wrapS = THREE.RepeatWrapping;
    asphaltTexture.wrapT = THREE.RepeatWrapping;
    asphaltTexture.colorSpace = THREE.SRGBColorSpace;
    asphaltTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    asphaltTexture.needsUpdate = true;
    const positionsByStyle = [[], [], [], [], [], [], [], []];
    const major = new Set(['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link']);
    const secondary = new Set(['secondary', 'secondary_link', 'tertiary']);
    const paths = new Set(['footway', 'path', 'cycleway', 'steps', 'corridor', 'elevator']);
    const offsetPolyline = (points, offset) => points.map(([x, z], index) => {
      const previous = points[Math.max(0, index - 1)], next = points[Math.min(points.length - 1, index + 1)];
      const dx = next[0] - previous[0], dz = next[1] - previous[1];
      const length = Math.hypot(dx, dz) || 1;
      return [x - dz / length * offset, z + dx / length * offset];
    });
    const inferredVerticalOffset = attributes => {
      const explicit = Number(attributes?.inferredVerticalOffsetM);
      if (Number.isFinite(explicit)) return explicit;
      const layer = clamp(Number.parseInt(attributes?.layer || '0', 10) || 0, -5, 5);
      const bridge = attributes?.bridge && attributes.bridge !== 'no';
      const tunnel = attributes?.tunnel && attributes.tunnel !== 'no';
      if (bridge) return Math.max(4.5, Math.max(layer, 1) * 3);
      if (tunnel) return -Math.max(3, Math.abs(Math.min(layer, -1)) * 3);
      return layer * 0.35;
    };
    for (const record of data.roads || []) {
      const [mappedWidth, highway, points] = record;
      // fallback.json stores attributes at index 3; the semantic adapter also
      // carries a source marker and stores them at index 4.
      const attributes = (record[4] && typeof record[4] === 'object')
        ? record[4] : ((record[3] && typeof record[3] === 'object') ? record[3] : {});
      const surface = String(attributes.surface || '').toLowerCase();
      const unsealed = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'earth', 'ground', 'sand', 'compacted']);
      const pavedUnits = new Set(['paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'bricks']);
      const baseStyle = highway === 'pedestrian' ? 4 : paths.has(highway) ? 3 : major.has(highway) ? 1 : secondary.has(highway) ? 2 : 0;
      const styleIndex = baseStyle >= 3 ? baseStyle : unsealed.has(surface) ? 5 : pavedUnits.has(surface) ? 6 : surface === 'concrete' || surface === 'concrete:plates' ? 7 : baseStyle;
      if (points.length > 1) {
        const verticalOffset = inferredVerticalOffset(attributes);
        positionsByStyle[styleIndex].push({
          points,
          width: clamp(Number(mappedWidth) || 4, paths.has(highway) ? 0.8 : 2.5, 18),
          verticalOffset,
          surfaceOffset: ROAD_CLASS_OFFSETS[baseStyle] ?? ROAD_CLASS_OFFSETS[0],
          // Paths < local streets < secondary streets < primary/trunk roads.
          // Keep this even when surface material changes the colour bucket.
          priority: baseStyle >= 3 ? 0 : baseStyle === 1 ? 3 : baseStyle === 2 ? 2 : 1,
        });
        if (!paths.has(highway) && highway !== 'pedestrian') {
          const width = clamp(Number(mappedWidth) || 4, 2.5, 18);
          const sidewalk = String(attributes.sidewalk || '').toLowerCase();
          const left = ['yes', 'both', 'left', 'separate'].includes(sidewalk) || ['yes', 'separate'].includes(String(attributes.sidewalkLeft || '').toLowerCase());
          const right = ['yes', 'both', 'right', 'separate'].includes(sidewalk) || ['yes', 'separate'].includes(String(attributes.sidewalkRight || '').toLowerCase());
          const separation = width * 0.5 + 1.05;
          if (left) positionsByStyle[3].push({ points: offsetPolyline(points, separation), width: 1.55, verticalOffset: verticalOffset + 0.02, priority: 0 });
          if (right) positionsByStyle[3].push({ points: offsetPolyline(points, -separation), width: 1.55, verticalOffset: verticalOffset + 0.02, priority: 0 });
        }
      }
    }
    const colors = [COLORS.road, COLORS.roadMajor, COLORS.roadSecondary, COLORS.path, COLORS.pedestrian, 0x716b5e, 0x77756e, 0x747a7a];
    // Higher-priority carriageways sit a few centimetres above lower classes
    // at overlaps. Footways remain contextual and below carriageways so they
    // cannot slice a visible road into disconnected pieces at junctions.
    const buildRibbon = (roads, styleIndex, priority, gradeSeparated, outer = false) => {
      const vertices = [];
      const uvs = [];
      const indices = [];
      const pushVertex = (x, z, elevationOffset, surfaceY = roadTerrainHeightAt(x, z)) => {
        const index = vertices.length / 3;
        vertices.push(x, surfaceY + elevationOffset, z);
        uvs.push(x / 12, z / 12);
        return index;
      };
      const addDisc = (x, z, radius, elevationOffset) => {
        const surfaceY = roadTerrainHeightAt(x, z);
        const center = pushVertex(x, z, elevationOffset, surfaceY);
        const segments = 12;
        for (let segment = 0; segment < segments; segment += 1) {
          const angle = segment / segments * Math.PI * 2;
          pushVertex(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius, elevationOffset, surfaceY);
        }
        for (let segment = 0; segment < segments; segment += 1) {
          indices.push(center, center + 1 + segment, center + 1 + ((segment + 1) % segments));
        }
      };
      for (const road of roads) {
        const halfWidth = road.width * 0.5 + (outer ? ([3, 4].includes(styleIndex) ? 0.24 : 0.48) : 0);
        const elevationOffset = (road.surfaceOffset ?? ROAD_CLASS_OFFSETS[styleIndex] ?? 0.26)
          + (road.verticalOffset || 0) + (outer ? -0.10 : 0);
        const cleanPoints = road.points.filter(([x, z], index, points) => (
          Number.isFinite(x) && Number.isFinite(z)
          && (!index || Math.hypot(x - points[index - 1][0], z - points[index - 1][1]) > 0.05)
        ));
        let segmentCount = 0;
        for (let index = 0; index < cleanPoints.length - 1; index += 1) {
          const [x1, z1] = cleanPoints[index];
          const [x2, z2] = cleanPoints[index + 1];
          const dx = x2 - x1;
          const dz = z2 - z1;
          const length = Math.hypot(dx, dz);
          if (length <= 0.05) continue;
          const nx = -dz / length * halfWidth;
          const nz = dx / length * halfWidth;
          // Long source segments used to bridge over terrain undulations as
          // one flat quad. Subdivide them so roads, paths and surface paint
          // all follow the same terrain samples at close zoom.
          const subdivisions = Math.max(1, Math.ceil(length / 4));
          for (let section = 0; section < subdivisions; section += 1) {
            const startAmount = section / subdivisions;
            const endAmount = (section + 1) / subdivisions;
            const sx = x1 + dx * startAmount;
            const sz = z1 + dz * startAmount;
            const ex = x1 + dx * endAmount;
            const ez = z1 + dz * endAmount;
            const startY = roadTerrainHeightAt(sx, sz);
            const endY = roadTerrainHeightAt(ex, ez);
            const a = pushVertex(sx + nx, sz + nz, elevationOffset, startY);
            const b = pushVertex(sx - nx, sz - nz, elevationOffset, startY);
            const c = pushVertex(ex + nx, ez + nz, elevationOffset, endY);
            const d = pushVertex(ex - nx, ez - nz, elevationOffset, endY);
            indices.push(a, b, c, b, d, c);
            segmentCount += 1;
          }
        }
        if (segmentCount) {
          // A strip based on averaged vertex normals can fold over itself at
          // a hairpin or duplicate survey vertex, producing block-sized
          // triangles. Independent quads plus bounded round joins cannot
          // escape the road width and also close split-centreline junctions.
          for (const [x, z] of cleanPoints) addDisc(x, z, halfWidth, elevationOffset);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const material = new THREE.MeshBasicMaterial({
        color: outer ? 0x2c2f2e : colors[styleIndex],
        map: !outer && styleIndex <= 2 ? asphaltTexture : null,
        transparent: false,
        opacity: 1,
        // At-grade road classes use the explicit painter hierarchy and do not
        // mask one another. Bridges keep depth writes so their real elevation
        // still wins over any higher-priority street passing underneath.
        depthWrite: gradeSeparated,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: outer ? -1 : -3,
        polygonOffsetUnits: outer ? -1 : -3,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // Stay below mapped parking/crossing paint (orders 6 and 8) while still
      // preserving fine-grained ordering among the four network tiers.
      mesh.renderOrder = 2 + priority * 0.2 + (outer ? 0 : 0.1);
      return mesh;
    };
    positionsByStyle.forEach((roads, index) => {
      if (!roads.length) return;
      const target = index === 3 || index === 4 ? layerGroups.paths : layerGroups.roads;
      for (let priority = 0; priority <= 3; priority += 1) {
        const tier = roads.filter(road => road.priority === priority);
        for (const gradeSeparated of [false, true]) {
          const grade = tier.filter(road => (Math.abs(road.verticalOffset || 0) > 1) === gradeSeparated);
          if (!grade.length) continue;
          target.add(buildRibbon(grade, index, priority, gradeSeparated, true));
          target.add(buildRibbon(grade, index, priority, gradeSeparated, false));
        }
      }
    });
  }

  function makeRailways() {
    const railPositions = [];
    const sleeperPositions = [];
    const gaugeHalfWidth = 0.62;
    const sleeperHalfWidth = 1.08;
    const sleeperSpacing = 4.8;
    for (const record of data.railways || []) {
      const [, points, attributes = {}] = record;
      const explicitOffset = Number(attributes.inferredVerticalOffsetM);
      const layer = clamp(Number.parseInt(attributes.layer || '0', 10) || 0, -5, 5);
      const bridge = attributes.bridge && attributes.bridge !== 'no';
      const tunnel = attributes.tunnel && attributes.tunnel !== 'no';
      const verticalOffset = Number.isFinite(explicitOffset)
        ? explicitOffset
        : bridge ? Math.max(4.5, Math.max(layer, 1) * 3)
          : tunnel ? -Math.max(3, Math.abs(Math.min(layer, -1)) * 3) : layer * 0.35;
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
            railX1, terrainHeightAt(railX1, railZ1) + verticalOffset + 0.20, railZ1,
            railX2, terrainHeightAt(railX2, railZ2) + verticalOffset + 0.20, railZ2,
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
            leftX, terrainHeightAt(leftX, leftZ) + verticalOffset + 0.15, leftZ,
            rightX, terrainHeightAt(rightX, rightZ) + verticalOffset + 0.15, rightZ,
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

  function makeStreetFurniture() {
    const group = layerGroups.cityFurniture;
    const matrix = new THREE.Matrix4();
    const makeInstances = (geometry, material, matrices, semanticClass) => {
      if (!matrices.length) return null;
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((instanceMatrix, index) => mesh.setMatrixAt(index, instanceMatrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = !['parkingSpace', 'pedestrianCrossing'].includes(semanticClass);
      mesh.receiveShadow = true;
      mesh.userData.semanticClass = semanticClass;
      mesh.userData.maxDistance = ['parkingSpace', 'pedestrianCrossing', 'daisyPetals', 'daisyCentres', 'daisyZebraBands'].includes(semanticClass)
        ? 720
        : semanticClass.startsWith('publicLight') ? 1000
          : ['fountain', 'bench', 'wasteBasket', 'bicycleParking', 'streetClock', 'bollard', 'busStop'].some(value => semanticClass.startsWith(value)) ? 850 : null;
      if (semanticClass === 'parkingSpace') mesh.renderOrder = 6;
      if (['pedestrianCrossing', 'daisyPetals', 'daisyCentres', 'daisyZebraBands'].includes(semanticClass)) mesh.renderOrder = 8;
      group.add(mesh);
      return mesh;
    };
    const composeMatrix = (position, quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1)) => (
      new THREE.Matrix4().compose(position, quaternion, scale)
    );
    const segmentMatrix = (start, end) => {
      const direction = end.clone().sub(start);
      const midpoint = start.clone().add(end).multiplyScalar(0.5);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
      return composeMatrix(midpoint, quaternion, new THREE.Vector3(1, direction.length(), 1));
    };

    // South African municipal lighting inventories commonly describe the
    // support rather than pole height. These conservative values are inferred
    // from support type and wattage and remain tagged as inferred, not survey.
    const publicLights = (data.cityFurniture || []).filter(item => item.class === 'publicLight' && item.coordinates);
    const poleMatrices = [], armMatrices = [], headMatrices = [], lampMatrices = [], lampGlowPositions = [];
    for (const item of publicLights) {
      const [x, z] = item.coordinates;
      const baseY = terrainHeightAt(x, z) + 0.18;
      const support = String(item.attributes?.FixtureSupport || '').toLowerCase();
      const rawWattage = Number(item.attributes?.Wattage);
      const wattage = rawWattage > 0 ? rawWattage : 150;
      const highMast = support.includes('high mast');
      const postTop = support.includes('post top') || support.includes('top entry');
      const flood = support.includes('flood');
      const doubleFixture = support.includes('double') || Number(item.attributes?.LightCount) > 1;
      let height = Number(item.attributes?.inferredHeightM) || (highMast ? 18 : wattage <= 80 ? 6 : wattage <= 150 ? 8 : wattage <= 250 ? 10 : 12);
      if (postTop) height = Math.min(height, 8);
      const yaw = THREE.MathUtils.degToRad(Number(item.attributes?.roadFacingDeg) || 0);
      const directions = doubleFixture ? [yaw, yaw + Math.PI] : [yaw];
      poleMatrices.push(composeMatrix(
        new THREE.Vector3(x, baseY + height * 0.5, z),
        new THREE.Quaternion(),
        new THREE.Vector3(highMast ? 1.55 : 1, height, highMast ? 1.55 : 1),
      ));
      for (const direction of directions) {
        const outward = new THREE.Vector3(Math.cos(direction), 0, Math.sin(direction));
        const top = new THREE.Vector3(x, baseY + height, z);
        let lampPosition;
        if (postTop) {
          lampPosition = top.clone().add(new THREE.Vector3(0, 0.22, 0));
        } else {
          const outreach = highMast ? 2.3 : support.includes('whip') ? 1.8 : 1.25;
          const shoulder = top.clone().add(outward.clone().multiplyScalar(outreach * 0.45)).add(new THREE.Vector3(0, support.includes('whip') ? 0.55 : 0.12, 0));
          lampPosition = top.clone().add(outward.clone().multiplyScalar(outreach)).add(new THREE.Vector3(0, support.includes('whip') ? 0.38 : 0.04, 0));
          armMatrices.push(segmentMatrix(top, shoulder), segmentMatrix(shoulder, lampPosition));
        }
        const headQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -direction);
        headMatrices.push(composeMatrix(
          lampPosition.clone().add(new THREE.Vector3(0, -0.05, 0)),
          headQuaternion,
          postTop ? new THREE.Vector3(0.34, 0.5, 0.34) : flood ? new THREE.Vector3(0.48, 0.22, 0.62) : new THREE.Vector3(0.62, 0.17, 0.28),
        ));
        const bulbPosition = lampPosition.clone().add(new THREE.Vector3(0, -0.16, 0));
        lampMatrices.push(composeMatrix(bulbPosition, headQuaternion));
        lampGlowPositions.push(bulbPosition);
      }
    }
    const galvanized = new THREE.MeshLambertMaterial({ color: 0x8c9698 });
    makeInstances(new THREE.CylinderGeometry(0.065, 0.14, 1, 8), galvanized, poleMatrices, 'publicLightPole');
    makeInstances(new THREE.CylinderGeometry(0.045, 0.055, 1, 7), galvanized, armMatrices, 'publicLightArm');
    makeInstances(new THREE.SphereGeometry(0.5, 10, 6), new THREE.MeshLambertMaterial({ color: 0x596164 }), headMatrices, 'publicLightFixture');
    nightLighting.streetBulbMaterial = new THREE.MeshBasicMaterial({ color: 0xd8c9a8 });
    makeInstances(new THREE.SphereGeometry(0.09, 8, 6), nightLighting.streetBulbMaterial, lampMatrices, 'publicLightLamp');

    if (lampGlowPositions.length) {
      const glowCanvas = document.createElement('canvas');
      glowCanvas.width = glowCanvas.height = 64;
      const glowContext = glowCanvas.getContext('2d');
      const gradient = glowContext.createRadialGradient(32, 32, 2, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(255,247,205,1)');
      gradient.addColorStop(0.2, 'rgba(255,205,120,0.72)');
      gradient.addColorStop(1, 'rgba(255,172,72,0)');
      glowContext.fillStyle = gradient;
      glowContext.fillRect(0, 0, 64, 64);
      const glowGeometry = new THREE.BufferGeometry().setFromPoints(lampGlowPositions);
      const glowMaterial = new THREE.PointsMaterial({
        map: new THREE.CanvasTexture(glowCanvas), color: 0xffd28a, size: 1.55,
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      const glow = new THREE.Points(glowGeometry, glowMaterial);
      glow.userData = { semanticClass: 'publicLightGlow', maxDistance: 1000 };
      glow.renderOrder = 9;
      group.add(glow);
      nightLighting.streetGlow = glow;
    }

    const yawQuaternion = degrees => new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), -THREE.MathUtils.degToRad(Number(degrees) || 0),
    );
    const offsetOnRoad = (centre, bearing, along, across) => {
      const angle = THREE.MathUtils.degToRad(Number(bearing) || 0);
      return [
        centre[0] + Math.cos(angle) * along - Math.sin(angle) * across,
        centre[1] + Math.sin(angle) * along + Math.cos(angle) * across,
      ];
    };
    const majorRoadTypes = new Set(['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link']);
    const secondaryRoadTypes = new Set(['secondary', 'secondary_link', 'tertiary']);
    const nonCarriagewayTypes = new Set(['footway', 'path', 'cycleway', 'steps', 'corridor', 'elevator', 'pedestrian']);
    const roadFamily = highway => majorRoadTypes.has(highway) ? 'major' : secondaryRoadTypes.has(highway) ? 'secondary' : 'local';
    const roadSurfaceOffset = highway => majorRoadTypes.has(highway)
      ? ROAD_CLASS_OFFSETS[1]
      : secondaryRoadTypes.has(highway) ? ROAD_CLASS_OFFSETS[2] : ROAD_CLASS_OFFSETS[0];
    const renderedRoadSegments = [];
    for (const [mappedWidth, highway, points] of data.roads || []) {
      if (nonCarriagewayTypes.has(highway)) continue;
      const width = clamp(Number(mappedWidth) || 4, 2.5, 18);
      for (let index = 0; index < points.length - 1; index += 1) {
        const [ax, az] = points[index];
        const [bx, bz] = points[index + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const length = Math.hypot(dx, dz);
        if (length < 0.2) continue;
        renderedRoadSegments.push({ ax, az, bx, bz, dx, dz, length, width, highway });
      }
    }
    const nearestOnSegment = (point, segment) => {
      const amount = clamp(
        ((point[0] - segment.ax) * segment.dx + (point[1] - segment.az) * segment.dz) / (segment.length * segment.length),
        0,
        1,
      );
      const x = segment.ax + segment.dx * amount;
      const z = segment.az + segment.dz * amount;
      return { x, z, distance: Math.hypot(point[0] - x, point[1] - z) };
    };
    const visibleRoadFrame = (centre, fallbackBearing, fallbackWidth) => {
      const fallbackAngle = THREE.MathUtils.degToRad(Number(fallbackBearing) || 0);
      const fallbackTangent = [Math.cos(fallbackAngle), Math.sin(fallbackAngle)];
      const nearby = [];
      for (const segment of renderedRoadSegments) {
        const nearest = nearestOnSegment(centre, segment);
        if (nearest.distance > 22) continue;
        let tangent = [segment.dx / segment.length, segment.dz / segment.length];
        let dot = tangent[0] * fallbackTangent[0] + tangent[1] * fallbackTangent[1];
        if (dot < 0) {
          tangent = [-tangent[0], -tangent[1]];
          dot = -dot;
        }
        if (dot < Math.cos(THREE.MathUtils.degToRad(35))) continue;
        nearby.push({ segment, nearest, tangent, alignment: dot });
      }
      if (!nearby.length) {
        return {
          centre, bearing: fallbackBearing, width: fallbackWidth,
          surfaceOffset: ROAD_CLASS_OFFSETS[0] + 0.015,
        };
      }
      const best = nearby.reduce((selected, candidate) => {
        const score = candidate.nearest.distance + (1 - candidate.alignment) * 14;
        return !selected || score < selected.score ? { ...candidate, score } : selected;
      }, null);
      const family = roadFamily(best.segment.highway);
      const matched = nearby.filter(candidate => (
        roadFamily(candidate.segment.highway) === family
        && candidate.nearest.distance <= 18
        && Math.abs(candidate.tangent[0] * best.tangent[0] + candidate.tangent[1] * best.tangent[1]) >= Math.cos(THREE.MathUtils.degToRad(22))
      ));
      let tangentX = 0;
      let tangentZ = 0;
      for (const candidate of matched) {
        const weight = 1 / (1 + candidate.nearest.distance);
        let [tx, tz] = candidate.tangent;
        if (tx * best.tangent[0] + tz * best.tangent[1] < 0) [tx, tz] = [-tx, -tz];
        tangentX += tx * weight;
        tangentZ += tz * weight;
      }
      const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
      tangentX /= tangentLength;
      tangentZ /= tangentLength;
      const normalX = -tangentZ;
      const normalZ = tangentX;
      let minimumEdge = Infinity;
      let maximumEdge = -Infinity;
      for (const candidate of matched) {
        const offset = (candidate.nearest.x - centre[0]) * normalX + (candidate.nearest.z - centre[1]) * normalZ;
        minimumEdge = Math.min(minimumEdge, offset - candidate.segment.width * 0.5);
        maximumEdge = Math.max(maximumEdge, offset + candidate.segment.width * 0.5);
      }
      const measuredWidth = maximumEdge - minimumEdge;
      const width = clamp(Math.max(Number(fallbackWidth) || 5, measuredWidth), 5, 34);
      const centreOffset = Number.isFinite(minimumEdge + maximumEdge) ? (minimumEdge + maximumEdge) * 0.5 : 0;
      return {
        centre: [centre[0] + normalX * centreOffset, centre[1] + normalZ * centreOffset],
        bearing: THREE.MathUtils.radToDeg(Math.atan2(tangentZ, tangentX)),
        width,
        surfaceOffset: roadSurfaceOffset(best.segment.highway) + 0.015,
      };
    };

    // Assemble point bays into straight curbside runs. Each run shares its two
    // long edges and dividers, eliminating stacked boxes and slight rotations
    // between records that belong to the same row.
    const parkingMatrices = [];
    const parkingGroups = new Map();
    for (const item of data.parking || []) {
      if (!item.coordinates) continue;
      const rawBearing = Number(item.attributes?.roadBearingDeg) || 0;
      const normalizedBearing = ((rawBearing + 90) % 180 + 180) % 180 - 90;
      const bearing = Math.round(normalizedBearing / 10) * 10;
      const angle = THREE.MathUtils.degToRad(bearing);
      const tangent = [Math.cos(angle), Math.sin(angle)];
      const normal = [-tangent[1], tangent[0]];
      const roadCentre = item.attributes?.roadCentre || item.coordinates;
      const sideAmount = (item.coordinates[0] - roadCentre[0]) * normal[0] + (item.coordinates[1] - roadCentre[1]) * normal[1];
      const side = sideAmount < 0 ? -1 : 1;
      const roadKey = item.attributes?.roadName || item.attributes?.roadFeatureId || 'unknown-road';
      const key = `${roadKey}:${bearing}:${side}`;
      if (!parkingGroups.has(key)) parkingGroups.set(key, { bearing, tangent, normal, items: [] });
      parkingGroups.get(key).items.push({
        along: item.coordinates[0] * tangent[0] + item.coordinates[1] * tangent[1],
        across: item.coordinates[0] * normal[0] + item.coordinates[1] * normal[1],
      });
    }
    for (const parkingGroup of parkingGroups.values()) {
      const sorted = parkingGroup.items.sort((a, b) => a.along - b.along);
      const runs = [];
      for (const item of sorted) {
        const run = runs.at(-1);
        if (!run || item.along - run.at(-1).along > 8.2) runs.push([item]);
        else run.push(item);
      }
      for (const sourceRun of runs) {
        const run = [];
        for (const item of sourceRun) {
          if (!run.length || item.along - run.at(-1).along >= 3.4) run.push(item);
        }
        if (!run.length) continue;
        const count = run.length;
        const alongCentre = run.reduce((sum, item) => sum + item.along, 0) / count;
        const acrossValues = run.map(item => item.across).sort((a, b) => a - b);
        const acrossCentre = acrossValues[Math.floor(acrossValues.length / 2)];
        const centre = [
          parkingGroup.tangent[0] * alongCentre + parkingGroup.normal[0] * acrossCentre,
          parkingGroup.tangent[1] * alongCentre + parkingGroup.normal[1] * acrossCentre,
        ];
        const bearing = parkingGroup.bearing;
        const quaternion = yawQuaternion(bearing);
        const runLength = count * 5.2;
        for (const across of [-1.2, 1.2]) {
          const [x, z] = offsetOnRoad(centre, bearing, 0, across);
          parkingMatrices.push(composeMatrix(
            new THREE.Vector3(x, terrainHeightAt(x, z) + 0.61, z), quaternion,
            new THREE.Vector3(runLength, 1, 0.085),
          ));
        }
        for (let divider = 0; divider <= count; divider += 1) {
          const along = -runLength * 0.5 + divider * 5.2;
          const [x, z] = offsetOnRoad(centre, bearing, along, 0);
          parkingMatrices.push(composeMatrix(
            new THREE.Vector3(x, terrainHeightAt(x, z) + 0.61, z), quaternion,
            new THREE.Vector3(0.085, 1, 2.4),
          ));
        }
      }
    }
    makeInstances(
      new THREE.BoxGeometry(1, 0.035, 1),
      new THREE.MeshBasicMaterial({
        color: 0x879294, transparent: true, opacity: 0.42, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -6,
      }),
      parkingMatrices,
      'parkingSpace',
    );

    const crossingItems = [];
    for (const item of (data.crossings || []).filter(entry => entry.attributes?.crossingDesign !== 'coveredByDaisyInstallation')) {
      if (item.attributes?.crossingDesign === 'daisy') {
        crossingItems.push(item);
        continue;
      }
      const attributes = item.attributes || {};
      const centre = attributes.roadCentre || item.coordinates;
      const bearing = ((Number(attributes.roadBearingDeg) || 0) % 180 + 180) % 180;
      const roadKey = attributes.roadName || attributes.roadFeatureId;
      const duplicate = crossingItems.some(existing => {
        if (existing.attributes?.crossingDesign === 'daisy') return false;
        const existingAttributes = existing.attributes || {};
        if ((existingAttributes.roadName || existingAttributes.roadFeatureId) !== roadKey) return false;
        const existingCentre = existingAttributes.roadCentre || existing.coordinates;
        const existingBearing = ((Number(existingAttributes.roadBearingDeg) || 0) % 180 + 180) % 180;
        const bearingDifference = Math.min(Math.abs(bearing - existingBearing), 180 - Math.abs(bearing - existingBearing));
        return Math.hypot(centre[0] - existingCentre[0], centre[1] - existingCentre[1]) <= 10 && bearingDifference <= 18;
      });
      if (!duplicate) crossingItems.push(item);
    }
    const zebraMarkings = [];
    // Road ribbons top out at +0.42 m. Each marking corner is independently
    // draped at +0.57 m so slopes cannot push part of a crossing under a road.
    const crossingSurfaceOffset = 0.57;
    const addZebraBand = (centre, bearing, roadWidth, alongOffset = 0, surfaceOffset = crossingSurfaceOffset) => {
      const stripeCount = Math.max(5, Math.floor(roadWidth / 1.05));
      const spacing = roadWidth / stripeCount;
      for (let stripe = 0; stripe < stripeCount; stripe += 1) {
        const across = -roadWidth * 0.5 + spacing * (stripe + 0.5);
        zebraMarkings.push({ centre, bearing, along: alongOffset, across, halfAlong: 1.6, halfAcross: spacing * 0.29, surfaceOffset });
      }
    };
    const crossingPaint = 0xaeb2ad;
    const makeCrossingMesh = (markings, semanticClass, surfaceOffset = crossingSurfaceOffset) => {
      if (!markings.length) return null;
      const positions = [];
      for (const marking of markings) {
        const alongDivisions = Math.max(1, Math.ceil(marking.halfAlong * 2 / 0.4));
        const acrossDivisions = Math.max(1, Math.ceil(marking.halfAcross * 2 / 0.3));
        const pointAt = (alongIndex, acrossIndex) => {
          const along = marking.along - marking.halfAlong + marking.halfAlong * 2 * alongIndex / alongDivisions;
          const across = marking.across - marking.halfAcross + marking.halfAcross * 2 * acrossIndex / acrossDivisions;
          const [x, z] = offsetOnRoad(marking.centre, marking.bearing, along, across);
          const [centreX, centreZ] = offsetOnRoad(marking.centre, marking.bearing, along, 0);
          return [x, roadTerrainHeightAt(centreX, centreZ) + (marking.surfaceOffset ?? surfaceOffset), z];
        };
        for (let alongIndex = 0; alongIndex < alongDivisions; alongIndex += 1) {
          for (let acrossIndex = 0; acrossIndex < acrossDivisions; acrossIndex += 1) {
            const a = pointAt(alongIndex, acrossIndex);
            const b = pointAt(alongIndex + 1, acrossIndex);
            const c = pointAt(alongIndex + 1, acrossIndex + 1);
            const d = pointAt(alongIndex, acrossIndex + 1);
            positions.push(...a, ...b, ...c, ...a, ...c, ...d);
          }
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: crossingPaint, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
      }));
      mesh.renderOrder = 8;
      mesh.userData.semanticClass = semanticClass;
      mesh.userData.maxDistance = 720;
      group.add(mesh);
      return mesh;
    };
    const makeDrapedEllipses = (ellipses, color, semanticClass, surfaceOffset) => {
      if (!ellipses.length) return null;
      const positions = [];
      const segments = 12;
      for (const ellipse of ellipses) {
        const surfaceY = roadTerrainHeightAt(ellipse.x, ellipse.z) + surfaceOffset;
        const centre = [ellipse.x, surfaceY, ellipse.z];
        const perimeter = [];
        for (let segment = 0; segment < segments; segment += 1) {
          const angle = segment / segments * Math.PI * 2;
          const localLong = Math.cos(angle) * ellipse.longRadius;
          const localShort = Math.sin(angle) * ellipse.shortRadius;
          const x = ellipse.x + Math.cos(ellipse.rotation) * localLong - Math.sin(ellipse.rotation) * localShort;
          const z = ellipse.z + Math.sin(ellipse.rotation) * localLong + Math.cos(ellipse.rotation) * localShort;
          perimeter.push([x, surfaceY, z]);
        }
        for (let segment = 0; segment < segments; segment += 1) {
          positions.push(...centre, ...perimeter[segment], ...perimeter[(segment + 1) % segments]);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
      }));
      mesh.renderOrder = 8;
      mesh.userData.semanticClass = semanticClass;
      mesh.userData.maxDistance = 720;
      group.add(mesh);
      return mesh;
    };
    const daisyItems = [];
    for (const item of crossingItems) {
      const attributes = item.attributes || {};
      const frame = visibleRoadFrame(
        attributes.roadCentre || item.coordinates,
        attributes.roadBearingDeg || 0,
        Number(attributes.roadWidthM) || 8,
      );
      if (attributes.crossingDesign === 'daisy') {
        daisyItems.push({ item, ...frame });
      } else {
        addZebraBand(frame.centre, frame.bearing, frame.width, 0, frame.surfaceOffset);
      }
    }
    const conventionalZebraCount = zebraMarkings.length;
    makeCrossingMesh(zebraMarkings, 'pedestrianCrossing');

    // The St George's Mall / Strand Street installation has two zebra bands
    // framing a field of variable African daisies, following the supplied photo.
    for (const { centre, width, bearing, surfaceOffset } of daisyItems) {
      const daisySurfaceOffset = surfaceOffset + 0.008;
      addZebraBand(centre, bearing, width, -7.1, daisySurfaceOffset);
      addZebraBand(centre, bearing, width, 7.1, daisySurfaceOffset);
      const petals = [], flowerCentres = [];
      const motifs = [
        [-4.4, -0.34, 0.95], [-4.2, 0.02, 0.48], [-4.0, 0.35, 0.78],
        [-2.0, -0.12, 0.58], [-1.8, 0.27, 1.02], [-0.5, -0.38, 0.72],
        [0.1, 0.02, 1.08], [0.5, 0.38, 0.52], [2.1, -0.27, 0.98],
        [2.3, 0.15, 0.62], [4.2, -0.02, 0.55], [4.4, 0.34, 0.9],
      ];
      for (const [along, acrossFactor, radius] of motifs) {
        const [cx, cz] = offsetOnRoad(centre, bearing, along, acrossFactor * width);
        flowerCentres.push({ x: cx, z: cz, longRadius: radius * 0.27, shortRadius: radius * 0.27, rotation: 0 });
        for (let petal = 0; petal < 12; petal += 1) {
          const angle = petal / 12 * Math.PI * 2 + THREE.MathUtils.degToRad(bearing);
          const px = cx + Math.cos(angle) * radius * 0.56;
          const pz = cz + Math.sin(angle) * radius * 0.56;
          petals.push({
            x: px, z: pz, longRadius: radius * 0.68,
            shortRadius: radius * 0.31, rotation: angle,
          });
        }
      }
      makeDrapedEllipses(petals, 0xb7bab4, 'daisyPetals', daisySurfaceOffset);
      makeDrapedEllipses(flowerCentres, 0xd49b32, 'daisyCentres', daisySurfaceOffset + 0.008);
    }
    // Daisy zebra bands are added after the first zebra mesh was built.
    if (daisyItems.length) {
      makeCrossingMesh(zebraMarkings.slice(conventionalZebraCount), 'daisyZebraBands');
    }

    // OSM point amenities carry reliable mapped positions but usually no
    // dimensions or orientation. Repeated procedural models keep the draw
    // count low and visibly distinguish each useful street-level class while
    // the semantic model honestly records the dimensions as inferred.
    const osmFurniture = data.cityFurniture || [];
    const deterministicYaw = (x, z) => ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1) * Math.PI;
    const furnitureMaterial = new THREE.MeshLambertMaterial({ color: 0x667477 });
    const darkFurnitureMaterial = new THREE.MeshLambertMaterial({ color: 0x303a3d });
    const timberMaterial = new THREE.MeshLambertMaterial({ color: 0x8a6543 });

    const benches = osmFurniture.filter(item => item.class === 'bench' && item.coordinates);
    const benchSeats = [], benchBacks = [], benchLegs = [];
    for (const item of benches) {
      const [x, z] = item.coordinates;
      const y = terrainHeightAt(x, z) + 0.2;
      const yaw = deterministicYaw(x, z);
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      benchSeats.push(composeMatrix(new THREE.Vector3(x, y + 0.56, z), quaternion, new THREE.Vector3(1.9, 0.12, 0.55)));
      benchBacks.push(composeMatrix(
        new THREE.Vector3(x + Math.sin(yaw) * 0.23, y + 0.98, z - Math.cos(yaw) * 0.23),
        quaternion,
        new THREE.Vector3(1.9, 0.68, 0.09),
      ));
      for (const dx of [-0.68, 0.68]) benchLegs.push(composeMatrix(
        new THREE.Vector3(x + Math.cos(yaw) * dx, y + 0.28, z + Math.sin(yaw) * dx),
        quaternion,
        new THREE.Vector3(0.1, 0.55, 0.42),
      ));
    }
    makeInstances(new THREE.BoxGeometry(1, 1, 1), timberMaterial, benchSeats, 'benchSeat');
    makeInstances(new THREE.BoxGeometry(1, 1, 1), timberMaterial, benchBacks, 'benchBack');
    makeInstances(new THREE.BoxGeometry(1, 1, 1), darkFurnitureMaterial, benchLegs, 'benchLeg');

    const bins = osmFurniture.filter(item => item.class === 'wasteBasket' && item.coordinates);
    const binMatrices = bins.map(item => {
      const [x, z] = item.coordinates;
      return composeMatrix(new THREE.Vector3(x, terrainHeightAt(x, z) + 0.67, z));
    });
    makeInstances(new THREE.CylinderGeometry(0.32, 0.27, 0.9, 10), darkFurnitureMaterial, binMatrices, 'wasteBasket');

    const bollards = osmFurniture.filter(item => item.class === 'bollard' && item.coordinates);
    const bollardMatrices = bollards.map(item => {
      const [x, z] = item.coordinates;
      return composeMatrix(new THREE.Vector3(x, terrainHeightAt(x, z) + 0.58, z));
    });
    makeInstances(new THREE.CylinderGeometry(0.11, 0.14, 0.8, 10), furnitureMaterial, bollardMatrices, 'bollard');

    const bicycleParking = osmFurniture.filter(item => item.class === 'bicycleParking' && item.coordinates);
    const bicycleRackMatrices = [];
    for (const item of bicycleParking) {
      const [x, z] = item.coordinates;
      const yaw = deterministicYaw(x, z);
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      for (const offset of [-0.85, 0, 0.85]) {
        bicycleRackMatrices.push(composeMatrix(
          new THREE.Vector3(x + Math.cos(yaw) * offset, terrainHeightAt(x, z) + 0.85, z + Math.sin(yaw) * offset),
          quaternion,
          new THREE.Vector3(0.72, 1, 1),
        ));
      }
    }
    makeInstances(new THREE.TorusGeometry(0.56, 0.055, 6, 12), furnitureMaterial, bicycleRackMatrices, 'bicycleParkingRack');

    const fountains = osmFurniture.filter(item => item.class === 'fountain' && item.coordinates);
    const fountainBases = [], fountainBowls = [], fountainWater = [], fountainJets = [];
    for (const item of fountains) {
      const [x, z] = item.coordinates;
      const y = terrainHeightAt(x, z) + 0.18;
      fountainBases.push(composeMatrix(new THREE.Vector3(x, y + 0.24, z)));
      fountainBowls.push(composeMatrix(new THREE.Vector3(x, y + 0.5, z)));
      fountainWater.push(composeMatrix(new THREE.Vector3(x, y + 0.62, z)));
      fountainJets.push(composeMatrix(new THREE.Vector3(x, y + 1.02, z)));
    }
    makeInstances(new THREE.CylinderGeometry(1.8, 2.05, 0.48, 24), new THREE.MeshLambertMaterial({ color: 0x8b918d }), fountainBases, 'fountainBase');
    makeInstances(new THREE.CylinderGeometry(1.55, 1.7, 0.24, 24, 1, true), new THREE.MeshLambertMaterial({ color: 0xa1a6a0, side: THREE.DoubleSide }), fountainBowls, 'fountainBowl');
    makeInstances(new THREE.CylinderGeometry(1.52, 1.52, 0.025, 24), new THREE.MeshLambertMaterial({ color: 0x4d9db3, transparent: true, opacity: 0.72 }), fountainWater, 'fountainWater');
    makeInstances(new THREE.CylinderGeometry(0.025, 0.045, 0.8, 6), new THREE.MeshBasicMaterial({ color: 0xa9e5f3, transparent: true, opacity: 0.8 }), fountainJets, 'fountainJet');

    const busStops = osmFurniture.filter(item => item.class === 'busStop' && item.coordinates);
    const busStopPoles = [], busStopSigns = [];
    for (const item of busStops) {
      const [x, z] = item.coordinates;
      const y = terrainHeightAt(x, z) + 0.18;
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deterministicYaw(x, z));
      busStopPoles.push(composeMatrix(new THREE.Vector3(x, y + 1.45, z)));
      busStopSigns.push(composeMatrix(new THREE.Vector3(x, y + 2.55, z), quaternion));
    }
    makeInstances(new THREE.CylinderGeometry(0.045, 0.07, 2.9, 7), furnitureMaterial, busStopPoles, 'busStopPole');
    makeInstances(new THREE.BoxGeometry(0.62, 0.72, 0.08), new THREE.MeshLambertMaterial({ color: 0x2475a9 }), busStopSigns, 'busStopSign');

    const streetClocks = osmFurniture.filter(item => item.class === 'streetClock' && item.coordinates);
    const clockPoles = [], clockFaces = [];
    for (const item of streetClocks) {
      const [x, z] = item.coordinates;
      const y = terrainHeightAt(x, z) + 0.18;
      clockPoles.push(composeMatrix(new THREE.Vector3(x, y + 1.5, z)));
      const faceRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, deterministicYaw(x, z), 0));
      clockFaces.push(composeMatrix(new THREE.Vector3(x, y + 3.05, z), faceRotation));
    }
    makeInstances(new THREE.CylinderGeometry(0.055, 0.1, 3.0, 8), darkFurnitureMaterial, clockPoles, 'streetClockPole');
    makeInstances(new THREE.CylinderGeometry(0.48, 0.48, 0.12, 20), new THREE.MeshLambertMaterial({ color: 0xe2ded0 }), clockFaces, 'streetClockFace');

    // Public toilets are point inventories, so use a recognizable compact
    // facility model while retaining LoD0 semantics and avoiding false detail.
    const toilets = (data.cityFurniture || []).filter(item => item.class === 'publicToilet' && item.coordinates);
    const toiletBodyMaterial = new THREE.MeshLambertMaterial({ color: 0x6f858b });
    const toiletRoofMaterial = new THREE.MeshLambertMaterial({ color: 0x39484d });
    const toiletDoorMaterial = new THREE.MeshLambertMaterial({ color: 0x243338 });
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 256; signCanvas.height = 128;
    const signContext = signCanvas.getContext('2d');
    signContext.fillStyle = '#176ca4'; signContext.fillRect(0, 0, 256, 128);
    signContext.fillStyle = '#ffffff'; signContext.font = 'bold 72px sans-serif'; signContext.textAlign = 'center'; signContext.textBaseline = 'middle';
    signContext.fillText('WC', 128, 66);
    const toiletSignMaterial = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(signCanvas), side: THREE.DoubleSide });
    for (const item of toilets) {
      const [x, z] = item.coordinates;
      const ground = terrainHeightAt(x, z) + 0.2;
      const yaw = -THREE.MathUtils.degToRad(Number(item.attributes?.roadFacingDeg) || 0) + Math.PI / 2;
      const facility = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.7, 2.5, 3.5), toiletBodyMaterial);
      body.position.y = 1.25;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.18, 3.8), toiletRoofMaterial);
      roof.position.y = 2.58;
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.05, 0.08), toiletDoorMaterial);
      door.position.set(0, 1.03, 1.79);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.36), toiletSignMaterial);
      sign.position.set(0, 2.18, 1.84);
      facility.add(body, roof, door, sign);
      facility.position.set(x, ground, z);
      facility.rotation.y = yaw;
      facility.userData = { semanticClass: 'publicToilet', identifier: item.identifier, name: item.attributes?.FCLT_NAME };
      facility.userData.maxDistance = 900;
      group.add(facility);
    }

    // Monuments deliberately remain semantic-only until object-specific 3D
    // models are supplied; no generic placeholder is rendered.
    const pointObjects = [...publicLights, ...(data.crossings || []), ...(data.parking || []), ...toilets, ...osmFurniture];
    const festoonItems = (data.cityFurniture || []).filter(entry => entry.class === 'festoonLighting' && entry.centerline);
    const festoonChildStart = group.children.length;
    if (festoonItems.length) {
      const buildingFacades = (data.buildings || []).map(record => ({
        ground: Number(record[0]) || 0,
        height: Number(record[1]) || 6,
        ring: record[2] || [],
        identifier: record[3],
      })).filter(building => building.ring.length >= 3);
      const nearestPointOnSegment = (point, a, b) => {
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const amount = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
        return [a[0] + dx * amount, a[1] + dz * amount];
      };
      const facadeCandidates = (point, tangent) => {
        const candidates = [];
        for (const building of buildingFacades) {
          let closest = null;
          let distanceSquared = Infinity;
          for (let index = 0; index < building.ring.length; index += 1) {
            const wallPoint = nearestPointOnSegment(point, building.ring[index], building.ring[(index + 1) % building.ring.length]);
            const candidateDistance = (wallPoint[0] - point[0]) ** 2 + (wallPoint[1] - point[1]) ** 2;
            if (candidateDistance < distanceSquared) {
              distanceSquared = candidateDistance;
              closest = wallPoint;
            }
          }
          if (!closest || distanceSquared > 30 ** 2) continue;
          const side = Math.sign(tangent[0] * (closest[1] - point[1]) - tangent[1] * (closest[0] - point[0]));
          const attachmentAboveGround = Math.min(8.0, Math.max(3.8, building.height - 1.0));
          candidates.push({
            point: new THREE.Vector3(closest[0], building.ground + attachmentAboveGround, closest[1]),
            building: building.identifier,
            side,
            distance: Math.sqrt(distanceSquared),
          });
        }
        return candidates.sort((a, b) => a.distance - b.distance);
      };
      const sampleAlignment = (points, spacing = 14) => {
        const source = points.map(([x, z]) => new THREE.Vector2(x, z));
        const lengths = [0];
        for (let index = 1; index < source.length; index += 1) {
          lengths.push(lengths.at(-1) + source[index].distanceTo(source[index - 1]));
        }
        const total = lengths.at(-1);
        const count = Math.max(2, Math.ceil(total / spacing) + 1);
        const samples = [];
        for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
          const distance = total * sampleIndex / (count - 1);
          let segment = 0;
          while (segment < lengths.length - 2 && lengths[segment + 1] < distance) segment += 1;
          const segmentLength = lengths[segment + 1] - lengths[segment] || 1;
          const amount = (distance - lengths[segment]) / segmentLength;
          const point = source[segment].clone().lerp(source[segment + 1], amount);
          const tangent = source[segment + 1].clone().sub(source[segment]).normalize();
          samples.push({ point: [point.x, point.y], tangent: [tangent.x, tangent.y] });
        }
        return samples;
      };
      const anchors = [];
      const spans = [];
      for (const item of festoonItems) {
        let previousBuilding = null;
        const firstAlignmentPoint = item.centerline[0];
        const lastAlignmentPoint = item.centerline.at(-1);
        const closedAlignment = Math.hypot(
          firstAlignmentPoint[0] - lastAlignmentPoint[0],
          firstAlignmentPoint[1] - lastAlignmentPoint[1],
        ) < 1;
        const itemAnchors = sampleAlignment(item.centerline).map((sample, index) => {
          const candidates = facadeCandidates(sample.point, sample.tangent);
          const desiredSide = index % 2 ? -1 : 1;
          const preferred = closedAlignment
            ? candidates[0]
            : candidates.find(candidate => candidate.side === desiredSide && candidate.building !== previousBuilding)
              || candidates.find(candidate => candidate.building !== previousBuilding)
              || candidates[0];
          if (preferred) {
            previousBuilding = preferred.building;
            anchors.push(preferred.point);
            return preferred.point;
          }
          const [x, z] = sample.point;
          const fallback = new THREE.Vector3(x, terrainHeightAt(x, z) + 5.2, z);
          anchors.push(fallback);
          return fallback;
        });
        for (let index = 0; index < itemAnchors.length - 1; index += 1) {
          if (itemAnchors[index].distanceTo(itemAnchors[index + 1]) <= 36) spans.push([itemAnchors[index], itemAnchors[index + 1]]);
        }
      }

      const cableMaterial = new THREE.MeshBasicMaterial({ color: 0x202326 });
      const bulbPositions = [];
      const socketPositions = [];
      for (const [start, end] of spans) {
        const distance = start.distanceTo(end);
        const sag = clamp(distance * 0.045, 0.35, 1.35);
        const curvePoints = [];
        for (let index = 0; index <= 16; index += 1) {
          const amount = index / 16;
          const point = start.clone().lerp(end, amount);
          point.y -= 4 * sag * amount * (1 - amount);
          curvePoints.push(point);
        }
        const curve = new THREE.CatmullRomCurve3(curvePoints);
        const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.035, 5, false), cableMaterial);
        cable.castShadow = true;
        group.add(cable);
        const bulbCount = Math.max(2, Math.floor(distance / 1.35));
        for (let bulb = 1; bulb < bulbCount; bulb += 1) {
          const point = curve.getPointAt(bulb / bulbCount);
          socketPositions.push(point.clone());
          bulbPositions.push(point.clone().add(new THREE.Vector3(0, -0.17, 0)));
        }
      }

      const setInstances = (positions, geometry, material) => {
        if (!positions.length) return null;
        const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
        positions.forEach((point, index) => {
          matrix.makeTranslation(point.x, point.y, point.z);
          mesh.setMatrixAt(index, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        group.add(mesh);
        return mesh;
      };
      setInstances(anchors, new THREE.SphereGeometry(0.11, 7, 5), new THREE.MeshBasicMaterial({ color: 0x35383a }));
      setInstances(socketPositions, new THREE.CylinderGeometry(0.055, 0.075, 0.18, 6), new THREE.MeshBasicMaterial({ color: 0x292a27 }));
      nightLighting.festoonBulbMaterial = new THREE.MeshBasicMaterial({ color: 0xd6bd83 });
      const bulbs = setInstances(
        bulbPositions,
        new THREE.SphereGeometry(0.09, 8, 6),
        nightLighting.festoonBulbMaterial,
      );
      if (bulbs) bulbs.userData.semanticClass = 'festoonBulbs';

      const glowCanvas = document.createElement('canvas');
      glowCanvas.width = glowCanvas.height = 64;
      const glowContext = glowCanvas.getContext('2d');
      const gradient = glowContext.createRadialGradient(32, 32, 2, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(255,245,190,1)');
      gradient.addColorStop(0.18, 'rgba(255,196,85,0.85)');
      gradient.addColorStop(1, 'rgba(255,160,40,0)');
      glowContext.fillStyle = gradient;
      glowContext.fillRect(0, 0, 64, 64);
      const glowGeometry = new THREE.BufferGeometry().setFromPoints(bulbPositions);
      const glowMaterial = new THREE.PointsMaterial({
        map: new THREE.CanvasTexture(glowCanvas), color: 0xffc45c, size: 1.35,
        transparent: true, opacity: 0.82, depthWrite: false,
        blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      const glow = new THREE.Points(glowGeometry, glowMaterial);
      glow.renderOrder = 9;
      group.add(glow);
      nightLighting.festoonGlow = glow;

      // A small number of actual lights lets the warm festoon glow reach the
      // nearby façades without the cost of one PointLight per bulb.
      const lightStride = Math.max(1, Math.ceil(bulbPositions.length / 10));
      for (let index = 0; index < bulbPositions.length; index += lightStride) {
        const light = new THREE.PointLight(0xffb95d, 1.15, 11, 2);
        light.position.copy(bulbPositions[index]);
        group.add(light);
        nightLighting.festoonPointLights.push(light);
      }
      group.userData.festoon = { spans: spans.length, bulbs: bulbPositions.length, facadeAnchors: anchors.length };
      for (const child of group.children.slice(festoonChildStart)) child.userData.maxDistance = 1000;
    }
    return pointObjects.length;
  }

  status.textContent = 'Building GPU scene…';
  const { mesh: terrainMesh, shadowCatcher } = makeTerrain();
  const buildingMeshes = makeBuildings();
  buildingMeshes.surface = makeDetailedRoofSurface();
  const buildingAppearance = document.querySelector('#building-appearance');
  function setBuildingAppearance(mode) {
    const coloured = mode === 'elevation';
    for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean)) {
      const values = coloured ? mesh.geometry.userData.elevationColors : mesh.geometry.userData.appearanceColors;
      if (values) mesh.geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
      mesh.material.vertexColors = Boolean(values);
      mesh.material.color.setHex(values ? 0xffffff : (mesh === buildingMeshes.walls ? COLORS.wall : COLORS.roof));
      mesh.material.needsUpdate = true;
    }
    requestRender();
  }
  buildingAppearance?.addEventListener('change', event => setBuildingAppearance(event.target.value));
  setBuildingAppearance(buildingAppearance?.value || 'neutral');
  function setBuildingDrawTransparency(enabled) {
    // A closure stroke is aimed at ground-level road geometry, but roofs
    // (including LiDAR-covered structures like parking garages) can fully
    // occlude a narrow street or driveway from the default aerial-ish
    // camera angle, leaving nothing visible to aim at even though the road
    // is perfectly selectable underneath. Fade buildings while the closure
    // drawing tool is active so the user can see what they are drawing over.
    for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean)) {
      mesh.material.transparent = enabled;
      mesh.material.opacity = enabled ? 0.22 : 1;
      mesh.material.depthWrite = !enabled;
      mesh.material.needsUpdate = true;
    }
    requestRender();
  }
  makeGrass();
  makeWaterAndOsmDetails();
  const railwayCount = makeRailways();
  makeRoads();
  const canopyCount = makeCanopies();
  makeStreetFurniture();

  const heatGroup = new THREE.Group();
  const sunDomainGroup = new THREE.Group();
  const windGroup = new THREE.Group();
  const trafficGroup = new THREE.Group();
  const trafficStatusGroup = new THREE.Group();
  const trafficDrawingGroup = new THREE.Group();
  const permanentStatusGroup = new THREE.Group();
  const liveClosureGroup = new THREE.Group();
  const selectedRoadDirectionGroup = new THREE.Group();
  const scenarioStatusGroup = new THREE.Group();
  trafficStatusGroup.add(permanentStatusGroup, liveClosureGroup, selectedRoadDirectionGroup, scenarioStatusGroup);
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
  scene.add(heatGroup, sunDomainGroup, windGroup, trafficStatusGroup, trafficDrawingGroup, trafficGroup, streetViewGroup);

  const heatToggle = document.querySelector('#heat-toggle');
  const heatMetric = document.querySelector('#heat-metric');
  const heatDate = document.querySelector('#heat-date');
  const heatTime = document.querySelector('#heat-time');
  const heatDateControl = document.querySelector('#heat-date-control');
  const heatTimeControl = document.querySelector('#heat-time-control');
  const heatStatus = document.querySelector('#heat-status');
  const heatLegendMin = document.querySelector('#heat-legend-min');
  const heatLegendMax = document.querySelector('#heat-legend-max');
  const heatSummary = document.querySelector('#heat-summary');
  const heatAverage = document.querySelector('#heat-average');
  const heatPriorityArea = document.querySelector('#heat-priority-area');
  const heatMaximum = document.querySelector('#heat-maximum');
  const heatAverageLabel = document.querySelector('#heat-average-label');
  const heatMaximumLabel = document.querySelector('#heat-maximum-label');
  const sunToggle = document.querySelector('#sun-toggle');
  const sunDate = document.querySelector('#sun-date');
  const sunTime = document.querySelector('#sun-time');
  const sunTimeValue = document.querySelector('#sun-time-value');
  const sunGenerate = document.querySelector('#sun-generate');
  const sunProgress = document.querySelector('#sun-progress');
  const sunStatus = document.querySelector('#sun-status');
  const sunModeButtons = [...document.querySelectorAll('[data-sun-mode]')];
  const sunInstantControl = document.querySelector('#sun-instant-control');
  const sunWindowControls = document.querySelector('#sun-window-controls');
  const sunDateTimeHeading = document.querySelector('#sun-date-time-heading');
  const sunStartTime = document.querySelector('#sun-start-time');
  const sunEndTime = document.querySelector('#sun-end-time');
  const sunStepTime = document.querySelector('#sun-step-time');
  const sunAnalysisSurfaces = document.querySelector('#sun-analysis-surfaces');
  const sunSurfaceResolution = document.querySelector('#sun-surface-resolution');
  const sunDomainSize = document.querySelector('#sun-domain-size');
  const sunMoveDomain = document.querySelector('#sun-move-domain');
  const sunHoursLegend = document.querySelector('#sun-hours-legend');
  const sunHoursMin = document.querySelector('#sun-hours-min');
  const sunHoursMax = document.querySelector('#sun-hours-max');
  const windToggle = document.querySelector('#wind-toggle');
  const windDirection = document.querySelector('#wind-direction');
  const windSeason = document.querySelector('#wind-season');
  const windStability = document.querySelector('#wind-stability');
  const windForcingMode = document.querySelector('#wind-forcing-mode');
  const windSpeed = document.querySelector('#wind-speed');
  const windSize = document.querySelector('#wind-size');
  const windSpeedValue = document.querySelector('#wind-speed-value');
  const windSizeValue = document.querySelector('#wind-size-value');
  const windStatus = document.querySelector('#wind-status');
  const windSimulate = document.querySelector('#wind-simulate');
  const windMoveDomain = document.querySelector('#wind-move-domain');
  const windLegendMin = document.querySelector('#wind-legend-min');
  const windLegendMax = document.querySelector('#wind-legend-max');
  const windLegendLow = document.querySelector('#wind-legend-low');
  const windLegendHigh = document.querySelector('#wind-legend-high');
  const windLegendField = document.querySelector('#wind-legend-field');
  const windComfortChips = document.querySelector('#wind-comfort-chips');
  const windGradient = document.querySelector('.wind-panel .wind-gradient');
  const windFlowlinesVisible = document.querySelector('#wind-flowlines-visible');
  const windVolumeVisible = document.querySelector('#wind-volume-visible');
  const windFlowBoxHeightRow = document.querySelector('#wind-flow-box-height-row');
  const windFlowBoxHeight = document.querySelector('#wind-flow-box-height');
  const windFlowBoxHeightValue = document.querySelector('#wind-flow-box-height-value');
  const windFlowlineCount = document.querySelector('#wind-flowline-count');
  const windAnimationSpeed = document.querySelector('#wind-animation-speed');
  const windAnimationSpeedValue = document.querySelector('#wind-animation-speed-value');
  const windLensButtons = [...document.querySelectorAll('[data-wind-lens]')];
  const windPanel = document.querySelector('.wind-panel');
  const windModeBadge = document.querySelector('.wind-mode-badge');
  const windSourceTitle = document.querySelector('#wind-source-title');
  const windSourceDetail = document.querySelector('#wind-source-detail');
  const windCfdControls = document.querySelector('#wind-cfd-controls');
  const windFlowBoxControls = document.querySelector('#wind-flow-box-controls');
  const windClimateControls = document.querySelector('#wind-climate-controls');
  const windCfdField = document.querySelector('#wind-cfd-field');
  const windCfdViewButtons = [...document.querySelectorAll('[data-cfd-view]')];
  const windGroundControls = document.querySelector('#wind-ground-controls');
  const windCfdGroundHeight = document.querySelector('#wind-cfd-ground-height');
  const windSliceControls = document.querySelector('#wind-slice-controls');
  const windSlicePlane = document.querySelector('#wind-slice-plane');
  const windSlicePosition = document.querySelector('#wind-slice-position');
  const windSlicePositionValue = document.querySelector('#wind-slice-position-value');
  const windSliceWidth = document.querySelector('#wind-slice-width');
  const windSliceHeight = document.querySelector('#wind-slice-height');
  const windSliceWidthValue = document.querySelector('#wind-slice-width-value');
  const windSliceHeightValue = document.querySelector('#wind-slice-height-value');
  const windSliceCenterX = document.querySelector('#wind-slice-center-x');
  const windSliceCenterY = document.querySelector('#wind-slice-center-y');
  const windSliceCenterXValue = document.querySelector('#wind-slice-center-x-value');
  const windSliceCenterYValue = document.querySelector('#wind-slice-center-y-value');
  const windSliceReset = document.querySelector('#wind-slice-reset');
  const windDirectionControls = document.querySelector('[data-wind-direction-controls]');
  const windDirectionPresets = [...document.querySelectorAll('[data-wind-direction]')];
  const trafficToggle = document.querySelector('#traffic-toggle');
  const trafficRestrictionsToggle = document.querySelector('#traffic-restrictions-toggle');
  const trafficFreshness = document.querySelector('#traffic-freshness');
  const trafficRefresh = document.querySelector('#traffic-refresh');
  const trafficLiveStatus = document.querySelector('#traffic-live-status');
  const trafficLiveMetrics = document.querySelector('#traffic-live-metrics');
  const trafficDuration = document.querySelector('#traffic-duration');
  const trafficDurationValue = document.querySelector('#traffic-duration-value');
  const trafficScenario = document.querySelector('#traffic-scenario');
  const trafficDemand = document.querySelector('#traffic-demand');
  const trafficDrawLane = document.querySelector('#traffic-draw-lane');
  const trafficDrawRoad = document.querySelector('#traffic-draw-road');
  const trafficDrawOneWay = document.querySelector('#traffic-draw-oneway');
  const trafficDrawPopup = document.querySelector('#traffic-draw-popup');
  const trafficDrawPopupTitle = document.querySelector('#traffic-draw-popup-title');
  const trafficDrawPopupStatus = document.querySelector('#traffic-draw-popup-status');
  const trafficDrawPopupCount = document.querySelector('#traffic-draw-popup-count');
  const trafficDrawConfirm = document.querySelector('#traffic-draw-confirm');
  const trafficDrawCancel = document.querySelector('#traffic-draw-cancel');
  const trafficSelectionStatus = document.querySelector('#traffic-selection-status');
  const trafficControlModel = document.querySelector('#traffic-control-model');
  const trafficOneWayRow = document.querySelector('#traffic-oneway-row');
  const trafficOneWayToggle = document.querySelector('#traffic-oneway');
  const trafficFlipDirection = document.querySelector('#traffic-flip-direction');
  const trafficRun = document.querySelector('#traffic-run');
  const trafficClear = document.querySelector('#traffic-clear');
  const trafficStatus = document.querySelector('#traffic-status');
  const trafficCompare = document.querySelector('#traffic-compare');
  const trafficResults = document.querySelector('#traffic-results');
  const trafficImpactSummary = document.querySelector('#traffic-impact-summary');
  const trafficReport = document.querySelector('#traffic-report');
  const trafficReportDialog = document.querySelector('#traffic-report-dialog');
  const trafficReportDocument = document.querySelector('#traffic-report-document');
  const trafficReportClose = document.querySelector('#traffic-report-close');
  const trafficReportPrint = document.querySelector('#traffic-report-print');
  const trafficOnScreen = document.querySelector('#traffic-onscreen');
  let trafficOnScreenShownAt = 0;
  const query = new URLSearchParams(location.search);
  const windApi = query.get('windApi') || '/api';

  const shadowState = {
    enabled: Boolean(sunToggle?.checked),
    date: sunDate?.value || '2026-07-27',
    minutes: Number(sunTime?.value) || 720,
    generated: false,
    mode: 'shadows',
    center: [0, 0],
    size: Number(sunDomainSize?.value) || 500,
    moveMode: false,
  };
  let liveShadowTimer = 0;
  const windState = {
    enabled: Boolean(windToggle?.checked),
    // center/size is the interactive, user-drawn flow-seed box (the old
    // "draw a box" domain), independent of the solved CFD case's own
    // footprint. domainCenter/domainSize below track the latter — used for
    // camera framing and the Comfort grid, never overwritten by dragging.
    center: [0, 0],
    size: Number(windSize?.value) || 300,
    domainCenter: [0, 0],
    domainSize: 300,
    direction: Number(windDirection?.value) || 135,
    season: windSeason?.value || 'annual',
    stability: windStability?.value || 'neutral',
    height: 2,
    forcingMode: windForcingMode?.value || 'era5_climatology',
    analysisMode: 'direction',
    dataMode: 'cfd',
    cfd: null,
    cfdView: 'ground',
    cfdField: 'speed',
    cfdGroundHeight: 2,
    slicePlane: 'vertical-crosswind',
    slicePosition: 0.5,
    sliceWidth: 1,
    // A full-height slice is dominated by uniform free-stream flow above roof
    // level (the solved domain reaches ~220 m), which reduces the pedestrian-
    // and canopy-height detail people actually open this view for to a thin
    // sliver. Default to the near-ground band; "Reset full slice" still
    // restores the complete domain height on request.
    sliceHeight: 0.35,
    sliceCenterX: 0.5,
    sliceCenterY: 0,
    // Colour range actually visible in the current CFD view, keyed by field
    // name — set by whichever builder last ran (ground/slice) so the legend
    // and colours always agree. Falls back to the whole-domain manifest
    // range (dominated by free-stream speed well above roof height) when
    // null, which is why Ground/Slice recompute it: without this, most
    // pedestrian-height speed differences were squeezed into a sliver of the
    // colour scale and read as a uniform blue/cyan wash.
    cfdLocalRange: null,
    surfaceVisible: true,
    flowlinesVisible: Boolean(windFlowlinesVisible?.checked),
    volumeVisible: Boolean(windVolumeVisible?.checked),
    volumeHeight: 80,
    // How tall the flow box's 3D seeding actually extends, user-adjustable
    // and independent of volumeHeight (the solved domain's real ceiling,
    // ~220 m, which flowBoxHeight is clamped to).
    flowBoxHeight: Number(windFlowBoxHeight?.value) || 80,
    particleCount: Number(windFlowlineCount?.value) || 800,
    animationSpeed: (Number(windAnimationSpeed?.value) || 100) / 100,
    speed: (Number(windSpeed?.value) || 36) / 3.6,
    referenceHeight: 2,
    field: null,
    particles: [],
    moveMode: false,
    lastTime: performance.now(),
  };
  const trafficState = {
    sceneActive: document.querySelector('[data-menu-target].active')?.dataset.menuTarget === 'traffic',
    enabled: Boolean(trafficToggle?.checked),
    result: null,
    tracks: [],
    durationS: 900,
    sampleIntervalS: 2,
    simClock: 0,
    lastTime: performance.now(),
    roadStatuses: [],
    roadsByName: new Map(),
    liveRoads: [],
    networkEdges: [],
    edgesById: new Map(),
    snapGrid: new Map(),
    snapCellSize: 45,
    snapRadius: 24,
    closureMode: 'lane',
    oneWay: false,
    // True when the user picked the dedicated "One-way" tool rather than
    // plain "Street" -- both submit closure_mode: "full" underneath (a
    // one-way conversion on a single-lane-per-direction road *is* a full
    // closure of one directional edge), this only changes the UI framing
    // and which flip-button copy is shown.
    oneWayIntent: false,
    drawing: false,
    stroking: false,
    pointerId: null,
    lastScreen: null,
    strokePoints: [],
    selectedEdgeIds: [],
  };
  const streetViewState = { placing: false, point: null };
  let heatMesh = null;
  let heatRange = null;
  let heatPayload = null;
  let analysisGroupMode = null;
  let heatLoadToken = 0;
  let sunLoadToken = 0;
  let sunAbortController = null;
  let sunAnalysisId = null;
  let windHeatMesh = null;
  let windPoints = null;
  let windCfdSlice = null;
  let windFacadePressure = null;
  let trafficCars = null;
  let windBox = null;
  let windEdges = null;
  let windHandle = null;
  let sunBox = null;
  let sunEdges = null;
  let sunHandle = null;
  let streetLayersVisibleBeforeWind = null;
  const windTrailPoints = 56;
  let drag = null;
  let windDrag = null;
  let sunDrag = null;
  let sliceDrag = null;
  const windBuildingCellSize = 60;
  const windBuildingGrid = new Map();
  const savedVisibility = Object.fromEntries(
    Object.entries(layerGroups).map(([name, group]) => [name, group.visible]),
  );

  function syncTrafficSceneVisibility() {
    trafficGroup.visible = trafficState.sceneActive && trafficState.enabled;
    trafficStatusGroup.visible = trafficState.sceneActive && Boolean(trafficRestrictionsToggle?.checked);
    trafficDrawingGroup.visible = trafficState.sceneActive && Boolean(trafficState.selectedEdgeIds.length);
  }

  function rememberNormalVisibility() {
    for (const [name, group] of Object.entries(layerGroups)) savedVisibility[name] = group.visible;
  }

  function restoreNormalVisibility() {
    for (const [name, group] of Object.entries(layerGroups)) group.visible = savedVisibility[name];
  }

  // Road and footpath meshes are drawn above the terrain and otherwise cover
  // the wind surface exactly where street-level interpretation matters most.
  // Preserve the user's layer choices, hide both overlays only while a
  // generated wind result is visible, then restore them on clear/hide.
  function hideStreetLayersForWind() {
    if (streetLayersVisibleBeforeWind === null) {
      streetLayersVisibleBeforeWind = {
        roads: layerGroups.roads.visible,
        paths: layerGroups.paths.visible,
      };
    }
    layerGroups.roads.visible = false;
    layerGroups.paths.visible = false;
    document.querySelectorAll('[data-layer="roads"], [data-layer="paths"]').forEach(input => {
      input.disabled = true;
      input.title = 'Hidden while the generated wind surface is visible';
    });
    syncLayerControls();
  }

  function restoreStreetLayersAfterWind() {
    if (streetLayersVisibleBeforeWind === null) return;
    layerGroups.roads.visible = streetLayersVisibleBeforeWind.roads;
    layerGroups.paths.visible = streetLayersVisibleBeforeWind.paths;
    streetLayersVisibleBeforeWind = null;
    document.querySelectorAll('[data-layer="roads"], [data-layer="paths"]').forEach(input => {
      input.disabled = false;
      input.removeAttribute('title');
    });
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
  for (const [ground, height, ring, , , wallHeight = height, , , , , minHeight = 0, , , holes = []] of data.buildings) {
    if (!ring?.length) continue;
    const minX = Math.min(...ring.map(point => point[0]));
    const maxX = Math.max(...ring.map(point => point[0]));
    const minZ = Math.min(...ring.map(point => point[1]));
    const maxZ = Math.max(...ring.map(point => point[1]));
    const centroid = ring.reduce((sum, [x, z]) => [sum[0] + x, sum[1] + z], [0, 0]);
    centroid[0] /= ring.length;
    centroid[1] /= ring.length;
    const building = {
      ring, holes, rings: [ring, ...holes], minX, maxX, minZ, maxZ, centroid,
      roofY: ground + Math.max(height, wallHeight),
      baseY: ground + Math.max(0, Number(minHeight) || 0),
      minHeight: Math.max(0, Number(minHeight) || 0),
    };
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

  function windPointInsideBuilding(x, z, worldY = null) {
    const column = Math.floor(x / windBuildingCellSize);
    const row = Math.floor(z / windBuildingCellSize);
    const candidates = windBuildingGrid.get(windCellKey(column, row)) || [];
    return candidates.some(building => (
      (worldY === null ? building.minHeight <= windState.height : worldY >= building.baseY && worldY <= building.roofY)
      && x >= building.minX && x <= building.maxX
      && z >= building.minZ && z <= building.maxZ
      && pointInWindRing(x, z, building.ring)
      && !building.holes.some(hole => pointInWindRing(x, z, hole))
    ));
  }

  function rooftopHeightAt(x, z) {
    const candidates = windBuildingGrid.get(windCellKey(
      Math.floor(x / windBuildingCellSize), Math.floor(z / windBuildingCellSize),
    )) || [];
    const buildingsAtPoint = candidates.filter(candidate => (
      x >= candidate.minX && x <= candidate.maxX
      && z >= candidate.minZ && z <= candidate.maxZ
      && pointInWindRing(x, z, candidate.ring)
      && !candidate.holes.some(hole => pointInWindRing(x, z, hole))
    ));
    const roofY = buildingsAtPoint.reduce((highest, building) => Math.max(highest, building.roofY), -Infinity);
    return Number.isFinite(roofY) ? roofY + 0.08 : terrainHeightAt(x, z) + 0.48;
  }

  function nearestWindBoundary(x, z, worldY = null) {
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
      if (worldY === null ? building.minHeight > windState.height : worldY < building.baseY || worldY > building.roofY) continue;
      if (x < building.minX - 30 || x > building.maxX + 30 || z < building.minZ - 30 || z > building.maxZ + 30) continue;
      for (const boundaryRing of building.rings) {
       for (let index = 0; index < boundaryRing.length; index += 1) {
        const [ax, az] = boundaryRing[index];
        const [bx, bz] = boundaryRing[(index + 1) % boundaryRing.length];
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
    }
    return nearest;
  }

  function redirectWindFlow(x, z, flow, force = false, worldY = null) {
    const boundary = nearestWindBoundary(x, z, worldY);
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
    const inside = windPointInsideBuilding(x, z, worldY);
    const tangentialSpeed = Math.abs(incomingTangent);
    // Preserve the component parallel to the facade and add only a small
    // outward bias. This is a sliding collision response, not a vortex.
    const outwardSpeed = inside || force ? speed * 0.55 : speed * 0.35 * proximity;
    const length = Math.hypot(tangentialSpeed, outwardSpeed) || 1;
    return {
      u: (tangentX * tangentialSpeed + normalX * outwardSpeed) * speed / length,
      w: flow.w || 0,
      v: (tangentZ * tangentialSpeed + normalZ * outwardSpeed) * speed / length,
      speed,
    };
  }

  function pushWindPointOutsideBuilding(x, z, worldY = null) {
    const boundary = nearestWindBoundary(x, z, worldY);
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
    // Fine street markings and furniture disappear at district scale. Apart
    // from reducing clutter this avoids spending GPU time on details smaller
    // than a pixel; they return automatically as the camera approaches.
    for (const object of layerGroups.cityFurniture.children) {
      const maxDistance = Number(object.userData?.maxDistance);
      if (maxDistance > 0) object.visible = cameraState.distance <= maxDistance;
    }
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

  // Frame a local-space [minX, minZ, maxX, maxZ] box. Used after a traffic
  // run so the corridor the user just closed fills the view: at full-CBD
  // zoom an individual car is only a few pixels and lost between buildings.
  function frameBounds(bounds, { elevation = 0.5 } = {}) {
    if (!bounds || bounds.length !== 4) return;
    const [minX, minZ, maxX, maxZ] = bounds;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const span = Math.max(Math.hypot(maxX - minX, maxZ - minZ), 240);
    cameraState.target.set(centerX, terrainHeightAt(centerX, centerZ) + 15, centerZ);
    cameraState.distance = clamp(span * 0.9, 360, 2400);
    cameraState.elevation = elevation;
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

  function fitSunShadowCamera(target) {
    const shadowCamera = sunLight.shadow.camera;
    // A fixed world-space square does not cover a rectangular scene after it
    // rotates into the sun's coordinate system. Fit all eight corners of the
    // terrain/caster volume in light space instead, so every ground triangle
    // remains inside the shadow texture at every solar azimuth and altitude.
    shadowCamera.position.copy(sunLight.position);
    shadowCamera.up.set(0, 1, 0);
    shadowCamera.lookAt(target);
    shadowCamera.updateMatrixWorld(true);

    let minimumX = Infinity;
    let maximumX = -Infinity;
    let minimumY = Infinity;
    let maximumY = -Infinity;
    let minimumZ = Infinity;
    let maximumZ = -Infinity;
    for (const x of [left, right]) {
      for (const y of [shadowMinimumY, shadowMaximumY]) {
        for (const z of [minZ, maxZ]) {
          const point = new THREE.Vector3(x, y, z).applyMatrix4(shadowCamera.matrixWorldInverse);
          minimumX = Math.min(minimumX, point.x);
          maximumX = Math.max(maximumX, point.x);
          minimumY = Math.min(minimumY, point.y);
          maximumY = Math.max(maximumY, point.y);
          minimumZ = Math.min(minimumZ, point.z);
          maximumZ = Math.max(maximumZ, point.z);
        }
      }
    }

    const padding = 24;
    shadowCamera.left = minimumX - padding;
    shadowCamera.right = maximumX + padding;
    shadowCamera.bottom = minimumY - padding;
    shadowCamera.top = maximumY + padding;
    // Camera-space points in front of the light camera have negative z.
    shadowCamera.near = Math.max(1, -maximumZ - padding);
    shadowCamera.far = Math.max(shadowCamera.near + 1, -minimumZ + padding);
    shadowCamera.updateProjectionMatrix();
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

  function setBuildingAnalysisSkin(enabled) {
    if (buildingMeshes.walls) buildingMeshes.walls.visible = true;
    // Sun-hour roofs now reuse the detailed roof triangles, so the neutral
    // roof remains a safe backing surface for any unmapped edge triangles.
    if (buildingMeshes.roofs) buildingMeshes.roofs.visible = true;
    if (buildingMeshes.surface) buildingMeshes.surface.visible = true;
  }

  function cancelSunHours(message = '', clearResult = true) {
    sunLoadToken += 1;
    if (sunAnalysisId) {
      fetch(`${windApi}/sunlight/cancel?${new URLSearchParams({ analysis_id: sunAnalysisId })}`, {
        method: 'POST', keepalive: true,
      }).catch(() => {});
      sunAnalysisId = null;
    }
    sunAbortController?.abort();
    sunAbortController = null;
    if (sunProgress) {
      sunProgress.hidden = true;
      sunProgress.removeAttribute('value');
    }
    if (sunGenerate) {
      sunGenerate.disabled = false;
      if (shadowState.mode === 'hours') sunGenerate.textContent = 'Calculate sun hours';
    }
    if (clearResult) {
      heatGroup.visible = false;
      setBuildingAnalysisSkin(false);
    }
    if (message && sunStatus) sunStatus.textContent = message;
    requestRender();
  }

  function updateSunBox() {
    const visible = shadowState.enabled && shadowState.mode === 'hours';
    sunDomainGroup.visible = visible;
    if (!visible) return;
    if (!sunBox) {
      const geometry = new THREE.BoxGeometry(1, 3, 1);
      sunBox = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0xd6a05d, transparent: true, opacity: 0.08, depthWrite: false,
      }));
      sunEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0xffe2b5, transparent: true, opacity: 0.9, depthTest: false }),
      );
      sunHandle = new THREE.Mesh(
        new THREE.SphereGeometry(7, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xd18a3d, depthTest: false }),
      );
      sunHandle.name = 'sun-resize-handle';
      sunDomainGroup.add(sunBox, sunEdges, sunHandle);
    }
    const size = shadowState.size;
    const y = terrainHeightAt(shadowState.center[0], shadowState.center[1]) + 3;
    sunBox.scale.set(size, 1, size);
    sunBox.position.set(shadowState.center[0], y, shadowState.center[1]);
    sunBox.material.opacity = shadowState.moveMode ? 0.15 : 0.035;
    sunEdges.scale.copy(sunBox.scale);
    sunEdges.position.copy(sunBox.position);
    sunEdges.material.opacity = shadowState.moveMode ? 0.95 : 0.42;
    sunHandle.position.set(shadowState.center[0] + size / 2, y + 3, shadowState.center[1] + size / 2);
    sunHandle.visible = shadowState.moveMode;
    requestRender();
  }

  function setShadowMode(enabled) {
    const wasInStudyMode = shadowState.enabled || heatGroup.visible;
    if (enabled && !wasInStudyMode) rememberNormalVisibility();
    shadowState.enabled = enabled;
    if (!enabled) {
      // A cumulative calculation may still be running when the user leaves
      // Sunlight. Invalidate it so its late response cannot replace Heat.
      cancelSunHours('', false);
    }
    if (sunToggle) sunToggle.checked = enabled;
    document.body.classList.toggle('sun-mode', enabled);
    if (enabled) {
      if (heatToggle) heatToggle.checked = false;
      setHeatMode(false);
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
      setBuildingAnalysisSkin(false);
      restoreNormalVisibility();
      heatGroup.visible = Boolean(heatToggle?.checked) && analysisGroupMode === 'heat';
      windState.enabled = Boolean(windToggle?.checked);
      windGroup.visible = windState.enabled;
    }
    setSunMaterials(enabled);
    updateSunBox();
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
    const target = new THREE.Vector3((left + right) * 0.5, 20, (minZ + maxZ) * 0.5);
    sunLight.target.position.copy(target);
    sunLight.position.copy(target).addScaledVector(sun.vector, 3000);
    sunLight.target.updateMatrixWorld();
    sunLight.updateMatrixWorld();
    fitSunShadowCamera(target);
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

  function heatColor(value, minimum, maximum, metric = '') {
    const color = new THREE.Color();
    const t = clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
    const stops = metric === 'cumulative_sun_hours' ? [
      [0, 0x5e2e18], [0.25, 0x9a4b25], [0.5, 0xd47a32], [0.75, 0xf2b44e], [1, 0xffe8a6],
    ] : [
      [0, 0x2b50be], [0.2, 0x2daede], [0.42, 0x74cf48],
      [0.64, 0xffe241], [0.82, 0xff9619], [1, 0xe03020],
    ];
    let upper = 1;
    while (upper < stops.length - 1 && t > stops[upper][0]) upper += 1;
    const lower = upper - 1;
    const amount = (t - stops[lower][0]) / (stops[upper][0] - stops[lower][0]);
    return color.setHex(stops[lower][1]).lerp(new THREE.Color(stops[upper][1]), amount);
  }

  function buildRooftopHeatMesh(payload, range, featureValue = feature => feature.value, geometrySource = detailedRoofGeometrySource) {
    if (!geometrySource?.positions?.length) return null;
    const cellSize = 80;
    const records = [];
    const grid = new Map();
    const key = (column, row) => `${column}:${row}`;
    const addRecord = (rings, value) => {
      if (!rings?.[0]?.length || value == null) return;
      const xs = rings[0].map(point => point[0]);
      const zs = rings[0].map(point => point[1]);
      const record = { rings, value, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
      const index = records.push(record) - 1;
      for (let row = Math.floor(record.minZ / cellSize); row <= Math.floor(record.maxZ / cellSize); row += 1) {
        for (let column = Math.floor(record.minX / cellSize); column <= Math.floor(record.maxX / cellSize); column += 1) {
          const cellKey = key(column, row);
          if (!grid.has(cellKey)) grid.set(cellKey, []);
          grid.get(cellKey).push(index);
        }
      }
    };
    for (const feature of payload.features || []) {
      for (const polygon of geometryPolygons(feature.geometry)) addRecord(polygon, featureValue(feature));
    }
    const insideRing = (x, z, ring) => {
      let inside = false;
      for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const [xi, zi] = ring[index], [xj, zj] = ring[previous];
        const edgeX = xj - xi, edgeZ = zj - zi;
        const edgeLengthSquared = edgeX * edgeX + edgeZ * edgeZ;
        if (edgeLengthSquared > 0) {
          const along = clamp(((x - xi) * edgeX + (z - zi) * edgeZ) / edgeLengthSquared, 0, 1);
          if (Math.hypot(x - (xi + edgeX * along), z - (zi + edgeZ * along)) <= 0.02) return true;
        }
        if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
      }
      return inside;
    };
    const valueAt = (x, z) => {
      for (const recordIndex of grid.get(key(Math.floor(x / cellSize), Math.floor(z / cellSize))) || []) {
        const record = records[recordIndex];
        if (x < record.minX || x > record.maxX || z < record.minZ || z > record.maxZ) continue;
        if (!insideRing(x, z, record.rings[0])) continue;
        if (record.rings.slice(1).some(ring => insideRing(x, z, ring))) continue;
        return record.value;
      }
      return null;
    };
    const positions = [];
    const colors = [];
    const meshIndices = [];
    const vertexMap = new Map();
    const source = geometrySource.positions;
    const indices = geometrySource.indices || null;
    const indexCount = indices?.length || source.length / 3;
    for (let offset = 0; offset < indexCount; offset += 3) {
      const a = indices ? indices[offset] : offset;
      const b = indices ? indices[offset + 1] : offset + 1;
      const c = indices ? indices[offset + 2] : offset + 2;
      const x = (source[a * 3] + source[b * 3] + source[c * 3]) / 3;
      const z = (source[a * 3 + 2] + source[b * 3 + 2] + source[c * 3 + 2]) / 3;
      const samples = [
        [x, z],
        [source[a * 3], source[a * 3 + 2]], [source[b * 3], source[b * 3 + 2]], [source[c * 3], source[c * 3 + 2]],
        [(source[a * 3] + source[b * 3]) / 2, (source[a * 3 + 2] + source[b * 3 + 2]) / 2],
        [(source[b * 3] + source[c * 3]) / 2, (source[b * 3 + 2] + source[c * 3 + 2]) / 2],
        [(source[c * 3] + source[a * 3]) / 2, (source[c * 3 + 2] + source[a * 3 + 2]) / 2],
      ];
      const value = samples.map(point => valueAt(point[0], point[1])).find(candidate => candidate != null);
      if (value == null) continue;
      for (const vertex of [a, b, c]) {
        let mapped = vertexMap.get(vertex);
        if (mapped == null) {
          mapped = positions.length / 3;
          vertexMap.set(vertex, mapped);
          const vertexValue = valueAt(source[vertex * 3], source[vertex * 3 + 2]) ?? value;
          const color = heatColor(vertexValue, range.min, range.max, payload.metric);
          positions.push(source[vertex * 3], source[vertex * 3 + 1], source[vertex * 3 + 2]);
          colors.push(color.r, color.g, color.b);
        }
        meshIndices.push(mapped);
      }
    }
    if (!positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(meshIndices);
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
  }

  function buildRooftopHeatMeshes(payload, range, featureValue = feature => feature.value) {
    return [detailedRoofGeometrySource, simplifiedRoofGeometrySource]
      .map(source => buildRooftopHeatMesh(payload, range, featureValue, source))
      .filter(Boolean);
  }

  function buildFacadeSunMesh(payload, range) {
    if (!buildingWallGeometrySource?.positions?.length) return null;
    const recordsByEdge = new Map();
    for (const feature of payload.features || []) {
      if (feature.surface !== 'facade' || feature.source_id == null || feature.edge_index == null) continue;
      const recordKey = `${feature.source_id}:${feature.edge_index}`;
      if (!recordsByEdge.has(recordKey)) recordsByEdge.set(recordKey, []);
      const ys = (feature.vertices || []).map(vertex => vertex[1]);
      recordsByEdge.get(recordKey).push({
        minY: Math.min(...ys) - 0.05, maxY: Math.max(...ys) + 0.05,
        value: feature.display_value ?? feature.value, area: Number(feature.area_m2) || 1,
      });
    }
    const source = buildingWallGeometrySource.positions;
    const positions = [], colors = [];
    for (let offset = 0; offset < source.length; offset += 9) {
      const triangleIndex = offset / 9;
      const identity = buildingWallGeometrySource.triangles?.[triangleIndex];
      if (!identity) continue;
      const records = recordsByEdge.get(`${identity.sourceId}:${identity.edgeIndex}`) || [];
      if (!records.length) continue;
      const y = (source[offset + 1] + source[offset + 4] + source[offset + 7]) / 3;
      const matching = records.filter(record => y >= record.minY && y <= record.maxY);
      const selected = matching.length ? matching : records;
      const totalArea = selected.reduce((sum, record) => sum + record.area, 0);
      const value = selected.reduce((sum, record) => sum + record.value * record.area, 0) / totalArea;
      const color = heatColor(value, range.min, range.max, 'cumulative_sun_hours');
      for (let vertex = 0; vertex < 3; vertex += 1) {
        positions.push(source[offset + vertex * 3], source[offset + vertex * 3 + 1], source[offset + vertex * 3 + 2]);
        colors.push(color.r, color.g, color.b);
      }
    }
    if (!positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.94, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
  }

  function buildHeatMesh(payload) {
    for (const object of heatGroup.children) disposeObject(object);
    heatGroup.clear();
    heatMesh = null;
    analysisGroupMode = payload.metric === 'cumulative_sun_hours' ? 'sun' : 'heat';
    const range = payload.color_range || payload.range;
    if (!payload.features?.length || !range) return;
    if (payload.metric === 'rooftop_temperature_c') {
      const roofMeshes = buildRooftopHeatMeshes(payload, range);
      heatMesh = roofMeshes[0] || null;
      heatGroup.add(...roofMeshes);
      return;
    }
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
      const color = heatColor(feature.value, range.min, range.max, payload.metric);
      for (const polygon of polygons) {
        const contour = toVectorRing(polygon[0] || []);
        if (contour.length < 3) continue;
        const holes = polygon.slice(1).map(toVectorRing).filter(ring => ring.length >= 3);
        const vertices = contour.concat(...holes);
        for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
          for (const index of face) {
            const point = vertices[index];
            const y = payload.metric === 'rooftop_temperature_c'
              ? detailedRoofHeightAt(point.x, point.y, Number(feature.surface_y ?? rooftopHeightAt(point.x, point.y)))
              : terrainHeightAt(point.x, point.y) + 0.48;
            positions.push(point.x, y, point.y);
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
      // Without this, the mesh z-fights with the terrain it sits 0.48 m
      // above — the depth buffer's precision thins out with distance, so at
      // typical city-block camera distances random patches of the surface
      // lose the fight and show bare terrain through instead, looking like
      // unexplained gaps in coverage that scale with view distance/angle
      // rather than with the underlying (actually complete) zone data.
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }));
    heatGroup.add(heatMesh);
  }

  function formatHeatValue(value, metadata = {}) {
    if (value == null) return '—';
    const decimals = Number(metadata.decimals ?? 1);
    return `${Number(value).toFixed(decimals)}${metadata.unit || ''}`;
  }

  function syncHeatTemporalControls(metric = heatMetric?.value) {
    const temporal = ['pedestrian_priority_score', 'shade_deficit_score'].includes(metric);
    if (heatDateControl) heatDateControl.hidden = !temporal;
    if (heatTimeControl) heatTimeControl.hidden = !temporal;
  }

  function renderHeatSummary(summary, metadata = {}) {
    if (!heatSummary) return;
    const ready = summary?.area_weighted_mean != null && summary?.maximum != null;
    heatSummary.hidden = !ready;
    if (!ready) return;
    heatAverage.textContent = formatHeatValue(summary.area_weighted_mean, metadata);
    heatMaximum.textContent = formatHeatValue(summary.maximum, metadata);
    if (heatAverageLabel) heatAverageLabel.textContent = 'Average';
    if (heatMaximumLabel) heatMaximumLabel.textContent = 'Maximum';
    const hotspotHectares = Number(summary.hotspot_area_m2 || 0) / 10000;
    const hotspotPercent = Number(summary.hotspot_area_pct || 0);
    heatPriorityArea.textContent = `${hotspotHectares.toFixed(1)} ha · ${hotspotPercent.toFixed(0)}%`;
  }

  async function loadHeat(metric = heatMetric?.value || 'pedestrian_priority_score') {
    if (!heatStatus) return;
    const loadToken = ++heatLoadToken;
    syncHeatTemporalControls(metric);
    heatStatus.textContent = 'Loading heat zones…';
    try {
      const params = new URLSearchParams({
        metric,
        date: heatDate?.value || '2026-01-15',
        minutes: heatTime?.value || '720',
      });
      const response = await fetch(`${windApi}/heat/zones?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (loadToken !== heatLoadToken) return;
      heatPayload = payload;
      if (heatToggle?.checked && !shadowState.enabled) buildHeatMesh(payload);
      renderHeatSummary(payload.summary, payload.metric_metadata, payload.metric_label);
      const range = payload.color_range || payload.range;
      heatRange = range;
      const scale = payload.color_scale || {};
      heatLegendMin.textContent = range
        ? `${scale.bottom_band_label || 'Bottom 10%'} ≤ ${formatHeatValue(range.min, payload.metric_metadata)}`
        : 'Bottom 10%';
      heatLegendMax.textContent = range
        ? `${scale.top_band_label || 'Top 10%'} ≥ ${formatHeatValue(range.max, payload.metric_metadata)}`
        : 'Top 10%';
      const rawWindow = payload.window?.label;
      const window = rawWindow === 'summer_2025_2026' ? 'Summer 2025–26' : rawWindow || 'Summer 2025–26';
      const scenarioMinutes = Number(payload.scenario?.minutes ?? 720);
      const scenarioTime = `${String(Math.floor(scenarioMinutes / 60)).padStart(2, '0')}:${String(scenarioMinutes % 60).padStart(2, '0')}`;
      const timeContext = ['shade_deficit_score', 'pedestrian_priority_score'].includes(payload.metric) ? `${scenarioTime} · ` : '';
      heatStatus.textContent = `${timeContext}${payload.count || payload.features?.length || 0} zones · ${window}`;
    } catch (error) {
      if (loadToken !== heatLoadToken) return;
      renderHeatSummary(null);
      heatStatus.textContent = `Heat data unavailable (${error.message})`;
    }
    setHeatMode(Boolean(heatToggle?.checked));
  }

  async function generateSunHours() {
    if (!sunToggle?.checked) sunToggle.checked = true;
    setShadowMode(true);
    cancelSunHours('', false);
    const loadToken = ++sunLoadToken;
    const controller = new AbortController();
    sunAbortController = controller;
    sunAnalysisId = crypto.randomUUID();
    sunStatus.textContent = 'Accumulating direct sunlight…';
    sunGenerate.disabled = true;
    sunGenerate.textContent = 'Calculating…';
    if (sunProgress) {
      sunProgress.hidden = false;
      sunProgress.removeAttribute('value');
    }
    try {
      const scenario = {
        date: sunDate?.value || shadowState.date,
        start_minutes: sunStartTime?.value || '480', end_minutes: sunEndTime?.value || '1080',
        step_minutes: sunStepTime?.value || '60',
      };
      const surfaces = sunAnalysisSurfaces?.value || 'all';
      const half = shadowState.size / 2;
      const domain = {
        min_x: shadowState.center[0] - half, min_z: shadowState.center[1] - half,
        max_x: shadowState.center[0] + half, max_z: shadowState.center[1] + half,
      };
      const durationHours = (Number(scenario.end_minutes) - Number(scenario.start_minutes)) / 60;
      const requestFactories = [];
      if (surfaces !== 'buildings') {
        requestFactories.push(() => fetch(`${windApi}/heat/zones?${new URLSearchParams({ metric: 'cumulative_sun_hours', ...scenario, ...domain })}`, { signal: controller.signal })
          .then(async response => {
            if (!response.ok) throw new Error((await response.json()).detail || `HTTP ${response.status}`);
            return ['ground', await response.json()];
          }));
      }
      if (surfaces !== 'ground') {
        const buildingParams = new URLSearchParams({
          ...scenario, ...domain, resolution_m: sunSurfaceResolution?.value || '5',
          surfaces: 'all', analysis_id: sunAnalysisId,
        });
        requestFactories.push(() => fetch(`${windApi}/sunlight/building-surfaces?${buildingParams}`, { signal: controller.signal })
          .then(async response => {
            const body = await response.json();
            if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
            return ['buildings', body];
          }));
      }
      let completed = 0;
      const requests = requestFactories.map(factory => factory().then(result => {
        completed += 1;
        if (loadToken === sunLoadToken && sunProgress) {
          sunProgress.value = completed / requestFactories.length * 100;
          sunStatus.textContent = completed < requestFactories.length
            ? `Sunlight surfaces ${completed}/${requestFactories.length} ready…`
            : 'Building the sunlight map…';
        }
        return result;
      }));
      const results = Object.fromEntries(await Promise.all(requests));
      if (loadToken !== sunLoadToken || !shadowState.enabled || shadowState.mode !== 'hours') return;
      const payload = results.ground || {
        metric: 'cumulative_sun_hours', features: [], range: { min: 0, max: durationHours },
        color_range: { min: 0, max: durationHours }, summary: { area_weighted_mean: null, total_area_m2: 0 },
        scenario: { ...scenario, sample_count: 0 },
      };
      payload.color_range = { min: 0, max: durationHours };
      buildHeatMesh(payload);
      if (results.buildings) addBuildingSunMesh(results.buildings, payload.color_range);
      setBuildingAnalysisSkin(Boolean(results.buildings));
      heatGroup.visible = true;
      sunLight.visible = false;
      shadowCatcher.visible = false;
      const range = payload.color_range || payload.range;
      if (range) {
        sunHoursMin.textContent = `${range.min.toFixed(1)} h`;
        sunHoursMax.textContent = `${range.max.toFixed(1)} h`;
      }
      const start = Number(scenario.start_minutes);
      const end = Number(scenario.end_minutes);
      const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
      const summaries = [payload.summary, results.buildings?.summary].filter(summary => summary?.area_weighted_mean != null);
      const totalArea = summaries.reduce((sum, summary) => sum + Number(summary.total_area_m2 || 0), 0);
      const average = totalArea ? summaries.reduce((sum, summary) => sum + summary.area_weighted_mean * summary.total_area_m2, 0) / totalArea : 0;
      const cellCount = results.buildings?.count ? ` · ${results.buildings.count.toLocaleString()} building cells` : '';
      sunStatus.textContent = `${average.toFixed(1)} h average direct sun · ${clock(start)}–${clock(end)} · ${shadowState.size} m area${cellCount}.`;
    } catch (error) {
      if (loadToken !== sunLoadToken) return;
      if (error.name === 'AbortError') return;
      sunStatus.textContent = `Sun-hours analysis unavailable (${error.message})`;
    } finally {
      if (loadToken === sunLoadToken) {
        sunAbortController = null;
        sunAnalysisId = null;
        sunGenerate.disabled = false;
        sunGenerate.textContent = 'Calculate sun hours';
        if (sunProgress) {
          sunProgress.hidden = true;
          sunProgress.removeAttribute('value');
        }
        requestRender();
      }
    }
  }

  function addBuildingSunMesh(payload, range) {
    const positions = [];
    const colors = [];
    const pushTriangle = (a, b, c, color) => {
      positions.push(...a, ...b, ...c);
      for (let vertex = 0; vertex < 3; vertex += 1) colors.push(color.r, color.g, color.b);
    };
    for (const feature of payload.features || []) {
      const value = feature.display_value ?? feature.value;
      if (value == null) continue;
      const color = heatColor(value, range.min, range.max, 'cumulative_sun_hours');
      if (feature.surface === 'roof') {
        const y = Number(feature.surface_y) + 0.08;
        for (const polygon of geometryPolygons(feature.geometry)) {
          const contour = polygon[0].map(([x, z]) => new THREE.Vector2(x, z));
          const holes = polygon.slice(1).map(ring => ring.map(([x, z]) => new THREE.Vector2(x, z)));
          const vertices = contour.concat(...holes);
          for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
            pushTriangle([vertices[a].x, y, vertices[a].y], [vertices[b].x, y, vertices[b].y], [vertices[c].x, y, vertices[c].y], color);
          }
        }
      } else if (feature.surface === 'facade' && feature.vertices?.length >= 4) {
        const vertices = feature.vertices.map(([x, y, z]) => [x, y, z]);
        pushTriangle(vertices[0], vertices[1], vertices[2], color);
        pushTriangle(vertices[0], vertices[2], vertices[3], color);
      }
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.94, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    mesh.renderOrder = 7;
    heatGroup.add(mesh);
  }

  function setSunAnalysisMode(mode) {
    cancelSunHours('', true);
    shadowState.mode = mode;
    const cumulative = mode === 'hours';
    for (const button of sunModeButtons) {
      const active = button.dataset.sunMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (sunInstantControl) sunInstantControl.hidden = cumulative;
    if (sunWindowControls) sunWindowControls.hidden = !cumulative;
    if (sunDateTimeHeading) sunDateTimeHeading.textContent = cumulative ? 'Date & analysis window' : 'Date & time';
    if (sunHoursLegend) sunHoursLegend.hidden = !cumulative;
    sunGenerate.textContent = cumulative ? 'Calculate sun hours' : 'Generate shadows';
    heatGroup.visible = false;
    setBuildingAnalysisSkin(false);
    shadowState.generated = false;
    setSunMaterials(false);
    sunStatus.textContent = cumulative
      ? 'Move the analysis area if needed, then calculate cumulative direct sunlight.'
      : 'Choose a date and time, then generate terrain-aware shadows.';
    requestRender();
    updateSunBox();
  }

  function setHeatMode(enabled) {
    if (enabled) restoreStreetLayersAfterWind();
    const wasInStudyMode = shadowState.enabled || heatGroup.visible;
    if (enabled && !wasInStudyMode) rememberNormalVisibility();
    if (enabled && shadowState.enabled) {
      cancelSunHours('', false);
    }
    if (enabled && analysisGroupMode !== 'heat') {
      if (heatPayload) buildHeatMesh(heatPayload);
      else {
        for (const object of heatGroup.children) disposeObject(object);
        heatGroup.clear();
        analysisGroupMode = null;
      }
    }
    heatGroup.visible = enabled && analysisGroupMode === 'heat';
    document.body.classList.toggle('heat-mode', enabled);
    if (enabled) {
      shadowState.enabled = false;
      if (sunToggle) sunToggle.checked = false;
      document.body.classList.remove('sun-mode');
      const rooftopContext = heatMetric?.value === 'rooftop_temperature_c';
      // Keep the terrain slab visible beneath the transparent heat surface so
      // its cut edge reads with the same depth as every other analysis mode.
      layerGroups.terrain.visible = true;
      layerGroups.grass.visible = rooftopContext;
      layerGroups.railways.visible = false;
      // Keep the walking network faintly legible so priority areas can be
      // interpreted as routes and crossings, not isolated heat polygons.
      layerGroups.paths.visible = rooftopContext;
      layerGroups.roads.visible = rooftopContext;
      layerGroups.buildings.visible = true;
      layerGroups.trees.visible = true;
      windState.enabled = false;
      if (windToggle) windToggle.checked = false;
      windGroup.visible = false;
      trafficState.enabled = false;
      if (trafficToggle) trafficToggle.checked = false;
      trafficGroup.visible = false;
      setSunMaterials(false);
    } else if (!shadowState.enabled) {
      restoreNormalVisibility();
      windState.enabled = Boolean(windToggle?.checked);
      windGroup.visible = windState.enabled;
      trafficState.enabled = Boolean(trafficToggle?.checked);
      syncTrafficSceneVisibility();
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
            const fallbackY = Number(feature.surface_y ?? terrainHeightAt(point.x, point.y) + 0.62);
            positions.push(
              point.x,
              feature.surface_y != null ? detailedRoofHeightAt(point.x, point.y, fallbackY) : fallbackY,
              point.y,
            );
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

  const trafficPlaybackSpeed = 10; // simulated seconds advanced per real second
  // Vehicles are released over the first 70% of the run, so simulated t=0 is
  // an empty street that takes tens of real seconds to fill. Start playback
  // once the corridor is already loaded, and rewind to the same point rather
  // than to 0, so switching between before/after compares like with like.
  const trafficWarmStartFraction = 0.45;
  const trafficMaxCars = 900;
  // Free-flow reference for the speed colour ramp. 13.9 m/s is 50 km/h, the
  // CBD limit, so a car at the limit renders green and a stationary one red.
  const trafficFreeFlowMps = 13.9;
  const carMatrix = new THREE.Matrix4();
  const carQuaternion = new THREE.Quaternion();
  const carPosition = new THREE.Vector3();
  const carScale = new THREE.Vector3(1, 1, 1);
  const carColor = new THREE.Color();
  const carUp = new THREE.Vector3(0, 1, 0);

  function visiblePolyline(points) {
    if (!points || points.length < 2) return [];
    const parts = [];
    let current = [];
    const pushCurrent = () => {
      if (current.length >= 2) parts.push(current);
      current = [];
    };
    for (let index = 0; index < points.length - 1; index += 1) {
      const [x0, z0] = points[index];
      const [x1, z1] = points[index + 1];
      const length = Math.hypot(x1 - x0, z1 - z0);
      const samples = Math.max(1, Math.ceil(length / 4));
      for (let sample = 0; sample <= samples; sample += 1) {
        const ratio = sample / samples;
        const x = x0 + (x1 - x0) * ratio;
        const z = z0 + (z1 - z0) * ratio;
        if (terrainValidAt(x, z)) {
          const previous = current[current.length - 1];
          if (!previous || Math.hypot(previous[0] - x, previous[1] - z) > 0.01) current.push([x, z]);
        } else {
          pushCurrent();
        }
      }
    }
    pushCurrent();
    return parts.sort((left, right) => right.length - left.length);
  }

  function statusRibbon(points, width, color, opacity = 0.9, elevation = 0.66, xray = false) {
    points = visiblePolyline(points)[0];
    if (!points || points.length < 2) return null;
    const vertices = [];
    const indices = [];
    for (let index = 0; index < points.length; index += 1) {
      const [x, z] = points[index];
      const previous = points[Math.max(0, index - 1)];
      const next = points[Math.min(points.length - 1, index + 1)];
      const dx = next[0] - previous[0];
      const dz = next[1] - previous[1];
      const length = Math.hypot(dx, dz) || 1;
      const nx = -dz / length * width * 0.5;
      const nz = dx / length * width * 0.5;
      const leftX = x + nx, leftZ = z + nz;
      const rightX = x - nx, rightZ = z - nz;
      vertices.push(
        leftX, terrainHeightAt(leftX, leftZ) + elevation, leftZ,
        rightX, terrainHeightAt(rightX, rightZ) + elevation, rightZ,
      );
      if (index > 0) {
        const previousLeft = (index - 1) * 2;
        const previousRight = previousLeft + 1;
        const left = index * 2;
        const right = left + 1;
        indices.push(previousLeft, previousRight, left, previousRight, right, left);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      color, transparent: opacity < 1, opacity, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.NormalBlending, depthTest: !xray,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 9;
    return mesh;
  }

  function pointsAlongLine(points, spacing = 12) {
    const sampled = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const [x0, z0] = points[index];
      const [x1, z1] = points[index + 1];
      const length = Math.hypot(x1 - x0, z1 - z0);
      const count = Math.max(1, Math.floor(length / spacing));
      for (let step = 0; step < count; step += 1) {
        const ratio = step / count;
        sampled.push([x0 + (x1 - x0) * ratio, z0 + (z1 - z0) * ratio]);
      }
    }
    sampled.push(points[points.length - 1]);
    return sampled;
  }

  function clearStatusGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      disposeObject(child);
    }
  }

  function appendDirectionArrow(vertices, x, z, dx, dz, lateral = 0) {
    const length = Math.hypot(dx, dz) || 1;
    const tx = dx / length, tz = dz / length;
    const nx = -tz, nz = tx;
    const centerX = x + nx * lateral;
    const centerZ = z + nz * lateral;
    const tipX = centerX + tx * 5.2, tipZ = centerZ + tz * 5.2;
    const backX = centerX - tx * 3.6, backZ = centerZ - tz * 3.6;
    const elevation = terrainHeightAt(centerX, centerZ) + 0.88;
    vertices.push(
      tipX, elevation, tipZ,
      backX + nx * 2.7, elevation, backZ + nz * 2.7,
      backX - nx * 2.7, elevation, backZ - nz * 2.7,
    );
  }

  function buildSelectedRoadDirections(road) {
    clearStatusGroup(selectedRoadDirectionGroup);
    if (!road) return;
    const arrowVertices = [];
    for (const segment of road.direction_segments || []) {
      const points = visiblePolyline(segment.points || [])[0] || [];
      const guide = statusRibbon(points, segment.direction === 'oneway' ? 1.3 : 0.8, 0xe8fbff, 0.32, 0.73, true);
      if (guide) selectedRoadDirectionGroup.add(guide);
      for (let index = 0; index < points.length - 1; index += 1) {
        const [x0, z0] = points[index];
        const [x1, z1] = points[index + 1];
        const dx = x1 - x0, dz = z1 - z0;
        const distance = Math.hypot(dx, dz);
        if (distance < 5) continue;
        const arrowCount = Math.max(1, Math.floor(distance / 48));
        for (let arrow = 0; arrow < arrowCount; arrow += 1) {
          const ratio = (arrow + 0.5) / arrowCount;
          const x = x0 + dx * ratio, z = z0 + dz * ratio;
          if (segment.direction === 'oneway') {
            appendDirectionArrow(arrowVertices, x, z, dx, dz, 0);
          } else {
            appendDirectionArrow(arrowVertices, x, z, dx, dz, -1.8);
            appendDirectionArrow(arrowVertices, x, z, -dx, -dz, 1.8);
          }
        }
      }
    }
    if (arrowVertices.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrowVertices, 3));
      const arrows = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0xf2fdff, transparent: true, opacity: 0.92,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      }));
      arrows.renderOrder = 11;
      selectedRoadDirectionGroup.add(arrows);
    }
    selectedRoadDirectionGroup.name = `${road.name}-directions`;
  }

  function buildPermanentRoadStatuses(statuses) {
    clearStatusGroup(permanentStatusGroup);
    for (const statusItem of statuses || []) {
      const halo = statusRibbon(statusItem.points, 4.2, 0x568b87, 0.08, 0.59);
      const core = statusRibbon(statusItem.points, 1.6, 0x82aaa5, 0.34, 0.64);
      if (halo) permanentStatusGroup.add(halo);
      if (core) permanentStatusGroup.add(core);
    }
    permanentStatusGroup.name = 'permanent-pedestrian-streets';
  }

  function buildLiveRoadClosures(sampledRoads) {
    clearStatusGroup(liveClosureGroup);
    for (const sample of sampledRoads || []) {
      if (!sample.road_closure) continue;
      const road = trafficState.roadsByName.get(sample.name);
      for (const points of road?.geometry_local || []) {
        const halo = statusRibbon(points, 9, 0xff2d2d, 0.24, 0.70);
        const core = statusRibbon(points, 4.2, 0xff514c, 0.95, 0.76);
        if (halo) liveClosureGroup.add(halo);
        if (core) liveClosureGroup.add(core);
      }
    }
    liveClosureGroup.name = 'live-road-closures';
  }

  function lineMidpoint(points) {
    const lengths = [];
    let total = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const length = Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]);
      lengths.push(length);
      total += length;
    }
    let target = total * 0.5;
    for (let index = 0; index < lengths.length; index += 1) {
      if (target <= lengths[index]) {
        const ratio = lengths[index] ? target / lengths[index] : 0;
        return [
          points[index][0] + (points[index + 1][0] - points[index][0]) * ratio,
          points[index][1] + (points[index + 1][1] - points[index][1]) * ratio,
        ];
      }
      target -= lengths[index];
    }
    return points[Math.floor(points.length / 2)];
  }

  function closureLabel(lines, mode, roadName) {
    if (!lines.length) return null;
    const longest = [...lines].sort((a, b) => pointsAlongLine(b, 5).length - pointsAlongLine(a, 5).length)[0];
    const [x, z] = lineMidpoint(longest);
    const canvasLabel = document.createElement('canvas');
    canvasLabel.width = 768;
    canvasLabel.height = 192;
    const context = canvasLabel.getContext('2d');
    context.fillStyle = mode === 'full' ? '#d92f2b' : '#d97b18';
    context.fillRect(0, 0, canvasLabel.width, canvasLabel.height);
    context.strokeStyle = '#fff4df';
    context.lineWidth = 12;
    context.strokeRect(8, 8, canvasLabel.width - 16, canvasLabel.height - 16);
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '900 68px sans-serif';
    context.fillText(mode === 'full' ? 'ROAD CLOSED' : 'LANE CLOSED', canvasLabel.width / 2, 72);
    context.font = '700 34px sans-serif';
    context.fillText(roadName || 'Selected section', canvasLabel.width / 2, 142);
    const texture = new THREE.CanvasTexture(canvasLabel);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false,
    });
    const label = new THREE.Sprite(material);
    label.position.set(x, terrainHeightAt(x, z) + 28, z);
    label.scale.set(76, 19, 1);
    label.renderOrder = 20;
    label.userData.closurePulse = true;
    label.userData.baseWidth = 76;
    label.userData.baseHeight = 19;
    return label;
  }

  function addClosureFurniture(lines, mode, roadName) {
    const positions = lines.flatMap(points => pointsAlongLine(points, mode === 'full' ? 10 : 14));
    if (!positions.length) return;
    const geometry = new THREE.ConeGeometry(0.72, 2.6, 10);
    geometry.translate(0, 1.3, 0);
    const material = new THREE.MeshBasicMaterial({
      color: mode === 'full' ? 0xff584f : 0xffa62f,
      depthTest: false,
    });
    const cones = new THREE.InstancedMesh(geometry, material, Math.min(positions.length, 500));
    const matrix = new THREE.Matrix4();
    positions.slice(0, 500).forEach(([x, z], index) => {
      matrix.makeTranslation(x, terrainHeightAt(x, z) + 0.62, z);
      cones.setMatrixAt(index, matrix);
    });
    cones.renderOrder = 12;
    scenarioStatusGroup.add(cones);

    const endpoints = lines.flatMap(points => [points[0], points[points.length - 1]]);
    const beaconGeometry = new THREE.CylinderGeometry(0.42, 0.9, 18, 12);
    const beaconMaterial = new THREE.MeshBasicMaterial({
      color: mode === 'full' ? 0xff3e38 : 0xffb02e,
      transparent: true, opacity: 0.72, depthTest: false,
    });
    const beacons = new THREE.InstancedMesh(beaconGeometry, beaconMaterial, endpoints.length);
    endpoints.forEach(([x, z], index) => {
      matrix.makeTranslation(x, terrainHeightAt(x, z) + 9.5, z);
      beacons.setMatrixAt(index, matrix);
    });
    beacons.renderOrder = 13;
    scenarioStatusGroup.add(beacons);

    const barrierRed = new THREE.MeshBasicMaterial({ color: 0xf13f37, depthTest: false });
    const barrierWhite = new THREE.MeshBasicMaterial({ color: 0xfff4df, depthTest: false });
    const barrierWidth = mode === 'full' ? 11 : 3.4;
    const stripePositions = mode === 'full' ? [-4, -1.35, 1.35, 4] : [-1.05, 0, 1.05];
    const legPositions = mode === 'full' ? [-4.3, 4.3] : [-1.25, 1.25];
    for (const points of lines) {
      if (points.length < 2) continue;
      const ends = [
        { point: points[0], neighbour: points[1] },
        { point: points[points.length - 1], neighbour: points[points.length - 2] },
      ];
      for (const { point, neighbour } of ends) {
        const [x, z] = point;
        const dx = neighbour[0] - x, dz = neighbour[1] - z;
        const barrier = new THREE.Group();
        const panel = new THREE.Mesh(new THREE.BoxGeometry(barrierWidth, 2.4, 0.8), barrierRed.clone());
        panel.position.y = 2.5;
        barrier.add(panel);
        for (const stripeX of stripePositions) {
          const stripe = new THREE.Mesh(new THREE.BoxGeometry(mode === 'full' ? 1.25 : 0.52, 2.5, 0.86), barrierWhite.clone());
          stripe.position.set(stripeX, 2.5, 0);
          barrier.add(stripe);
        }
        for (const legX of legPositions) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.65, 4.8, 0.65), barrierRed.clone());
          leg.position.set(legX, 0.3, 0);
          barrier.add(leg);
        }
        barrier.position.set(x, terrainHeightAt(x, z) + 0.7, z);
        barrier.rotation.y = Math.atan2(dx, dz);
        barrier.renderOrder = 16;
        scenarioStatusGroup.add(barrier);
      }
    }
    barrierRed.dispose();
    barrierWhite.dispose();

    const label = closureLabel(lines, mode, roadName);
    if (label) scenarioStatusGroup.add(label);
  }

  function buildScenarioRoadStatuses(payload) {
    clearStatusGroup(scenarioStatusGroup);
    const closureLines = (payload?.closure?.geometry_local || [])
      .flatMap(points => visiblePolyline(points))
      .filter(points => points.length >= 2);
    const isFull = payload?.closure_mode === 'full';
    for (const points of closureLines) {
      const halo = statusRibbon(points, isFull ? 10 : 4.6, isFull ? 0xff342f : 0xff9d27, isFull ? 0.25 : 0.2, 0.69, true);
      const closure = statusRibbon(points, isFull ? 6.5 : 2.3, isFull ? 0xff4b45 : 0xffbd45, 0.95, 0.75, true);
      if (halo) scenarioStatusGroup.add(halo);
      if (closure) scenarioStatusGroup.add(closure);
      if (isFull) {
        const pedestrianCore = statusRibbon(points, 4.2, 0x2be0ad, 0.92, 0.79, true);
        if (pedestrianCore) scenarioStatusGroup.add(pedestrianCore);
      }
    }
    addClosureFurniture(closureLines, payload?.closure_mode, payload?.road_name);

    // Derived from the actual closed-edge topology, not the `one_way`
    // request flag -- covers the dedicated "one-way" drawing tool too,
    // which submits a plain full closure with no such flag.
    const remainingOpenLines = (payload?.closure?.remaining_open_geometry_local || [])
      .flatMap(points => visiblePolyline(points))
      .filter(points => points.length >= 2);
    for (const points of remainingOpenLines) {
      const halo = statusRibbon(points, 8, 0x2f6bff, 0.22, 0.68, true);
      const open = statusRibbon(points, 5, 0x4f8bff, 0.9, 0.74, true);
      if (halo) scenarioStatusGroup.add(halo);
      if (open) scenarioStatusGroup.add(open);
    }

    for (const segment of payload?.flow_comparison || []) {
      const delta = Number(segment.vehicle_delta) || 0;
      const halted = Number(segment.closure_halted) || 0;
      const magnitude = Math.min(1, Math.abs(delta) / 3 + halted / 5);
      const color = delta >= 0 ? (halted > 1 ? 0xff4a35 : 0xffa033) : 0x42c8ff;
      const ribbon = statusRibbon(segment.points, 0.8 + magnitude * 2.8, color, 0.4 + magnitude * 0.48, 0.71);
      if (ribbon) {
        ribbon.userData.flowPulse = true;
        ribbon.userData.baseOpacity = ribbon.material.opacity;
        scenarioStatusGroup.add(ribbon);
      }
    }
    scenarioStatusGroup.name = 'simulated-closure-and-diversions';
    syncTrafficSceneVisibility();
  }

  function buildTrafficSnapIndex(edges) {
    trafficState.snapGrid = new Map();
    const cellSize = trafficState.snapCellSize;
    const radius = trafficState.snapRadius;
    const add = (column, row, segment) => {
      const key = `${column}:${row}`;
      if (!trafficState.snapGrid.has(key)) trafficState.snapGrid.set(key, []);
      trafficState.snapGrid.get(key).push(segment);
    };
    for (const edge of edges) {
      // Lane mode must snap to the offset SUMO lane which will actually be
      // closed. Using a shared municipal centreline here made two opposing
      // carriageways indistinguishable and made it impossible to reliably
      // ask for one closed lane in each direction.
      const snapPaths = [
        { points: edge.lane_points, mode: 'lane' },
        { points: edge.snap_points, mode: 'full' },
        { points: edge.points, mode: 'full' },
      ].filter(path => path.points?.length >= 2);
      for (const path of snapPaths) {
        const snapPoints = path.points;
        for (let index = 0; index < snapPoints.length - 1; index += 1) {
          const a = snapPoints[index], b = snapPoints[index + 1];
          const segment = { edge, a, b, mode: path.mode };
          const minColumn = Math.floor((Math.min(a[0], b[0]) - radius) / cellSize);
          const maxColumn = Math.floor((Math.max(a[0], b[0]) + radius) / cellSize);
          const minRow = Math.floor((Math.min(a[1], b[1]) - radius) / cellSize);
          const maxRow = Math.floor((Math.max(a[1], b[1]) + radius) / cellSize);
          for (let column = minColumn; column <= maxColumn; column += 1) {
            for (let row = minRow; row <= maxRow; row += 1) add(column, row, segment);
          }
        }
      }
    }
  }

  function snapToTrafficRoad(x, z, preferredName = null, previousEdgeId = null) {
    const cellSize = trafficState.snapCellSize;
    const column = Math.floor(x / cellSize), row = Math.floor(z / cellSize);
    const candidates = trafficState.snapGrid.get(`${column}:${row}`) || [];
    let nearest = null;
    for (const candidate of candidates) {
      if (candidate.mode !== trafficState.closureMode) continue;
      const dx = candidate.b[0] - candidate.a[0];
      const dz = candidate.b[1] - candidate.a[1];
      const denominator = dx * dx + dz * dz || 1;
      const ratio = clamp(((x - candidate.a[0]) * dx + (z - candidate.a[1]) * dz) / denominator, 0, 1);
      const snappedX = candidate.a[0] + dx * ratio;
      const snappedZ = candidate.a[1] + dz * ratio;
      const distance = Math.hypot(x - snappedX, z - snappedZ);
      // Keep a freehand stroke on the road it is already following when it
      // passes through a junction. At a corner, the perpendicular road is
      // often fractionally closer than the intended carriageway; name and
      // continuity penalties make that choice stable without disabling turns.
      const sameName = preferredName && trafficEdgeName(candidate.edge) === preferredName;
      const sameEdge = previousEdgeId && candidate.edge.id === previousEdgeId;
      const score = distance + (preferredName && !sameName ? 7 : 0) - (sameEdge ? 2 : 0);
      if (!nearest || score < nearest.score) {
        nearest = { x: snappedX, z: snappedZ, distance, score, edge: candidate.edge };
      }
    }
    return nearest && nearest.distance <= trafficState.snapRadius ? nearest : null;
  }

  function nearbyFullOnlyRoad(points, radius = trafficState.snapRadius) {
    // Lane mode has no snap candidates on a single-lane-per-direction edge
    // (removing its only lane would sever the road, not narrow it) -- this
    // covers most of the unsealed/paved-surface minor streets and access
    // lanes in the network, not just one specific road. Finding the nearest
    // such road along a lane-mode stroke lets the status message say why it
    // can't be selected here, instead of leaving the user guessing -- or
    // worse, silently landing on a different, unrelated road instead (see
    // the caller in commitTrafficStroke).
    const cellSize = trafficState.snapCellSize;
    let nearest = null;
    for (const [x, z] of points) {
      const column = Math.floor(x / cellSize), row = Math.floor(z / cellSize);
      const candidates = trafficState.snapGrid.get(`${column}:${row}`) || [];
      for (const candidate of candidates) {
        if (candidate.mode !== 'full' || Number(candidate.edge.lane_count) >= 2) continue;
        const dx = candidate.b[0] - candidate.a[0];
        const dz = candidate.b[1] - candidate.a[1];
        const denominator = dx * dx + dz * dz || 1;
        const ratio = clamp(((x - candidate.a[0]) * dx + (z - candidate.a[1]) * dz) / denominator, 0, 1);
        const snappedX = candidate.a[0] + dx * ratio;
        const snappedZ = candidate.a[1] + dz * ratio;
        const distance = Math.hypot(x - snappedX, z - snappedZ);
        if (distance <= radius && (!nearest || distance < nearest.distance)) {
          nearest = { distance, edge: candidate.edge };
        }
      }
    }
    return nearest;
  }

  function snapToSelectedTrafficRoad(x, z) {
    const selected = new Set(trafficState.selectedEdgeIds);
    if (!selected.size) return null;
    const cellSize = trafficState.snapCellSize;
    const column = Math.floor(x / cellSize), row = Math.floor(z / cellSize);
    let nearest = null;
    // Search neighbouring cells as well as the pointer cell so a right-click
    // near a grid boundary still removes the intended selected section.
    for (let dxCell = -1; dxCell <= 1; dxCell += 1) {
      for (let dzCell = -1; dzCell <= 1; dzCell += 1) {
        const candidates = trafficState.snapGrid.get(`${column + dxCell}:${row + dzCell}`) || [];
        for (const candidate of candidates) {
          if (!selected.has(candidate.edge.id)) continue;
          const dx = candidate.b[0] - candidate.a[0];
          const dz = candidate.b[1] - candidate.a[1];
          const denominator = dx * dx + dz * dz || 1;
          const ratio = clamp(((x - candidate.a[0]) * dx + (z - candidate.a[1]) * dz) / denominator, 0, 1);
          const snappedX = candidate.a[0] + dx * ratio;
          const snappedZ = candidate.a[1] + dz * ratio;
          const distance = Math.hypot(x - snappedX, z - snappedZ);
          if (!nearest || distance < nearest.distance) {
            nearest = { distance, edge: candidate.edge };
          }
        }
      }
    }
    return nearest && nearest.distance <= trafficState.snapRadius ? nearest : null;
  }

  function removeTrafficSelectionAt(event) {
    if (trafficState.stroking || !trafficState.selectedEdgeIds.length) return false;
    const point = pointerGround(event);
    if (!point) return false;
    const nearest = snapToSelectedTrafficRoad(point.x, point.z);
    if (!nearest) return false;
    const removedId = nearest.edge.id;
    trafficState.selectedEdgeIds = trafficState.selectedEdgeIds.filter(edgeId => edgeId !== removedId);
    if (trafficState.result) invalidateTrafficResult('Selection changed · run the comparison again.');
    updateTrafficDrawing();
    const count = trafficState.selectedEdgeIds.length;
    if (trafficSelectionStatus) {
      trafficSelectionStatus.textContent = count
        ? `Removed 1 road section · ${count} ${count === 1 ? 'section' : 'sections'} remain selected.`
        : 'Selection cleared · draw a new closure to begin.';
    }
    if (trafficStatus) trafficStatus.textContent = trafficState.drawing
      ? (count ? `Editing ${trafficSelectionLabel()} · confirm when finished.` : 'Draw at least one road section, then confirm.')
      : (count ? `${trafficSelectionLabel()} selected · adjust the scenario or simulate the closure.` : 'Draw a closure to begin.');
    if (trafficRun) trafficRun.disabled = !count;
    updateTrafficDrawPopup(count
      ? 'Section removed. Continue drawing or confirm the selection.'
      : 'Selection is empty. Draw another freehand stroke to continue.');
    if (trafficState.drawing && trafficRun) trafficRun.disabled = true;
    updateTrafficInterventionControls();
    return true;
  }

  function trafficEdgeName(edge) {
    return edge?.name && edge.name !== 'Unnamed road'
      ? edge.name
      : edge?.official?.name || `edge:${edge?.id || 'unknown'}`;
  }

  function trafficSelectionLabel() {
    const names = [...new Set(trafficState.selectedEdgeIds
      .map(edgeId => trafficState.edgesById.get(edgeId)?.name)
      .filter(name => name && name !== 'Unnamed road'))];
    return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '') || 'Selected road section';
  }

  function trafficSelectionDetails() {
    const selected = trafficState.selectedEdgeIds
      .map(edgeId => trafficState.edgesById.get(edgeId))
      .filter(Boolean);
    const official = selected.map(edge => edge.official).filter(Boolean);
    if (!official.length) return 'SUMO/OSM road attributes';
    const lanes = [...new Set(official.map(item => Number(item.lanes)).filter(Number.isFinite))];
    const speeds = [...new Set(official.map(item => Number(item.speed_limit_kph)).filter(Number.isFinite))];
    const classes = [...new Set(official.map(item => item.road_class).filter(Boolean))];
    const details = [];
    if (lanes.length === 1) details.push(`${lanes[0]} municipal ${lanes[0] === 1 ? 'lane' : 'lanes'}`);
    else if (lanes.length > 1) details.push(`${Math.min(...lanes)}–${Math.max(...lanes)} municipal lanes`);
    if (speeds.length === 1) details.push(`${speeds[0]} km/h ${official.some(item => item.speed_limit_source === 'Confirmed') ? 'confirmed' : 'mapped'} limit`);
    if (classes.length === 1) details.push(classes[0]);
    if (official.some(item => item.bus_route)) details.push('bus route');
    details.push(`${official.length}/${selected.length} sections matched to City road-centre data`);
    return details.join(' · ');
  }

  function trafficSelectionEffect() {
    const edges = trafficState.selectedEdgeIds
      .map(edgeId => trafficState.edgesById.get(edgeId))
      .filter(Boolean);
    if (trafficState.closureMode === 'full') {
      const lanes = edges.reduce((total, edge) => total + (Number(edge.lane_count) || 0), 0);
      return `${lanes} ${lanes === 1 ? 'lane' : 'lanes'} closed across ${edges.length} road ${edges.length === 1 ? 'section' : 'sections'}`;
    }
    const narrowed = edges.filter(edge => Number(edge.lane_count) >= 2).length;
    const skipped = edges.length - narrowed;
    return `${narrowed} kerbside ${narrowed === 1 ? 'lane' : 'lanes'} closed across ${narrowed} directional ${narrowed === 1 ? 'section' : 'sections'}`
      + (skipped ? ` · ${skipped} single-lane ${skipped === 1 ? 'section is' : 'sections are'} not closable in lane mode` : '');
  }

  function trafficSelectionReverseIds() {
    // Only offers a flip when every selected section has a real
    // opposite-direction sibling to swap onto -- an ordinary two-way street
    // (one lane each way, like most residential blocks) is modelled as two
    // such edges, so this is how the user picks which way stays open.
    if (!trafficState.selectedEdgeIds.length) return null;
    const reverseIds = trafficState.selectedEdgeIds.map(edgeId => trafficState.edgesById.get(edgeId)?.reverse_edge_id);
    return reverseIds.every(Boolean) ? reverseIds : null;
  }

  function updateTrafficInterventionControls() {
    if (trafficOneWayRow) trafficOneWayRow.hidden = trafficState.closureMode !== 'lane';
    if (trafficFlipDirection) {
      trafficFlipDirection.hidden = !trafficSelectionReverseIds();
      trafficFlipDirection.textContent = trafficState.oneWayIntent
        ? '⇄ Reverse which way traffic flows'
        : '⇄ Close the other direction instead';
    }
  }

  function trafficJunctionBridges(edges, maximumGap = 48) {
    const bridges = [];
    const seen = new Set();
    const endpoint = (points, atStart) => {
      const point = atStart ? points[0] : points.at(-1);
      const neighbour = atStart ? points[1] : points.at(-2);
      return { point, neighbour };
    };
    for (let firstIndex = 0; firstIndex < edges.length; firstIndex += 1) {
      const first = edges[firstIndex];
      if (!first?.points || first.points.length < 2) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < edges.length; secondIndex += 1) {
        const second = edges[secondIndex];
        if (!second?.points || second.points.length < 2) continue;
        if (trafficEdgeName(first) !== trafficEdgeName(second)) continue;
        let best = null;
        for (const firstAtStart of [true, false]) {
          for (const secondAtStart of [true, false]) {
            const a = endpoint(first.points, firstAtStart);
            const b = endpoint(second.points, secondAtStart);
            const gap = Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]);
            if (gap < 0.75 || gap > maximumGap) continue;
            const ax = a.point[0] - a.neighbour[0], az = a.point[1] - a.neighbour[1];
            const bx = b.neighbour[0] - b.point[0], bz = b.neighbour[1] - b.point[1];
            const lengths = Math.hypot(ax, az) * Math.hypot(bx, bz) || 1;
            const continuation = (ax * bx + az * bz) / lengths;
            const gapAlignment = (
              ((b.point[0] - a.point[0]) * ax + (b.point[1] - a.point[1]) * az)
              / (gap * (Math.hypot(ax, az) || 1))
            );
            // Only bridge a reasonably straight continuation. This prevents
            // the selected road from painting across the perpendicular road.
            if (continuation < 0.45 || gapAlignment < 0.55) continue;
            const score = gap + (1 - continuation) * 18;
            if (!best || score < best.score) best = { a: a.point, b: b.point, score };
          }
        }
        if (!best) continue;
        const key = [first.id, second.id].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          bridges.push([best.a, best.b]);
        }
      }
    }
    return bridges;
  }

  function updateTrafficDrawing() {
    clearStatusGroup(trafficDrawingGroup);
    const fullClosure = trafficState.closureMode === 'full';
    for (const edgeId of trafficState.selectedEdgeIds) {
      const edge = trafficState.edgesById.get(edgeId);
      if (!edge) continue;
      const points = !fullClosure && edge.lane_points?.length >= 2 ? edge.lane_points : edge.points;
      const halo = statusRibbon(points, fullClosure ? 11 : 4.6, fullClosure ? 0xff352f : 0xff9825, fullClosure ? 0.28 : 0.2, 0.82, true);
      const core = statusRibbon(points, fullClosure ? 6 : 2.3, fullClosure ? 0xff554d : 0xffc24a, 0.94, 0.87, true);
      if (halo) trafficDrawingGroup.add(halo);
      if (core) trafficDrawingGroup.add(core);
    }
    if (trafficState.drawing && trafficState.strokePoints.length >= 2) {
      const preview = statusRibbon(trafficState.strokePoints, 2.2, 0x5be6c8, 0.82, 0.91, true);
      if (preview) trafficDrawingGroup.add(preview);
    }
    const selectedEdges = trafficState.selectedEdgeIds
      .map(edgeId => trafficState.edgesById.get(edgeId))
      .filter(Boolean);
    const displayedEdges = selectedEdges.map(edge => ({
      ...edge,
      points: !fullClosure && edge.lane_points?.length >= 2 ? edge.lane_points : edge.points,
    }));
    // Never invent geometry between lane endpoints. The former junction
    // bridges could connect opposing carriageways diagonally and draw large
    // X shapes across the road. A kerbside closure should show only the real
    // sidewalk-side lane segments supplied by SUMO.
    const junctionBridges = fullClosure ? trafficJunctionBridges(displayedEdges) : [];
    for (const points of junctionBridges) {
      const bridgeHalo = statusRibbon(points, fullClosure ? 11 : 4.6, fullClosure ? 0xff352f : 0xff9825, fullClosure ? 0.28 : 0.2, 0.82, true);
      const bridgeCore = statusRibbon(points, fullClosure ? 6 : 2.3, fullClosure ? 0xff554d : 0xffc24a, 0.94, 0.87, true);
      if (bridgeHalo) trafficDrawingGroup.add(bridgeHalo);
      if (bridgeCore) trafficDrawingGroup.add(bridgeCore);
    }
    buildSelectedRoadDirections({
      name: trafficSelectionLabel(),
      direction_segments: [
        ...displayedEdges.map(edge => ({ points: edge.points, direction: 'oneway' })),
        ...junctionBridges.map(points => ({ points, direction: 'oneway' })),
      ],
    });
    trafficDrawingGroup.visible = trafficState.sceneActive;
    requestRender();
  }

  function resetTrafficResult() {
    trafficState.result = null;
    trafficState.tracks = [];
    clearStatusGroup(scenarioStatusGroup);
    if (trafficCars) trafficCars.count = 0;
    if (trafficResults) trafficResults.hidden = true;
    if (trafficImpactSummary) trafficImpactSummary.hidden = true;
    if (trafficReport) trafficReport.disabled = true;
    if (trafficCompare) {
      trafficCompare.value = 'baseline';
      trafficCompare.disabled = true;
    }
  }

  function invalidateTrafficResult(message) {
    if (!trafficState.result) return;
    resetTrafficResult();
    updateTrafficDrawing();
    if (trafficRun) trafficRun.disabled = !trafficState.selectedEdgeIds.length;
    if (trafficStatus) trafficStatus.textContent = message;
  }

  function resetTrafficToolLabels() {
    if (trafficDrawLane) trafficDrawLane.innerHTML = '<span>▥</span> Lane';
    if (trafficDrawRoad) trafficDrawRoad.innerHTML = '<span>⛔</span> Street';
    if (trafficDrawOneWay) trafficDrawOneWay.innerHTML = '<span>➜</span> One-way';
  }

  function updateTrafficDrawPopup(message = null) {
    const count = trafficState.selectedEdgeIds.length;
    if (trafficDrawPopupTitle) {
      trafficDrawPopupTitle.textContent = trafficState.oneWayIntent
        ? 'Edit one-way conversion'
        : trafficState.closureMode === 'full'
          ? 'Edit street closure'
          : 'Edit lane closure';
    }
    if (trafficDrawPopupCount) trafficDrawPopupCount.textContent = String(count);
    if (trafficDrawPopupCount?.nextElementSibling) {
      trafficDrawPopupCount.nextElementSibling.textContent = count ? trafficSelectionEffect() : 'road sections selected';
    }
    if (trafficDrawConfirm) trafficDrawConfirm.disabled = count === 0 || trafficState.stroking;
    if (trafficDrawPopupStatus && message) trafficDrawPopupStatus.textContent = message;
  }

  function clearTrafficSelection() {
    trafficState.drawing = false;
    trafficState.stroking = false;
    trafficState.pointerId = null;
    trafficState.lastScreen = null;
    trafficState.strokePoints = [];
    trafficState.selectedEdgeIds = [];
    if (trafficDrawPopup) trafficDrawPopup.hidden = true;
    resetTrafficResult();
    clearStatusGroup(trafficDrawingGroup);
    clearStatusGroup(selectedRoadDirectionGroup);
    trafficDrawLane?.classList.remove('active');
    trafficDrawRoad?.classList.remove('active');
    trafficDrawOneWay?.classList.remove('active');
    trafficState.oneWayIntent = false;
    resetTrafficToolLabels();
    if (trafficRun) trafficRun.disabled = true;
    if (trafficSelectionStatus) trafficSelectionStatus.textContent = 'Choose a closure tool. Add one or more freehand strokes, right-click sections to remove them, then confirm in the popup.';
    if (trafficStatus) trafficStatus.textContent = 'Draw a closure to begin.';
    updateTrafficInterventionControls();
    setBuildingDrawTransparency(false);
    canvas.style.cursor = '';
    requestRender();
  }

  function beginTrafficDrawing(mode) {
    clearTrafficSelection();
    setBuildingDrawTransparency(true);
    streetViewState.placing = false;
    windState.moveMode = false;
    windMoveDomain?.classList.remove('active');
    // "One-way" submits the same closure_mode: "full" as "Street" -- a
    // one-way conversion on the (typical) single-lane-per-direction road is
    // mechanically a full closure of just one directional edge. The
    // distinct tool exists so the flip-direction choice is front and
    // centre instead of buried behind a plain "Street closure" label.
    trafficState.closureMode = mode === 'lane' ? 'lane' : 'full';
    trafficState.oneWayIntent = mode === 'oneway';
    trafficState.drawing = true;
    if (trafficState.closureMode === 'full' && trafficOneWayToggle) {
      // A full closure already shuts the selected direction entirely --
      // also closing its reverse would silently pedestrianise both
      // directions, so this flag only applies to lane closures.
      trafficOneWayToggle.checked = false;
      trafficState.oneWay = false;
    }
    updateTrafficInterventionControls();
    if (trafficDrawPopup) trafficDrawPopup.hidden = false;
    if (trafficDrawPopupStatus) {
      trafficDrawPopupStatus.textContent = 'Draw a freehand stroke, lift your pointer, then draw again anywhere. Confirm when the selection is complete.';
    }
    updateTrafficDrawPopup();
    const button = mode === 'full' ? trafficDrawRoad : mode === 'oneway' ? trafficDrawOneWay : trafficDrawLane;
    button?.classList.add('active');
    if (button) button.textContent = mode === 'full' ? 'Drawing street…' : mode === 'oneway' ? 'Drawing one-way…' : 'Drawing lane…';
    if (trafficSelectionStatus) {
      const kind = mode === 'full' ? 'street closure' : mode === 'oneway' ? 'one-way conversion' : 'lane closure';
      trafficSelectionStatus.textContent = `Freehand ${kind} · draw over the road, then release to snap.`;
    }
    canvas.style.cursor = 'crosshair';
  }

  function commitTrafficStroke() {
    trafficState.stroking = false;
    trafficState.pointerId = null;
    // Match only after release. This keeps the stroke responsive and avoids
    // selecting a crossing edge merely because the pointer grazed a junction.
    const countBefore = trafficState.selectedEdgeIds.length;
    let preferredName = null;
    let previousEdgeId = null;
    const accept = (point) => {
      const snapped = snapToTrafficRoad(point[0], point[1], preferredName, previousEdgeId);
      if (!snapped) return;
      if (!preferredName) preferredName = trafficEdgeName(snapped.edge);
      previousEdgeId = snapped.edge.id;
      if (!trafficState.selectedEdgeIds.includes(snapped.edge.id)) {
        trafficState.selectedEdgeIds.push(snapped.edge.id);
      }
    };
    for (let index = 0; index < trafficState.strokePoints.length; index += 1) {
      const point = trafficState.strokePoints[index];
      if (index === 0) {
        accept(point);
        continue;
      }
      const previous = trafficState.strokePoints[index - 1];
      const distance = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      const sampleCount = Math.max(1, Math.ceil(distance / 8));
      for (let sample = 1; sample <= sampleCount; sample += 1) {
        const ratio = sample / sampleCount;
        accept([
          previous[0] + (point[0] - previous[0]) * ratio,
          previous[1] + (point[1] - previous[1]) * ratio,
        ]);
      }
    }
    const count = trafficState.selectedEdgeIds.length;
    const added = count - countBefore;
    let missReason = null;
    if (trafficState.closureMode === 'lane') {
      // A single-lane-per-direction road (most unsealed/paved-surface minor
      // streets and access lanes in this network) has no lane-mode geometry
      // at all -- so a stroke drawn along one can silently snap to whatever
      // *other* narrowable road happens to be nearby instead, with no error.
      // Surface that explicitly rather than leaving an unrelated road
      // selected with no explanation.
      const newlyAddedIds = trafficState.selectedEdgeIds.slice(countBefore);
      const nearFull = nearbyFullOnlyRoad(trafficState.strokePoints);
      if (nearFull && !newlyAddedIds.includes(nearFull.edge.id)) {
        const lanes = Number(nearFull.edge.lane_count) || 1;
        const nearName = trafficEdgeName(nearFull.edge);
        const insteadText = newlyAddedIds.length
          ? ` ${trafficEdgeName(trafficState.edgesById.get(newlyAddedIds[0]))} was selected instead because it is the nearest road that can be narrowed here.`
          : '';
        missReason = `${nearName} has only ${lanes} ${lanes === 1 ? 'lane' : 'lanes'} in this direction, so narrowing it would sever the road rather than close one lane.${insteadText} Use Street closure for ${nearName} instead — the other direction stays open as one-way, or use ⇄ Close the other direction instead to flip which side closes.`;
      }
    }
    trafficState.strokePoints = [];
    if (trafficSelectionStatus) {
      trafficSelectionStatus.textContent = missReason || (added
        ? `${added} ${added === 1 ? 'section' : 'sections'} added · ${count} total selected. Draw another stroke, right-click to remove, or confirm.`
        : 'That stroke did not add a new road section. Draw closer to a road centreline or confirm the current selection.');
    }
    if (trafficStatus) trafficStatus.textContent = count
      ? `Editing ${trafficSelectionLabel()} · selection is not confirmed yet.`
      : 'Draw at least one road section, then confirm the selection.';
    if (trafficRun) trafficRun.disabled = true;
    updateTrafficDrawPopup(missReason || (added
      ? `${added} ${added === 1 ? 'section was' : 'sections were'} added. You can lift and draw another stroke anywhere.`
      : 'No new section was added. Try another stroke or confirm the current selection.'));
    updateTrafficDrawing();
  }

  function confirmTrafficDrawing() {
    if (trafficState.stroking || !trafficState.selectedEdgeIds.length) {
      updateTrafficDrawPopup('Add at least one road section before confirming.');
      return;
    }
    trafficState.drawing = false;
    trafficState.strokePoints = [];
    trafficDrawLane?.classList.remove('active');
    trafficDrawRoad?.classList.remove('active');
    trafficDrawOneWay?.classList.remove('active');
    resetTrafficToolLabels();
    if (trafficDrawPopup) trafficDrawPopup.hidden = true;
    setBuildingDrawTransparency(false);
    canvas.style.cursor = '';
    const count = trafficState.selectedEdgeIds.length;
    const label = trafficSelectionLabel();
    const directionHint = trafficState.oneWayIntent && trafficSelectionReverseIds()
      ? ' Traffic stays open in the drawn direction — use ⇄ below to reverse it.'
      : '';
    if (trafficSelectionStatus) trafficSelectionStatus.textContent = `${trafficSelectionEffect()} · ${label} · ${trafficSelectionDetails()}. Right-click a section to remove it.${directionHint}`;
    if (trafficStatus) trafficStatus.textContent = `${label} confirmed · adjust the scenario or run the comparison.`;
    if (trafficRun) trafficRun.disabled = false;
    updateTrafficDrawing();
    updateTrafficInterventionControls();
  }

  function flipTrafficDirection() {
    const reverseIds = trafficSelectionReverseIds();
    if (!reverseIds) return;
    trafficState.selectedEdgeIds = reverseIds;
    updateTrafficDrawing();
    if (trafficState.result) invalidateTrafficResult('Direction changed · run the comparison again.');
    const label = trafficSelectionLabel();
    const closingWhat = trafficState.closureMode === 'full'
      ? `${trafficSelectionEffect()} · the other direction now stays open, one-way`
      : `${trafficSelectionEffect()} · now narrowing the opposite direction`;
    if (trafficSelectionStatus) trafficSelectionStatus.textContent = `${closingWhat} · ${label} · ${trafficSelectionDetails()}. Right-click a section to remove it.`;
    if (trafficStatus) trafficStatus.textContent = `${label} confirmed (direction flipped) · adjust the scenario or run the comparison.`;
  }

  async function loadTrafficRoads() {
    try {
      const response = await fetch(`${windApi}/traffic/roads`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const roads = payload.roads || [];
      trafficState.roadsByName = new Map(roads.map(road => [road.name, road]));
      trafficState.networkEdges = payload.network_edges || [];
      trafficState.edgesById = new Map(trafficState.networkEdges.map(edge => [edge.id, edge]));
      buildTrafficSnapIndex(trafficState.networkEdges);
      trafficState.roadStatuses = payload.road_statuses || [];
      buildPermanentRoadStatuses(trafficState.roadStatuses);
      buildLiveRoadClosures(trafficState.liveRoads);
      requestRender();
      if (trafficScenario && payload.scenarios?.length) {
        trafficScenario.innerHTML = payload.scenarios
          .map(scenario => `<option value="${scenario.key}"${scenario.key === 'am_peak' ? ' selected' : ''}>${scenario.label}</option>`)
          .join('');
      }
      if (trafficDrawLane) trafficDrawLane.disabled = !trafficState.networkEdges.length;
      if (trafficDrawRoad) trafficDrawRoad.disabled = !trafficState.networkEdges.length;
      if (trafficDrawOneWay) trafficDrawOneWay.disabled = !trafficState.networkEdges.length;
      if (trafficState.networkEdges.length && trafficStatus) {
        const matched = payload.road_data?.municipal_matched_edges || 0;
        trafficStatus.textContent = `${trafficState.networkEdges.length} road sections ready · ${matched} matched to City road-centre data.`;
      }
    } catch (error) {
      if (trafficStatus) trafficStatus.textContent = `Road list unavailable (${error.message})`;
    }
  }

  async function loadTrafficLive(force) {
    if (!trafficLiveStatus) return;
    trafficLiveStatus.textContent = force ? 'Refreshing live traffic…' : 'Loading live traffic…';
    if (trafficRefresh) trafficRefresh.disabled = true;
    try {
      const response = await fetch(`${windApi}/traffic/live${force ? '?refresh=true' : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      if (trafficFreshness) {
        trafficFreshness.textContent = payload.stale ? 'Stale' : 'Live';
        trafficFreshness.classList.toggle('stale', Boolean(payload.stale));
      }
      const level = (payload.congestion_level || 'unknown').replace(/_/g, ' ');
      trafficState.liveRoads = payload.sampled_roads || [];
      buildLiveRoadClosures(trafficState.liveRoads);
      const liveClosures = trafficState.liveRoads.filter(road => road.road_closure).length;
      trafficLiveStatus.textContent = `${level} congestion · ${payload.sampled_count}/${payload.requested_count} roads sampled`
        + (liveClosures ? ` · ${liveClosures} live ${liveClosures === 1 ? 'closure' : 'closures'}` : '')
        + (payload.warning ? ` · ${payload.warning}` : '');
      if (trafficLiveMetrics) {
        trafficLiveMetrics.hidden = false;
        trafficLiveMetrics.innerHTML = `
          <span><b>${Math.round((payload.average_speed_ratio || 0) * 100)}%</b>Avg speed vs free-flow</span>
          <span><b>${level}</b>Congestion level</span>`;
      }
      if (force && trafficScenario?.value === 'live') {
        invalidateTrafficResult('Live conditions changed · run the comparison again.');
      }
    } catch (error) {
      trafficLiveStatus.textContent = `Live traffic unavailable (${error.message})`;
    } finally {
      if (trafficRefresh) trafficRefresh.disabled = false;
    }
  }

  // The server sends each vehicle as a contiguous run of positions starting
  // at `t0`, sampled every `sample_interval_s`. Heading and speed are derived
  // here from consecutive samples rather than shipped: it halves the payload
  // and guarantees a car's nose points along the path it is actually on.
  //
  // Headings are resolved once, at load, rather than per frame. A car stopped
  // in a queue has two identical consecutive samples, and atan2(0, 0) is 0 --
  // so deriving heading live made every stationary car point due north
  // regardless of the street it was sitting on, which is what turned queues
  // into sideways heaps. Segments with no real movement instead inherit the
  // last direction the car actually travelled.
  const headingMinTravelM = 0.25;
  function tracksFromTrajectories(rawTracks) {
    const tracks = [];
    for (const track of rawTracks || []) {
      const count = track?.x?.length || 0;
      if (count < 2) continue;
      const segments = count - 1;
      const heading = new Float32Array(segments);
      const travelled = new Float32Array(segments);
      for (let index = 0; index < segments; index += 1) {
        const dx = track.x[index + 1] - track.x[index];
        const dz = track.z[index + 1] - track.z[index];
        const distance = Math.hypot(dx, dz);
        travelled[index] = distance;
        heading[index] = distance > headingMinTravelM ? Math.atan2(dx, dz) : NaN;
      }
      // Carry the last known heading forward over stopped stretches, then
      // backwards for a car that is stationary from its very first sample.
      let carried = NaN;
      for (let index = 0; index < segments; index += 1) {
        if (Number.isNaN(heading[index])) heading[index] = carried;
        else carried = heading[index];
      }
      carried = NaN;
      for (let index = segments - 1; index >= 0; index -= 1) {
        if (Number.isNaN(heading[index])) heading[index] = carried;
        else carried = heading[index];
      }
      // A vehicle that never moved at all has no direction to infer.
      for (let index = 0; index < segments; index += 1) {
        if (Number.isNaN(heading[index])) heading[index] = 0;
      }
      tracks.push({ t0: track.t0, type: track.type || 'car', x: track.x, z: track.z, heading, travelled });
    }
    return tracks;
  }

  // A recognisable car at city scale: a low body with a shorter, narrower
  // cabin sitting on top, built once and reused by every instance.
  // Cars are drawn larger than life, because a true 4.3 m car is barely a
  // pixel with the CBD in frame -- but not uniformly so, and length is the
  // tightest of the three. SUMO queues stopped cars 4.4 m of body plus a
  // 2.0 m minimum gap apart, so anything drawn longer than ~6.4 m makes a
  // stationary queue render as one interpenetrating heap. Width is capped by
  // the ~3.2 m lane so neighbouring lanes stay distinct; height is free to
  // carry most of the visibility, since nothing is stacked vertically.
  const carLengthScale = 1.3;  // 5.6 m drawn, inside the 6.4 m queue pitch
  const carWidthScale = 1.5;   // 2.8 m drawn, inside the 3.2 m lane
  const carHeightScale = 1.9;
  function makeCarGeometry() {
    const body = new THREE.BoxGeometry(1.85, 0.66, 4.3);
    body.translate(0, 0.45, 0);
    const cabin = new THREE.BoxGeometry(1.6, 0.6, 2.1);
    cabin.translate(0, 1.05, -0.15);
    const merged = new THREE.BufferGeometry();
    const bodyPositions = body.getAttribute('position').array;
    const cabinPositions = cabin.getAttribute('position').array;
    const bodyNormals = body.getAttribute('normal').array;
    const cabinNormals = cabin.getAttribute('normal').array;
    const bodyIndex = [...body.getIndex().array];
    const cabinIndex = [...cabin.getIndex().array].map(i => i + bodyPositions.length / 3);
    merged.setAttribute('position', new THREE.Float32BufferAttribute(
      [...bodyPositions, ...cabinPositions], 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(
      [...bodyNormals, ...cabinNormals], 3));
    merged.setIndex([...bodyIndex, ...cabinIndex]);
    // BoxGeometry axes are (width=x, height=y, depth=z); depth is the car's
    // travel direction, which the instance matrix then rotates by heading.
    merged.scale(carWidthScale, carHeightScale, carLengthScale);
    body.dispose();
    cabin.dispose();
    return merged;
  }

  function resetTrafficCars() {
    if (trafficCars) {
      trafficGroup.remove(trafficCars);
      disposeObject(trafficCars);
    }
    // No `vertexColors` here: the per-car colour comes from setColorAt, which
    // three.js applies via instanceColor. Turning vertexColors on would make
    // the shader look for a per-vertex `color` attribute this geometry lacks.
    trafficCars = new THREE.InstancedMesh(
      makeCarGeometry(),
      new THREE.MeshLambertMaterial({ emissiveIntensity: 0.4 }),
      trafficMaxCars,
    );
    trafficCars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trafficCars.frustumCulled = false;
    trafficCars.count = 0;
    trafficCars.name = 'traffic-cars';
    trafficGroup.add(trafficCars);
  }

  function applyTrafficCompareSelection() {
    const payload = trafficState.result;
    if (!payload) {
      trafficState.tracks = [];
      return;
    }
    const key = trafficCompare?.value === 'closure' ? 'closure' : 'baseline';
    trafficState.tracks = tracksFromTrajectories(payload.trajectories?.[key]);
    trafficState.simClock = trafficState.durationS * trafficWarmStartFraction;
    trafficState.lastTime = performance.now();
    if (!trafficCars) resetTrafficCars();
  }

  // Position, heading and speed of one vehicle at simulated time `t`, or null
  // when that vehicle is not on the network then.
  function trafficStateAt(track, t, sampleIntervalS) {
    const span = (track.x.length - 1) * sampleIntervalS;
    const local = t - track.t0;
    if (local < 0 || local > span) return null;
    const exact = local / sampleIntervalS;
    const index = Math.min(track.x.length - 2, Math.floor(exact));
    const ratio = exact - index;
    const x0 = track.x[index];
    const z0 = track.z[index];
    return {
      x: x0 + (track.x[index + 1] - x0) * ratio,
      z: z0 + (track.z[index + 1] - z0) * ratio,
      heading: track.heading[index],
      speed: track.travelled[index] / sampleIntervalS,
    };
  }

  function updateTrafficCars(now) {
    if (!trafficGroup.visible || !trafficCars || !trafficState.tracks.length) return;
    const elapsed = Math.min(0.25, (now - trafficState.lastTime) / 1000);
    trafficState.lastTime = now;
    const durationS = Math.max(trafficState.durationS || 1, 1);
    trafficState.simClock = (trafficState.simClock + elapsed * trafficPlaybackSpeed) % durationS;
    const sampleIntervalS = trafficState.sampleIntervalS || 2;

    let count = 0;
    for (const track of trafficState.tracks) {
      if (count >= trafficMaxCars) break;
      const state = trafficStateAt(track, trafficState.simClock, sampleIntervalS);
      if (!state) continue;
      // Routes can leave the rendered terrain even though every trip starts
      // and ends inside it. Drawing those gives cars hovering over the void,
      // so drop them until they come back onto ground that exists.
      if (!terrainValidAt(state.x, state.z)) continue;
      carPosition.set(state.x, terrainHeightAt(state.x, state.z) + 0.35, state.z);
      carQuaternion.setFromAxisAngle(carUp, state.heading);
      if (track.type === 'city_shuttle') carScale.set(1.08, 1.18, 1.75);
      else if (track.type === 'delivery_van') carScale.set(1.04, 1.12, 1.22);
      else if (track.type === 'minibus_taxi') carScale.set(1.02, 1.08, 1.12);
      else carScale.set(1, 1, 1);
      carMatrix.compose(carPosition, carQuaternion, carScale);
      trafficCars.setMatrixAt(count, carMatrix);
      // Red when stopped through amber to green at the 50 km/h limit, so
      // congestion behind a closed lane is readable at a glance.
      const flow = clamp(state.speed / trafficFreeFlowMps, 0, 1);
      carColor.setHSL(flow * 0.33, 0.85, 0.52);
      trafficCars.setColorAt(count, carColor);
      count += 1;
    }
    trafficCars.count = count;
    trafficCars.instanceMatrix.needsUpdate = true;
    if (trafficCars.instanceColor) trafficCars.instanceColor.needsUpdate = true;
    // Throttled: this is a DOM write inside the render loop.
    if (trafficOnScreen && now - trafficOnScreenShownAt > 400) {
      trafficOnScreenShownAt = now;
      const minute = Math.floor(trafficState.simClock / 60);
      const second = String(Math.floor(trafficState.simClock % 60)).padStart(2, '0');
      trafficOnScreen.textContent = `${count} vehicles · ${minute}:${second}`;
    }
  }

  function trafficImpactAssessment(impact = {}) {
    if (impact.assessment_ready === false) {
      return {
        durationChange: null,
        completionChange: Number(impact.completion_change_percentage_points) || 0,
        completionDrop: 0,
        queueIncrease: 0,
        severity: 'incomplete',
        headline: 'Comparison incomplete — do not use this result yet',
        action: impact.simulation_complete === false
          ? 'One or both simulation runs reached the processing time limit. Reduce the selected area or demand and rerun the comparison.'
          : impact.baseline_stable === false
            ? `The open-road baseline completed only ${reportNumber(Number(impact.completed_trip_ratio_baseline || 0) * 100, 0, '%')} of generated trips; at least ${reportNumber(Number(impact.minimum_baseline_completion_ratio || 0) * 100, 0, '%')} is required. Reduce synthetic demand or shorten the selected area and rerun it.`
          : impact.paired_sample_sufficient === false
            ? `Only ${Number(impact.compared_trip_count) || 0} trips completed both runs (${reportNumber(Number(impact.paired_trip_ratio || 0) * 100, 0, '%')} of generated trips). Increase the sampling window or reduce disruption and rerun it.`
            : 'No trip completed in both runs, so a like-for-like travel-time comparison is not available. Revise the closure or demand and rerun it.',
      };
    }
    const durationChange = Number(
      impact.mean_journey_time_change_pct ?? impact.mean_duration_change_pct,
    ) || 0;
    const completionChange = (
      (impact.completed_trip_ratio_closure ?? 0) - (impact.completed_trip_ratio_baseline ?? 0)) * 100;
    const completionDrop = Math.max(0, -completionChange);
    const queueIncrease = Math.max(0,
      (Number(impact.max_queue_closure) || 0) - (Number(impact.max_queue_baseline) || 0));
    let severity = 'minor';
    if (durationChange >= 35 || completionDrop >= 15) severity = 'major';
    else if (durationChange >= 18 || completionDrop >= 8 || queueIncrease >= 15) severity = 'significant';
    else if (durationChange >= 7 || completionDrop >= 3 || queueIncrease >= 5) severity = 'noticeable';

    const headline = {
      major: 'Major modelled disruption — revise the option',
      significant: 'Significant modelled disruption — test mitigation',
      noticeable: 'Noticeable modelled disruption — mitigation is advisable',
      minor: 'Limited modelled disruption in this scenario',
    }[severity];
    const action = {
      major: 'Revise the option before progressing it. Shorten or phase the work zone, retain available capacity where possible, or move it outside the peak, then compare the revision.',
      significant: 'Test a shorter or off-peak work zone and explicit junction or diversion management before taking the option forward.',
      noticeable: 'Compare practical mitigation such as off-peak timing, a shorter work zone, and monitoring of the busiest diversion roads.',
      minor: 'Retain this option for further assessment, alongside diversion signing, monitoring, emergency access and an operational contingency.',
    }[severity];
    return { durationChange, completionChange, completionDrop, queueIncrease, severity, headline, action };
  }

  function publicChange(value, noun = 'traffic') {
    const numeric = Number(value) || 0;
    if (Math.abs(numeric) < 0.05) return `about the same ${noun}`;
    return `${reportNumber(Math.abs(numeric), 1)} ${numeric > 0 ? 'more' : 'fewer'} ${noun}`;
  }

  function publicOccupancyChange(value) {
    const numeric = Number(value) || 0;
    if (Math.abs(numeric) < 0.05) return 'about the same mean vehicle occupancy';
    return `${reportNumber(Math.abs(numeric), 1)} ${numeric > 0 ? 'higher' : 'lower'} mean vehicle occupancy`;
  }

  const reportEscape = value => String(value ?? '—').replace(/[&<>"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character]);

  function reportNumber(value, digits = 1, unit = '') {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    return `${numeric.toLocaleString('en-ZA', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit}`;
  }

  function reportChange(value, digits = 1, unit = '', inverse = false) {
    if (value === null || value === undefined || value === '') return '<span>—</span>';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '<span>—</span>';
    const className = (inverse ? numeric > 0 : numeric < 0) ? 'report-change-negative'
      : numeric === 0 ? '' : 'report-change-positive';
    const sign = numeric > 0 ? '+' : '';
    return `<span class="${className}">${sign}${reportNumber(numeric, digits, unit)}</span>`;
  }

  function niceScaleMetres(approxMetres) {
    const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    return steps.reduce((best, step) => (
      Math.abs(step - approxMetres) < Math.abs(best - approxMetres) ? step : best
    ), steps[0]);
  }

  function trafficReportMap(payload) {
    const flows = (payload.flow_comparison || []).slice(0, 100);
    const closures = payload.closure?.geometry_local || [];
    // Derived from the actual closed-edge topology (see server/traffic.py's
    // `_remaining_open_direction`), not the `one_way` request flag -- so
    // this draws correctly for the dedicated "one-way" drawing tool, which
    // submits a plain full closure with no such flag.
    const openDirection = payload.closure?.remaining_open_geometry_local || [];
    const lines = [...flows.map(item => item.points), ...closures, ...openDirection].filter(points => points?.length >= 2);
    const allPoints = lines.flat();
    if (!allPoints.length) return '<div class="report-note">No road geometry was available for the report diagram.</div>';
    const xs = allPoints.map(point => Number(point[0]));
    const zs = allPoints.map(point => Number(point[1]));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const padding = 40;
    // Fit the canvas to the content's own aspect ratio (clamped to a sane
    // range) instead of a fixed 900x340 box -- a mostly straight corridor
    // used to leave most of that fixed box empty, with the drawing pinned
    // to the top-left corner.
    const spanX = Math.max(maxX - minX, 1), spanZ = Math.max(maxZ - minZ, 1);
    const width = 900;
    const height = Math.round(clamp(width * (spanZ / spanX), 320, 640));
    const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanZ);
    // Centre the drawing within the padded canvas on both axes, rather than
    // anchoring it to the top-left padding corner.
    const offsetX = padding + ((width - padding * 2) - spanX * scale) / 2;
    const offsetY = padding + ((height - padding * 2) - spanZ * scale) / 2;
    // Local z runs southward (see server/traffic.py's _edge_index projection),
    // so increasing z must move *down* the SVG for the sheet to read north-up.
    const projectXY = point => [offsetX + (point[0] - minX) * scale, offsetY + (point[1] - minZ) * scale];
    const project = point => projectXY(point).map(n => n.toFixed(1)).join(',');
    const flowLines = flows.map(segment => {
      const delta = Number(segment.vehicle_delta) || 0;
      const color = delta >= 0 ? '#ef9b38' : '#4fc5ed';
      const lineWidth = Math.min(6, 1.1 + Math.abs(delta) * 0.8);
      return `<polyline points="${segment.points.map(project).join(' ')}" fill="none" stroke="${color}" stroke-width="${lineWidth.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity=".82"/>`;
    }).join('');
    const closureLines = closures.map(points => `<polyline points="${points.map(project).join(' ')}" fill="none" stroke="#ff5149" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="${points.map(project).join(' ')}" fill="none" stroke="#fff3d5" stroke-width="2" stroke-dasharray="5 5"/>`).join('');
    const openDirectionLines = openDirection.map(points => `<polyline points="${points.map(project).join(' ')}" fill="none" stroke="#2be0ad" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><polyline points="${points.map(project).join(' ')}" fill="none" stroke="#d8fff2" stroke-width="2" stroke-dasharray="4 6"/>`).join('');
    // Arrow follows the open edge's own direction of travel -- this is the
    // side that stays driveable, not the closed side.
    const openDirectionArrows = openDirection.filter(points => points.length >= 2).map(points => {
      const start = projectXY(points[0]);
      const end = projectXY(points[points.length - 1]);
      const midX = (start[0] + end[0]) / 2, midY = (start[1] + end[1]) / 2;
      const angle = Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI;
      return `<g transform="translate(${midX.toFixed(1)},${midY.toFixed(1)}) rotate(${angle.toFixed(1)})">
        <path d="M -16 0 L 12 0 M 3 -8 L 12 0 L 3 8" stroke="#0f6b4f" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
    }).join('');
    const scaleMetres = niceScaleMetres((width - padding * 2) / scale / 4);
    const scaleWidthPx = scaleMetres * scale;
    const scaleBarX = width - padding - scaleWidthPx;
    const scaleBarY = height - 18;
    // Label the closed road and the handful of nearby streets already
    // called out in the "Most affected nearby roads" list below, so the
    // reader can tell *which* street each coloured line is without cross
    // referencing the list by eye. One label per street, placed on its
    // longest drawn segment so it doesn't collide with a short stub.
    const streetHalo = (x, y, text, color) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10" font-weight="700" fill="${color}" stroke="#17201d" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${reportEscape(text)}</text>`;
    const byStreetName = new Map();
    for (const segment of flows) {
      const name = segment.name;
      if (!name || name === 'Unnamed road') continue;
      if (!byStreetName.has(name)) byStreetName.set(name, []);
      byStreetName.get(name).push(segment.points);
    }
    const labelledNames = (payload.street_flow_summary || [])
      .filter(street => street.name !== payload.road_name)
      .slice(0, 5).map(street => street.name);
    const streetLabelMarks = labelledNames
      .filter(name => byStreetName.has(name))
      .map(name => {
        const linePx = longestPolyline(byStreetName.get(name)).map(projectXY);
        const [x, y] = linePx[Math.floor(linePx.length / 2)];
        return streetHalo(x, y - 6, name, '#dfe7e3');
      }).join('');
    const closedRoadLabel = closures.length
      ? (() => {
        const linePx = longestPolyline(closures).map(projectXY);
        const [x, y] = linePx[Math.floor(linePx.length / 2)];
        return streetHalo(x, y - 6, payload.road_name, '#ffb4ae');
      })()
      : '';
    return `<div class="report-map">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Road closure and changed traffic flow diagram">
        <rect width="${width}" height="${height}" rx="4" fill="#17201d"/>
        <g>${flowLines}${closureLines}${openDirectionLines}${openDirectionArrows}</g>
        <g>${streetLabelMarks}${closedRoadLabel}</g>
        <g stroke="#c8d6d1" stroke-width="1.4">
          <line x1="${scaleBarX.toFixed(1)}" y1="${scaleBarY}" x2="${(scaleBarX + scaleWidthPx).toFixed(1)}" y2="${scaleBarY}"/>
          <line x1="${scaleBarX.toFixed(1)}" y1="${scaleBarY - 4}" x2="${scaleBarX.toFixed(1)}" y2="${scaleBarY + 4}"/>
          <line x1="${(scaleBarX + scaleWidthPx).toFixed(1)}" y1="${scaleBarY - 4}" x2="${(scaleBarX + scaleWidthPx).toFixed(1)}" y2="${scaleBarY + 4}"/>
        </g>
        <text x="${(scaleBarX + scaleWidthPx / 2).toFixed(1)}" y="${scaleBarY - 8}" fill="#c8d6d1" font-size="10" text-anchor="middle">${scaleMetres} m</text>
        <g transform="translate(${padding + 12},${padding + 8})" stroke="#c8d6d1" stroke-width="1.6" fill="none">
          <line x1="0" y1="22" x2="0" y2="0"/>
          <path d="M -5 6 L 0 0 L 5 6" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
        <text x="${padding + 12}" y="${padding + 40}" fill="#c8d6d1" font-size="10" text-anchor="middle">N</text>
      </svg>
      <div class="report-map-caption">
        <span><i style="background:#ff5149"></i>Closed to vehicles${payload.closure?.functions_as_one_way ? ' (reallocated to pedestrians)' : ''}</span>
        ${openDirection.length ? '<span><i style="background:#2be0ad"></i>Stays open, one-way (arrow = travel direction)</span>' : ''}
        <span><i style="background:#ef9b38"></i>More traffic</span>
        <span><i style="background:#4fc5ed"></i>Less traffic</span>
      </div>
    </div>`;
  }

  function ribbonPolygonPoints(pointsPx, widthPx) {
    if (pointsPx.length < 2) return null;
    const left = [], right = [];
    for (let index = 0; index < pointsPx.length; index += 1) {
      const prev = pointsPx[Math.max(0, index - 1)];
      const next = pointsPx[Math.min(pointsPx.length - 1, index + 1)];
      const dx = next[0] - prev[0], dy = next[1] - prev[1];
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length, ny = dx / length;
      left.push([pointsPx[index][0] + nx * widthPx / 2, pointsPx[index][1] + ny * widthPx / 2]);
      right.push([pointsPx[index][0] - nx * widthPx / 2, pointsPx[index][1] - ny * widthPx / 2]);
    }
    return [...left, ...right.reverse()].map(point => point.map(n => n.toFixed(1)).join(',')).join(' ');
  }

  function longestPolyline(lines) {
    let best = null, bestLength = -1;
    for (const points of lines) {
      let length = 0;
      for (let index = 1; index < points.length; index += 1) {
        length += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
      }
      if (length > bestLength) { best = points; bestLength = length; }
    }
    return best;
  }

  function trafficClosureSchematic(payload) {
    // A scaled, top-down engineering-style plan of just the closed section
    // -- which lane closes (green, reallocated to pedestrians), which lane
    // stays open and which way it flows (grey, with a direction arrow) --
    // rather than the wider corridor diversion pattern (see
    // `trafficReportMap`, shown separately further down the report).
    const closure = payload.closure || {};
    const closedLines = (closure.geometry_local || []).filter(points => points?.length >= 2);
    const openLines = (closure.remaining_open_geometry_local || []).filter(points => points?.length >= 2);
    if (!closedLines.length) return '';
    const closedLine = longestPolyline(closedLines);
    const openLine = openLines.length ? longestPolyline(openLines) : null;
    const allPoints = [...closedLine, ...(openLine || [])];
    const xs = allPoints.map(point => Number(point[0]));
    const zs = allPoints.map(point => Number(point[1]));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const padding = 96;
    const spanX = Math.max(maxX - minX, 6), spanZ = Math.max(maxZ - minZ, 6);
    // Same fit-to-content-aspect-ratio + centring fix as `trafficReportMap`:
    // a straight, mostly-one-axis segment used to leave the fixed 860x360
    // canvas mostly blank with the ribbon hugging the top-left padding.
    const width = 860;
    const height = Math.round(clamp(width * (spanZ / spanX), 260, 520));
    const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanZ);
    const offsetX = padding + ((width - padding * 2) - spanX * scale) / 2;
    const offsetY = padding + ((height - padding * 2) - spanZ * scale) / 2;
    const projectXY = ([x, z]) => [offsetX + (x - minX) * scale, offsetY + (z - minZ) * scale];
    const laneWidthM = 3.2;
    const laneWidthPx = Math.max(20, laneWidthM * scale);
    const closedPx = closedLine.map(projectXY);
    const openPx = openLine ? openLine.map(projectXY) : null;
    const closedRibbon = ribbonPolygonPoints(closedPx, laneWidthPx);
    const openRibbon = openPx ? ribbonPolygonPoints(openPx, laneWidthPx) : null;
    const pointAt = (points, ratio) => points[Math.min(points.length - 1, Math.round((points.length - 1) * ratio))];
    // Offset the two label anchors to different points along their lines
    // (rather than both at the exact midpoint) so they stay legible on a
    // short or steeply-angled segment instead of colliding in the middle.
    const closedMid = pointAt(closedPx, 0.32);
    const openMid = openPx ? pointAt(openPx, 0.68) : null;
    const kerbLine = `<polyline points="${closedPx.map(point => point.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#3c4842" stroke-width="1.6" stroke-dasharray="7 5"/>`;
    const arrow = openPx ? (() => {
      const start = openPx[0], end = openPx[openPx.length - 1];
      const angle = Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI;
      const midX = (start[0] + end[0]) / 2, midY = (start[1] + end[1]) / 2;
      return `<g transform="translate(${midX.toFixed(1)},${midY.toFixed(1)}) rotate(${angle.toFixed(1)})">
        <path d="M -24 0 L 18 0 M 4 -11 L 18 0 L 4 11" stroke="#17403a" stroke-width="4.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
    })() : '';
    const closedLabelY = closedMid[1] - laneWidthPx / 2 - 16;
    const openLabelY = openMid ? openMid[1] + laneWidthPx / 2 + 24 : 0;
    const haloText = (x, y, size, weight, color, text) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}" text-anchor="middle" fill="${color}" stroke="#fbfbf9" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${text}</text>`;
    // Three distinct outcomes, previously conflated into one fallback message:
    // (1) the sibling direction survives and stays driveable one-way (openMid set);
    // (2) a *whole* road is closed with nothing left to drive on (`full` mode,
    //     no surviving sibling); (3) only the kerbside lane narrows, so the
    //     road itself is still driveable in both directions on its remaining
    //     lane(s) -- the old fallback wrongly told drivers this case had "no
    //     vehicle access" at all, which only case (2) is true for.
    const isLaneNarrowing = payload.closure_mode !== 'full' && Number(closure.edges_narrowed) > 0;
    const fallbackLabel = isLaneNarrowing
      ? 'Road stays open -- traffic continues on the remaining lane'
      : 'No vehicle access -- closed in both directions';
    return `<div class="report-plan">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Closure plan -- which lane closes, which stays open, and which way it flows">
        <rect width="${width}" height="${height}" rx="6" fill="#fbfbf9" stroke="#d5dad6"/>
        <polygon points="${closedRibbon}" fill="#bfe8d9" stroke="#1e6f61" stroke-width="1.6"/>
        ${openRibbon ? `<polygon points="${openRibbon}" fill="#dde1dd" stroke="#7c8580" stroke-width="1.2"/>` : ''}
        ${kerbLine}
        ${arrow}
        ${haloText(closedMid[0], closedLabelY, 11, 700, '#1e6f61', isLaneNarrowing ? 'CLOSED LANE · PEDESTRIAN AREA' : 'PEDESTRIAN AREA')}
        ${haloText(closedMid[0], closedLabelY + 13, 9, 400, '#1e6f61', `≈${laneWidthM.toFixed(1)} m (schematic)`)}
        ${openMid ? `${haloText(openMid[0], openLabelY, 11, 700, '#3c4842', 'TRAVEL LANE · ONE-WAY')}
        ${haloText(openMid[0], openLabelY + 13, 9, 400, '#3c4842', `≈${laneWidthM.toFixed(1)} m (schematic)`)}` : `<text x="${width / 2}" y="${height - padding + 28}" font-size="10" text-anchor="middle" fill="#78817d">${fallbackLabel}</text>`}
      </svg>
      <div class="report-plan-legend">
        <span><i style="background:#bfe8d9;border-color:#1e6f61"></i>Closed to cars, becomes pedestrian space</span>
        ${openMid ? '<span><i style="background:#dde1dd;border-color:#7c8580"></i>Stays open, one-way (arrow = direction of travel)</span>' : isLaneNarrowing ? '<span><i style="background:#fff;border-color:#7c8580"></i>Road stays open in both directions on the remaining lane</span>' : ''}
      </div>
      <p class="report-cross-section-note">Schematic plan on the real road geometry — illustrative (not surveyed) lane widths. The arrow shows the one-way direction that stays open; drawn on the "One-way" or "Street closure" tool, flip with ⇄ before running to choose the other direction instead.</p>
    </div>`;
  }

  function trafficCrossSection(payload) {
    const closure = payload.closure || {};
    const narrowed = Number(closure.edges_narrowed) || 0;
    // Illustrative only: the network carries no surveyed lane widths, so this
    // uses SUMO's own default lane width, not a measured cross-section.
    const laneWidthM = 3.2;
    let segments;
    if (closure.functions_as_one_way) {
      segments = [
        { label: 'Pavement', widthM: 2.0, fill: '#dfe3df' },
        { label: 'Travel lane · one-way', widthM: laneWidthM, fill: '#c7cdc8' },
        { label: 'Pedestrian area · reallocated', widthM: laneWidthM, fill: '#bfe8d9' },
        { label: 'Verge', widthM: 1.5, fill: '#dfe3df' },
      ];
    } else if (narrowed > 0) {
      segments = [
        { label: 'Pavement', widthM: 2.0, fill: '#dfe3df' },
        { label: 'Remaining travel lane', widthM: laneWidthM, fill: '#c7cdc8' },
        { label: 'Closed lane · reallocated', widthM: laneWidthM, fill: '#bfe8d9' },
        { label: 'Verge', widthM: 1.5, fill: '#dfe3df' },
      ];
    } else if (payload.closure_mode === 'full') {
      segments = [
        { label: 'Pavement', widthM: 2.0, fill: '#dfe3df' },
        { label: 'Pedestrian area · fully closed to vehicles', widthM: laneWidthM * 2, fill: '#bfe8d9' },
        { label: 'Verge', widthM: 1.5, fill: '#dfe3df' },
      ];
    } else {
      return '';
    }
    const totalWidth = segments.reduce((sum, segment) => sum + segment.widthM, 0);
    const chartWidth = 760, chartHeight = 78, chartX = 20;
    const pxPerMetre = (chartWidth - chartX * 2) / totalWidth;
    let cursor = chartX;
    const bars = segments.map(segment => {
      const w = segment.widthM * pxPerMetre;
      const bar = `<rect x="${cursor.toFixed(1)}" y="10" width="${w.toFixed(1)}" height="${chartHeight - 30}" fill="${segment.fill}" stroke="#9aa39d"/>
        <text x="${(cursor + w / 2).toFixed(1)}" y="${chartHeight - 8}" font-size="9" text-anchor="middle" fill="#4b544e">${segment.label} · ${segment.widthM.toFixed(1)} m</text>`;
      cursor += w;
      return bar;
    }).join('');
    return `<div class="report-cross-section">
      <svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Illustrative cross-section of the closed lane">${bars}</svg>
      <p class="report-cross-section-note">Schematic — SUMO default lane width (${laneWidthM.toFixed(1)} m), not a surveyed cross-section.</p>
    </div>`;
  }

  function buildTrafficDrawingSheet(payload, reportReference, generated) {
    const closure = payload.closure || {};
    const closureDescription = String(closure.description || 'closure applied');
    const notes = [
      `${reportEscape(closureDescription.charAt(0).toUpperCase() + closureDescription.slice(1))}.`,
    ];
    if (closure.functions_as_one_way) {
      // `remaining_open_geometry_local` is computed from the actual closed
      // edges, not a request flag, so this fires for the dedicated
      // "one-way" tool and for a plain street closure of one direction,
      // not only the flag-driven lane+reverse combination.
      notes.push('The closed side is reallocated to pedestrians; the open side (arrow on the plan) operates one-way for vehicles.');
      if (closure.open_direction?.label) {
        notes.push(`Direction kept open: ${closure.open_direction.label}. This compass label, not only the arrow, identifies the tested option.`);
      }
    } else if (closure.one_way && Number(closure.already_one_way_edges) > 0) {
      notes.push('One-way conversion requested, but the selected section(s) already run one-way in the source data — no reverse-direction edge to close.');
    }
    notes.push(`Simulated for ${payload.scenario?.label || '—'} traffic, using ${payload.signal_data_source || (payload.traffic_control === 'priority' ? 'priority junctions (no traffic lights)' : 'SUMO-generated signal programs')}.`);
    if (payload.demand_model?.endpoint_policy?.startsWith('through_traffic_only')) {
      notes.push('Through-traffic test: the selected physical street section is excluded from trip origins and destinations so displaced trips reroute instead of disappearing. Driveway, loading and kerbside access demand is not modelled.');
    }
    const historicalCalibration = payload.demand_model?.historical_speed_calibration;
    if (historicalCalibration?.applied) {
      const peakWindow = historicalCalibration.observed_peak_window
        ? `; observed peak window ${historicalCalibration.observed_peak_window}` : '';
      notes.push(`TomTom speed-pattern calibration applied from ${historicalCalibration.distinct_days} weekdays and ${historicalCalibration.sample_count} samples${peakWindow}. This calibrates peak timing and relative congestion, not vehicle counts.`);
    } else if (['am_peak', 'pm_peak'].includes(payload.scenario?.key)) {
      notes.push('TomTom peak calibration is not ready yet; the labelled peak window remains the default assumption until at least five adequately covered weekdays have been collected.');
    }
    const notesList = notes.map((note, index) => `<li><span>${index + 1}</span>${note}</li>`).join('');
    const crossSection = trafficCrossSection(payload);
    const planSchematic = trafficClosureSchematic(payload);
    return `<section class="report-sheet">
      <div class="report-sheet-main">
        <div class="report-sheet-heading">
          <h2>Plan view</h2>
          <span>Schematic, not to engineering scale</span>
        </div>
        ${planSchematic || '<div class="report-note">No closure geometry was available for the plan.</div>'}
        ${crossSection ? `<div class="report-sheet-heading"><h2>Cross-section</h2><span>Illustrative lane allocation</span></div>${crossSection}` : ''}
      </div>
      <aside class="report-sheet-side">
        <table class="report-title-block">
          <tbody>
            <tr><th colspan="2">Title</th></tr>
            <tr><td colspan="2">${reportEscape(payload.road_name)} — traffic simulation</td></tr>
            <tr><th>Scale</th><td>Schematic — not surveyed</td></tr>
            <tr><th>Scenario</th><td>${reportEscape(payload.scenario?.label || '—')}</td></tr>
            <tr><th>Date</th><td>${reportEscape(generated)}</td></tr>
            <tr><th>Prepared by</th><td>climateExplorer traffic simulation</td></tr>
            <tr><th>Reference</th><td>${reportEscape(reportReference)}</td></tr>
          </tbody>
        </table>
        <div class="report-notes">
          <div class="report-notes-heading">Notes</div>
          <ol class="report-notes-list">${notesList}</ol>
        </div>
      </aside>
    </section>`;
  }

  function buildTrafficReport() {
    const payload = trafficState.result;
    if (!payload || !trafficReportDocument) return;
    const impact = payload.impact || {};
    const assessment = trafficImpactAssessment(impact);
    const environment = impact.environment || {};
    const assessmentReady = impact.assessment_ready !== false;
    const reportedEnvironment = assessmentReady ? environment : {};
    const activity = payload.street_activity || {};
    const demand = payload.demand_model || {};
    const historicalCalibration = demand.historical_speed_calibration || {};
    const decisionValue = value => assessmentReady ? value : null;
    const toKmh = value => value === null || value === undefined ? null : Number(value) * 3.6;
    const generated = new Intl.DateTimeFormat('en-ZA', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Johannesburg',
    }).format(new Date());
    const reportReference = `TRF-${Number(demand.seed || 0).toString(16).toUpperCase().padStart(8, '0')}`;
    const percent = value => value !== null && value !== undefined && Number.isFinite(Number(value))
      ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`
      : '—';
    const completionText = Math.abs(assessment.completionChange) < 0.05
      ? 'about the same share of trips finish'
      : `${Math.abs(assessment.completionChange).toFixed(1)} percentage points ${assessment.completionChange > 0 ? 'more' : 'fewer'} trips finish`;
    const flowItems = (payload.street_flow_summary || []).slice(0, 5).map(street => `
      <li><b>${reportEscape(street.name)}</b><span>${publicOccupancyChange(street.vehicle_delta)}</span></li>`).join('')
      || '<li><b>No nearby street noticeably affected</b><span>—</span></li>';
    const durationDetail = assessment.severity === 'incomplete'
      ? reportEscape(assessment.action)
      : `On average, a trip through this area took <b>${reportNumber(Math.abs(impact.mean_journey_time_change_s), 0, ' seconds')} ${Number(impact.mean_journey_time_change_s) >= 0 ? 'longer' : 'shorter'}</b> (${percent(assessment.durationChange)}), and <b>${completionText}</b>.`;

    trafficReportDocument.innerHTML = `
      <header class="report-header">
        <div class="report-brand-title">
          <img class="report-brand" src="/branding/MissionWordmark.webp" alt="Mission for Inner City Cape Town">
          <div>
          <p class="report-kicker">Cape Town CBD Climate Explorer</p>
          <h1 id="traffic-report-title">Road closure simulation report</h1>
          </div>
        </div>
        <div class="report-header-meta">
          <b>${reportEscape(reportReference)}</b>
          Generated ${reportEscape(generated)}<br>
          Exploratory planning summary
        </div>
      </header>

      ${buildTrafficDrawingSheet(payload, reportReference, generated)}

      <section class="report-verdict ${assessment.severity}">
        <div>
          <h2>${reportEscape(assessment.headline)}</h2>
          <p>${durationDetail}</p>
        </div>
      </section>

      <section class="report-decision-grid" aria-label="Interpretation and recommendation">
        <div class="report-decision-card primary">
          <span>Recommended action</span>
          <h2>${reportEscape(assessment.action)}</h2>
        </div>
        <div class="report-decision-card">
          <span>What was tested</span>
          <p><b>${reportEscape(payload.road_name)}</b> · ${reportEscape(payload.closure?.description)}${payload.closure?.open_direction?.label ? ` · direction kept open: ${reportEscape(payload.closure.open_direction.label)}` : ''}. ${reportEscape(payload.scenario?.label)}, sampled over ${reportNumber(payload.duration_min, 0, ' minutes')}.</p>
        </div>
      </section>

      <section class="report-section">
        <div class="report-section-heading"><h2>Where traffic shifts to</h2><span>Streets nearby, before vs after</span></div>
        ${trafficReportMap(payload)}
      </section>

      <section class="report-section">
        <div class="report-section-heading"><h2>What changes for road users</h2><span>Road open compared with road closed</span></div>
        <div class="report-stat-grid">
          <div class="report-stat"><span>Journey time</span><strong>${reportChange(decisionValue(impact.mean_journey_time_change_s), 0, ' sec')}</strong><small>${percent(decisionValue(impact.mean_journey_time_change_pct))} on average, per trip</small></div>
          <div class="report-stat"><span>Queuing</span><strong>${reportNumber(impact.max_queue_closure, 0, ' vehicles')}</strong><small>Busiest moment · was ${reportNumber(impact.max_queue_baseline, 0)} before</small></div>
          <div class="report-stat"><span>Trips completed</span><strong>${reportNumber(impact.completed_trip_ratio_closure === null ? null : impact.completed_trip_ratio_closure * 100, 0, '%')}</strong><small>Was ${reportNumber(impact.completed_trip_ratio_baseline === null ? null : impact.completed_trip_ratio_baseline * 100, 0, '%')} before</small></div>
          <div class="report-stat"><span>Traffic speed</span><strong>${reportChange(toKmh(decisionValue(impact.mean_speed_change_mps)), 1, ' km/h', true)}</strong><small>${percent(decisionValue(impact.mean_speed_change_pct))} on average</small></div>
          <div class="report-stat"><span>CO₂ emitted</span><strong>${percent(reportedEnvironment.co2_kg?.change_pct)}</strong><small>${reportChange(reportedEnvironment.co2_kg?.change, 2, ' kg')} over the sample window</small></div>
          <div class="report-stat"><span>Lanes closed</span><strong>${reportNumber(payload.closure?.lanes_closed, 0)}</strong><small>${reportEscape(payload.closure?.description || '—')}</small></div>
        </div>
      </section>

      <section class="report-section report-two-column">
        <div>
          <div class="report-section-heading"><h2>Most affected nearby roads</h2><span>Where traffic shifts to</span></div>
          <ul class="report-list">${flowItems}</ul>
        </div>
        <div>
          <div class="report-section-heading"><h2>Around this street</h2><span>What's already there</span></div>
          <ul class="report-list">
            <li><b>Parking spaces nearby</b><span>${reportNumber(activity.parking_spaces, 0)}</span></li>
            <li><b>Pedestrian crossings nearby</b><span>${reportNumber(activity.pedestrian_crossings, 0)}</span></li>
            <li><b>Raised crossings</b><span>${reportNumber(activity.raised_crossings, 0)}</span></li>
          </ul>
        </div>
      </section>

      <section class="report-section">
        <div class="report-section-heading"><h2>Comparison provenance</h2><span>Reproduce and compare this run</span></div>
        <div class="report-note">Demand seed <b>${reportNumber(demand.seed, 0)}</b> · ${reportNumber(demand.planned_vehicle_count, 0)} generated trips · ${reportNumber(impact.compared_trip_count, 0)} paired completions (${reportNumber(Number(impact.paired_trip_ratio || 0) * 100, 1, '%')}) · open-road completion ${reportNumber(Number(impact.completed_trip_ratio_baseline || 0) * 100, 1, '%')} · peak calibration ${historicalCalibration.applied ? `${reportEscape(historicalCalibration.observed_peak_window || 'fixed scenario window')} from ${reportNumber(historicalCalibration.distinct_days, 0)} weekdays` : 'not yet ready'} · ${reportEscape(payload.signal_data_source || 'signal source not recorded')}. Opposite one-way directions are comparable only when scenario, duration, demand multiplier, demand seed and generated-trip count match.</div>
      </section>

      <section class="report-section">
        <div class="report-section-heading"><h2>How to read this report</h2><span>In plain terms</span></div>
        <div class="report-note">This is a "what-if" through-traffic simulation: the same synthetic traffic is sent through the network twice — once as normal, once with this closure — and the two runs are compared. It is not calibrated to observed counts on the selected street and does not model driveway, loading, pedestrian, public-transport or emergency-access operations. Treat it as option screening, not a certified traffic study.</div>
      </section>

      <footer class="report-footer">
        <img src="/branding/MisisonFavicon.webp" alt=""> Mission for Inner City Cape Town · ${reportEscape(reportReference)}
      </footer>`;

    trafficReportDocument.scrollTop = 0;
    if (typeof trafficReportDialog.showModal === 'function') trafficReportDialog.showModal();
    else trafficReportDialog.setAttribute('open', '');
  }

  function buildTrafficResult(payload) {
    trafficState.result = payload;
    trafficState.durationS = Math.round((payload.duration_min || 15) * 60);
    trafficState.sampleIntervalS = payload.playback?.sample_interval_s || 2;
    resetTrafficCars();
    if (trafficCompare) trafficCompare.value = 'closure';
    applyTrafficCompareSelection();
    clearStatusGroup(trafficDrawingGroup);
    buildScenarioRoadStatuses(payload);
    const impact = payload.impact || {};
    const environment = impact.environment || {};
    const formatPercent = value => (value === null || value === undefined)
      ? '—'
      : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
    if (trafficResults) {
      trafficResults.hidden = false;
      trafficResults.innerHTML = `
        <span><b>${formatPercent(impact.mean_journey_time_change_pct)}</b>Journey time</span>
        <span><b>${formatPercent(impact.mean_speed_change_pct)}</b>Mean speed</span>
        <span><b>${impact.max_queue_baseline ?? 0} → ${impact.max_queue_closure ?? 0}</b>Peak queue</span>
        <span><b>${impact.completed_trip_ratio_baseline === null || impact.completed_trip_ratio_baseline === undefined ? '—' : `${Math.round(impact.completed_trip_ratio_baseline * 100)}%`} → ${impact.completed_trip_ratio_closure === null || impact.completed_trip_ratio_closure === undefined ? '—' : `${Math.round(impact.completed_trip_ratio_closure * 100)}%`}</b>Trips completed</span>
        <span><b>${formatPercent(environment.co2_kg?.change_pct)}</b>CO₂</span>
        <span><b>${payload.closure?.lanes_closed || 0}</b>Lanes closed</span>`;
    }
    if (trafficImpactSummary) {
      const assessment = trafficImpactAssessment(impact);
      trafficImpactSummary.className = `traffic-impact-summary ${assessment.severity}`;
      trafficImpactSummary.innerHTML = `<strong>${assessment.headline}</strong>`
        + (assessment.severity === 'incomplete'
          ? assessment.action
          : `${assessment.action} ${formatPercent(assessment.durationChange)} paired journey time · `
            + `${assessment.completionChange >= 0 ? '+' : ''}${assessment.completionChange.toFixed(1)} percentage-point completion change.`);
      trafficImpactSummary.hidden = false;
    }
    if (trafficStatus) {
      trafficStatus.textContent = `${payload.road_name} · ${payload.baseline.trip_count} before · `
        + `${payload.closure_metrics.trip_count} with closure`;
    }
    if (trafficToggle) trafficToggle.checked = true;
    if (trafficCompare) trafficCompare.disabled = false;
    if (trafficReport) trafficReport.disabled = false;
    trafficState.enabled = true;
    syncTrafficSceneVisibility();
    frameBounds(payload.corridor?.road_bounds_local);
    requestRender();
  }

  async function runTrafficClosurePreview() {
    if (!trafficState.selectedEdgeIds.length) return;
    trafficRun.disabled = true;
    trafficRun.textContent = 'Simulating…';
    trafficStatus.textContent = 'Running paired SUMO simulations (road open vs closed)… this can take up to a minute.';
    try {
      const response = await fetch(`${windApi}/traffic/closure-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          road_name: trafficSelectionLabel(),
          edge_ids: trafficState.selectedEdgeIds,
          duration_min: Number(trafficDuration?.value) || 10,
          scenario: trafficScenario?.value || 'am_peak',
          closure_mode: trafficState.closureMode,
          traffic_control: trafficControlModel?.value || 'signalized',
          demand_multiplier: Number(trafficDemand?.value) || 1,
          one_way: trafficState.oneWay,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      buildTrafficResult(payload);
    } catch (error) {
      trafficStatus.textContent = `Closure preview unavailable (${error.message})`;
    } finally {
      trafficRun.disabled = !trafficState.selectedEdgeIds.length;
      trafficRun.textContent = 'Run comparison';
    }
  }

  function foamToViewerPoint(foamX, foamY, foamZ) {
    const coordinates = windState.cfd.manifest.coordinates;
    const center = coordinates.viewer_center_xz;
    const downwind = coordinates.x_downwind_in_viewer_xz;
    const crosswind = coordinates.y_crosswind_in_viewer_xz;
    return [
      center[0] + foamX * downwind[0] + foamY * crosswind[0],
      foamZ + coordinates.vertical_datum_m,
      center[1] + foamX * downwind[1] + foamY * crosswind[1],
    ];
  }

  function viewerToFoamPoint(x, worldY, z) {
    const coordinates = windState.cfd.manifest.coordinates;
    const relativeX = x - coordinates.viewer_center_xz[0];
    const relativeZ = z - coordinates.viewer_center_xz[1];
    return [
      relativeX * coordinates.x_downwind_in_viewer_xz[0] + relativeZ * coordinates.x_downwind_in_viewer_xz[1],
      relativeX * coordinates.y_crosswind_in_viewer_xz[0] + relativeZ * coordinates.y_crosswind_in_viewer_xz[1],
      worldY - coordinates.vertical_datum_m,
    ];
  }

  function sampleCfd(x, worldY, z) {
    const cfd = windState.cfd;
    if (!cfd) return null;
    const foam = viewerToFoamPoint(x, worldY, z);
    const { origin_foam_m: origin, spacing_foam_m: spacing, dimensions } = cfd.manifest;
    const coordinate = foam.map((value, axis) => (value - origin[axis]) / spacing[axis]);
    if (coordinate.some((value, axis) => value < 0 || value > dimensions[axis] - 1)) return null;
    const lower = coordinate.map((value, axis) => Math.min(Math.floor(value), dimensions[axis] - 2));
    const fraction = coordinate.map((value, axis) => clamp(value - lower[axis], 0, 1));
    const result = new Float32Array(cfd.channelCount);
    let weightTotal = 0;
    for (let dz = 0; dz <= 1; dz += 1) {
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const ix = lower[0] + dx;
          const iy = lower[1] + dy;
          const iz = lower[2] + dz;
          const sampleIndex = iz * dimensions[0] * dimensions[1] + iy * dimensions[0] + ix;
          if (!cfd.mask[sampleIndex]) continue;
          const weight = (dx ? fraction[0] : 1 - fraction[0])
            * (dy ? fraction[1] : 1 - fraction[1])
            * (dz ? fraction[2] : 1 - fraction[2]);
          for (let channel = 0; channel < cfd.channelCount; channel += 1) {
            result[channel] += cfd.fields[sampleIndex * cfd.channelCount + channel] * weight;
          }
          weightTotal += weight;
        }
      }
    }
    if (weightTotal < 0.05) return null;
    for (let channel = 0; channel < result.length; channel += 1) result[channel] /= weightTotal;
    return {
      u: result[cfd.channels.u_viewer_x],
      w: result[cfd.channels.w_up],
      v: result[cfd.channels.v_viewer_z],
      speed: result[cfd.channels.speed],
      p: result[cfd.channels.p],
      k: result[cfd.channels.k],
      epsilon: result[cfd.channels.epsilon],
    };
  }

  function cfdFieldRange(name) {
    return windState.cfdLocalRange?.[name] || windState.cfd?.manifest.ranges?.[name] || [0, 1];
  }

  // A minimum span keeps colour contrast meaningful when a view happens to
  // be almost uniformly calm (a near-zero span would blow tiny noise up into
  // the full colour range) and floors speed at zero rather than the sampled
  // minimum, since "no wind" is a real, meaningful value to show distinctly.
  function computeLocalRange(field, values) {
    if (!values.length) return null;
    const minimumSpan = field === 'speed' ? 1.5 : field === 'p' ? 4 : 0.05;
    let sampledMinimum = Infinity;
    let maximum = -Infinity;
    for (const value of values) {
      if (value < sampledMinimum) sampledMinimum = value;
      if (value > maximum) maximum = value;
    }
    const minimum = field === 'speed' ? 0 : sampledMinimum;
    if (maximum - minimum < minimumSpan) maximum = minimum + minimumSpan;
    return [minimum, maximum];
  }

  function cfdColor(value, field = windState.cfdField) {
    const [minimum, maximum] = cfdFieldRange(field);
    if (field === 'p') {
      const extent = Math.max(Math.abs(minimum), Math.abs(maximum), 1);
      const t = clamp(value / extent * 0.5 + 0.5, 0, 1);
      return t < 0.5
        ? new THREE.Color(0x265bd7).lerp(new THREE.Color(0xf2f4f5), t * 2)
        : new THREE.Color(0xf2f4f5).lerp(new THREE.Color(0xe33b35), (t - 0.5) * 2);
    }
    if (field === 'k') {
      const t = clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
      return new THREE.Color(0x26145c).lerp(new THREE.Color(0xee3a80), Math.sqrt(t)).lerp(new THREE.Color(0xffd55c), t * t);
    }
    return windColor(value, minimum, maximum);
  }

  const CFD_FIELD_LABELS = { speed: 'Velocity magnitude', p: 'Pressure', k: 'Turbulence kinetic energy' };

  function updateCfdLegend() {
    if (!windState.cfd) return;
    const [minimum, maximum] = cfdFieldRange(windState.cfdField);
    const units = windState.cfdField === 'speed' ? 'm/s' : 'm²/s²';
    if (windLegendField) windLegendField.textContent = CFD_FIELD_LABELS[windState.cfdField] || windState.cfdField;
    windLegendLow.innerHTML = `<b>${minimum.toFixed(2)}</b> ${units} · low`;
    windLegendHigh.innerHTML = `<b>${maximum.toFixed(2)}</b> ${units} · high`;
    windGradient?.classList.remove('comfort');
    windGradient?.classList.toggle('pressure', windState.cfdField === 'p');
    windGradient?.classList.toggle('turbulence', windState.cfdField === 'k');
    if (windComfortChips) windComfortChips.hidden = true;
  }

  const COMFORT_CHIP_COLORS = ['#287f69', '#55aa70', '#a8c84c', '#e5bd3f', '#df8039', '#c7473f'];

  function renderComfortLegend() {
    if (windLegendField) windLegendField.textContent = 'Comfort category';
    if (!windComfortChips) return;
    windComfortChips.hidden = false;
    windComfortChips.innerHTML = COMFORT_CATEGORY_DEFS.map(category => `
      <span><i style="background:${COMFORT_CHIP_COLORS[category.code]}"></i>${category.label}${
        category.max_speed_mps ? ` ≤${category.max_speed_mps} m/s` : ''}</span>`).join('');
  }

  // Registry of solved OpenFOAM cases available to the browser. Only SE is
  // meshed and solved today; append entries here (and enable the matching
  // compass button in index.html) as more directions are converted with
  // scripts/convert_openfoam_vtk.py. Direction and Comfort both read this —
  // neither ever synthesizes a direction that isn't listed here.
  const CFD_CASES = [
    { direction_deg: 135, sector: 'se', label: 'SE 135°', base: '/assets/cfd/cbd_se_pilot/' },
    { direction_deg: 315, sector: 'nw', label: 'NW 315°', base: '/assets/cfd/cbd_nw_full/' },
  ];

  function findCfdCase(directionDeg) {
    return CFD_CASES.find(item => item.direction_deg === directionDeg) || null;
  }

  // Fetches and decodes one case's volume into windState.cfd only — no view
  // building, no camera framing, no status/badge text. Direction's own
  // loadCfdWind() below layers all of that on top for its interactive 3D
  // view; Comfort calls this directly because it only needs to *sample* the
  // volume onto a 2D grid and must not disturb Direction's view state
  // (surfaceVisible, cfdView meshes, camera framing) when it runs.
  async function ensureCfdCaseLoaded(directionDeg) {
    const cfdCase = findCfdCase(directionDeg);
    if (!cfdCase) throw new Error(`no solved OpenFOAM case for ${directionDeg}°`);
    const base = cfdCase.base;
    const manifest = await fetch(`${base}volume.json`, { cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
      return response.json();
    });
    const assetVersion = `${manifest.solver.case_id}-${manifest.result_time}-${manifest.dimensions.join('x')}`;
    const [fieldBuffer, maskBuffer] = await Promise.all([
      fetch(`${base}${manifest.fields}?v=${assetVersion}`).then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`fields HTTP ${response.status}`))),
      fetch(`${base}${manifest.valid_mask}?v=${assetVersion}`).then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`mask HTTP ${response.status}`))),
    ]);
    const channels = Object.fromEntries(manifest.channels.map((name, index) => [name, index]));
    const sampleCount = manifest.dimensions.reduce((total, value) => total * value, 1);
    const fields = new Float32Array(fieldBuffer);
    const mask = new Uint8Array(maskBuffer);
    if (fields.length !== sampleCount * manifest.channels.length || mask.length !== sampleCount) {
      throw new Error('CFD asset dimensions do not match its manifest');
    }
    windState.cfd = { manifest, fields, mask, channels, channelCount: manifest.channels.length };
    windState.dataMode = 'cfd';
    return cfdCase;
  }

  async function loadCfdWind(directionDeg = windState.direction) {
    windSimulate.disabled = true;
    windSimulate.textContent = 'Loading CFD volume…';
    windStatus.textContent = 'Loading compact OpenFOAM fields…';
    try {
      const cfdCase = await ensureCfdCaseLoaded(directionDeg);
      const manifest = windState.cfd.manifest;
      windState.direction = manifest.direction_deg_from;
      windState.domainCenter = [...manifest.coordinates.viewer_center_xz];
      windState.domainSize = Math.max(
        manifest.spacing_foam_m[0] * (manifest.dimensions[0] - 1),
        manifest.spacing_foam_m[1] * (manifest.dimensions[1] - 1),
      );
      // Only give the flow box a starting position the first time a case
      // loads. After that it's the user's box — reloading or switching
      // direction must not snap it back to the domain centre.
      if (!windState.flowBoxInitialized) {
        windState.center = [...windState.domainCenter];
        windState.flowBoxInitialized = true;
      }
      windState.volumeHeight = manifest.spacing_foam_m[2] * (manifest.dimensions[2] - 1);
      if (windFlowBoxHeight) {
        windFlowBoxHeight.max = String(Math.round(windState.volumeHeight));
        if (windState.flowBoxHeight > windState.volumeHeight) {
          windState.flowBoxHeight = windState.volumeHeight;
          windFlowBoxHeight.value = String(Math.round(windState.volumeHeight));
          if (windFlowBoxHeightValue) windFlowBoxHeightValue.textContent = String(Math.round(windState.volumeHeight));
        }
      }
      windState.volumeVisible = true;
      windState.surfaceVisible = false;
      windState.field = {
        cfd: true,
        speed: manifest.ranges.speed,
        origin: [-windState.domainSize / 2, -windState.domainSize / 2],
        width: manifest.dimensions[0], height: manifest.dimensions[1],
        dx: manifest.spacing_foam_m[0], dz: manifest.spacing_foam_m[1],
      };
      if (windVolumeVisible) windVolumeVisible.checked = true;
      if (windFlowBoxHeightRow) windFlowBoxHeightRow.hidden = false;
      buildCfdView();
      resetWindParticles();
      updateCfdLegend();
      updateWindBox();
      const solver = manifest.solver;
      const coverage = manifest.building_coverage;
      const coverageLabel = coverage
        ? `${coverage.centroids_in_domain}/${coverage.scene_buildings} buildings in solved domain`
        : 'solved domain only';
      if (windModeBadge) windModeBadge.textContent = coverage?.fraction >= 0.99 ? 'CFD · FULL CBD' : 'CFD · PILOT';
      if (windSourceDetail) windSourceDetail.textContent = `${cfdCase.label} · iteration ${manifest.result_time} · ${coverageLabel}`;
      windDirectionPresets.forEach(button => button.classList.toggle('active', Number(button.dataset.windDirection) === windState.direction));
      windStatus.textContent = `OpenFOAM ${solver.version} · ${windState.cfdGroundHeight.toFixed(1)} m pedestrian field · ${coverageLabel}`;
      const half = windState.domainSize * 0.52;
      frameBounds([
        windState.domainCenter[0] - half, windState.domainCenter[1] - half,
        windState.domainCenter[0] + half, windState.domainCenter[1] + half,
      ], { elevation: 0.38 });
    } catch (error) {
      windStatus.textContent = `CFD volume unavailable (${error.message})`;
    } finally {
      windSimulate.disabled = false;
      windSimulate.textContent = 'Reload OpenFOAM result';
      requestRender();
    }
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

  function sampleWindAtHeight(x, z, heightAboveGround, worldY = null) {
    if (windState.dataMode === 'cfd' && windState.cfd) {
      // heightAboveGround is only set once, at particle spawn; a particle's
      // real world-Y drifts from terrain-relative height as vertical velocity
      // (w) accumulates. Sampling at the caller's live worldY keeps the
      // velocity query at the same point the particle is actually drawn at —
      // recomputing it from the stale spawn height sampled the wrong cell
      // (often outside the valid mask) and froze particles mid-air.
      const y = worldY != null ? worldY : terrainHeightAt(x, z) + heightAboveGround;
      return sampleCfd(x, y, z) || { u: 0, w: 0, v: 0, speed: 0, p: 0, k: 0 };
    }
    const sampled = sampleWind(x, z);
    if (!windState.volumeVisible) return sampled;
    // The current screening model supplies one horizontal slice. For the
    // volume preview only, extend it with the same stability/profile exponent
    // used by the API. A real CFD volume will replace this with sampled Ux/Uy/Uz.
    const sourceHeight = Math.max(0.5, Number(windState.field?.height_m) || windState.height || 2);
    const exponent = Number(windState.field?.height_profile_exponent) || 0.28;
    const factor = clamp((Math.max(heightAboveGround, 0.5) / sourceHeight) ** exponent, 0.55, 2.4);
    return { u: sampled.u * factor, v: sampled.v * factor, speed: sampled.speed * factor };
  }

  function windColor(value, minimum, maximum) {
    // A wider, more saturated 7-stop ramp than a plain 5-stop blue-red gives
    // calm and gale-force speeds visibly distinct bands rather than a wash
    // of similar blues/reds — deep indigo (still air) through cyan, green,
    // yellow, orange, to near-magenta red (strongest wind) at the top.
    const stops = [
      [0, 0x1c2b8c],
      [0.16, 0x1f7fe0],
      [0.34, 0x1fd0d8],
      [0.5, 0x3ede6b],
      [0.66, 0xf4e03f],
      [0.82, 0xff8a2e],
      [1, 0xe8203f],
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
    for (const child of object.children || []) disposeObject(child);
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
    else object.material?.dispose();
  }

  function clearWindSimulation() {
    for (const object of [windHeatMesh, windPoints, windCfdSlice, windFacadePressure]) {
      if (!object) continue;
      windGroup.remove(object);
      disposeObject(object);
    }
    windHeatMesh = null;
    windPoints = null;
    windCfdSlice = null;
    windFacadePressure = null;
    windState.particles = [];
    restoreStreetLayersAfterWind();
  }

  function cfdGridSample(ix, iy, iz) {
    const cfd = windState.cfd;
    const dimensions = cfd.manifest.dimensions;
    const sampleIndex = iz * dimensions[0] * dimensions[1] + iy * dimensions[0] + ix;
    if (!cfd.mask[sampleIndex]) return null;
    const base = sampleIndex * cfd.channelCount;
    return {
      speed: cfd.fields[base + cfd.channels.speed],
      p: cfd.fields[base + cfd.channels.p],
      k: cfd.fields[base + cfd.channels.k],
    };
  }

  function buildCfdPedestrianSurface() {
    if (windHeatMesh) {
      windGroup.remove(windHeatMesh);
      disposeObject(windHeatMesh);
      windHeatMesh = null;
    }
    if (!windState.cfd || windState.cfdView !== 'ground') return;
    const manifest = windState.cfd.manifest;
    const nativeSpacing = manifest.spacing_foam_m;
    const domainSizeX = nativeSpacing[0] * (manifest.dimensions[0] - 1);
    const domainSizeY = nativeSpacing[1] * (manifest.dimensions[1] - 1);
    const origin = manifest.origin_foam_m;
    // Sample finer than the native ~20 m OpenFOAM grid. That grid is coarser
    // than most street canyons, so a narrow street often has zero native
    // grid points landing inside it — every corner check then fails and the
    // whole street draws as a hole, even though sampleCfd (trilinear) can
    // interpolate a perfectly good value at any point in between. Only the
    // wide main streets happened to catch enough native points to look
    // continuous.
    const groundResolution = 12;
    const columns = Math.max(2, Math.round(domainSizeX / groundResolution));
    const rows = Math.max(2, Math.round(domainSizeY / groundResolution));
    const spacing = [domainSizeX / columns, domainSizeY / rows];
    const points = [];
    const samples = [];
    for (let row = 0; row <= rows; row += 1) {
      for (let column = 0; column <= columns; column += 1) {
        const foamX = origin[0] + column * spacing[0];
        const foamY = origin[1] + row * spacing[1];
        const [x, , z] = foamToViewerPoint(foamX, foamY, 0);
        const worldY = terrainHeightAt(x, z) + windState.cfdGroundHeight;
        const sample = pointInLidarFootprint(x, z) && !windPointInsideBuilding(x, z, worldY)
          ? sampleCfd(x, worldY, z) : null;
        points.push([x, worldY, z]);
        samples.push(sample);
      }
    }
    windState.cfdLocalRange = {
      [windState.cfdField]: computeLocalRange(
        windState.cfdField,
        samples.filter(Boolean).map(sample => sample[windState.cfdField]),
      ),
    };
    const positions = [];
    const colors = [];
    const valid = [];
    for (let index = 0; index < points.length; index += 1) {
      const [x, worldY, z] = points[index];
      const sample = samples[index];
      positions.push(x, worldY + 0.12, z);
      const color = sample ? cfdColor(sample[windState.cfdField]) : new THREE.Color(0x202729);
      colors.push(color.r, color.g, color.b);
      valid.push(Boolean(sample));
    }
    const indices = [];
    const rowWidth = columns + 1;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const a = row * rowWidth + column;
        const b = a + 1;
        const c = a + rowWidth;
        const d = c + 1;
        if (valid[a] && valid[b] && valid[c]) indices.push(a, c, b);
        if (valid[b] && valid[c] && valid[d]) indices.push(b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    windHeatMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.82, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    windHeatMesh.name = `cfd-terrain-following-${windState.cfdGroundHeight}m-${windState.cfdField}`;
    windHeatMesh.renderOrder = 3;
    windGroup.add(windHeatMesh);
    hideStreetLayersForWind();
  }

  function updateCfdSliceLabels(fixedAxis, axes, fixedIndex, centerA, centerB) {
    if (!windState.cfd) return;
    const manifest = windState.cfd.manifest;
    const coordinate = manifest.origin_foam_m[fixedAxis] + fixedIndex * manifest.spacing_foam_m[fixedAxis];
    const axisName = fixedAxis === 0 ? 'downwind x' : fixedAxis === 1 ? 'crosswind y' : 'height z';
    if (windSlicePositionValue) windSlicePositionValue.textContent = `${axisName} ${coordinate.toFixed(0)} m`;
    const spanA = manifest.spacing_foam_m[axes[0]] * (manifest.dimensions[axes[0]] - 1) * windState.sliceWidth;
    const spanB = manifest.spacing_foam_m[axes[1]] * (manifest.dimensions[axes[1]] - 1) * windState.sliceHeight;
    if (windSliceWidthValue) windSliceWidthValue.textContent = `${spanA.toFixed(0)} m`;
    if (windSliceHeightValue) windSliceHeightValue.textContent = `${spanB.toFixed(0)} m`;
    const coordinateA = manifest.origin_foam_m[axes[0]] + centerA * manifest.spacing_foam_m[axes[0]];
    const coordinateB = manifest.origin_foam_m[axes[1]] + centerB * manifest.spacing_foam_m[axes[1]];
    if (windSliceCenterXValue) windSliceCenterXValue.textContent = `${coordinateA.toFixed(0)} m`;
    if (windSliceCenterYValue) windSliceCenterYValue.textContent = `${coordinateB.toFixed(0)} m`;
  }

  // The fixed (sliced-along) axis for the current slice plane choice, plus
  // the world-space unit direction and total length of that axis — shared by
  // buildCfdSlice (to lay out the plane) and the click-and-drag handler
  // below (to turn mouse movement into a slicePosition change).
  function sliceFixedAxis() {
    return windState.slicePlane === 'vertical-crosswind' ? 0 : windState.slicePlane === 'vertical-downwind' ? 1 : 2;
  }
  function sliceAxisWorldDirection(fixedAxis) {
    if (fixedAxis === 2) return new THREE.Vector3(0, 1, 0);
    const coordinates = windState.cfd.manifest.coordinates;
    const vector = fixedAxis === 0 ? coordinates.x_downwind_in_viewer_xz : coordinates.y_crosswind_in_viewer_xz;
    return new THREE.Vector3(vector[0], 0, vector[1]).normalize();
  }
  function sliceAxisWorldLength(fixedAxis) {
    const manifest = windState.cfd.manifest;
    return manifest.spacing_foam_m[fixedAxis] * (manifest.dimensions[fixedAxis] - 1);
  }

  function buildCfdSlice() {
    if (windCfdSlice) {
      windGroup.remove(windCfdSlice);
      disposeObject(windCfdSlice);
      windCfdSlice = null;
    }
    if (!windState.cfd || windState.cfdView !== 'slice') return;
    const manifest = windState.cfd.manifest;
    const dimensions = manifest.dimensions;
    const origin = manifest.origin_foam_m;
    const spacing = manifest.spacing_foam_m;
    const fixedAxis = sliceFixedAxis();
    const axes = fixedAxis === 0 ? [1, 2] : fixedAxis === 1 ? [0, 2] : [0, 1];
    const fixed = Math.round(windState.slicePosition * (dimensions[fixedAxis] - 1));
    const countA = Math.max(2, Math.round((dimensions[axes[0]] - 1) * windState.sliceWidth) + 1);
    const countB = Math.max(2, Math.round((dimensions[axes[1]] - 1) * windState.sliceHeight) + 1);
    if (windSliceCenterX) windSliceCenterX.disabled = countA === dimensions[axes[0]];
    if (windSliceCenterY) windSliceCenterY.disabled = countB === dimensions[axes[1]];
    const startA = Math.round((dimensions[axes[0]] - countA) * windState.sliceCenterX);
    const startB = Math.round((dimensions[axes[1]] - countB) * windState.sliceCenterY);
    const width = countA;
    const height = countB;
    updateCfdSliceLabels(fixedAxis, axes, fixed, startA + (countA - 1) / 2, startB + (countB - 1) / 2);
    const points = [];
    const samples = [];
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const index = [0, 0, 0];
        index[fixedAxis] = fixed;
        index[axes[0]] = startA + column;
        index[axes[1]] = startB + row;
        const foam = index.map((value, axis) => origin[axis] + value * spacing[axis]);
        points.push(foamToViewerPoint(...foam));
        samples.push(cfdGridSample(...index));
      }
    }
    windState.cfdLocalRange = {
      [windState.cfdField]: computeLocalRange(
        windState.cfdField,
        samples.filter(Boolean).map(sample => sample[windState.cfdField]),
      ),
    };
    const positions = [];
    const colors = [];
    const valid = [];
    for (let index = 0; index < points.length; index += 1) {
      const sample = samples[index];
      positions.push(...points[index]);
      const color = sample ? cfdColor(sample[windState.cfdField]) : new THREE.Color(0x252a2c);
      colors.push(color.r, color.g, color.b);
      valid.push(Boolean(sample));
    }
    const indices = [];
    for (let row = 0; row < height - 1; row += 1) {
      for (let column = 0; column < width - 1; column += 1) {
        const a = row * width + column;
        const b = a + 1;
        const c = a + width;
        const d = c + 1;
        if (valid[a] && valid[b] && valid[c]) indices.push(a, c, b);
        if (valid[b] && valid[c] && valid[d]) indices.push(b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const sliceMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.NormalBlending,
    }));
    sliceMesh.renderOrder = 4;
    const corners = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]].map(([column, row]) => {
      const index = [0, 0, 0];
      index[fixedAxis] = fixed;
      index[axes[0]] = startA + column;
      index[axes[1]] = startB + row;
      return foamToViewerPoint(...index.map((value, axis) => origin[axis] + value * spacing[axis]));
    });
    const outlineGeometry = new THREE.BufferGeometry().setFromPoints(corners.map(point => new THREE.Vector3(...point)));
    const outline = new THREE.LineLoop(outlineGeometry, new THREE.LineBasicMaterial({
      color: 0xe8fbff, transparent: true, opacity: 0.9, depthTest: false,
    }));
    outline.renderOrder = 6;
    windCfdSlice = new THREE.Group();
    windCfdSlice.add(sliceMesh, outline);
    windCfdSlice.name = `cfd-${windState.cfdField}-${windState.slicePlane}-slice`;
    windGroup.add(windCfdSlice);
  }

  function buildCfdFacadePressure() {
    if (windFacadePressure) {
      windGroup.remove(windFacadePressure);
      disposeObject(windFacadePressure);
      windFacadePressure = null;
    }
    if (!windState.cfd || windState.cfdView !== 'facade') return;
    const positions = [];
    const colors = [];
    const indices = [];
    for (const [ground, height, ring, , , wallHeight = height, , , , , minHeight = 0] of data.buildings) {
      if (!ring?.length) continue;
      const baseY = ground + Math.max(0, Number(minHeight) || 0);
      const roofY = ground + Math.max(height, wallHeight);
      if (roofY <= baseY + 0.5) continue;
      const centroid = ring.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
      centroid[0] /= ring.length;
      centroid[1] /= ring.length;
      for (let edge = 0; edge < ring.length; edge += 1) {
        const a = ring[edge];
        const b = ring[(edge + 1) % ring.length];
        const ax = centroid[0] + (a[0] - centroid[0]) * 1.006;
        const az = centroid[1] + (a[1] - centroid[1]) * 1.006;
        const bx = centroid[0] + (b[0] - centroid[0]) * 1.006;
        const bz = centroid[1] + (b[1] - centroid[1]) * 1.006;
        const bands = Math.max(1, Math.min(5, Math.ceil((roofY - baseY) / 12)));
        for (let band = 0; band < bands; band += 1) {
          const lowY = baseY + (roofY - baseY) * band / bands;
          const highY = baseY + (roofY - baseY) * (band + 1) / bands;
          const sample = sampleCfd((ax + bx) / 2, (lowY + highY) / 2, (az + bz) / 2);
          if (!sample) continue;
          const color = cfdColor(sample.p, 'p');
          const offset = positions.length / 3;
          positions.push(ax, lowY, az, bx, lowY, bz, ax, highY, az, bx, highY, bz);
          for (let vertex = 0; vertex < 4; vertex += 1) colors.push(color.r, color.g, color.b);
          indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    windFacadePressure = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
    }));
    windFacadePressure.name = 'cfd-facade-pressure';
    windFacadePressure.renderOrder = 5;
    windGroup.add(windFacadePressure);
  }

  function buildCfdView() {
    if (windState.cfdView !== 'ground') restoreStreetLayersAfterWind();
    // Ground/slice recompute this for whichever field is showing; reset
    // first so switching to Flow/Façades never colours with a stale range
    // left over from a different view (that range can be much narrower than
    // what those views actually span, which would blow the colours out).
    windState.cfdLocalRange = null;
    buildCfdPedestrianSurface();
    buildCfdSlice();
    buildCfdFacadePressure();
    if (windPoints) windPoints.visible = windState.cfdView === 'flow' && windState.flowlinesVisible;
    updateCfdLegend();
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
    const comfortMode = field.analysis_mode === 'comfort' && field.comfort_category?.length;
    const minimum = comfortMode ? 0 : Math.min(...field.speed);
    const maximum = comfortMode ? 5 : Math.max(...field.speed, windState.speed * 0.1, 0.1);
    const comfortColors = [0x287f69, 0x55aa70, 0xa8c84c, 0xe5bd3f, 0xdf8039, 0xc7473f];
    const positions = [];
    const colors = [];
    const indices = [];
    for (let row = 0; row <= field.height; row += 1) {
      for (let column = 0; column <= field.width; column += 1) {
        const x = field.origin[0] + column * field.dx;
        const z = field.origin[1] + row * field.dz;
        const sampled = sampleWind(x, z);
        let color;
        if (comfortMode) {
          const sourceColumn = clamp(Math.floor((x - field.origin[0]) / field.dx), 0, field.width - 1);
          const sourceRow = clamp(Math.floor((z - field.origin[1]) / field.dz), 0, field.height - 1);
          const code = field.comfort_category[sourceRow * field.width + sourceColumn] ?? 5;
          color = new THREE.Color(comfortColors[code]);
        } else {
          color = windColor(sampled.speed, minimum, maximum);
        }
        positions.push(x, terrainHeightAt(x, z) + 1.05, z);
        colors.push(color.r, color.g, color.b);
      }
    }
    const rowWidth = field.width + 1;
    for (let row = 0; row < field.height; row += 1) {
      for (let column = 0; column < field.width; column += 1) {
        if (comfortMode) {
          // Require both: a real CFD sample (excludes the lidar-footprint
          // holes for water bodies etc. wrongly leaving false-comfortable
          // gaps) AND inside the mapped city footprint (excludes the wide
          // upstream/downstream clearance buffer the solved wind-aligned
          // domain carries beyond the actual mapped terrain — that buffer is
          // real CFD data, but rendering it read as the study spilling out
          // past its own bounds since it's ocean/unmapped land, not city).
          const centerX = field.origin[0] + (column + 0.5) * field.dx;
          const centerZ = field.origin[1] + (row + 0.5) * field.dz;
          if (!field.valid?.[row * field.width + column] || !pointInLidarFootprint(centerX, centerZ)) continue;
        } else {
          const centerX = field.origin[0] + (column + 0.5) * field.dx;
          const centerZ = field.origin[1] + (row + 0.5) * field.dz;
          if (!pointInLidarFootprint(centerX, centerZ)) continue;
        }
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
    windHeatMesh.visible = windState.surfaceVisible;
    windGroup.add(windHeatMesh);
    if (windState.enabled && windState.surfaceVisible) hideStreetLayersForWind();
  }

  function spawnWindParticle(field) {
    const makeParticle = (x, worldY, z, age, heightAboveGround) => ({
      x, worldY, z, spawnX: x, spawnY: worldY, spawnZ: z, age, heightAboveGround, u: 0, w: 0, v: 0,
      trail: Array.from({ length: windTrailPoints }, () => [x, worldY, z]),
    });
    if (windState.dataMode === 'cfd' && windState.cfd) {
      // Seed across the user's flow box (like the old "draw a box, then
      // simulate" domain), not a fixed curtain over the whole ~2600 m solved
      // domain — that mostly seeded particles far upstream of the streets
      // anyone actually wanted to look at, so they read as a small,
      // disconnected patch of dashes rather than flow through the city.
      const half = windState.size / 2;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const x = windState.center[0] + (Math.random() * 2 - 1) * half;
        const z = windState.center[1] + (Math.random() * 2 - 1) * half;
        const groundY = terrainHeightAt(x, z);
        const heightAboveGround = windState.volumeVisible
          ? 2 + Math.random() ** 1.5 * Math.max(3, windState.flowBoxHeight - 2)
          : windState.cfdGroundHeight + Math.random() * 3;
        const worldY = groundY + heightAboveGround;
        if (sampleCfd(x, worldY, z) && !windPointInsideBuilding(x, z, worldY)) {
          return makeParticle(x, worldY, z, Math.random() * 7, heightAboveGround);
        }
      }
    }
    const minX = field.origin[0];
    const maxX = minX + field.width * field.dx;
    const minZ = field.origin[1];
    const maxZ = minZ + field.height * field.dz;
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      const heightAboveGround = windState.volumeVisible
        ? 3 + Math.random() ** 1.35 * Math.max(3, windState.volumeHeight - 3)
        : 5;
      const worldY = terrainHeightAt(x, z) + heightAboveGround;
      if (pointInLidarFootprint(x, z) && !windPointInsideBuilding(x, z, worldY)) {
        return makeParticle(x, worldY, z, Math.random() * 8, heightAboveGround);
      }
    }
    // A deterministic fallback keeps the particle count stable even if a very
    // small analysis box happens to be mostly occupied by a large footprint.
    const fallbackX = clamp(windState.center[0], minX, maxX);
    const fallbackZ = clamp(windState.center[1], minZ, maxZ);
    const fallbackHeight = windState.volumeVisible ? windState.volumeHeight : 5;
    return makeParticle(fallbackX, terrainHeightAt(fallbackX, fallbackZ) + fallbackHeight, fallbackZ, 0, fallbackHeight);
  }

  function resetWindParticles() {
    const count = Math.round(clamp(windState.particleCount, 200, 1600));
    windState.particles = Array.from({ length: count }, () => spawnWindParticle(windState.field));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * (windTrailPoints - 1) * 6), 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * (windTrailPoints - 1) * 6), 3));
    if (windPoints) {
      windGroup.remove(windPoints);
      disposeObject(windPoints);
    }
    windPoints = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    windPoints.name = 'wind-gusts';
    windPoints.renderOrder = 3;
    windPoints.visible = windState.flowlinesVisible && windState.analysisMode !== 'comfort' && windState.cfdView === 'flow';
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
    const boxHeight = windState.volumeVisible ? windState.flowBoxHeight : 45;
    windBox.scale.set(windState.size, boxHeight / 45, windState.size);
    windBox.material.opacity = windState.moveMode ? 0.14 : 0.035;
    const y = terrainHeightAt(windState.center[0], windState.center[1]) + boxHeight * 0.5 + 1;
    windBox.position.set(windState.center[0], y, windState.center[1]);
    windEdges.position.copy(windBox.position);
    windEdges.scale.copy(windBox.scale);
    const half = windState.size * 0.5;
    windHandle.position.set(windState.center[0] + half, y + boxHeight * 0.5, windState.center[1] + half);
    windHandle.visible = windState.moveMode;
    const showPreviewBox = windState.analysisMode === 'direction' && windState.cfdView === 'flow';
    windBox.visible = showPreviewBox;
    windEdges.visible = showPreviewBox;
    windHandle.visible = showPreviewBox && windState.moveMode;
    requestRender();
  }

  async function simulateWind() {
    if (windState.analysisMode === 'comfort') {
      await runComfortStudy();
      return;
    }
    await loadCfdWind(windState.direction);
  }

  // Lanczos approximation of Γ(x), g=7, n=9 — accurate to ~1e-10 over the
  // shape-parameter range (~1.5–6) the ERA5 Weibull fits use.
  const GAMMA_COEFFICIENTS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  function gamma(x) {
    if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
    const z = x - 1;
    let sum = GAMMA_COEFFICIENTS[0];
    for (let index = 1; index < 9; index += 1) sum += GAMMA_COEFFICIENTS[index] / (z + index);
    const t = z + 7.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * sum;
  }
  function weibullExceedance(meanSpeed, thresholdMps, shape) {
    if (!(meanSpeed > 1e-9)) return 0;
    const scale = meanSpeed / gamma(1 + 1 / shape);
    return Math.exp(-Math.pow(thresholdMps / scale, shape));
  }

  const COMFORT_THRESHOLDS_MPS = [2.5, 4, 6, 8, 10];
  // Matches server/wind_metrics.py COMFORT_CATEGORIES so the inline results
  // summary (setupWindResults in app.js) can read field.comfort_categories
  // the same way it already does for the old screening comfort field.
  const COMFORT_CATEGORY_DEFS = [
    { code: 0, key: 'long_sitting', label: 'Long sitting', max_speed_mps: 2.5 },
    { code: 1, key: 'short_sitting', label: 'Short sitting', max_speed_mps: 4.0 },
    { code: 2, key: 'standing', label: 'Standing', max_speed_mps: 6.0 },
    { code: 3, key: 'strolling', label: 'Strolling', max_speed_mps: 8.0 },
    { code: 4, key: 'business_walking', label: 'Business walking', max_speed_mps: 10.0 },
    { code: 5, key: 'uncomfortable', label: 'Uncomfortable', max_speed_mps: null },
  ];

  // Comfort as "weighted screening across 16 directions" only made sense
  // while every direction shared one fast proxy solver. Now that Direction
  // is OpenFOAM, Comfort weights whichever directions actually have a solved
  // case by their ERA5 wind-rose frequency and Weibull exceedance — the same
  // math server/field.py used, just summed over 1 term instead of 16. It
  // never interpolates or assumes calm for the missing sectors; it excludes
  // them, so the result is an honest lower bound, not a full annual study.
  async function runComfortStudy() {
    windSimulate.disabled = true;
    windSimulate.textContent = 'Weighting OpenFOAM sectors…';
    windStatus.textContent = 'Loading ERA5 sector frequencies…';
    try {
      const params = new URLSearchParams({ season: windState.season, stability: windState.stability });
      const response = await fetch(`${windApi}/wind/climatology/sectors?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const climatology = await response.json();
      const resolved = CFD_CASES
        .map(cfdCase => ({ cfdCase, sector: climatology.sectors.find(item => item.sector === cfdCase.sector) }))
        .filter(entry => entry.sector);
      if (!resolved.length) throw new Error('no ERA5 sector data for any solved OpenFOAM case');
      const coverage = resolved.reduce((sum, entry) => sum + entry.sector.frequency_fraction, 0);

      // A fixed grid, independent of any one case's own solved-domain framing
      // (which shifts slightly per direction), so every resolved case's
      // contribution samples the exact same cells and can be summed directly.
      const domainCenter = [0, 0];
      const domainSize = 2600;
      const half = domainSize / 2;
      const resolution = 20;
      const width = Math.max(4, Math.round(domainSize / resolution));
      const height = width;
      const dx = domainSize / width;
      const dz = domainSize / height;
      const originX = domainCenter[0] - half;
      const originZ = domainCenter[1] - half;
      const cellCount = width * height;
      const speed = new Array(cellCount).fill(0);
      const u = new Array(cellCount).fill(0);
      const v = new Array(cellCount).fill(0);
      // Tracks cells that got an OpenFOAM sample from at least one resolved
      // case. Each case's own wind-aligned solved volume rotated inside this
      // axis-aligned sampling grid leaves its corners — and the odd internal
      // cell that landed outside the valid mesh — unsampled; without this,
      // those cells defaulted to "long sitting" (the first exceedance loop
      // below sees all-zero exceedance and picks the calmest category),
      // which both drew as a false-comfortable colour and inflated the
      // comfort share stats.
      const valid = new Uint8Array(cellCount);
      const exceedanceByThreshold = COMFORT_THRESHOLDS_MPS.map(() => new Array(cellCount).fill(0));
      // Load and sample one case's volume at a time — every resolved
      // direction contributes its own weighted share to the same grid, never
      // interpolated with the others, only summed.
      for (const { cfdCase, sector } of resolved) {
        windStatus.textContent = `Sampling ${cfdCase.label}…`;
        await ensureCfdCaseLoaded(cfdCase.direction_deg);
        for (let row = 0; row < height; row += 1) {
          for (let column = 0; column < width; column += 1) {
            const x = originX + (column + 0.5) * dx;
            const z = originZ + (row + 0.5) * dz;
            const worldY = terrainHeightAt(x, z) + windState.cfdGroundHeight;
            const index = row * width + column;
            const sample = sampleCfd(x, worldY, z);
            if (!sample) continue;
            valid[index] = 1;
            speed[index] += sample.speed * sector.frequency_fraction;
            u[index] += sample.u * sector.frequency_fraction;
            v[index] += sample.v * sector.frequency_fraction;
            COMFORT_THRESHOLDS_MPS.forEach((threshold, thresholdIndex) => {
              exceedanceByThreshold[thresholdIndex][index]
                += weibullExceedance(sample.speed, threshold, sector.weibull_shape) * sector.frequency_fraction;
            });
          }
        }
      }
      const comfortCategory = new Array(cellCount).fill(5);
      for (let index = 0; index < cellCount; index += 1) {
        if (!valid[index]) continue;
        for (let thresholdIndex = 0; thresholdIndex < COMFORT_THRESHOLDS_MPS.length; thresholdIndex += 1) {
          if (exceedanceByThreshold[thresholdIndex][index] <= 0.05) {
            comfortCategory[index] = thresholdIndex;
            break;
          }
        }
      }
      // "Standing" (6 m/s) is the representative single-threshold exceedance
      // reported in the inline summary below; the category breakdown above
      // already covers all five activity thresholds at once.
      const standingIndex = COMFORT_THRESHOLDS_MPS.indexOf(6);
      windState.field = {
        analysis_mode: 'comfort',
        cfd: true,
        version: 'cfd-comfort-v1',
        validation_status: windState.cfd?.manifest.validation_status || 'exploratory_unvalidated_pilot',
        comfort_standard: 'Lawson-LDDC-style activity thresholds, OpenFOAM + ERA5 wind-rose weighted (resolved sectors only)',
        season: windState.season,
        height_m: windState.cfdGroundHeight,
        origin: [originX, originZ], width, height, dx, dz,
        speed, u, v, valid, comfort_category: comfortCategory,
        comfort_categories: COMFORT_CATEGORY_DEFS,
        exceedance: { threshold_mps: 6, probability: exceedanceByThreshold[standingIndex] },
        uncertainty: { relative_fraction: 0.35 },
        direction_count: resolved.length,
        coverage_fraction: coverage,
      };
      const sectorList = resolved.map(entry => entry.sector.sector.toUpperCase()).join(', ');
      windStatus.textContent = `OpenFOAM comfort · ${resolved.length}/16 sectors resolved (${sectorList}) · `
        + `${(coverage * 100).toFixed(1)}% of ${windState.season} wind hours covered · lower-bound estimate, `
        + `unsolved directions excluded.`;
    } catch (error) {
      windState.field = null;
      windStatus.textContent = `Comfort study unavailable (${error.message})`;
    }
    windSimulate.disabled = false;
    windSimulate.textContent = 'Run OpenFOAM-weighted comfort study';
    windGradient?.classList.add('comfort');
    windLegendLow.innerHTML = '<b>Long sitting</b> · suitable';
    windLegendHigh.innerHTML = '<b>Uncomfortable</b> · mitigate';
    renderComfortLegend();
    windState.lastTime = performance.now();
    if (!windState.field) {
      requestRender();
      return;
    }
    // Comfort has no surface-visibility toggle of its own (the Appearance
    // section is Direction-only); its heatmap is the entire display, so it
    // must be visible regardless of what Direction last left surfaceVisible
    // at.
    windState.surfaceVisible = true;
    dispatchEvent(new CustomEvent('climate-wind-result', { detail: windState.field }));
    buildWindHeatmap();
    requestRender();
  }

  function updateWindParticles(now) {
    if (!windState.enabled || !windState.field || !windPoints) return;
    const elapsed = Math.min(0.06, (now - windState.lastTime) / 1000) * windState.animationSpeed;
    windState.lastTime = now;
    const half = windState.size * 0.5;
    const positions = windPoints.geometry.attributes.position.array;
    const colors = windPoints.geometry.attributes.color.array;
    const fieldSpeeds = windState.field.speed || [];
    const minimumSpeed = fieldSpeeds.length ? Math.min(...fieldSpeeds) : 0;
    const maximumSpeed = Math.max(...fieldSpeeds, windState.speed, 0.1) * (windState.volumeVisible ? 1.8 : 1);
    windState.particles.forEach((particle, index) => {
      const cfdMode = windState.dataMode === 'cfd' && windState.cfd;
      const worldY = cfdMode ? particle.worldY : terrainHeightAt(particle.x, particle.z) + particle.heightAboveGround;
      const target = redirectWindFlow(
        particle.x, particle.z,
        sampleWindAtHeight(particle.x, particle.z, particle.heightAboveGround, worldY),
        false, worldY,
      );
      // Relax toward the redirected vector over several frames. Instant
      // reflections look like teleports at corners; this gives each gust a
      // short, stable turn radius while preserving the field's speed.
      const blend = 1 - Math.exp(-elapsed * 7);
      particle.u += (target.u - particle.u) * blend;
      particle.w += ((target.w || 0) - particle.w) * blend;
      particle.v += (target.v - particle.v) * blend;
      let sampled = { u: particle.u, w: particle.w, v: particle.v, speed: Math.hypot(particle.u, particle.w, particle.v) };
      const nextX = particle.x + sampled.u * elapsed * 5.5;
      const nextY = worldY + sampled.w * elapsed * 5.5;
      const nextZ = particle.z + sampled.v * elapsed * 5.5;
      particle.age += elapsed;
      // Bound CFD particles to the flow box (with a little overshoot so a
      // wake can visibly clear the edge) rather than the whole ~2600 m
      // solved domain — otherwise a fast respawn near the box reads as
      // "dies after a small section" while the rest of the domain sits empty.
      const outsideDomain = cfdMode
        ? !sampleCfd(nextX, nextY, nextZ)
          || Math.abs(nextX - windState.center[0]) > half + 60
          || Math.abs(nextZ - windState.center[1]) > half + 60
        : Math.abs(nextX - windState.center[0]) > half || Math.abs(nextZ - windState.center[1]) > half;
      const nextWorldY = cfdMode ? nextY : terrainHeightAt(nextX, nextZ) + particle.heightAboveGround;
      const midpointX = (particle.x + nextX) * 0.5;
      const midpointZ = (particle.z + nextZ) * 0.5;
      const midpointWorldY = cfdMode ? (worldY + nextY) * 0.5 : terrainHeightAt(midpointX, midpointZ) + particle.heightAboveGround;
      const midpointBlocked = windPointInsideBuilding(midpointX, midpointZ, midpointWorldY);
      const displacementFromSpawn = Math.hypot(particle.x - particle.spawnX, particle.z - particle.spawnZ);
      // A numerical recirculation or a narrow collision pocket should not
      // keep the same streak alive forever. Re-seed particles that have not
      // made meaningful downstream progress after several seconds.
      if (outsideDomain || particle.age > 9 || (particle.age > 6 && displacementFromSpawn < 20)) {
        Object.assign(particle, spawnWindParticle(windState.field));
        const respawnWorldY = cfdMode ? particle.worldY : terrainHeightAt(particle.x, particle.z) + particle.heightAboveGround;
        const respawnTarget = redirectWindFlow(
          particle.x, particle.z,
          sampleWindAtHeight(particle.x, particle.z, particle.heightAboveGround, respawnWorldY),
          false, respawnWorldY,
        );
        particle.u = respawnTarget.u;
        particle.w = respawnTarget.w || 0;
        particle.v = respawnTarget.v;
        sampled = { u: particle.u, w: particle.w, v: particle.v, speed: Math.hypot(particle.u, particle.w, particle.v) };
      } else if (windPointInsideBuilding(nextX, nextZ, nextWorldY) || midpointBlocked) {
        // Reflect the attempted step into a wall onto the nearest facade
        // tangent, then push the point just outside the footprint. This is a
        // stable pedestrian-height collision response rather than a respawn.
        sampled = redirectWindFlow(particle.x, particle.z, sampled, true, worldY);
        particle.u += (sampled.u - particle.u) * blend;
        particle.v += (sampled.v - particle.v) * blend;
        sampled = { u: particle.u, w: particle.w, v: particle.v, speed: Math.hypot(particle.u, particle.w, particle.v) };
        const redirectedX = particle.x + sampled.u * elapsed * 5.5;
        const redirectedZ = particle.z + sampled.v * elapsed * 5.5;
        const redirectedWorldY = terrainHeightAt(redirectedX, redirectedZ) + particle.heightAboveGround;
        if (windPointInsideBuilding(redirectedX, redirectedZ, redirectedWorldY)) {
          [particle.x, particle.z] = pushWindPointOutsideBuilding(particle.x, particle.z, worldY);
        } else {
          particle.x = redirectedX;
          particle.z = redirectedZ;
        }
        particle.worldY = cfdMode ? worldY : terrainHeightAt(particle.x, particle.z) + particle.heightAboveGround;
        particle.trail = Array.from({ length: windTrailPoints }, () => [particle.x, particle.worldY, particle.z]);
      } else {
        particle.x = nextX;
        particle.worldY = nextWorldY;
        particle.z = nextZ;
      }
      particle.trail.shift();
      particle.trail.push([particle.x, particle.worldY, particle.z]);
      const baseOffset = index * (windTrailPoints - 1) * 6;
      for (let trailIndex = 0; trailIndex < windTrailPoints - 1; trailIndex += 1) {
        const [tailX, tailY, tailZ] = particle.trail[trailIndex];
        const [headX, headY, headZ] = particle.trail[trailIndex + 1];
        const offset = baseOffset + trailIndex * 6;
        positions[offset] = tailX;
        positions[offset + 1] = cfdMode ? tailY : terrainHeightAt(tailX, tailZ) + particle.heightAboveGround;
        positions[offset + 2] = tailZ;
        positions[offset + 3] = headX;
        positions[offset + 4] = cfdMode ? headY : terrainHeightAt(headX, headZ) + particle.heightAboveGround;
        positions[offset + 5] = headZ;
        const segmentSample = cfdMode ? sampleCfd(headX, headY, headZ) : sampleWindAtHeight(headX, headZ, particle.heightAboveGround);
        const color = windState.dataMode === 'cfd'
          ? cfdColor(segmentSample?.speed || 0, 'speed')
          : windColor(segmentSample.speed, minimumSpeed, maximumSpeed);
        const fade = 0.24 + 0.76 * (trailIndex / (windTrailPoints - 2));
        for (let colorOffset = 0; colorOffset < 6; colorOffset += 3) {
          colors[offset + colorOffset] = color.r * fade;
          colors[offset + colorOffset + 1] = color.g * fade;
          colors[offset + colorOffset + 2] = color.b * fade;
        }
      }
    });
    windPoints.geometry.attributes.position.needsUpdate = true;
    windPoints.geometry.attributes.color.needsUpdate = true;
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

  function pointerRaycaster(event) {
    const rect = canvas.getBoundingClientRect();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ), camera);
    return raycaster;
  }

  function requestGroundPick(handler) {
    groundPickHandler = handler;
    canvas.style.cursor = handler ? 'crosshair' : '';
  }

  function addScenePickHandler(handler) {
    scenePickHandlers.add(handler);
    return () => scenePickHandlers.delete(handler);
  }

  function appendTrafficClosurePoint(event, force = false) {
    const point = pointerGround(event);
    if (!point) return false;
    const screen = [event.clientX, event.clientY];
    if (!force && trafficState.lastScreen
      && Math.hypot(screen[0] - trafficState.lastScreen[0], screen[1] - trafficState.lastScreen[1]) < 4) return false;

    const previous = trafficState.strokePoints.at(-1);
    const distance = previous ? Math.hypot(point.x - previous[0], point.z - previous[1]) : 0;
    const sampleCount = Math.max(1, Math.ceil(distance / 8));
    for (let sample = previous ? 1 : sampleCount; sample <= sampleCount; sample += 1) {
      const ratio = sample / sampleCount;
      const sampleX = previous ? previous[0] + (point.x - previous[0]) * ratio : point.x;
      const sampleZ = previous ? previous[1] + (point.z - previous[1]) * ratio : point.z;
      if (!previous || sample === sampleCount) {
        const candidate = [sampleX, sampleZ];
        if (!trafficState.strokePoints.length || Math.hypot(
          candidate[0] - trafficState.strokePoints.at(-1)[0],
          candidate[1] - trafficState.strokePoints.at(-1)[1],
        ) >= 0.35) trafficState.strokePoints.push(candidate);
      }
    }
    trafficState.lastScreen = screen;
    updateTrafficDrawing();
    if (trafficSelectionStatus) {
      trafficSelectionStatus.textContent = trafficState.strokePoints.length > 1
        ? `Freehand stroke recorded · ${trafficState.strokePoints.length} points · release to snap.`
        : 'Draw over the road centreline; release to snap the stroke.';
    }
    return Boolean(trafficState.strokePoints.length);
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

  canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', event => {
    clickCandidate = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    if (groundPickHandler && event.button === 0) {
      const point = pointerGround(event);
      if (point) {
        const handler = groundPickHandler;
        requestGroundPick(null);
        clickCandidate = null;
        handler(point.x, point.z);
        requestRender();
        return;
      }
    }
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
    if (trafficState.drawing && event.button === 0) {
      trafficState.strokePoints = [];
      trafficState.stroking = true;
      trafficState.pointerId = event.pointerId;
      trafficState.lastScreen = null;
      updateTrafficDrawPopup('Drawing stroke… lift your pointer to snap and add these road sections.');
      appendTrafficClosurePoint(event, true);
      capturePointer(event);
      return;
    }
    if (event.button === 2 && removeTrafficSelectionAt(event)) return;
    if (shadowState.enabled && shadowState.mode === 'hours' && shadowState.moveMode && event.button === 0) {
      const point = pointerGround(event);
      if (point) {
        const handleScreen = handleScreenPoint(sunHandle);
        const handleDistance = handleScreen
          ? Math.hypot(event.clientX - handleScreen.x, event.clientY - handleScreen.y)
          : Infinity;
        sunDrag = {
          mode: handleDistance <= 20 ? 'resize' : 'move',
          start: point,
          center: [...shadowState.center],
          size: shadowState.size,
        };
        cancelSunHours('', true);
        sunStatus.textContent = sunDrag.mode === 'resize'
          ? 'Resizing sunlight area · release, then calculate again.'
          : 'Moving sunlight area · release, then calculate again.';
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
        windStatus.textContent = windDrag.mode === 'resize'
          ? 'Resizing flow box…'
          : 'Moving flow box…';
        capturePointer(event);
        return;
      }
    }
    if (windState.enabled && windState.analysisMode === 'direction' && windState.cfdView === 'slice'
      && windCfdSlice && event.button === 0) {
      const hit = pointerRaycaster(event).intersectObject(windCfdSlice, true)[0];
      if (hit) {
        const fixedAxis = sliceFixedAxis();
        sliceDrag = {
          axisDirection: sliceAxisWorldDirection(fixedAxis),
          axisLength: sliceAxisWorldLength(fixedAxis),
          dragPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(
            camera.getWorldDirection(new THREE.Vector3()), hit.point,
          ),
          startPoint: hit.point.clone(),
          startPosition: windState.slicePosition,
        };
        windStatus.textContent = 'Moving slice…';
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
    if (trafficState.drawing && trafficState.stroking && event.pointerId === trafficState.pointerId) {
      appendTrafficClosurePoint(event);
      return;
    }
    if (sunDrag) {
      const point = pointerGround(event);
      if (!point) return;
      if (sunDrag.mode === 'resize') {
        const requested = Math.max(Math.abs(point.x - sunDrag.center[0]), Math.abs(point.z - sunDrag.center[1])) * 2;
        const maximum = Math.min(1000,
          2 * (sunDrag.center[0] - left), 2 * (right - sunDrag.center[0]),
          2 * (sunDrag.center[1] - minZ), 2 * (maxZ - sunDrag.center[1]));
        shadowState.size = Math.round(clamp(requested, 200, maximum) / 25) * 25;
        if (sunDomainSize && [...sunDomainSize.options].some(option => Number(option.value) === shadowState.size)) {
          sunDomainSize.value = String(shadowState.size);
        }
      } else {
        shadowState.center[0] = clamp(sunDrag.center[0] + point.x - sunDrag.start.x, left + shadowState.size / 2, right - shadowState.size / 2);
        shadowState.center[1] = clamp(sunDrag.center[1] + point.z - sunDrag.start.z, minZ + shadowState.size / 2, maxZ - shadowState.size / 2);
      }
      updateSunBox();
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
      updateWindBox();
      return;
    }
    if (sliceDrag) {
      const point = new THREE.Vector3();
      if (!pointerRaycaster(event).ray.intersectPlane(sliceDrag.dragPlane, point)) return;
      const distanceAlongAxis = point.clone().sub(sliceDrag.startPoint).dot(sliceDrag.axisDirection);
      windState.slicePosition = clamp(sliceDrag.startPosition + distanceAlongAxis / sliceDrag.axisLength, 0, 1);
      if (windSlicePosition) windSlicePosition.value = String(Math.round(windState.slicePosition * 100));
      buildCfdSlice();
      requestRender();
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
    if (trafficState.drawing && trafficState.stroking && event.pointerId === trafficState.pointerId) {
      appendTrafficClosurePoint(event, true);
      commitTrafficStroke();
      return;
    }
    drag = null;
    if (clickCandidate && scenePickHandlers.size
      && Math.hypot(event.clientX - clickCandidate.x, event.clientY - clickCandidate.y) < 5) {
      const raycaster = pointerRaycaster(event);
      for (const handler of scenePickHandlers) {
        if (handler({ raycaster, event })) break;
      }
    }
    clickCandidate = null;
    if (sunDrag) {
      sunStatus.textContent = `Analysis area updated to ${shadowState.size} m · calculate sun hours again.`;
    }
    sunDrag = null;
    if (windDrag && windState.moveMode) {
      // The OpenFOAM volume is already loaded; moving the box only changes
      // where flowlines seed, so reseed immediately instead of asking for a
      // full "Simulate" reload.
      if (windState.field && windState.analysisMode === 'direction') resetWindParticles();
      windStatus.textContent = windDrag.mode === 'resize'
        ? `Flow box resized to ${windState.size} m.`
        : 'Flow box moved.';
    }
    windDrag = null;
    if (sliceDrag) {
      windStatus.textContent = 'Slice moved.';
    }
    sliceDrag = null;
  });
  canvas.addEventListener('pointercancel', event => {
    if (event.pointerId === trafficState.pointerId) {
      trafficState.stroking = false;
      trafficState.pointerId = null;
      trafficState.strokePoints = [];
      updateTrafficDrawPopup('Stroke cancelled by the pointer. Draw again or confirm the existing selection.');
      updateTrafficDrawing();
    }
    sunDrag = null;
    drag = null;
    windDrag = null;
    sliceDrag = null;
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    cameraState.distance = clamp(cameraState.distance * Math.exp(event.deltaY * 0.0008), 80, 7000);
    updateCamera();
  }, { passive: false });
  canvas.addEventListener('dblclick', event => {
    if (trafficState.drawing) {
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
  heatMetric?.addEventListener('change', event => {
    loadHeat(event.target.value);
  });
  heatDate?.addEventListener('change', event => {
    shadowState.date = event.target.value || shadowState.date;
    loadHeat(heatMetric?.value);
  });
  heatTime?.addEventListener('change', event => {
    shadowState.minutes = Number(event.target.value);
    loadHeat(heatMetric?.value);
  });
  sunToggle?.addEventListener('change', event => setShadowMode(event.target.checked));
  sunDate?.addEventListener('change', event => {
    shadowState.date = event.target.value || shadowState.date;
    if (shadowState.mode === 'shadows') queueLiveShadowUpdate();
    else {
      cancelSunHours('Date changed · calculate sun hours again.');
    }
  });
  sunTime?.addEventListener('input', event => {
    shadowState.minutes = Number(event.target.value);
    if (shadowState.mode === 'shadows') queueLiveShadowUpdate();
  });
  sunModeButtons.forEach(button => button.addEventListener('click', () => setSunAnalysisMode(button.dataset.sunMode)));
  sunDomainSize?.addEventListener('change', event => {
    shadowState.size = Number(event.target.value) || 500;
    cancelSunHours(`Analysis area resized to ${shadowState.size} m · calculate sun hours.`);
    updateSunBox();
  });
  for (const control of [sunStartTime, sunEndTime, sunStepTime, sunAnalysisSurfaces, sunSurfaceResolution]) {
    control?.addEventListener('change', () => cancelSunHours('Sun-hours settings changed · calculate again.'));
  }
  sunMoveDomain?.addEventListener('click', () => {
    shadowState.moveMode = !shadowState.moveMode;
    sunMoveDomain.classList.toggle('active', shadowState.moveMode);
    sunMoveDomain.setAttribute('aria-pressed', String(shadowState.moveMode));
    sunMoveDomain.textContent = shadowState.moveMode ? 'Done moving' : 'Move / resize analysis area';
    updateSunBox();
  });
  sunGenerate?.addEventListener('click', () => {
    if (shadowState.mode === 'hours') generateSunHours();
    else generateShadows();
  });

  function setWindAnalysisMode(mode) {
    if (!['direction', 'comfort'].includes(mode)) return;
    windState.analysisMode = mode;
    // Both lenses are OpenFOAM-sourced now; the screening proxy is retired
    // from this UI. dataMode stays 'cfd' so the particle/sampling code paths
    // that already special-case CFD keep working unchanged.
    windState.dataMode = 'cfd';
    windLensButtons.filter(button => ['direction', 'comfort'].includes(button.dataset.windLens)).forEach(button => {
      const active = button.dataset.windLens === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    if (windDirectionControls) windDirectionControls.hidden = mode !== 'direction';
    if (windCfdControls) windCfdControls.hidden = mode !== 'direction';
    if (windClimateControls) windClimateControls.hidden = mode !== 'comfort';
    // Flow region (box move/resize + flowline appearance) only applies to
    // Direction's Flow view.
    if (windFlowBoxControls) windFlowBoxControls.hidden = mode !== 'direction' || windState.cfdView !== 'flow';
    updateWindBox();
    windPanel?.classList.add('cfd-active');
    if (windModeBadge) windModeBadge.textContent = mode === 'comfort' ? 'CFD · COMFORT (PARTIAL)' : 'CFD · FULL CBD';
    if (windSourceTitle) windSourceTitle.textContent = mode === 'comfort' ? 'OpenFOAM-weighted comfort' : 'OpenFOAM urban airflow';
    if (windSourceDetail) windSourceDetail.textContent = mode === 'comfort'
      ? 'ERA5 wind rose · resolved OpenFOAM sectors only'
      : 'Pick a solved direction, then load the result';
    if (windFlowlinesVisible) windFlowlinesVisible.disabled = mode === 'comfort';
    if (windVolumeVisible) windVolumeVisible.disabled = mode === 'comfort';
    if (mode === 'comfort' && windState.volumeVisible) {
      windState.volumeVisible = false;
      if (windVolumeVisible) windVolumeVisible.checked = false;
    }
    windSimulate.textContent = mode === 'comfort' ? 'Run OpenFOAM-weighted comfort study' : 'Load OpenFOAM result';
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = mode === 'comfort'
      ? 'Weights each solved OpenFOAM direction by its ERA5 wind-rose frequency. Unsolved directions are excluded, not assumed calm.'
      : 'Pick a solved wind direction, then load the OpenFOAM result.';
    requestRender();
  }

  windLensButtons.forEach(button => button.addEventListener('click', () => {
    const lens = button.dataset.windLens;
    if (lens === 'direction' || lens === 'comfort') setWindAnalysisMode(lens);
  }));

  windDirectionPresets.forEach(button => button.addEventListener('click', () => {
    const directionDeg = Number(button.dataset.windDirection);
    if (!findCfdCase(directionDeg)) return;
    windState.direction = directionDeg;
    windDirectionPresets.forEach(item => item.classList.toggle('active', Number(item.dataset.windDirection) === directionDeg));
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = `${button.textContent} selected · click Load OpenFOAM result.`;
    requestRender();
  }));
  windFlowlinesVisible?.addEventListener('change', event => {
    windState.flowlinesVisible = event.target.checked;
    if (windPoints) windPoints.visible = windState.flowlinesVisible && windState.analysisMode !== 'comfort' && windState.cfdView === 'flow';
    requestRender();
  });
  windVolumeVisible?.addEventListener('change', event => {
    windState.volumeVisible = event.target.checked;
    if (windFlowBoxHeightRow) windFlowBoxHeightRow.hidden = !windState.volumeVisible;
    if (windState.field && windState.analysisMode !== 'comfort') resetWindParticles();
    updateWindBox();
    windStatus.textContent = windState.volumeVisible
      ? `Flowlines seed through ${windState.flowBoxHeight} m of box height.`
      : 'Flowlines seed at pedestrian height only.';
    requestRender();
  });
  windFlowBoxHeight?.addEventListener('input', event => {
    windState.flowBoxHeight = Number(event.target.value) || 80;
    if (windFlowBoxHeightValue) windFlowBoxHeightValue.textContent = String(windState.flowBoxHeight);
    if (windState.field && windState.volumeVisible && windState.analysisMode !== 'comfort') resetWindParticles();
    updateWindBox();
    requestRender();
  });
  windFlowlineCount?.addEventListener('change', event => {
    windState.particleCount = Number(event.target.value) || 800;
    if (windState.field && windState.analysisMode !== 'comfort') resetWindParticles();
    requestRender();
  });
  windAnimationSpeed?.addEventListener('input', event => {
    windState.animationSpeed = Number(event.target.value) / 100;
    if (windAnimationSpeedValue) windAnimationSpeedValue.textContent = `${event.target.value}%`;
  });
  windCfdViewButtons.forEach(button => button.addEventListener('click', () => {
    windState.cfdView = button.dataset.cfdView;
    windCfdViewButtons.forEach(candidate => {
      const active = candidate === button;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-pressed', String(active));
    });
    if (windState.cfdView === 'facade') {
      windState.cfdField = 'p';
      if (windCfdField) windCfdField.value = 'p';
    }
    if (windSliceControls) windSliceControls.hidden = windState.cfdView !== 'slice';
    if (windGroundControls) windGroundControls.hidden = windState.cfdView !== 'ground';
    if (windFlowBoxControls) windFlowBoxControls.hidden = windState.cfdView !== 'flow';
    if (windState.cfd && windState.cfdView === 'flow') resetWindParticles();
    updateWindBox();
    buildCfdView();
    if (windState.cfd) {
      windStatus.textContent = windState.cfdView === 'ground'
        ? `${windState.cfdGroundHeight.toFixed(1)} m terrain-following OpenFOAM field · solved cells only.`
        : windState.cfdView === 'slice'
          ? 'Move the plane and crop its two dimensions with the slice controls.'
          : windState.cfdView === 'facade'
            ? 'OpenFOAM kinematic pressure mapped to façades inside the solved domain.'
            : 'Resolved 3D pathlines through the OpenFOAM velocity volume.';
    }
    requestRender();
  }));
  windCfdField?.addEventListener('change', event => {
    windState.cfdField = event.target.value;
    if (windState.cfdView === 'facade' && windState.cfdField !== 'p') {
      windState.cfdView = 'slice';
      windCfdViewButtons.forEach(button => {
        const active = button.dataset.cfdView === 'slice';
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      if (windSliceControls) windSliceControls.hidden = false;
    }
    buildCfdView();
    requestRender();
  });
  windCfdGroundHeight?.addEventListener('change', event => {
    windState.cfdGroundHeight = Number(event.target.value) || 2;
    buildCfdPedestrianSurface();
    windStatus.textContent = `${windState.cfdGroundHeight.toFixed(1)} m terrain-following OpenFOAM field · solved cells only.`;
    requestRender();
  });
  windSlicePlane?.addEventListener('change', event => {
    windState.slicePlane = event.target.value;
    buildCfdSlice();
    requestRender();
  });
  windSlicePosition?.addEventListener('input', event => {
    windState.slicePosition = Number(event.target.value) / 100;
    if (windSlicePositionValue) windSlicePositionValue.textContent = `${event.target.value}%`;
    buildCfdSlice();
    requestRender();
  });
  windSliceWidth?.addEventListener('input', event => {
    windState.sliceWidth = Number(event.target.value) / 100;
    buildCfdSlice();
    requestRender();
  });
  windSliceHeight?.addEventListener('input', event => {
    windState.sliceHeight = Number(event.target.value) / 100;
    buildCfdSlice();
    requestRender();
  });
  windSliceCenterX?.addEventListener('input', event => {
    windState.sliceCenterX = Number(event.target.value) / 100;
    buildCfdSlice();
    requestRender();
  });
  windSliceCenterY?.addEventListener('input', event => {
    windState.sliceCenterY = Number(event.target.value) / 100;
    buildCfdSlice();
    requestRender();
  });
  windSliceReset?.addEventListener('click', () => {
    windState.slicePosition = 0.5;
    windState.sliceWidth = 1;
    windState.sliceHeight = 1;
    windState.sliceCenterX = 0.5;
    windState.sliceCenterY = 0.5;
    if (windSlicePosition) windSlicePosition.value = '50';
    if (windSliceWidth) windSliceWidth.value = '100';
    if (windSliceHeight) windSliceHeight.value = '100';
    if (windSliceCenterX) windSliceCenterX.value = '50';
    if (windSliceCenterY) windSliceCenterY.value = '50';
    buildCfdSlice();
    requestRender();
  });

  windToggle?.addEventListener('change', event => {
    if (event.target.checked && heatGroup.visible) {
      if (heatToggle) heatToggle.checked = false;
      setHeatMode(false);
    }
    windState.enabled = event.target.checked;
    windGroup.visible = windState.enabled;
    if (windState.enabled) {
      if (windState.field && windState.surfaceVisible) hideStreetLayersForWind();
      if (windState.analysisMode === 'direction' && !windState.cfd) loadCfdWind();
    } else {
      restoreStreetLayersAfterWind();
    }
    windStatus.textContent = windState.enabled
      ? (windState.field ? 'Existing wind heatmap and gusts shown.' : '3D domain ready · position it, then simulate.')
      : 'Wind display hidden.';
    requestRender();
  });
  windSeason?.addEventListener('change', event => {
    windState.season = event.target.value;
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = 'Season changed · click Simulate wind.';
    requestRender();
  });
  windStability?.addEventListener('change', event => {
    windState.stability = event.target.value;
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = 'Stability changed · click Simulate wind.';
  });
  windForcingMode?.addEventListener('change', event => {
    windState.forcingMode = event.target.value;
    windSpeed.disabled = windState.forcingMode === 'era5_climatology';
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = 'Forcing source changed · click Simulate wind.';
  });
  if (windSpeed) windSpeed.disabled = windState.forcingMode === 'era5_climatology';
  windSpeed?.addEventListener('input', event => {
    windState.speed = Number(event.target.value) / 3.6;
    windState.referenceHeight = 2;
    if (windSpeedValue) windSpeedValue.textContent = `${Math.round(windState.speed * 3.6)} km/h`;
  });
  windSize?.addEventListener('input', event => {
    windState.size = Number(event.target.value);
    windSizeValue.textContent = String(windState.size);
    const sizeCopy = document.querySelector('#wind-size-value-copy');
    if (sizeCopy) sizeCopy.textContent = String(windState.size);
    if (windState.field && windState.analysisMode === 'direction') resetWindParticles();
    windStatus.textContent = `Flow box resized to ${windState.size} m.`;
    updateWindBox();
  });
  windMoveDomain?.addEventListener('click', () => {
    windState.moveMode = !windState.moveMode;
    windMoveDomain.classList.toggle('active', windState.moveMode);
    windMoveDomain.setAttribute('aria-pressed', String(windState.moveMode));
    windMoveDomain.title = windState.moveMode ? 'Click when the flow box position is set' : 'Move or resize the flow box';
    updateWindBox();
  });
  windSimulate?.addEventListener('click', simulateWind);
  trafficDuration?.addEventListener('input', () => {
    if (trafficDurationValue) trafficDurationValue.textContent = `${trafficDuration.value} min`;
    invalidateTrafficResult('Duration changed · run the comparison again.');
  });
  trafficScenario?.addEventListener('change', () => invalidateTrafficResult('Time of day changed · run the comparison again.'));
  trafficDemand?.addEventListener('change', () => invalidateTrafficResult('Demand assumption changed · run the comparison again.'));
  trafficControlModel?.addEventListener('change', () => invalidateTrafficResult('Junction behaviour changed · run the comparison again.'));
  trafficOneWayToggle?.addEventListener('change', () => {
    trafficState.oneWay = Boolean(trafficOneWayToggle.checked);
    invalidateTrafficResult('One-way conversion changed · run the comparison again.');
  });
  trafficFlipDirection?.addEventListener('click', flipTrafficDirection);
  trafficRefresh?.addEventListener('click', () => loadTrafficLive(true));
  trafficDrawLane?.addEventListener('click', () => beginTrafficDrawing('lane'));
  trafficDrawRoad?.addEventListener('click', () => beginTrafficDrawing('full'));
  trafficDrawOneWay?.addEventListener('click', () => beginTrafficDrawing('oneway'));
  trafficDrawConfirm?.addEventListener('click', confirmTrafficDrawing);
  trafficDrawCancel?.addEventListener('click', clearTrafficSelection);
  trafficRun?.addEventListener('click', runTrafficClosurePreview);
  trafficClear?.addEventListener('click', clearTrafficSelection);
  trafficReport?.addEventListener('click', buildTrafficReport);
  trafficReportClose?.addEventListener('click', () => trafficReportDialog?.close());
  trafficReportPrint?.addEventListener('click', () => window.print());
  trafficCompare?.addEventListener('change', () => {
    applyTrafficCompareSelection();
    requestRender();
  });
  trafficToggle?.addEventListener('change', () => {
    trafficState.enabled = Boolean(trafficToggle.checked);
    syncTrafficSceneVisibility();
    if (trafficState.enabled) {
      trafficState.lastTime = performance.now();
      requestRender();
    }
  });
  trafficRestrictionsToggle?.addEventListener('change', () => {
    syncTrafficSceneVisibility();
    requestRender();
  });
  addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (groundPickHandler) {
      event.preventDefault();
      const handler = groundPickHandler;
      requestGroundPick(null);
      handler(null, null);
      return;
    }
    if (trafficState.drawing) {
      event.preventDefault();
      clearTrafficSelection();
    }
  });
  addEventListener('climate-menu-change', event => {
    const name = event.detail?.name;
    transportLayer?.setPanelActive(name === 'transport');
    // Tools is a utility panel, not its own exclusive visualization — switch
    // away from whatever layer (heat/sun/wind/traffic) is active only when
    // moving to a tab that has one, so opening Tools to reach a shared
    // control doesn't silently turn off the layer you were looking at.
    if (name !== 'tools') {
      if (name !== 'sun' && shadowState.enabled) setShadowMode(false);
      if (name !== 'heat' && heatToggle?.checked) {
        heatToggle.checked = false;
        setHeatMode(false);
      }
      if (name !== 'wind' && windToggle?.checked) {
        windToggle.checked = false;
        windToggle.dispatchEvent(new Event('change'));
      }
      if (name !== 'traffic' && trafficToggle?.checked) {
        trafficToggle.checked = false;
        trafficToggle.dispatchEvent(new Event('change'));
      }
      if (name === 'heat' && heatToggle && !heatToggle.checked) {
        heatToggle.checked = true;
        setHeatMode(true);
      } else if (name === 'sun' && !shadowState.enabled) {
        setShadowMode(true);
      } else if (name === 'wind' && windToggle && !windToggle.checked) {
        windToggle.checked = true;
        windToggle.dispatchEvent(new Event('change'));
      } else if (name === 'traffic' && trafficToggle && !trafficToggle.checked) {
        trafficToggle.checked = true;
        trafficToggle.dispatchEvent(new Event('change'));
      }
    }
    trafficState.sceneActive = name === 'traffic';
    if (!trafficState.sceneActive && trafficState.drawing) {
      clearTrafficSelection();
    }
    syncTrafficSceneVisibility();
    requestRender();
  });
  addEventListener('climate-streetview-mode', event => {
    streetViewState.placing = Boolean(event.detail?.enabled);
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
    windState.forcingMode = 'manual';
    if (windForcingMode) windForcingMode.value = 'manual';
    if (windSpeed) windSpeed.disabled = false;
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
    windStatus.textContent = `Current 10 m forcing set · ${windState.speed.toFixed(1)} m/s from ${Math.round(windState.direction)}° · click Simulate wind.`;
    requestRender();
  });

  function render(now = performance.now()) {
    animationFrame = 0;
    resize();
    updateWindParticles(now);
    updateTrafficCars(now);
    const transportAnimating = transportLayer?.update(now) || false;
    if (trafficStatusGroup.visible && scenarioStatusGroup.children.length) {
      const pulse = 0.82 + Math.sin(now * 0.004) * 0.18;
      for (const child of scenarioStatusGroup.children) {
        if (child.userData.flowPulse && child.material) {
          child.material.opacity = child.userData.baseOpacity * pulse;
        }
        if (child.userData.closurePulse && child.material) {
          const labelPulse = 1 + Math.sin(now * 0.005) * 0.035;
          child.scale.set(
            child.userData.baseWidth * labelPulse,
            child.userData.baseHeight * labelPulse,
            1,
          );
          child.material.opacity = 0.9 + Math.sin(now * 0.005) * 0.1;
        }
      }
    }
    renderer.render(scene, camera);
    renderRequested = false;
    if ((windState.enabled && windState.field)
      || (trafficGroup.visible && trafficState.tracks.length)
      || (trafficStatusGroup.visible && scenarioStatusGroup.children.length)
      || transportAnimating) {
      animationFrame = requestAnimationFrame(render);
    }
  }

  addEventListener('resize', requestRender);
  fitScene();
  setWindAnalysisMode(windState.analysisMode);
  updateWindBox();
  windGroup.visible = windState.enabled;
  syncTrafficSceneVisibility();
  const roofTriangles = roofSurfaceBuffer ? manifest.layers?.roof_surface?.triangles : 0;
  status.textContent = `${data.buildings.length} buildings · ${(data.water || []).length} water bodies · ${railwayCount} railway lines · ${roofTriangles ? `${roofTriangles.toLocaleString()} detailed roof triangles · ` : ''}${canopyCount} canopy footprints`;
  updateSunStatus();
  loadHeat();
  setHeatMode(Boolean(heatToggle?.checked));
  loadTrafficRoads();
  loadTrafficLive(false);
  try {
    transportLayer = await createTransportLayer({
      THREE, scene, terrainHeightAt, terrainValidAt, requestRender, frameBounds,
      requestGroundPick, addScenePickHandler,
    });
    transportLayer.setPanelActive(document.querySelector('[data-menu-target].active')?.dataset.menuTarget === 'transport');
  } catch (error) {
    console.warn('Public transport layer unavailable:', error);
    const transportStatus = document.querySelector('#transport-status');
    if (transportStatus) transportStatus.textContent = `Transport layer unavailable (${error.message})`;
  }
  requestRender();

  window.__trafficDebug = {
    trafficState, frameBounds, canvas, terrainHeightAt,
    projectToScreen: (x, z) => {
      const canvasRect = canvas.getBoundingClientRect();
      const y = terrainHeightAt(x, z) + 1.0;
      const vector = new THREE.Vector3(x, y, z);
      vector.project(camera);
      return {
        x: canvasRect.left + (vector.x * 0.5 + 0.5) * canvasRect.width,
        y: canvasRect.top + (-vector.y * 0.5 + 0.5) * canvasRect.height,
      };
    },
  };
  return { renderer, scene, camera };
}
