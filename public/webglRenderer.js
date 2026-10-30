import { percentileColorPosition, utciAbsolutePalette, utciPalette, temperatureColor, UTCI_COLOR_MIN, UTCI_COLOR_MAX } from './thermalColors.js';
import * as THREE from './vendor/three.module.min.js';
import { createWindSurfaceMaterial } from './windSurfaceMotion.js?v=6';
import { scopedFetch as fetch, assertManifest, cancelRequests, createAnalysisId } from './requestClient.js';
import { attachSceneExperience } from './sceneExperience.js';
import { CAMERA_MAX_DISTANCE, CAMERA_MIN_DISTANCE, CAMERA_MIN_ELEVATION, orbitFromDrag, panFromDrag } from './cameraControls.js';
import { createTransportLayer } from './transportLayer.js?v=33';
import { attachPlaceInspector } from './placeInspector.js?v=3';
import { createDesignMassing } from './designMassing.js?v=14';
import { rayFootprintIntervals, addVerticalOccluder, blockedByVerticalOccluder, terrainRayDistances, viewshedRingDistances } from './viewshedMath.js';
import { recordSourceResidence, summarizeSourceResidence } from './plumeAttribution.js';
import { accumulateResidenceBins, advancePollutantStep, clipPolylineToValidSamples, clipReflectedSegmentWithinRange, clipSegmentToValidIntervals, combinedTrafficMassG, intersectIntervals, lagrangianTimeScale, normalizedMaskedInterpolationGradient, pollutantTimeStep, reflectNormalVelocityAtBoundary, reflectVelocityAtBoundary, segmentBuildingIntervals, segmentCellFractions, segmentPolygonSetIntervals, stratifiedFractions, stratifiedSampleTime, subtractIntervals } from './pollutantTransport.js';

const COLORS = {
  background: 0x101719,
  fog: 0x101719,
  terrain: 0xc0b49b,
  terrainSun: 0xf9f9f9,
  wall: 0xb4b4b4,
  wallSun: 0xffffff,
  roof: 0xcacaca,
  roofSun: 0xffffff,
  road: 0x59605d,
  roadMajor: 0x646b67,
  roadSecondary: 0x5f6662,
  // Permanent pedestrian streets should read as context, while the brighter
  // red/orange simulation ribbons remain the attention-grabbing states.
  pedestrian: 0xa87967,
  path: 0xb5a994,
  rail: 0x929b9c,
  plinthTop: 0xc5c7c4,
  plinthSide: 0x747977,
  plinthAccent: 0x666d6b,
};

// Shared scene-layer contract. Physical lift keeps draped surfaces off terrain;
// draw order resolves only near-coplanar overlays. Neither should be used to
// make a feature jump over a real 3D obstruction: depth testing stays enabled.
const SCENE_LAYERS = Object.freeze({
  terrain: { order: 0, lift: 0 },
  terrainShadow: { order: 4, lift: 0 },
  water: { order: 1, lift: 0.08 },
  grass: { order: 2, lift: 0.14 },
  path: { order: 3, lift: 0.16 },
  road: { order: 4, lift: 0.26 },
  roadPriorityStep: 0.12,
  groundTexture: { order: 5, lift: 0.42 },
  streetMarking: { order: 8, lift: 0.48 },
  mappedCoverage: { order: 7, lift: 0.62 },
  runoff: { order: 9, lift: 0.82 },
  cycling: { order: 10, lift: 1.15 },
  analysisSurface: { order: 20, lift: 0.68 },
  analysisVolume: { order: 18, lift: 0 },
  annotation: { order: 1000, lift: 0 },
});

function setSceneLayer(object, layerName, localOrder = 0) {
  const layer = SCENE_LAYERS[layerName];
  if (!layer) throw new Error(`Unknown scene layer: ${layerName}`);
  object.userData.sceneLayer = layerName;
  object.renderOrder = layer.order + localOrder;
  return object;
}

// Keep at-grade road classes slightly separated at junctions while preserving
// one shared surface lift for each renderer layer.
const ROAD_CLASS_OFFSETS = [
  SCENE_LAYERS.road.lift,
  SCENE_LAYERS.road.lift + 0.08,
  SCENE_LAYERS.road.lift + 0.04,
  SCENE_LAYERS.path.lift,
  SCENE_LAYERS.path.lift + 0.02,
];

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export async function startWebGLScene(canvas, status) {
  if (!window.WebGL2RenderingContext) throw new Error('WebGL 2 is unavailable');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: true,
  });
  // A small amount of supersampling keeps roof silhouettes crisp on dense
  // displays without doubling the post-processing cost on high-DPI screens.
  // Keep edges crisp on high-DPI displays without paying for nearly three
  // times as many fragments as a 1x render. The post pass and dense city
  // geometry make that extra fill rate noticeable on integrated GPUs.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(COLORS.background, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const manifest = assertManifest(await fetch('/assets/manifest.json', { cache: 'no-store' }).then(response => response.json()));
  let roofSurfaceBuffer = null;
  let roofSurfacePromise = null;
  const loadRoofSurface = () => {
    if (!roofSurfacePromise) {
      roofSurfacePromise = manifest.assets?.roof_surface
        ? fetch(`/assets/${manifest.assets.roof_surface}?v=${manifest.layers?.roof_surface?.cache_key || manifest.layers?.roof_surface?.bytes || 0}`)
          .then(response => response.ok ? response.arrayBuffer() : null)
          .catch(error => { console.warn(`Detailed roof surface unavailable: ${error.message}`); return null; })
        : Promise.resolve(null);
    }
    return roofSurfacePromise;
  };
  const loadRendererScene = async () => {
    // The compact scene is intentionally the normal interactive asset. The
    // full semantic model and dense roof mesh remain available for analysis,
    // but parsing them here adds substantial startup and rendering overhead.
    const expectedWater = manifest.layers?.fallback?.water || 0;
    const fallbackResponse = await fetch(`/assets/${manifest.assets?.fallback || 'fallback.json'}?v=${manifest.layers?.fallback?.cache_key || manifest.layers?.fallback?.bytes || 0}`);
    if (!fallbackResponse.ok) throw new Error(`compact scene HTTP ${fallbackResponse.status}`);
    const fallback = await fallbackResponse.json();
    if (expectedWater && (fallback.water || []).length !== expectedWater) {
      throw new Error(`compact scene contains ${(fallback.water || []).length}/${expectedWater} water bodies`);
    }
    // The separate municipal lighting inventory contains thousands of
    // fixtures. Keep it out of the interactive scene to avoid its startup,
    // memory, and rendering cost.
    fallback.cityFurniture = [];
    return fallback;
  };
  const [data, canopyAsset] = await Promise.all([
    loadRendererScene(),
    fetch(`/assets/canopy.json?v=${manifest.layers?.canopy?.cache_key || manifest.layers?.canopy?.bytes || 0}`).then(response => response.ok ? response.json() : { canopies: [] }).catch(() => ({ canopies: [] })),
  ]);

  const scene = new THREE.Scene();
  const reportAreaOutline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    color: 0x83e6bd, transparent: true, opacity: 0.98, depthTest: false, depthWrite: false,
  }));
  reportAreaOutline.name = 'report-area-square';
  reportAreaOutline.renderOrder = 2000;
  reportAreaOutline.visible = false;
  scene.add(reportAreaOutline);
  const reportAreaHandleGeometry = new THREE.SphereGeometry(1, 16, 12);
  const reportAreaHandleMaterial = new THREE.MeshStandardMaterial({
    color: 0xa6aaa8, emissive: 0x171a19, roughness: 0.88, metalness: 0,
    depthTest: false, depthWrite: false,
  });
  const reportAreaHandles = new THREE.Group();
  reportAreaHandles.name = 'report-area-corner-handles';
  reportAreaHandles.visible = false;
  const reportAreaHandle = new THREE.Mesh(reportAreaHandleGeometry, reportAreaHandleMaterial);
  reportAreaHandle.name = 'report-area-resize-handle';
  reportAreaHandle.renderOrder = 2001;
  reportAreaHandles.add(reportAreaHandle);
  scene.add(reportAreaHandles);
  const placeInspectorHighlight = new THREE.Group();
  placeInspectorHighlight.name = 'place-inspector-highlight';
  scene.add(placeInspectorHighlight);
  scene.background = new THREE.Color(COLORS.background);
  // Procedural atmospheric sky rendered on an inward-facing sphere. It follows
  // the camera position while retaining world orientation, so celestial bodies
  // stay at their calculated compass bearings as the camera moves.
  const skyUniforms = {
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    moonDirection: { value: new THREE.Vector3(0, 1, 0) },
    moonSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    groundColor: { value: new THREE.Color('#b7c4c0') },
    cloudCover: { value: 0 },
    isDay: { value: 1 },
    isRainy: { value: 0 },
    sunStrength: { value: 0 },
    moonStrength: { value: 0 },
    twilight: { value: 0 },
    cloudTime: { value: 0 },
  };
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: `
      varying vec3 vSkyDirection;
      void main() {
        vSkyDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 sunDirection;
      uniform vec3 moonDirection;
      uniform vec3 moonSunDirection;
      uniform vec3 groundColor;
      uniform float cloudCover;
      uniform float isDay;
      uniform float isRainy;
      uniform float sunStrength;
      uniform float moonStrength;
      uniform float twilight;
      uniform float cloudTime;
      varying vec3 vSkyDirection;
      float hash31(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float noise3(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
                       mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
                       mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float cloudNoise(vec3 p) {
        float value = 0.0;
        float amplitude = 0.55;
        for (int i = 0; i < 4; i++) {
          value += noise3(p) * amplitude;
          p *= 2.03;
          amplitude *= 0.5;
        }
        return value;
      }
      void main() {
        vec3 direction = normalize(vSkyDirection);
        float horizon = 1.0 - smoothstep(0.0, 0.5, direction.y);
        float sunDot = dot(direction, normalize(sunDirection));
        float sunFacing = smoothstep(-0.45, 0.9, dot(normalize(direction.xz + vec2(0.0001)), normalize(sunDirection.xz + vec2(0.0001))));
        vec3 dayZenith = mix(vec3(0.11, 0.30, 0.57), vec3(0.31, 0.39, 0.47), isRainy);
        vec3 dayHorizon = mix(vec3(0.68, 0.80, 0.87), vec3(0.53, 0.59, 0.63), isRainy);
        float warmHorizon = twilight * (1.0 - isRainy) * sunFacing;
        dayHorizon = mix(dayHorizon, vec3(1.0, 0.48, 0.24), warmHorizon * 0.84);
        dayZenith = mix(dayZenith, vec3(0.35, 0.29, 0.43), twilight * (1.0 - isRainy) * 0.2);
        vec3 dayColor = mix(dayZenith, dayHorizon, pow(horizon, 0.85));
        dayColor += vec3(0.25, 0.20, 0.13) * pow(max(sunDot, 0.0), 12.0) * isDay * (1.0 - isRainy);
        vec3 nightZenith = vec3(0.005, 0.012, 0.032);
        vec3 nightHorizon = vec3(0.018, 0.035, 0.065);
        vec3 skyColor = mix(mix(nightZenith, nightHorizon, pow(horizon, 0.8)), dayColor, isDay);
        vec3 twilightSky = mix(vec3(0.23, 0.25, 0.43), vec3(0.93, 0.43, 0.24), pow(horizon, 1.3) * sunFacing);
        skyColor = mix(skyColor, twilightSky, twilight * (1.0 - isRainy) * 0.68);
        // The lower hemisphere is a distant ground backdrop. Blend it through
        // the horizon on the same dome so there is no finite plane edge.
        float groundBlend = 1.0 - smoothstep(-0.18, 0.06, direction.y);
        skyColor = mix(skyColor, groundColor, groundBlend);
        float starSeed = hash31(floor(direction * 700.0));
        float stars = smoothstep(0.9995, 0.99995, starSeed) * (1.0 - isDay)
          * smoothstep(0.02, 0.42, direction.y);
        skyColor += vec3(0.55, 0.68, 0.88) * stars * 0.3;
        // Sample clouds on a sphere so they stay continuous at the horizon
        // and overhead instead of stretching into radial streaks near the pole.
        // A small translation through the field gives them a slow wind drift.
        vec3 cloudPoint = direction * vec3(13.0, 6.5, 13.0)
          + vec3(cloudTime * 0.01, 0.0, cloudTime * 0.006);
        float cloudField = cloudNoise(cloudPoint);
        float coverage = max(cloudCover, isRainy * 0.82);
        float cloudThreshold = 0.64 - coverage * 0.24;
        float clouds = smoothstep(cloudThreshold - 0.08, cloudThreshold + 0.08, cloudField)
          * smoothstep(-0.02, 0.06, direction.y);
        float cloudShade = smoothstep(0.34, 0.72, cloudField);
        vec3 cloudColor = mix(vec3(0.60, 0.68, 0.72), vec3(0.90, 0.92, 0.91), cloudShade);
        cloudColor = mix(cloudColor, vec3(0.32, 0.38, 0.43), isRainy * 0.8);
        cloudColor = mix(cloudColor * 0.08, cloudColor, isDay);
        cloudColor += vec3(0.25, 0.19, 0.11) * pow(max(sunDot, 0.0), 12.0) * isDay * (1.0 - isRainy);
        skyColor = mix(skyColor, cloudColor, clouds * 0.94);
        float sunTransmission = 1.0 - clouds * 0.96;
        float disc = smoothstep(0.999985, 0.999995, sunDot) * sunStrength * sunTransmission;
        float sunGlare = (pow(max(sunDot, 0.0), 110.0) * 1.8
          + pow(max(sunDot, 0.0), 28.0) * 0.42
          + pow(max(sunDot, 0.0), 8.0) * 0.055)
          * sunStrength * sunTransmission;
        vec3 sunlightColor = mix(vec3(1.0, 0.67, 0.35), vec3(1.0, 0.94, 0.78), smoothstep(0.02, 0.35, sunDirection.y));
        skyColor += sunlightColor * sunGlare;
        skyColor = mix(skyColor, sunlightColor * 4.0, disc);
        vec3 moonRight = normalize(cross(moonDirection, vec3(0.0, 1.0, 0.0)) + vec3(0.0001, 0.0, 0.0001));
        vec3 moonUp = normalize(cross(moonRight, moonDirection));
        vec2 moonPoint = vec2(dot(direction, moonRight), dot(direction, moonUp)) / 0.0046;
        float moonRadius = dot(moonPoint, moonPoint);
        float moonFront = sqrt(max(0.0, 1.0 - moonRadius));
        vec3 projectedSun = moonSunDirection - moonDirection * dot(moonSunDirection, moonDirection);
        vec2 moonLightRaw = vec2(dot(projectedSun, moonRight), dot(projectedSun, moonUp));
        vec2 moonLight = length(moonLightRaw) > 0.0001 ? normalize(moonLightRaw) : vec2(1.0, 0.0);
        float moonLightAngle = dot(vec2(moonPoint.x, moonFront), moonLight);
        float moonLit = smoothstep(-0.045, 0.045, moonLightAngle);
        float moonDisc = (1.0 - smoothstep(0.94, 1.02, moonRadius)) * moonStrength * (1.0 - clouds * 0.94);
        float maria = noise3(vec3(moonPoint * 5.5, moonFront * 3.0));
        float craterGrain = noise3(vec3(moonPoint * 17.0, moonFront * 11.0));
        float lunarSurface = smoothstep(0.30, 0.72, maria) * 0.22 + craterGrain * 0.09;
        float limbShade = mix(0.62, 1.0, moonFront);
        vec3 moonStone = mix(vec3(0.48, 0.51, 0.56), vec3(0.77, 0.79, 0.81), clamp(0.56 + lunarSurface, 0.0, 1.0));
        vec3 moonLitColor = moonStone * limbShade * (0.72 + 0.48 * moonLit);
        float earthshine = (1.0 - moonLit) * 0.075;
        skyColor = mix(skyColor, vec3(0.055, 0.067, 0.09), moonDisc * 0.72);
        skyColor += moonLitColor * moonDisc * moonLit * 1.35;
        skyColor += vec3(0.19, 0.23, 0.29) * moonDisc * earthshine;
        gl_FragColor = vec4(skyColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const skySphere = new THREE.Mesh(new THREE.SphereGeometry(10000, 48, 32), skyMaterial);
  skySphere.renderOrder = -10000;
  skySphere.visible = false;
  scene.add(skySphere);
  let skyWeather = null;
  function updateWeatherSky(weather = skyWeather, sun = null) {
    skyWeather = weather;
    const skyActive = Boolean(shadowState.enabled && !viewshedState.active);
    skySphere.visible = skyActive;
    scene.background.set(shadowState.enabled || viewshedState.active ? '#f7f7f7' : COLORS.background);
    const day = sun ? sun.altitude > 0 : weather?.is_day !== false;
    const clouds = weather?.cloud_cover_pct == null ? 0.28 : clamp(Number(weather.cloud_cover_pct) || 0, 0, 100) / 100;
    const rainy = Number(weather?.precipitation_mm) > 0.1 || Number(weather?.weather_code) >= 51;
    skyUniforms.cloudCover.value = clouds;
    const daylight = sun ? clamp((sun.altitude + 0.15) / 0.24, 0, 1) : (day ? 1 : 0);
    skyUniforms.isDay.value = daylight;
    skyUniforms.isRainy.value = rainy ? 1 : 0;
    const twilight = sun ? Math.exp(-Math.pow(sun.altitude / 0.18, 2)) : 0;
    skyUniforms.twilight.value = twilight;
    const horizonColor = new THREE.Color('#27364e').lerp(new THREE.Color(rainy ? '#b6c1c8' : '#d7e7f0'), daylight);
    if (!rainy) horizonColor.lerp(new THREE.Color('#e4ab92'), twilight * 0.45);
    if (scene.fog) scene.fog.color.copy(skyActive ? horizonColor : new THREE.Color(shadowState.enabled || viewshedState.active ? '#f7f7f7' : COLORS.fog));
    const groundColor = new THREE.Color('#414b50').lerp(new THREE.Color(rainy ? '#a1adab' : '#b7c4c0'), daylight);
    if (!rainy) groundColor.lerp(new THREE.Color('#bdada0'), twilight * 0.35);
    skyUniforms.groundColor.value.copy(groundColor);
    const phaseDate = new Date(`${shadowState.date}T12:00:00+02:00`);
    const newMoonReference = Date.UTC(2000, 0, 6, 18, 14);
    const lunarDays = (phaseDate.getTime() - newMoonReference) / 86400000;
    const phase = ((lunarDays / 29.530588853) % 1 + 1) % 1;
    const sunVisible = Boolean(sun && sun.altitude > -0.018);
    const moon = sun ? moonPosition(shadowState.date, shadowState.minutes) : null;
    const moonVisible = Boolean(moon && moon.altitude > -0.018
      && 0.5 - 0.5 * Math.cos(phase * Math.PI * 2) > 0.015);
    skyUniforms.sunStrength.value = sunVisible ? 1 : 0;
    skyUniforms.moonStrength.value = moonVisible ? 1 - clouds * 0.68 : 0;
    if (sun) {
      skyUniforms.sunDirection.value.copy(sun.vector);
      skyUniforms.moonSunDirection.value.copy(sun.vector);
      if (moon) skyUniforms.moonDirection.value.copy(moon.vector);
    }
  }

  // Low precision lunar ephemeris (Schlyter orbital elements), sufficient for
  // rendering the Moon's real local azimuth/altitude on the sky dome.
  function moonPosition(dateText, minutes) {
    const [year, month, day] = dateText.split('-').map(Number);
    const utc = Date.UTC(year || 2026, (month || 7) - 1, day || 27, 0, minutes - 120);
    const jd = utc / 86400000 + 2440587.5;
    const d = jd - 2451543.5;
    const rad = Math.PI / 180;
    const n = (125.1228 - 0.0529538083 * d) * rad;
    const inclination = 5.1454 * rad;
    const periapsis = (318.0634 + 0.1643573223 * d) * rad;
    const eccentricity = 0.0549;
    const meanAnomaly = ((115.3654 + 13.0649929509 * d) % 360) * rad;
    const eccentricAnomaly = meanAnomaly + eccentricity * Math.sin(meanAnomaly) * (1 + eccentricity * Math.cos(meanAnomaly));
    const xv = Math.cos(eccentricAnomaly) - eccentricity;
    const yv = Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
    const trueAnomaly = Math.atan2(yv, xv);
    const radius = Math.hypot(xv, yv);
    const longitude = trueAnomaly + periapsis;
    const x = radius * (Math.cos(n) * Math.cos(longitude) - Math.sin(n) * Math.sin(longitude) * Math.cos(inclination));
    const y = radius * (Math.sin(n) * Math.cos(longitude) + Math.cos(n) * Math.sin(longitude) * Math.cos(inclination));
    const z = radius * Math.sin(longitude) * Math.sin(inclination);
    const eclipticLongitude = Math.atan2(y, x);
    const eclipticLatitude = Math.atan2(z, Math.hypot(x, y));
    const obliquity = 23.4393 * rad;
    const ra = Math.atan2(Math.sin(eclipticLongitude) * Math.cos(obliquity) - Math.tan(eclipticLatitude) * Math.sin(obliquity), Math.cos(eclipticLongitude));
    const declination = Math.asin(Math.sin(eclipticLatitude) * Math.cos(obliquity) + Math.cos(eclipticLatitude) * Math.sin(obliquity) * Math.sin(eclipticLongitude));
    const t = (jd - 2451545) / 36525;
    const gmst = ((280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - t * t * t / 38710000) % 360) * rad;
    const hourAngle = gmst + 18.4241 * rad - ra;
    const latitude = -33.9249 * rad;
    const altitude = Math.asin(clamp(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle), -1, 1));
    const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) + Math.PI) % (2 * Math.PI);
    return { altitude, vector: new THREE.Vector3(Math.sin(azimuth) * Math.cos(altitude), Math.sin(altitude), -Math.cos(azimuth) * Math.cos(altitude)) };
  }
  // Soft distance fog gives the model atmospheric depth at city-wide zoom
  // without hiding anything at typical street/building inspection distances.
  scene.fog = new THREE.Fog(COLORS.fog, 1900, 4600);
  const camera = new THREE.PerspectiveCamera(46, 1, 1, 12000);
  const postTarget = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  postTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  postTarget.depthTexture.format = THREE.DepthFormat;
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new THREE.Scene();
  const postMaterial = new THREE.ShaderMaterial({
    uniforms: {
      sceneColor: { value: postTarget.texture },
      sceneDepth: { value: postTarget.depthTexture },
      inverseProjection: { value: camera.projectionMatrixInverse },
      resolution: { value: new THREE.Vector2(1, 1) },
      focalPixels: { value: 1 },
      cameraNear: { value: camera.near },
      cameraFar: { value: camera.far },
      aoRadius: { value: 1.55 },
      aoStrength: { value: 0.22 },
      bloomStrength: { value: 0.075 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D sceneColor;
      uniform sampler2D sceneDepth;
      uniform mat4 inverseProjection;
      uniform vec2 resolution;
      uniform float focalPixels;
      uniform float cameraNear;
      uniform float cameraFar;
      uniform float aoRadius;
      uniform float aoStrength;
      uniform float bloomStrength;
      varying vec2 vUv;

      vec3 positionFromDepth(vec2 uv, float depth) {
        vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 viewPosition = inverseProjection * clip;
        return viewPosition.xyz / max(viewPosition.w, 0.00001);
      }

      void main() {
        vec4 color = texture2D(sceneColor, vUv);
        float centerDepth = texture2D(sceneDepth, vUv).x;
        if (centerDepth >= 0.99999) {
          gl_FragColor = color;
          #include <colorspace_fragment>
          return;
        }

        vec3 center = positionFromDepth(vUv, centerDepth);
        vec2 texel = 1.0 / resolution;
        float leftDepth = texture2D(sceneDepth, vUv - vec2(texel.x, 0.0)).x;
        float rightDepth = texture2D(sceneDepth, vUv + vec2(texel.x, 0.0)).x;
        float downDepth = texture2D(sceneDepth, vUv - vec2(0.0, texel.y)).x;
        float upDepth = texture2D(sceneDepth, vUv + vec2(0.0, texel.y)).x;
        vec3 leftPosition = leftDepth < 0.99999 ? positionFromDepth(vUv - vec2(texel.x, 0.0), leftDepth) : center - vec3(0.001, 0.0, 0.0);
        vec3 rightPosition = rightDepth < 0.99999 ? positionFromDepth(vUv + vec2(texel.x, 0.0), rightDepth) : center + vec3(0.001, 0.0, 0.0);
        vec3 downPosition = downDepth < 0.99999 ? positionFromDepth(vUv - vec2(0.0, texel.y), downDepth) : center - vec3(0.0, 0.001, 0.0);
        vec3 upPosition = upDepth < 0.99999 ? positionFromDepth(vUv + vec2(0.0, texel.y), upDepth) : center + vec3(0.0, 0.001, 0.0);
        vec3 normal = normalize(cross(rightPosition - leftPosition, upPosition - downPosition));
        if (dot(normal, -center) < 0.0) normal = -normal;

        float viewDepth = -center.z;
        float pixelRadius = clamp(aoRadius * focalPixels / max(viewDepth, 0.01), 1.0, 14.0);
        float occlusion = 0.0;
        for (int sampleIndex = 0; sampleIndex < 8; sampleIndex++) {
          float angle = float(sampleIndex) * 0.78539816339;
          vec2 direction = vec2(cos(angle), sin(angle));
          vec2 sampleUv = clamp(vUv + direction * pixelRadius * texel, texel, 1.0 - texel);
          float sampleDepth = texture2D(sceneDepth, sampleUv).x;
          if (sampleDepth < 0.99999) {
            vec3 samplePosition = positionFromDepth(sampleUv, sampleDepth);
            vec3 delta = samplePosition - center;
            float distanceToSample = length(delta);
            float hemisphere = max(dot(normal, normalize(delta)) - 0.08, 0.0);
            float falloff = 1.0 - smoothstep(0.0, aoRadius, distanceToSample);
            occlusion += hemisphere * falloff;
          }
        }
        float shade = 1.0 - min(0.30, occlusion * aoStrength * 1.25 / 8.0);
        vec3 graded = color.rgb * shade;
        float luminance = dot(graded, vec3(0.2126, 0.7152, 0.0722));
        graded = mix(vec3(luminance), graded, 1.055);
        graded = (graded - 0.5) * 1.035 + 0.5;
        float shadowGrade = 1.0 - smoothstep(0.08, 0.48, luminance);
        float highlightGrade = smoothstep(0.58, 0.96, luminance);
        graded += vec3(-0.004, 0.001, 0.010) * shadowGrade;
        graded += vec3(0.012, 0.006, -0.004) * highlightGrade;

        // A faint cool rim makes building silhouettes read against the dark
        // backdrop without adding outlines to climate data layers.
        float rim = pow(1.0 - clamp(dot(normal, normalize(-center)), 0.0, 1.0), 5.0);
        graded += vec3(0.007, 0.016, 0.020) * rim;

        // Small, thresholded glow lifts only the brightest rendered details.
        // Its low strength keeps heat and wind palettes visually stable.
        vec2 bloomStep = texel * 4.0;
        vec3 bloom = vec3(0.0);
        vec3 bloomA = texture2D(sceneColor, clamp(vUv + vec2(-1.0, -1.0) * bloomStep, texel, 1.0 - texel)).rgb;
        vec3 bloomB = texture2D(sceneColor, clamp(vUv + vec2(1.0, -1.0) * bloomStep, texel, 1.0 - texel)).rgb;
        vec3 bloomC = texture2D(sceneColor, clamp(vUv + vec2(-1.0, 1.0) * bloomStep, texel, 1.0 - texel)).rgb;
        vec3 bloomD = texture2D(sceneColor, clamp(vUv + vec2(1.0, 1.0) * bloomStep, texel, 1.0 - texel)).rgb;
        bloom += bloomA * smoothstep(0.90, 1.08, dot(bloomA, vec3(0.2126, 0.7152, 0.0722)));
        bloom += bloomB * smoothstep(0.90, 1.08, dot(bloomB, vec3(0.2126, 0.7152, 0.0722)));
        bloom += bloomC * smoothstep(0.90, 1.08, dot(bloomC, vec3(0.2126, 0.7152, 0.0722)));
        bloom += bloomD * smoothstep(0.90, 1.08, dot(bloomD, vec3(0.2126, 0.7152, 0.0722)));
        graded += bloom * (bloomStrength * 0.25);
        gl_FragColor = vec4(graded, color.a);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
  postScene.add(postQuad);
  const postSize = new THREE.Vector2(1, 1);
  const cameraState = {
    azimuth: -0.75,
    // Start at a higher diorama angle so mapped streets, landmark roofs, and
    // timetable vehicles remain visible between tall blocks.
    elevation: 0.60,
    distance: 1600,
    target: new THREE.Vector3(0, 20, 0),
  };
  const streetNameOverlay = document.querySelector('#street-name-overlay');
  const streetNameToggle = document.querySelector('#map-street-names');
  let streetNameLabelSignature = '';
  let animationFrame = 0;
  let animationTimer = 0;
  let renderRequested = true;
  let sceneReadyToRender = false;
  let cameraIntro = null;
  let transportLayer = null;
  let transportLoading = null;
  // Scene picking shared by overlay layers: a click that did not turn into a
  // camera drag is offered to each registered handler until one consumes it.
  let groundPickHandler = null;
  let clickCandidate = null;
  const scenePickHandlers = new Set();
  let placeInspectorPickMode = false;
  let reportAreaPickMode = false;
  let reportAreaDrag = null;
  let reportAreaBounds = null;
  let reportAreaHandleCornerIndex = 2;
  let reportAreaLocked = false;
  const viewshedState = {
    active: false, pickMode: false, point: null, radius: 500, eyeHeight: 1.7,
    shape: 'cone', heading: 0, spread: 60, verticalFov: 20, group: new THREE.Group(),
  };
  viewshedState.group.name = 'viewshed-analysis';
  viewshedState.group.visible = false;
  scene.add(viewshedState.group);
  const viewshedStatus = document.querySelector('#viewshed-status');
  const viewshedPickButton = document.querySelector('#viewshed-pick');
  const viewshedShape = document.querySelector('#viewshed-shape');
  const viewshedHeading = document.querySelector('#viewshed-heading');
  const viewshedHeadingValue = document.querySelector('#viewshed-heading-value');
  const viewshedSpread = document.querySelector('#viewshed-spread');
  const viewshedSpreadValue = document.querySelector('#viewshed-spread-value');
  const viewshedHeight = document.querySelector('#viewshed-height');
  const viewshedHeightValue = document.querySelector('#viewshed-height-value');
  const viewshedRadius = document.querySelector('#viewshed-radius');
  const viewshedRadiusValue = document.querySelector('#viewshed-radius-value');
  const viewshedPersonButton = document.querySelector('#viewshed-person');
  let viewshedPersonCamera = null;
  let viewshedBuildingIndex = null;
  let designViewshedRefreshTimer = 0;
  const layerGroups = {
    terrain: new THREE.Group(),
    groundcover: new THREE.Group(),
    cycling: new THREE.Group(),
    runoff: new THREE.Group(),
    water: new THREE.Group(),
    grass: new THREE.Group(),
    railways: new THREE.Group(),
    paths: new THREE.Group(),
    roads: new THREE.Group(),
    cityFurniture: new THREE.Group(),
    publicRealm: new THREE.Group(),
    buildings: new THREE.Group(),
    trees: new THREE.Group(),
  };
  let ambientTrafficRoads = [];
  let ambientParkingAisles = [];
  const ambientParkingLots = [];
  const groundSurfaceMeshes = [];
  const pavementOverrideMeshes = [];
  const sunModeNeutralMeshes = [];
  layerGroups.groundcover.visible = false;
  layerGroups.cycling.visible = false;
  layerGroups.runoff.visible = false;
  layerGroups.cityFurniture.visible = true;
  layerGroups.publicRealm.visible = true;
  Object.values(layerGroups).forEach(group => scene.add(group));
  let groundcoverLoaded = false;
  let groundcoverLoading = null;
  let cyclingLoaded = false;
  let runoffLoading = null;
  let runoffLoaded = false;
  let runoffMetadata = null;
  let runoffRainfallDepthMm = 25;

  // Decorative and municipal lighting share the same solar switch. Street
  // lamp glows and ground pools are batched; only festoon fill lights use
  // individual PointLights.
  const nightLighting = {
    streetGlow: null,
    streetBulbMaterial: null,
    streetPool: null,
    streetPoolMaterial: null,
    festoonGlow: null,
    festoonBulbMaterial: null,
    festoonPointLights: [],
  };

  const ambient = new THREE.HemisphereLight(0xf2f8f5, 0x77725e, 1.7);
  scene.add(ambient);
  // Warm, shadowless key and cool sky fill keep small façades legible while the
  // dedicated sun study remains responsible for analytical cast shadows.
  const cityFill = new THREE.DirectionalLight(0xffe3bd, 1.16);
  cityFill.position.set(-900, 1250, 700);
  scene.add(cityFill);
  const skyFill = new THREE.DirectionalLight(0xb9e0f0, 0.54);
  skyFill.position.set(800, 700, -900);
  scene.add(skyFill);
  const sunLight = new THREE.DirectionalLight(0xfff3d6, 3.25);
  sunLight.castShadow = true;
  sunLight.visible = false;
  sunLight.shadow.bias = 0.00015;
  sunLight.shadow.normalBias = 0.18;
  sunLight.shadow.radius = 2;
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

  // Sample the same two-triangle surface that the terrain mesh actually
  // renders. Draped features use this to avoid the small height mismatch
  // between bilinear sampling and the mesh's diagonal cell split.
  function terrainSurfaceHeightAt(x, z) {
    const u = clamp((x - left) / terrainWidth, 0, 1) * (terrain.columns - 1);
    const v = clamp((z - minZ) / terrainDepth, 0, 1) * (terrain.rows - 1);
    const column = Math.min(terrain.columns - 2, Math.floor(u));
    const row = Math.min(terrain.rows - 2, Math.floor(v));
    const tx = u - column;
    const tz = v - row;
    const at = (r, c) => terrain.heights[r * terrain.columns + c];
    const a = at(row, column), b = at(row, column + 1);
    const c = at(row + 1, column), d = at(row + 1, column + 1);
    return tx + tz <= 1
      ? a * (1 - tx - tz) + b * tx + c * tz
      : b * (1 - tz) + c * (1 - tx) + d * (tx + tz - 1);
  }

  // Roads are designed surfaces, so they should not inherit every small DTM
  // bump or seam. A local median rejects isolated spikes while retaining the
  // broader street slope and avoids twisting markings across the carriageway.
  const roadTerrainHeightCache = new Map();
  const roadTerrainHeightCacheKey = (x, z) => {
    const qx = Math.round((x + 10000) * 1000);
    const qz = Math.round((z + 10000) * 1000);
    return qx >= 0 && qx <= 20000000 && qz >= 0 && qz <= 20000000
      ? qx * 20000001 + qz
      : null;
  };
  function roadTerrainHeightAt(x, z) {
    const key = roadTerrainHeightCacheKey(x, z);
    if (key !== null) {
      const cached = roadTerrainHeightCache.get(key);
      if (cached !== undefined) return cached;
    }
    const radius = 4;
    const samples = [
      terrainHeightAt(x, z),
      terrainHeightAt(x - radius, z), terrainHeightAt(x + radius, z),
      terrainHeightAt(x, z - radius), terrainHeightAt(x, z + radius),
      terrainHeightAt(x - radius, z - radius), terrainHeightAt(x + radius, z - radius),
      terrainHeightAt(x - radius, z + radius), terrainHeightAt(x + radius, z + radius),
    ].sort((a, b) => a - b);
    const height = samples[Math.floor(samples.length / 2)];
    if (key !== null && roadTerrainHeightCache.size < 120000) roadTerrainHeightCache.set(key, height);
    return height;
  }

  const roadSurfaceHeightAt = (x, z) => Math.max(roadTerrainHeightAt(x, z), terrainSurfaceHeightAt(x, z));

  const nonStreetNameRoadTypes = new Set(['footway', 'path', 'cycleway', 'steps', 'corridor', 'elevator']);
  const namedStreetFeatures = (data.roads || []).flatMap(record => {
    const name = String(record?.[3]?.name || '').trim();
    const highway = String(record?.[1] || '');
    const points = record?.[2];
    if (!name || nonStreetNameRoadTypes.has(highway) || !Array.isArray(points) || points.length < 2) return [];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of points) {
      minX = Math.min(minX, x); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
    }
    return [{ name, points, minX, minZ, maxX, maxZ }];
  });

  function clearPlaceInspectorHighlight() {
    for (const child of [...placeInspectorHighlight.children]) {
      placeInspectorHighlight.remove(child);
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
      else child.material?.dispose();
    }
  }

  function focusPlaceInspector(feature, { focus = true } = {}) {
    clearPlaceInspectorHighlight();
    if (feature.kind === 'building') {
      const top = Number(feature.value[0] || 0) + Math.max(1, Number(feature.value[5] || feature.value[1] || 1)) + 1.2;
      const points = feature.ring.map(([x, z]) => new THREE.Vector3(x, top, z));
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const outline = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({
        color: 0xffd46b, transparent: true, opacity: 0.98, depthTest: false, depthWrite: false,
      }));
      outline.renderOrder = 1000;
      placeInspectorHighlight.add(outline);
    } else {
      const points = feature.points.map(([x, z]) => new THREE.Vector3(x, roadTerrainHeightAt(x, z) + 1.8, z));
      if (points.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(points);
        const geometry = new THREE.TubeGeometry(curve, Math.max(12, Math.min(128, points.length * 4)), 1.15, 6, false);
        const line = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
          color: 0xffd46b, transparent: true, opacity: 0.94, depthTest: false, depthWrite: false,
        }));
        line.renderOrder = 1000;
        placeInspectorHighlight.add(line);
      }
    }
    if (focus) {
      cameraState.target.set(feature.x, terrainSurfaceHeightAt(feature.x, feature.z) + 12, feature.z);
      cameraState.distance = Math.min(cameraState.distance, feature.kind === 'street' ? 700 : 550);
      updateCamera();
    }
    requestRender();
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

  function getViewshedBuildingIndex() {
    if (viewshedBuildingIndex) return viewshedBuildingIndex;
    const cellSize = 64;
    const cells = new Map();
    const insert = (ground, height, outer, holes = [], minHeight = 0) => {
      if (!outer?.length) return;
      const bounds = [
        Math.min(...outer.map(([x]) => x)), Math.min(...outer.map(([, z]) => z)),
        Math.max(...outer.map(([x]) => x)), Math.max(...outer.map(([, z]) => z)),
      ];
      const building = { ground: Number(ground) || 0, top: (Number(ground) || 0) + (Number(height) || 0), outer, holes: Array.isArray(holes) ? holes : [], bounds };
      for (let cx = Math.floor(bounds[0] / cellSize); cx <= Math.floor(bounds[2] / cellSize); cx += 1) {
        for (let cz = Math.floor(bounds[1] / cellSize); cz <= Math.floor(bounds[3] / cellSize); cz += 1) {
          const key = `${cx}:${cz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(building);
        }
      }
    };
    data.buildings.forEach((row, index) => {
      if (designRemovedBuildingIndexes.has(index)) return;
      const [ground, height, outer, , , wallHeight = height, , , , , minHeight = 0, , , holes = []] = row;
      const min = Math.max(0, Number(minHeight) || 0);
      insert(ground + min, Math.max(0, Math.max(Number(height) || 0, Number(wallHeight) || 0) - min), outer, holes);
    });
    for (const block of designMassingBlocks) insert(block.groundM ?? block.ground_m ?? 0, block.height_m ?? block.height ?? 0, block.ring, block.holes || []);
    viewshedBuildingIndex = { cellSize, cells };
    return viewshedBuildingIndex;
  }

  function viewshedBuildingsAt(x, z) {
    const { cellSize, cells } = getViewshedBuildingIndex();
    const candidates = cells.get(`${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`) || [];
    const matches = [];
    for (const building of candidates) {
      const [minX, minZ, maxX, maxZ] = building.bounds;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      if (pointInRing(x, z, building.outer) && !(building.holes || []).some(hole => pointInRing(x, z, hole))) matches.push(building);
    }
    return matches;
  }

  function viewshedRayObstacles(x, z, dx, dz, radius) {
    const { cellSize, cells } = getViewshedBuildingIndex();
    let cx = Math.floor(x / cellSize), cz = Math.floor(z / cellSize);
    const stepX = Math.sign(dx), stepZ = Math.sign(dz);
    const nextX = stepX > 0 ? (cx + 1) * cellSize : cx * cellSize;
    const nextZ = stepZ > 0 ? (cz + 1) * cellSize : cz * cellSize;
    let distanceX = stepX ? (nextX - x) / dx : Infinity;
    let distanceZ = stepZ ? (nextZ - z) / dz : Infinity;
    const deltaX = stepX ? cellSize / Math.abs(dx) : Infinity;
    const deltaZ = stepZ ? cellSize / Math.abs(dz) : Infinity;
    const candidates = new Set();
    for (let travel = 0; travel <= radius;) {
      for (const building of cells.get(`${cx}:${cz}`) || []) candidates.add(building);
      if (distanceX < distanceZ) {
        travel = distanceX;
        distanceX += deltaX;
        cx += stepX;
      } else {
        travel = distanceZ;
        distanceZ += deltaZ;
        cz += stepZ;
      }
    }
    const obstacles = [];
    for (const building of candidates) {
      for (const [start, end] of rayFootprintIntervals(x, z, dx, dz, radius, building.outer, building.holes)) {
        obstacles.push({ start, end, base: building.ground, top: building.top });
      }
    }
    obstacles.sort((a, b) => a.start - b.start);
    return obstacles;
  }

  function clearViewshedResult() {
    if (viewshedPersonCamera) setViewshedPersonView(false);
    viewshedState.group.traverse(object => {
      if (object.geometry && object.geometry !== terrainMesh.geometry) object.geometry.dispose();
      object.material?.uniforms?.visibilityMap?.value?.dispose();
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
      else object.material?.dispose();
    });
    viewshedState.group.clear();
    viewshedState.point = null;
    if (viewshedPersonButton) viewshedPersonButton.disabled = true;
    viewshedState.group.visible = false;
    if (viewshedStatus) viewshedStatus.textContent = viewshedState.active
      ? 'Click the terrain, a roof, or a building face to place the observer.'
      : 'Select Pick viewpoint, then click the map.';
    requestRender();
  }

  function setViewshedPersonView(enabled) {
    if (enabled && !viewshedState.point) return;
    if (enabled && !viewshedPersonCamera) {
      viewshedPersonCamera = {
        azimuth: cameraState.azimuth, elevation: cameraState.elevation,
        distance: cameraState.distance, target: cameraState.target.clone(), fov: camera.fov,
      };
    } else if (!enabled && viewshedPersonCamera) {
      Object.assign(cameraState, {
        azimuth: viewshedPersonCamera.azimuth, elevation: viewshedPersonCamera.elevation,
        distance: viewshedPersonCamera.distance,
      });
      cameraState.target.copy(viewshedPersonCamera.target);
      camera.fov = viewshedPersonCamera.fov;
      camera.updateProjectionMatrix();
      viewshedPersonCamera = null;
    }
    if (viewshedPersonButton) {
      viewshedPersonButton.setAttribute('aria-pressed', String(Boolean(viewshedPersonCamera)));
      viewshedPersonButton.textContent = viewshedPersonCamera ? 'Return to map view' : 'View from observer';
    }
    const marker = viewshedState.group.children.at(-1);
    if (marker?.isGroup) marker.visible = !viewshedPersonCamera;
    if (viewshedPersonCamera) {
      camera.fov = 70;
      camera.updateProjectionMatrix();
    }
    updateCamera();
    requestRender();
  }

  function buildViewshed(x, z, placement = null, reportBounds = null) {
    const radius = viewshedState.radius;
    const eyeHeight = viewshedState.eyeHeight;
    const onBuilding = placement?.kind === 'building';
    if (!onBuilding && !terrainValidAt(x, z)) {
      if (viewshedStatus) viewshedStatus.textContent = 'That point is outside the mapped terrain. Choose a point on the city ground.';
      return false;
    }
    const wasPersonView = Boolean(viewshedPersonCamera);
    clearViewshedResult();
    const observerGround = terrainSurfaceHeightAt(x, z);
    const wallPlacement = onBuilding && !placement.roof;
    const normal = placement?.normal || [0, 1, 0];
    const originX = x + (wallPlacement ? normal[0] * 1.2 : 0);
    const originZ = z + (wallPlacement ? normal[2] * 1.2 : 0);
    const observerY = onBuilding
      ? (placement.roof ? placement.y + eyeHeight : placement.y)
      : observerGround + eyeHeight;
    if (wallPlacement && !placement.headingInitialized) {
      viewshedState.heading = ((Math.round((Math.atan2(normal[0], -normal[2]) * 180 / Math.PI) / 5) * 5) % 360 + 360) % 360;
      if (viewshedHeading) viewshedHeading.value = String(Math.min(355, viewshedState.heading));
      if (viewshedHeadingValue) viewshedHeadingValue.textContent = `${viewshedState.heading}° · ${compassLabel(viewshedState.heading)}`;
    } else if (onBuilding && !placement.headingInitialized) {
      const focusHeading = Math.atan2(cameraState.target.x - x, -(cameraState.target.z - z)) * 180 / Math.PI;
      viewshedState.heading = (Math.round((focusHeading + 360) / 5) * 5) % 360;
      if (viewshedHeading) viewshedHeading.value = String(Math.min(355, viewshedState.heading));
      if (viewshedHeadingValue) viewshedHeadingValue.textContent = `${viewshedState.heading}° · ${compassLabel(viewshedState.heading)}`;
    }
    const observerBuildings = viewshedBuildingsAt(x, z);
    if (!onBuilding && observerBuildings.some(building => observerY >= building.ground && observerY < building.top)) {
      if (viewshedStatus) viewshedStatus.textContent = 'That point is inside a mapped building at this height. Choose an open area or raise the observer height.';
      return false;
    }
    // Keep polar cells close to street scale so open road corridors do not
    // disappear between rays or radial rings. Bound the mesh for long ranges.
    const ringDistances = viewshedRingDistances(radius);
    const radialSegments = ringDistances.length - 1;
    const isCone = viewshedState.shape === 'cone';
    const fullCircle = !isCone;
    const centerAngle = viewshedState.heading * Math.PI / 180 - Math.PI / 2;
    // Sample only the selected sector. A full 360° trace is unnecessary for
    // the default 60° view and used to block the main thread during changes.
    const angleSpan = isCone ? viewshedState.spread * Math.PI / 180 : Math.PI * 2;
    const angleSegments = clamp(Math.ceil(angleSpan * radius / 3), isCone ? 24 : 120, isCone ? 420 : 1200);
    const meshAngleCount = fullCircle ? angleSegments : angleSegments + 1;
    const meshAngles = fullCircle
      ? Array.from({ length: angleSegments }, (_, index) => index * Math.PI * 2 / angleSegments)
      : Array.from({ length: meshAngleCount }, (_, index) => centerAngle - viewshedState.spread * Math.PI / 360
        + angleSpan * index / angleSegments);
    const visibility = meshAngles.map(() => new Uint8Array(radialSegments + 1));
    let validSamples = 0;
    let visibleSamples = 0;
    for (let angleIndex = 0; angleIndex < meshAngleCount; angleIndex += 1) {
      const angle = meshAngles[angleIndex];
      const dx = Math.cos(angle), dz = Math.sin(angle);
      const obstacles = viewshedRayObstacles(originX, originZ, dx, dz, radius);
      const sampleDistances = terrainRayDistances(originX, originZ, dx, dz, radius,
        left, minZ, terrainWidth / (terrain.columns - 1), terrainDepth / (terrain.rows - 1), ringDistances);
      const occludedAngles = [];
      const activeObstacles = [];
      let nextObstacle = 0;
      let previousDistance = 0;
      let horizon = -Math.PI / 2;
      let nextRing = 1;
      for (const d of sampleDistances) {
        const sampleX = originX + dx * d, sampleZ = originZ + dz * d;
        if (!terrainValidAt(sampleX, sampleZ)) break;
        const ground = terrainSurfaceHeightAt(sampleX, sampleZ);
        while (nextObstacle < obstacles.length && obstacles[nextObstacle].start <= d) {
          activeObstacles.push(obstacles[nextObstacle]);
          nextObstacle += 1;
        }
        for (let index = activeObstacles.length - 1; index >= 0; index -= 1) {
          const obstacle = activeObstacles[index];
          const from = Math.max(obstacle.start, previousDistance);
          const to = Math.min(obstacle.end, d);
          addVerticalOccluder(occludedAngles, obstacle.base, obstacle.top, observerY, from, to);
          if (obstacle.end <= d) activeObstacles.splice(index, 1);
        }
        // Terrain is a horizon. Buildings occupy bounded angular intervals,
        // allowing a low sightline through a real mapped underpass.
        const targetAngle = Math.atan2(ground - observerY, d);
        const visible = !blockedByVerticalOccluder(occludedAngles, targetAngle) && targetAngle >= horizon - 0.001;
        while (nextRing <= radialSegments && d >= ringDistances[nextRing] - 0.001) {
          visibility[angleIndex][nextRing] = visible ? 1 : 2;
          const sampleDistance = ringDistances[nextRing];
          const sampleX = originX + dx * sampleDistance;
          const sampleZ = originZ + dz * sampleDistance;
          const inReportArea = !reportBounds || (sampleX >= reportBounds.min_x && sampleX <= reportBounds.max_x
            && sampleZ >= reportBounds.min_z && sampleZ <= reportBounds.max_z);
          if (inReportArea) {
            validSamples += 1;
            if (visible) visibleSamples += 1;
          }
          nextRing += 1;
        }
        horizon = Math.max(horizon, targetAngle);
        previousDistance = d;
        if (d >= radius) break;
      }
    }

    // Render the classification on the terrain's own triangles. A separate
    // polar ground mesh bridges slopes and appears to float or cut through
    // the mapped surface even when its vertex heights were sampled correctly.
    const texturePixels = new Uint8Array(meshAngleCount * (radialSegments + 1) * 4);
    for (let ring = 0; ring <= radialSegments; ring += 1) {
      for (let angleIndex = 0; angleIndex < meshAngleCount; angleIndex += 1) {
        const value = ring === 0 ? 1 : visibility[angleIndex][ring];
        const offset = (ring * meshAngleCount + angleIndex) * 4;
        texturePixels[offset] = value === 1 ? 255 : 0;
        texturePixels[offset + 3] = value ? 255 : 0;
      }
    }
    const visibilityMap = new THREE.DataTexture(texturePixels, meshAngleCount, radialSegments + 1, THREE.RGBAFormat);
    visibilityMap.magFilter = THREE.NearestFilter;
    visibilityMap.minFilter = THREE.NearestFilter;
    visibilityMap.generateMipmaps = false;
    visibilityMap.needsUpdate = true;
    const footprint = new THREE.Mesh(terrainMesh.geometry, new THREE.ShaderMaterial({
      uniforms: {
        visibilityMap: { value: visibilityMap },
        origin: { value: new THREE.Vector2(originX, originZ) },
        radius: { value: radius },
        angleStart: { value: meshAngles[0] },
        angleSpan: { value: angleSpan },
        angleStep: { value: angleSpan / angleSegments },
        angleCount: { value: meshAngleCount },
        ringCount: { value: radialSegments + 1 },
        fullCircle: { value: fullCircle },
      },
      vertexShader: `
        varying vec2 groundXZ;
        void main() {
          groundXZ = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, position.y + 0.08, position.z, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D visibilityMap;
        uniform vec2 origin;
        uniform float radius, angleStart, angleSpan, angleStep, angleCount, ringCount;
        uniform bool fullCircle;
        varying vec2 groundXZ;
        void main() {
          vec2 offset = groundXZ - origin;
          float distanceToEye = length(offset);
          if (distanceToEye > radius) discard;
          float angle = atan(offset.y, offset.x);
          float relative = mod(angle - angleStart + 12.56637061436, 6.28318530718);
          if (!fullCircle && relative > angleSpan) discard;
          float column = floor(relative / angleStep + 0.5);
          column = fullCircle ? mod(column, angleCount) : clamp(column, 0.0, angleCount - 1.0);
          float row = distanceToEye <= 30.0
            ? floor(distanceToEye + 0.5)
            : distanceToEye <= 100.0
              ? 30.0 + floor((distanceToEye - 30.0) / 2.0 + 0.5)
              : 65.0 + floor((distanceToEye - 100.0) / 4.0 + 0.5);
          row = clamp(row, 0.0, ringCount - 1.0);
          vec4 result = texture2D(visibilityMap, vec2((column + 0.5) / angleCount, (row + 0.5) / ringCount));
          if (result.a < 0.5) discard;
          vec3 color = result.r > 0.5 ? vec3(0.008, 0.48, 0.18) : vec3(0.78, 0.085, 0.105);
          gl_FragColor = vec4(color, 0.76);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    setSceneLayer(footprint, 'analysisSurface');
    footprint.name = 'viewshed-footprint';
    viewshedState.group.add(footprint);

    const visibleColor = new THREE.Color(0x16b875);
    const hiddenColor = new THREE.Color(0xe55158);
    const positions = [];
    const topPositions = [];
    const colors = [];
    const topColors = [];
    const indices = [];
    const validVertex = [];
    for (let ring = 0; ring <= radialSegments; ring += 1) {
      const distance = ringDistances[ring];
      for (let meshAngleIndex = 0; meshAngleIndex < meshAngleCount; meshAngleIndex += 1) {
        const angle = meshAngles[meshAngleIndex];
        const px = originX + Math.cos(angle) * distance;
        const pz = originZ + Math.sin(angle) * distance;
        const valid = ring === 0 || terrainValidAt(px, pz);
        const ground = valid ? terrainSurfaceHeightAt(px, pz) : observerGround;
        // Sit above mapped ground textures, but let above-ground objects,
        // buildings and ridges retain their normal depth in front of the tint.
        const floorY = ground + SCENE_LAYERS.analysisSurface.lift;
        const visible = ring === 0 || visibility[meshAngleIndex][ring] === 1;
        const color = visible ? visibleColor : hiddenColor;
        positions.push(px, floorY, pz);
        colors.push(color.r, color.g, color.b);
        topPositions.push(px, isCone ? observerY + Math.tan(viewshedState.verticalFov * Math.PI / 360) * distance : floorY, pz);
        topColors.push(color.r, color.g, color.b);
        validVertex.push(valid);
      }
    }
    for (let ring = 0; ring < radialSegments; ring += 1) {
      const sectorCount = fullCircle ? meshAngleCount : meshAngleCount - 1;
      for (let meshAngleIndex = 0; meshAngleIndex < sectorCount; meshAngleIndex += 1) {
        const nextAngle = (meshAngleIndex + 1) % meshAngleCount;
        const a = ring * meshAngleCount + meshAngleIndex;
        const b = ring * meshAngleCount + nextAngle;
        const c = (ring + 1) * meshAngleCount + meshAngleIndex;
        const d = (ring + 1) * meshAngleCount + nextAngle;
        if (!validVertex[a] || !validVertex[b] || !validVertex[c] || !validVertex[d]) continue;
        indices.push(a, c, b, b, c, d);
      }
    }
    const marker = new THREE.Group();
    const pin = new THREE.Mesh(new THREE.SphereGeometry(2.8, 18, 14), new THREE.MeshBasicMaterial({ color: 0xffbd68 }));
    pin.position.set(originX, observerY, originZ);
    marker.add(pin);
    if (!wallPlacement) {
      const stemHeight = Math.max(3.5, eyeHeight);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, stemHeight, 10), new THREE.MeshBasicMaterial({ color: 0xffbd68 }));
      stem.position.set(originX, (onBuilding ? placement.y : observerGround) + stemHeight * 0.5, originZ);
      marker.add(stem);
    } else {
      const tick = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.5, 8), new THREE.MeshBasicMaterial({ color: 0xffbd68 }));
      tick.position.set(x + normal[0] * 0.5, observerY, z + normal[2] * 0.5);
      tick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(normal[0], 0, normal[2]).normalize());
      marker.add(tick);
    }

    if (isCone) {
      const topGeometry = new THREE.BufferGeometry();
      topGeometry.setAttribute('position', new THREE.Float32BufferAttribute(topPositions, 3));
      topGeometry.setAttribute('color', new THREE.Float32BufferAttribute(topColors, 3));
      topGeometry.setIndex(indices);
      const canopy = new THREE.Mesh(topGeometry, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.025, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      }));
      setSceneLayer(canopy, 'analysisVolume');
      canopy.name = 'viewshed-cone-canopy';
      viewshedState.group.add(canopy);

      const sidePositions = [];
      const sideIndices = [];
      const addSideQuad = (lowerA, upperA, lowerB, upperB) => {
        const base = sidePositions.length / 3;
        sidePositions.push(...lowerA, ...upperA, ...lowerB, ...upperB);
        sideIndices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      };
      for (let ring = 0; ring < radialSegments; ring += 1) {
        for (const sideAngleIndex of fullCircle ? [] : [0, meshAngleCount - 1]) {
          const first = ring * meshAngleCount + sideAngleIndex;
          const second = (ring + 1) * meshAngleCount + sideAngleIndex;
          if (validVertex[first] && validVertex[second]) addSideQuad(
            positions.slice(first * 3, first * 3 + 3), topPositions.slice(first * 3, first * 3 + 3),
            positions.slice(second * 3, second * 3 + 3), topPositions.slice(second * 3, second * 3 + 3),
          );
        }
      }
      const farStart = radialSegments * meshAngleCount;
      for (let meshAngleIndex = 0; meshAngleIndex < meshAngleCount - 1; meshAngleIndex += 1) {
        const first = farStart + meshAngleIndex, second = first + 1;
        if (validVertex[first] && validVertex[second]) addSideQuad(
          positions.slice(first * 3, first * 3 + 3), topPositions.slice(first * 3, first * 3 + 3),
          positions.slice(second * 3, second * 3 + 3), topPositions.slice(second * 3, second * 3 + 3),
        );
      }
      const sideGeometry = new THREE.BufferGeometry();
      sideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sidePositions, 3));
      sideGeometry.setIndex(sideIndices);
      const sides = new THREE.Mesh(sideGeometry, new THREE.MeshBasicMaterial({
        color: 0x677887, transparent: true, opacity: 0.035, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      }));
      setSceneLayer(sides, 'analysisVolume');
      sides.name = 'viewshed-cone-sides';
      viewshedState.group.add(sides);

      const outlinePoints = (useTop, indicesToTrace) => indicesToTrace.map(index => {
        const offset = (farStart + index) * 3;
        const source = useTop ? topPositions : positions;
        return new THREE.Vector3(source[offset], source[offset + 1], source[offset + 2]);
      });
      const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x526875, transparent: true, opacity: 0.65, depthTest: true, toneMapped: false });
      const edgeIndices = Array.from({ length: meshAngleCount }, (_, index) => index);
      marker.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outlinePoints(false, edgeIndices)), outlineMaterial.clone()));
      marker.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outlinePoints(true, edgeIndices)), outlineMaterial.clone()));
      for (const sideAngleIndex of [0, meshAngleCount - 1]) {
        const endpoint = (farStart + sideAngleIndex) * 3;
        marker.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(originX, observerY, originZ),
          new THREE.Vector3(topPositions[endpoint], topPositions[endpoint + 1], topPositions[endpoint + 2]),
        ]), outlineMaterial.clone()));
        marker.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(originX, observerY, originZ),
          new THREE.Vector3(positions[endpoint], positions[endpoint + 1], positions[endpoint + 2]),
        ]), outlineMaterial.clone()));
      }
    } else {
      const ringPoints = [];
      for (let index = 0; index < 128; index += 1) {
        const angle = index * Math.PI * 2 / 128;
        const px = originX + Math.cos(angle) * radius;
        const pz = originZ + Math.sin(angle) * radius;
        ringPoints.push(new THREE.Vector3(px, terrainSurfaceHeightAt(px, pz) + SCENE_LAYERS.analysisSurface.lift, pz));
      }
      const rangeRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPoints), new THREE.LineBasicMaterial({ color: 0x8de9ec, transparent: true, opacity: 0.75, depthTest: true }));
      setSceneLayer(rangeRing, 'analysisSurface', 1);
      marker.add(rangeRing);
    }
    viewshedState.group.add(marker);
    viewshedState.point = { x, z, placement: placement ? { ...placement, headingInitialized: true } : null, originX, originZ, observerY };
    if (viewshedPersonButton) viewshedPersonButton.disabled = false;
    viewshedState.group.visible = viewshedState.active;
    if (wasPersonView) setViewshedPersonView(true);
    if (viewshedStatus) {
      const percent = validSamples ? Math.round(visibleSamples / validSamples * 100) : 0;
      const shapeSummary = isCone ? `${viewshedState.heading}° heading · ${viewshedState.spread}° cone` : '360° view';
      const sourceLabel = wallPlacement ? 'façade / window' : onBuilding ? 'roof' : 'ground';
      viewshedStatus.textContent = `${percent}% of sampled ground visible · ${sourceLabel} · ${shapeSummary} · ${radius} m radius.`;
    }
    const visibleGroundPercent = validSamples ? visibleSamples / validSamples * 100 : 0;
    const shapeLabel = isCone ? 'Directional view' : 'Full 360° view';
    const surfaceLabel = wallPlacement ? 'building face' : onBuilding ? 'roof' : 'ground';
    dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'viewshed', metadata: {
      description: reportBounds
        ? `${visibleGroundPercent.toFixed(1)}% of sampled ground inside the selected square is visible from its centre.`
        : `${visibleGroundPercent.toFixed(1)}% of mapped ground is visible from this viewpoint within ${radius} m. ${shapeLabel}${isCone ? ` facing ${compassLabel(viewshedState.heading)}` : ''}.`,
      visible_ground_pct: visibleGroundPercent,
      visible_samples: visibleSamples,
      sampled_ground_count: validSamples,
      radius_m: radius,
      eye_height_m: eyeHeight,
      heading_deg: isCone ? viewshedState.heading : null,
      spread_deg: isCone ? viewshedState.spread : 360,
      shape: shapeLabel,
      analysis_scope: reportBounds ? 'selected-square' : 'view-radius',
      area_bounds: reportBounds || null,
      observer: { x: originX, z: originZ, height_m: observerY, surface: surfaceLabel },
      kpis: {
        visible_ground_pct: visibleGroundPercent,
        visible_samples: visibleSamples,
        sampled_ground_count: validSamples,
        radius_m: radius,
        eye_height_m: eyeHeight,
      },
    } } }));
    requestRender();
    return true;
  }

  const waterMasks = (data.water || []).map(water => {
    const [outer, ...holes] = water.rings || [];
    if (!outer?.length) return null;
    return {
      outer,
      holes,
      bounds: [
        Math.min(...outer.map(([x]) => x)), Math.min(...outer.map(([, z]) => z)),
        Math.max(...outer.map(([x]) => x)), Math.max(...outer.map(([, z]) => z)),
      ],
    };
  }).filter(Boolean);

  function pointInMappedWater(x, z, masks = waterMasks) {
    for (const mask of masks) {
      const [minX, minZ, maxX, maxZ] = mask.bounds;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      if (pointInRing(x, z, mask.outer) && !mask.holes.some(hole => pointInRing(x, z, hole))) return true;
    }
    return false;
  }

  function pointNearMappedWaterBoundary(x, z, tolerance = 2) {
    const toleranceSquared = tolerance * tolerance;
    for (const mask of waterMasks) {
      const [minX, minZ, maxX, maxZ] = mask.bounds;
      if (x < minX - tolerance || x > maxX + tolerance || z < minZ - tolerance || z > maxZ + tolerance) continue;
      for (const ring of [mask.outer, ...mask.holes]) {
        for (let index = 0; index < ring.length; index += 1) {
          const [ax, az] = ring[index], [bx, bz] = ring[(index + 1) % ring.length];
          const dx = bx - ax, dz = bz - az;
          const t = clamp(((x - ax) * dx + (z - az) * dz) / Math.max(dx * dx + dz * dz, 1e-8), 0, 1);
          const px = ax + dx * t, pz = az + dz * t;
          if ((x - px) ** 2 + (z - pz) ** 2 <= toleranceSquared) return true;
        }
      }
    }
    return false;
  }

  function pointInLidarFootprint(x, z) {
    if (!terrain.footprint?.length) return true;
    return terrain.footprint.some(polygon => (
      pointInRing(x, z, polygon[0])
      && !polygon.slice(1).some(hole => pointInRing(x, z, hole))
    ));
  }

  const lidarEdgeCellSize = 60;
  const lidarEdgesByCell = new Map();
  for (const polygon of terrain.footprint || []) for (const ring of polygon || []) {
    for (let index = 0; index < ring.length; index += 1) {
      const [ax, az] = ring[index], [bx, bz] = ring[(index + 1) % ring.length];
      const edge = [ax, az, bx, bz];
      for (let row = Math.floor(Math.min(az, bz) / lidarEdgeCellSize);
        row <= Math.floor(Math.max(az, bz) / lidarEdgeCellSize); row += 1) {
        for (let column = Math.floor(Math.min(ax, bx) / lidarEdgeCellSize);
          column <= Math.floor(Math.max(ax, bx) / lidarEdgeCellSize); column += 1) {
          const key = `${column}:${row}`;
          if (!lidarEdgesByCell.has(key)) lidarEdgesByCell.set(key, []);
          lidarEdgesByCell.get(key).push(edge);
        }
      }
    }
  }

  function lidarFootprintSegmentIntervals(x0, z0, x1, z1, startInside) {
    if (!terrain.footprint?.length) return [[0, 1]];
    const candidates = new Set();
    for (let row = Math.floor(Math.min(z0, z1) / lidarEdgeCellSize);
      row <= Math.floor(Math.max(z0, z1) / lidarEdgeCellSize); row += 1) {
      for (let column = Math.floor(Math.min(x0, x1) / lidarEdgeCellSize);
        column <= Math.floor(Math.max(x0, x1) / lidarEdgeCellSize); column += 1) {
        for (const edge of lidarEdgesByCell.get(`${column}:${row}`) || []) candidates.add(edge);
      }
    }
    return segmentPolygonSetIntervals(x0, z0, x1, z1, terrain.footprint, [...candidates], startInside);
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

  function makeDioramaBase(minimumY) {
    const sourceRing = terrain.footprint?.[0]?.[0];
    if (!sourceRing || sourceRing.length < 8) return [];
    const sampleStep = Math.max(1, Math.ceil(sourceRing.length / 128));
    let ring = sourceRing.filter((_, index) => index % sampleStep === 0)
      .map(([x, z]) => new THREE.Vector2(x, z));
    // Smooth the rasterized LiDAR boundary while keeping the physical cut
    // line inside its own measured footprint.
    for (let pass = 0; pass < 2; pass += 1) {
      const smoothed = [];
      for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index], next = ring[(index + 1) % ring.length];
        smoothed.push(
          new THREE.Vector2(current.x * 0.75 + next.x * 0.25, current.y * 0.75 + next.y * 0.25),
          new THREE.Vector2(current.x * 0.25 + next.x * 0.75, current.y * 0.25 + next.y * 0.75),
        );
      }
      ring = smoothed;
    }
    let centroidX = 0, centroidZ = 0;
    for (const point of ring) { centroidX += point.x; centroidZ += point.y; }
    centroidX /= ring.length;
    centroidZ /= ring.length;
    const makeLayer = ({ margin, bottomY, depth, face, side, bevel = false, name }) => {
      const outline = ring.map(point => {
        const dx = point.x - centroidX, dz = point.y - centroidZ;
        const length = Math.hypot(dx, dz) || 1;
        return [point.x + dx / length * margin, point.y + dz / length * margin];
      });
      const shape = new THREE.Shape();
      shape.moveTo(outline[0][0], -outline[0][1]);
      for (const [x, z] of outline.slice(1)) shape.lineTo(x, -z);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth, steps: 1, bevelEnabled: bevel,
        bevelSegments: bevel ? 2 : 0,
        bevelSize: bevel ? 0.65 : 0,
        bevelThickness: bevel ? 0.55 : 0,
        curveSegments: 2,
      });
      geometry.rotateX(-Math.PI / 2);
      const materials = [
        new THREE.MeshStandardMaterial({ color: face, roughness: 0.84, side: THREE.DoubleSide }),
        new THREE.MeshStandardMaterial({ color: side, roughness: 0.76, side: THREE.DoubleSide }),
      ];
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.position.y = bottomY;
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    };
    const rim = makeLayer({
      margin: 18, bottomY: minimumY - 52, depth: 7,
      face: COLORS.plinthAccent, side: COLORS.plinthSide, name: 'concrete-edge-course',
    });
    const slab = makeLayer({
      margin: 14, bottomY: minimumY - 45, depth: 44,
      face: COLORS.plinthTop, side: COLORS.plinthSide, bevel: true, name: 'diorama-plinth',
    });
    return [rim, slab];
  }

  const surfaceTextureCache = new Map();
  let sharedSurfaceNoiseFields = null;
  function surfaceNoiseFields(size) {
    if (sharedSurfaceNoiseFields) return sharedSurfaceNoiseFields;
    const fract = value => value - Math.floor(value);
    const hash = (x, y, cells, seed) => {
      const wrappedX = (x % cells + cells) % cells;
      const wrappedY = (y % cells + cells) % cells;
      const value = Math.sin((wrappedX + seed * 13.1) * 127.1 + (wrappedY - seed * 3.7) * 311.7) * 43758.5453;
      return fract(value);
    };
    const noise = (u, v, cells, seed) => {
      const x = u * cells, y = v * cells;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const top = hash(x0, y0, cells, seed) * (1 - sx) + hash(x0 + 1, y0, cells, seed) * sx;
      const bottom = hash(x0, y0 + 1, cells, seed) * (1 - sx) + hash(x0 + 1, y0 + 1, cells, seed) * sx;
      return top * (1 - sy) + bottom * sy;
    };
    const count = size * size;
    const fields = { broad: new Float64Array(count), medium: new Float64Array(count), fine: new Float64Array(count) };
    for (let y = 0; y < size; y += 1) {
      const v = y / size;
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x, u = x / size;
        fields.broad[index] = noise(u, v, 4, 17);
        fields.medium[index] = noise(u, v, 13, 29);
        fields.fine[index] = noise(u, v, 44, 41);
      }
    }
    sharedSurfaceNoiseFields = fields;
    return fields;
  }

  function makeSurfaceTexture(kind) {
    if (surfaceTextureCache.has(kind)) return surfaceTextureCache.get(kind);
    const size = 256;
    const pixels = new Uint8Array(size * size * 4);
    const { broad: broadField, medium: mediumField, fine: fineField } = surfaceNoiseFields(size);
    const fract = value => value - Math.floor(value);
    const hash = (x, y, cells, seed) => {
      const wrappedX = (x % cells + cells) % cells;
      const wrappedY = (y % cells + cells) % cells;
      const value = Math.sin((wrappedX + seed * 13.1) * 127.1 + (wrappedY - seed * 3.7) * 311.7) * 43758.5453;
      return fract(value);
    };
    const smoothstep = (edge0, edge1, value) => {
      const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
      return amount * amount * (3 - 2 * amount);
    };
    const put = (x, y, red, green = red, blue = red) => {
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(clamp(red, 0, 255));
      pixels[offset + 1] = Math.round(clamp(green, 0, 255));
      pixels[offset + 2] = Math.round(clamp(blue, 0, 255));
      pixels[offset + 3] = 255;
    };

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const u = x / size, v = y / size;
        const index = y * size + x;
        const broad = broadField[index];
        const medium = mediumField[index];
        const fine = fineField[index];
        if (kind === 'grass') {
          const dry = smoothstep(0.61, 0.86, broad * 0.7 + medium * 0.3);
          const variation = (broad - 0.5) * 17 + (medium - 0.5) * 12 + (fine - 0.5) * 7;
          const straw = fine > 0.982 ? 12 : 0;
          put(x, y,
            113 + variation + dry * 21 + straw,
            126 + variation + dry * 5 + straw * 0.7,
            76 + variation * 0.52 + dry * 12 + straw * 0.35);
          continue;
        }
        if (kind === 'terrain') {
          const value = 229 + (broad - 0.5) * 9 + (medium - 0.5) * 6 + (fine - 0.5) * 4;
          put(x, y, value, value, value);
          continue;
        }

        let value = 229 + (broad - 0.5) * 9 + (medium - 0.5) * 12 + (fine - 0.5) * 8;
        if (kind === 'asphalt') {
          if (fine > 0.995) value -= 30 + medium * 22;
          put(x, y, value + 2, value + 1, value - 1);
          continue;
        }
        if (kind === 'gravel') {
          if (fine > 0.978) value -= 26 + medium * 27;
          put(x, y, value + 4, value + 2, value - 3);
          continue;
        }

        if (kind === 'brick' || kind === 'stone') {
          const across = kind === 'brick' ? 24 : 12;
          const down = kind === 'brick' ? 16 : 12;
          const row = Math.floor(v * down);
          const columnOffset = kind === 'brick' && row % 2 ? 0.5 : 0;
          const cellU = fract(u * across + columnOffset);
          const cellV = fract(v * down);
          const mortar = kind === 'brick'
            ? cellU < 0.055 || cellU > 0.945 || cellV < 0.065 || cellV > 0.935
            : cellU < 0.035 || cellU > 0.965 || cellV < 0.035 || cellV > 0.965;
          const blockTone = hash(Math.floor(u * across), row, across * down, kind === 'brick' ? 53 : 67);
          value += (blockTone - 0.5) * (kind === 'brick' ? 14 : 9);
          if (mortar) value -= kind === 'brick' ? 39 : 31;
          put(x, y, value + (kind === 'brick' ? 4 : 3), value, value - (kind === 'brick' ? 2 : 1));
          continue;
        }

        if (kind === 'grandParade') {
          // The Parade is a warm, finely jointed stone field, with the broad
          // darker divider bands visible in the aerial reference every few
          // metres. UVs repeat in real-world units, so these remain at a
          // consistent scale as the camera moves.
          const across = 24;
          const down = 24;
          const column = Math.floor(u * across);
          const row = Math.floor(v * down);
          const cellU = fract(u * across), cellV = fract(v * down);
          const fineJoint = cellU < 0.025 || cellU > 0.975 || cellV < 0.025 || cellV > 0.975;
          const broadBand = column % 12 === 0 || row % 12 === 0;
          const blockTone = hash(column, row, across * down, 83);
          value += (blockTone - 0.5) * 8 - (broadBand ? 10 : 0);
          if (fineJoint) value -= 26;
          put(x, y, value + 5, value + 1, value - 8);
          continue;
        }

        if (kind === 'redPavers') {
          // Restrained terracotta blocks with the larger square joints from
          // Thibault Square and St George's Mall readable at close zoom.
          const across = 24;
          const down = 24;
          const column = Math.floor(u * across);
          const row = Math.floor(v * down);
          const cellU = fract(u * across), cellV = fract(v * down);
          const fineJoint = cellU < 0.024 || cellU > 0.976 || cellV < 0.024 || cellV > 0.976;
          const squareBand = column % 6 === 0 || row % 6 === 0;
          const blockTone = hash(column, row, across * down, 97);
          value += (blockTone - 0.5) * 9 - (squareBand ? 12 : 0);
          if (fineJoint) value -= 24;
          put(x, y, value + 14, value - 20, value - 31);
          continue;
        }

        put(x, y, value + 4, value + 2, value);
      }
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    surfaceTextureCache.set(kind, texture);
    return texture;
  }

  function makeTerrain() {
    const positions = [];
    const uvs = [];
    const indices = [];
    const terrainMask = terrain.valid;
    const cellValid = index => !terrainMask?.length || terrainMask[index] > 0;
    const appendPartialTriangle = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      const first = positions.length / 3;
      positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      uvs.push(ax / 32, az / 32, bx / 32, bz / 32, cx / 32, cz / 32);
      indices.push(first, first + 1, first + 2);
    };
    for (let row = 0; row < terrain.rows; row += 1) {
      for (let column = 0; column < terrain.columns; column += 1) {
        const x = left + terrainWidth * column / (terrain.columns - 1);
        const z = minZ + terrainDepth * row / (terrain.rows - 1);
        positions.push(x, terrain.heights[row * terrain.columns + column], z);
        uvs.push(x / 32, z / 32);
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
        // Keep the regular terrain grid in the interior, but refine only cells
        // that cross the lidar footprint. This cuts the city edge to the survey
        // outline instead of extending whole coarse cells into the void.
        const validA = cellValid(a), validB = cellValid(b);
        const validC = cellValid(c), validD = cellValid(d);
        // The old centroid validity check rounds to the nearest terrain grid
        // vertex: triangle A-C-B resolves to A, and B-C-D resolves to D.
        // Reuse those exact mask values and retain the same partial-cell rule.
        if (validA && validB && validC) indices.push(a, c, b);
        else if (validA) appendPartialTriangle(
          x0, terrain.heights[a], z0, x0, terrain.heights[c], z1, x1, terrain.heights[b], z0,
        );
        if (validB && validC && validD) indices.push(b, c, d);
        else if (validD) appendPartialTriangle(
          x1, terrain.heights[b], z0, x0, terrain.heights[c], z1, x1, terrain.heights[d], z1,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      color: COLORS.terrain,
      map: makeSurfaceTexture('terrain'),
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
    let minimumY = Infinity;
    for (let index = 1; index < positions.length; index += 3) minimumY = Math.min(minimumY, positions[index]);
    const plinthMeshes = makeDioramaBase(minimumY);
    for (const plinth of plinthMeshes) {
      plinth.userData.normalMaterial = plinth.material;
      plinth.userData.sunMaterial = Array.isArray(plinth.material)
        ? plinth.material.map(() => new THREE.MeshStandardMaterial({ color: COLORS.terrainSun, roughness: 0.9, side: THREE.DoubleSide }))
        : new THREE.MeshStandardMaterial({ color: COLORS.terrainSun, roughness: 0.9, side: THREE.DoubleSide });
      sunModeNeutralMeshes.push(plinth);
    }
    layerGroups.terrain.add(...plinthMeshes);
    setSceneLayer(mesh, 'terrain');
    setSceneLayer(shadowCatcher, 'terrainShadow');
    layerGroups.terrain.add(mesh, shadowCatcher);
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

  const waterNoiseCache = new Map();
  function waterNoiseTables(seed) {
    if (waterNoiseCache.has(seed)) return waterNoiseCache.get(seed);
    const tables = new Map();
    for (const cells of [4, 12, 40]) {
      const values = new Float64Array(cells * cells);
      for (let y = 0; y < cells; y += 1) for (let x = 0; x < cells; x += 1) {
        const value = Math.sin((x + seed * 13.1) * 127.1 + (y - seed * 3.7) * 311.7) * 43758.5453;
        values[y * cells + x] = value - Math.floor(value);
      }
      tables.set(cells, values);
    }
    waterNoiseCache.set(seed, tables);
    return tables;
  }

  function makeWaterTexture(algaeStrength, seed) {
    const size = 256;
    const pixels = new Uint8Array(size * size * 4);
    const tables = waterNoiseTables(seed);
    const noise = (u, v, cells) => {
      const x = u * cells, y = v * cells;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const table = tables.get(cells);
      const wrap = value => (value % cells + cells) % cells;
      const top = table[wrap(y0) * cells + wrap(x0)] * (1 - sx) + table[wrap(y0) * cells + wrap(x0 + 1)] * sx;
      const bottom = table[wrap(y0 + 1) * cells + wrap(x0)] * (1 - sx) + table[wrap(y0 + 1) * cells + wrap(x0 + 1)] * sx;
      return top * (1 - sy) + bottom * sy;
    };
    const smoothstep = (edge0, edge1, value) => {
      const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
      return amount * amount * (3 - 2 * amount);
    };
    const deep = [17, 83, 111];
    const shallow = [48, 143, 157];
    const algae = [82, 119, 57];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const u = x / size, v = y / size;
        const broad = noise(u, v, 4);
        const medium = noise(u, v, 12);
        const fine = noise(u, v, 40);
        const waterTone = clamp(broad * 0.62 + medium * 0.30 + fine * 0.08, 0, 1);
        const algaePatch = smoothstep(0.50, 0.76, broad * 0.78 + medium * 0.22) * algaeStrength;
        const ripple = Math.pow(Math.max(0, Math.sin((u * 7.0 + v * 4.2 + broad * 0.16) * Math.PI * 2) - 0.94), 1.7) * 88;
        const grain = (fine - 0.5) * 9;
        const offset = (y * size + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const water = deep[channel] + (shallow[channel] - deep[channel]) * waterTone;
          const toned = water + (algae[channel] - water) * algaePatch + ripple + grain;
          pixels[offset + channel] = Math.round(clamp(toned, 0, 255));
        }
        pixels[offset + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  function makeWater() {
    const batches = new Map([
      ['lake', { positions: [], uvs: [], indices: [] }],
      ['pond', { positions: [], uvs: [], indices: [] }],
      ['canal', { positions: [], uvs: [], indices: [] }],
    ]);
    for (const water of data.water || []) {
      const [outer, ...holes] = water.rings || [];
      if (!outer?.length || outer.length < 3) continue;
      const { vertices, faces } = triangulateRings(outer, holes);
      if (!faces.length) continue;
      const heights = outer.map(([x, z]) => terrainSurfaceHeightAt(x, z)).sort((a, b) => a - b);
      const waterLevel = heights[Math.floor(heights.length * 0.5)] + 0.55;
      const attributes = water.attributes || {};
      const kind = attributes.class === 'canal' ? 'canal' : attributes.class === 'pond' ? 'pond' : 'lake';
      const batch = batches.get(kind);
      const firstVertex = batch.positions.length / 3;
      for (const [x, z] of vertices) {
        batch.positions.push(x, waterLevel, z);
        batch.uvs.push(x / 45, z / 45);
      }
      for (const face of faces) batch.indices.push(...face.map(index => firstVertex + index));
    }

    const settings = {
      lake: { algae: 0.27, seed: 3, roughness: 0.28, clearcoat: 0.34 },
      pond: { algae: 0.58, seed: 7, roughness: 0.34, clearcoat: 0.22 },
      canal: { algae: 0.08, seed: 13, roughness: 0.22, clearcoat: 0.46 },
    };
    for (const [kind, batch] of batches) {
      if (!batch.indices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
      geometry.setIndex(batch.indices);
      geometry.computeVertexNormals();
      const config = settings[kind];
      const material = new THREE.MeshPhysicalMaterial({
        map: makeWaterTexture(config.algae, config.seed),
        color: kind === 'pond' ? 0xe8f4d9 : kind === 'canal' ? 0xd7f2f1 : 0xe0f4f4,
        roughness: config.roughness,
        metalness: 0.035,
        clearcoat: config.clearcoat,
        clearcoatRoughness: 0.24,
        bumpMap: makeWaterTexture(config.algae * 0.42, config.seed + 21),
        bumpScale: 0.11,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `osm-water-${kind}`;
      mesh.userData.normalMaterial = material;
      mesh.userData.sunMaterial = new THREE.MeshLambertMaterial({
        color: COLORS.terrainSun, emissive: 0x242424, emissiveIntensity: 0.24, side: THREE.DoubleSide,
      });
    setSceneLayer(mesh, 'water');
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      layerGroups.water.add(mesh);
      sunModeNeutralMeshes.push(mesh);
    }
    return data.water?.length || 0;
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

  let designRemovedBuildingIndexes = new Set();
  let designMassingBlocks = [];
  let designWindBaseline = null;
  const designShadePreviewGroup = new THREE.Group();
  designShadePreviewGroup.name = 'design-live-shade-preview';
  designShadePreviewGroup.visible = false;
  scene.add(designShadePreviewGroup);
  const designWindPreviewGroup = new THREE.Group();
  designWindPreviewGroup.name = 'design-live-wind-preview';
  designWindPreviewGroup.visible = false;
  scene.add(designWindPreviewGroup);
  const designSunlightImpactGroup = new THREE.Group();
  designSunlightImpactGroup.name = 'design-sunlight-impact';
  designSunlightImpactGroup.visible = false;
  scene.add(designSunlightImpactGroup);
  let designSunlightImpactSummary = '';
  let designProposalGeometry = null;
  let designSunlightCompareRevision = 0;
  let designSunlightAnalysisId = null;
  let designHeatCompareRevision = 0;
  function clearDesignSunlightImpact() {
    while (designSunlightImpactGroup.children.length) {
      const child = designSunlightImpactGroup.children[0];
      designSunlightImpactGroup.remove(child);
      disposeObject(child);
    }
    designSunlightImpactGroup.visible = false;
    designSunlightImpactSummary = '';
    syncDesignImpactLegend();
  }
  function showDesignSunlightImpact(payload) {
    clearDesignSunlightImpact();
    const grid = payload?.ground?.grid;
    if (!grid || !Array.isArray(grid.before) || !Array.isArray(grid.after)) return;
    const positions = [], colors = [], indices = [];
    const resolution = Number(payload.ground.resolution_m) || 20;
    let maxChange = 0;
    for (let index = 0; index < grid.before.length; index += 1) {
      if (Number.isFinite(grid.before[index]) && Number.isFinite(grid.after[index])) {
        maxChange = Math.max(maxChange, Math.abs(grid.after[index] - grid.before[index]));
      }
    }
    const limit = Math.max(0.15, maxChange);
    const lessSun = new THREE.Color(0x31b7d2), moreSun = new THREE.Color(0xffa34d);
    for (let row = 0; row < grid.rows; row += 1) {
      for (let column = 0; column < grid.columns; column += 1) {
        const index = row * grid.columns + column;
        const before = grid.before[index], after = grid.after[index];
        if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
        const delta = after - before;
        if (Math.abs(delta) < 0.04) continue;
        const x0 = grid.origin_x + column * resolution - resolution * 0.5;
        const z0 = grid.origin_z + row * resolution - resolution * 0.5;
        const x1 = x0 + resolution, z1 = z0 + resolution;
        const offset = positions.length / 3;
        for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
          positions.push(x, terrainSurfaceHeightAt(x, z) + 0.28, z);
        }
        const color = lessSun.clone().lerp(moreSun, delta > 0 ? 1 : 0);
        color.multiplyScalar(0.55 + 0.45 * Math.min(1, Math.abs(delta) / limit));
        for (let corner = 0; corner < 4; corner += 1) colors.push(color.r, color.g, color.b);
        indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
      }
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.68, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.name = 'design-sunlight-ground-change';
    mesh.renderOrder = 5;
    designSunlightImpactGroup.add(mesh);
    designSunlightImpactGroup.visible = true;
    const local = payload.ground.local_impact || {};
    const change = Number(local.change_mean_sun_hours || 0);
    designSunlightImpactSummary = `${change > 0 ? '+' : ''}${change.toFixed(1)} h nearby`;
    syncDesignImpactLegend();
  }
  addEventListener('climate-design-sunlight-result', event => showDesignSunlightImpact(event.detail));
  addEventListener('climate-design-geometry-change', event => {
    designProposalGeometry = event.detail || null;
    designSunlightCompareRevision += 1;
    if (designSunlightAnalysisId) {
      const analysisId = designSunlightAnalysisId;
      designSunlightAnalysisId = null;
      fetch(`${windApi}/sunlight/cancel?${new URLSearchParams({ analysis_id: analysisId })}`, { method: 'POST' }).catch(() => {});
    }
    clearDesignSunlightImpact();
    const button = document.querySelector('#design-sunlight-compare');
    const status = document.querySelector('#design-sunlight-status');
    const heatButton = document.querySelector('#design-heat-compare');
    const heatStatus = document.querySelector('#design-heat-status');
    const hasProposal = Boolean(designProposalGeometry?.add_buildings?.length || designProposalGeometry?.remove_building_indexes?.length);
    if (button) button.disabled = !hasProposal;
    designHeatCompareRevision += 1;
    if (heatButton) heatButton.disabled = !hasProposal;
    if (status) status.textContent = hasProposal
      ? 'Proposal changed. Compare direct sunlight for the current geometry and selected Sun date/window.'
      : 'Edit a building or add/remove a block to enable a matched sunlight comparison.';
    if (heatStatus) heatStatus.textContent = hasProposal
      ? 'Proposal changed. Recalculate the matched heat/shade screen for the current geometry and selected Heat date/time.'
      : 'Edit a building or add/remove a block to enable matched heat/shade screening.';
  });
  function syncDesignImpactLegend() {
    const legend = document.querySelector('#design-impact-legend');
    if (!legend) return;
    const hasProposal = designMassingBlocks.length > 0 || designRemovedBuildingIndexes.size > 0;
    const isWind = designWindPreviewGroup.visible;
    const isSunlight = designSunlightImpactGroup.visible;
    legend.querySelector('b').textContent = isSunlight ? `Sunlight impact · ${designSunlightImpactSummary}` : 'Live design impact';
    legend.querySelector('#design-impact-added-label').textContent = isSunlight
      ? 'More direct sun' : isWind ? 'Added wind wake · slower flow' : 'Added shade · cooling potential';
    legend.querySelector('#design-impact-removed-label').textContent = isSunlight
      ? 'Less direct sun' : isWind ? 'Wake removed · faster flow' : 'Shade removed · warming potential';
    legend.hidden = !hasProposal || !(designShadePreviewGroup.visible || designWindPreviewGroup.visible || isSunlight);
    legend.classList.toggle('design-impact-sunlight', isSunlight);
  }
  function makeGroundPreviewGeometry(outline, lift) {
    const contour = outline.map(([x, z]) => new THREE.Vector2(x, -z));
    const positions = [];
    for (const face of THREE.ShapeUtils.triangulateShape(contour, [])) {
      for (const index of face) {
        const [x, z] = outline[index];
        positions.push(x, terrainSurfaceHeightAt(x, z) + lift, z);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  }
  function updateDesignWindPreview() {
    for (const child of designWindPreviewGroup.children) { child.geometry?.dispose(); child.material?.dispose(); }
    designWindPreviewGroup.clear();
    if (!windToggle?.checked || !designWindBaseline || (!designMassingBlocks.length && !designRemovedBuildingIndexes.size)) {
      designWindPreviewGroup.visible = false;
      syncDesignImpactLegend();
      return;
    }
    const field = designWindBaseline.field || designWindBaseline;
    const direction = Number(field.direction_deg) || 0;
    const axis = Array.isArray(field.basis_xz) ? field.basis_xz : [-Math.sin(direction * Math.PI / 180), Math.cos(direction * Math.PI / 180)];
    const cross = Array.isArray(field.basis_z) ? field.basis_z : [-axis[1], axis[0]];
    const addWake = (ring, height, color) => {
      if (ring.length < 3) return;
      const centerX = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
      const centerZ = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
      const flow = ring.map(([x, z]) => (x - centerX) * axis[0] + (z - centerZ) * axis[1]);
      const side = ring.map(([x, z]) => (x - centerX) * cross[0] + (z - centerZ) * cross[1]);
      height = Math.max(3, Number(height) || 12);
      const halfWidth = Math.max(4, (Math.max(...side) - Math.min(...side)) / 2);
      const start = Math.max(...flow), length = Math.max(45, height * 6), endWidth = halfWidth + length * 0.16;
      const world = (distance, lateral) => [centerX + distance * axis[0] + lateral * cross[0], centerZ + distance * axis[1] + lateral * cross[1]];
      const points = [world(start, -halfWidth), world(start, halfWidth), world(start + length, endWidth), world(start + length, -endWidth)];
      const geometry = makeGroundPreviewGeometry(points, 0.82);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.62, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 80;
      mesh.userData.designWindPreview = true;
      designWindPreviewGroup.add(mesh);
    };
    for (const block of designMassingBlocks) {
      addWake(block.ring || [], block.height_m ?? block.height, 0x23b7d5);
    }
    for (const index of designRemovedBuildingIndexes) {
      const row = data.buildings[index];
      if (row) addWake(row[2] || [], row[1], 0xf07d48);
    }
    designWindPreviewGroup.visible = designWindPreviewGroup.children.length > 0;
    syncDesignImpactLegend();
  }
  function updateDesignShadePreview() {
    for (const child of designShadePreviewGroup.children) {
      child.geometry?.dispose(); child.material?.dispose();
    }
    designShadePreviewGroup.clear();
    let sunDate = shadowState.date, sunMinutes = shadowState.minutes;
    if (heatToggle?.checked) {
      if (heatPeriod?.value === 'climatology' && heatClimateMonth && heatClimateHour) {
        sunDate = `2026-${String(Number(heatClimateMonth.value) || 1).padStart(2, '0')}-15`;
        sunMinutes = (Number(heatClimateHour.value) || 12) * 60;
      } else if (heatPayload?.thermal) {
        const frame = selectedThermalFrame();
        if (frame?.valid_at) {
          const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          }).formatToParts(new Date(frame.valid_at)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
          sunDate = `${parts.year}-${parts.month}-${parts.day}`;
          sunMinutes = Number(parts.hour) * 60 + Number(parts.minute);
        }
      } else {
        sunDate = heatDate?.value || sunDate;
        if (heatTime?.value) sunMinutes = Number(heatTime.value);
        else if (Number.isFinite(Number(heatPayload?.scenario?.minutes))) sunMinutes = Number(heatPayload.scenario.minutes);
      }
    }
    const sun = sunPosition(sunDate, sunMinutes);
    if (!heatToggle?.checked || sun.altitude <= 0.02) {
      designShadePreviewGroup.visible = false;
      syncDesignImpactLegend();
      return;
    }
    const hull = points => {
      const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower = [], upper = [];
      for (const point of sorted) { while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point); }
      for (const point of sorted.reverse()) { while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point); }
      return lower.slice(0, -1).concat(upper.slice(0, -1));
    };
    const addShadow = (ring, height, color, opacity) => {
      if (ring.length < 3) return;
      height = Number(height) || 0;
      const dx = -sun.vector.x / Math.max(0.03, sun.vector.y) * height;
      const dz = -sun.vector.z / Math.max(0.03, sun.vector.y) * height;
      const outline = hull([...ring, ...ring.map(([x, z]) => [x + dx, z + dz])]);
      if (outline.length < 3) return;
      const geometry = makeGroundPreviewGeometry(outline, 0.82);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 80; mesh.userData.designShadePreview = true;
      designShadePreviewGroup.add(mesh);
    };
    for (const block of designMassingBlocks) {
      addShadow(block.ring || [], block.height_m ?? block.height, 0x36c5de, 0.54);
    }
    for (const index of designRemovedBuildingIndexes) {
      const row = data.buildings[index];
      if (row) addShadow(row[2] || [], row[1], 0xf07d48, 0.42);
    }
    designShadePreviewGroup.visible = designShadePreviewGroup.children.length > 0;
    syncDesignImpactLegend();
  }
  function makeBuildings() {
    const wallPositions = [];
    const wallTriangles = [];
    const roofPositions = [];
    const wallColors = [];
    const wallElevationColors = [];
    data.buildings.forEach(([ground, height, ring, , , wallHeight = height, detailedRoof = false, , , wallProfile = null, minHeight = 0, , , holes = []], buildingIndex) => {
      if (designRemovedBuildingIndexes.has(buildingIndex)) return;
      const osm = data.buildings[buildingIndex]?.[14] || {};
      const roofShape = String(osm['roof:shape'] || '').toLowerCase();
      const shapedRoof = ['gable', 'gabled', 'hip', 'hipped', 'pyramid', 'pyramidal'].includes(roofShape);
      let roofRise = Number.parseFloat(String(osm['roof:height'] || '').replace(/\s*m(?:et(?:er|re)s?)?$/i, ''));
      if (!Number.isFinite(roofRise) || roofRise <= 0) roofRise = 0;
      roofRise = Math.min(roofRise || (shapedRoof ? Math.min(3, height * 0.18) : 0), Math.max(0, height * 0.28));
      const baseY = ground + Math.max(0, Number(minHeight) || 0);
      const simpleWallHeight = Math.max(2.5, (roofSurfaceBuffer ? wallHeight : height) - roofRise);
      const roofY = ground + simpleWallHeight;
      const colour = elevationColour(height);
      // Keep mapped buildings neutral; analysis colours remain available only
      // through the existing elevation view.
      const facadeColour = new THREE.Color(COLORS.wall);
      for (const [ringIndex, wallRing] of [ring, ...holes].entries()) {
        for (let index = 0; index < wallRing.length; index += 1) {
          const next = (index + 1) % wallRing.length;
          const [x1, z1] = wallRing[index];
          const [x2, z2] = wallRing[next];
          const top1 = ground + (roofSurfaceBuffer && detailedRoof && ringIndex === 0 ? (wallProfile?.[index] ?? wallHeight) : simpleWallHeight);
          const top2 = ground + (roofSurfaceBuffer && detailedRoof && ringIndex === 0 ? (wallProfile?.[next] ?? wallHeight) : simpleWallHeight);
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
      // OSM footprints and mapped building parts define the mass. Mapped roof
      // shape tags add a restrained gable or hip above that OSM-derived mass.
      if (!detailedRoof || !roofSurfaceBuffer) {
        const triangulated = triangulateRings(ring, holes);
        const centre = ring.reduce((sum, point) => [sum[0] + point[0] / ring.length, sum[1] + point[1] / ring.length], [0, 0]);
        let ridgeNormal = null;
        if (shapedRoof && roofRise > 0) {
          const directions = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
          const mapped = String(osm['roof:direction'] || '').trim().toUpperCase();
          const bearing = Number.isFinite(Number(mapped)) && mapped !== '' ? Number(mapped) : directions[mapped];
          if (Number.isFinite(bearing)) {
            const radians = bearing * Math.PI / 180;
            ridgeNormal = [Math.sin(radians), Math.cos(radians)];
          } else {
            let xx = 0, xz = 0, zz = 0;
            for (const [x, z] of ring) {
              const dx = x - centre[0], dz = z - centre[1];
              xx += dx * dx; xz += dx * dz; zz += dz * dz;
            }
            const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
            ridgeNormal = [-Math.sin(angle), Math.cos(angle)];
          }
        }
        const maxProjection = ridgeNormal
          ? Math.max(0.01, ring.reduce((max, [x, z]) => Math.max(max, Math.abs((x - centre[0]) * ridgeNormal[0] + (z - centre[1]) * ridgeNormal[1])), 0))
          : 1;
        const maxAlongProjection = ridgeNormal
          ? Math.max(0.01, ring.reduce((max, [x, z]) => Math.max(max, Math.abs((x - centre[0]) * ridgeNormal[1] - (z - centre[1]) * ridgeNormal[0])), 0))
          : 1;
        for (const face of triangulated.faces) {
          const a = triangulated.vertices[face[0]];
          let b = triangulated.vertices[face[1]], c = triangulated.vertices[face[2]];
          const normalY = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
          if (normalY < 0) [b, c] = [c, b];
          const surfaceY = ([x, z]) => {
            if (!ridgeNormal || roofRise <= 0) return roofY;
            const projection = Math.abs((x - centre[0]) * ridgeNormal[0] + (z - centre[1]) * ridgeNormal[1]);
            const gable = Math.max(0, 1 - projection / maxProjection);
            const along = Math.max(0, 1 - Math.abs((x - centre[0]) * ridgeNormal[1] - (z - centre[1]) * ridgeNormal[0]) / maxAlongProjection);
            const factor = roofShape.startsWith('hip') || roofShape.startsWith('pyramid') ? Math.min(gable, along) : gable;
            return roofY + roofRise * factor;
          };
          roofPositions.push(a[0], surfaceY(a), a[1], b[0], surfaceY(b), b[1], c[0], surfaceY(c), c[1]);
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
    roofGeometry.computeVertexNormals();
    const wallMaterial = new THREE.MeshPhongMaterial({
      color: COLORS.wall, vertexColors: true, side: THREE.DoubleSide,
      specular: 0x343a3b, shininess: 20,
    });
    const roofMaterial = new THREE.MeshPhongMaterial({
      color: COLORS.roof, side: THREE.DoubleSide,
      specular: 0x3a3832, shininess: 15,
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
    detailedRoofHeightGrid.clear();
    const header = new DataView(roofSurfaceBuffer, 0, 8);
    const vertexCount = header.getUint32(0, true);
    const indexCount = header.getUint32(4, true);
    const positionOffset = 8;
    const heightOffset = positionOffset + vertexCount * 3 * 4;
    const indexOffset = heightOffset + vertexCount * 4;
    if (indexOffset + indexCount * 4 > roofSurfaceBuffer.byteLength) return null;

    const sourcePositions = new Float32Array(roofSurfaceBuffer, positionOffset, vertexCount * 3);
    const indices = new Uint32Array(roofSurfaceBuffer, indexOffset, indexCount);
    // Keep raw elevations for analysis and roof-mounted installations, while
    // making a separate, gently regularized copy for display. LiDAR-derived
    // meshes can contain isolated cell spikes that read as a crumpled roof at
    // city scale. Triangle-neighbour averaging follows each roof's topology,
    // so it cannot blur across gaps or between adjacent buildings.
    detailedRoofGeometrySource = { positions: sourcePositions, indices };
    const removedRoofRings = [...designRemovedBuildingIndexes].map(index => data.buildings[index]?.[2]).filter(ring => ring?.length >= 3);
    const visibleIndices = designRemovedBuildingIndexes.size ? [] : indices;
    if (designRemovedBuildingIndexes.size) {
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const x = (sourcePositions[a * 3] + sourcePositions[b * 3] + sourcePositions[c * 3]) / 3;
        const z = (sourcePositions[a * 3 + 2] + sourcePositions[b * 3 + 2] + sourcePositions[c * 3 + 2]) / 3;
        if (!removedRoofRings.some(ring => pointInRing(x, z, ring))) visibleIndices.push(a, b, c);
      }
    }
    const positions = new Float32Array(sourcePositions);
    const vertexCountFromHeader = positions.length / 3;
    const smoothRoofSurface = () => {
      const sums = new Float64Array(vertexCountFromHeader);
      const counts = new Uint16Array(vertexCountFromHeader);
      for (let pass = 0; pass < 2; pass += 1) {
        sums.fill(0);
        counts.fill(0);
        for (let index = 0; index < indices.length; index += 3) {
          const a = indices[index], b = indices[index + 1], c = indices[index + 2];
          const mean = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
          sums[a] += mean; sums[b] += mean; sums[c] += mean;
          counts[a] += 1; counts[b] += 1; counts[c] += 1;
        }
        for (let vertex = 0; vertex < vertexCountFromHeader; vertex += 1) {
          if (!counts[vertex]) continue;
          const offset = vertex * 3 + 1;
          const delta = (sums[vertex] / counts[vertex] - positions[offset]) * 0.58;
          positions[offset] += clamp(delta, -0.55, 0.55);
        }
      }
    };
    smoothRoofSurface();
    for (let index = 0; index < vertexCount; index += 1) {
      const x = sourcePositions[index * 3];
      const y = sourcePositions[index * 3 + 1];
      const z = sourcePositions[index * 3 + 2];
      if (removedRoofRings.some(ring => pointInRing(x, z, ring))) continue;
      const key = detailedRoofCellKey(Math.floor(x / detailedRoofHeightCellSize), Math.floor(z / detailedRoofHeightCellSize));
      if (!detailedRoofHeightGrid.has(key)) detailedRoofHeightGrid.set(key, []);
      detailedRoofHeightGrid.get(key).push([x, y, z]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const displayIndices = ArrayBuffer.isView(visibleIndices) ? visibleIndices : new Uint32Array(visibleIndices);
    geometry.setIndex(new THREE.BufferAttribute(displayIndices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshPhongMaterial({
      color: COLORS.roof, side: THREE.DoubleSide,
      specular: 0x3a3832, shininess: 15,
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

  function makeOsmDetails() {
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
    const uvs = [];
    const clipToTerrainTriangle = (subject, clip) => {
      const signedArea = clip.reduce((sum, point, index) => {
        const next = clip[(index + 1) % clip.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0);
      const orientation = Math.sign(signedArea) || 1;
      let output = subject;
      for (let edge = 0; edge < clip.length && output.length; edge += 1) {
        const a = clip[edge], b = clip[(edge + 1) % clip.length];
        const signedDistance = ([x, z]) => orientation * ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]));
        const input = output;
        output = [];
        for (let index = 0; index < input.length; index += 1) {
          const current = input[index], previous = input[(index + input.length - 1) % input.length];
          const currentDistance = signedDistance(current), previousDistance = signedDistance(previous);
          const currentInside = currentDistance >= -1e-7, previousInside = previousDistance >= -1e-7;
          if (currentInside !== previousInside) {
            const amount = previousDistance / (previousDistance - currentDistance);
            output.push([
              previous[0] + (current[0] - previous[0]) * amount,
              previous[1] + (current[1] - previous[1]) * amount,
            ]);
          }
          if (currentInside) output.push(current);
        }
      }
      return output;
    };
    const pushTerrainMatchedPolygon = polygon => {
      if (polygon.length < 3) return;
      const first = polygon[0];
      for (let index = 1; index < polygon.length - 1; index += 1) {
        const triangle = [first, polygon[index], polygon[index + 1]];
        const centerX = (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3;
        const centerZ = (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3;
        if (pointInMappedWater(centerX, centerZ) || !terrainValidAt(centerX, centerZ)) continue;
        for (const [x, z] of triangle) {
          positions.push(x, terrainSurfaceHeightAt(x, z) + SCENE_LAYERS.grass.lift, z);
          uvs.push(x / 12, z / 12);
        }
      }
    };
    for (const ring of data.grass || []) {
      for (const face of triangulateRing(ring)) {
        const subject = face.map(index => ring[index]);
        const minX = Math.min(...subject.map(([x]) => x));
        const maxX = Math.max(...subject.map(([x]) => x));
        const minZ = Math.min(...subject.map(([, z]) => z));
        const maxZ = Math.max(...subject.map(([, z]) => z));
        const firstColumn = clamp(Math.floor((minX - left) / terrainWidth * (terrain.columns - 1)), 0, terrain.columns - 2);
        const lastColumn = clamp(Math.floor((maxX - left) / terrainWidth * (terrain.columns - 1)), 0, terrain.columns - 2);
        const gridMinZ = -top;
        const rowStart = clamp(Math.floor((minZ - gridMinZ) / terrainDepth * (terrain.rows - 1)), 0, terrain.rows - 2);
        const rowEnd = clamp(Math.floor((maxZ - gridMinZ) / terrainDepth * (terrain.rows - 1)), 0, terrain.rows - 2);
        for (let row = rowStart; row <= rowEnd; row += 1) {
          for (let column = firstColumn; column <= lastColumn; column += 1) {
            const x0 = left + terrainWidth * column / (terrain.columns - 1);
            const x1 = left + terrainWidth * (column + 1) / (terrain.columns - 1);
            const z0 = gridMinZ + terrainDepth * row / (terrain.rows - 1);
            const z1 = gridMinZ + terrainDepth * (row + 1) / (terrain.rows - 1);
            const cellTriangles = [
              [[x0, z0], [x0, z1], [x1, z0]],
              [[x1, z0], [x0, z1], [x1, z1]],
            ];
            for (const terrainTriangle of cellTriangles) {
              pushTerrainMatchedPolygon(clipToTerrainTriangle(subject, terrainTriangle));
            }
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      color: 0xffffff, map: makeSurfaceTexture('grass'), side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    mesh.receiveShadow = true;
    setSceneLayer(mesh, 'grass');
    layerGroups.grass.add(mesh);
  }

  // Keep the pedestrian surface graph available to the later crossing pass.
  // Crossing records are loaded lazily, after the base streets are built.
  let pedestrianSurfaceRecords = [];

  function makeRoads() {
    const asphaltTexture = makeSurfaceTexture('asphalt');
    const stoneTexture = makeSurfaceTexture('stone');
    const brickTexture = makeSurfaceTexture('brick');
    const surfaceTextures = [
      asphaltTexture, asphaltTexture, asphaltTexture,
      stoneTexture, brickTexture, makeSurfaceTexture('gravel'),
      stoneTexture, makeSurfaceTexture('concrete'), brickTexture, makeSurfaceTexture('redPavers'),
    ];
    const positionsByStyle = [[], [], [], [], [], [], [], [], [], []];
    const major = new Set(['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link']);
    const secondary = new Set(['secondary', 'secondary_link', 'tertiary']);
    const paths = new Set(['footway', 'path', 'cycleway', 'steps', 'corridor', 'elevator', 'pedestrian']);
    const sidewalkRecords = [];
    const offsetPolyline = (points, offset) => points.map(([x, z], index) => {
      const previous = points[Math.max(0, index - 1)], next = points[Math.min(points.length - 1, index + 1)];
      const dx = next[0] - previous[0], dz = next[1] - previous[1];
      const length = Math.hypot(dx, dz) || 1;
      return [x - dz / length * offset, z + dx / length * offset];
    });
    const offsetSidewalkPolyline = (points, offset) => {
      const clean = points.filter(([x, z], index) => Number.isFinite(x) && Number.isFinite(z)
        && (!index || Math.hypot(x - points[index - 1][0], z - points[index - 1][1]) > 0.05));
      if (clean.length < 2 || Math.abs(offset) < 0.001) return clean.map(point => [...point]);
      const normals = clean.slice(0, -1).map((point, index) => {
        const next = clean[index + 1];
        const dx = next[0] - point[0], dz = next[1] - point[1];
        const length = Math.hypot(dx, dz) || 1;
        return [-dz / length, dx / length];
      });
      return clean.map(([x, z], index) => {
        if (index === 0) return [x + normals[0][0] * offset, z + normals[0][1] * offset];
        if (index === clean.length - 1) {
          const normal = normals[normals.length - 1];
          return [x + normal[0] * offset, z + normal[1] * offset];
        }
        const before = normals[index - 1], after = normals[index];
        let mx = before[0] + after[0], mz = before[1] + after[1];
        const magnitude = Math.hypot(mx, mz);
        if (magnitude < 0.05) return [x + after[0] * offset, z + after[1] * offset];
        mx /= magnitude; mz /= magnitude;
        const denominator = mx * after[0] + mz * after[1];
        if (denominator <= 0.1) return [x + after[0] * offset, z + after[1] * offset];
        const miter = Math.min(Math.abs(offset) / denominator, Math.abs(offset) * 2.5) * Math.sign(offset);
        return [x + mx * miter, z + mz * miter];
      });
    };
    const sidewalkSideEnabled = (general, taggedSide, side) => {
      if (taggedSide === 'separate' || taggedSide === 'no') return false;
      if (general === 'separate') return false;
      if (taggedSide === 'yes') return true;
      if (general === 'no') return false;
      if (taggedSide) return false;
      return ['yes', 'both'].includes(general) || general === side;
    };
    const inferredVerticalOffset = (attributes, highway) => {
      const explicit = Number(attributes?.inferredVerticalOffsetM);
      if (Number.isFinite(explicit)) return explicit;
      const layer = clamp(Number.parseInt(attributes?.layer || '0', 10) || 0, -5, 5);
      const bridge = attributes?.bridge && attributes.bridge !== 'no';
      const tunnel = attributes?.tunnel && attributes.tunnel !== 'no';
      if (bridge) {
        // Footbridges across small channels need only a modest clearance.
        // The generic 4.5 m road-overpass assumption left the castle crossing
        // visibly floating above its approaches.
        if (paths.has(highway) || highway === 'pedestrian') return Math.max(1.2, Math.max(layer, 1) * 1.2);
        return Math.max(4.5, Math.max(layer, 1) * 3);
      }
      if (tunnel) return -Math.max(3, Math.abs(Math.min(layer, -1)) * 3);
      return layer * 0.35;
    };
    for (const record of data.roads || []) {
      const [mappedWidth, highway, points] = record;
      // fallback.json stores attributes at index 3; the semantic adapter also
      // carries a source marker and stores them at index 4.
      const attributes = (record[4] && typeof record[4] === 'object')
        ? record[4] : ((record[3] && typeof record[3] === 'object') ? record[3] : {});
      const surface = String(attributes.renderSurface || attributes.surface || '').toLowerCase();
      const siteOverride = attributes.groundMaterialOverride;
      const unsealed = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'earth', 'ground', 'sand', 'compacted']);
      const pavedUnits = new Set(['paving_stones', 'sett', 'cobblestone', 'cobblestone:flattened', 'unhewn_cobblestone']);
      const brickSurfaces = new Set(['brick', 'bricks']);
      const baseStyle = siteOverride === 'red_pavers' || highway === 'pedestrian' ? 4 : paths.has(highway) ? 3 : major.has(highway) ? 1 : secondary.has(highway) ? 2 : 0;
      const taggedSurfaceStyle = unsealed.has(surface) ? 5
        : brickSurfaces.has(surface) ? 8
          : pavedUnits.has(surface) ? 6
            : surface === 'concrete' || surface === 'concrete:plates' ? 7
              : surface === 'asphalt' ? null : null;
      const siteSurfaceStyle = siteOverride === 'red_pavers' ? 9 : null;
      const mappedSurfaceStyle = surface === 'asphalt' ? baseStyle
        : surface === 'stone' ? 6 : surface === 'brick' || surface === 'bricks' ? 8
          : surface === 'gravel' ? 5 : surface === 'concrete' ? 7 : null;
      const styleIndex = siteSurfaceStyle ?? mappedSurfaceStyle ?? taggedSurfaceStyle ?? baseStyle;
      if (points.length > 1) {
        const verticalOffset = inferredVerticalOffset(attributes, highway);
        const renderWidth = Number(attributes.renderWidthM);
        const parkingAisle = attributes.service === 'parking_aisle';
        const roadRecord = {
          points,
          width: parkingAisle ? clamp(Number.isFinite(renderWidth) && renderWidth > 0 ? renderWidth : 3.1, 2.7, 3.5)
            : clamp(Number.isFinite(renderWidth) && renderWidth > 0 ? renderWidth : Number(mappedWidth) || 4, baseStyle >= 3 ? 0.8 : 2.5, 18),
          verticalOffset,
          // Parking service aisles run over mapped parking polygons. Keep
          // their asphalt ribbon slightly above those ground surfaces so it
          // remains visible through the ground layer at Riebeek Square.
          surfaceOffset: parkingAisle ? 0.50 : (ROAD_CLASS_OFFSETS[baseStyle] ?? ROAD_CLASS_OFFSETS[0]),
          highway,
          styleIndex,
          baseStyle,
          surface,
          attributes,
          // Paths < local streets < secondary streets < primary/trunk roads.
          // Keep this even when surface material changes the colour bucket.
          priority: parkingAisle ? 0 : baseStyle >= 3 ? 0 : baseStyle === 1 ? 3 : baseStyle === 2 ? 2 : 1,
        };
        positionsByStyle[styleIndex].push(roadRecord);
        if (baseStyle < 3) {
          const sidewalk = String(attributes.sidewalk || '').toLowerCase();
          const sidewalkWidthFor = value => {
            const parsed = Number.parseFloat(String(value ?? '').replace(/\s*m(?:et(?:er|re)s?)?$/i, ''));
            return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 1.1, 4.5) : 1.55;
          };
          for (const [side, tag, sign, tagWidth] of [
            ['left', attributes.sidewalkLeft ?? attributes['sidewalk:left'], -1,
              attributes.sidewalkLeftWidth ?? attributes['sidewalk:left:width'] ?? attributes.sidewalkWidth ?? attributes['sidewalk:width']],
            ['right', attributes.sidewalkRight ?? attributes['sidewalk:right'], 1,
              attributes.sidewalkRightWidth ?? attributes['sidewalk:right:width'] ?? attributes.sidewalkWidth ?? attributes['sidewalk:width']],
          ]) {
            if (!sidewalkSideEnabled(sidewalk, String(tag || '').toLowerCase(), side)) continue;
            const sidewalkWidth = sidewalkWidthFor(tagWidth);
            const separation = roadRecord.width * 0.5 + sidewalkWidth * 0.5 + 0.05;
            // The viewer flips northing into its Z axis, so OSM left and right
            // have the opposite sign to the renderer's 2D normal.
            const pointsOffset = offsetSidewalkPolyline(points, sign * separation);
            if (pointsOffset.length < 2) continue;
            sidewalkRecords.push({
              points: pointsOffset, width: sidewalkWidth,
              verticalOffset: verticalOffset + 0.02, priority: 0,
              // Route synthetic sidewalks through the footway painter layer;
              // missing road fields must not make them draw as asphalt.
              baseStyle: 3, styleIndex: 3,
              startNode: points[0], endNode: points[points.length - 1],
              centerOffset: separation, roadWidth: roadRecord.width,
              roadCenterline: points, sideSign: sign,
            });
          }
        }
      }
    }
    // At shared OSM road nodes, extend offset sidewalk ends to the miter
    // intersection of their curb lines. This closes corners without shifting
    // an entire sidewalk toward or over the carriageway.
    const sidewalkEndpointsByNode = new Map();
    sidewalkRecords.forEach((record, recordIndex) => {
      for (const end of ['start', 'end']) {
        const node = record[`${end}Node`];
        const grade = record.verticalOffset.toFixed(1);
        const key = `${node[0].toFixed(1)}:${node[1].toFixed(1)}:${grade}`;
        if (!sidewalkEndpointsByNode.has(key)) sidewalkEndpointsByNode.set(key, []);
        sidewalkEndpointsByNode.get(key).push({ recordIndex, end });
      }
    });
    for (const endpoints of sidewalkEndpointsByNode.values()) {
      if (endpoints.length < 2) continue;
      const candidates = [];
      for (let first = 0; first < endpoints.length; first += 1) {
        for (let second = first + 1; second < endpoints.length; second += 1) {
          const a = endpoints[first], b = endpoints[second];
          const recordA = sidewalkRecords[a.recordIndex], recordB = sidewalkRecords[b.recordIndex];
          if (a.recordIndex === b.recordIndex && a.end === b.end) continue;
          const lineA = recordA.points, lineB = recordB.points;
          const p = a.end === 'start' ? lineA[0] : lineA[lineA.length - 1];
          const q = b.end === 'start' ? lineB[0] : lineB[lineB.length - 1];
          const neighborA = a.end === 'start' ? lineA[1] : lineA[lineA.length - 2];
          const neighborB = b.end === 'start' ? lineB[1] : lineB[lineB.length - 2];
          const lengthA = Math.hypot(neighborA[0] - p[0], neighborA[1] - p[1]);
          const lengthB = Math.hypot(neighborB[0] - q[0], neighborB[1] - q[1]);
          if (lengthA < 0.1 || lengthB < 0.1) continue;
          const r = [(neighborA[0] - p[0]) / lengthA, (neighborA[1] - p[1]) / lengthA];
          const s = [(neighborB[0] - q[0]) / lengthB, (neighborB[1] - q[1]) / lengthB];
          const denominator = r[0] * s[1] - r[1] * s[0];
          if (Math.abs(denominator) < 0.20) continue;
          const qp = [q[0] - p[0], q[1] - p[1]];
          const distanceA = (qp[0] * s[1] - qp[1] * s[0]) / denominator;
          const distanceB = (qp[0] * r[1] - qp[1] * r[0]) / denominator;
          const maximum = Math.min(12, recordA.centerOffset + recordB.centerOffset);
          if (distanceA >= -0.02 || distanceB >= -0.02
            || Math.abs(distanceA) > maximum || Math.abs(distanceB) > maximum) continue;
          const intersection = [p[0] + r[0] * distanceA, p[1] + r[1] * distanceA];
          candidates.push({ a, b, intersection, score: Math.abs(distanceA) + Math.abs(distanceB) });
        }
      }
      candidates.sort((a, b) => a.score - b.score);
      const joined = new Set();
      for (const candidate of candidates) {
        const keyA = `${candidate.a.recordIndex}:${candidate.a.end}`;
        const keyB = `${candidate.b.recordIndex}:${candidate.b.end}`;
        if (joined.has(keyA) || joined.has(keyB)) continue;
        const recordA = sidewalkRecords[candidate.a.recordIndex];
        const recordB = sidewalkRecords[candidate.b.recordIndex];
        if (candidate.a.end === 'start') recordA.points[0] = candidate.intersection;
        else recordA.points[recordA.points.length - 1] = candidate.intersection;
        if (candidate.b.end === 'start') recordB.points[0] = candidate.intersection;
        else recordB.points[recordB.points.length - 1] = candidate.intersection;
        (recordA.joinedEnds ||= new Set()).add(candidate.a.end);
        (recordB.joinedEnds ||= new Set()).add(candidate.b.end);
        joined.add(keyA);
        joined.add(keyB);
      }
    }

    const mappedPedestrianRecords = positionsByStyle.flat().filter(record => (
      record.baseStyle >= 3 && record.points?.length > 1
    ));
    const closestPointOnRecords = (point, records, maxDistance, grade, options = {}) => {
      let best = null;
      const maximumSquared = maxDistance * maxDistance;
      const tangent = options.tangent || null;
      for (const candidate of records) {
        if (candidate === options.exclude || Math.abs((candidate.verticalOffset || 0) - grade) > 0.75) continue;
        const points = candidate.points;
        for (let index = 0; index < points.length - 1; index += 1) {
          const a = points[index], b = points[index + 1];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const lengthSquared = dx * dx + dz * dz;
          if (lengthSquared < 0.01) continue;
          if (tangent) {
            const alignment = Math.abs((dx * tangent[0] + dz * tangent[1]) / Math.sqrt(lengthSquared));
            if (alignment < (options.minimumAlignment ?? 0)) continue;
          }
          const amount = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared, 0, 1);
          const x = a[0] + dx * amount, z = a[1] + dz * amount;
          const distanceSquared = (point[0] - x) ** 2 + (point[1] - z) ** 2;
          if (distanceSquared > maximumSquared || (best && distanceSquared >= best.distanceSquared)) continue;
          best = {
            point: [x, z], distanceSquared, distance: Math.sqrt(distanceSquared),
            record: candidate, segmentIndex: index,
          };
        }
      }
      return best;
    };

    // Attach synthetic sidewalk ends to mapped pedestrian ways when they stop
    // close to one. Then attach the ends of mapped footways to those sidewalks
    // where their actual OSM geometry meets the street edge. This preserves
    // the mapped path alignment and closes small digitising gaps without
    // inventing long links across a carriageway or between different levels.
    for (const record of sidewalkRecords) {
      for (const end of ['start', 'end']) {
        if (record.joinedEnds?.has(end)) continue;
        const point = end === 'start' ? record.points[0] : record.points[record.points.length - 1];
        const connected = closestPointOnRecords(point, mappedPedestrianRecords, 3.4, record.verticalOffset);
        if (!connected) continue;
        const centreline = record.roadCenterline;
        const centre = record[`${end}Node`];
        const neighbor = end === 'start' ? centreline[1] : centreline[centreline.length - 2];
        const dx = neighbor[0] - centre[0], dz = neighbor[1] - centre[1];
        const length = Math.hypot(dx, dz) || 1;
        const lateral = ((connected.point[0] - centre[0]) * (-dz / length)
          + (connected.point[1] - centre[1]) * (dx / length)) * record.sideSign;
        // A nearby path across a narrow street is not a sidewalk connection.
        // Keep the snap outside the carriageway edge on the tagged side.
        if (lateral < record.roadWidth * 0.5 - 0.65) continue;
        if (end === 'start') record.points[0] = connected.point;
        else record.points[record.points.length - 1] = connected.point;
        (record.joinedEnds ||= new Set()).add(end);
      }
    }
    for (const record of mappedPedestrianRecords) {
      for (const end of ['start', 'end']) {
        const point = end === 'start' ? record.points[0] : record.points[record.points.length - 1];
        const maximumGap = clamp(record.width * 0.5 + 1.15, 1.9, 3.4);
        const connected = closestPointOnRecords(point, sidewalkRecords, maximumGap, record.verticalOffset);
        if (!connected) continue;
        if (end === 'start') record.points[0] = connected.point;
        else record.points[record.points.length - 1] = connected.point;
      }
    }
    pedestrianSurfaceRecords = [...mappedPedestrianRecords, ...sidewalkRecords];
    positionsByStyle[3].push(...sidewalkRecords);
    const colors = [COLORS.road, COLORS.roadMajor, COLORS.roadSecondary, COLORS.path, COLORS.pedestrian, 0x80796b, 0x9b8e79, 0x99958b, 0xa67866, 0xa66f5c];
    // Higher-priority carriageways sit a few centimetres above lower classes
    // at overlaps. Footways remain contextual and below carriageways so they
    // cannot slice a visible road into disconnected pieces at junctions.
    const buildRibbon = (roads, styleIndex, priority, gradeSeparated) => {
      const vertices = [];
      const uvs = [];
      const indices = [];
      const pushVertex = (x, z, elevationOffset, surfaceY = roadSurfaceHeightAt(x, z)) => {
        const index = vertices.length / 3;
        vertices.push(x, surfaceY + elevationOffset, z);
        const repeatMetres = styleIndex === 9 ? 18 : styleIndex === 4 || styleIndex === 6 || styleIndex === 8 ? 6 : styleIndex === 3 ? 8 : styleIndex === 5 ? 7 : 12;
        uvs.push(x / repeatMetres, z / repeatMetres);
        return index;
      };
      const addDisc = (x, z, radius, elevationOffset) => {
        const surfaceY = roadSurfaceHeightAt(x, z);
        const center = pushVertex(x, z, elevationOffset, surfaceY);
        const segments = 12;
        for (let segment = 0; segment < segments; segment += 1) {
          const angle = segment / segments * Math.PI * 2;
          const edgeX = x + Math.cos(angle) * radius;
          const edgeZ = z + Math.sin(angle) * radius;
          pushVertex(edgeX, edgeZ, elevationOffset, Math.max(roadSurfaceHeightAt(edgeX, edgeZ), surfaceY - 0.08));
        }
        for (let segment = 0; segment < segments; segment += 1) {
          indices.push(center, center + 1 + segment, center + 1 + ((segment + 1) % segments));
        }
      };
      for (const road of roads) {
        const halfWidth = road.width * 0.5;
        const elevationOffset = (road.surfaceOffset ?? ROAD_CLASS_OFFSETS[styleIndex] ?? 0.26)
          + (road.verticalOffset || 0);
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
            const startY = roadSurfaceHeightAt(sx, sz);
            const endY = roadSurfaceHeightAt(ex, ez);
            const aX = sx + nx, aZ = sz + nz;
            const bX = sx - nx, bZ = sz - nz;
            const cX = ex + nx, cZ = ez + nz;
            const dX = ex - nx, dZ = ez - nz;
            const a = pushVertex(aX, aZ, elevationOffset, Math.max(roadSurfaceHeightAt(aX, aZ), startY - 0.08));
            const b = pushVertex(bX, bZ, elevationOffset, Math.max(roadSurfaceHeightAt(bX, bZ), startY - 0.08));
            const c = pushVertex(cX, cZ, elevationOffset, Math.max(roadSurfaceHeightAt(cX, cZ), endY - 0.08));
            const d = pushVertex(dX, dZ, elevationOffset, Math.max(roadSurfaceHeightAt(dX, dZ), endY - 0.08));
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
      const material = new THREE.MeshStandardMaterial({
        color: colors[styleIndex],
        map: surfaceTextures[styleIndex],
        roughness: 0.94,
        metalness: 0,
        transparent: false,
        opacity: 1,
        // At-grade road classes use the explicit painter hierarchy and do not
        // mask one another. Bridges keep depth writes so their real elevation
        // still wins over any higher-priority street passing underneath.
        depthWrite: gradeSeparated,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // Keep street paint above carriageways while preserving the local
      // hierarchy among road classes at junctions.
      const parkingAisleLayer = roads.some(road => road.attributes?.service === 'parking_aisle');
      const sceneLayer = roads.every(road => road.baseStyle >= 3) ? 'path' : 'road';
      setSceneLayer(mesh, sceneLayer, (parkingAisleLayer ? 0.08 : priority * SCENE_LAYERS.roadPriorityStep));
      mesh.receiveShadow = true;
      if (styleIndex === 9) pavementOverrideMeshes.push(mesh);
      return mesh;
    };
    positionsByStyle.forEach((roads, index) => {
      if (!roads.length) return;
      for (const pedestrianLayer of [true, false]) {
        const surfaceGroup = roads.filter(road => (road.baseStyle >= 3) === pedestrianLayer);
        if (!surfaceGroup.length) continue;
        const target = pedestrianLayer ? layerGroups.paths : layerGroups.roads;
        for (let priority = 0; priority <= 3; priority += 1) {
          const tier = surfaceGroup.filter(road => road.priority === priority);
          for (const gradeSeparated of [false, true]) {
            const grade = tier.filter(road => (Math.abs(road.verticalOffset || 0) > 1) === gradeSeparated);
            if (!grade.length) continue;
            target.add(buildRibbon(grade, index, priority, gradeSeparated));
          }
        }
      }
    });

    // Build a proper timber pedestrian drawbridge where the mapped footpath
    // actually crosses the Castle moat. The roadway ribbon remains the path
    // surface; the close-set planks, stringers, abutments and open rails give
    // its elevation a visible structural explanation.
    const castleRings = (data.buildings || [])
      .filter(building => building[14]?.['building:part'] === 'castle' || building[14]?.building === 'castle')
      .map(building => building[2]).filter(ring => ring?.length);
    if (castleRings.length) {
      const allCastlePoints = castleRings.flat();
      const castleBounds = [
        Math.min(...allCastlePoints.map(point => point[0])) - 90,
        Math.min(...allCastlePoints.map(point => point[1])) - 90,
        Math.max(...allCastlePoints.map(point => point[0])) + 90,
        Math.max(...allCastlePoints.map(point => point[1])) + 90,
      ];
      const details = [];
      const planks = [];
      for (const road of positionsByStyle.flat()) {
        if (!road.attributes?.bridge || road.attributes.bridge === 'no' || road.points.length < 2) continue;
        const nearby = road.points.some(([x, z]) => x >= castleBounds[0] && x <= castleBounds[2] && z >= castleBounds[1] && z <= castleBounds[3]);
        if (!nearby || road.width > 9) continue;
        for (let segment = 0; segment < road.points.length - 1; segment += 1) {
          const [x1, z1] = road.points[segment], [x2, z2] = road.points[segment + 1];
          const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz);
          if (length < 2 || length > 20) continue;
          const middleX = (x1 + x2) * 0.5, middleZ = (z1 + z2) * 0.5;
          if (!pointInMappedWater(middleX, middleZ) && !pointNearMappedWaterBoundary(middleX, middleZ, 2.5)) continue;
          const angle = Math.atan2(-dz, dx);
          const half = road.width * 0.5;
          const topAt = (x, z) => roadSurfaceHeightAt(x, z) + road.surfaceOffset + road.verticalOffset;
          const top1 = topAt(x1, z1), top2 = topAt(x2, z2);
          const centerTop = (top1 + top2) * 0.5;
          const centerX = middleX, centerZ = middleZ;

          // A shallow continuous deck hides the paved ribbon's exposed edges.
          details.push({ x: centerX, z: centerZ, y: centerTop - 0.09, angle, length: length + 0.16, width: road.width + 0.28, height: 0.24, color: 0x5b4b3a });
          // Two longitudinal beams carry the deck. No centre pier is added to
          // this short drawbridge; it should span cleanly from bank to bank.
          for (const side of [-1, 1]) {
            const beamOffset = Math.max(0.12, half - 0.22) * side;
            details.push({
              x: centerX - dz / length * beamOffset,
              z: centerZ + dx / length * beamOffset,
              y: centerTop - 0.24, angle, length: length + 0.26, width: 0.18, height: 0.28, color: 0x493c30,
            });
            const railOffset = half + 0.08;
            const railX = centerX - dz / length * railOffset * side;
            const railZ = centerZ + dx / length * railOffset * side;
            const postCount = Math.max(2, Math.ceil(length / 1.15));
            for (let post = 0; post <= postCount; post += 1) {
              const t = post / postCount;
              const x = x1 + dx * t - dz / length * railOffset * side;
              const z = z1 + dz * t + dx / length * railOffset * side;
              const y = topAt(x1 + dx * t, z1 + dz * t);
              details.push({ x, z, y: y + 0.34, angle, length: 0.16, width: 0.16, height: 0.68, color: 0x735c41 });
            }
            // Open, narrow handrails read as a pedestrian bridge rather than
            // the solid raised curb that the earlier side beams resembled.
            for (const [height, railHeight] of [[0.42, 0.1], [0.76, 0.14]]) {
              details.push({ x: railX, z: railZ, y: centerTop + height, angle, length: length + 0.1, width: 0.12, height: railHeight, color: 0x826b4e });
            }
          }
          // Stone bearing blocks meet the banks at both ends of the timber span.
          for (const [x, z, top] of [[x1, z1, top1], [x2, z2, top2]]) {
            const base = Math.min(terrainSurfaceHeightAt(x, z), top - 0.42);
            const bearingTop = top + 0.03;
            details.push({
              x, z, y: (base + bearingTop) * 0.5, angle,
              length: 0.58, width: road.width + 0.55, height: bearingTop - base, color: 0x77766f,
            });
          }

          // Individual crosswise planks leave only narrow joints, so the deck
          // reads continuously as timber instead of a road with a few marks.
          const boardCount = Math.max(2, Math.ceil(length / 0.28));
          const plankColors = [0x755d43, 0x80674a, 0x6b543d];
          for (let board = 0; board < boardCount; board += 1) {
            const t = (board + 0.5) / boardCount;
            const x = x1 + dx * t, z = z1 + dz * t;
            planks.push({
              x, z, y: topAt(x, z) + 0.1,
              angle, length: length / boardCount * 0.88, width: Math.max(1.4, road.width - 0.12), height: 0.14,
              color: plankColors[board % plankColors.length],
            });
          }
        }
      }
      const addBridgeParts = (parts, name) => {
        if (!parts.length) return;
        const group = new THREE.Group();
        for (const part of parts) {
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(part.length, part.height, part.width),
            new THREE.MeshLambertMaterial({ color: part.color }),
          );
          mesh.position.set(part.x, part.y, part.z);
          mesh.rotation.y = part.angle;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        }
        group.userData[name] = true;
        layerGroups.paths.add(group);
      };
      addBridgeParts(details, 'castleBridgeStructure');
      addBridgeParts(planks, 'castleDrawbridgeDeck');
    }

    // OSM has no explicit crossing or stop-line features in this city extract,
    // but connected road vertices are available. Use those shared nodes to let
    // lane dashes breathe at real junctions without inventing zebra crossings
    // or traffic-control markings.
    const roadVertices = new Map();
    const roadVertexKey = (x, z) => `${Math.round(x / 2)}:${Math.round(z / 2)}`;
    for (const road of positionsByStyle.flat()) {
      if (road.baseStyle > 2 || road.styleIndex > 2) continue;
      let distance = 0;
      for (let index = 0; index < road.points.length; index += 1) {
        const point = road.points[index];
        if (index) distance += Math.hypot(point[0] - road.points[index - 1][0], point[1] - road.points[index - 1][1]);
        const key = roadVertexKey(point[0], point[1]);
        const entries = roadVertices.get(key) || [];
        entries.push({ road, distance });
        roadVertices.set(key, entries);
      }
    }
    ambientParkingAisles = positionsByStyle.flat().filter(road => road.attributes?.service === 'parking_aisle' && road.points?.length > 1);
    ambientTrafficRoads = positionsByStyle.flat().filter(road => road.baseStyle < 3
      && road.attributes?.service !== 'parking_aisle' && road.points?.length > 1);
    for (const entries of roadVertices.values()) {
      for (const entry of entries) {
        const joinsAnotherAtGrade = entries.some(other => other.road !== entry.road
          && Math.abs((other.road.verticalOffset || 0) - (entry.road.verticalOffset || 0)) < 1);
        if (!joinsAnotherAtGrade) continue;
        const cuts = entry.road.junctionDistances || (entry.road.junctionDistances = []);
        if (!cuts.some(distance => Math.abs(distance - entry.distance) < 1)) cuts.push(entry.distance);
      }
    }

    const roadPaint = { white: [], yellow: [] };
    const paintIndices = { white: [], yellow: [] };
    const appendRoadQuad = (targetVertices, targetIndices, road, start, end, width, extraHeight) => {
      const dx = end[0] - start[0];
      const dz = end[1] - start[1];
      const length = Math.hypot(dx, dz);
      if (length < 0.04) return;
      const nx = -dz / length * width * 0.5;
      const nz = dx / length * width * 0.5;
      const corners = [
        [start[0] + nx, start[1] + nz], [start[0] - nx, start[1] - nz],
        [end[0] + nx, end[1] + nz], [end[0] - nx, end[1] - nz],
      ];
      const first = targetVertices.length / 3;
      for (const [x, z] of corners) {
        targetVertices.push(x, roadSurfaceHeightAt(x, z) + road.surfaceOffset + (road.verticalOffset || 0) + extraHeight, z);
      }
      targetIndices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
    };
    const cleanLine = points => points.filter(([x, z], index, source) => (
      Number.isFinite(x) && Number.isFinite(z)
      && (!index || Math.hypot(x - source[index - 1][0], z - source[index - 1][1]) > 0.05)
    ));
    const appendDashedRoadLine = (road, points, lateralOffset, colorBucket, dashLength = 3.2, gapLength = 4.8) => {
      const line = offsetPolyline(points, lateralOffset);
      const cycleLength = dashLength + gapLength;
      let travelled = 0;
      for (let index = 0; index < line.length - 1; index += 1) {
        const start = line[index], end = line[index + 1];
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (length < 0.05) continue;
        let cursor = 0;
        while (cursor < length - 0.001) {
          const phase = (travelled + cursor) % cycleLength;
          const inDash = phase < dashLength;
          const remaining = inDash ? dashLength - phase : cycleLength - phase;
          const step = Math.min(length - cursor, Math.max(0.025, remaining));
          const dashCenter = travelled + cursor + step * 0.5;
          const atJunction = road.junctionDistances?.some(distance => Math.abs(distance - dashCenter) < 4.5);
          if (inDash && !atJunction) {
            const amountA = cursor / length;
            const amountB = (cursor + step) / length;
            appendRoadQuad(
              roadPaint[colorBucket], paintIndices[colorBucket], road,
              [start[0] + (end[0] - start[0]) * amountA, start[1] + (end[1] - start[1]) * amountA],
              [start[0] + (end[0] - start[0]) * amountB, start[1] + (end[1] - start[1]) * amountB],
              0.11, 0.075,
            );
          }
          cursor += step;
        }
        travelled += length;
      }
    };
    for (const road of positionsByStyle.flat()) {
      // Offset sidewalk records share the road layer list but intentionally
      // have no carriageway style fields. They must not enter lane-marking
      // generation, which expects a mapped vehicle-road surface offset.
      if (!Number.isFinite(road.baseStyle) || !Number.isFinite(road.styleIndex)
        || road.baseStyle > 2 || road.styleIndex > 2 || !road.points?.length) continue;
      const points = cleanLine(road.points);
      if (points.length < 2) continue;
      const oneway = ['yes', '1', 'true', '-1'].includes(String(road.attributes?.oneway || '').toLowerCase());
      const taggedLanes = Number.parseInt(road.attributes?.lanes, 10);
      const laneCount = clamp(Number.isFinite(taggedLanes) && taggedLanes > 0
        ? taggedLanes : road.width >= 8 ? 2 : 1, 1, 6);
      if (laneCount > 1 && !oneway) appendDashedRoadLine(road, points, 0, 'yellow');
      const laneWidth = road.width / laneCount;
      for (let divider = 1; divider < laneCount; divider += 1) {
        const lateralOffset = -road.width * 0.5 + laneWidth * divider;
        if (!oneway && Math.abs(lateralOffset) < 0.35) continue;
        appendDashedRoadLine(road, points, lateralOffset, 'white', 2.8, 5.2);
      }


    }
    const addRoadDetailMesh = (vertices, indices, material, name, nearDistance, farDistance) => {
      if (!indices.length) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.renderOrder = 6;
      mesh.userData.detailFade = { nearDistance, farDistance, opacity: material.opacity };
      mesh.material.transparent = true;
      mesh.material.depthWrite = false;
      mesh.material.polygonOffset = true;
      mesh.material.polygonOffsetFactor = -8;
      mesh.material.polygonOffsetUnits = -8;
      layerGroups.roads.add(mesh);
      return mesh;
    };
    addRoadDetailMesh(
      roadPaint.white, paintIndices.white,
      new THREE.MeshBasicMaterial({ color: 0xd5d4c5, opacity: 0.84, side: THREE.DoubleSide }),
      'faded-white lane paint', 650, 1850,
    );
    addRoadDetailMesh(
      roadPaint.yellow, paintIndices.yellow,
      new THREE.MeshBasicMaterial({ color: 0xc7ae61, opacity: 0.88, side: THREE.DoubleSide }),
      'faded-yellow centre lines', 650, 1850,
    );
  }

  function makeRailways() {
    const ballastGroup = new THREE.Group();
    const sleepersGroup = new THREE.Group();
    const railsGroup = new THREE.Group();
    const overviewRailsGroup = new THREE.Group();
    const catenaryGroup = new THREE.Group();
    const overheadWiresGroup = new THREE.Group();
    ballastGroup.userData.maxDistance = 950;
    sleepersGroup.userData.maxDistance = 1550;
    railsGroup.userData.maxDistance = 1700;
    overviewRailsGroup.userData.minDistance = 1700;
    overheadWiresGroup.userData.maxDistance = 2400;
    catenaryGroup.userData.maxDistance = 3600;
    layerGroups.railways.add(ballastGroup, sleepersGroup, railsGroup, overviewRailsGroup, catenaryGroup, overheadWiresGroup);

    const ballastCanvas = document.createElement('canvas');
    ballastCanvas.width = ballastCanvas.height = 192;
    const ballastContext = ballastCanvas.getContext('2d');
    const ballastPalette = ['#77766f', '#8a8579', '#625f59', '#9a9284', '#6e716c', '#817b70'];
    ballastContext.fillStyle = '#77746b';
    ballastContext.fillRect(0, 0, 192, 192);
    let ballastSeed = 29;
    const ballastRandom = () => {
      ballastSeed = (ballastSeed * 1664525 + 1013904223) >>> 0;
      return ballastSeed / 4294967296;
    };
    for (let pebble = 0; pebble < 3200; pebble += 1) {
      const x = ballastRandom() * 192, y = ballastRandom() * 192;
      const rx = 0.5 + ballastRandom() * 2.3, ry = 0.5 + ballastRandom() * 1.7;
      ballastContext.fillStyle = ballastPalette[Math.floor(ballastRandom() * ballastPalette.length)];
      ballastContext.beginPath();
      ballastContext.ellipse(x, y, rx, ry, ballastRandom() * Math.PI, 0, Math.PI * 2);
      ballastContext.fill();
    }
    const ballastTexture = new THREE.CanvasTexture(ballastCanvas);
    ballastTexture.wrapS = ballastTexture.wrapT = THREE.RepeatWrapping;
    ballastTexture.colorSpace = THREE.SRGBColorSpace;
    ballastTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const ballastMaterial = new THREE.MeshStandardMaterial({
      color: 0xe1ded4, map: ballastTexture, roughness: 1, metalness: 0,
      side: THREE.DoubleSide,
    });
    const sleeperMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94 });
    const railMaterial = new THREE.MeshPhongMaterial({
      color: 0xaeb5b3, specular: 0x737b7b, shininess: 72, side: THREE.DoubleSide,
    });
    const mastMaterial = new THREE.MeshStandardMaterial({ color: 0x596260, metalness: 0.34, roughness: 0.74 });
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0x69716e, metalness: 0.3, roughness: 0.78 });
    const insulatorMaterial = new THREE.MeshStandardMaterial({ color: 0xb5bbb5, roughness: 0.67 });
    const wireMaterial = new THREE.LineBasicMaterial({
      color: 0x444c4b, transparent: true, opacity: 0.84, depthTest: true, depthWrite: false,
    });
    const sleeperMatrices = [];
    const sleeperColors = [];
    const overviewRailPositions = [];
    const contactVertices = [];
    const messengerVertices = [];
    const dropperVertices = [];
    const mastPositions = [];
    const armPositions = [];
    const upperArmPositions = [];
    const braceTransforms = [];
    const insulatorPositions = [];
    const gaugeHalfWidth = 0.7175;
    const ballastHalfWidth = 1.72;
    const sleeperSpacing = 0.68;
    const catenarySpan = 52;
    const unitScale = new THREE.Vector3(1, 1, 1);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const scratchPosition = new THREE.Vector3();
    const scratchQuaternion = new THREE.Quaternion();
    const scratchMatrix = new THREE.Matrix4();
    const makeMetric = points => {
      const cumulative = [0];
      for (let index = 1; index < points.length; index += 1) {
        cumulative.push(cumulative[index - 1] + Math.hypot(
          points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1],
        ));
      }
      return { points, cumulative, length: cumulative.at(-1) || 0 };
    };
    const sampleMetric = (metric, distance) => {
      const target = clamp(distance, 0, metric.length);
      let index = 1;
      while (index < metric.cumulative.length - 1 && metric.cumulative[index] < target) index += 1;
      const startDistance = metric.cumulative[index - 1];
      const segmentLength = Math.max(metric.cumulative[index] - startDistance, 0.001);
      const amount = clamp((target - startDistance) / segmentLength, 0, 1);
      const start = metric.points[index - 1], end = metric.points[index];
      return {
        x: start[0] + (end[0] - start[0]) * amount,
        z: start[1] + (end[1] - start[1]) * amount,
        dx: end[0] - start[0], dz: end[1] - start[1],
      };
    };
    const makeTrackGeometry = (samples, strips, textureLength) => {
      const positions = [], uvs = [], indices = [];
      for (const strip of strips) {
        const startIndex = positions.length / 3;
        for (const sample of samples) {
          const previous = sample.previous, next = sample.next;
          const dx = next.x - previous.x, dz = next.z - previous.z;
          const length = Math.hypot(dx, dz) || 1;
          const nx = -dz / length, nz = dx / length;
          for (const side of [-1, 1]) {
            const offset = strip.offset + side * strip.width / 2;
            const x = sample.x + nx * offset, z = sample.z + nz * offset;
            positions.push(x, terrainHeightAt(x, z) + sample.verticalOffset + strip.height, z);
            uvs.push(sample.distance / textureLength, side > 0 ? 1 : 0);
          }
        }
        for (let index = 1; index < samples.length; index += 1) {
          const left = startIndex + index * 2, right = left + 1;
          indices.push(left - 2, left - 1, left, left - 1, right, left);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      return geometry;
    };
    const addBraceInstances = () => {
      if (!braceTransforms.length) return;
      const braces = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.075, 0.075), armMaterial, braceTransforms.length);
      for (let index = 0; index < braceTransforms.length; index += 1) braces.setMatrixAt(index, braceTransforms[index].matrix);
      braces.instanceMatrix.needsUpdate = true;
      braces.castShadow = false;
      braces.receiveShadow = false;
      catenaryGroup.add(braces);
    };

    const railwayRecords = data.railways || [];
    for (let recordIndex = 0; recordIndex < railwayRecords.length; recordIndex += 1) {
      const [railwayType, points, attributes = {}] = railwayRecords[recordIndex];
      if (railwayType !== 'rail' || points.length < 2) continue;
      const explicitOffset = Number(attributes.inferredVerticalOffsetM);
      const layer = clamp(Number.parseInt(attributes.layer || '0', 10) || 0, -5, 5);
      const bridge = attributes.bridge && attributes.bridge !== 'no';
      const tunnel = attributes.tunnel && attributes.tunnel !== 'no';
      const verticalOffset = Number.isFinite(explicitOffset)
        ? explicitOffset
        : bridge ? Math.max(4.5, Math.max(layer, 1) * 3)
          : tunnel ? -Math.max(3, Math.abs(Math.min(layer, -1)) * 3) : layer * 0.35;
      const metric = makeMetric(points);
      if (metric.length < 1) continue;
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index], end = points[index + 1];
        const dx = end[0] - start[0], dz = end[1] - start[1];
        const segmentLength = Math.hypot(dx, dz);
        if (segmentLength < 0.05) continue;
        const nx = -dz / segmentLength, nz = dx / segmentLength;
        for (const offset of [-gaugeHalfWidth, gaugeHalfWidth]) {
          const x1 = start[0] + nx * offset, z1 = start[1] + nz * offset;
          const x2 = end[0] + nx * offset, z2 = end[1] + nz * offset;
          overviewRailPositions.push(
            x1, terrainHeightAt(x1, z1) + verticalOffset + 0.26, z1,
            x2, terrainHeightAt(x2, z2) + verticalOffset + 0.26, z2,
          );
        }
      }
      const samples = [];
      const sampleSpacing = 2.5;
      const sampleCount = Math.max(1, Math.ceil(metric.length / sampleSpacing));
      for (let index = 0; index <= sampleCount; index += 1) {
        const distance = metric.length * index / sampleCount;
        const point = sampleMetric(metric, distance);
        const previous = sampleMetric(metric, Math.max(0, distance - 0.5));
        const next = sampleMetric(metric, Math.min(metric.length, distance + 0.5));
        samples.push({ ...point, distance, previous, next, verticalOffset });
      }

      const ballast = new THREE.Mesh(
        makeTrackGeometry(samples, [{ offset: 0, width: ballastHalfWidth * 2, height: 0.025 }], 3.2),
        ballastMaterial,
      );
      ballast.renderOrder = -1;
      ballastGroup.add(ballast);
      const railGeometry = makeTrackGeometry(samples, [
        { offset: -gaugeHalfWidth, width: 0.115, height: 0.255 },
        { offset: gaugeHalfWidth, width: 0.115, height: 0.255 },
      ], 1);
      const rails = new THREE.Mesh(railGeometry, railMaterial);
      rails.renderOrder = 1;
      railsGroup.add(rails);

      for (let distance = sleeperSpacing * 0.5; distance < metric.length; distance += sleeperSpacing) {
        const point = sampleMetric(metric, distance);
        const previous = sampleMetric(metric, Math.max(0, distance - 0.35));
        const next = sampleMetric(metric, Math.min(metric.length, distance + 0.35));
        const dx = next.x - previous.x, dz = next.z - previous.z;
        const tangentLength = Math.hypot(dx, dz) || 1;
        const nx = -dz / tangentLength, nz = dx / tangentLength;
        const edgeLeft = [point.x - nx * 1.27, point.z - nz * 1.27];
        const edgeRight = [point.x + nx * 1.27, point.z + nz * 1.27];
        const ground = (terrainHeightAt(...edgeLeft) + terrainHeightAt(...edgeRight)) * 0.5;
        const quaternion = new THREE.Quaternion().setFromUnitVectors(xAxis, new THREE.Vector3(nx, 0, nz));
        const matrix = new THREE.Matrix4().compose(
          new THREE.Vector3(point.x, ground + verticalOffset + 0.115, point.z), quaternion, unitScale,
        );
        sleeperMatrices.push(matrix);
        const grain = Math.sin(point.x * 12.9898 + point.z * 78.233 + recordIndex * 6.31) * 43758.5453;
        const shade = grain - Math.floor(grain);
        const palette = shade < 0.53 ? 0x625e55 : shade < 0.84 ? 0x777166 : 0x555b59;
        sleeperColors.push(new THREE.Color(palette));
      }

      // South African Metrorail uses overhead electric traction. A regular
      // cantilever, contact wire, messenger wire and short droppers give the
      // corridor a readable catenary silhouette without adding fake signals.
      const electrified = !tunnel && attributes.electrified !== 'no' && attributes.electrified !== false;
      if (!electrified) continue;
      const side = recordIndex % 2 ? -1 : 1;
      for (let distance = catenarySpan * 0.5; distance < metric.length - 7; distance += catenarySpan) {
        const point = sampleMetric(metric, distance);
        const previous = sampleMetric(metric, Math.max(0, distance - 1));
        const next = sampleMetric(metric, Math.min(metric.length, distance + 1));
        const dx = next.x - previous.x, dz = next.z - previous.z;
        const tangentLength = Math.hypot(dx, dz) || 1;
        const nx = -dz / tangentLength, nz = dx / tangentLength;
        const baseX = point.x + nx * side * 3.9;
        const baseZ = point.z + nz * side * 3.9;
        const baseY = terrainHeightAt(baseX, baseZ) + verticalOffset;
        mastPositions.push({ x: baseX, y: baseY + 3.35, z: baseZ });
        const armX = point.x + nx * side * 1.95;
        const armZ = point.z + nz * side * 1.95;
        const armAngle = Math.atan2(nz * side, -nx * side);
        armPositions.push({ x: armX, y: baseY + 5.75, z: armZ, angle: armAngle });
        upperArmPositions.push({ x: armX, y: baseY + 6.48, z: armZ, angle: armAngle });
        const braceStart = [baseX, baseY + 4.55, baseZ];
        const braceEnd = [point.x + nx * side * 0.2, baseY + 5.72, point.z + nz * side * 0.2];
        const braceDirection = new THREE.Vector3(
          braceEnd[0] - braceStart[0], braceEnd[1] - braceStart[1], braceEnd[2] - braceStart[2],
        );
        const braceLength = braceDirection.length();
        scratchQuaternion.setFromUnitVectors(xAxis, braceDirection.normalize());
        scratchMatrix.compose(
          new THREE.Vector3((braceStart[0] + braceEnd[0]) * 0.5, (braceStart[1] + braceEnd[1]) * 0.5, (braceStart[2] + braceEnd[2]) * 0.5),
          scratchQuaternion,
          new THREE.Vector3(braceLength, 1, 1),
        );
        braceTransforms.push({ matrix: scratchMatrix.clone() });
        insulatorPositions.push({ x: point.x + nx * side * 0.18, y: baseY + 5.51, z: point.z + nz * side * 0.18 });
        insulatorPositions.push({ x: point.x + nx * side * 0.18, y: baseY + 6.32, z: point.z + nz * side * 0.18 });
      }

      const wireStep = 4.5;
      let previousContact = null, previousMessenger = null;
      for (let distance = 0; distance <= metric.length + wireStep * 0.25; distance += wireStep) {
        const along = Math.min(distance, metric.length);
        const point = sampleMetric(metric, along);
        const phase = ((along + catenarySpan * 0.5) % catenarySpan) / catenarySpan;
        const sag = 0.48 * phase * (1 - phase);
        const ground = terrainHeightAt(point.x, point.z) + verticalOffset;
        const contact = [point.x, ground + 5.4 + sag, point.z];
        const messenger = [point.x, ground + 6.17 + sag * 0.55, point.z];
        if (previousContact) {
          contactVertices.push(...previousContact, ...contact);
          messengerVertices.push(...previousMessenger, ...messenger);
        }
        if (Math.abs((along - 4) % 9) < wireStep * 0.5) {
          dropperVertices.push(contact[0], contact[1], contact[2], messenger[0], messenger[1], messenger[2]);
        }
        previousContact = contact;
        previousMessenger = messenger;
        if (along >= metric.length) break;
      }
    }

    if (sleeperMatrices.length) {
      const sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(2.55, 0.19, 0.27), sleeperMaterial, sleeperMatrices.length);
      for (let index = 0; index < sleeperMatrices.length; index += 1) {
        sleepers.setMatrixAt(index, sleeperMatrices[index]);
        sleepers.setColorAt(index, sleeperColors[index]);
      }
      sleepers.instanceMatrix.needsUpdate = true;
      if (sleepers.instanceColor) sleepers.instanceColor.needsUpdate = true;
      sleepers.castShadow = false;
      sleepers.receiveShadow = false;
      sleepers.renderOrder = 0;
      sleepersGroup.add(sleepers);
    }
    if (overviewRailPositions.length) {
      const overviewGeometry = new THREE.BufferGeometry();
      overviewGeometry.setAttribute('position', new THREE.Float32BufferAttribute(overviewRailPositions, 3));
      const overviewRails = new THREE.LineSegments(overviewGeometry, new THREE.LineBasicMaterial({ color: COLORS.rail }));
      overviewRails.renderOrder = 1;
      overviewRailsGroup.add(overviewRails);
    }

    const setInstances = (geometry, material, positions, target, makeQuaternion = null) => {
      if (!positions.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
      for (let index = 0; index < positions.length; index += 1) {
        const item = positions[index];
        scratchPosition.set(item.x, item.y, item.z);
        if (makeQuaternion) makeQuaternion(item, scratchQuaternion);
        else scratchQuaternion.identity();
        scratchMatrix.compose(scratchPosition, scratchQuaternion, unitScale);
        mesh.setMatrixAt(index, scratchMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      target.add(mesh);
    };
    const rotationForAngle = (item, quaternion) => quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.angle);
    setInstances(new THREE.CylinderGeometry(0.12, 0.17, 6.8, 8), mastMaterial, mastPositions, catenaryGroup);
    setInstances(new THREE.BoxGeometry(4.2, 0.12, 0.13), armMaterial, armPositions, catenaryGroup, rotationForAngle);
    setInstances(new THREE.BoxGeometry(4.2, 0.1, 0.12), armMaterial, upperArmPositions, catenaryGroup, rotationForAngle);
    addBraceInstances();
    if (insulatorPositions.length) {
      const insulators = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 6), insulatorMaterial, insulatorPositions.length);
      for (let index = 0; index < insulatorPositions.length; index += 1) {
        const item = insulatorPositions[index];
        scratchMatrix.compose(new THREE.Vector3(item.x, item.y, item.z), new THREE.Quaternion(), unitScale);
        insulators.setMatrixAt(index, scratchMatrix);
      }
      insulators.instanceMatrix.needsUpdate = true;
      catenaryGroup.add(insulators);
    }
    const addWireSegments = (vertices, material, target, renderOrder) => {
      if (!vertices.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      const line = new THREE.LineSegments(geometry, material);
      line.renderOrder = renderOrder;
      target.add(line);
    };
    addWireSegments(contactVertices, wireMaterial, overheadWiresGroup, 3);
    addWireSegments(messengerVertices, wireMaterial, overheadWiresGroup, 3);
    addWireSegments(dropperVertices, wireMaterial, overheadWiresGroup, 3);
    return (data.railways || []).length;
  }

  function makeGroundSurfaces() {
    const palette = {
      grand_parade: { color: 0xc4b391, texture: 'grandParade', repeat: 22 },
      red_pavers: { color: 0xa66f5c, texture: 'redPavers', repeat: 18 },
      concrete: { color: 0xa6a398, texture: 'concrete', repeat: 12 },
      asphalt: { color: 0x686a65, texture: 'asphalt', repeat: 12 },
      stone: { color: 0xa69a82, texture: 'stone', repeat: 10 },
      brick: { color: 0xa67866, texture: 'brick', repeat: 8 },
      gravel: { color: 0x80796b, texture: 'gravel', repeat: 8 },
    };
    const groups = new Map();
    for (const surface of data.groundSurfaces || []) {
      if (surface.amenity === 'parking'
        && [undefined, null, 'surface'].includes(surface.parking)) {
        ambientParkingLots.push(surface);
      }
      const style = palette[surface.material] || palette.stone;
      const key = `${surface.special ? 'site' : 'mapped'}:${surface.material || 'stone'}`;
      if (!groups.has(key)) groups.set(key, { style, special: Boolean(surface.special), vertices: [], uvs: [], indices: [], vertexLookup: new Map() });
      const batch = groups.get(key);
      const rings = surface.rings || [];
      const outer = rings[0];
      if (!outer || outer.length < 3) continue;
      let triangulated;
      try {
        triangulated = triangulateRings(outer, rings.slice(1));
      } catch {
        continue;
      }
      if (!triangulated.faces.length) continue;
      const appendDrapedTriangle = (a, b, c) => {
        const edgeLength = Math.max(
          Math.hypot(b[0] - a[0], b[1] - a[1]),
          Math.hypot(c[0] - b[0], c[1] - b[1]),
          Math.hypot(a[0] - c[0], a[1] - c[1]),
        );
        const divisions = clamp(Math.ceil(edgeLength / 8), 1, 48);
        const rows = [];
        for (let row = 0; row <= divisions; row += 1) {
          const indices = [];
          for (let column = 0; column <= divisions - row; column += 1) {
            const bWeight = column / divisions;
            const cWeight = row / divisions;
            const aWeight = 1 - bWeight - cWeight;
            const x = a[0] * aWeight + b[0] * bWeight + c[0] * cWeight;
            const z = a[1] * aWeight + b[1] * bWeight + c[1] * cWeight;
            const key = `${x.toFixed(3)}:${z.toFixed(3)}`;
            let vertex = batch.vertexLookup.get(key);
            if (vertex === undefined) {
              vertex = batch.vertices.length / 3;
              batch.vertexLookup.set(key, vertex);
              batch.vertices.push(x, terrainSurfaceHeightAt(x, z) + SCENE_LAYERS.groundTexture.lift, z);
              batch.uvs.push(x / batch.style.repeat, z / batch.style.repeat);
            }
            indices.push(vertex);
          }
          rows.push(indices);
        }
        for (let row = 0; row < divisions; row += 1) {
          for (let column = 0; column < divisions - row; column += 1) {
            batch.indices.push(rows[row][column], rows[row][column + 1], rows[row + 1][column]);
            if (column + row < divisions - 1) {
              batch.indices.push(rows[row][column + 1], rows[row + 1][column + 1], rows[row + 1][column]);
            }
          }
        }
      };
      for (const face of triangulated.faces) {
        const a = triangulated.vertices[face[0]], b = triangulated.vertices[face[1]], c = triangulated.vertices[face[2]];
        appendDrapedTriangle(a, b, c);
      }
    }
    for (const batch of groups.values()) {
      if (!batch.indices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.vertices, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
      geometry.setIndex(batch.indices);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: batch.style.color,
        map: makeSurfaceTexture(batch.style.texture),
        roughness: 0.96,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }));
      const materialPriority = ['asphalt', 'gravel', 'stone', 'brick', 'concrete', 'red_pavers', 'grand_parade'].indexOf(batch.style.texture);
      setSceneLayer(mesh, 'groundTexture', Math.max(0, materialPriority) * 0.06 + (batch.special ? 0.48 : 0));
      mesh.receiveShadow = true;
      mesh.name = batch.special ? 'image-checked-ground-surfaces' : `mapped-${batch.style.texture}-ground-surfaces`;
      layerGroups.terrain.add(mesh);
      groundSurfaceMeshes.push(mesh);
    }
  }

  async function loadGroundcoverInventory() {
    const summary = document.querySelector('#groundcover-summary');
    const status = document.querySelector('#groundcover-status');
    const areas = document.querySelector('#groundcover-areas');
    const caveat = document.querySelector('#groundcover-caveat');
    if (summary) summary.hidden = false;
    if (groundcoverLoaded) return;
    if (groundcoverLoading) return groundcoverLoading;
    groundcoverLoading = (async () => {
      if (status) status.textContent = 'Loading mapped surface coverage…';
      try {
        const response = await fetch(`${windApi}/groundcover`, { requestKey: 'groundcover-inventory' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
        const palette = {
          paved: { color: 0xe8ad61 }, vegetated: { color: 0x5ecb91 }, water: { color: 0x54c3e1 },
        };
        for (const category of payload.categories || []) {
          const style = palette[category.category];
          if (!style) continue;
          const positions = [], indices = [];
          let vertexCount = 0;
          const appendTriangle = (a, b, c) => {
            const edgeLength = Math.max(
              Math.hypot(b[0] - a[0], b[1] - a[1]),
              Math.hypot(c[0] - b[0], c[1] - b[1]),
              Math.hypot(a[0] - c[0], a[1] - c[1]),
            );
            const divisions = clamp(Math.ceil(edgeLength / 8), 1, 48);
            const rows = [];
            for (let row = 0; row <= divisions; row += 1) {
              const rowIndices = [];
              for (let column = 0; column <= divisions - row; column += 1) {
                const wb = column / divisions, wc = row / divisions, wa = 1 - wb - wc;
                const x = a[0] * wa + b[0] * wb + c[0] * wc;
                const z = a[1] * wa + b[1] * wb + c[1] * wc;
                rowIndices.push(vertexCount++);
                positions.push(x, terrainSurfaceHeightAt(x, z) + SCENE_LAYERS.mappedCoverage.lift, z);
              }
              rows.push(rowIndices);
            }
            for (let row = 0; row < divisions; row += 1) {
              for (let column = 0; column < divisions - row; column += 1) {
                indices.push(rows[row][column], rows[row][column + 1], rows[row + 1][column]);
                if (column + row < divisions - 1) {
                  indices.push(rows[row][column + 1], rows[row + 1][column + 1], rows[row + 1][column]);
                }
              }
            }
          };
          for (const polygon of category.polygons || []) {
            const outer = polygon[0] || [];
            if (outer.length < 3) continue;
            let triangulated;
            try { triangulated = triangulateRings(outer, polygon.slice(1)); }
            catch { continue; }
            for (const face of triangulated.faces) {
              appendTriangle(triangulated.vertices[face[0]], triangulated.vertices[face[1]], triangulated.vertices[face[2]]);
            }
          }
          if (!indices.length) continue;
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
          geometry.setIndex(indices);
          geometry.computeVertexNormals();
          const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
            color: style.color, transparent: true, opacity: 0.76,
            roughness: 0.96, metalness: 0, side: THREE.DoubleSide,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
          }));
          setSceneLayer(mesh, 'mappedCoverage');
          mesh.name = `groundcover-${category.category}`;
          layerGroups.groundcover.add(mesh);
        }
        if (status) status.textContent = `${Number(payload.coverage_percent || 0).toFixed(1)}% of the mapped terrain footprint has a classified polygon (${(Number(payload.mapped_area_m2 || 0) / 10000).toFixed(1)} ha).`;
        if (areas) areas.replaceChildren(...(payload.categories || []).map(category => {
          const row = document.createElement('div');
          row.className = `groundcover-area ${category.category}`;
          const name = document.createElement('span'); name.textContent = category.label;
          const area = document.createElement('b'); area.textContent = `${(Number(category.area_m2 || 0) / 10000).toFixed(1)} ha`;
          row.append(name, area); return row;
        }));
        if (caveat) caveat.textContent = `${payload.source}. ${payload.caveat}`;
        groundcoverLoaded = true;
      } catch (error) {
        if (status) status.textContent = `Surface inventory unavailable · ${error.message || 'try again later'}`;
      } finally {
        groundcoverLoading = null;
        requestRender();
      }
    })();
    return groundcoverLoading;
  }

  function updateRunoffSummary() {
    const rainfallOutput = document.querySelector('#runoff-rainfall-value');
    const volume = document.querySelector('#runoff-volume');
    if (rainfallOutput) rainfallOutput.textContent = `${runoffRainfallDepthMm} mm`;
    if (!runoffMetadata || !volume) return;
    const grossVolume = Number(runoffMetadata.mapped_paved_area_m2 || 0) * runoffRainfallDepthMm / 1000;
    volume.textContent = `${grossVolume.toLocaleString('en-ZA', { maximumFractionDigits: 0 })} m³ gross rainfall on mapped pavement under the stated 100% runoff assumption.`;
  }

  async function loadRunoffScreening() {
    const summary = document.querySelector('#runoff-summary');
    const status = document.querySelector('#runoff-status');
    const caveat = document.querySelector('#runoff-caveat');
    if (summary) summary.hidden = false;
    if (runoffLoaded) return;
    if (runoffLoading) return runoffLoading;
    runoffLoading = (async () => {
      if (status) status.textContent = 'Loading mapped-pavement flow paths…';
      try {
        const response = await fetch(`${windApi}/runoff/screening`, { requestKey: 'runoff-screening' });
        const metadata = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(metadata.detail || `HTTP ${response.status}`);
        const assetResponse = await fetch(`${metadata.asset_url}?v=${metadata.asset_cache_key || metadata.asset_sha256}`);
        if (!assetResponse.ok) throw new Error(`flow asset HTTP ${assetResponse.status}`);
        const buffer = await assetResponse.arrayBuffer();
        const headerSize = 36, recordSize = 8;
        if (buffer.byteLength < headerSize || String.fromCharCode(...new Uint8Array(buffer, 0, 8)) !== 'CTFLOW01') {
          throw new Error('flow asset header is invalid');
        }
        const header = new DataView(buffer, 0, headerSize);
        const width = header.getUint32(8, true), height = header.getUint32(12, true);
        const resolution = header.getFloat32(16, true);
        const minX = header.getFloat32(20, true), minZ = header.getFloat32(24, true);
        const threshold = header.getFloat32(28, true), count = header.getUint32(32, true);
        if (headerSize + count * recordSize !== buffer.byteLength
          || width !== Number(metadata.grid?.width) || height !== Number(metadata.grid?.height)
          || count !== Number(metadata.record_count)) throw new Error('flow asset dimensions do not match its manifest');

        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const records = new DataView(buffer, headerSize);
        let maximumArea = threshold;
        for (let index = 0; index < count; index += 1) maximumArea = Math.max(maximumArea, records.getUint32(index * recordSize + 4, true));
        const lowColor = new THREE.Color(0x2475e5);
        const middleColor = new THREE.Color(0x27cbd1);
        const highColor = new THREE.Color(0xff7958);
        const color = new THREE.Color();
        for (let index = 0; index < count; index += 1) {
          const offset = index * recordSize;
          const row = records.getUint16(offset, true), column = records.getUint16(offset + 2, true);
          const area = records.getUint32(offset + 4, true);
          const x = minX + (column + 0.5) * resolution;
          const z = minZ + (row + 0.5) * resolution;
          positions.set([x, terrainSurfaceHeightAt(x, z) + SCENE_LAYERS.runoff.lift, z], index * 3);
          const blend = clamp(Math.log(Math.max(1, area / threshold)) / Math.log(Math.max(1.01, maximumArea / threshold)), 0, 1);
          if (blend < 0.58) color.copy(lowColor).lerp(middleColor, blend / 0.58);
          else color.copy(middleColor).lerp(highColor, (blend - 0.58) / 0.42);
          colors.set([color.r, color.g, color.b], index * 3);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({
          size: 5.5, sizeAttenuation: true, vertexColors: true, transparent: true,
          opacity: 0.92, depthWrite: false,
        }));
        points.name = 'mapped-pavement-runoff-concentration';
        setSceneLayer(points, 'runoff');
        layerGroups.runoff.add(points);
        runoffMetadata = metadata;
        runoffLoaded = true;
        if (status) status.textContent = `${Number(metadata.record_count).toLocaleString()} flow cells · ${(Number(metadata.mapped_paved_area_m2) / 10000).toFixed(1)} ha mapped pavement · ${Number(metadata.mapped_paved_coverage_percent).toFixed(1)}% of valid terrain.`;
        if (caveat) caveat.textContent = `${metadata.method} ${metadata.runoff_assumption} ${metadata.limitations}`;
        updateRunoffSummary();
      } catch (error) {
        if (status) status.textContent = `Runoff screen unavailable · ${error.message || 'try again later'}`;
      } finally {
        runoffLoading = null;
        requestRender();
      }
    })();
    return runoffLoading;
  }

  function buildCyclingLayer() {
    if (cyclingLoaded) return;
    cyclingLoaded = true;
    const ways = (data.roads || []).filter(record => record[1] === 'cycleway' && record[2]?.length >= 2)
      .map(record => record[2]);
    const parents = ways.map((_, index) => index);
    const find = index => {
      while (parents[index] !== index) {
        parents[index] = parents[parents[index]];
        index = parents[index];
      }
      return index;
    };
    const join = (a, b) => { parents[find(a)] = find(b); };
    const distanceToSegment = (point, a, b) => {
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const amount = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / Math.max(dx * dx + dz * dz, 1e-6), 0, 1);
      return Math.hypot(point[0] - a[0] - dx * amount, point[1] - a[1] - dz * amount);
    };
    let totalLength = 0, openEnds = 0;
    const endpoints = [];
    ways.forEach((points, index) => {
      for (let point = 1; point < points.length; point += 1) {
        totalLength += Math.hypot(points[point][0] - points[point - 1][0], points[point][1] - points[point - 1][1]);
      }
      endpoints.push([index, points[0]], [index, points[points.length - 1]]);
    });
    const openEndpointPositions = [];
    for (const [wayIndex, endpoint] of endpoints) {
      let linked = false;
      for (let otherIndex = 0; otherIndex < ways.length; otherIndex += 1) {
        if (otherIndex === wayIndex) continue;
        const other = ways[otherIndex];
        let nearest = Infinity;
        for (let point = 1; point < other.length; point += 1) {
          nearest = Math.min(nearest, distanceToSegment(endpoint, other[point - 1], other[point]));
          if (nearest <= 8) break;
        }
        if (nearest <= 8) {
          linked = true;
          join(wayIndex, otherIndex);
        }
      }
      if (!linked) {
        openEnds += 1;
        openEndpointPositions.push(endpoint);
      }
    }
    const components = new Set(ways.map((_, index) => find(index))).size;
    const dark = new THREE.MeshBasicMaterial({ color: 0x073842, transparent: true, opacity: 0.94, depthWrite: false });
    const highlight = new THREE.MeshBasicMaterial({ color: 0x56e4ed, transparent: true, opacity: 0.98, depthWrite: false });
    for (const points of ways) {
      const pathPoints = points.map(([x, z]) => new THREE.Vector3(x, terrainSurfaceHeightAt(x, z) + SCENE_LAYERS.cycling.lift, z));
      const curve = new THREE.CatmullRomCurve3(pathPoints, false, 'centripetal');
      const divisions = Math.max(16, Math.ceil(curve.getLength() / 1.5));
      const outer = new THREE.Mesh(new THREE.TubeGeometry(curve, divisions, 1.12, 6, false), dark);
      const inner = new THREE.Mesh(new THREE.TubeGeometry(curve, divisions, 0.62, 6, false), highlight);
      setSceneLayer(outer, 'cycling');
      setSceneLayer(inner, 'cycling');
      outer.name = 'mapped-cycleway-outline';
      inner.name = 'mapped-cycleway-highlight';
      layerGroups.cycling.add(outer, inner);
    }
    const endMarkerGeometry = new THREE.SphereGeometry(1.35, 10, 8);
    const endMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xffc46b });
    for (const [x, z] of openEndpointPositions) {
      const marker = new THREE.Mesh(endMarkerGeometry, endMarkerMaterial);
      marker.position.set(x, terrainSurfaceHeightAt(x, z) + 1.4, z);
      setSceneLayer(marker, 'cycling', 1);
      marker.name = 'unmatched-mapped-cycleway-end';
      layerGroups.cycling.add(marker);
    }
    const status = document.querySelector('#cycling-status');
    const caveat = document.querySelector('#cycling-caveat');
    if (status) status.textContent = ways.length
      ? `${ways.length} mapped links · ${(totalLength / 1000).toFixed(2)} km · ${components} connected groups · ${openEnds} unmatched ends.`
      : 'No dedicated cycleway links are present in this map extract.';
    if (caveat) caveat.textContent = 'OpenStreetMap dedicated cycleway features only; endpoints are unmatched when more than 8 m from another mapped cycleway. They may be intentional terminals. Other roads may allow cycling but are not counted here. This is not a safety or accessibility assessment.';
  }

  function makeCanopies() {
    const canopies = canopyAsset.canopies || [];
    const positions = [];
    const uvs = [];
    const shades = [];
    const indices = [];
    let vertexLookup = new Map();
    let canopyShade = 0;
    let vertexOriginX = 0, vertexOriginY = 0, vertexOriginZ = 0;
    const hashHeight = (x, z, seed) => {
      const value = Math.sin(x * 12.9898 + z * 78.233 + seed * 0.000001) * 43758.5453;
      return value - Math.floor(value);
    };
    const addVertex = (x, y, z) => {
      const qx = Math.round((x - vertexOriginX) * 1000);
      const qy = Math.round((y - vertexOriginY) * 1000);
      const qz = Math.round((z - vertexOriginZ) * 1000);
      // Crown-local millimetre coordinates fit into 17 bits per axis for
      // ordinary trees. Pack them into an exact 51-bit integer Map key and
      // keep the original string key as a safe fallback for oversized crowns.
      const packed = qx >= 0 && qx < 131072 && qy >= 0 && qy < 131072 && qz >= 0 && qz < 131072;
      const key = packed
        ? (qx * 131072 + qy) * 131072 + qz
        : `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
      if (vertexLookup.has(key)) return vertexLookup.get(key);
      const index = positions.length / 3;
      vertexLookup.set(key, index);
      positions.push(x, y, z);
      uvs.push(x / 10, z / 10);
      shades.push(canopyShade, canopyShade, canopyShade);
      return index;
    };
    const addTriangle = (a, b, c) => {
      indices.push(
        addVertex(a.x, a.y, a.z),
        addVertex(b.x, b.y, b.z),
        addVertex(c.x, c.y, c.z),
      );
    };
    const smoothRing = (ring, iterations) => {
      let points = ring;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const smoothed = [];
        for (let index = 0; index < points.length; index += 1) {
          const current = points[index];
          const next = points[(index + 1) % points.length];
          smoothed.push(
            new THREE.Vector2(current.x * 0.75 + next.x * 0.25, current.y * 0.75 + next.y * 0.25),
            new THREE.Vector2(current.x * 0.25 + next.x * 0.75, current.y * 0.25 + next.y * 0.75),
          );
        }
        points = smoothed;
      }
      return points;
    };
    for (const [, , crownBase, crownTop, seed, sourceRings] of canopies) {
      canopyShade = 0.86 + hashHeight(0, 0, seed) * 0.28;
      // Vertices are shared within one crown for smooth normals. Separate
      // crowns intentionally keep their own normals and colour variation.
      vertexLookup = new Map();
      const rings = sourceRings.map(sourceRing => {
        const ring = sourceRing.map(([x, z]) => new THREE.Vector2(x, z));
        return smoothRing(ring, 1);
      });
      const contour = rings[0] || [];
      const holes = rings.slice(1);
      if (contour.length < 3) continue;
      const vertices = contour.concat(...holes);
      const canopyHeight = Math.max(0.6, crownTop - crownBase);
      let centerX = 0;
      let centerZ = 0;
      let minimumX = Infinity, minimumZ = Infinity;
      for (const point of contour) {
        centerX += point.x;
        centerZ += point.y;
        minimumX = Math.min(minimumX, point.x);
        minimumZ = Math.min(minimumZ, point.y);
      }
      vertexOriginX = Math.floor(minimumX * 1000) / 1000;
      vertexOriginY = Math.floor(crownBase * 1000) / 1000;
      vertexOriginZ = Math.floor(minimumZ * 1000) / 1000;
      centerX /= contour.length;
      centerZ /= contour.length;
      const canopyRadius = Math.max(0.7, ...contour.map(point => Math.hypot(point.x - centerX, point.y - centerZ)));
      const topY = point => {
        const edgeDistance = Math.max(0, canopyRadius - Math.hypot(point.x - centerX, point.y - centerZ));
        const ratio = clamp(edgeDistance / (canopyRadius * 0.84), 0, 1);
        const dome = ratio * ratio * (3 - 2 * ratio);
        const leafClump = (hashHeight(point.x, point.y, seed + 23) - 0.5) * 0.12;
        return crownBase + canopyHeight * (0.52 + dome * 0.48 + leafClump);
      };
      for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        const [sourceA, sourceB, sourceC] = face.map(index => vertices[index]);
        const toSurfacePoint = point => ({ x: point.x, y: topY(point), z: point.y, groundZ: point.y });
        const a = toSurfacePoint(sourceA);
        const b = toSurfacePoint(sourceB);
        const c = toSurfacePoint(sourceC);
        const midpoint = (first, second) => {
          const point = { x: (first.x + second.x) * 0.5, y: (first.groundZ + second.groundZ) * 0.5 };
          return toSurfacePoint(point);
        };
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        addTriangle(a, ab, ca);
        addTriangle(ab, b, bc);
        addTriangle(ca, bc, c);
        addTriangle(ab, bc, ca);
      }
      for (const ring of rings) {
        for (let index = 0; index < ring.length; index += 1) {
          const next = (index + 1) % ring.length;
          const a = ring[index], b = ring[next];
          const lowerA = crownBase + hashHeight(a.x, a.y, seed + 11) * 0.45;
          const lowerB = crownBase + hashHeight(b.x, b.y, seed + 11) * 0.45;
          const topA = { x: a.x, y: topY(a), z: a.y };
          const topB = { x: b.x, y: topY(b), z: b.y };
          const bottomA = { x: a.x, y: lowerA, z: a.y };
          const bottomB = { x: b.x, y: lowerB, z: b.y };
          addTriangle(topA, topB, bottomB);
          addTriangle(topA, bottomB, bottomA);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const crownMaterial = new THREE.MeshLambertMaterial({
      color: 0x7da55d,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    const crowns = new THREE.Mesh(geometry, crownMaterial);
    crowns.userData.normalMaterial = crownMaterial;
    crowns.userData.sunMaterial = new THREE.MeshLambertMaterial({
      color: 0x7da55d, vertexColors: true, side: THREE.DoubleSide,
    });
    crowns.userData.viewshedMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff, emissive: 0x202428, emissiveIntensity: 0.25, side: THREE.DoubleSide,
    });
    crowns.castShadow = true;
    crowns.receiveShadow = true;

    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.3, 1, 5);
    const trunkMaterial = new THREE.MeshLambertMaterial({ color: 0x6b4d35 });
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, data.trees.length);
    trunks.userData.normalMaterial = trunkMaterial;
    trunks.userData.sunMaterial = new THREE.MeshLambertMaterial({
      color: COLORS.terrainSun, emissive: 0x242424, emissiveIntensity: 0.24, side: THREE.DoubleSide,
    });
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
    sunModeNeutralMeshes.push(trunks, crowns);

    return canopies.length;
  }

  function makeStreetFurniture(furnitureRecords = data.cityFurniture || [], targetGroup = layerGroups.cityFurniture, featureLayers = {}, options = {}) {
    const group = targetGroup;
    const crossings = featureLayers.crossings || data.crossings || [];
    const parking = featureLayers.parking || data.parking || [];
    const lightingEffects = options.lightingEffects === true;
    const lightingEffectsOnly = options.lightingEffectsOnly === true;
    const matrix = new THREE.Matrix4();
    const makeInstances = (geometry, material, matrices, semanticClass) => {
      if (!matrices.length) return null;
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((instanceMatrix, index) => mesh.setMatrixAt(index, instanceMatrix));
      mesh.instanceMatrix.needsUpdate = true;
      const isStreetLight = semanticClass.startsWith('publicLight');
      mesh.castShadow = !isStreetLight && !['parkingSpace', 'pedestrianCrossing'].includes(semanticClass);
      mesh.receiveShadow = !isStreetLight;
      mesh.userData.semanticClass = semanticClass;
      mesh.userData.maxDistance = ['parkingSpace', 'pedestrianCrossing', 'daisyPetals', 'daisyCentres', 'daisyZebraBands', 'publicLightPool'].includes(semanticClass)
        ? 720
        : semanticClass === 'publicLightGlow' ? 2200
          : semanticClass.startsWith('publicLight') ? 1050
          : ['fountain', 'bench', 'wasteBasket', 'bicycleParking', 'streetClock', 'bollard', 'busStop'].some(value => semanticClass.startsWith(value)) ? 850 : null;
      if (semanticClass === 'parkingSpace') setSceneLayer(mesh, 'streetMarking');
      if (['pedestrianCrossing', 'daisyPetals', 'daisyCentres', 'daisyZebraBands'].includes(semanticClass)) {
        setSceneLayer(mesh, 'streetMarking', 0.2);
      }
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
    const publicLights = furnitureRecords.filter(item => item.class === 'publicLight' && item.coordinates);
    // Keep the broad city view readable without drawing every municipal
    // fixture in a dense corridor. At close zoom retain the complete inventory.
    if (cameraState.distance > 120) {
      const cells = new Map();
      // Increase lamp spacing gradually as the camera pulls back. This keeps
      // the city view legible without abruptly switching to the full inventory.
      const cellSize = clamp(cameraState.distance * 0.06, 18, 64);
      for (const item of publicLights) {
        const [x, z] = item.coordinates;
        const cell = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
        const score = (Number(item.attributes?.Wattage) || 0)
          + (String(item.attributes?.FixtureSupport || '').toLowerCase().includes('high mast') ? 1000 : 0);
        const previous = cells.get(cell);
        if (!previous || score > previous.score) cells.set(cell, { item, score });
      }
      publicLights.splice(0, publicLights.length, ...Array.from(cells.values(), value => value.item));
    }
    const poleMatrices = [], armMatrices = [], headMatrices = [], lampGlowPositions = [], lampPoolMatrices = [];
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
      if (!lightingEffectsOnly) {
        poleMatrices.push(composeMatrix(
          new THREE.Vector3(x, baseY + height * 0.5, z),
          new THREE.Quaternion(),
          new THREE.Vector3(highMast ? 1.55 : 1, height, highMast ? 1.55 : 1),
        ));
      }
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
          if (!lightingEffectsOnly) armMatrices.push(segmentMatrix(top, shoulder), segmentMatrix(shoulder, lampPosition));
        }
        const headQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -direction);
        if (!lightingEffectsOnly) {
          headMatrices.push(composeMatrix(
            lampPosition.clone().add(new THREE.Vector3(0, -0.05, 0)),
            headQuaternion,
            postTop ? new THREE.Vector3(0.34, 0.5, 0.34) : flood ? new THREE.Vector3(0.48, 0.22, 0.62) : new THREE.Vector3(0.62, 0.17, 0.28),
          ));
        }
        if (lightingEffects) lampGlowPositions.push(lampPosition.clone().add(new THREE.Vector3(0, -0.16, 0)));

        // A soft, low-profile road wash follows the direction the fixture
        // faces. This single instanced pass gives the same readable night cue
        // as a light map without creating thousands of expensive PointLights.
        if (lightingEffects) {
          const roadWidth = clamp(Number(item.attributes?.roadWidthM) || 8, 5, 18);
          const poolCenter = new THREE.Vector3(x, baseY + 0.34, z)
            .add(outward.clone().multiplyScalar(Math.max(3.2, roadWidth * 0.35)));
          const groundOrientation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
          const roadOrientation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), direction);
          const poolOrientation = roadOrientation.multiply(groundOrientation);
          lampPoolMatrices.push(composeMatrix(
            poolCenter,
            poolOrientation,
            new THREE.Vector3(clamp(roadWidth * 0.72, 4.5, 11), clamp(roadWidth * 1.05, 8, 17), 1),
          ));
        }
      }
    }
    if (!lightingEffectsOnly) {
      const galvanized = new THREE.MeshLambertMaterial({ color: 0x8c9698 });
      makeInstances(new THREE.CylinderGeometry(0.065, 0.14, 1, 5), galvanized, poleMatrices, 'publicLightPole');
      makeInstances(new THREE.CylinderGeometry(0.045, 0.055, 1, 5), galvanized, armMatrices, 'publicLightArm');
      makeInstances(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshLambertMaterial({ color: 0x596164 }), headMatrices, 'publicLightFixture');
      // The tiny bulb sits inside the fixture head at city scale, so omit its
      // separate mesh pass. Night glow and road pools remain available to the
      // lighting inventory when that view explicitly requests them.
    }

    if (lampPoolMatrices.length) {
      const poolCanvas = document.createElement('canvas');
      poolCanvas.width = poolCanvas.height = 128;
      const poolContext = poolCanvas.getContext('2d');
      const poolGradient = poolContext.createRadialGradient(64, 64, 2, 64, 64, 64);
      poolGradient.addColorStop(0, 'rgba(255, 214, 151, 0.32)');
      poolGradient.addColorStop(0.34, 'rgba(255, 183, 103, 0.18)');
      poolGradient.addColorStop(1, 'rgba(255, 157, 74, 0)');
      poolContext.fillStyle = poolGradient;
      poolContext.fillRect(0, 0, 128, 128);
      const poolTexture = new THREE.CanvasTexture(poolCanvas);
      poolTexture.colorSpace = THREE.SRGBColorSpace;
      nightLighting.streetPoolMaterial = new THREE.MeshBasicMaterial({
        map: poolTexture, color: 0xffd69b, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), nightLighting.streetPoolMaterial, lampPoolMatrices.length);
      lampPoolMatrices.forEach((instanceMatrix, index) => pools.setMatrixAt(index, instanceMatrix));
      pools.instanceMatrix.needsUpdate = true;
      pools.receiveShadow = false;
      pools.castShadow = false;
      pools.renderOrder = 5;
      pools.userData.semanticClass = 'publicLightPool';
      pools.userData.maxDistance = 720;
      group.add(pools);
      nightLighting.streetPool = pools;
    }

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
      const glowTexture = new THREE.CanvasTexture(glowCanvas);
      glowTexture.colorSpace = THREE.SRGBColorSpace;
      const glowMaterial = new THREE.PointsMaterial({
        map: glowTexture, color: 0xffd28a, size: 2.8,
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      const glow = new THREE.Points(glowGeometry, glowMaterial);
      glow.userData = { semanticClass: 'publicLightGlow', maxDistance: 2200 };
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
    for (const item of parking) {
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
      // Segment identifiers keep similarly named Bree Street parking rows
      // separate when the street curves or changes alignment. Grouping by the
      // display name alone joined distant bays into implausibly long markings.
      const roadKey = item.attributes?.roadFeatureId || item.attributes?.roadName || 'unknown-road';
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
    for (const item of crossings.filter(entry => entry.attributes?.crossingDesign !== 'coveredByDaisyInstallation')) {
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
    const landingPositions = [];
    const landingUvs = [];
    const landingIndices = [];
    const addCrossingLanding = (frame, acrossSign, alongOffset = 0) => {
      if (!pedestrianSurfaceRecords.length) return;
      const angle = THREE.MathUtils.degToRad(Number(frame.bearing) || 0);
      const tangent = [Math.cos(angle), Math.sin(angle)];
      const normal = [-tangent[1], tangent[0]];
      const curb = offsetOnRoad(frame.centre, frame.bearing, alongOffset, acrossSign * frame.width * 0.5);
      const probe = offsetOnRoad(frame.centre, frame.bearing, alongOffset, acrossSign * (frame.width * 0.5 + 1.35));
      let nearest = null;
      const maximumSquared = 4.5 * 4.5;
      for (const candidate of pedestrianSurfaceRecords) {
        if (Math.abs(candidate.verticalOffset || 0) > 0.75) continue;
        const points = candidate.points || [];
        for (let index = 0; index < points.length - 1; index += 1) {
          const a = points[index], b = points[index + 1];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const lengthSquared = dx * dx + dz * dz;
          if (lengthSquared < 0.01) continue;
          const alignment = Math.abs((dx * tangent[0] + dz * tangent[1]) / Math.sqrt(lengthSquared));
          if (alignment < Math.cos(THREE.MathUtils.degToRad(35))) continue;
          const amount = clamp(((probe[0] - a[0]) * dx + (probe[1] - a[1]) * dz) / lengthSquared, 0, 1);
          const x = a[0] + dx * amount, z = a[1] + dz * amount;
          const distanceSquared = (probe[0] - x) ** 2 + (probe[1] - z) ** 2;
          if (distanceSquared > maximumSquared || (nearest && distanceSquared >= nearest.distanceSquared)) continue;
          nearest = { point: [x, z], distanceSquared, record: candidate };
        }
      }
      if (!nearest) return;
      const outwardDistance = (nearest.point[0] - curb[0]) * normal[0] * acrossSign
        + (nearest.point[1] - curb[1]) * normal[1] * acrossSign;
      if (outwardDistance < 0.15 || outwardDistance > 5.5) return;

      const halfWidth = clamp((Number(nearest.record.width) || 1.8) * 0.46, 0.8, 1.35);
      const corners = [
        [curb[0] - tangent[0] * halfWidth, curb[1] - tangent[1] * halfWidth],
        [curb[0] + tangent[0] * halfWidth, curb[1] + tangent[1] * halfWidth],
        [nearest.point[0] - tangent[0] * halfWidth, nearest.point[1] - tangent[1] * halfWidth],
        [nearest.point[0] + tangent[0] * halfWidth, nearest.point[1] + tangent[1] * halfWidth],
      ];
      const first = landingPositions.length / 3;
      const walkOffset = (nearest.record.surfaceOffset ?? ROAD_CLASS_OFFSETS[3]) + (nearest.record.verticalOffset || 0);
      const offsets = [frame.surfaceOffset, frame.surfaceOffset, walkOffset, walkOffset];
      corners.forEach(([x, z], index) => {
        landingPositions.push(x, roadTerrainHeightAt(x, z) + offsets[index], z);
        landingUvs.push(x / 8, z / 8);
      });
      landingIndices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
    };
    const makeCrossingLandingMesh = () => {
      if (!landingIndices.length) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(landingPositions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(landingUvs, 2));
      geometry.setIndex(landingIndices);
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: makeSurfaceTexture('stone'),
        roughness: 0.94,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'mapped-crossing-sidewalk-landings';
      mesh.receiveShadow = true;
      setSceneLayer(mesh, 'path', 0.02);
      layerGroups.paths.add(mesh);
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
        for (const acrossSign of [-1, 1]) {
          addCrossingLanding(frame, acrossSign, -7.1);
          addCrossingLanding(frame, acrossSign, 7.1);
        }
      } else {
        addZebraBand(frame.centre, frame.bearing, frame.width, 0, frame.surfaceOffset);
        for (const acrossSign of [-1, 1]) addCrossingLanding(frame, acrossSign);
      }
    }
    makeCrossingLandingMesh();
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
    const osmFurniture = furnitureRecords;
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
    const fountainBases = [], fountainBowls = [];
    for (const item of fountains) {
      const [x, z] = item.coordinates;
      const y = terrainHeightAt(x, z) + 0.18;
      fountainBases.push(composeMatrix(new THREE.Vector3(x, y + 0.24, z)));
      fountainBowls.push(composeMatrix(new THREE.Vector3(x, y + 0.5, z)));
    }
    makeInstances(new THREE.CylinderGeometry(1.8, 2.05, 0.48, 24), new THREE.MeshLambertMaterial({ color: 0x8b918d }), fountainBases, 'fountainBase');
    makeInstances(new THREE.CylinderGeometry(1.55, 1.7, 0.24, 24, 1, true), new THREE.MeshLambertMaterial({ color: 0xa1a6a0, side: THREE.DoubleSide }), fountainBowls, 'fountainBowl');

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
    const toilets = furnitureRecords.filter(item => item.class === 'publicToilet' && item.coordinates);
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
    const pointObjects = [...publicLights, ...crossings, ...parking, ...toilets, ...osmFurniture];
    const festoonItems = furnitureRecords.filter(entry => entry.class === 'festoonLighting' && entry.centerline);
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
  makeWater();
  let buildingMeshes = makeBuildings();
  buildingMeshes.surface = makeDetailedRoofSurface();
  const buildingAppearance = document.querySelector('#building-appearance');
  let buildingDrawTransparencyEnabled = false;
  function setBuildingAppearance(mode) {
    const coloured = mode === 'elevation';
    for (const mesh of [buildingMeshes.walls]) {
      const values = coloured ? mesh.geometry.userData.elevationColors : mesh.geometry.userData.appearanceColors;
      if (values) mesh.geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
      mesh.material.vertexColors = Boolean(values);
      mesh.material.color.setHex(values ? 0xffffff : COLORS.wall);
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
    buildingDrawTransparencyEnabled = enabled;
    for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean)) {
      mesh.material.transparent = enabled;
      mesh.material.opacity = enabled ? 0.22 : 1;
      mesh.material.depthWrite = !enabled;
      mesh.material.needsUpdate = true;
    }
    requestRender();
  }
  const activeDemolitions = new Set();
  function startBuildingDemolition(index) {
    const record = data.buildings[index];
    const ring = record?.[2];
    if (!Array.isArray(ring) || ring.length < 3 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const xs = ring.map(point => Number(point[0])), zs = ring.map(point => Number(point[1]));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const ground = Number(record[0]) || 0;
    const base = ground + Math.max(0, Number(record[10]) || 0);
    const height = Math.max(3, Number(record[5]) || Number(record[1]) || 12);
    const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
    const holes = Array.isArray(record[13]) ? record[13] : [];
    const group = new THREE.Group();
    group.name = 'building-demolition-rubble';

    // Keep a faithful footprint for the opening collapse beat, then let
    // irregular masonry fragments break away from the shell.
    const shape = new THREE.Shape();
    ring.forEach(([x, z], pointIndex) => {
      const px = x - centerX, pz = -(z - centerZ);
      if (pointIndex === 0) shape.moveTo(px, pz); else shape.lineTo(px, pz);
    });
    shape.closePath();
    for (const hole of holes) {
      const path = new THREE.Path();
      hole.forEach(([x, z], pointIndex) => {
        const px = x - centerX, pz = -(z - centerZ);
        if (pointIndex === 0) path.moveTo(px, pz); else path.lineTo(px, pz);
      });
      path.closePath();
      shape.holes.push(path);
    }
    const shellGeometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
    shellGeometry.rotateX(-Math.PI / 2);
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0xb4b4b4, roughness: 0.94, flatShading: true, transparent: true,
      side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(shellGeometry, shellMaterial);
    shell.position.set(centerX, base, centerZ);
    shell.castShadow = true;
    shell.receiveShadow = true;
    group.add(shell);

    const fragments = [];
    const fragmentCount = clamp(Math.round(((maxX - minX) * (maxZ - minZ)) / 95), 18, 52);
    for (let fragmentIndex = 0, attempts = 0; fragmentIndex < fragmentCount && attempts < fragmentCount * 12; attempts += 1) {
      const x = minX + Math.random() * (maxX - minX), z = minZ + Math.random() * (maxZ - minZ);
      if (!pointInWindRing(x, z, ring) || holes.some(hole => pointInWindRing(x, z, hole))) continue;
      const size = 1.1 + Math.random() * Math.min(4.4, Math.max(1.6, height * 0.12));
      const geometry = new THREE.DodecahedronGeometry(size, 0);
      const material = new THREE.MeshStandardMaterial({
        color: [0xb4b4b4, 0x999894, 0xc5c0b5, 0x827f78][Math.floor(Math.random() * 4)],
        roughness: 0.98, flatShading: true, transparent: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(0.65 + Math.random() * 1.1, 0.45 + Math.random() * 0.9, 0.65 + Math.random() * 1.1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const origin = new THREE.Vector3(x, base + height * (0.22 + Math.random() * 0.78), z);
      mesh.position.copy(origin);
      const initialRotation = [Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI];
      mesh.rotation.set(...initialRotation);
      group.add(mesh);
      const dx = x - centerX + (Math.random() - 0.5) * 5;
      const dz = z - centerZ + (Math.random() - 0.5) * 5;
      const length = Math.hypot(dx, dz) || 1;
      fragments.push({ mesh, origin, vx: dx / length * (3 + Math.random() * 8),
        vy: 3 + Math.random() * 9, vz: dz / length * (3 + Math.random() * 8),
        initialRotation, spin: [Math.random() * 5 - 2.5, Math.random() * 5 - 2.5, Math.random() * 5 - 2.5],
        delay: 0.18 + Math.random() * 0.7, halfHeight: size * 0.8, groundedAt: null });
      fragmentIndex += 1;
    }
    const dustPoints = [];
    for (let i = 0; i < 28; i += 1) {
      const x = minX + Math.random() * (maxX - minX), z = minZ + Math.random() * (maxZ - minZ);
      dustPoints.push(new THREE.Vector3(x, base + 1 + Math.random() * 3, z));
    }
    const dustGeometry = new THREE.BufferGeometry().setFromPoints(dustPoints);
    const dustMaterial = new THREE.PointsMaterial({
      color: 0xb5b0a7, size: 5, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true,
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    group.add(dust);
    if (!fragments.length) {
      shellGeometry.dispose();
      shellMaterial.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
      return;
    }
    scene.add(group);
    activeDemolitions.add({ group, shell, shellMaterial, dust, dustMaterial, fragments, startedAt: performance.now() });
    requestRender();
  }
  addEventListener('climate-building-demolition-start', event => {
    startBuildingDemolition(Number(event.detail?.index));
  });
  function updateDemolitionAnimations(now) {
    for (const demolition of activeDemolitions) {
      const elapsed = (now - demolition.startedAt) / 1000;
      const collapse = clamp((elapsed - 0.2) / 0.9, 0, 1);
      demolition.shell.rotation.set(collapse * 0.11, 0, -collapse * 0.2);
      demolition.shell.scale.y = 1 - collapse * 0.68;
      demolition.shellMaterial.opacity = 1 - collapse * 0.95;
      demolition.dust.position.y = Math.max(0, elapsed - 0.25) * 5;
      demolition.dustMaterial.opacity = clamp((elapsed - 0.25) * 0.9, 0, 0.34) * clamp(1 - Math.max(0, elapsed - 0.7) / 1.1, 0, 1);
      for (const fragment of demolition.fragments) {
        const t = elapsed - fragment.delay;
        if (t <= 0) continue;
        const { mesh, origin } = fragment;
        if (fragment.groundedAt === null) {
          const x = origin.x + fragment.vx * t;
          const z = origin.z + fragment.vz * t;
          const y = origin.y + fragment.vy * t - 12 * t * t;
          const floor = terrainHeightAt(x, z) + fragment.halfHeight;
          mesh.position.set(x, y, z);
          mesh.rotation.set(
            fragment.initialRotation[0] + fragment.spin[0] * t,
            fragment.initialRotation[1] + fragment.spin[1] * t,
            fragment.initialRotation[2] + fragment.spin[2] * t,
          );
          if (y <= floor) {
            mesh.position.y = floor;
            fragment.groundedAt = now;
          }
        } else {
          const fade = clamp(1 - (now - fragment.groundedAt) / 620, 0, 1);
          mesh.material.opacity = fade;
          if (!fade) mesh.visible = false;
        }
      }
      if (demolition.fragments.every(fragment => fragment.groundedAt !== null
        && now - fragment.groundedAt >= 620)) {
        scene.remove(demolition.group);
        demolition.shell.geometry.dispose();
        demolition.shellMaterial.dispose();
        demolition.dust.geometry.dispose();
        demolition.dustMaterial.dispose();
        for (const fragment of demolition.fragments) {
          fragment.mesh.geometry.dispose();
          fragment.mesh.material.dispose();
        }
        activeDemolitions.delete(demolition);
      }
    }
    return activeDemolitions.size > 0;
  }
  function rebuildDesignGeometry(removedIndexes, blocks) {
    const hadEditedGeometry = Boolean(windState.designGeometryDirty);
    const nextRemovedIndexes = new Set(removedIndexes);
    const removedGeometryChanged = nextRemovedIndexes.size !== designRemovedBuildingIndexes.size
      || [...nextRemovedIndexes].some(index => !designRemovedBuildingIndexes.has(index));
    designRemovedBuildingIndexes = nextRemovedIndexes;
    designMassingBlocks = blocks;
    viewshedBuildingIndex = null;
    if (viewshedState.point) {
      clearTimeout(designViewshedRefreshTimer);
      const point = { ...viewshedState.point, placement: viewshedState.point.placement ? { ...viewshedState.point.placement } : null };
      designViewshedRefreshTimer = setTimeout(() => {
        designViewshedRefreshTimer = 0;
        buildViewshed(point.x, point.z, point.placement);
      }, 160);
    }
    rebuildWindBuildingGrid();
    const hasEditedGeometry = designRemovedBuildingIndexes.size > 0 || designMassingBlocks.length > 0;
    windState.designGeometryDirty = hasEditedGeometry;
    windState.loadedCfdCase = null;
    if (hasEditedGeometry || hadEditedGeometry) {
      invalidateWindStudy();
      windState.field = null;
      windState.cfd = null;
      clearWindSimulation();
      if (windStatus) windStatus.textContent = hasEditedGeometry
        ? 'Edited geometry changed · rerun the Wind study to analyse this layout.'
        : 'Scenario reset to mapped geometry · run the Wind study again.';
    }
    if (removedGeometryChanged) {
      for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean)) {
        layerGroups.buildings.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.userData.sunMaterial?.dispose();
      }
      buildingMeshes = makeBuildings();
      buildingMeshes.surface = makeDetailedRoofSurface();
      syncWindBuildingDetail();
      setBuildingAppearance(buildingAppearance?.value || 'neutral');
      setBuildingDrawTransparency(buildingDrawTransparencyEnabled);
    }
    setSunMaterials(shadowState.enabled || viewshedState.active);
    updateDesignShadePreview();
    updateDesignWindPreview();
    if (shadowState.mode === 'hours') {
      cancelSunHours('Scene changed · calculate sun hours again.');
    }
    if (shadowState.enabled && shadowState.generated && shadowState.mode === 'shadows') {
      clearTimeout(liveShadowTimer);
      liveShadowTimer = setTimeout(() => {
        liveShadowTimer = 0;
        sunLight.shadow.needsUpdate = true;
        renderer.shadowMap.needsUpdate = true;
        requestRender();
      }, 100);
    }
    requestRender();
  }
  makeGrass();
  makeOsmDetails();
  const railwayCount = makeRailways();
  makeRoads();
  makeGroundSurfaces();
  const canopyCount = makeCanopies();
  let lightingEffectsRequested = false;
  let lightingAreaGroup = null;
  let lightingAreaKey = null;
  let lightingAreaGeneration = 0;
  let lightingAreaTimer = 0;
  let lightingAreaReady = false;
  const LIGHTING_AREA_ZOOM_LIMIT = 900;
  const LIGHTING_AREA_GRID_M = 250;

  function scheduleLightingAreaLoad(immediate = false) {
    const lightingEnabled = Boolean(layerGroups.cityFurniture.visible && layerGroups.publicRealm.visible);
    const sunPanelActive = document.querySelector('[data-menu-target].active')?.dataset.menuTarget === 'sun';
    const closeEnough = cameraState.distance <= LIGHTING_AREA_ZOOM_LIMIT && !shadowState.enabled && !sunPanelActive;
    const analysisNeedsLights = viewshedState.active && !shadowState.enabled && !sunPanelActive;
    if (!lightingEnabled || (!closeEnough && !analysisNeedsLights)) {
      if (lightingAreaGroup) lightingAreaGroup.visible = false;
      if (lightingAreaKey !== null) {
        lightingAreaGeneration += 1;
        lightingAreaKey = null;
        clearTimeout(lightingAreaTimer);
      }
      return;
    }
    if (lightingAreaGroup) lightingAreaGroup.visible = true;

    // Request a slightly padded, camera-centred rectangle and snap it to a
    // 250 m grid. This keeps requests stable while the user makes small pans.
    const metresPerPixel = cameraState.distance * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      / Math.max(canvas.clientHeight, 1);
    const halfWidth = clamp(canvas.clientWidth * metresPerPixel * 0.38, LIGHTING_AREA_GRID_M * 0.55, 800);
    const halfDepth = clamp(canvas.clientHeight * metresPerPixel * 0.38, LIGHTING_AREA_GRID_M * 0.55, 800);
    const minX = Math.floor((cameraState.target.x - halfWidth) / LIGHTING_AREA_GRID_M) * LIGHTING_AREA_GRID_M;
    const maxX = Math.ceil((cameraState.target.x + halfWidth) / LIGHTING_AREA_GRID_M) * LIGHTING_AREA_GRID_M;
    const minZ = Math.floor((cameraState.target.z - halfDepth) / LIGHTING_AREA_GRID_M) * LIGHTING_AREA_GRID_M;
    const maxZ = Math.ceil((cameraState.target.z + halfDepth) / LIGHTING_AREA_GRID_M) * LIGHTING_AREA_GRID_M;
    const key = `${minX}:${minZ}:${maxX}:${maxZ}:${lightingEffectsRequested ? 1 : 0}`;
    if (key === lightingAreaKey) return;
    lightingAreaKey = key;
    const generation = ++lightingAreaGeneration;
    clearTimeout(lightingAreaTimer);
    const load = async () => {
      const params = new URLSearchParams({
        min_x: String(minX), min_z: String(minZ), max_x: String(maxX), max_z: String(maxZ),
      });
      try {
        const response = await fetch(`/api/lighting/fixtures?${params}`);
        if (!response.ok) throw new Error(`lighting area HTTP ${response.status}`);
        const payload = await response.json();
        if (generation !== lightingAreaGeneration) return;
        const fixtures = Array.isArray(payload.cityFurniture) ? payload.cityFurniture : [];
        const nextGroup = new THREE.Group();
        nextGroup.name = 'nearby-street-lighting';
        makeStreetFurniture(fixtures, nextGroup, {}, { lightingEffects: lightingEffectsRequested });
        if (lightingAreaGroup) {
          layerGroups.cityFurniture.remove(lightingAreaGroup);
          disposeObject(lightingAreaGroup);
        }
        lightingAreaGroup = nextGroup;
        lightingAreaGroup.visible = lightingEnabled;
        layerGroups.cityFurniture.add(nextGroup);
        lightingAreaReady = true;
        if (viewshedState.active) setViewshedContextMaterials(true);
        updateSunStatus();
        requestRender();
      } catch (error) {
        if (generation === lightingAreaGeneration) {
          lightingAreaKey = null;
          console.warn(`Mapped lighting unavailable: ${error.message}`);
        }
      }
    };
    if (immediate) void load();
    else lightingAreaTimer = setTimeout(load, 140);
  }

  function ensureLightingInventory(withNightEffects = false) {
    if (withNightEffects) lightingEffectsRequested = true;
    scheduleLightingAreaLoad(true);
    return Promise.resolve(lightingAreaReady);
  }
  let publicRealmLoaded = false;
  let publicRealmPromise = null;
  async function ensurePublicRealm() {
    const status = document.querySelector('#public-realm-status');
    const summary = document.querySelector('#public-realm-summary');
    if (summary) summary.hidden = false;
    if (publicRealmLoaded) return;
    if (publicRealmPromise) return publicRealmPromise;
    const asset = manifest.assets?.public_realm;
    if (!asset) {
      if (status) status.textContent = 'Public-realm inventory is not available in this scene release.';
      return;
    }
    const version = manifest.layers?.public_realm?.cache_key || manifest.layers?.public_realm?.bytes || 0;
    publicRealmPromise = fetch(`/assets/${asset}?v=${version}`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`public-realm inventory HTTP ${response.status}`)))
      .then(payload => {
        const records = Array.isArray(payload.publicRealm) ? payload.publicRealm : [];
        const crossings = Array.isArray(payload.crossings) ? payload.crossings : [];
        const parking = Array.isArray(payload.parking) ? payload.parking : [];
        if (records.length || crossings.length || parking.length) {
          makeStreetFurniture(records, layerGroups.publicRealm, { crossings, parking });
        }
        const names = {
          busStop: 'bus stops', bench: 'benches', publicToilet: 'public toilets',
          bicycleParking: 'bike-parking points', fountain: 'fountains',
          streetClock: 'street clocks', wasteBasket: 'waste baskets', bollard: 'bollards',
        };
        const counts = manifest.layers?.public_realm?.classes || {};
        const breakdown = Object.entries(counts).filter(([, count]) => count > 0)
          .map(([kind, count]) => `${count} ${names[kind] || kind}`).join(' · ');
        const streetUse = `${crossings.length.toLocaleString()} pedestrian crossings · ${parking.length.toLocaleString()} parking spaces`;
        if (status) status.textContent = `${records.length.toLocaleString()} mapped places${breakdown ? ` · ${breakdown}` : ''} · ${streetUse}.`;
        publicRealmLoaded = true;
        layerGroups.publicRealm.visible = viewshedState.active || Boolean(savedVisibility.publicRealm);
        layerGroups.cityFurniture.visible = layerGroups.publicRealm.visible;
        if (viewshedState.active) setViewshedContextMaterials(true);
        requestRender();
      })
      .catch(error => {
        if (status) status.textContent = `Public-realm layer unavailable (${error.message}). Toggle it off and on to retry.`;
      })
      .finally(() => { publicRealmPromise = null; });
    return publicRealmPromise;
  }

  const heatGroup = new THREE.Group();
  const heatStreetGroup = new THREE.Group();
  heatStreetGroup.renderOrder = 15;
  heatStreetGroup.visible = false;
  const sunDomainGroup = new THREE.Group();
  const windGroup = new THREE.Group();
  const windFocusMarker = new THREE.Group();
  const windFocusRing = new THREE.Mesh(
    new THREE.RingGeometry(9, 12, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd34e, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  windFocusRing.rotation.x = -Math.PI / 2;
  windFocusRing.position.y = 0.5;
  windFocusRing.renderOrder = 1005;
  const windFocusStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.8, 1.2, 18, 10),
    new THREE.MeshBasicMaterial({ color: 0xffe78c, depthTest: false, depthWrite: false }),
  );
  windFocusStem.position.y = 14;
  windFocusStem.renderOrder = 1006;
  const windFocusCap = new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffb739, depthTest: false, depthWrite: false }),
  );
  windFocusCap.position.y = 25;
  windFocusCap.renderOrder = 1007;
  windFocusMarker.add(windFocusRing, windFocusStem, windFocusCap);
  windFocusMarker.visible = false;
  scene.add(windFocusMarker);
  const pollutionGroup = new THREE.Group();
  windGroup.add(pollutionGroup);
  const trafficGroup = new THREE.Group();
  const trafficStatusGroup = new THREE.Group();
  const trafficDrawingGroup = new THREE.Group();
  const permanentStatusGroup = new THREE.Group();
  const liveClosureGroup = new THREE.Group();
  const selectedRoadDirectionGroup = new THREE.Group();
  const scenarioStatusGroup = new THREE.Group();
  trafficStatusGroup.add(permanentStatusGroup, liveClosureGroup, selectedRoadDirectionGroup, scenarioStatusGroup);
  const streetViewGroup = new THREE.Group();
  const walkingRouteGroup = new THREE.Group();
  const localNotesGroup = new THREE.Group();
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
  scene.add(heatGroup, heatStreetGroup, sunDomainGroup, windGroup, trafficStatusGroup, trafficDrawingGroup, trafficGroup, streetViewGroup, walkingRouteGroup, localNotesGroup);

  const heatToggle = document.querySelector('#heat-toggle');
  const heatMetric = document.querySelector('#heat-metric');
  const heatDate = document.querySelector('#heat-date');
  const heatTime = document.querySelector('#heat-time');
  const heatDateControl = document.querySelector('#heat-date-control');
  const heatTimeControl = document.querySelector('#heat-time-control');
  const heatThermalControls = document.querySelector('#heat-thermal-controls');
  const heatScreeningControls = document.querySelector('#heat-screening-controls');
  const heatForecastHint = document.querySelector('#heat-forecast-hint');
  const heatLayerHelp = document.querySelector('#heat-layer-help');
  const heatInspectButton = document.querySelector('#heat-inspect-place');
  const heatInspectResult = document.querySelector('#heat-inspect-result');
  const heatSaveComparison = document.querySelector('#heat-save-comparison');
  const heatComparison = document.querySelector('#heat-comparison');
  const heatForecastControl = document.querySelector('#heat-forecast-control');
  const heatForecastTime = document.querySelector('#heat-forecast-time');
  const heatForecastLabel = document.querySelector('#heat-forecast-label');
  const heatPeriod = document.querySelector('#heat-period');
  const heatPeriodControl = document.querySelector('#heat-period-control');
  const heatClimateControls = document.querySelector('#heat-climate-controls');
  const heatClimateAggregate = document.querySelector('#heat-climate-aggregate');
  const heatClimateSeasonControl = document.querySelector('#heat-climate-season-control');
  const heatClimateSeason = document.querySelector('#heat-climate-season');
  const heatClimateMonth = document.querySelector('#heat-climate-month');
  const heatClimateHour = document.querySelector('#heat-climate-hour');
  const heatClimateMonthLabel = document.querySelector('#heat-climate-month-label');
  const heatClimateHourLabel = document.querySelector('#heat-climate-hour-label');
  const heatScenarioControls = document.querySelector('#heat-scenario-controls');
  const heatScenarioType = document.querySelector('#heat-scenario-type');
  const heatScenarioRadius = document.querySelector('#heat-scenario-radius');
  const heatScenarioRadiusLabel = document.querySelector('#heat-scenario-radius-label');
  const heatScenarioShade = document.querySelector('#heat-scenario-shade');
  const heatScenarioShadeLabel = document.querySelector('#heat-scenario-shade-label');
  const heatScenarioPick = document.querySelector('#heat-scenario-pick');
  const heatPointPick = document.querySelector('#heat-point-pick');
  const heatScenarioRun = document.querySelector('#heat-scenario-run');
  const heatScenarioDelta = document.querySelector('#heat-scenario-delta');
  const heatScenarioBaseline = document.querySelector('#heat-scenario-baseline');
  const heatScenarioStatus = document.querySelector('#heat-scenario-status');
  const heatScenarioSummary = document.querySelector('#heat-scenario-summary');
  const heatClimateMethod = document.querySelector('#heat-climate-method');
  const heatWeatherInputs = document.querySelector('#heat-weather-inputs');
  const heatLoadingState = document.querySelector('#heat-loading-state');
  const heatSeasonProfile = document.querySelector('#heat-season-profile');
  const heatMonthProfile = document.querySelector('#heat-month-profile');
  const heatDayProfile = document.querySelector('#heat-day-profile');
  const heatStatus = document.querySelector('#heat-status');
  const heatProvenance = document.querySelector('#heat-provenance');
  const heatEnergy = document.querySelector('#heat-energy');
  const heatEnergySummary = document.querySelector('#heat-energy-summary');
  const heatLegendMin = document.querySelector('#heat-legend-min');
  const heatLegendMax = document.querySelector('#heat-legend-max');
  const heatSummary = document.querySelector('#heat-summary');
  const heatComfortKpis = document.querySelector('#heat-comfort-kpis');
  const heatKpiScope = document.querySelector('#heat-kpi-scope');
  const heatKpiMethod = document.querySelector('#heat-kpi-method');
  const heatKpiShareHeading = document.querySelector('#heat-kpi-share-heading');
  const heatKpiCells = {
    cold: [document.querySelector('#heat-kpi-cold-share'), document.querySelector('#heat-kpi-cold-hours')],
    comfort: [document.querySelector('#heat-kpi-comfort-share'), document.querySelector('#heat-kpi-comfort-hours')],
    heat: [document.querySelector('#heat-kpi-heat-share'), document.querySelector('#heat-kpi-heat-hours')],
  };
  const heatAverage = document.querySelector('#heat-average');
  const heatPriorityArea = document.querySelector('#heat-priority-area');
  const heatMaximum = document.querySelector('#heat-maximum');
  const heatAverageLabel = document.querySelector('#heat-average-label');
  const heatMaximumLabel = document.querySelector('#heat-maximum-label');
  const heatExplorer = document.querySelector('#heat-explorer');
  const heatDistribution = document.querySelector('#heat-distribution');
  const heatDistributionCount = document.querySelector('#heat-distribution-count');
  const heatExplorerNote = document.querySelector('#heat-explorer-note');
  const heatHotStreets = document.querySelector('#heat-hot-streets');
  const heatCoolStreets = document.querySelector('#heat-cool-streets');
  const heatHotStreetsTitle = document.querySelector('#heat-hot-streets-title');
  const heatCoolStreetsTitle = document.querySelector('#heat-cool-streets-title');
  const heatSurfaceSummary = document.querySelector('#heat-surface-summary');
  const heatSurfaceTypes = document.querySelector('#heat-surface-types');
  const heatStreetMapToggle = document.querySelector('#heat-street-map-toggle');
  const heatStreetMapStatus = document.querySelector('#heat-street-map-status');
  const sunToggle = document.querySelector('#sun-toggle');
  const sunDate = document.querySelector('#sun-date');
  const sunAnalysisDate = document.querySelector('#sun-analysis-date');
  const sunTime = document.querySelector('#sun-time');
  const sunTimeValue = document.querySelector('#sun-time-value');
  const sunTimeTools = document.querySelector('#sun-time-tools');
  const sunPlay = document.querySelector('#sun-play');
  const sunPositionMarker = document.querySelector('#sun-position-marker');
  const sunPositionGlow = document.querySelector('#sun-position-glow');
  const sunPositionAltitude = document.querySelector('#sun-position-altitude');
  const sunPositionCaption = document.querySelector('#sun-position-caption');
  const sunGenerate = document.querySelector('#sun-generate');
  const sunProgress = document.querySelector('#sun-progress');
  const sunStatus = document.querySelector('#sun-status');
  const sunModeButtons = [...document.querySelectorAll('[data-sun-mode]')];
  const sunShadowControls = document.querySelector('#sun-shadow-controls');
  const sunInstantControl = document.querySelector('#sun-instant-control');
  const sunWindowControls = document.querySelector('#sun-window-controls');
  const sunDateTimeHeading = document.querySelector('#sun-date-time-heading');
  const sunHoursMethod = document.querySelector('#sun-hours-method');
  const sunStartTime = document.querySelector('#sun-start-time');
  const sunEndTime = document.querySelector('#sun-end-time');
  const sunStepTime = document.querySelector('#sun-step-time');
  const sunAnalysisSurfaces = document.querySelector('#sun-analysis-surfaces');
  const sunSurfaceResolution = document.querySelector('#sun-surface-resolution');
  const sunDomainSize = document.querySelector('#sun-domain-size');
  const sunCompareDate = document.querySelector('#sun-compare-date');
  const sunCompare = document.querySelector('#sun-compare');
  const sunCompareSwitch = document.querySelector('#sun-compare-switch');
  const sunCompareSummary = document.querySelector('#sun-compare-summary');
  const sunInspect = document.querySelector('#sun-inspect');
  const sunInspectResult = document.querySelector('#sun-inspect-result');
  const sunResultButtons = [...document.querySelectorAll('[data-sun-result]')];
  const sunDetailButtons = [...document.querySelectorAll('[data-sun-detail]')];
  const sunMoveDomain = document.querySelector('#sun-move-domain');
  const sunHoursLegend = document.querySelector('#sun-hours-legend');
  const sunHoursMin = document.querySelector('#sun-hours-min');
  const sunHoursMax = document.querySelector('#sun-hours-max');
  const windToggle = document.querySelector('#wind-toggle');
  const windDirection = document.querySelector('#wind-direction');
  const windSeason = document.querySelector('#wind-season');
  const windStability = document.querySelector('#wind-stability');
  const windComfortCriterion = document.querySelector('#wind-comfort-criterion');
  const windCriterionProvenance = document.querySelector('#wind-criterion-provenance');
  const windForcingMode = document.querySelector('#wind-forcing-mode');
  const windSpeed = document.querySelector('#wind-speed');
  const windSize = document.querySelector('#wind-size');
  const windSpeedValue = document.querySelector('#wind-speed-value');
  const windSizeValue = document.querySelector('#wind-size-value');
  const windStatus = document.querySelector('#wind-status');
  const windSimulate = document.querySelector('#wind-simulate');
  const windResults = document.querySelector('#wind-results');
  const windReport = document.querySelector('#wind-report');
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
  const windGroundMotion = document.querySelector('#wind-ground-motion');
  const windGroundAnimationSpeed = document.querySelector('#wind-ground-animation-speed');
  const windGroundAnimationSpeedValue = document.querySelector('#wind-ground-animation-speed-value');
  const windCfdLoading = document.querySelector('#wind-cfd-loading');
  const windCfdLoadingMessage = document.querySelector('#wind-cfd-loading-message');
  const windLensButtons = [...document.querySelectorAll('[data-wind-lens]')];
  const windPanel = document.querySelector('.wind-panel');
  const windModeBadge = document.querySelector('.wind-mode-badge');
  const windCfdControls = document.querySelector('#wind-cfd-controls');
  const windFlowBoxControls = document.querySelector('#wind-flow-box-controls');
  const windClimateControls = document.querySelector('#wind-climate-controls');
  const windCfdField = document.querySelector('#wind-cfd-field');
  const windCfdViewButtons = [...document.querySelectorAll('[data-cfd-view]')];
  const windGroundControls = document.querySelector('#wind-ground-controls');
  const windCfdGroundHeight = document.querySelector('#wind-cfd-ground-height');
  const windInspectToggle = document.querySelector('#wind-inspect-toggle');
  const windInspectResult = document.querySelector('#wind-inspect-result');
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
  const pollutionControls = document.querySelector('#pollution-controls');
  const pollutionPickSource = document.querySelector('#pollution-pick-source');
  const pollutionSourceStatus = document.querySelector('#pollution-source-status');
  const pollutionDirection = document.querySelector('#pollution-direction');
  const pollutionSourceType = document.querySelector('#pollution-source-type');
  const pollutionTrafficOptions = document.querySelector('#pollution-traffic-options');
  const pollutionTrafficLoadControl = document.querySelector('#pollution-traffic-load-control');
  const pollutionAdvanced = document.querySelector('#pollution-advanced');
  const pollutionPointControls = document.querySelector('#pollution-point-controls');
  const pollutionTrafficScenario = document.querySelector('#pollution-traffic-scenario');
  const pollutionTrafficLoad = document.querySelector('#pollution-traffic-load');
  const pollutionTrafficSeed = document.querySelector('#pollution-traffic-seed');
  const pollutionHeight = document.querySelector('#pollution-height');
  const pollutionTime = document.querySelector('#pollution-time');
  const pollutionTimeLabel = document.querySelector('#pollution-time-label');
  const pollutionPlay = document.querySelector('#pollution-play');
  const pollutionInspectToggle = document.querySelector('#pollution-inspect-toggle');
  const pollutionInspectResult = document.querySelector('#pollution-inspect-result');
  const pollutionResults = document.querySelector('#pollution-results');
  const pollutionLegend = document.querySelector('#pollution-legend');
  const pollutionLegendTitle = document.querySelector('#pollution-legend-title');
  const pollutionGradientLegend = document.querySelector('#pollution-gradient-legend');
  const pollutionContinuousLabels = document.querySelector('#pollution-continuous-labels');
  const pollutionTierLegend = document.querySelector('#pollution-tier-legend');
  const pollutionLegendNote = document.querySelector('#pollution-legend-note');
  const pollutionScaleReference = document.querySelector('#pollution-scale-reference');
  const pollutionAreaRadius = document.querySelector('#pollution-area-radius');
  const pollutionTimelineTitle = document.querySelector('#pollution-timeline-title');
  const pollutionTimeEndpoints = document.querySelector('#pollution-time-endpoints');
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
  const trafficSeedCount = document.querySelector('#traffic-seed-count');
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
  const trafficSelectionList = document.querySelector('#traffic-selection-list');
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
  const trafficUncertainty = document.querySelector('#traffic-uncertainty');
  const trafficCalibrationBadge = document.querySelector('#traffic-calibration-badge');
  const trafficCalibrationStatus = document.querySelector('#traffic-calibration-status');
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
  let sunPlaybackTimer = 0;
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
    comfortCriterionId: windComfortCriterion?.value || 'lawson_lddc_style_screening_v1',
    height: 2,
    forcingMode: windForcingMode?.value || 'era5_climatology',
    analysisMode: 'comfort',
    dataMode: 'cfd',
    cfd: null,
    designGeometryDirty: false,
    loadedCfdCase: null,
    cfdView: 'ground',
    cfdField: 'speed',
    cfdGroundHeight: 2,
    groundMotionVisible: windGroundMotion?.checked !== false,
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
  function syncWindBuildingDetail() {
    if (buildingMeshes.surface) buildingMeshes.surface.visible = true;
  }
  const pollutionState = {
    source: [0, 0],
    sourceMode: pollutionSourceType?.value || 'traffic',
    sourceHeight: Number(pollutionHeight?.value) || 2,
    durationS: 900,
    emissionWindowS: 360,
    parcelWeightG: 1,
    mappedEmissionMassG: null,
    cfdSourceMassG: null,
    topEmissionRoads: [],
    demandMetadata: null,
    trafficRunData: null,
    timeS: 0,
    playing: false,
    lastTime: performance.now(),
    trajectories: [],
    exposureBins: [],
    sourceResidenceByEdge: new Map(),
    receivingArea: null,
    currentExposureSmooth: null,
    exposureThresholds: null,
    runExposureThresholds: null,
    topExposureHotspots: [],
    escaped: 0,
    particleCount: 420,
    studyReady: false,
    streetVisibilityBeforePollution: null,
  };
  const POLLUTION_GRID_SIZE = 112;
  let pollutionStudyRevision = 0;
  let pollutionComparisonScale = null;
  const pollutionSeedHistory = new Map();
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
    roadsLoading: false,
    roadsLoadPromise: null,
    roadsLoadAttempts: 0,
    roadsRetryTimer: null,
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
    strokeStartScreen: null,
    strokePoints: [],
    selectedEdgeIds: [],
  };
  const streetViewState = { placing: false, point: null };
  let heatMesh = null;
  let heatRange = null;
  let heatPayload = null;
  let heatStreetRankings = [];
  let selectedHeatStreet = '';
  let selectedHeatStreetLocation = null;
  let heatStreetSegmentsCache = null;
  const heatZoneRoadCache = new Map();
  let heatCurrentSummary = null;
  let heatSavedComparison = null;
  let analysisGroupMode = null;
  let heatLoadToken = 0;
  let heatLoaded = false;
  let thermalManifest = null;
  let thermalClimatology = null;
  const thermalClimateFrameCache = new Map();
  const thermalClipIndexCache = new Map();
  let thermalEnergy = null;
  let thermalBaselinePayload = null;
  let thermalScenarioPayload = null;
  let thermalScenarioSummary = null;
  let thermalScenarioCenter = null;
  let thermalComparisonPoint = null;
  let sunLoadToken = 0;
  let sunAbortController = null;
  let sunAnalysisId = null;
  let sunSeasonalResults = null;
  let activeSunResult = null;
  let windHeatMesh = null;
  let windPoints = null;
  let windCfdSlice = null;
  let windFacadePressure = null;
  let pollutionSourceMarker = null;
  let pollutionReceivingAreaMarker = null;
  let pollutionSurface = null;
  let pollutionSurfaceTexture = null;
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

  let windSurfaceLastTime = null;
  function updateWindSurfaceMotion(now) {
    const motion = windHeatMesh?.material.userData.surfaceMotion;
    const active = Boolean(motion && windHeatMesh.visible && windGroup.visible && windState.enabled
      && windState.analysisMode === 'direction' && windState.cfdView === 'ground'
      && windState.cfdField === 'speed' && windState.groundMotionVisible
      && !matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (motion) {
      motion.enabled.value = active ? 1 : 0;
      if (active) {
        const seconds = windSurfaceLastTime === null ? 0
          : Math.min(0.1, Math.max(0, (now - windSurfaceLastTime) / 1000)) * windState.animationSpeed * 3;
        motion.update(renderer, seconds);
      }
    }
    windSurfaceLastTime = active ? now : null;
    return active;
  }

  // Initialise and advance the transport target when a newly built surface
  // first becomes visible, so the initial CFD load starts with motion already
  // underway instead of waiting for a later reload to seed it.
  function primeWindSurfaceMotion() {
    const motion = windHeatMesh?.material.userData.surfaceMotion;
    const active = Boolean(motion && windHeatMesh.visible && windGroup.visible && windState.enabled
      && windState.analysisMode === 'direction' && windState.cfdView === 'ground'
      && windState.cfdField === 'speed' && windState.groundMotionVisible
      && !matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (!active) return false;
    motion.enabled.value = 1;
    motion.update(renderer, Math.min(0.1, (1 / 30) * windState.animationSpeed * 3));
    windSurfaceLastTime = performance.now();
    return true;
  }

  function makeWindLayerMaterial(parameters) {
    return new THREE.MeshBasicMaterial(parameters);
  }

  const cameraTouchPointers = new Map();
  let cameraTouchGesture = null;
  let lastCameraTouchTap = 0;
  const windBuildingCellSize = 60;
  const windBuildingGrid = new Map();
  const savedVisibility = Object.fromEntries(
    Object.entries(layerGroups).map(([name, group]) => [name, group.visible]),
  );

  function refreshTransportVehicleLayers() {
    transportLayer?.refreshLayerVisibility?.();
  }

  function syncTrafficSceneVisibility() {
    trafficGroup.visible = trafficState.sceneActive && trafficState.enabled;
    trafficStatusGroup.visible = trafficState.sceneActive && Boolean(trafficRestrictionsToggle?.checked);
    trafficDrawingGroup.visible = trafficState.sceneActive && Boolean(trafficState.selectedEdgeIds.length);
  }

  function restoreNormalVisibility() {
    for (const [name, group] of Object.entries(layerGroups)) group.visible = savedVisibility[name];
    refreshTransportVehicleLayers();
  }

  function syncGroundSurfaceMaterials() {
    const analysisView = Boolean(shadowState.enabled || viewshedState.active || heatToggle?.checked || windToggle?.checked);
    for (const mesh of groundSurfaceMeshes) mesh.visible = !analysisView;
    for (const mesh of pavementOverrideMeshes) mesh.visible = !analysisView || viewshedState.active;
    if (analysisView) layerGroups.groundcover.visible = false;
    if (analysisView) layerGroups.cycling.visible = false;
    if (analysisView) layerGroups.runoff.visible = false;
  }

  function setViewshedContextMaterials(enabled) {
    const contextualLayers = ['roads', 'paths', 'cityFurniture', 'publicRealm'];
    const applyTo = (object, layerName) => {
      if (object === ambientTraffic.group || object === ambientTraffic.signalGroup) return;
      if ((layerName === 'cityFurniture' || layerName === 'publicRealm') && (object.isPoints || object.isPointLight)) {
        if (enabled) {
          if (object.userData.viewshedOriginalVisible === undefined) object.userData.viewshedOriginalVisible = object.visible;
          object.visible = false;
        } else if (object.userData.viewshedOriginalVisible !== undefined) {
          object.visible = object.userData.viewshedOriginalVisible;
          delete object.userData.viewshedOriginalVisible;
        }
      }
      if (object.isMesh && object.material && !Array.isArray(object.material)) {
        const semantic = object.userData.semanticClass || '';
        if (semantic === 'publicLightPool' || semantic === 'publicLightGlow') {
          if (enabled) {
            if (object.userData.viewshedOriginalVisible === undefined) object.userData.viewshedOriginalVisible = object.visible;
            object.visible = false;
          } else if (object.userData.viewshedOriginalVisible !== undefined) {
            object.visible = object.userData.viewshedOriginalVisible;
            delete object.userData.viewshedOriginalVisible;
          }
        } else if (enabled) {
          if (!object.userData.viewshedOriginalMaterial) object.userData.viewshedOriginalMaterial = object.material;
          if (!object.userData.viewshedMaterial) {
            const material = object.material.clone();
            if ('map' in material) material.map = null;
            if ('vertexColors' in material) material.vertexColors = false;
            if (material.color) {
              const isMarking = object.name.startsWith('faded-')
                || ['parkingSpace', 'pedestrianCrossing', 'daisyPetals', 'daisyCentres', 'daisyZebraBands'].includes(semantic);
              material.color.setHex(isMarking ? 0xd8dcda
                : layerName === 'roads' ? 0xe4e8e6
                  : layerName === 'paths' ? 0xf2f3f1 : 0xf3f4f2);
            }
            if (material.emissive) material.emissive.setHex(0x0a0a0a);
            object.userData.viewshedMaterial = material;
          }
          object.material = object.userData.viewshedMaterial;
          if (object.name.startsWith('faded-') || ['parkingSpace', 'pedestrianCrossing'].includes(semantic)) {
            if (object.userData.viewshedOriginalRenderOrder === undefined) object.userData.viewshedOriginalRenderOrder = object.renderOrder;
            object.renderOrder = SCENE_LAYERS.analysisSurface.order + 1;
          }
        } else if (object.userData.viewshedOriginalMaterial) {
          object.material = object.userData.viewshedOriginalMaterial;
          if (object.userData.viewshedOriginalRenderOrder !== undefined) object.renderOrder = object.userData.viewshedOriginalRenderOrder;
        }
      }
      for (const child of object.children) applyTo(child, layerName);
    };
    for (const layerName of contextualLayers) applyTo(layerGroups[layerName], layerName);
  }

  const sectionLayerProfiles = {
    analysis: {
      terrain: true, water: false, grass: false, railways: false,
      paths: false, roads: false, groundcover: false, cycling: false, runoff: false, cityFurniture: false, publicRealm: false, buildings: true, trees: true,
    },
    traffic: {
      terrain: true, water: false, grass: false, railways: false,
      paths: false, roads: true, groundcover: false, cycling: false, runoff: false, cityFurniture: false, publicRealm: false, buildings: true, trees: true,
    },
    transport: {
      terrain: true, water: false, grass: false, railways: true,
      paths: false, roads: true, groundcover: false, cycling: false, runoff: false, cityFurniture: false, publicRealm: false, buildings: true, trees: true,
    },
    viewshed: {
      terrain: true, water: false, grass: false, railways: false,
      paths: true, roads: true, groundcover: false, cycling: false, runoff: false, cityFurniture: true, publicRealm: true, buildings: true, trees: true,
    },
  };

  function applySectionLayerProfile(name) {
    if (name === 'tools') {
      if (!shadowState.enabled && !heatToggle?.checked && !windToggle?.checked && !viewshedState.active) {
        layerGroups.groundcover.visible = Boolean(savedVisibility.groundcover);
        layerGroups.cycling.visible = Boolean(savedVisibility.cycling);
        layerGroups.runoff.visible = Boolean(savedVisibility.runoff);
      }
      return;
    }
    const profile = ['heat', 'sun', 'wind'].includes(name)
      ? sectionLayerProfiles.analysis : sectionLayerProfiles[name];
    if (!profile) return;
    for (const [layerName, visible] of Object.entries(profile)) {
      layerGroups[layerName].visible = visible;
    }
    if (name === 'viewshed') syncGroundSurfaceMaterials();
    syncLayerControls();
    refreshTransportVehicleLayers();
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
    refreshTransportVehicleLayers();
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
    refreshTransportVehicleLayers();
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

  // Wind particle collision checks and facade interactions follow the current
  // scenario geometry. This collision index does not replace the resolved
  // OpenFOAM field; edited geometry still needs a matching solve.
  function rebuildWindBuildingGrid() {
    windBuildingGrid.clear();
    const addBuilding = (ground, height, ring, wallHeight = height, minHeight = 0, holes = []) => {
    if (!ring?.length) return;
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
    };
    data.buildings.forEach(([ground, height, ring, , , wallHeight = height, , , , , minHeight = 0, , , holes = []], index) => {
      if (!designRemovedBuildingIndexes.has(index)) addBuilding(ground, height, ring, wallHeight, minHeight, holes);
    });
    for (const block of designMassingBlocks) {
      const ground = Number.isFinite(block.groundM) ? block.groundM : terrainHeightAt(block.x, block.z) + Number(block.baseOffsetM || 0);
      const ring = block.ring?.length >= 3 ? block.ring : [[block.x - block.width / 2, block.z - block.depth / 2], [block.x + block.width / 2, block.z - block.depth / 2], [block.x + block.width / 2, block.z + block.depth / 2], [block.x - block.width / 2, block.z + block.depth / 2]];
      addBuilding(ground, block.height, ring, block.height, 0, block.holes || []);
    }
  }
  rebuildWindBuildingGrid();

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

  function windBuildingIntervalsAlongSegment(x0, y0, z0, x1, y1, z1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);
    const candidates = new Set();
    for (let row = Math.floor(minZ / windBuildingCellSize); row <= Math.floor(maxZ / windBuildingCellSize); row += 1) {
      for (let column = Math.floor(minX / windBuildingCellSize); column <= Math.floor(maxX / windBuildingCellSize); column += 1) {
        for (const building of windBuildingGrid.get(windCellKey(column, row)) || []) candidates.add(building);
      }
    }
    return segmentBuildingIntervals(x0, y0, z0, x1, y1, z1, [...candidates]);
  }

  function windBuildingOutwardNormal(x, y, z) {
    const boundary = nearestWindBoundary(x, z, y);
    if (!boundary) return null;
    const building = boundary.building;
    const wallDistance = boundary.distance;
    const baseDistance = y - building.baseY;
    const roofDistance = building.roofY - y;
    if (roofDistance <= wallDistance && roofDistance <= baseDistance) return [0, 1, 0];
    if (baseDistance < wallDistance && baseDistance < roofDistance) return [0, -1, 0];
    let normal = [boundary.pointX - x, 0, boundary.pointZ - z];
    let length = Math.hypot(normal[0], normal[2]);
    if (length < 1e-6) {
      normal = [building.centroid[0] - x, 0, building.centroid[1] - z];
      length = Math.hypot(normal[0], normal[2]);
    }
    if (!(length > 0)) return null;
    return [normal[0] / length, 0, normal[2] / length];
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
    const inside = windPointInsideBuilding(x, z, worldY);
    let normalX = x - boundary.pointX;
    let normalZ = z - boundary.pointZ;
    const length = Math.hypot(normalX, normalZ);
    if (length < 0.001) {
      normalX = x - boundary.building.centroid[0];
      normalZ = z - boundary.building.centroid[1];
    }
    if (inside) {
      normalX = -normalX;
      normalZ = -normalZ;
    }
    const normalLength = Math.hypot(normalX, normalZ) || 1;
    return [boundary.pointX + normalX / normalLength * 1.5, boundary.pointZ + normalZ / normalLength * 1.5];
  }

  function requestRender() {
    renderRequested = true;
    if (animationTimer) {
      clearTimeout(animationTimer);
      animationTimer = 0;
    }
    if (sceneReadyToRender && !animationFrame) animationFrame = requestAnimationFrame(render);
  }

  function updateMapHud() {
    const northArrow = document.querySelector('#north-arrow');
    const scaleBar = document.querySelector('#map-scale-bar');
    const scaleLabel = document.querySelector('#map-scale-label');
    if (northArrow) {
      const angle = Math.atan2(-Math.cos(cameraState.azimuth), Math.sin(cameraState.azimuth) * Math.sin(cameraState.elevation));
      northArrow.style.setProperty('--north-angle', `${angle * 180 / Math.PI}deg`);
    }
    if (!scaleBar || !scaleLabel) return;
    const metresPerPixel = cameraState.distance * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(canvas.clientHeight, 1);
    const rawMetres = metresPerPixel * 84;
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawMetres, 0.001)));
    const fraction = rawMetres / magnitude;
    const niceDistance = (fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1) * magnitude;
    scaleBar.style.width = `${clamp(niceDistance / metresPerPixel, 36, 112)}px`;
    scaleLabel.textContent = `≈ ${niceDistance >= 1000 ? `${Number((niceDistance / 1000).toFixed(1))} km` : `${Math.round(niceDistance)} m}`}`;
  }

  function updateStreetNameLabels() {
    if (!streetNameOverlay) return;
    const observerView = Boolean(viewshedPersonCamera && viewshedState.point);
    const enabled = streetNameToggle?.getAttribute('aria-pressed') !== 'false';
    const streetScale = observerView || cameraState.distance <= 880;
    if (!enabled || !streetScale || !namedStreetFeatures.length) {
      const signature = `hidden:${enabled}:${streetScale}`;
      if (signature !== streetNameLabelSignature) {
        streetNameLabelSignature = signature;
        if (streetNameOverlay.childElementCount) streetNameOverlay.replaceChildren();
      }
      return;
    }

    const canvasBounds = canvas.getBoundingClientRect();
    if (canvasBounds.width < 20 || canvasBounds.height < 20) {
      streetNameLabelSignature = 'empty';
      if (streetNameOverlay.childElementCount) streetNameOverlay.replaceChildren();
      return;
    }
    const interfaceBounds = [];
    for (const element of document.querySelectorAll('.panel, .scene-hud-top, .scene-legend, .map-scale, .map-controls, #wind-cfd-loading, #traffic-draw-popup')) {
      if (element.hidden || getComputedStyle(element).display === 'none') continue;
      const bounds = element.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) interfaceBounds.push(bounds);
    }
    const cameraPose = observerView
      ? [camera.position.x, camera.position.y, camera.position.z, camera.rotation.x, camera.rotation.y, camera.rotation.z, camera.fov]
      : [cameraState.distance, cameraState.target.x, cameraState.target.y, cameraState.target.z, cameraState.azimuth, cameraState.elevation, camera.fov];
    const signature = [...cameraPose, canvasBounds.left, canvasBounds.top, canvasBounds.width, canvasBounds.height,
      ...interfaceBounds.flatMap(bounds => [bounds.left, bounds.top, bounds.width, bounds.height])]
      .map(value => Number(value).toFixed(2)).join(':');
    if (signature === streetNameLabelSignature) return;
    streetNameLabelSignature = signature;

    camera.updateMatrixWorld(true);
    let centerX = cameraState.target.x, centerZ = cameraState.target.z;
    let searchRadius = Math.max(90, cameraState.distance * 1.15);
    if (observerView) {
      const direction = camera.getWorldDirection(new THREE.Vector3());
      centerX = camera.position.x + direction.x * 110;
      centerZ = camera.position.z + direction.z * 110;
      searchRadius = 260;
    }
    const radiusSquared = searchRadius * searchRadius;
    const nearestByName = new Map();
    for (const feature of namedStreetFeatures) {
      const gapX = Math.max(feature.minX - centerX, 0, centerX - feature.maxX);
      const gapZ = Math.max(feature.minZ - centerZ, 0, centerZ - feature.maxZ);
      if (gapX * gapX + gapZ * gapZ > radiusSquared) continue;
      const points = feature.points;
      let nearest = null;
      for (let index = 1; index < points.length; index += 1) {
        const [ax, az] = points[index - 1], [bx, bz] = points[index];
        const dx = bx - ax, dz = bz - az;
        const lengthSquared = dx * dx + dz * dz;
        if (!(lengthSquared > 0.01)) continue;
        const amount = clamp(((centerX - ax) * dx + (centerZ - az) * dz) / lengthSquared, 0, 1);
        const x = ax + dx * amount, z = az + dz * amount;
        const distanceSquared = (centerX - x) ** 2 + (centerZ - z) ** 2;
        if (!nearest || distanceSquared < nearest.distanceSquared) nearest = { x, z, distanceSquared };
      }
      if (!nearest || nearest.distanceSquared > radiusSquared) continue;
      const current = nearestByName.get(feature.name);
      if (!current || nearest.distanceSquared < current.distanceSquared) nearestByName.set(feature.name, nearest);
    }

    const projected = new THREE.Vector3();
    const candidates = [];
    for (const [name, point] of nearestByName) {
      projected.set(point.x, roadSurfaceHeightAt(point.x, point.z) + 1.8, point.z).project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const x = canvasBounds.left + (projected.x * 0.5 + 0.5) * canvasBounds.width;
      const y = canvasBounds.top + (-projected.y * 0.5 + 0.5) * canvasBounds.height;
      const width = Math.max(72, name.length * 6.4 + 20);
      const box = { left: x - width / 2, right: x + width / 2, top: y - 34, bottom: y + 5 };
      if (box.left < canvasBounds.left + 7 || box.right > canvasBounds.right - 7
        || box.top < canvasBounds.top + 8 || box.bottom > canvasBounds.bottom - 8) continue;
      candidates.push({ name, x, y, box, distanceSquared: point.distanceSquared });
    }
    candidates.sort((a, b) => a.distanceSquared - b.distanceSquared);

    const reserved = interfaceBounds.map(bounds => ({
      left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
    }));
    const placed = [...reserved];
    const labels = [];
    for (const candidate of candidates) {
      const overlaps = placed.some(box => candidate.box.left < box.right + 8
        && candidate.box.right + 8 > box.left
        && candidate.box.top < box.bottom + 6
        && candidate.box.bottom + 6 > box.top);
      if (overlaps) continue;
      placed.push(candidate.box);
      const label = document.createElement('span');
      label.className = 'street-name-label';
      label.textContent = candidate.name;
      label.style.left = `${candidate.x}px`;
      label.style.top = `${candidate.y - 3}px`;
      labels.push(label);
    }
    streetNameOverlay.replaceChildren(...labels);
  }

  function updateCamera() {
    if (viewshedPersonCamera && viewshedState.point) {
      const { originX, originZ, observerY } = viewshedState.point;
      const heading = viewshedState.heading * Math.PI / 180;
      camera.position.set(originX, observerY, originZ);
      camera.lookAt(originX + Math.sin(heading) * 30, observerY, originZ - Math.cos(heading) * 30);
      scene.fog.near = 1900;
      scene.fog.far = 4600;
      return;
    }
    cameraState.distance = clamp(cameraState.distance, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
    cameraState.elevation = clamp(cameraState.elevation, CAMERA_MIN_ELEVATION, 1.35);
    const horizontal = Math.cos(cameraState.elevation) * cameraState.distance;
    const targetIsOnMap = terrainValidAt(cameraState.target.x, cameraState.target.z);
    const targetGround = targetIsOnMap
      ? terrainSurfaceHeightAt(cameraState.target.x, cameraState.target.z)
      : shadowMinimumY;
    // Keep a stable orbit pivot just above street level. The camera's position
    // remains entirely determined by its distance and elevation, so wheel and
    // pinch zoom do not change direction or jump as the ground approaches.
    if (targetIsOnMap) cameraState.target.y = Math.max(cameraState.target.y, targetGround + 12);
    const targetY = cameraState.target.y;
    camera.position.set(
      cameraState.target.x + Math.cos(cameraState.azimuth) * horizontal,
      targetY + Math.sin(cameraState.elevation) * cameraState.distance,
      cameraState.target.z + Math.sin(cameraState.azimuth) * horizontal,
    );
    camera.lookAt(cameraState.target.x, targetY, cameraState.target.z);
    const atmosphereScale = Math.max(1, cameraState.distance / 1600);
    scene.fog.near = 1900 * atmosphereScale;
    scene.fog.far = 4600 * atmosphereScale;
    updateMapHud();
    // Fine street markings and furniture disappear at district scale. Apart
    // from reducing clutter this avoids spending GPU time on details smaller
    // than a pixel; they return automatically as the camera approaches.
    for (const group of [layerGroups.cityFurniture, layerGroups.publicRealm]) {
      for (const object of group.children) {
        const maxDistance = Number(object.userData?.maxDistance);
        const isStreetLight = String(object.userData?.semanticClass || '').startsWith('publicLight');
        if (maxDistance > 0) object.visible = cameraState.distance <= maxDistance
          && !(shadowState.enabled && isStreetLight)
          && !(viewshedState.active && (object.isPoints || object.isPointLight
            || ['publicLightPool', 'publicLightGlow'].includes(object.userData?.semanticClass)));
      }
    }
    for (const object of layerGroups.railways.children) {
      const minDistance = Number(object.userData?.minDistance) || 0;
      const maxDistance = Number(object.userData?.maxDistance) || 0;
      if (minDistance > 0 || maxDistance > 0) {
        object.visible = (minDistance <= 0 || cameraState.distance >= minDistance)
          && (maxDistance <= 0 || cameraState.distance <= maxDistance);
      }
    }
    for (const group of [layerGroups.roads, layerGroups.paths]) {
      for (const object of group.children) {
        const fade = object.userData?.detailFade;
        if (!fade || !object.material) continue;
        const amount = clamp((cameraState.distance - fade.nearDistance) / (fade.farDistance - fade.nearDistance), 0, 1);
        const visibility = 1 - amount;
        object.visible = visibility > 0.005;
        object.material.opacity = fade.opacity * visibility;
      }
    }
    scheduleLightingAreaLoad();
    updateReportAreaHandles(reportAreaBounds);
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
    updateReportAreaHandles(reportAreaBounds);
    updateMapHud();
  }

  function resizePostProcessing() {
    renderer.getDrawingBufferSize(postSize);
    const width = Math.max(1, Math.round(postSize.x));
    const height = Math.max(1, Math.round(postSize.y));
    if (postTarget.width !== width || postTarget.height !== height) postTarget.setSize(width, height);
    postMaterial.uniforms.resolution.value.set(width, height);
    postMaterial.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
    postMaterial.uniforms.focalPixels.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    postMaterial.uniforms.aoStrength.value = 0.14 + (1 - clamp(cameraState.distance / 6000, 0, 1)) * 0.10;
  }

  function fitScene({ intro = false } = {}) {
    const mapOffset = terrainWidth * 0.15;
    // Shift the world opposite the panel, so the complete city remains in the
    // unobscured canvas area when the controls occupy the right edge.
    const targetX = Math.sin(cameraState.azimuth) * mapOffset;
    const targetZ = -Math.cos(cameraState.azimuth) * mapOffset;
    const targetGround = terrainValidAt(targetX, targetZ) ? terrainSurfaceHeightAt(targetX, targetZ) : shadowMinimumY;
    cameraState.target.set(targetX, targetGround + 12, targetZ);
    const fittedDistance = Math.max(CAMERA_MIN_DISTANCE, Math.min(2800, Math.hypot(terrainWidth, terrainDepth) * 0.76));
    const fittedElevation = 0.57;
    if (intro && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cameraState.distance = Math.min(CAMERA_MAX_DISTANCE, fittedDistance * 1.14);
      cameraState.elevation = fittedElevation + 0.055;
      cameraIntro = {
        startedAt: performance.now(), duration: 1100,
        startDistance: cameraState.distance, endDistance: fittedDistance,
        startElevation: cameraState.elevation, endElevation: fittedElevation,
      };
    } else {
      cameraIntro = null;
      cameraState.distance = fittedDistance;
      cameraState.elevation = fittedElevation;
    }
    updateCamera();
  }

  document.querySelector('#map-zoom-in')?.addEventListener('click', () => {
    cameraIntro = null;
    cameraState.distance = clamp(cameraState.distance * 0.82, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
    updateCamera();
  });
  document.querySelector('#map-zoom-out')?.addEventListener('click', () => {
    cameraIntro = null;
    cameraState.distance = clamp(cameraState.distance / 0.82, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
    updateCamera();
  });
  document.querySelector('#map-fit')?.addEventListener('click', fitScene);
  streetNameToggle?.addEventListener('click', () => {
    const enabled = streetNameToggle.getAttribute('aria-pressed') !== 'true';
    streetNameToggle.setAttribute('aria-pressed', String(enabled));
    streetNameToggle.title = enabled
      ? 'Street names show when zoomed to street level'
      : 'Street names are hidden';
    requestRender();
  });

  // Frame a local-space [minX, minZ, maxX, maxZ] box. Used after a traffic
  // run so the corridor the user just closed fills the view: at full-CBD
  // zoom an individual car is only a few pixels and lost between buildings.
  function frameBounds(bounds, { elevation = 0.5, accountForPanel = false } = {}) {
    if (!bounds || bounds.length !== 4) return;
    const [minX, minZ, maxX, maxZ] = bounds;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const span = Math.max(Math.hypot(maxX - minX, maxZ - minZ), 240);
    cameraState.target.set(centerX, terrainHeightAt(centerX, centerZ) + 15, centerZ);
    cameraState.distance = clamp(span * 0.9, CAMERA_MIN_DISTANCE, 2400);
    cameraState.elevation = elevation;
    if (accountForPanel) {
      const viewport = canvas.getBoundingClientRect();
      const panelRect = document.querySelector('.panel')?.getBoundingClientRect();
      if (panelRect && panelRect.left < viewport.right && panelRect.right > viewport.left) {
        let visibleLeft = viewport.left, visibleRight = viewport.right;
        const panelOverlapsMostHeight = Math.min(viewport.bottom, panelRect.bottom) - Math.max(viewport.top, panelRect.top) > viewport.height * 0.6;
        if (panelOverlapsMostHeight && panelRect.left >= (viewport.left + viewport.right) / 2) {
          visibleRight = Math.min(visibleRight, panelRect.left);
        } else if (panelOverlapsMostHeight && panelRect.right <= (viewport.left + viewport.right) / 2) {
          visibleLeft = Math.max(visibleLeft, panelRect.right);
        }
        const targetScreenOffset = (visibleLeft + visibleRight) / 2 - (viewport.left + viewport.right) / 2;
        const worldPerPixel = 2 * cameraState.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
          * camera.aspect / Math.max(viewport.width, 1);
        cameraState.target.x -= targetScreenOffset * worldPerPixel * Math.sin(cameraState.azimuth);
        cameraState.target.z += targetScreenOffset * worldPerPixel * Math.cos(cameraState.azimuth);
      }
    }
    updateCamera();
  }

  function sunPosition(dateText = shadowState.date, minutes = shadowState.minutes) {
    const [year, month, day] = dateText.split('-').map(Number);
    const date = new Date(Date.UTC(year || 2026, (month || 7) - 1, day || 27));
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
    const hour = minutes / 60;
    const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (hour - 12) / 24);
    const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const latitude = -33.9249 * Math.PI / 180;
    const solarMinutes = minutes + equation + 4 * 18.4241 - 120;
    const hourAngle = (solarMinutes / 4 - 180) * Math.PI / 180;
    const altitude = Math.asin(clamp(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle), -1, 1));
    const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) + Math.PI) % (2 * Math.PI);
    return {
      altitude,
      vector: new THREE.Vector3(Math.sin(azimuth) * Math.cos(altitude), Math.sin(altitude), -Math.cos(azimuth) * Math.cos(altitude)),
    };
  }

  function updateStreetLighting(sun) {
    // Public lights switch on through civil twilight and reach full output
    // after sunset. Solar altitude keeps this tied to both the chosen date
    // and the time slider instead of using a fixed clock threshold.
    const lowerTwilight = THREE.MathUtils.degToRad(-7);
    const upperTwilight = THREE.MathUtils.degToRad(5);
    const progress = clamp((sun.altitude - lowerTwilight) / (upperTwilight - lowerTwilight), 0, 1);
    const eased = progress * progress * (3 - 2 * progress);
    const nightLevel = 1 - eased;
    if (nightLighting.streetBulbMaterial) {
      const dayBulb = new THREE.Color(0x393b37);
      const litBulb = new THREE.Color(0xffc56d);
      nightLighting.streetBulbMaterial.color.copy(dayBulb).lerp(litBulb, nightLevel);
    }
    if (nightLighting.streetGlow) nightLighting.streetGlow.material.opacity = nightLevel * 0.88;
    if (nightLighting.streetPoolMaterial) nightLighting.streetPoolMaterial.opacity = nightLevel * 0.78;
    if (nightLighting.festoonBulbMaterial) {
      const dayBulb = new THREE.Color(0x4a453b);
      const litBulb = new THREE.Color(0xffce78);
      nightLighting.festoonBulbMaterial.color.copy(dayBulb).lerp(litBulb, nightLevel);
    }
    if (nightLighting.festoonGlow) nightLighting.festoonGlow.material.opacity = nightLevel * 0.78;
    for (const light of nightLighting.festoonPointLights) light.intensity = nightLevel * 1.35;
    requestRender();
  }

  function updateSunStatus(message = null) {
    const sun = sunPosition();
    updateStreetLighting(sun);
    updateWeatherSky(skyWeather, sun);
    const hours = String(Math.floor(shadowState.minutes / 60)).padStart(2, '0');
    const minutes = String(shadowState.minutes % 60).padStart(2, '0');
    if (sunTimeValue) sunTimeValue.textContent = `${hours}:${minutes}`;
    updateSunPositionGraphic(sun);
    if (sunStatus) {
      sunStatus.textContent = message || (sun.altitude <= 0
        ? 'Sun is below the horizon at this time.'
        : `Cape Town · ${shadowState.date} · ${hours}:${minutes} · sun altitude ${Math.round(sun.altitude * 180 / Math.PI)}°${shadowState.generated ? '' : ' · preparing shadows…'}`);
    }
  }

  function updateSunPositionGraphic(sun = sunPosition()) {
    const altitudeDegrees = sun.altitude * 180 / Math.PI;
    if (sunPositionAltitude) sunPositionAltitude.textContent = altitudeDegrees > 0
      ? `Altitude ${Math.round(altitudeDegrees)}°` : 'Sun below horizon';
    if (sunPositionMarker && sunPositionGlow) {
      const visible = altitudeDegrees > 0;
      sunPositionMarker.style.display = visible ? '' : 'none';
      sunPositionGlow.style.display = visible ? '' : 'none';
      if (visible) {
        const azimuth = (Math.atan2(sun.vector.x, -sun.vector.z) + Math.PI * 2) % (Math.PI * 2);
        const x = clamp(120 - Math.sin(azimuth) * 100, 20, 220);
        const y = clamp(92 - Math.sin(sun.altitude) * 76, 16, 90);
        sunPositionMarker.setAttribute('cx', x.toFixed(1));
        sunPositionMarker.setAttribute('cy', y.toFixed(1));
        sunPositionGlow.setAttribute('cx', x.toFixed(1));
        sunPositionGlow.setAttribute('cy', y.toFixed(1));
      }
    }
    if (sunPositionCaption) {
      if (altitudeDegrees > 0) {
        sunPositionCaption.textContent = `${Math.round(altitudeDegrees)}° high · ${sun.vector.x < -0.15 ? 'east' : sun.vector.x > 0.15 ? 'west' : 'north'} sky`;
      } else {
        const lunarDate = new Date(`${shadowState.date}T12:00:00+02:00`);
        const ageDays = (lunarDate.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
        const phase = ((ageDays / 29.530588853) % 1 + 1) % 1;
        const illumination = Math.round((0.5 - 0.5 * Math.cos(phase * Math.PI * 2)) * 100);
        sunPositionCaption.textContent = `Moon · ${illumination}% illuminated`;
      }
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
    // Keep the sun-hours city neutral white too, but reserve the direct light
    // and shadow map for the instantaneous shadow study.
    const directShadowStudy = enabled && shadowState.enabled && shadowState.mode === 'shadows';
    sunLight.visible = directShadowStudy && shadowState.generated;
    shadowCatcher.visible = directShadowStudy && shadowState.generated;
    ambient.intensity = directShadowStudy ? 0.5 : 1.72;
    cityFill.color.setHex(enabled ? 0xffffff : 0xffe8c7);
    skyFill.color.setHex(enabled ? 0xffffff : 0xbfe3ef);
    sunLight.color.setHex(enabled ? 0xffffff : 0xfff3d6);
    updateWeatherSky(skyWeather, sunPosition());
    terrainMesh.material.color.setHex(enabled ? terrainMesh.userData.sunColor : terrainMesh.userData.normalColor);
    // The single, non-indexed façade mesh is a receiver and caster for the
    // entire CBD. Receiving its own low-resolution city-wide shadow map creates
    // repeated self-shadow acne across otherwise flat walls. Keep wall faces
    // lit by the sun direction and keep casting shadows onto terrain/roofs.
    if (buildingMeshes.walls) buildingMeshes.walls.receiveShadow = !directShadowStudy;
    for (const mesh of [...[buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean), ...sunModeNeutralMeshes]) {
      mesh.material = enabled
        ? (viewshedState.active && mesh.userData.viewshedMaterial) || mesh.userData.sunMaterial
        : mesh.userData.normalMaterial;
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
    shadowState.enabled = enabled;
    scheduleLightingAreaLoad();
    if (!enabled) {
      // A cumulative calculation may still be running when the user leaves
      // Sunlight. Invalidate it so its late response cannot replace Heat.
      cancelSunHours('', false);
    }
    if (sunToggle) sunToggle.checked = enabled;
    document.body.classList.toggle('sun-mode', enabled);
    if (enabled) {
      windFocusMarker.visible = false;
      if (heatToggle) heatToggle.checked = false;
      setHeatMode(false);
      heatGroup.visible = false;
      layerGroups.terrain.visible = true;
      layerGroups.groundcover.visible = false;
      layerGroups.cycling.visible = false;
      layerGroups.grass.visible = false;
      layerGroups.railways.visible = false;
      layerGroups.paths.visible = false;
      layerGroups.roads.visible = false;
      layerGroups.cityFurniture.visible = false;
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
    refreshTransportVehicleLayers();
    setSunMaterials(enabled);
    syncGroundSurfaceMaterials();
    updateSunBox();
    syncLayerControls();
    updateSunStatus();
    syncDesignImpactLegend();
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
      syncDesignImpactLegend();
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
    syncDesignImpactLegend();
    dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'sun', metadata: {
      description: `Direct shadows · ${shadowState.date} · ${shadowState.minutes} minutes after midnight · mapped geometry, no cloud correction.`,
      date: shadowState.date, minutes: shadowState.minutes, clientOnly: true,
    } } }));
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
    const activePanel = document.querySelector('[data-menu-target].active')?.dataset.menuTarget;
    const waterDisabled = Boolean(shadowState.enabled || heatGroup.visible || windGroup.visible || trafficGroup.visible
      || ['heat', 'sun', 'wind', 'walking', 'traffic', 'transport'].includes(activePanel));
    layerGroups.water.visible = waterDisabled ? false : Boolean(savedVisibility.water);
    document.querySelectorAll('[data-layer]').forEach(input => {
      const group = layerGroups[input.dataset.layer];
      if (!group) return;
      if (input.dataset.layer === 'water') {
        input.disabled = waterDisabled;
        input.title = waterDisabled ? 'Water is hidden while an analysis layer is active.' : 'OpenStreetMap water bodies';
      }
      input.checked = group.visible;
      document.querySelector(`[data-legend-layer="${input.dataset.layer}"]`)
        ?.classList.toggle('is-hidden', !group.visible);
      if (input.dataset.layer === 'groundcover') {
        const summary = document.querySelector('#groundcover-summary');
        if (summary) summary.hidden = !group.visible;
      }
      if (input.dataset.layer === 'cycling') {
        const summary = document.querySelector('#cycling-summary');
        if (summary) summary.hidden = !group.visible;
      }
      if (input.dataset.layer === 'publicRealm') {
        const summary = document.querySelector('#public-realm-summary');
        if (summary) summary.hidden = !group.visible;
      }
    });
  }

  function heatColor(value, minimum, maximum, metric = '', percentileValues = null) {
    const color = new THREE.Color();
    if (metric === 'utci_c') {
      const t = percentileValues ? percentileColorPosition(value, percentileValues)
        : clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
      const stops = utciPalette(minimum, maximum).stops;
      let upper = 1;
      while (upper < stops.length - 1 && t > stops[upper][0]) upper += 1;
      const lower = upper - 1;
      const amount = (t - stops[lower][0]) / (stops[upper][0] - stops[lower][0]);
      return color.setHex(stops[lower][1]).lerp(new THREE.Color(stops[upper][1]), amount);
    }
    if (metric === 'utci_delta_c') {
      const limit = Math.max(Math.abs(minimum), Math.abs(maximum), 0.5);
      const amount = clamp((value + limit) / (2 * limit), 0, 1);
      const stops = [[0, 0x1769aa], [0.5, 0xf3f0df], [1, 0xc73532]];
      const upper = amount <= 0.5 ? 1 : 2;
      const lower = upper - 1;
      return color.setHex(stops[lower][1]).lerp(
        new THREE.Color(stops[upper][1]),
        (amount - stops[lower][0]) / (stops[upper][0] - stops[lower][0]),
      );
    }
    const t = metric === 'utci_absolute_c'
      ? clamp((value - UTCI_COLOR_MIN) / (UTCI_COLOR_MAX - UTCI_COLOR_MIN), 0, 1)
      : clamp((value - minimum) / Math.max(maximum - minimum, 0.001), 0, 1);
    const stops = metric === 'utci_absolute_c' ? utciAbsolutePalette().stops : metric === 'cumulative_sun_hours' ? [
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

  function utciCategory(value) {
    const thresholds = [
      [-40, 'extreme cold stress'], [-27, 'very strong cold stress'],
      [-13, 'strong cold stress'], [0, 'moderate cold stress'],
      [9, 'slight cold stress'], [26, 'no thermal stress'],
      [32, 'moderate heat stress'], [38, 'strong heat stress'],
      [46, 'very strong heat stress'], [Infinity, 'extreme heat stress'],
    ];
    return thresholds.find(([ceiling]) => value < ceiling)?.[1] || 'no thermal stress';
  }

  function syncHeatTemporalControls(metric = heatMetric?.value) {
    const forecast = ['utci_c', 'tmrt_c'].includes(metric);
    const staticSurface = metric === 'sky_view_factor';
    const climate = forecast && heatPeriod?.value === 'climatology';
    const temporal = ['pedestrian_priority_score', 'shade_deficit_score'].includes(metric);
    if (heatLayerHelp) {
      const explanations = {
        utci_c: 'Outdoor heat stress combines air, humidity, wind and radiant temperature. Experimental model estimate, not a street observation.',
        tmrt_c: 'Mean radiant temperature estimates the combined radiant load from sun and surrounding surfaces; it is one UTCI input, not air temperature.',
        sky_view_factor: 'SOLWEIG sky-view factor from the prepared 2 m city surface. Higher values indicate more open sky; lower values indicate greater obstruction from buildings, terrain and canopy.',
        pedestrian_priority_score: 'Screening rank: 70% fixed Summer 2025–26 surface-heat baseline + 30% shade deficit at the selected date and time. Not a health-risk score.',
        pedestrian_heat_exposure_c: 'Satellite-derived exposure proxy in °C. It is not UTCI, PET, air temperature or a measured pedestrian exposure.',
        shade_deficit_score: 'Relative lack of mapped shade at the selected date and time. It does not measure surface temperature or health risk.',
        heat_model_lst_c: 'Modelled land-surface temperature from the Summer 2025–26 product; it is not air temperature.',
        rooftop_temperature_c: 'Land-surface temperature screened onto mapped roofs. It is not a measured roof-membrane temperature.',
      };
      heatLayerHelp.textContent = explanations[metric] || (forecast ? 'Outdoor comfort from air, humidity, wind and radiant heat.' : 'Satellite heat and mapped shade · separate from UTCI.');
    }
    if (heatThermalControls) heatThermalControls.hidden = !forecast && !staticSurface;
    if (heatThermalControls?.firstElementChild) heatThermalControls.firstElementChild.hidden = staticSurface;
    if (heatScreeningControls) heatScreeningControls.hidden = !temporal;
    if (heatDateControl) heatDateControl.hidden = !temporal;
    if (heatTimeControl) heatTimeControl.hidden = !temporal;
    if (heatPeriodControl) heatPeriodControl.hidden = !forecast;
    if (heatForecastHint) heatForecastHint.hidden = !forecast || climate || staticSurface;
    if (heatClimateControls) heatClimateControls.hidden = !climate;
    if (heatClimateSeasonControl) heatClimateSeasonControl.hidden = !climate || heatClimateAggregate?.value !== 'season';
    if (heatClimateMonth?.parentElement) heatClimateMonth.parentElement.hidden = !climate || heatClimateAggregate?.value !== 'month';
    if (heatForecastControl) heatForecastControl.hidden = !forecast || climate || staticSurface;
    if (heatScenarioControls) heatScenarioControls.hidden = !forecast || climate || metric !== 'utci_c';
  }

  function thermalChannel(manifest, name) {
    const index = manifest.channels?.findIndex(channel => channel.name === name) ?? -1;
    if (index < 0) throw new Error(`Thermal channel ${name} is unavailable`);
    return { ...manifest.channels[index], index };
  }

  function selectedThermalFrame() {
    const frames = thermalManifest?.frames || [];
    if (!frames.length) return null;
    const index = clamp(Math.trunc(Number(heatForecastTime?.value || 0)), 0, frames.length - 1);
    return frames[index];
  }

  function thermalGridIndices(grid, stride, rows, columns) {
    const bounds = grid.bounds.map(Number);
    const cacheKey = `${grid.width}:${grid.height}:${grid.resolution_m}:${stride}:${bounds.join(',')}`;
    if (thermalClipIndexCache.has(cacheKey)) return thermalClipIndexCache.get(cacheKey);
    const indices = new Uint32Array(rows * columns * 6);
    let indexOffset = 0;
    const [minX, minZ, maxX, maxZ] = bounds;
    const resolution = Number(grid.resolution_m);
    const intersectionsAt = z => {
      const crossings = [];
      for (const polygon of terrain.footprint || []) for (const ring of polygon || []) {
        for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
          const [x1, z1] = ring[index], [x2, z2] = ring[previous];
          if ((z1 > z) !== (z2 > z)) crossings.push((x2 - x1) * (z - z1) / ((z2 - z1) || Number.EPSILON) + x1);
        }
      }
      crossings.sort((a, b) => a - b);
      return crossings;
    };
    const insideAt = (x, crossings) => {
      if (!terrain.footprint?.length) return true;
      let count = 0;
      while (count < crossings.length && crossings[count] < x) count += 1;
      return count % 2 === 1;
    };
    const vertexColumns = columns + 1;
    for (let row = 0; row < rows; row += 1) {
      const z0 = Math.min(maxZ, minZ + Math.min(grid.height, row * stride) * resolution);
      const z1 = Math.min(maxZ, minZ + Math.min(grid.height, (row + 1) * stride) * resolution);
      const firstCrossings = intersectionsAt(z0 + (z1 - z0) / 3);
      const secondCrossings = intersectionsAt(z0 + 2 * (z1 - z0) / 3);
      for (let column = 0; column < columns; column += 1) {
        const x0 = Math.min(maxX, minX + Math.min(grid.width, column * stride) * resolution);
        const x1 = Math.min(maxX, minX + Math.min(grid.width, (column + 1) * stride) * resolution);
        const topLeft = row * vertexColumns + column;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + vertexColumns;
        const bottomRight = bottomLeft + 1;
        if (insideAt(x0 + (x1 - x0) / 3, firstCrossings)) {
          indices.set([topLeft, bottomLeft, topRight], indexOffset);
          indexOffset += 3;
        }
        if (insideAt(x0 + 2 * (x1 - x0) / 3, secondCrossings)) {
          indices.set([topRight, bottomLeft, bottomRight], indexOffset);
          indexOffset += 3;
        }
      }
    }
    const clippedIndices = indices.slice(0, indexOffset);
    thermalClipIndexCache.set(cacheKey, clippedIndices);
    return clippedIndices;
  }

  function buildThermalMesh(payload) {
    for (const object of heatGroup.children) disposeObject(object);
    heatGroup.clear();
    heatMesh = null;
    analysisGroupMode = 'heat';
    const { manifest, values, metric, range } = payload;
    const grid = manifest.grid;
    const channel = thermalChannel(manifest, metric);
    const channelCount = manifest.channels.length;
    // Render at about 4 m and smoothly extend neighboring model values across
    // masked cells for a continuous visual surface. Point samples and summaries
    // continue to use only cells the model actually calculated.
    const stride = Math.max(1, Math.round(4 / Number(grid.resolution_m)));
    const [minX, minZ, maxX, maxZ] = grid.bounds.map(Number);
    const resolution = Number(grid.resolution_m);
    const sample = (row, column) => {
      const raw = values[(row * grid.width + column) * channelCount + channel.index];
      return raw === manifest.nodata ? null : raw * Number(channel.scale) + Number(channel.offset || 0);
    };
    const rows = Math.ceil(grid.height / stride), columns = Math.ceil(grid.width / stride);
    const displayValues = new Float32Array(rows * columns);
    displayValues.fill(Number.NaN);
    for (let displayRow = 0; displayRow < rows; displayRow += 1) {
      for (let displayColumn = 0; displayColumn < columns; displayColumn += 1) {
        let sum = 0, count = 0;
        for (let dy = 0; dy < stride; dy += 1) for (let dx = 0; dx < stride; dx += 1) {
          const row = displayRow * stride + dy, column = displayColumn * stride + dx;
          if (row >= grid.height || column >= grid.width) continue;
          const value = sample(row, column);
          if (value != null && Number.isFinite(value)) { sum += value; count += 1; }
        }
        if (count >= Math.max(1, Math.ceil(stride * stride * 0.5))) {
          displayValues[displayRow * columns + displayColumn] = sum / count;
        }
      }
    }
    const displayCellCount = rows * columns;
    const imputed = new Uint8Array(displayCellCount);
    const queue = new Int32Array(displayCellCount);
    let queueStart = 0, queueEnd = 0;
    for (let index = 0; index < displayCellCount; index += 1) {
      if (Number.isFinite(displayValues[index])) queue[queueEnd++] = index;
      else imputed[index] = 1;
    }
    if (!queueEnd) throw new Error('selected thermal frame has no valid cells');
    while (queueStart < queueEnd) {
      const index = queue[queueStart++];
      const row = Math.floor(index / columns), column = index - row * columns;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nextRow = row + dy, nextColumn = column + dx;
        if (nextRow < 0 || nextColumn < 0 || nextRow >= rows || nextColumn >= columns) continue;
        const next = nextRow * columns + nextColumn;
        if (Number.isFinite(displayValues[next])) continue;
        displayValues[next] = displayValues[index];
        queue[queueEnd++] = next;
      }
    }
    // Two light smoothing passes soften the nearest-cell fill under buildings
    // and at the extent edges without changing any directly modelled cells.
    const smoothed = new Float32Array(displayCellCount);
    for (let pass = 0; pass < 2; pass += 1) {
      smoothed.set(displayValues);
      for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        if (!imputed[index]) continue;
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const r = row + dy, c = column + dx;
          if (r < 0 || c < 0 || r >= rows || c >= columns) continue;
          sum += displayValues[r * columns + c];
          count += 1;
        }
        if (count) smoothed[index] = displayValues[index] * 0.5 + (sum / count) * 0.5;
      }
      displayValues.set(smoothed);
    }
    const cornerValue = (row, column, fallback) => {
      let sum = 0, count = 0;
      for (const [r, c] of [[row - 1, column - 1], [row - 1, column], [row, column - 1], [row, column]]) {
        if (r < 0 || c < 0 || r >= rows || c >= columns) continue;
        const candidate = displayValues[r * columns + c];
        if (Number.isFinite(candidate)) { sum += candidate; count += 1; }
      }
      return count ? sum / count : fallback;
    };
    const vertexColumns = columns + 1, vertexRows = rows + 1;
    const vertexCount = vertexColumns * vertexRows;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    for (let row = 0; row < vertexRows; row += 1) for (let column = 0; column < vertexColumns; column += 1) {
      const index = row * vertexColumns + column, offset = index * 3;
      const x = Math.min(maxX, minX + Math.min(grid.width, column * stride) * resolution);
      const z = Math.min(maxZ, minZ + Math.min(grid.height, row * stride) * resolution);
      positions[offset] = x;
      positions[offset + 1] = terrainHeightAt(x, z) + 0.5;
      positions[offset + 2] = z;
      const fallback = displayValues[Math.min(row, rows - 1) * columns + Math.min(column, columns - 1)];
      const value = cornerValue(row, column, fallback);
      const color = payload.climatology && metric === 'utci_c'
        ? heatColor(value, UTCI_COLOR_MIN, UTCI_COLOR_MAX, 'utci_absolute_c')
        : metric === 'sky_view_factor'
          ? skyViewFactorColor(value / 100)
          : heatColor(value, range.min, range.max, metric, range.percentiles);
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(thermalGridIndices(grid, stride, rows, columns), 1));
    heatMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    }));
    heatGroup.add(heatMesh);
  }

  function skyViewFactorColor(value) {
    const t = clamp(value, 0, 1);
    const stops = [
      [0, 0.58, 0.20, 0.26],
      [0.5, 0.92, 0.70, 0.30],
      [1, 0.28, 0.70, 0.82],
    ];
    const upper = stops.findIndex(stop => stop[0] >= t);
    const right = stops[Math.max(1, upper)];
    const left = stops[Math.max(0, upper - 1)];
    const blend = (t - left[0]) / Math.max(1e-6, right[0] - left[0]);
    return new THREE.Color(left[1] + (right[1] - left[1]) * blend,
      left[2] + (right[2] - left[2]) * blend,
      left[3] + (right[3] - left[3]) * blend);
  }

  function climateFrame(month, hour) {
    return thermalClimatology?.frames?.find(item => item.month === month && item.hour_local === hour) || null;
  }

  function climateBar(label, value, minimum, maximum, selection, title) {
    const amount = maximum > minimum ? clamp((value - minimum) / (maximum - minimum), 0.025, 1) : 0.5;
    const isUtci = heatMetric?.value === 'utci_c';
    const t = clamp((value - 10) / 40, 0, 1);
    const colorValue = isUtci ? temperatureColor(value) : [16, 8, 0].reduce((hex, shift) => hex
      | Math.round(((0x2b50be >> shift) & 255) * (1 - t) + ((0xed4825 >> shift) & 255) * t) << shift, 0);
    const color = colorValue.toString(16).padStart(6, '0');
    const selected = (selection.month != null && selection.month === Number(heatClimateMonth?.value))
      || (selection.season != null && selection.season === selection.selectedSeason)
      || (selection.hour != null && selection.hour === Number(heatClimateHour?.value));
    const data = Object.entries(selection).filter(([key]) => key !== 'selectedSeason')
      .map(([key, item]) => `data-${key}="${item}"`).join(' ');
    return `<button type="button" class="heat-climate-bar${selected ? ' selected' : ''}" ${data} title="${title}">
      <span class="heat-climate-bar-label">${label}</span><span class="heat-climate-bar-track"><i style="width:${(amount * 100).toFixed(1)}%;background:#${color}"></i></span><b>${value.toFixed(1)}°</b></button>`;
  }

  function renderClimateProfiles() {
    if (!thermalClimatology) return;
    const month = Number(heatClimateMonth?.value || 1);
    const hour = Number(heatClimateHour?.value || 12);
    const metric = heatMetric?.value || 'utci_c';
    const field = metric === 'tmrt_c' ? 'mean_tmrt_c' : 'mean_utci_c';
    const metricLabel = metric === 'tmrt_c' ? 'Tmrt' : 'UTCI';
    document.querySelectorAll('.heat-climate-profile-section > b').forEach((heading, index) => {
      heading.textContent = index === 0 ? `Compare seasons · mean ${metricLabel} at selected hour`
        : index === 1 ? `Compare months · mean ${metricLabel} at selected hour`
          : `Compare times · mean ${metricLabel} in selected month`;
    });
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const seasons = [
      { key: 'summer', label: 'Summer', months: [12, 1, 2] },
      { key: 'autumn', label: 'Autumn', months: [3, 4, 5] },
      { key: 'winter', label: 'Winter', months: [6, 7, 8] },
      { key: 'spring', label: 'Spring', months: [9, 10, 11] },
    ];
    const monthRows = months.map((label, index) => ({ month: index + 1, summary: climateFrame(index + 1, hour)?.summary }));
    const monthValues = monthRows.map(item => item.summary?.[field]).filter(Number.isFinite);
    const monthMin = Math.min(...monthValues), monthMax = Math.max(...monthValues);
    if (heatMonthProfile) heatMonthProfile.innerHTML = monthRows.map((item, index) => item.summary
      ? climateBar(months[index], item.summary[field], monthMin, monthMax, { month: item.month }, `${months[index]} · ${hour.toString().padStart(2, '0')}:00 · mean ${metricLabel} ${item.summary[field].toFixed(1)}°C`)
      : '').join('');

    const seasonRows = seasons.map(item => {
      const weighted = item.months.map(monthId => ({
        value: climateFrame(monthId, hour)?.summary?.[field],
        days: new Date(Date.UTC(2020, monthId, 0)).getUTCDate(),
      })).filter(row => Number.isFinite(row.value));
      const days = weighted.reduce((sum, row) => sum + row.days, 0);
      return { ...item, value: weighted.reduce((sum, row) => sum + row.value * row.days, 0) / Math.max(1, days) };
    });
    const seasonMin = Math.min(...seasonRows.map(item => item.value)), seasonMax = Math.max(...seasonRows.map(item => item.value));
    const activeSeason = heatClimateAggregate?.value === 'season'
      ? heatClimateSeason?.value : seasons.find(item => item.months.includes(month))?.key;
    if (heatSeasonProfile) heatSeasonProfile.innerHTML = seasonRows.map(item => climateBar(
      item.label, item.value, seasonMin, seasonMax,
      { season: item.key, selectedSeason: activeSeason },
      `${item.label} · average of its three monthly composite ${metricLabel} values at ${hour.toString().padStart(2, '0')}:00 · ${item.value.toFixed(1)}°C`,
    )).join('');

    const parts = [
      { label: '00–02', hours: [0, 1, 2], select: 1 }, { label: '03–05', hours: [3, 4, 5], select: 4 },
      { label: '06–08', hours: [6, 7, 8], select: 7 }, { label: '09–11', hours: [9, 10, 11], select: 10 },
      { label: '12–14', hours: [12, 13, 14], select: 13 }, { label: '15–17', hours: [15, 16, 17], select: 16 },
      { label: '18–20', hours: [18, 19, 20], select: 19 }, { label: '21–23', hours: [21, 22, 23], select: 22 },
    ].map(part => ({ ...part, value: part.hours.reduce((sum, item) => sum + (climateFrame(month, item)?.summary?.[field] || 0), 0) / part.hours.length }));
    const partMin = Math.min(...parts.map(item => item.value)), partMax = Math.max(...parts.map(item => item.value));
    if (heatDayProfile) heatDayProfile.innerHTML = parts.map(item => climateBar(
      item.label, item.value, partMin, partMax, { hour: item.select },
      `${item.label} local time · average monthly-composite ${metricLabel} ${item.value.toFixed(1)}°C`,
    )).join('');
  }

  async function getClimateFrameValues(frame) {
    if (!thermalClimateFrameCache.has(frame.id)) {
      const response = await fetch(`${windApi}/thermal/climatology/frames/${encodeURIComponent(frame.id)}`);
      if (!response.ok) throw new Error(`historical climate map HTTP ${response.status}`);
      thermalClimateFrameCache.set(frame.id, new Int16Array(await response.arrayBuffer()));
    }
    return thermalClimateFrameCache.get(frame.id);
  }

  function renderThermalKpiBands(bands, scope, method, hoursAvailable = false) {
    if (!heatComfortKpis) return;
    const bandById = new Map((bands || []).map(item => [item.id, item]));
    const ids = { cold: 'cold_stress', comfort: 'no_thermal_stress', heat: 'heat_stress' };
    for (const [key, id] of Object.entries(ids)) {
      const item = bandById.get(id);
      const [shareNode, hoursNode] = heatKpiCells[key] || [];
      if (shareNode) shareNode.textContent = item?.area_time_share_pct == null
        ? '—' : `${Number(item.area_time_share_pct).toFixed(1)}%`;
      if (hoursNode) hoursNode.textContent = hoursAvailable && item?.equivalent_hours_per_mapped_cell != null
        ? `${Number(item.equivalent_hours_per_mapped_cell).toLocaleString()} h` : '—';
    }
    if (heatKpiScope) heatKpiScope.textContent = scope;
    if (heatKpiMethod) heatKpiMethod.textContent = method;
    if (heatKpiShareHeading) heatKpiShareHeading.textContent = hoursAvailable ? 'Area-time share' : 'Area at selected hour';
    heatComfortKpis.hidden = false;
  }

  async function loadClimatology(metric, loadToken) {
    if (!thermalClimatology) {
      const response = await fetch(`${windApi}/thermal/climatology`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `historical climate product HTTP ${response.status}`);
      thermalClimatology = payload;
      if (heatClimateMethod) {
        const baseline = payload.baseline || {};
        heatClimateMethod.textContent = `${payload.source?.dataset || 'ERA5'} · ${baseline.start_year}–${baseline.end_year} · ${payload.grid?.resolution_m} m overview grid. ${payload.method}`;
      }
    }
    if (loadToken !== heatLoadToken) return;
    const month = Number(heatClimateMonth?.value || 1);
    const hour = Number(heatClimateHour?.value || 12);
    if (heatClimateMonthLabel) heatClimateMonthLabel.textContent = new Date(Date.UTC(2020, month - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
    if (heatClimateHourLabel) heatClimateHourLabel.textContent = `${hour.toString().padStart(2, '0')}:00 SAST`;
    renderClimateProfiles();
    const aggregate = heatClimateAggregate?.value || 'month';
    const selectedSeason = heatClimateSeason?.value || 'summer';
    const seasonMonths = {
      summer: [12, 1, 2], autumn: [3, 4, 5], winter: [6, 7, 8], spring: [9, 10, 11],
    };
    const monthList = aggregate === 'annual' ? Array.from({ length: 12 }, (_, index) => index + 1)
      : aggregate === 'season' ? seasonMonths[selectedSeason] : [month];
    const sourceFrames = monthList.map(monthId => climateFrame(monthId, hour)).filter(Boolean);
    if (!sourceFrames.length) throw new Error(`no climate maps for ${aggregate} at ${hour}:00`);
    const sourceValues = await Promise.all(sourceFrames.map(getClimateFrameValues));
    if (loadToken !== heatLoadToken) return;
    const channel = thermalChannel(thermalClimatology, metric);
    let values;
    if (sourceValues.length === 1) values = sourceValues[0];
    else {
      const pixels = thermalClimatology.grid.width * thermalClimatology.grid.height;
      const sums = new Float64Array(pixels), weights = new Float32Array(pixels);
      sourceValues.forEach((source, index) => {
        const days = new Date(Date.UTC(2020, sourceFrames[index].month, 0)).getUTCDate();
        for (let pixel = 0; pixel < pixels; pixel++) {
          const raw = source[pixel * thermalClimatology.channels.length + channel.index];
          if (raw === thermalClimatology.nodata) continue;
          sums[pixel] += raw * days;
          weights[pixel] += days;
        }
      });
      values = new Int16Array(pixels);
      for (let pixel = 0; pixel < pixels; pixel++) {
        values[pixel] = weights[pixel]
          ? Math.round(sums[pixel] / weights[pixel])
          : thermalClimatology.nodata;
      }
    }
    const range = thermalClimatology.color_ranges?.[metric] || thermalClimatology.color_range || { min: -10, max: 50 };
    const legendGradient = document.querySelector('.heat-gradient');
    if (legendGradient) legendGradient.style.background = metric === 'utci_c' ? utciAbsolutePalette().gradient : '';
    const displayManifest = sourceValues.length === 1 ? thermalClimatology : {
      ...thermalClimatology, channels: [channel],
    };
    heatPayload = { thermal: true, climatology: true, manifest: displayManifest, values, metric, range };
    heatRange = range;
    if (heatToggle?.checked && !shadowState.enabled) buildThermalMesh(heatPayload);
    const stats = [];
    for (let pixel = 0; pixel < values.length / displayManifest.channels.length; pixel++) {
      const raw = values[pixel * displayManifest.channels.length + (sourceValues.length === 1 ? channel.index : 0)];
      if (raw !== thermalClimatology.nodata) stats.push(raw * channel.scale + Number(channel.offset || 0));
    }
    stats.sort((a, b) => a - b);
    const mean = stats.length ? stats.reduce((sum, value) => sum + value, 0) / stats.length : NaN;
    const percentile90 = stats.length ? stats[Math.floor((stats.length - 1) * 0.9)] : NaN;
    const hotThreshold = metric === 'utci_c' ? 26 : Infinity;
    heatPriorityArea.textContent = metric === 'utci_c'
      ? `${(stats.filter(value => value >= hotThreshold).length / Math.max(1, stats.length) * 100).toFixed(1)}%` : '—';
    if (heatAverageLabel) heatAverageLabel.textContent = metric === 'utci_c' ? 'Mean UTCI' : 'Mean Tmrt';
    if (heatMaximumLabel) heatMaximumLabel.textContent = metric === 'utci_c' ? 'P90 UTCI' : 'P90 Tmrt';
    if (heatPriorityArea?.nextElementSibling) heatPriorityArea.nextElementSibling.textContent = 'Area UTCI ≥ 26°C';
    heatSummary.hidden = false;
    heatLegendMin.textContent = metric === 'utci_c' ? `≤ ${UTCI_COLOR_MIN}°C` : `${Number(range.min).toFixed(0)}°C`;
    heatLegendMax.textContent = metric === 'utci_c' ? `≥ ${UTCI_COLOR_MAX}°C` : `${Number(range.max).toFixed(0)}°C`;
    const localHour = `${hour.toString().padStart(2, '0')}:00`;
    const periodLabel = aggregate === 'annual' ? 'Annual composite' : aggregate === 'season'
      ? `${selectedSeason[0].toUpperCase()}${selectedSeason.slice(1)} mean` : sourceFrames[0].month_name;
    if (metric === 'utci_c') {
      const kpiParams = new URLSearchParams({ aggregate, month: String(month), season: selectedSeason });
      try {
        const kpiResponse = await fetch(`${windApi}/thermal/climatology/kpis?${kpiParams}`);
        if (!kpiResponse.ok) throw new Error(`KPI HTTP ${kpiResponse.status}`);
        const kpis = await kpiResponse.json();
        if (loadToken === heatLoadToken) {
          const baseline = kpis.baseline_years || [];
          renderThermalKpiBands(
            kpis.bands,
            `${periodLabel} · representative year · ${Number(kpis.representative_period_hours).toLocaleString()} h · ${baseline[0]}–${baseline[1]}`,
            kpis.method,
            true,
          );
        }
      } catch (error) {
        if (heatComfortKpis) heatComfortKpis.hidden = true;
        if (heatKpiMethod) heatKpiMethod.textContent = 'Historical category area-time summary is unavailable.';
      }
    } else if (heatComfortKpis) heatComfortKpis.hidden = true;
    heatStatus.textContent = `${metric === 'utci_c' ? 'UTCI' : 'Tmrt'} · ${periodLabel} · ${localHour} SAST · 2016–2025 climate composite`;
    renderHeatExplorer(heatPayload, channel);
    if (heatWeatherInputs) heatWeatherInputs.hidden = true;
    if (heatEnergy) heatEnergy.hidden = true;
    const legendHelp = document.querySelector('#heat-legend-help');
    if (legendHelp) legendHelp.textContent = 'The same temperature scale is used for every month and hour. Masked cells are blended for map continuity; point values and summaries use calculated cells only.';
    if (heatProvenance) heatProvenance.textContent = `Historical reanalysis composite · not a live forecast or observed street-level UTCI · ${thermalClimatology.validation_status.replaceAll('_', ' ')}.`;
    dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'heat', metadata: {
      description: `${periodLabel}, ${localHour} SAST · ERA5 ${thermalClimatology.baseline.start_year}–${thermalClimatology.baseline.end_year} climate composite`,
      metric, valid_at: sourceFrames[0].valid_at, validation_status: thermalClimatology.validation_status,
      metric_label: metric === 'utci_c' ? 'Outdoor comfort (UTCI)' : metric === 'tmrt_c' ? 'Mean radiant temperature (Tmrt)' : 'Heat measure',
      period_label: periodLabel,
      climatology: true, aggregate, month, season: selectedSeason, local_hour: hour,
      manifest_generated_at: thermalClimatology.generated_at,
      manifest_sha256: thermalClimatology.manifest_sha256, models: thermalClimatology.models,
      grid: thermalClimatology.grid,
      source_frames: sourceFrames.map(frame => ({ id: frame.id, valid_at: frame.valid_at, sha256: frame.sha256, bytes: frame.bytes })),
      kpis: {
        mean, p90: percentile90, valid_cell_count: stats.length,
        hotspot_area_pct: metric === 'utci_c' ? stats.filter(value => value >= 26).length / Math.max(1, stats.length) * 100 : null,
      },
    } } }));
  }

  async function loadThermal(metric, loadToken) {
    if (loadToken !== heatLoadToken) return;
    let staticSurfaceManifest = null;
    if (metric === 'sky_view_factor') {
      const manifestResponse = await fetch(`${windApi}/thermal/sky-view-factor/manifest`);
      const payload = await manifestResponse.json().catch(() => ({}));
      if (!manifestResponse.ok) throw new Error(payload.detail || `sky-view-factor manifest HTTP ${manifestResponse.status}`);
      staticSurfaceManifest = payload;
    }
    if (metric !== 'sky_view_factor' && !thermalManifest) {
      let payload;
      while (loadToken === heatLoadToken) {
        const response = await fetch(`${windApi}/thermal/forecast`);
        payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || `forecast HTTP ${response.status}`);
        if (payload.available === false) {
          if (payload.status === 'not_started') {
            throw new Error('Thermal worker is not running. Install its dependencies with `.venv/bin/python -m pip install -r requirements-models.txt`, then start it with `.venv/bin/python -m server.thermal_worker`.');
          }
          if (payload.status === 'failed') {
            throw new Error(`Thermal worker failed during ${payload.worker?.phase || 'model execution'}. Check its terminal output, then restart it.`);
          }
          const phase = String(payload.worker?.phase || 'starting').replaceAll('_', ' ');
          heatStatus.textContent = `Preparing UTCI forecast · ${phase}…`;
          await new Promise(resolve => setTimeout(resolve, 15000));
          continue;
        }
        break;
      }
      if (loadToken !== heatLoadToken) return;
      const publishedFrames = (payload.frames || []).filter(frame => frame
        && typeof frame.id === 'string' && typeof frame.file === 'string'
        && Number.isFinite(Date.parse(frame.valid_at)))
        .sort((a, b) => Date.parse(a.valid_at) - Date.parse(b.valid_at));
      if (!publishedFrames.length) throw new Error('The forecast has no available time frames yet. Wait for the thermal worker to publish data.');
      thermalManifest = { ...payload, frames: publishedFrames };
      if (heatForecastTime) {
        heatForecastTime.max = String(thermalManifest.frames.length - 1);
        heatForecastTime.value = String(clamp(Number(heatForecastTime.value || 0), 0, thermalManifest.frames.length - 1));
        heatForecastTime.disabled = thermalManifest.frames.length < 2;
      }
      fetch(`${windApi}/thermal/energy?run_id=${encodeURIComponent(thermalManifest.run_id)}`)
        .then(response => response.ok ? response.json() : null).then(payload => { thermalEnergy = payload; }).catch(() => {});
    }
    const frame = metric === 'sky_view_factor' ? null : selectedThermalFrame();
    if (metric !== 'sky_view_factor' && !frame) throw new Error('forecast contains no frames');
    if (metric === 'sky_view_factor') {
      const response = await fetch(`${windApi}/thermal/sky-view-factor`);
      if (!response.ok) throw new Error(`sky-view-factor grid HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const expectedBytes = staticSurfaceManifest.grid.width * staticSurfaceManifest.grid.height * Int16Array.BYTES_PER_ELEMENT;
      if (buffer.byteLength !== expectedBytes) {
        throw new Error(`sky-view-factor grid is incomplete (${buffer.byteLength} of ${expectedBytes} bytes)`);
      }
      const values = new Int16Array(buffer);
      const channel = staticSurfaceManifest.channels[0];
      const manifest = staticSurfaceManifest;
      if (loadToken !== heatLoadToken) return;
      let sum = 0, validCells = 0, maximum = -Infinity, highVisibilityCells = 0;
      const samples = [];
      const sampleStride = Math.max(1, Math.floor(values.length / 100000));
      for (let index = 0; index < values.length; index += 1) {
        if (values[index] === manifest.nodata) continue;
        const value = values[index] * channel.scale;
        sum += value;
        validCells += 1;
        maximum = Math.max(maximum, value);
        if (value >= 90) highVisibilityCells += 1;
        if ((validCells - 1) % sampleStride === 0) samples.push(value);
      }
      if (!validCells || !samples.length) throw new Error('sky-view-factor grid has no valid ground cells');
      samples.sort((a, b) => a - b);
      const percentile = fraction => samples[Math.round((samples.length - 1) * fraction)];
      const range = { min: 0, max: 100, percentiles: Array.from({ length: 81 }, (_, index) => percentile(0.1 + index / 100)) };
      heatPayload = { thermal: true, manifest, values, metric, range };
      thermalBaselinePayload = heatPayload;
      thermalScenarioPayload = null;
      thermalScenarioSummary = null;
      if (heatScenarioDelta) heatScenarioDelta.disabled = true;
      if (heatScenarioBaseline) heatScenarioBaseline.disabled = true;
      if (heatScenarioSummary) heatScenarioSummary.hidden = true;
      heatRange = range;
      if (heatToggle?.checked && !shadowState.enabled) buildThermalMesh(heatPayload);
      const mean = sum / validCells;
      renderHeatSummary({ area_weighted_mean: mean, maximum,
        hotspot_area_m2: highVisibilityCells * Number(manifest.grid.resolution_m) ** 2,
        hotspot_area_pct: highVisibilityCells / validCells * 100 }, channel);
      renderHeatExplorer(heatPayload, channel);
      const legend = document.querySelector('.heat-gradient');
      if (legend) legend.style.background = 'linear-gradient(90deg, #943440, #ebaf4d 50%, #47b3d1)';
      heatLegendMin.textContent = '0% · obstructed';
      heatLegendMax.textContent = '100% · open';
      heatStatus.textContent = 'SOLWEIG sky-view factor · static surface model';
      heatForecastLabel.textContent = 'Static surface';
      if (heatProvenance) heatProvenance.textContent = `SOLWEIG sky-view factor · ${manifest.grid.resolution_m} m surface grid · higher values mean a larger visible sky hemisphere. Static geometry product reused by the hourly thermal runs.`;
      if (heatAverageLabel) heatAverageLabel.textContent = 'Mean SVF';
      if (heatMaximumLabel) heatMaximumLabel.textContent = 'Maximum SVF';
      if (heatPriorityArea?.nextElementSibling) heatPriorityArea.nextElementSibling.textContent = 'SVF ≥ 90%';
      return;
    }
    let response;
    try {
      response = await fetch(`${windApi}/thermal/frames/${encodeURIComponent(thermalManifest.run_id)}/${encodeURIComponent(frame.id)}`);
    } catch (error) {
      if (![404, 422].includes(error.status)) throw error;
      const failedIndex = thermalManifest.frames.findIndex(item => item.id === frame.id);
      const frames = thermalManifest.frames.filter(item => item.id !== frame.id);
      if (!frames.length) throw new Error('The API has no readable forecast frames. Wait for the thermal worker to publish a complete forecast.');
      thermalManifest = { ...thermalManifest, frames };
      if (heatForecastTime) {
        heatForecastTime.max = String(frames.length - 1);
        heatForecastTime.value = String(clamp(failedIndex, 0, frames.length - 1));
        heatForecastTime.disabled = frames.length < 2;
      }
      heatStatus.textContent = `Skipping unavailable ${new Date(frame.valid_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' })} frame; loading the nearest available time.`;
      return loadThermal(metric, loadToken);
    }
    if (!response.ok) throw new Error(`frame HTTP ${response.status}`);
    const frameBuffer = await response.arrayBuffer();
    const expectedBytes = thermalManifest.grid.width * thermalManifest.grid.height
      * thermalManifest.channels.length * Int16Array.BYTES_PER_ELEMENT;
    if (frameBuffer.byteLength !== expectedBytes) {
      throw new Error(`forecast frame is incomplete (${frameBuffer.byteLength} of ${expectedBytes} bytes)`);
    }
    const values = new Int16Array(frameBuffer);
    if (loadToken !== heatLoadToken) return;
    const channel = thermalChannel(thermalManifest, metric);
    const sampleValues = [];
    let total = 0, validCells = 0, maximum = -Infinity, hotspotCells = 0;
    let coldStressCells = 0, noStressCells = 0, heatStressCells = 0;
    const sampleStride = Math.max(1, Math.floor(thermalManifest.grid.width * thermalManifest.grid.height / 100000));
    for (let pixel = 0; pixel < thermalManifest.grid.width * thermalManifest.grid.height; pixel++) {
      const raw = values[pixel * thermalManifest.channels.length + channel.index];
      if (raw === thermalManifest.nodata) continue;
      const value = raw * channel.scale + Number(channel.offset || 0);
      total += value;
      validCells++;
      maximum = Math.max(maximum, value);
      if (metric === 'utci_c') {
        if (value < 9) coldStressCells++;
        else if (value < 26) noStressCells++;
        else heatStressCells++;
        if (value >= 32) hotspotCells++;
      }
      // Sample by valid-cell count, rather than fixed pixel positions. The
      // latter can miss every valid cell in sparse frames and falsely report
      // that an otherwise usable forecast frame is empty.
      if ((validCells - 1) % sampleStride === 0) {
        sampleValues.push(value);
      }
    }
    sampleValues.sort((a, b) => a - b);
    if (!validCells || !sampleValues.length) throw new Error('selected thermal frame has no valid cells');
    const percentile = fraction => sampleValues[Math.round((sampleValues.length - 1) * fraction)];
    const percentiles = Array.from({ length: 81 }, (_, index) => percentile(0.1 + index / 100));
    const range = { min: percentiles[0], max: percentiles.at(-1), percentiles };
    const legendGradient = document.querySelector('.heat-gradient');
    if (legendGradient) legendGradient.style.background = metric === 'utci_c' ? utciPalette(range.min, range.max).gradient : '';
    heatPayload = { thermal: true, manifest: thermalManifest, values, metric, range };
    thermalBaselinePayload = heatPayload;
    thermalScenarioPayload = null;
    thermalScenarioSummary = null;
    if (heatScenarioDelta) heatScenarioDelta.disabled = true;
    if (heatScenarioBaseline) heatScenarioBaseline.disabled = true;
    if (heatScenarioSummary) heatScenarioSummary.hidden = true;
    heatRange = range;
    if (heatToggle?.checked && !shadowState.enabled) buildThermalMesh(heatPayload);
    const mean = total / validCells;
    renderHeatSummary({
      area_weighted_mean: mean, maximum,
      hotspot_area_m2: metric === 'utci_c' ? hotspotCells * Number(thermalManifest.grid.resolution_m) ** 2 : 0,
      hotspot_area_pct: metric === 'utci_c' ? hotspotCells / Math.max(1, validCells) * 100 : 0,
    }, channel);
    if (metric === 'utci_c') {
      renderThermalKpiBands([
        { id: 'cold_stress', area_time_share_pct: coldStressCells / validCells * 100 },
        { id: 'no_thermal_stress', area_time_share_pct: noStressCells / validCells * 100 },
        { id: 'heat_stress', area_time_share_pct: heatStressCells / validCells * 100 },
      ], `Selected forecast hour · ${new Date(frame.valid_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })} SAST`,
      'Spatial area share for this modeled hour only; no period-hours estimate is inferred from the single frame.');
    } else if (heatComfortKpis) heatComfortKpis.hidden = true;
    renderHeatExplorer(heatPayload, channel);
    if (metric === 'utci_c') {
      heatLegendMin.textContent = `P10 ${formatHeatValue(range.min, channel)}`;
      heatLegendMax.textContent = `P90 ${formatHeatValue(range.max, channel)}`;
    } else {
      heatLegendMin.textContent = `P10 ${formatHeatValue(range.min, channel)}`;
      heatLegendMax.textContent = `P90 ${formatHeatValue(range.max, channel)}`;
    }
    const validDate = new Date(frame.valid_at);
    heatForecastLabel.textContent = `${validDate.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} SAST`;
    const forcing = frame.forcing || {};
    const hasWeatherWarnings = Array.isArray(forcing.weather_warnings) && forcing.weather_warnings.length > 0;
    const refreshFailure = thermalManifest.refresh?.state === 'failed'
      ? ` · latest refresh failed during ${String(thermalManifest.refresh.phase || 'model execution').replaceAll('_', ' ')}`
      : '';
    heatStatus.textContent = `${metric === 'utci_c' ? 'UTCI' : 'Tmrt'} · ${thermalManifest.stale ? 'stale forecast' : hasWeatherWarnings ? 'forecast inputs need checking' : 'model forecast · not observed'}${refreshFailure}`;
    const inputs = forcing.inputs || {};
    const weatherInputs = document.querySelector('#heat-weather-inputs');
    if (weatherInputs) {
      weatherInputs.hidden = false;
      weatherInputs.textContent = `Forecast air ${inputs.temperature_2m_c == null ? 'unavailable' : Number(inputs.temperature_2m_c).toFixed(1) + '°C'} · no CBD observation.`;
    }
    const inputSummary = inputs.temperature_2m_c == null ? '' : ` · Air input ${Number(inputs.temperature_2m_c).toFixed(1)}°C, ${Math.round(inputs.relative_humidity_2m_pct)}% RH${inputs.cloud_cover_pct == null ? '' : `, ${Math.round(inputs.cloud_cover_pct)}% cloud`}${inputs.global_radiation_wm2 == null ? '' : `, ${Math.round(inputs.global_radiation_wm2)} W/m² shortwave`}`;
    const generated = new Date(thermalManifest.generated_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const sources = forcing.sources?.join(' + ') || 'Open-Meteo model forecast';
    const station = forcing.station?.id ? ` · ${forcing.station.id} station report ${forcing.observed_at ? new Date(forcing.observed_at).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' }) + ' SAST' : ''}` : '';
    const modelSpread = forcing.model_spread || {};
    const temperatureSpread = modelSpread.temperature_2m;
    const windSpread = modelSpread.wind_speed_10m;
    const spreadSummary = [];
    if (temperatureSpread?.low != null && temperatureSpread?.high != null) {
      spreadSummary.push(`model air range ${Number(temperatureSpread.low).toFixed(1)}–${Number(temperatureSpread.high).toFixed(1)}°C`);
    }
    if (windSpread?.low != null && windSpread?.high != null) {
      spreadSummary.push(`model wind range ${Number(windSpread.low).toFixed(1)}–${Number(windSpread.high).toFixed(1)} m/s`);
    }
    const weatherWarnings = Array.isArray(forcing.weather_warnings) ? forcing.weather_warnings : [];
    const qualitySummary = weatherWarnings.length
      ? ` · Weather check: ${weatherWarnings.join('; ')}`
      : spreadSummary.length ? ` · ${spreadSummary.join('; ')}` : '';
    const radiationTiming = document.querySelector('#heat-radiation-timing');
    const radiationInfo = forcing.radiation;
    if (radiationTiming) {
      radiationTiming.hidden = !radiationInfo;
      if (radiationInfo) {
        const end = new Date(radiationInfo.interval_end);
        const endLabel = end.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const elapsed = Math.round((Date.now() - end.getTime()) / 60000);
        const age = elapsed >= 0 ? ` · ${elapsed} min old` : ' · forecast';
        const weatherTime = new Date(forcing.weather_valid_at || frame.valid_at).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' });
        radiationTiming.textContent = `${radiationInfo.source}: ${radiationInfo.averaging_minutes}-min mean ending ${endLabel} SAST${age}. Direct ${Math.round(inputs.direct_radiation_wm2)} + diffuse ${Math.round(inputs.diffuse_radiation_wm2)} W/m². Air/wind forecast: ${weatherTime} SAST.`;
      }
    }
    const auditPanel = document.querySelector('#heat-radiation-audit');
    const auditSummary = document.querySelector('#heat-radiation-audit-summary');
    const diagnostics = frame.radiation_diagnostics;
    if (auditPanel) auditPanel.hidden = !diagnostics;
    if (diagnostics && auditSummary) {
      const flux = key => diagnostics[key]?.mean?.toFixed(0) ?? '—';
      auditSummary.textContent = `Ground-area model means: incoming sunlight ${flux('kdown_wm2')}, reflected sunlight ${flux('kup_wm2')}, downward thermal radiation ${flux('ldown_wm2')}, upward thermal radiation ${flux('lup_wm2')} W/m². Mean radiant temperature ${diagnostics.tmrt_c?.mean?.toFixed(1)}°C. UTCI with radiant temperature set to air temperature: ${diagnostics.utci_without_radiant_excess_c?.mean?.toFixed(1)}°C (diagnostic comparison). These horizontal fluxes exclude lateral radiation and cannot be summed into a full human radiation budget. Roofs are excluded from ground-area results.`;
    }
    const radiationProvenance = forcing.provenance?.global_radiation_wm2 || forcing.provenance?.shortwave_radiation || '';
    const radiationSource = radiationProvenance.includes('satellite')
      ? 'EUMETSAT satellite observation'
      : 'Open-Meteo model forecast (no satellite measurement for this hour)';
    const resultContext = metric === 'utci_c'
      ? hasWeatherWarnings
        ? ' · Low-confidence model estimate: forecast inputs have quality warnings, and no CBD street observation is available. Do not treat its heat-stress category as observed local conditions. UTCI includes modeled sun and wind; it is not air temperature.'
      : ` · mean ${utciCategory(mean)}, peak ${utciCategory(maximum)}. UTCI is a sun-and-wind comfort index, not air temperature. The colour range adapts to this hour; compare numeric values across hours.`
      : '';
    heatProvenance.textContent = `${thermalManifest.validation_status.replaceAll('_', ' ')} · Weather ${sources}${station}${qualitySummary} · Radiation ${radiationSource}${thermalManifest.latest_observation_at && !forcing.station?.id ? ' · remote proxy checks through ' + new Date(thermalManifest.latest_observation_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) : ''} · run ${generated} SAST${inputSummary}${resultContext}`;
    if (metric === 'utci_c') {
      if (heatAverageLabel) heatAverageLabel.textContent = hasWeatherWarnings ? 'Mean UTCI · low confidence' : `Mean UTCI · ${utciCategory(mean)}`;
      if (heatMaximumLabel) heatMaximumLabel.textContent = hasWeatherWarnings ? 'Peak UTCI · low confidence' : `Peak UTCI · ${utciCategory(maximum)}`;
      if (heatPriorityArea?.nextElementSibling) heatPriorityArea.nextElementSibling.textContent = 'UTCI ≥ 32°C';
    } else {
      if (heatAverageLabel) heatAverageLabel.textContent = 'Mean Tmrt';
      if (heatMaximumLabel) heatMaximumLabel.textContent = 'Peak Tmrt';
      if (heatPriorityArea?.nextElementSibling) heatPriorityArea.nextElementSibling.textContent = 'Wind sector';
    }
    if (heatEnergy && heatEnergySummary) {
      const energyRow = thermalEnergy?.hours?.find(item => item.valid_at === frame.valid_at);
      heatEnergy.hidden = !energyRow;
      if (energyRow) heatEnergySummary.textContent = `QN ${energyRow.QN.toFixed(0)}, QH ${energyRow.QH.toFixed(0)}, QE ${energyRow.QE.toFixed(0)}, QS ${energyRow.QS.toFixed(0)} W/m² · runoff ${energyRow.RO.toFixed(2)} mm`;
    }
    dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'heat', metadata: {
      description: `Experimental ${metric} forecast valid ${frame.valid_at}`, run_id: thermalManifest.run_id, frame_id: frame.id,
      valid_at: frame.valid_at, validation_status: thermalManifest.validation_status, wind_sector: frame.wind_sector,
      run_generated_at: thermalManifest.generated_at, manifest_sha256: thermalManifest.manifest_sha256,
      frame_sha256: frame.sha256, model_versions: thermalManifest.models, worker: thermalManifest.worker || null,
      grid: thermalManifest.grid, channels: thermalManifest.channels,
      weather_warnings: forcing.weather_warnings || [], weather_inputs: inputs,
      kpis: {
        metric, mean, maximum, valid_cell_count: validCells,
        valid_area_m2: validCells * Number(thermalManifest.grid.resolution_m) ** 2,
        utci_area_share_pct: metric === 'utci_c' ? {
          cold_stress: coldStressCells / validCells * 100,
          no_thermal_stress: noStressCells / validCells * 100,
          heat_stress: heatStressCells / validCells * 100,
        } : null,
        hotspot_area_pct: metric === 'utci_c' ? hotspotCells / validCells * 100 : null,
      },
    } } }));
  }

  async function calculateThermalScenario() {
    if (!thermalManifest || !thermalBaselinePayload || !thermalScenarioCenter) return;
    heatScenarioRun.disabled = true;
    heatScenarioStatus.textContent = 'Calculating the shade intervention estimate…';
    try {
      const frame = selectedThermalFrame();
      if (!frame) throw new Error('No forecast frame is available for this time.');
      const response = await fetch(`${windApi}/thermal/scenario`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_id: thermalManifest.run_id, frame_id: frame.id,
          x: thermalScenarioCenter.x, z: thermalScenarioCenter.z,
          radius_m: Number(heatScenarioRadius.value),
          shade_percent: Number(heatScenarioShade.value), intervention: heatScenarioType.value,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || `scenario request failed (${response.status})`);
      }
      const raw = new Int16Array(await response.arrayBuffer());
      thermalScenarioSummary = JSON.parse(response.headers.get('X-Thermal-Scenario') || '{}');
      let limit = 0.5;
      for (const value of raw) if (value !== thermalManifest.nodata) limit = Math.max(limit, Math.abs(value * 0.1));
      const range = { min: -limit, max: limit, percentiles: null };
      const scenarioManifest = {
        ...thermalManifest, nodata: thermalManifest.nodata,
        channels: [{ name: 'utci_delta_c', scale: 0.1, offset: 0, unit: '°C' }],
      };
      thermalScenarioPayload = { thermal: true, manifest: scenarioManifest, values: raw, metric: 'utci_delta_c', range };
      heatScenarioSummary.hidden = false;
      heatScenarioSummary.textContent = `${thermalScenarioSummary.area_m2.toLocaleString()} m² assessed · mean UTCI ${thermalScenarioSummary.mean_utci_before_c}°C → ${thermalScenarioSummary.mean_utci_after_c}°C (${thermalScenarioSummary.mean_utci_delta_c > 0 ? '+' : ''}${thermalScenarioSummary.mean_utci_delta_c}°C) · area above 32°C ${thermalScenarioSummary.hot_area_before_m2.toLocaleString()} → ${thermalScenarioSummary.hot_area_after_m2.toLocaleString()} m². ${thermalScenarioSummary.note}`;
      heatScenarioDelta.disabled = false;
      heatScenarioBaseline.disabled = false;
      heatScenarioStatus.textContent = `Estimate ready for ${frame.valid_at}. Values describe the selected forecast hour.`;
      if (thermalComparisonPoint) await inspectThermalComparisonPoint(thermalComparisonPoint.x, thermalComparisonPoint.z);
    } catch (error) {
      heatScenarioStatus.textContent = error.message || 'Could not calculate this intervention estimate.';
    } finally {
      heatScenarioRun.disabled = false;
    }
  }

  async function inspectThermalComparisonPoint(x, z) {
    thermalComparisonPoint = { x, z };
    if (!thermalManifest) return;
    const frame = selectedThermalFrame();
    if (!frame) throw new Error('No forecast frame is available for this time.');
    const query = new URLSearchParams({ x: String(x), z: String(z), run_id: thermalManifest.run_id, frame_id: frame.id });
    const response = await fetch(`${windApi}/thermal/point?${query}`);
    if (!response.ok) throw new Error('The selected point has no forecast value.');
    const point = await response.json();
    const base = point.values.utci_c;
    let delta = null;
    if (thermalScenarioPayload) {
      const { width } = thermalScenarioPayload.manifest.grid;
      const index = point.grid_cell.row * width + point.grid_cell.column;
      const raw = thermalScenarioPayload.values[index];
      if (raw !== thermalManifest.nodata) delta = raw * 0.1;
    }
    const result = delta == null ? `Selected point UTCI ${base?.toFixed(1) ?? 'no data'}°C (${point.utci_category || 'masked cell'}).`
      : `Selected point UTCI ${base.toFixed(1)}°C → ${(base + delta).toFixed(1)}°C (${delta > 0 ? '+' : ''}${delta.toFixed(1)}°C).`;
    heatScenarioStatus.textContent = result;
  }

  function showThermalScenarioDifference() {
    if (!thermalScenarioPayload) return;
    heatPayload = thermalScenarioPayload;
    heatRange = thermalScenarioPayload.range;
    buildThermalMesh(thermalScenarioPayload);
    const gradient = document.querySelector('.heat-gradient');
    if (gradient) gradient.style.background = 'linear-gradient(90deg,#1769aa,#f3f0df,#c73532)';
    heatLegendMin.textContent = `−${Math.abs(thermalScenarioPayload.range.min).toFixed(1)}°C`;
    heatLegendMax.textContent = `+${Math.abs(thermalScenarioPayload.range.max).toFixed(1)}°C`;
    if (heatAverageLabel) heatAverageLabel.textContent = 'Mean UTCI change';
    if (heatMaximumLabel) heatMaximumLabel.textContent = 'Largest change';
    const s = thermalScenarioSummary;
    renderHeatSummary({ area_weighted_mean: s.mean_utci_delta_c, maximum: s.max_utci_reduction_c,
      hotspot_area_m2: Math.max(0, s.hot_area_before_m2 - s.hot_area_after_m2),
      hotspot_area_pct: s.area_m2 ? Math.max(0, s.hot_area_before_m2 - s.hot_area_after_m2) / s.area_m2 * 100 : 0 },
    { unit: '°C', decimals: 1 });
    if (heatAverageLabel) heatAverageLabel.textContent = 'Mean UTCI change';
    if (heatMaximumLabel) heatMaximumLabel.textContent = 'Max reduction';
    if (heatPriorityArea?.nextElementSibling) heatPriorityArea.nextElementSibling.textContent = 'Hot area reduced';
    heatStatus.textContent = 'Intervention UTCI difference · experimental shade screening estimate';
  }

  function showThermalBaseline() {
    if (!thermalBaselinePayload) return;
    heatPayload = thermalBaselinePayload;
    heatRange = thermalBaselinePayload.range;
    buildThermalMesh(thermalBaselinePayload);
    const gradient = document.querySelector('.heat-gradient');
    if (gradient) gradient.style.background = utciPalette(heatRange.min, heatRange.max).gradient;
    heatLegendMin.textContent = `P10 ${heatRange.min.toFixed(1)}°C`;
    heatLegendMax.textContent = `P90 ${heatRange.max.toFixed(1)}°C`;
    if (heatAverageLabel) heatAverageLabel.textContent = 'Mean UTCI';
    if (heatMaximumLabel) heatMaximumLabel.textContent = 'Peak UTCI';
    if (heatPriorityArea?.nextElementSibling) heatPriorityArea.nextElementSibling.textContent = 'UTCI ≥ 32°C';
    heatStatus.textContent = 'Experimental modelled UTCI forecast · not observed';
  }

  function heatDistributionValues(payload, metadata) {
    if (!payload?.thermal) return (payload?.features || [])
      .map(feature => Number(feature.value)).filter(Number.isFinite);
    const manifest = payload.manifest;
    const grid = manifest?.grid;
    if (!grid || !payload.values) return [];
    const channel = thermalChannel(manifest, payload.metric);
    const pixels = grid.width * grid.height;
    const stride = Math.max(1, Math.floor(pixels / 24000));
    const values = [];
    const nodata = Number(manifest.nodata ?? -32768);
    for (let pixel = 0; pixel < pixels; pixel += stride) {
      const raw = payload.values[pixel * manifest.channels.length + channel.index];
      if (raw === nodata) continue;
      values.push(raw * Number(channel.scale) + Number(channel.offset || 0));
    }
    return values;
  }

  function heatStreetSegments() {
    if (heatStreetSegmentsCache) return heatStreetSegmentsCache;
    heatStreetSegmentsCache = [];
    for (const road of data.roads || []) {
      const name = String(road?.[3]?.name || '').trim();
      const line = road?.[2];
      if (!name || !Array.isArray(line)) continue;
      for (let index = 1; index < line.length; index += 1) {
        const [x1, z1] = line[index - 1], [x2, z2] = line[index];
        if (Math.hypot(x2 - x1, z2 - z1) > 0.01) heatStreetSegmentsCache.push({ name, x1, z1, x2, z2 });
      }
    }
    return heatStreetSegmentsCache;
  }

  function nearestMappedStreetName(x, z) {
    const cacheKey = `${Math.round(x * 10)}:${Math.round(z * 10)}`;
    if (heatZoneRoadCache.has(cacheKey)) return heatZoneRoadCache.get(cacheKey);
    let nearestName = '', nearestDistance = Infinity;
    for (const segment of heatStreetSegments()) {
      const dx = segment.x2 - segment.x1, dz = segment.z2 - segment.z1;
      const lengthSquared = dx * dx + dz * dz;
      const fraction = clamp(((x - segment.x1) * dx + (z - segment.z1) * dz) / lengthSquared, 0, 1);
      const distance = Math.hypot(x - (segment.x1 + dx * fraction), z - (segment.z1 + dz * fraction));
      if (distance < nearestDistance) { nearestDistance = distance; nearestName = segment.name; }
    }
    heatZoneRoadCache.set(cacheKey, nearestName);
    return nearestName;
  }

  function rankHeatStreets(payload, metadata) {
    const groups = new Map();
    const add = (name, value, weight, x, z) => {
      const label = String(name || '').trim();
      if (!label || !Number.isFinite(value) || !(weight > 0)) return;
      let item = groups.get(label);
      if (!item) groups.set(label, item = { name: label, total: 0, weight: 0, x: 0, z: 0, samples: 0 });
      item.total += value * weight;
      item.weight += weight;
      item.x += x * weight;
      item.z += z * weight;
      item.samples += 1;
    };

    if (!payload?.thermal) {
      const mappedNames = new Set(heatStreetSegments().map(segment => heatStreetKey(segment.name)));
      for (const feature of payload?.features || []) {
        const area = Number(feature.area_m2);
        const value = Number(feature.value);
        let name = feature.nearest_road_name || feature.properties?.nearest_road_name;
        const geometry = feature.geometry;
        const rings = geometry?.type === 'Polygon' ? [geometry.coordinates?.[0]]
          : geometry?.type === 'MultiPolygon' ? geometry.coordinates?.map(polygon => polygon?.[0]) : [];
        const points = (rings || []).flat().filter(point => Array.isArray(point) && point.length >= 2);
        if (!points.length) continue;
        const center = points.reduce((acc, point) => [acc[0] + Number(point[0]), acc[1] + Number(point[1])], [0, 0]);
        const x = center[0] / points.length, z = center[1] / points.length;
        if (!mappedNames.has(heatStreetKey(name))) name = nearestMappedStreetName(x, z) || name;
        add(name, value, area, x, z);
      }
    } else {
      const manifest = payload.manifest, grid = manifest?.grid;
      if (!grid || !payload.values || !Array.isArray(data.roads)) return [];
      const channel = thermalChannel(manifest, payload.metric);
      const [minX, minZ] = grid.bounds.map(Number);
      const resolution = Number(grid.resolution_m);
      const nodata = Number(manifest.nodata ?? -32768);
      const sample = (x, z) => {
        const column = Math.floor((x - minX) / resolution), row = Math.floor((z - minZ) / resolution);
        if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) return null;
        const raw = payload.values[(row * grid.width + column) * manifest.channels.length + channel.index];
        return raw === nodata ? null : raw * Number(channel.scale) + Number(channel.offset || 0);
      };
      const spacing = Math.max(20, resolution * 0.65);
      for (const road of data.roads) {
        const points = road?.[2], name = road?.[3]?.name;
        if (!name || !Array.isArray(points) || points.length < 2) continue;
        for (let index = 1; index < points.length; index += 1) {
          const [x1, z1] = points[index - 1], [x2, z2] = points[index];
          const length = Math.hypot(x2 - x1, z2 - z1);
          if (!(length > 0)) continue;
          const steps = Math.max(1, Math.ceil(length / spacing));
          const weight = length / steps;
          for (let step = 0; step < steps; step += 1) {
            const fraction = (step + 0.5) / steps;
            const x = x1 + (x2 - x1) * fraction, z = z1 + (z2 - z1) * fraction;
            const value = sample(x, z);
            if (value != null) add(name, value, weight, x, z);
          }
        }
      }
    }

    return [...groups.values()].map(item => ({
      ...item, value: item.total / item.weight, x: item.x / item.weight, z: item.z / item.weight,
    })).filter(item => item.samples > 0).sort((a, b) => b.value - a.value);
  }

  function heatStreetKey(name) {
    const removable = new Set(['street', 'st', 'road', 'rd', 'avenue', 'ave', 'boulevard', 'blvd', 'drive', 'dr', 'lane', 'ln', 'mall', 'place', 'pl', 'crescent', 'close', 'parade']);
    return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
      .filter(token => token && !removable.has(token)).join(' ');
  }

  function clearHeatStreetOverlay() {
    for (const object of [...heatStreetGroup.children]) {
      heatStreetGroup.remove(object);
      disposeObject(object);
    }
  }

  function buildHeatStreetOverlay() {
    clearHeatStreetOverlay();
    const showAll = Boolean(heatStreetMapToggle?.checked);
    const selectedKey = heatStreetKey(selectedHeatStreet);
    if (!heatPayload || (!showAll && !selectedKey) || !heatStreetRankings.length) {
      heatStreetGroup.visible = false;
      return;
    }
    const stats = new Map(heatStreetRankings.map(item => [heatStreetKey(item.name), item.value]));
    const roadFeatures = data.roads || [];
    const hasNamedMatch = selectedKey && roadFeatures.some(road => heatStreetKey(road?.[3]?.name) === selectedKey);
    let fallbackRoadKey = '';
    if (selectedKey && !hasNamedMatch && selectedHeatStreetLocation) {
      let nearestDistance = Infinity;
      for (const road of roadFeatures) {
        const line = road?.[2], key = heatStreetKey(road?.[3]?.name);
        if (!key || !Array.isArray(line)) continue;
        for (let index = 1; index < line.length; index += 1) {
          const [x1, z1] = line[index - 1], [x2, z2] = line[index];
          const dx = x2 - x1, dz = z2 - z1, lengthSquared = dx * dx + dz * dz;
          if (!(lengthSquared > 0)) continue;
          const fraction = clamp(((selectedHeatStreetLocation.x - x1) * dx
            + (selectedHeatStreetLocation.z - z1) * dz) / lengthSquared, 0, 1);
          const distance = Math.hypot(selectedHeatStreetLocation.x - (x1 + dx * fraction),
            selectedHeatStreetLocation.z - (z1 + dz * fraction));
          if (distance < nearestDistance) { nearestDistance = distance; fallbackRoadKey = key; }
        }
      }
    }
    const range = heatPayload.thermal ? heatPayload.range : heatPayload.color_range || heatPayload.range || heatRange;
    if (!range || !Number.isFinite(Number(range.min)) || !Number.isFinite(Number(range.max))) {
      heatStreetGroup.visible = false;
      return;
    }
    const positions = [], colors = [], indices = [];
    let paintedRoadSegments = 0;
    for (const road of data.roads || []) {
      const roadName = road?.[3]?.name;
      const key = heatStreetKey(roadName);
      const value = stats.get(key);
      const isSelected = Boolean(selectedKey && (key === selectedKey || (!hasNamedMatch && key === fallbackRoadKey)));
      if (!key || (!showAll && !isSelected) || !Number.isFinite(value)) continue;
      paintedRoadSegments += 1;
      const colorMetric = heatPayload.thermal && heatPayload.climatology && heatPayload.metric === 'utci_c'
        ? 'utci_absolute_c' : heatPayload.metric;
      const color = isSelected ? new THREE.Color(0xfff38a)
        : heatColor(value, Number(range.min), Number(range.max), colorMetric,
          colorMetric === 'utci_absolute_c' ? null : range.percentiles);
      const line = road[2];
      if (!Array.isArray(line) || line.length < 2) continue;
      const roadWidth = clamp(Number(road[0]) || 6, 3.5, 16) + (isSelected ? 4 : 0);
      const yOffset = isSelected ? 1.25 : 0.82;
      for (let index = 1; index < line.length; index += 1) {
        const [x1, z1] = line[index - 1], [x2, z2] = line[index];
        const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz);
        if (!(length > 0.01)) continue;
        const nx = -dz / length * roadWidth * 0.5, nz = dx / length * roadWidth * 0.5;
        const base = positions.length / 3;
        for (const [x, z] of [[x1 + nx, z1 + nz], [x1 - nx, z1 - nz], [x2 + nx, z2 + nz], [x2 - nx, z2 - nz]]) {
          positions.push(x, terrainHeightAt(x, z) + yOffset, z);
          colors.push(color.r, color.g, color.b);
        }
        indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }
    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices);
      const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.98, side: THREE.DoubleSide,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      }));
      surface.renderOrder = 16;
      heatStreetGroup.add(surface);
    }
    heatStreetGroup.visible = Boolean(heatToggle?.checked && positions.length);
    if (heatStreetMapStatus) {
      heatStreetMapStatus.textContent = showAll
        ? `${paintedRoadSegments ? 'Street heat map ready' : 'No named streets matched'} · ${paintedRoadSegments.toLocaleString()} OSM road segments colored.`
        : `${selectedHeatStreet || 'Street'} highlighted on the model · ${paintedRoadSegments.toLocaleString()} ${hasNamedMatch ? 'matching' : 'nearest'} OSM road segments${fallbackRoadKey ? ' (street name unavailable in the scene)' : ''}.`;
    }
  }

  function renderHeatExplorer(payload, metadata = {}) {
    if (!heatExplorer || !heatDistribution || !heatHotStreets || !heatCoolStreets) return;
    const values = heatDistributionValues(payload, metadata).sort((a, b) => a - b);
    if (!values.length) {
      heatDistribution.replaceChildren();
      if (heatDistributionCount) heatDistributionCount.textContent = '—';
      for (const list of [heatHotStreets, heatCoolStreets]) {
        const item = document.createElement('li');
        item.textContent = 'Street rankings are unavailable for this layer.';
        list.replaceChildren(item);
      }
      if (heatExplorerNote) heatExplorerNote.textContent = 'No heat samples are available for this selection.';
      if (heatSurfaceSummary) heatSurfaceSummary.hidden = true;
      heatExplorer.hidden = false;
      return;
    }
    const percentile = fraction => values[Math.round((values.length - 1) * fraction)];
    const unit = metadata.unit || '';
    const stats = [
      ['Lowest', values[0]], ['P25', percentile(0.25)], ['Median', percentile(0.5)],
      ['P75', percentile(0.75)], ['Highest', values.at(-1)],
    ];
    heatDistribution.replaceChildren(...stats.map(([label, value]) => {
      const cell = document.createElement('span');
      const title = document.createElement('small'); title.textContent = label;
      const number = document.createElement('b'); number.textContent = `${Number(value).toFixed(metadata.decimals ?? 1)}${unit}`;
      cell.append(title, number); return cell;
    }));
    if (heatDistributionCount) heatDistributionCount.textContent = payload.thermal
      ? `${values.length.toLocaleString()} grid samples` : `${values.length.toLocaleString()} mapped zones`;
    const rankings = rankHeatStreets(payload, metadata);
    heatStreetRankings = rankings;
    buildHeatStreetOverlay();
    const rankingTitles = {
      shade_deficit_score: ['Largest shade deficit', 'Smallest shade deficit'],
      pedestrian_priority_score: ['Highest heat + shade priority', 'Lowest heat + shade priority'],
      pedestrian_heat_exposure_c: ['Highest exposure proxy', 'Lowest exposure proxy'],
      cumulative_sun_hours: ['Most direct sun', 'Least direct sun'],
      tmrt_c: ['Highest radiant heat', 'Lowest radiant heat'],
    }[payload.metric] || ['Hottest streets', 'Coolest streets'];
    if (heatHotStreetsTitle) heatHotStreetsTitle.textContent = rankingTitles[0];
    if (heatCoolStreetsTitle) heatCoolStreetsTitle.textContent = rankingTitles[1];
    const renderList = (target, items, reverse = false) => {
      const selected = reverse ? [...items].reverse().slice(0, 5) : items.slice(0, 5);
      target.replaceChildren();
      if (!selected.length) {
        const empty = document.createElement('li'); empty.textContent = 'Street attribution is not available for this layer.';
        target.append(empty); return;
      }
      selected.forEach((item, index) => {
        const row = document.createElement('li');
        const button = document.createElement('button'); button.type = 'button';
        button.setAttribute('aria-label', `Focus map on ${item.name}, ${formatHeatValue(item.value, metadata)}`);
        button.setAttribute('aria-pressed', String(heatStreetKey(item.name) === heatStreetKey(selectedHeatStreet)));
        if (heatStreetKey(item.name) === heatStreetKey(selectedHeatStreet)) button.classList.add('is-highlighted');
        const name = document.createElement('span'); name.textContent = item.name;
        const value = document.createElement('b'); value.textContent = formatHeatValue(item.value, metadata);
        const rank = document.createElement('small'); rank.textContent = String(index + 1).padStart(2, '0');
        button.append(rank, name, value);
        button.addEventListener('click', () => {
          selectedHeatStreet = item.name;
          selectedHeatStreetLocation = { x: item.x, z: item.z };
          heatExplorer.querySelectorAll('.heat-rankings button').forEach(candidate => {
            const active = candidate === button;
            candidate.setAttribute('aria-pressed', String(active));
            candidate.classList.toggle('is-highlighted', active);
          });
          buildHeatStreetOverlay();
          if (heatToggle && !heatToggle.checked) {
            heatToggle.checked = true;
            heatToggle.dispatchEvent(new Event('change', { bubbles: true }));
          }
          cameraState.target.set(item.x, terrainHeightAt(item.x, item.z) + 18, item.z);
          cameraState.distance = Math.max(CAMERA_MIN_DISTANCE, 520);
          updateCamera();
        });
        row.append(button); target.append(row);
      });
    };
    renderList(heatHotStreets, rankings);
    renderList(heatCoolStreets, rankings, true);
    if (heatExplorerNote) heatExplorerNote.textContent = payload.thermal
      ? `Street averages sample the ${payload.manifest.grid.resolution_m} m ${payload.climatology ? 'climate' : 'forecast'} grid along mapped street lines; they are model estimates, not street sensors.`
      : 'Satellite zones are grouped by street; unmatched source labels are assigned to the nearest OSM street line. Values describe surface heat, not air temperature.';

    if (heatSurfaceSummary && heatSurfaceTypes) {
      const totals = new Map();
      for (const feature of payload.features || []) {
        const raw = feature.surface_type || feature.properties?.surface_type;
        if (!raw) continue;
        const name = ({ 'Soil/Dirt': 'Bare / soil', Impervious: 'Built / paved', Grass: 'Vegetation', Tree: 'Vegetation', Water: 'Water' })[raw] || raw;
        totals.set(name, (totals.get(name) || 0) + Number(feature.area_m2 || 0));
      }
      heatSurfaceSummary.hidden = payload.thermal || !totals.size;
      if (!payload.thermal && totals.size) {
        const totalArea = [...totals.values()].reduce((sum, area) => sum + area, 0) || 1;
        heatSurfaceTypes.replaceChildren(...[...totals].sort((a, b) => b[1] - a[1]).map(([name, area]) => {
          const row = document.createElement('div'); row.className = 'heat-surface-type-row';
          const label = document.createElement('span'); label.textContent = name;
          const bar = document.createElement('i'); bar.style.width = `${(area / totalArea * 100).toFixed(1)}%`;
          const amount = document.createElement('b'); amount.textContent = `${(area / totalArea * 100).toFixed(0)}%`;
          row.append(label, bar, amount); return row;
        }));
      }
    }
    heatExplorer.hidden = false;
  }

  function renderHeatSummary(summary, metadata = {}) {
    if (!heatSummary) return;
    const ready = summary?.area_weighted_mean != null && summary?.maximum != null;
    heatSummary.hidden = !ready;
    heatCurrentSummary = ready ? {
      metric: heatMetric?.value || '', label: heatMetric?.selectedOptions[0]?.textContent.trim() || 'Heat view',
      mean: Number(summary.area_weighted_mean), maximum: Number(summary.maximum), unit: metadata.unit || '',
      date: heatPeriod?.value === 'climatology'
        ? `${heatClimateAggregate?.selectedOptions[0]?.textContent || 'Month'} · ${heatClimateAggregate?.value === 'season' ? heatClimateSeason?.selectedOptions[0]?.textContent || 'season' : heatClimateAggregate?.value === 'month' ? heatClimateMonthLabel?.textContent || 'month' : 'all months'} · ${heatClimateHourLabel?.textContent || 'local hour'}`
        : ['utci_c', 'tmrt_c'].includes(heatMetric?.value) ? heatForecastLabel?.textContent || 'Near-live forecast'
          : ['heat_model_lst_c', 'rooftop_temperature_c', 'pedestrian_heat_exposure_c'].includes(heatMetric?.value)
            ? `${heatPayload?.window?.label || 'Fixed source baseline'}`
            : `${heatDate?.value || ''} · ${heatTime?.selectedOptions[0]?.textContent || '12:00'}`,
    } : null;
    if (!ready) { updateHeatComparison(); return; }
    heatAverage.textContent = formatHeatValue(summary.area_weighted_mean, metadata);
    heatMaximum.textContent = formatHeatValue(summary.maximum, metadata);
    if (heatAverageLabel) heatAverageLabel.textContent = 'Average';
    if (heatMaximumLabel) heatMaximumLabel.textContent = 'Maximum';
    if (heatPriorityArea?.nextElementSibling) heatPriorityArea.nextElementSibling.textContent = heatMetric?.value === 'utci_c'
      ? 'UTCI ≥ 32°C area' : 'Top 10% area';
    const hotspotHectares = Number(summary.hotspot_area_m2 || 0) / 10000;
    const hotspotPercent = Number(summary.hotspot_area_pct || 0);
    heatPriorityArea.textContent = `${hotspotHectares.toFixed(1)} ha · ${hotspotPercent.toFixed(0)}%`;
    updateHeatComparison();
  }

  function updateHeatComparison() {
    if (!heatComparison) return;
    if (!heatSavedComparison || !heatCurrentSummary) { heatComparison.hidden = true; return; }
    heatComparison.hidden = false;
    const before = heatSavedComparison, after = heatCurrentSummary;
    if (before.metric === after.metric && before.unit === after.unit) {
      const delta = after.mean - before.mean;
      const sign = delta > 0 ? '+' : '';
      heatComparison.textContent = `Map-wide area-weighted mean · saved: ${before.label}, ${before.date}, ${before.mean.toFixed(1)}${before.unit}; now: ${after.date}, ${after.mean.toFixed(1)}${after.unit}. Change: ${sign}${delta.toFixed(1)}${after.unit}.`;
    } else {
      heatComparison.textContent = `Map-wide area-weighted mean · saved: ${before.label}, ${before.date}, ${before.mean.toFixed(1)}${before.unit}; now: ${after.label}, ${after.date}, ${after.mean.toFixed(1)}${after.unit}. Different measures cannot be subtracted.`;
    }
  }

  async function loadHeat(metric = heatMetric?.value || 'pedestrian_priority_score') {
    heatLoaded = true;
    if (!heatStatus) return;
    const loadToken = ++heatLoadToken;
    selectedHeatStreet = '';
    selectedHeatStreetLocation = null;
    heatStreetRankings = [];
    clearHeatStreetOverlay();
    heatStreetGroup.visible = false;
    if (heatExplorer) {
      heatExplorer.hidden = false;
      if (heatDistribution) heatDistribution.replaceChildren();
      if (heatDistributionCount) heatDistributionCount.textContent = 'Loading…';
      if (heatExplorerNote) heatExplorerNote.textContent = 'Updating street rankings for the selected layer…';
      for (const list of [heatHotStreets, heatCoolStreets]) {
        if (!list) continue;
        const item = document.createElement('li');
        item.textContent = 'Updating…';
        list.replaceChildren(item);
      }
      if (heatSurfaceSummary) heatSurfaceSummary.hidden = true;
    }
    syncHeatTemporalControls(metric);
    const legendGradient = document.querySelector('.heat-gradient');
    if (legendGradient) legendGradient.style.background = '';
    const legendHelp = document.querySelector('#heat-legend-help');
    if (legendHelp) {
      legendHelp.hidden = metric !== 'utci_c';
      legendHelp.textContent = heatPeriod?.value === 'climatology'
        ? 'One colour scale across all periods.'
        : 'Colours show differences within this hour; compare values across hours.';
    }
    const weatherInputs = document.querySelector('#heat-weather-inputs');
    if (weatherInputs) weatherInputs.hidden = true;
    for (const id of ['heat-radiation-timing', 'heat-radiation-audit']) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
    heatStatus.textContent = metric === 'utci_c' ? 'Loading UTCI…' : metric === 'tmrt_c' ? 'Loading Tmrt…' : 'Loading heat…';
    heatStatus.setAttribute('aria-busy', 'true');
    if (heatSummary) heatSummary.hidden = true;
    if (heatLoadingState) heatLoadingState.hidden = metric !== 'utci_c';
    try {
      if (['utci_c', 'tmrt_c', 'sky_view_factor'].includes(metric)) {
        if (metric !== 'sky_view_factor' && heatPeriod?.value === 'climatology') await loadClimatology(metric, loadToken);
        else await loadThermal(metric, loadToken);
        setHeatMode(Boolean(heatToggle?.checked));
        return;
      }
      if (heatAverageLabel) heatAverageLabel.textContent = 'Average';
      if (heatMaximumLabel) heatMaximumLabel.textContent = 'Maximum';
      if (heatProvenance) heatProvenance.textContent = 'Satellite-based heat screening · summer baseline with mapped shade indicators';
      if (heatEnergy) heatEnergy.hidden = true;
      const params = new URLSearchParams({
        metric,
        date: heatDate?.value || '2026-01-15',
        minutes: heatTime?.value || '720',
      });
      // Metric/date controls can change several times in quick succession.
      // Wait for the selection to settle, and let the request client supersede
      // any already-started heat-zone read with the same stable key.
      await new Promise(resolve => setTimeout(resolve, 220));
      if (loadToken !== heatLoadToken) return;
      const response = await fetch(`${windApi}/heat/zones?${params}`, { requestKey: 'heat-zones' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (loadToken !== heatLoadToken) return;
      heatPayload = payload;
      dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'heat', metadata: {
        description: `Source: ${payload.source || 'not supplied'} · window: ${payload.window?.label || 'not supplied'} · units: ${payload.metric_metadata?.unit || 'not supplied'}`,
        source: payload.source, window: payload.window, scenario: payload.scenario, metric: payload.metric,
        metric_label: payload.metric_label, metric_metadata: payload.metric_metadata, kpis: payload.summary,
      } } }));
      if (heatToggle?.checked && !shadowState.enabled) buildHeatMesh(payload);
      renderHeatSummary(payload.summary, payload.metric_metadata, payload.metric_label);
      renderHeatExplorer(payload, payload.metric_metadata);
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
      if (['utci_c', 'tmrt_c'].includes(metric)) {
        heatPayload = null;
        if (heatPeriod?.value === 'climatology') thermalClimatology = null;
        else thermalManifest = null;
        if (heatProvenance) heatProvenance.textContent = 'No model output has been published for this layer.';
        for (const object of heatGroup.children) disposeObject(object);
        heatGroup.clear();
        analysisGroupMode = null;
      }
      renderHeatSummary(null);
      if (heatExplorerNote) heatExplorerNote.textContent = `Street rankings unavailable: ${error.message}`;
      for (const list of [heatHotStreets, heatCoolStreets]) {
        if (!list) continue;
        const item = document.createElement('li');
        item.textContent = 'Rankings unavailable for this layer.';
        list.replaceChildren(item);
      }
      if (heatDistributionCount) heatDistributionCount.textContent = 'Unavailable';
      heatStatus.textContent = `Heat data unavailable (${error.message})`;
    } finally {
      if (loadToken === heatLoadToken) {
        heatStatus.setAttribute('aria-busy', 'false');
        if (heatLoadingState) heatLoadingState.hidden = true;
      }
    }
    setHeatMode(Boolean(heatToggle?.checked));
  }

  function displaySunHoursResult(result, difference = false) {
    const { payload, buildings, scenario, area, average } = result;
    activeSunResult = result;
    if (sunInspect) sunInspect.hidden = false;
    if (sunInspectResult) sunInspectResult.hidden = true;
    buildHeatMesh(payload);
    if (buildings) addBuildingSunMesh(buildings, payload.color_range, difference ? 'utci_delta_c' : 'cumulative_sun_hours');
    setBuildingAnalysisSkin(Boolean(buildings));
    heatGroup.visible = true;
    sunLight.visible = false;
    shadowCatcher.visible = false;
    const range = payload.color_range || payload.range;
    const sunGradient = document.querySelector('.sun-energy-gradient');
    if (sunGradient) sunGradient.style.background = difference
      ? 'linear-gradient(90deg,#2879bb,#f1eee4,#d34a39)' : '';
    if (range) {
      sunHoursMin.textContent = `${range.min.toFixed(1)} h`;
      sunHoursMax.textContent = `${difference && range.max > 0 ? '+' : ''}${range.max.toFixed(1)} h`;
    }
    const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    const cellCount = buildings?.count ? ` · ${buildings.count.toLocaleString()} building cells` : '';
    const dateLabel = new Date(`${scenario.date}T12:00:00`).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', year: 'numeric' });
    sunStatus.textContent = difference
      ? `Seasonal difference · ${average > 0 ? '+' : ''}${average.toFixed(1)} h average (${sunSeasonalResults.first.scenario.date} → ${sunSeasonalResults.second.scenario.date}) · same ${area} m area and time window.`
      : `${dateLabel} · ${average.toFixed(1)} h average direct sun · ${clock(Number(scenario.start_minutes))}–${clock(Number(scenario.end_minutes))} · ${area} m area${cellCount}.`;
    sunStatus.classList.remove('is-updated');
    requestAnimationFrame(() => sunStatus.classList.add('is-updated'));
    dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'sun', metadata: {
      description: `${average.toFixed(1)} h average sampled direct sun; ${scenario.date}; ${clock(Number(scenario.start_minutes))}–${clock(Number(scenario.end_minutes))}; ${area} m area. Clear-sky model.`,
      scenario, meanSunHours: average, analysis_id: payload.analysis_id || sunAnalysisId,
      kpis: { mean_direct_sun_hours: average, analysis_width_m: area, ...(buildings?.count ? { building_cell_count: buildings.count } : {}) },
    } } }));
  }

  async function generateSunHours(dateOverride = null, displayResult = true) {
    if (!sunToggle?.checked) sunToggle.checked = true;
    setShadowMode(true);
    cancelSunHours('', false);
    const loadToken = ++sunLoadToken;
    const controller = new AbortController();
    sunAbortController = controller;
    sunStatus.textContent = 'Accumulating direct sunlight…';
    sunGenerate.disabled = true;
    sunGenerate.textContent = 'Calculating…';
    if (sunProgress) {
      sunProgress.hidden = false;
      sunProgress.removeAttribute('value');
    }
    try {
      sunAnalysisId = createAnalysisId();
      const scenario = {
        date: dateOverride || sunAnalysisDate?.value || sunDate?.value || shadowState.date,
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
        requestFactories.push(() => fetch(`${windApi}/heat/zones?${new URLSearchParams({ metric: 'cumulative_sun_hours', ...scenario, ...domain })}`, {
          signal: controller.signal, timeoutMs: 300000,
        })
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
        requestFactories.push(() => fetch(`${windApi}/sunlight/building-surfaces?${buildingParams}`, {
          signal: controller.signal, timeoutMs: 300000,
        })
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
      const summaries = [payload.summary, results.buildings?.summary].filter(summary => summary?.area_weighted_mean != null);
      const totalArea = summaries.reduce((sum, summary) => sum + Number(summary.total_area_m2 || 0), 0);
      const average = totalArea ? summaries.reduce((sum, summary) => sum + summary.area_weighted_mean * summary.total_area_m2, 0) / totalArea : 0;
      const result = { payload, buildings: results.buildings || null, scenario, area: shadowState.size, average };
      if (displayResult) displaySunHoursResult(result);
      return result;
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

  function makeSunDifference(first, second) {
    const deltaFeatures = (before = [], after = []) => after.map((feature, index) => ({
      ...feature,
      value: Number(feature.value || 0) - Number(before[index]?.value || 0),
      display_value: Number(feature.display_value ?? feature.value ?? 0) - Number(before[index]?.display_value ?? before[index]?.value ?? 0),
    }));
    const ground = {
      ...second.payload,
      metric: 'utci_delta_c',
      features: deltaFeatures(first.payload.features, second.payload.features),
    };
    const buildingFeatures = deltaFeatures(first.buildings?.features, second.buildings?.features);
    const allDeltas = [...ground.features, ...buildingFeatures].map(feature => Number(feature.display_value ?? feature.value ?? 0));
    const limit = Math.max(0.5, ...allDeltas.map(Math.abs));
    ground.color_range = { min: -limit, max: limit };
    ground.range = ground.color_range;
    const buildings = second.buildings ? { ...second.buildings, features: buildingFeatures, color_range: ground.color_range } : null;
    return { payload: ground, buildings, scenario: second.scenario, area: second.area, average: second.average - first.average };
  }

  const designSunlightCompareButton = document.querySelector('#design-sunlight-compare');
  const designSunlightCompareStatus = document.querySelector('#design-sunlight-status');
  designSunlightCompareButton?.addEventListener('click', async () => {
    const geometry = designProposalGeometry;
    if (!geometry?.add_buildings?.length && !geometry?.remove_building_indexes?.length) {
      if (designSunlightCompareStatus) designSunlightCompareStatus.textContent = 'Edit the proposal before comparing sunlight.';
      return;
    }
    const revision = ++designSunlightCompareRevision;
    const analysisId = createAnalysisId();
    designSunlightAnalysisId = analysisId;
    designSunlightCompareButton.disabled = true;
    if (designSunlightCompareStatus) designSunlightCompareStatus.textContent = 'Calculating matched baseline and proposal sunlight…';
    const scenario = {
      date: sunAnalysisDate?.value || sunDate?.value || shadowState.date,
      start_minutes: Number(sunStartTime?.value || 480),
      end_minutes: Number(sunEndTime?.value || 1080),
      step_minutes: Number(sunStepTime?.value || 60),
      resolution_m: Number(sunSurfaceResolution?.value || 10),
    };
    try {
      const response = await fetch(`${windApi}/sunlight/design-comparison`, {
        method: 'POST', timeoutMs: 300000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...geometry, ...scenario, surfaces: 'all', analysis_id: analysisId,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      if (revision !== designSunlightCompareRevision) return;
      dispatchEvent(new CustomEvent('climate-design-sunlight-result', { detail: payload }));
      const ground = payload.ground || {};
      const local = ground.local_impact || {};
      const before = Number(ground.paired_before_mean_sun_hours);
      const after = Number(ground.paired_after_mean_sun_hours);
      const change = Number(ground.paired_change_mean_sun_hours);
      const localChange = Number(local.change_mean_sun_hours);
      const dateLabel = scenario.date;
      if (designSunlightCompareStatus) designSunlightCompareStatus.textContent =
        `Matched ground cells · ${dateLabel}, ${Math.floor(scenario.start_minutes / 60).toString().padStart(2, '0')}:${String(scenario.start_minutes % 60).padStart(2, '0')}–${Math.floor(scenario.end_minutes / 60).toString().padStart(2, '0')}:${String(scenario.end_minutes % 60).padStart(2, '0')} · ${Number(ground.paired_cell_count || 0).toLocaleString()} cells at 20 m · `
        + `${before.toFixed(2)} → ${after.toFixed(2)} h mean sun (${change > 0 ? '+' : ''}${change.toFixed(2)} h); local ${localChange > 0 ? '+' : ''}${localChange.toFixed(2)} h · clear-sky direct-sun comparison.`;
      dispatchEvent(new CustomEvent('climate-analysis-result', { detail: {
        tool: 'sun', metadata: {
          receivedAt: new Date().toISOString(), label: 'Matched design sunlight result',
          requestId: payload.analysis_id || analysisId,
          description: `Matched baseline/proposal direct-sun comparison · ${dateLabel} · ${scenario.start_minutes}–${scenario.end_minutes} local minutes · ${scenario.resolution_m} m building-surface resolution · ${Number(ground.paired_cell_count || 0)} paired 20 m ground cells · ground mean ${before.toFixed(2)} → ${after.toFixed(2)} h (${change > 0 ? '+' : ''}${change.toFixed(2)} h). Clear-sky direct sun only.`,
          scenario: { ...scenario, design_geometry_hash: payload.proposal_geometry_hash || payload.geometry_hash,
            proposal_geometry: geometry },
          analysis_id: payload.analysis_id || analysisId,
          pairedBeforeMeanSunHours: before, pairedAfterMeanSunHours: after,
          pairedChangeMeanSunHours: change, localChangeMeanSunHours: localChange,
          pairedGroundCellCount: Number(ground.paired_cell_count || 0),
          kpis: {
            paired_before_mean_sun_hours: before, paired_after_mean_sun_hours: after,
            paired_change_mean_sun_hours: change, local_change_mean_sun_hours: localChange,
            paired_ground_cell_count: Number(ground.paired_cell_count || 0),
          },
        },
      } }));
    } catch (error) {
      if (revision !== designSunlightCompareRevision) return;
      if (designSunlightCompareStatus) designSunlightCompareStatus.textContent = `Design sunlight comparison unavailable (${error.message}).`;
    } finally {
      if (revision === designSunlightCompareRevision) {
        designSunlightAnalysisId = null;
        designSunlightCompareButton.disabled = !designProposalGeometry?.add_buildings?.length
          && !designProposalGeometry?.remove_building_indexes?.length;
      }
    }
  });

  const designHeatCompareButton = document.querySelector('#design-heat-compare');
  const designHeatCompareStatus = document.querySelector('#design-heat-status');
  designHeatCompareButton?.addEventListener('click', async () => {
    const geometry = designProposalGeometry;
    if (!geometry?.add_buildings?.length && !geometry?.remove_building_indexes?.length) {
      if (designHeatCompareStatus) designHeatCompareStatus.textContent = 'Edit the proposal before comparing heat/shade screening.';
      return;
    }
    const revision = ++designHeatCompareRevision;
    const analysisId = createAnalysisId();
    const date = heatDate?.value || '2026-01-15';
    const minutes = Number(heatTime?.value || 720);
    designHeatCompareButton.disabled = true;
    if (designHeatCompareStatus) designHeatCompareStatus.textContent = 'Calculating matched baseline and proposal heat/shade screening…';
    try {
      const response = await fetch(`${windApi}/heat/design-comparison`, {
        method: 'POST', timeoutMs: 300000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...geometry, date, minutes, analysis_id: analysisId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      if (revision !== designHeatCompareRevision) return;
      const shadeBefore = Number(payload.mean_shade_deficit_before);
      const shadeAfter = Number(payload.mean_shade_deficit_after);
      const shadeChange = Number(payload.change_mean_shade_deficit);
      const scoreBefore = Number(payload.mean_priority_score_before);
      const scoreAfter = Number(payload.mean_priority_score_after);
      const scoreChange = Number(payload.change_mean_priority_score);
      const signed = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
      if (designHeatCompareStatus) designHeatCompareStatus.textContent =
        `Matched heat-zone area · ${date} ${Math.floor(minutes / 60).toString().padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} · `
        + `mean shade deficit ${shadeBefore.toFixed(2)}% → ${shadeAfter.toFixed(2)}% (${signed(shadeChange)} pp); `
        + `heat-priority screen ${scoreBefore.toFixed(2)} → ${scoreAfter.toFixed(2)}/100 (${signed(scoreChange)}). `
        + 'Fixed summer surface temperature; shade recalculated. Not UTCI/Tmrt.';
      dispatchEvent(new CustomEvent('climate-analysis-result', { detail: {
        tool: 'design_heat', metadata: {
          receivedAt: new Date().toISOString(), label: 'Matched design heat/shade screening',
          requestId: payload.analysis_id || analysisId,
          description: `Matched baseline/proposal heat-zone shade deficit and heat-priority screening · ${date} ${minutes} local minutes · fixed summer surface-temperature baseline; proposal shade recalculated; not UTCI/Tmrt.`,
          scenario: { date, minutes, proposal_id: geometry.proposal_id,
            design_geometry_hash: payload.proposal_geometry_hash || payload.geometry_hash,
            geometry_status: payload.scenario?.geometry_status, proposal_geometry: geometry },
          analysis_id: payload.analysis_id || analysisId,
          reference: { type: 'design-heat-shade-screen', analysis_id: payload.analysis_id || analysisId,
            geometry_hash: payload.proposal_geometry_hash || payload.geometry_hash,
            asset_hashes: payload.source_provenance?.asset_hashes || null,
            result_embedded_in_report: true,
            retention: 'Summary KPIs, per-zone before/after results and proposal geometry/settings are embedded in the report.' },
          source_provenance: payload.source_provenance,
          kpis: {
            mean_shade_deficit_before_pct: shadeBefore, mean_shade_deficit_after_pct: shadeAfter,
            change_mean_shade_deficit_percentage_points: shadeChange,
            mean_heat_priority_score_before_0_100: scoreBefore,
            mean_heat_priority_score_after_0_100: scoreAfter,
            change_mean_heat_priority_score: scoreChange,
            analysis_area_m2: Number(payload.area_m2 || 0), zone_count: Number(payload.zone_count || 0),
            source_zone_count: Number(payload.source_zone_count || payload.zone_count || 0),
            excluded_sub_0_05_m2_zone_count: Number(payload.excluded_sub_0_05_m2_zone_count || 0),
          },
          result_data: { zone_points: payload.zone_points || [], zone_count: Number(payload.zone_count || 0) },
          caveat: payload.method,
        },
      } }));
    } catch (error) {
      if (revision !== designHeatCompareRevision) return;
      if (designHeatCompareStatus) designHeatCompareStatus.textContent = `Design heat/shade comparison unavailable (${error.message}).`;
    } finally {
      if (revision === designHeatCompareRevision && designHeatCompareButton) {
        designHeatCompareButton.disabled = !designProposalGeometry?.add_buildings?.length
          && !designProposalGeometry?.remove_building_indexes?.length;
      }
    }
  });

  function addBuildingSunMesh(payload, range, colorMetric = 'cumulative_sun_hours') {
    const positions = [];
    const colors = [];
    const pushTriangle = (a, b, c, color) => {
      positions.push(...a, ...b, ...c);
      for (let vertex = 0; vertex < 3; vertex += 1) colors.push(color.r, color.g, color.b);
    };
    for (const feature of payload.features || []) {
      const value = feature.display_value ?? feature.value;
      if (value == null) continue;
      const color = heatColor(value, range.min, range.max, colorMetric);
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
    stopSunPlayback();
    cancelSunHours('', true);
    if (mode === 'hours' && sunAnalysisDate) sunAnalysisDate.value = shadowState.date;
    if (mode === 'shadows' && sunDate) sunDate.value = shadowState.date;
    shadowState.mode = mode;
    updateWeatherSky(skyWeather, sunPosition());
    const cumulative = mode === 'hours';
    for (const button of sunModeButtons) {
      const active = button.dataset.sunMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (sunInstantControl) sunInstantControl.hidden = cumulative;
    if (sunShadowControls) sunShadowControls.hidden = cumulative;
    if (sunTimeTools) sunTimeTools.hidden = cumulative;
    if (sunWindowControls) sunWindowControls.hidden = !cumulative;
    if (sunDateTimeHeading) sunDateTimeHeading.textContent = cumulative ? 'Date & analysis window' : 'Date & time';
    if (sunHoursLegend) sunHoursLegend.hidden = !cumulative;
    if (sunHoursMethod) sunHoursMethod.hidden = !cumulative;
    if (sunCompare) sunCompare.hidden = !cumulative;
    if (!cumulative) {
      sunCompareSwitch.hidden = true;
      sunCompareSummary.hidden = true;
      sunInspect.hidden = true;
      sunInspectResult.hidden = true;
    }
    document.body.classList.remove('sun-result-switching');
    requestAnimationFrame(() => {
      document.body.classList.add('sun-result-switching');
      setTimeout(() => document.body.classList.remove('sun-result-switching'), 460);
    });
    sunGenerate.textContent = cumulative ? 'Calculate sun hours' : 'Generate shadows';
    heatGroup.visible = false;
    setBuildingAnalysisSkin(false);
    shadowState.generated = false;
    setSunMaterials(shadowState.enabled);
    sunStatus.textContent = cumulative
      ? 'Move the analysis area if needed, then calculate cumulative direct sunlight.'
      : 'Showing direct shadows for the selected Cape Town date and time.';
    requestRender();
    updateSunBox();
    if (!cumulative && shadowState.enabled) generateShadows();
  }

  function setSunDetail(level) {
    const detailed = level === 'detailed';
    sunDetailButtons.forEach(button => {
      const active = button.dataset.sunDetail === level;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (sunSurfaceResolution) sunSurfaceResolution.value = detailed ? '5' : '10';
    if (sunDomainSize) sunDomainSize.value = detailed ? '300' : '500';
    shadowState.size = detailed ? 300 : 500;
    cancelSunHours(`${detailed ? 'Detailed' : 'Quick'} preset selected · ${shadowState.size} m area · calculate sun hours.`);
    updateSunBox();
  }

  function setHeatMode(enabled) {
    if (enabled) restoreStreetLayersAfterWind();
    if (enabled && shadowState.enabled) {
      cancelSunHours('', false);
    }
    if (enabled && analysisGroupMode !== 'heat') {
      if (heatPayload?.thermal) buildThermalMesh(heatPayload);
      else if (heatPayload) buildHeatMesh(heatPayload);
      else {
        for (const object of heatGroup.children) disposeObject(object);
        heatGroup.clear();
        analysisGroupMode = null;
      }
    }
    heatGroup.visible = enabled && analysisGroupMode === 'heat';
    heatStreetGroup.visible = Boolean(enabled && heatStreetRankings.length
      && (heatStreetMapToggle?.checked || selectedHeatStreet));
    document.body.classList.toggle('heat-mode', enabled);
    if (enabled) {
      windFocusMarker.visible = false;
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
      windFocusMarker.visible = false;
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
    updateDesignShadePreview();
    syncLayerControls();
    refreshTransportVehicleLayers();
    syncGroundSurfaceMaterials();
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
  const ambientWheelLocal = new THREE.Vector3();
  const ambientWheelPosition = new THREE.Vector3();
  const ambientLanePosition = new THREE.Vector3();
  const ambientWheelMatrix = new THREE.Matrix4();

  // Ambient cars are a restrained scale cue for the road network. Their paths
  // come from the same mapped carriageways as the road ribbons, while TomTom
  // speed ratios set their pace as soon as the live snapshot arrives.
  const ambientTraffic = {
    group: null, fleets: [], speedByName: new Map(), parkedVehicles: [],
    movingVehicles: [], controllers: [], signalGroup: null, signalLensMeshes: null,
    clock: performance.now(), initialized: false, setupPending: false,
  };
  const ambientCarPaint = [0x8a5547, 0x617a72, 0xc0a66f, 0x596776, 0xb2b0a3, 0x885f70, 0x687c91, 0x9b684c, 0x76816a, 0x545756];
  const ambientCarSpecs = [
    { body: [1.82, 0.62, 4.05], cabin: [1.52, 0.58, 2.18], cabinZ: -0.05, wheelZ: 1.26 }, // compact hatchback
    { body: [1.88, 0.61, 4.55], cabin: [1.5, 0.54, 2.12], cabinZ: -0.24, wheelZ: 1.39 }, // three-box sedan
    { body: [1.94, 0.73, 4.65], cabin: [1.62, 0.72, 2.72], cabinZ: 0.08, wheelZ: 1.42 }, // minibus taxi
  ];
  const ambientMaxCars = 2400;
  // Moving instances add useful street-level life but are visually negligible
  // at the full-city overview. Keep the overview render-on-demand; resume the
  // traffic animation when the camera is close enough to read individual cars.
  const ambientTrafficAnimationDistance = 400;
  // A guideline-informed fixed-time fallback where no site timing plan is
  // mapped. SARTSM Vol 3 §§6.12–6.13 (May 2012) gives a 50–100 s typical
  // cycle range, a 3 s minimum yellow at <=60 km/h, and a 2 s minimum
  // all-red for ordinary movements. OSM contains signal locations, not the
  // commissioned timing sheets, so these are plausible local defaults rather
  // than claimed Cape Town timings. Both greens exceed its 11 s preference.
  // This 60 s plan gives 32 s major green + 18 s minor green, with a 3 s
  // yellow and 2 s all-red clearance between stages.
  const trafficSignalTiming = {
    cycleSeconds: 60,
    majorGreenSeconds: 32,
    minorGreenSeconds: 18,
    yellowSeconds: 3,
    allRedSeconds: 2,
  };

  function normalizeTrafficRoadName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim()
      .replace(/\b(street|st|str|road|rd|avenue|ave|boulevard|blvd)\s*$/, '')
      .replace(/\s+/g, '');
  }

  function findTrafficSignalControllers(corridors) {
    const sites = [];
    for (const signal of data.trafficSignals || []) {
      const [x, z] = signal.coordinates || [];
      if (!Number.isFinite(x) || !Number.isFinite(z) || !terrainValidAt(x, z)) continue;
      let site = sites.find(candidate => Math.hypot(candidate.x - x, candidate.z - z) < 36);
      if (!site) {
        site = { osmId: signal.osmId, x, z, signals: [], stops: [], heading: 0, goAxis: 0, lastGoAxis: null };
        sites.push(site);
      }
      site.signals.push(signal);
    }

    for (const site of sites) {
      site.x = site.signals.reduce((sum, signal) => sum + signal.coordinates[0], 0) / site.signals.length;
      site.z = site.signals.reduce((sum, signal) => sum + signal.coordinates[1], 0) / site.signals.length;
    }

    for (const site of sites) {
      for (const signal of site.signals) {
        const [signalX, signalZ] = signal.coordinates;
        let nearest = null;
        for (let corridorIndex = 0; corridorIndex < corridors.length; corridorIndex += 1) {
          const corridor = corridors[corridorIndex];
          const bounds = corridor.bounds;
          if (signalX < bounds.minX - 18 || signalX > bounds.maxX + 18
            || signalZ < bounds.minZ - 18 || signalZ > bounds.maxZ + 18) continue;
          for (let segment = 1; segment < corridor.points.length; segment += 1) {
            const [ax, az] = corridor.points[segment - 1], [bx, bz] = corridor.points[segment];
            const dx = bx - ax, dz = bz - az;
            const segmentLength = corridor.cumulative[segment] - corridor.cumulative[segment - 1];
            if (segmentLength < 0.1) continue;
            const amount = clamp(((signalX - ax) * dx + (signalZ - az) * dz) / (segmentLength * segmentLength), 0, 1);
            const x = ax + dx * amount, z = az + dz * amount;
            const distanceSq = (signalX - x) ** 2 + (signalZ - z) ** 2;
            if (!nearest || distanceSq < nearest.distanceSq) {
              nearest = {
                corridorIndex,
                distance: corridor.cumulative[segment - 1] + segmentLength * amount,
                distanceSq,
                roadX: x,
                roadZ: z,
                roadWidth: Number(corridor.road.width) || 4,
                heading: Math.atan2(dx, dz),
                axis: Math.abs(dx) >= Math.abs(dz) ? 0 : 1,
              };
            }
          }
        }
        if (!nearest || nearest.distanceSq > 18 * 18) continue;
        const corridor = corridors[nearest.corridorIndex];
        signal.controller = site;
        signal.axis = nearest.axis;
        signal.heading = nearest.heading;
        const tangentX = Math.sin(nearest.heading);
        const tangentZ = Math.cos(nearest.heading);
        const towardCenter = (site.x - nearest.roadX) * tangentX + (site.z - nearest.roadZ) * tangentZ;
        const approachDirection = Math.abs(towardCenter) > 1
          ? Math.sign(towardCenter)
          : (Number(signal.osmId) % 2 ? 1 : -1);
        const centerlineOffset = (signalX - nearest.roadX) * -tangentZ + (signalZ - nearest.roadZ) * tangentX;
        const roadside = Math.abs(centerlineOffset) > 1.5 ? Math.sign(centerlineOffset) : approachDirection;
        const roadsideX = -tangentZ * roadside;
        const roadsideZ = tangentX * roadside;
        const poleOffset = Math.max(2.8, nearest.roadWidth * 0.5 + 1.1);
        signal.lightCoordinates = [nearest.roadX + roadsideX * poleOffset, nearest.roadZ + roadsideZ * poleOffset];
        // The signal face looks back toward its approaching traffic. South
        // African traffic keeps left, so the pole is on the approach's left.
        signal.lightHeading = nearest.heading + (approachDirection > 0 ? Math.PI : 0);
        // OSM traffic-signal points are usually placed on a pole at the
        // corner, rather than on the stop line. Keep a stop for the approach
        // the signal faces and move it upstream of the junction. A signal
        // must not stop traffic travelling away from it on the same road.
        const setback = clamp(2 + nearest.roadWidth * 0.35, 3.5, 5.5);
        const stopDistance = nearest.distance - approachDirection * setback;
        if (stopDistance < 1 || stopDistance > corridor.length - 1) continue;
        if (corridor.stops.some(stop => stop.site === site && stop.direction === approachDirection
          && Math.abs(stop.distance - stopDistance) < 8)) continue;
        const stop = {
          ...nearest,
          distance: stopDistance,
          intersectionDistance: nearest.distance,
          clearanceDistance: clamp(nearest.roadWidth * 1.5, 7, 12),
          direction: approachDirection,
          site,
          index: site.stops.length,
        };
        corridor.stops.push(stop);
        site.stops.push(stop);
        if (site.stops.length === 1) site.heading = nearest.heading;
      }
    }

    return sites.filter(site => site.stops.length > 0);
  }

  function buildMappedTrafficLights(controllers) {
    const mappedSignals = controllers.flatMap(controller => controller.signals
      .filter(signal => Number.isFinite(signal.heading))
      .map(signal => ({ ...signal, controller })));
    if (!mappedSignals.length) return;
    const group = new THREE.Group();
    group.name = 'mapped-osm-traffic-lights';
    group.renderOrder = 8;
    const count = mappedSignals.length;
    const parts = [
      ['pole', new THREE.CylinderGeometry(0.065, 0.09, 4.5, 8), new THREE.MeshStandardMaterial({ color: 0x465156, metalness: 0.28, roughness: 0.56 })],
      ['head', new THREE.BoxGeometry(0.42, 1.02, 0.34), new THREE.MeshStandardMaterial({ color: 0x293237, metalness: 0.12, roughness: 0.62 })],
      ['red', new THREE.SphereGeometry(0.105, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })],
      ['amber', new THREE.SphereGeometry(0.105, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })],
      ['green', new THREE.SphereGeometry(0.105, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })],
    ];
    const meshes = new Map();
    for (const [name, geometry, material] of parts) {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.name = `osm-traffic-light-${name}`;
      mesh.frustumCulled = false;
      mesh.castShadow = name === 'pole' || name === 'head';
      mesh.receiveShadow = false;
      group.add(mesh);
      meshes.set(name, mesh);
    }

    const up = new THREE.Vector3(0, 1, 0);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const matrix = new THREE.Matrix4();
    mappedSignals.forEach((signal, index) => {
      signal.lightIndex = index;
      const groundY = terrainSurfaceHeightAt(signal.lightCoordinates[0], signal.lightCoordinates[1]);
      const yaw = signal.lightHeading;
      quaternion.setFromAxisAngle(up, yaw);
      const setPart = (name, x, y, z) => {
        position.set(signal.lightCoordinates[0], groundY + y, signal.lightCoordinates[1]);
        position.x += Math.sin(yaw) * z + Math.cos(yaw) * x;
        position.z += Math.cos(yaw) * z - Math.sin(yaw) * x;
        matrix.compose(position, quaternion, scale);
        meshes.get(name).setMatrixAt(index, matrix);
      };
      setPart('pole', 0, 2.25, 0);
      setPart('head', 0, 4.18, 0.12);
      setPart('red', 0, 4.48, 0.31);
      setPart('amber', 0, 4.18, 0.31);
      setPart('green', 0, 3.88, 0.31);
    });
    for (const mesh of meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    ambientTraffic.signalGroup = group;
    ambientTraffic.signalLensMeshes = { red: meshes.get('red'), amber: meshes.get('amber'), green: meshes.get('green') };
    layerGroups.roads.add(group);
    updateTrafficSignalLights(performance.now(), mappedSignals);
  }

  function updateTrafficSignalLights(now, mappedSignals = null) {
    const lenses = ambientTraffic.signalLensMeshes;
    if (!lenses) return;
    const signals = mappedSignals || ambientTraffic.mappedSignals || [];
    let changed = { red: false, amber: false, green: false };
    const changedControllers = new Set();
    for (const controller of ambientTraffic.controllers) {
      const { cycleSeconds, majorGreenSeconds, minorGreenSeconds, yellowSeconds, allRedSeconds } = trafficSignalTiming;
      const phase = ((now / 1000 + controller.phaseOffset) % cycleSeconds + cycleSeconds) % cycleSeconds;
      const majorAxis = controller.majorAxis;
      const minorAxis = 1 - majorAxis;
      const majorYellowStart = majorGreenSeconds;
      const majorRedStart = majorYellowStart + yellowSeconds;
      const minorGreenStart = majorRedStart + allRedSeconds;
      const minorYellowStart = minorGreenStart + minorGreenSeconds;
      const minorRedStart = minorYellowStart + yellowSeconds;
      if (phase < majorYellowStart) {
        controller.goAxis = majorAxis;
        controller.yellowAxis = -1;
        controller.allRed = false;
      } else if (phase < majorRedStart) {
        controller.goAxis = -1;
        controller.yellowAxis = majorAxis;
        controller.allRed = false;
      } else if (phase < minorGreenStart) {
        controller.goAxis = -1;
        controller.yellowAxis = -1;
        controller.allRed = true;
      } else if (phase < minorYellowStart) {
        controller.goAxis = minorAxis;
        controller.yellowAxis = -1;
        controller.allRed = false;
      } else if (phase < minorRedStart) {
        controller.goAxis = -1;
        controller.yellowAxis = minorAxis;
        controller.allRed = false;
      } else {
        controller.goAxis = -1;
        controller.yellowAxis = -1;
        controller.allRed = true;
      }
      const displayKey = `${controller.goAxis}:${controller.yellowAxis}:${controller.allRed}`;
      if (controller.lastDisplayKey === displayKey) continue;
      controller.lastDisplayKey = displayKey;
      changedControllers.add(controller);
    }
    for (const signal of signals) {
      if (!changedControllers.has(signal.controller)) continue;
      const colors = signal.controller.yellowAxis === signal.axis
        ? { red: 0x641b16, amber: 0xffc641, green: 0x164526 }
        : signal.controller.goAxis === signal.axis
          ? { red: 0x641b16, amber: 0x59431a, green: 0x39ff78 }
          : { red: 0xff3328, amber: 0x59431a, green: 0x164526 };
      for (const name of ['red', 'amber', 'green']) {
        lenses[name].setColorAt(signal.lightIndex, carColor.setHex(colors[name]));
        changed[name] = true;
      }
    }
    for (const name of Object.keys(changed)) {
      if (changed[name] && lenses[name].instanceColor) lenses[name].instanceColor.needsUpdate = true;
    }
    if (mappedSignals) ambientTraffic.mappedSignals = mappedSignals;
  }

  function makeAmbientBodyGeometry(model) {
    const spec = ambientCarSpecs[model];
    const main = new THREE.BoxGeometry(...spec.body);
    main.translate(0, 0.38, 0);
    const roof = new THREE.BoxGeometry(spec.cabin[0] * 0.91, 0.13, spec.cabin[2] * 0.58);
    roof.translate(0, 1.15, spec.cabinZ);
    const mainPositions = main.getAttribute('position').array;
    const roofPositions = roof.getAttribute('position').array;
    const mainNormals = main.getAttribute('normal').array;
    const roofNormals = roof.getAttribute('normal').array;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...mainPositions, ...roofPositions], 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([...mainNormals, ...roofNormals], 3));
    geometry.setIndex([
      ...main.getIndex().array,
      ...[...roof.getIndex().array].map(index => index + mainPositions.length / 3),
    ]);
    main.dispose();
    roof.dispose();
    geometry.name = `ambient-${model}-body`;
    return geometry;
  }

  function makeAmbientCabinGeometry(model) {
    const spec = ambientCarSpecs[model];
    const cabin = new THREE.BoxGeometry(...spec.cabin);
    cabin.translate(0, 0.86, spec.cabinZ);
    return cabin;
  }

  function ambientCorridorRatio(corridor) {
    const ratio = corridor.nameKey ? ambientTraffic.speedByName.get(corridor.nameKey) : null;
    if (Number.isFinite(ratio)) return clamp(ratio, 0.08, 1.12);
    return Number.isFinite(ambientTraffic.cityRatio) ? clamp(ambientTraffic.cityRatio, 0.08, 1.12) : 0.62;
  }

  function pointInsideRing(x, z, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
      const [ax, az] = ring[index], [bx, bz] = ring[previous];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
    }
    return inside;
  }

  function parkingLotContains(lot, x, z) {
    const rings = lot.rings || [];
    return Boolean(rings[0]?.length >= 3 && pointInsideRing(x, z, rings[0])
      && !rings.slice(1).some(hole => pointInsideRing(x, z, hole)));
  }

  function parkingSlotFits(lot, x, z, heading, scale) {
    const halfWidth = 1.0 * scale;
    const halfLength = 2.15 * scale;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) {
        const cornerX = x + side * halfWidth * cos + end * halfLength * sin;
        const cornerZ = z - side * halfWidth * sin + end * halfLength * cos;
        if (!parkingLotContains(lot, cornerX, cornerZ)) return false;
      }
    }
    return true;
  }

  function makeParkedLotVehicles() {
    const vehicles = [];
    const maxParkedCars = 800;
    const parkedCarsOverlap = (x, z, heading, scale) => {
      const halfWidth = 1.0 * scale + 0.12;
      const halfLength = 2.15 * scale + 0.12;
      const widthAxis = [Math.cos(heading), -Math.sin(heading)];
      const lengthAxis = [Math.sin(heading), Math.cos(heading)];
      for (const other of vehicles) {
        const otherWidth = 1.0 * other.scale + 0.12;
        const otherLength = 2.15 * other.scale + 0.12;
        const dx = x - other.x, dz = z - other.z;
        if (Math.hypot(dx, dz) > halfLength + halfWidth + otherLength + otherWidth) continue;
        const otherWidthAxis = [Math.cos(other.heading), -Math.sin(other.heading)];
        const otherLengthAxis = [Math.sin(other.heading), Math.cos(other.heading)];
        const axes = [widthAxis, lengthAxis, otherWidthAxis, otherLengthAxis];
        let separated = false;
        for (const axis of axes) {
          const distance = Math.abs(dx * axis[0] + dz * axis[1]);
          const thisRadius = halfWidth * Math.abs(widthAxis[0] * axis[0] + widthAxis[1] * axis[1])
            + halfLength * Math.abs(lengthAxis[0] * axis[0] + lengthAxis[1] * axis[1]);
          const otherRadius = otherWidth * Math.abs(otherWidthAxis[0] * axis[0] + otherWidthAxis[1] * axis[1])
            + otherLength * Math.abs(otherLengthAxis[0] * axis[0] + otherLengthAxis[1] * axis[1]);
          if (distance >= thisRadius + otherRadius) { separated = true; break; }
        }
        if (!separated) return true;
      }
      return false;
    };
    const parkingSurfaceY = (x, z) => terrainSurfaceHeightAt(x, z) + SCENE_LAYERS.groundTexture.lift + 0.05;
    const addSlot = (lot, x, z, heading, seed, arrival = null) => {
      if (vehicles.length >= maxParkedCars) return;
      const scale = 0.82 + (seed % 5) * 0.035;
      if (!parkingLotContains(lot, x, z) || !parkingSlotFits(lot, x, z, heading, scale)) return;
      if (seed % 100 >= 62 || parkedCarsOverlap(x, z, heading, scale)) return;
      const parkedY = parkingSurfaceY(x, z);
      vehicles.push({
        parked: true,
        x, z, heading,
        y: parkedY,
        arrival: arrival ? {
          ...arrival,
          startAt: performance.now() + ((seed * 137) % 45000),
          duration: 2800,
          targetX: x, targetZ: z, targetY: parkedY,
          targetHeading: heading,
        } : null,
        model: seed % 3,
        color: ambientCarPaint[seed % ambientCarPaint.length],
        scale,
        lane: 0,
        speed: 0,
      });
    };

    for (let lotIndex = 0; lotIndex < ambientParkingLots.length && vehicles.length < maxParkedCars; lotIndex += 1) {
      const lot = ambientParkingLots[lotIndex];
      const lotCandidates = [];
      for (const aisle of ambientParkingAisles) {
        const points = aisle.points || [];
        let distanceAlong = 0;
        for (let segment = 1; segment < points.length; segment += 1) {
          const [ax, az] = points[segment - 1], [bx, bz] = points[segment];
          const dx = bx - ax, dz = bz - az;
          const length = Math.hypot(dx, dz);
          if (length < 4) { distanceAlong += length; continue; }
          const stepCount = Math.max(1, Math.floor(length / 6.3));
          for (let step = 0; step < stepCount; step += 1) {
            const along = Math.min(length, (step + 0.5) * length / stepCount);
            const aisleX = ax + dx * along / length;
            const aisleZ = az + dz * along / length;
            if (!parkingLotContains(lot, aisleX, aisleZ)) continue;
            const tangentX = dx / length, tangentZ = dz / length;
            for (const side of [-1, 1]) {
              const normalX = -tangentZ * side, normalZ = tangentX * side;
              const x = aisleX + normalX * 4.0;
              const z = aisleZ + normalZ * 4.0;
              const heading = Math.atan2(normalX, normalZ);
              if (!parkingSlotFits(lot, x, z, heading, 0.88)) continue;
              const aisleHeading = Math.atan2(tangentX, tangentZ);
              const startX = aisleX + normalX * 0.55;
              const startZ = aisleZ + normalZ * 0.55;
              const seed = (Number(lot.osmId) * 37 + segment * 19 + step * 11 + side * 23) >>> 0;
              const aisleY = roadSurfaceHeightAt(startX, startZ) + (aisle.verticalOffset || 0) + (aisle.surfaceOffset || 0) + 0.02;
              lotCandidates.push({
                x, z, heading, seed,
                arrival: seed % 19 === 0 ? { startX, startZ, startY: aisleY, startHeading: aisleHeading } : null,
              });
            }
          }
          distanceAlong += length;
        }
      }

      // Some surface lots have no mapped aisle lines. Give those a simple
      // perpendicular parking layout based on their longest mapped edge.
      if (!lotCandidates.length) {
        const ring = lot.rings?.[0] || [];
        let longest = null;
        for (let index = 0; index < ring.length; index += 1) {
          const a = ring[index], b = ring[(index + 1) % ring.length];
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (!longest || length > longest.length) longest = { a, b, length };
        }
        if (longest?.length > 12) {
          const tx = (longest.b[0] - longest.a[0]) / longest.length;
          const tz = (longest.b[1] - longest.a[1]) / longest.length;
          const nx = -tz, nz = tx;
          const projected = ring.map(([x, z]) => [x * tx + z * tz, x * nx + z * nz]);
          const minAlong = Math.min(...projected.map(point => point[0]));
          const maxAlong = Math.max(...projected.map(point => point[0]));
          const minAcross = Math.min(...projected.map(point => point[1]));
          const maxAcross = Math.max(...projected.map(point => point[1]));
          let seed = Number(lot.osmId) || lotIndex + 1;
          for (let across = minAcross + 4.2; across < maxAcross - 3; across += 8.5) {
            for (let along = minAlong + 3.1; along < maxAlong - 3; along += 6.3) {
              const x = tx * along + nx * across;
              const z = tz * along + nz * across;
              const heading = Math.atan2(nx, nz);
              if (parkingSlotFits(lot, x, z, heading, 0.88)) lotCandidates.push({ x, z, heading, seed: seed++ });
            }
          }
        }
      }

      for (const candidate of lotCandidates) {
        addSlot(lot, candidate.x, candidate.z, candidate.heading, candidate.seed, candidate.arrival);
      }
    }
    return vehicles;
  }

  function makeMappedParkedVehicles(parking = []) {
    const vehicles = [];
    for (const [index, bay] of parking.entries()) {
      if (!bay.coordinates || !terrainValidAt(bay.coordinates[0], bay.coordinates[1])) continue;
      const identifier = String(bay.identifier || index);
      let seed = 2166136261;
      for (let charIndex = 0; charIndex < identifier.length; charIndex += 1) {
        seed = Math.imul(seed ^ identifier.charCodeAt(charIndex), 16777619);
      }
      seed >>>= 0;
      // A stable 28% illustrative occupancy keeps curb rows lived-in without
      // filling every mapped bay. The identifier seed makes each visit match.
      if (seed % 100 >= 28) continue;
      const bearing = THREE.MathUtils.degToRad(Number(bay.attributes?.roadBearingDeg) || 0);
      const heading = Math.atan2(Math.cos(bearing), Math.sin(bearing));
      const model = seed % ambientCarSpecs.length;
      const scale = 0.82 + ((seed >>> 4) % 5) * 0.035;
      vehicles.push({
        parked: true,
        mappedBay: true,
        x: bay.coordinates[0],
        z: bay.coordinates[1],
        heading,
        y: terrainSurfaceHeightAt(bay.coordinates[0], bay.coordinates[1]) + 0.44,
        model,
        color: ambientCarPaint[(seed >>> 8) % ambientCarPaint.length],
        scale,
        lane: 0,
        speed: 0,
      });
    }
    return vehicles;
  }

  let mappedParkingLoaded = false;
  let mappedParkingPromise = null;
  function ensureMappedParkingVehicles() {
    if (mappedParkingLoaded || mappedParkingPromise) return mappedParkingPromise || Promise.resolve();
    const asset = manifest.assets?.public_realm;
    if (!asset) return Promise.resolve();
    const version = manifest.layers?.public_realm?.cache_key || manifest.layers?.public_realm?.bytes || 0;
    mappedParkingPromise = fetch(`/assets/${asset}?v=${version}`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`parking inventory HTTP ${response.status}`)))
      .then(payload => {
        const parked = makeMappedParkedVehicles(Array.isArray(payload.parking) ? payload.parking : []);
        ambientTraffic.parkedVehicles.push(...parked);
        mappedParkingLoaded = true;
        if (ambientTraffic.initialized) rebuildAmbientTrafficFleet();
      })
      .catch(error => console.warn(`Mapped parked cars unavailable: ${error.message}`))
      .finally(() => { mappedParkingPromise = null; });
    return mappedParkingPromise;
  }

  function rebuildAmbientTrafficFleet() {
    if (!ambientTraffic.corridors?.length) return;
    if (ambientTraffic.group) {
      layerGroups.roads.remove(ambientTraffic.group);
      disposeObject(ambientTraffic.group);
    }
    const vehicles = [];
    const counts = [];
    let desiredTotal = 0;
    for (const corridor of ambientTraffic.corridors) {
      corridor.vehicles = [];
      const road = corridor.road;
      const ratio = ambientCorridorRatio(corridor);
      const congestion = clamp((0.94 - ratio) / 0.82, 0, 1);
      // Keep at least 10 m between cars in a near-standstill queue, then spread
      // them toward 115 m on clear streets. This leaves room for the longest
      // modeled car and its following distance before the first frame.
      const spacing = 115 - congestion * 105;
      const taggedLanes = Number.parseInt(road.attributes?.lanes, 10);
      const laneCount = clamp(Number.isFinite(taggedLanes) && taggedLanes > 0
        ? taggedLanes : Math.round((Number(road.width) || 4) / 3.35), 1, 4);
      // TomTom supplies sampled speeds, not vehicle counts. Closer spacing
      // therefore follows a matched road's observed slowdown as an illustrative
      // queue, while unsampled roads use the citywide speed ratio.
      const desired = corridor.length / spacing * laneCount;
      counts.push(desired);
      desiredTotal += desired;
      corridor.laneCount = laneCount;
      corridor.congestion = congestion;
    }

    const populationScale = Math.min(1, ambientMaxCars / desiredTotal);
    for (let corridorIndex = 0; corridorIndex < ambientTraffic.corridors.length; corridorIndex += 1) {
      const corridor = ambientTraffic.corridors[corridorIndex];
      const count = Math.floor(counts[corridorIndex] * populationScale);
      const attributes = corridor.road.attributes || {};
      const oneWay = String(attributes.oneway || '').toLowerCase();
      const oneWayDirection = oneWay === '-1' ? -1 : 1;
      for (let index = 0; index < count; index += 1) {
        const seed = (corridorIndex * 37 + index * 19) % 997;
        const laneIndex = index % corridor.laneCount;
        const oneWayRoad = ['yes', 'true', '1', '-1'].includes(oneWay);
        const direction = oneWayRoad ? oneWayDirection
          : corridor.laneCount > 1 ? (laneIndex % 2 ? -1 : 1) : (index % 2 ? -1 : 1);
        const roadWidth = Number(corridor.road.width) || 4;
        const laneWidth = roadWidth / corridor.laneCount;
        const lane = oneWayRoad
          ? (laneIndex - (corridor.laneCount - 1) / 2) * Math.min(2.8, laneWidth)
          : corridor.laneCount === 1 ? (direction > 0 ? -1 : 1) * Math.max(0.85, Math.min(1.15, roadWidth * 0.28)) : (direction > 0 ? -1 : 1) * Math.min(
            Math.max(0.45, roadWidth * 0.5 - 0.8),
            Math.min(1.35, Math.max(0.45, laneWidth * 0.5)) + Math.floor(laneIndex / 2) * Math.min(2.8, laneWidth),
          );
        const progress = (index + 0.35 + (seed % 13) / 25) / Math.max(count, 1);
        const vehicle = {
          corridorIndex,
          distance: progress * corridor.length,
          direction,
          model: seed % 3,
          color: ambientCarPaint[seed % ambientCarPaint.length],
          scale: 0.78 + (seed % 5) * 0.035,
          lane,
          laneCount: corridor.laneCount,
          speed: 8.5 + (seed % 7) * 0.55,
        };
        vehicles.push(vehicle);
        corridor.vehicles.push(vehicle);
      }
    }
    stageAmbientTrafficSpawnsAtSignals(vehicles);
    resolveAmbientTrafficSpawnOverlaps(vehicles);
    ambientTraffic.movingVehicles = vehicles;
    for (const corridor of ambientTraffic.corridors) {
      corridor.vehicles = corridor.vehicles.filter(vehicle => !vehicle.disabled);
    }
    for (const vehicle of ambientTraffic.parkedVehicles) vehicle.rendered = false;
    vehicles.push(...ambientTraffic.parkedVehicles);

    const group = new THREE.Group();
    group.name = 'ambient-tomtom-traffic';
    group.renderOrder = 7;
    layerGroups.roads.add(group);
    ambientTraffic.group = group;
    ambientTraffic.fleets = [0, 1, 2].map(model => {
      const selected = vehicles.filter(vehicle => vehicle.model === model);
      const body = new THREE.InstancedMesh(
        makeAmbientBodyGeometry(model),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68, metalness: 0.05 }),
        Math.max(1, selected.length),
      );
      const cabin = new THREE.InstancedMesh(
        makeAmbientCabinGeometry(model),
        new THREE.MeshStandardMaterial({ color: 0x34454c, roughness: 0.28, metalness: 0.12 }),
        Math.max(1, selected.length),
      );
      const wheelGeometry = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 9);
      wheelGeometry.rotateZ(Math.PI / 2);
      const wheels = new THREE.InstancedMesh(
        wheelGeometry,
        new THREE.MeshStandardMaterial({ color: 0x292b2a, roughness: 0.96 }),
        Math.max(1, selected.length * 4),
      );
      const rimGeometry = new THREE.CylinderGeometry(0.14, 0.14, 0.22, 8);
      rimGeometry.rotateZ(Math.PI / 2);
      const rims = new THREE.InstancedMesh(
        rimGeometry,
        new THREE.MeshStandardMaterial({ color: 0x96948b, roughness: 0.5, metalness: 0.26 }),
        Math.max(1, selected.length * 4),
      );
      body.name = `ambient-car-bodies-${model}`;
      cabin.name = `ambient-car-glass-${model}`;
      wheels.name = `ambient-car-wheels-${model}`;
      rims.name = `ambient-car-rims-${model}`;
      for (const mesh of [body, cabin, wheels, rims]) {
        mesh.frustumCulled = false;
        mesh.count = 0;
        group.add(mesh);
      }
      selected.forEach((vehicle, index) => body.setColorAt(index, carColor.setHex(vehicle.color)));
      if (body.instanceColor) body.instanceColor.needsUpdate = true;
      return { model, vehicles: selected, body, cabin, wheels, rims };
    });
    ambientTraffic.clock = performance.now();
  }

  function setupAmbientTraffic() {
    if (ambientTraffic.initialized) return;
    ambientTraffic.initialized = true;
    const corridors = ambientTrafficRoads.flatMap(road => visiblePolyline(road.points).map(points => {
      if (!points || points.length < 2) return null;
      const corridorRoad = { ...road, points };
      const cumulative = [0];
      const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
      for (let index = 1; index < points.length; index += 1) {
        cumulative.push(cumulative[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
      }
      for (const [x, z] of points) {
        bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
      }
      const length = cumulative[cumulative.length - 1];
      if (length < 15) return null;
      const rawName = corridorRoad.attributes?.name || corridorRoad.attributes?.['name:en'] || '';
      const name = String(rawName).trim().toLocaleLowerCase();
      return { road: corridorRoad, points, cumulative, length, name, nameKey: normalizeTrafficRoadName(name), bounds, stops: [], vehicles: [] };
    })).filter(Boolean);
    if (!corridors.length) return;
    ambientTraffic.corridors = corridors;
    ambientTraffic.controllers = findTrafficSignalControllers(corridors);
    for (const controller of ambientTraffic.controllers) {
      controller.phaseOffset = Number(controller.osmId) % trafficSignalTiming.cycleSeconds;
      const axisPriority = [0, 0];
      const classPriority = {
        motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
        unclassified: 5, residential: 5, living_street: 4, service: 3,
      };
      for (const stop of controller.stops) {
        const corridor = corridors[stop.corridorIndex];
        const roadClass = String(corridor.road.attributes?.highway || '').toLowerCase();
        const lanes = Number.parseInt(corridor.road.attributes?.lanes, 10) || 1;
        const priority = (classPriority[roadClass] || 3) * 10 + Math.min(4, lanes);
        axisPriority[stop.axis] = Math.max(axisPriority[stop.axis], priority);
      }
      controller.majorAxis = axisPriority[0] >= axisPriority[1] ? 0 : 1;
    }
    ambientTraffic.parkedVehicles = makeParkedLotVehicles();
    rebuildAmbientTrafficFleet();
    void ensureMappedParkingVehicles();
    buildMappedTrafficLights(ambientTraffic.controllers);
  }

  function scheduleAmbientTrafficSetup() {
    if (ambientTraffic.initialized || ambientTraffic.setupPending
      || viewshedState.active || cameraState.distance > 900 || !layerGroups.roads.visible) return;
    ambientTraffic.setupPending = true;
    const prepare = () => {
      ambientTraffic.setupPending = false;
      if (viewshedState.active || cameraState.distance > 900 || !layerGroups.roads.visible) return;
      setupAmbientTraffic();
      requestRender();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(prepare, { timeout: 1200 });
    else setTimeout(prepare, 160);
  }

  function trafficSignalQueueTargets() {
    const targets = new Map();
    for (const corridor of ambientTraffic.corridors) {
      const queues = new Map();
      const oneway = ['yes', 'true', '1', '-1'].includes(String(corridor.road.attributes?.oneway || '').toLowerCase());
      for (const vehicle of corridor.vehicles) {
        let nearest = null;
        for (const stop of corridor.stops) {
          if (vehicle.direction !== stop.direction) continue;
          let gap = vehicle.direction > 0 ? stop.distance - vehicle.distance : vehicle.distance - stop.distance;
          if (gap < 0 && oneway) gap += corridor.length;
          const passedIntersection = vehicle.direction > 0
            ? vehicle.distance - stop.intersectionDistance
            : stop.intersectionDistance - vehicle.distance;
          const clearance = vehicle.signalClearance;
          if (clearance?.site === stop.site && clearance.corridorIndex === vehicle.corridorIndex
            && clearance.direction === vehicle.direction) {
            if (passedIntersection <= clearance.clearanceDistance) continue;
            vehicle.signalClearance = null;
          }
          // A vehicle close to the stop line when amber begins should clear
          // the junction. Holding it at the line during an all-red transition
          // can leave its body stopped across the crossing.
          if (stop.site.yellowAxis === stop.axis && gap <= 0
            && passedIntersection <= stop.clearanceDistance && passedIntersection >= -12) {
            vehicle.signalClearance = {
              site: stop.site,
              corridorIndex: vehicle.corridorIndex,
              direction: vehicle.direction,
              clearanceDistance: stop.clearanceDistance,
            };
            continue;
          }
          if (stop.site.yellowAxis === stop.axis && gap >= 0) {
            const frontLength = ambientCarSpecs[vehicle.model].body[2] * vehicle.scale * 0.5;
            const approachSpeed = vehicle.speed * ambientCorridorRatio(corridor);
            const clearanceGap = frontLength + Math.max(4, approachSpeed * 0.75);
            if (gap <= clearanceGap && passedIntersection <= stop.clearanceDistance) {
              vehicle.signalClearance = {
                site: stop.site,
                corridorIndex: vehicle.corridorIndex,
                direction: vehicle.direction,
                clearanceDistance: stop.clearanceDistance,
              };
              continue;
            }
          }
          if (stop.site.goAxis === stop.axis) continue;
          if (gap < 0 || gap > 420 || (nearest && gap >= nearest.gap)) continue;
          nearest = { stop, gap };
        }
        if (!nearest) continue;
        const directionQueues = queues.get(nearest.stop) || new Map([[1, new Map()], [-1, new Map()]]);
        const laneKey = Math.round(vehicle.lane / 0.75);
        const laneQueue = directionQueues.get(vehicle.direction).get(laneKey) || [];
        laneQueue.push({ vehicle, gap: nearest.gap });
        directionQueues.get(vehicle.direction).set(laneKey, laneQueue);
        queues.set(nearest.stop, directionQueues);
      }
      for (const [stop, directionQueues] of queues) {
        for (const laneQueues of directionQueues.values()) {
          for (const queue of laneQueues.values()) {
            queue.sort((first, second) => first.gap - second.gap);
            queue.forEach(({ vehicle, gap }, index) => {
              const frontClearance = ambientCarSpecs[vehicle.model].body[2] * vehicle.scale * 0.5 + 1.5;
              targets.set(vehicle, { gap, slotGap: frontClearance + index * 7.2 });
            });
          }
        }
      }
    }
    return targets;
  }

  function ambientTrafficVehiclePose(vehicle, distance = vehicle.distance, direction = vehicle.direction, lane = vehicle.lane) {
    const corridor = ambientTraffic.corridors[vehicle.corridorIndex];
    if (!corridor) return null;
    distance = clamp(distance, 0, corridor.length);
    let segment = 0;
    while (segment < corridor.cumulative.length - 2 && corridor.cumulative[segment + 1] < distance) segment += 1;
    const start = corridor.points[segment], end = corridor.points[segment + 1];
    const segmentLength = corridor.cumulative[segment + 1] - corridor.cumulative[segment] || 1;
    const fraction = (distance - corridor.cumulative[segment]) / segmentLength;
    const dx = (end[0] - start[0]) / segmentLength * direction;
    const dz = (end[1] - start[1]) / segmentLength * direction;
    return {
      x: start[0] + (end[0] - start[0]) * fraction + dz * lane,
      z: start[1] + (end[1] - start[1]) * fraction - dx * lane,
      heading: Math.atan2(dx, dz),
      direction,
      lane,
      halfLength: ambientCarSpecs[vehicle.model].body[2] * vehicle.scale * 0.5 + 0.08,
      halfWidth: ambientCarSpecs[vehicle.model].body[0] * vehicle.scale * 0.5 + 0.08,
    };
  }

  function ambientTrafficAdvance(vehicle, travel) {
    const corridor = ambientTraffic.corridors[vehicle.corridorIndex];
    const oneway = ['yes', 'true', '1', '-1'].includes(String(corridor.road.attributes?.oneway || '').toLowerCase());
    let distance = vehicle.distance;
    let direction = vehicle.direction;
    let lane = vehicle.lane;
    if (oneway) {
      distance = (distance + travel * direction) % corridor.length;
      if (distance < 0) distance += corridor.length;
    } else if (direction > 0) {
      distance += travel;
      if (distance >= corridor.length) {
        distance = corridor.length - (distance - corridor.length);
        direction = -1;
        lane = -lane;
      }
    } else {
      distance -= travel;
      if (distance <= 0) {
        distance = -distance;
        direction = 1;
        lane = -lane;
      }
    }
    return { distance, direction, lane };
  }

  function ambientTrafficBoxesOverlap(first, second) {
    const deltaX = second.x - first.x;
    const deltaZ = second.z - first.z;
    const firstForwardX = Math.sin(first.heading), firstForwardZ = Math.cos(first.heading);
    const firstSideX = Math.cos(first.heading), firstSideZ = -Math.sin(first.heading);
    const secondForwardX = Math.sin(second.heading), secondForwardZ = Math.cos(second.heading);
    const secondSideX = Math.cos(second.heading), secondSideZ = -Math.sin(second.heading);
    const axes = [
      [firstForwardX, firstForwardZ], [firstSideX, firstSideZ],
      [secondForwardX, secondForwardZ], [secondSideX, secondSideZ],
    ];
    for (const [axisX, axisZ] of axes) {
      const centerGap = Math.abs(deltaX * axisX + deltaZ * axisZ);
      const firstRadius = first.halfLength * Math.abs(firstForwardX * axisX + firstForwardZ * axisZ)
        + first.halfWidth * Math.abs(firstSideX * axisX + firstSideZ * axisZ);
      const secondRadius = second.halfLength * Math.abs(secondForwardX * axisX + secondForwardZ * axisZ)
        + second.halfWidth * Math.abs(secondSideX * axisX + secondSideZ * axisZ);
      if (centerGap >= firstRadius + secondRadius) return false;
    }
    return true;
  }

  function trafficGridKey(x, z) {
    return `${Math.floor(x / 8)}:${Math.floor(z / 8)}`;
  }

  function trafficGridNearby(grid, pose, callback, cellRadius = 1) {
    const cellX = Math.floor(pose.x / 8), cellZ = Math.floor(pose.z / 8);
    for (let x = cellX - cellRadius; x <= cellX + cellRadius; x += 1) {
      for (let z = cellZ - cellRadius; z <= cellZ + cellRadius; z += 1) {
        for (const entry of grid.get(`${x}:${z}`) || []) callback(entry);
      }
    }
  }

  function trafficPoseOnValidTerrain(pose) {
    return Boolean(pose && terrainValidAt(pose.x, pose.z));
  }

  function stageAmbientTrafficSpawnsAtSignals(vehicles) {
    for (const vehicle of vehicles) {
      const corridor = ambientTraffic.corridors[vehicle.corridorIndex];
      const oneWay = ['yes', 'true', '1', '-1'].includes(String(corridor.road.attributes?.oneway || '').toLowerCase());
      let nearest = null;
      for (const stop of corridor.stops) {
        if (vehicle.direction !== stop.direction) continue;
        let gap = vehicle.direction > 0 ? stop.distance - vehicle.distance : vehicle.distance - stop.distance;
        if (gap < 0 && oneWay) gap += corridor.length;
        const safeGap = ambientCarSpecs[vehicle.model].body[2] * vehicle.scale * 0.5 + 1.5;
        if (gap >= safeGap || gap < -12 || (nearest && Math.abs(gap) >= Math.abs(nearest.gap))) continue;
        nearest = { stop, gap, safeGap };
      }
      if (!nearest) continue;
      vehicle.distance = clamp(nearest.stop.distance - vehicle.direction * nearest.safeGap, 1, corridor.length - 1);
    }
  }

  function resolveAmbientTrafficSpawnOverlaps(vehicles) {
    const grid = new Map();
    const classPriority = {
      motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
      unclassified: 5, residential: 5, living_street: 4, service: 3,
    };
    const isClear = pose => {
      let clear = trafficPoseOnValidTerrain(pose);
      trafficGridNearby(grid, pose, other => {
        if (clear && ambientTrafficBoxesOverlap(pose, other)) clear = false;
      });
      return clear;
    };
    const add = pose => {
      const key = trafficGridKey(pose.x, pose.z);
      const entries = grid.get(key) || [];
      entries.push(pose);
      grid.set(key, entries);
    };
    vehicles.sort((first, second) => {
      const firstRoad = ambientTraffic.corridors[first.corridorIndex]?.road.attributes?.highway || '';
      const secondRoad = ambientTraffic.corridors[second.corridorIndex]?.road.attributes?.highway || '';
      return (classPriority[secondRoad] || 3) - (classPriority[firstRoad] || 3);
    });
    for (const vehicle of vehicles) {
      let pose = ambientTrafficVehiclePose(vehicle);
      if (pose && !isClear(pose)) {
        const corridor = ambientTraffic.corridors[vehicle.corridorIndex];
        const oneWay = ['yes', 'true', '1', '-1'].includes(String(corridor.road.attributes?.oneway || '').toLowerCase());
        let replacement = null;
        for (let offset = 3; offset <= 24 && !replacement; offset += 3) {
          for (const sign of [-1, 1]) {
            let distance = vehicle.distance + sign * offset;
            let direction = vehicle.direction;
            let lane = vehicle.lane;
            if (oneWay) {
              distance = (distance % corridor.length + corridor.length) % corridor.length;
            } else if (distance <= 1 || distance >= corridor.length - 1) continue;
            const candidate = ambientTrafficVehiclePose(vehicle, distance, direction, lane);
            if (candidate && isClear(candidate)) {
              replacement = { distance, pose: candidate };
              break;
            }
          }
        }
        if (replacement) {
          vehicle.distance = replacement.distance;
          pose = replacement.pose;
        } else {
          vehicle.disabled = true;
          continue;
        }
      }
      if (pose) add(pose);
    }
    for (const corridor of ambientTraffic.corridors) {
      corridor.vehicles = corridor.vehicles.filter(vehicle => !vehicle.disabled);
    }
    for (let index = vehicles.length - 1; index >= 0; index -= 1) {
      if (vehicles[index].disabled) vehicles.splice(index, 1);
    }
  }

  function ambientTrafficCollisionTargets(targets) {
    const vehicles = ambientTraffic.movingVehicles.filter(vehicle => !vehicle.parked && !vehicle.disabled);
    const grid = new Map();
    const classPriority = {
      motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
      unclassified: 5, residential: 5, living_street: 4, service: 3,
    };
    const records = vehicles.map(vehicle => ({ vehicle, pose: ambientTrafficVehiclePose(vehicle) }));
    const add = record => {
      if (!record.pose) return;
      const key = trafficGridKey(record.pose.x, record.pose.z);
      const entries = grid.get(key) || [];
      entries.push(record);
      grid.set(key, entries);
      record.key = key;
    };
    const remove = record => {
      if (!record.key) return;
      const entries = grid.get(record.key);
      if (entries) {
        const index = entries.indexOf(record);
        if (index >= 0) entries.splice(index, 1);
        if (!entries.length) grid.delete(record.key);
      }
      record.key = null;
    };
    records.forEach(add);
    records.sort((first, second) => {
      const firstRoad = ambientTraffic.corridors[first.vehicle.corridorIndex]?.road.attributes?.highway || '';
      const secondRoad = ambientTraffic.corridors[second.vehicle.corridorIndex]?.road.attributes?.highway || '';
      return (classPriority[secondRoad] || 3) - (classPriority[firstRoad] || 3);
    });

    for (const record of records) {
      remove(record);
      const vehicle = record.vehicle;
      let requested = Math.max(0, targets.get(vehicle) || 0);
      const corridor = ambientTraffic.corridors[vehicle.corridorIndex];
      const oneWay = ['yes', 'true', '1', '-1'].includes(String(corridor.road.attributes?.oneway || '').toLowerCase());
      const frontClearance = ambientCarSpecs[vehicle.model].body[2] * vehicle.scale * 0.5 + 1.5;
      // If a car from the crossing road has already entered this junction,
      // wait before the mapped stop line. This prevents collision avoidance
      // from leaving a car paused halfway into the intersection.
      for (const stop of corridor.stops) {
        if (vehicle.direction !== stop.direction) continue;
        let gap = vehicle.direction > 0 ? stop.distance - vehicle.distance : vehicle.distance - stop.distance;
        if (gap < 0 && oneWay) gap += corridor.length;
        if (gap < 0 || gap > 420) continue;
        let crossingOccupied = false;
        trafficGridNearby(grid, stop.site, other => {
          if (crossingOccupied || other.vehicle.corridorIndex === vehicle.corridorIndex) return;
          const crossingStop = stop.site.stops.find(candidate => candidate.corridorIndex === other.vehicle.corridorIndex
            && candidate.axis !== stop.axis && candidate.direction === other.vehicle.direction);
          if (!crossingStop) return;
          const distanceToSite = Math.hypot(other.pose.x - stop.site.x, other.pose.z - stop.site.z);
          const clearingRadius = Math.max(stop.clearanceDistance, crossingStop.clearanceDistance) + 5;
          if (distanceToSite > clearingRadius) return;
          const crossingGap = other.vehicle.direction > 0
            ? crossingStop.distance - other.vehicle.distance
            : other.vehicle.distance - crossingStop.distance;
          if (crossingGap < 0 && crossingGap > -(crossingStop.clearanceDistance + 8)) crossingOccupied = true;
        }, 2);
        if (crossingOccupied) requested = Math.min(requested, Math.max(0, gap - frontClearance));
      }
      let safeTravel = requested;
      const poseAt = travel => {
        const next = ambientTrafficAdvance(vehicle, travel);
        return ambientTrafficVehiclePose(vehicle, next.distance, next.direction, next.lane);
      };
      const clearAt = travel => {
        const pose = poseAt(travel);
        if (!pose) return false;
        let clear = trafficPoseOnValidTerrain(pose);
        trafficGridNearby(grid, pose, other => {
          if (clear && ambientTrafficBoxesOverlap(pose, other.pose)) clear = false;
        });
        return clear;
      };
      if (requested > 0) {
        const steps = Math.max(1, Math.ceil(requested / 0.65));
        let lastSafe = 0;
        for (let step = 1; step <= steps; step += 1) {
          const candidate = requested * step / steps;
          if (!clearAt(candidate)) {
            let low = lastSafe, high = candidate;
            for (let pass = 0; pass < 5; pass += 1) {
              const middle = (low + high) * 0.5;
              if (clearAt(middle)) low = middle;
              else high = middle;
            }
            safeTravel = low;
            break;
          }
          lastSafe = candidate;
        }
      }
      targets.set(vehicle, safeTravel);
      record.pose = poseAt(safeTravel);
      add(record);
    }
    return targets;
  }

  function ambientTrafficTravelTargets(elapsed, queuedVehicles) {
    const travelTargets = new Map();
    for (const corridor of ambientTraffic.corridors) {
      const laneGroups = new Map();
      const oneWay = ['yes', 'true', '1', '-1'].includes(String(corridor.road.attributes?.oneway || '').toLowerCase());
      const speedRatio = ambientCorridorRatio(corridor);
      for (const vehicle of corridor.vehicles) {
        const speed = vehicle.speed * speedRatio;
        let travel = elapsed * speed;
        const queue = queuedVehicles.get(vehicle);
        if (queue) travel = Math.min(travel, Math.max(0, queue.gap - queue.slotGap));
        const laneKey = `${vehicle.direction}:${Math.round(vehicle.lane / 0.75)}`;
        const progress = vehicle.direction > 0 ? vehicle.distance : corridor.length - vehicle.distance;
        const lane = laneGroups.get(laneKey) || [];
        lane.push({ vehicle, progress, travel, speed });
        laneGroups.set(laneKey, lane);
      }

      for (const lane of laneGroups.values()) {
        lane.sort((first, second) => first.progress - second.progress);
        const passCount = oneWay ? lane.length : 1;
        for (let pass = 0; pass < passCount; pass += 1) {
          let adjusted = false;
          for (let index = lane.length - 1; index >= 0; index -= 1) {
            const follower = lane[index];
            let leader = lane[index + 1];
            let gap = leader ? leader.progress - follower.progress : Infinity;
            if (!leader && oneWay && lane.length > 1) {
              leader = lane[0];
              gap = leader.progress + corridor.length - follower.progress;
            }
            if (!leader) continue;
            const leaderLength = ambientCarSpecs[leader.vehicle.model].body[2] * leader.vehicle.scale;
            const followerLength = ambientCarSpecs[follower.vehicle.model].body[2] * follower.vehicle.scale;
            const closingSpeed = Math.max(follower.speed, leader.speed);
            const followingGap = Math.max(1.6, Math.min(4.5, closingSpeed * 0.5));
            const minimumCenterGap = (leaderLength + followerLength) * 0.5 + followingGap;
            const safeTravel = Math.max(0, gap + leader.travel - minimumCenterGap);
            if (safeTravel + 1e-6 < follower.travel) {
              follower.travel = safeTravel;
              adjusted = true;
            }
          }
          if (!adjusted) break;
        }
        for (const follower of lane) travelTargets.set(follower.vehicle, follower.travel);
      }
    }
    return travelTargets;
  }

  function updateAmbientTraffic(now) {
    const group = ambientTraffic.group;
    if (!group) return;
    const activeTool = document.querySelector('[data-menu-target].active')?.dataset.menuTarget;
    // Ambient cars are a street-scale detail. Keep the fleet dormant at the
    // full-city view, where individual cars cannot be read, and avoid posing
    // thousands of instances on every map redraw while zoomed out.
    group.visible = activeTool !== 'transport' && activeTool !== 'viewshed' && layerGroups.roads.visible
      && cameraState.distance <= ambientTrafficAnimationDistance;
    if (ambientTraffic.signalGroup) ambientTraffic.signalGroup.visible = group.visible;
    if (!group.visible) {
      ambientTraffic.clock = now;
      return;
    }
    const elapsed = Math.min(0.15, Math.max(0, (now - ambientTraffic.clock) / 1000));
    ambientTraffic.clock = now;
    updateTrafficSignalLights(now);
    const queuedVehicles = trafficSignalQueueTargets();
    const travelTargets = ambientTrafficCollisionTargets(
      ambientTrafficTravelTargets(elapsed, queuedVehicles),
    );
    const corridors = ambientTraffic.corridors;
    for (const fleet of ambientTraffic.fleets) {
      let instance = 0;
      let wheelInstance = 0;
      for (const vehicle of fleet.vehicles) {
        if (vehicle.parked && vehicle.rendered) {
          instance += 1;
          wheelInstance += 4;
          continue;
        }
        let x, z, y, heading, dx, dz;
        if (vehicle.parked) {
          x = vehicle.x; z = vehicle.z; y = vehicle.y; heading = vehicle.heading;
          const arrival = vehicle.arrival;
          if (arrival && now >= arrival.startAt) {
            const progress = clamp((now - arrival.startAt) / arrival.duration, 0, 1);
            x = arrival.startX + (arrival.targetX - arrival.startX) * progress;
            z = arrival.startZ + (arrival.targetZ - arrival.startZ) * progress;
            y = arrival.startY + (arrival.targetY - arrival.startY) * progress;
            let turn = ((arrival.targetHeading - arrival.startHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            heading = arrival.startHeading + turn * progress;
            if (progress >= 1) vehicle.arrival = null;
          }
          dx = Math.sin(heading); dz = Math.cos(heading);
        } else {
          const corridor = corridors[vehicle.corridorIndex];
          const travel = travelTargets.get(vehicle) || 0;
          vehicle.distance += travel * vehicle.direction;
          if (['yes', 'true', '1', '-1'].includes(String(corridor.road.attributes?.oneway || '').toLowerCase())) {
            vehicle.distance = (vehicle.distance % corridor.length + corridor.length) % corridor.length;
          } else if (vehicle.distance >= corridor.length) {
            vehicle.distance = corridor.length - (vehicle.distance - corridor.length);
            vehicle.direction = -1;
            vehicle.lane = -vehicle.lane;
          } else if (vehicle.distance <= 0) {
            vehicle.distance = -vehicle.distance;
            vehicle.direction = 1;
            vehicle.lane = -vehicle.lane;
          }
          let segment = 0;
          while (segment < corridor.cumulative.length - 2 && corridor.cumulative[segment + 1] < vehicle.distance) segment += 1;
          const start = corridor.points[segment], end = corridor.points[segment + 1];
          const segmentLength = corridor.cumulative[segment + 1] - corridor.cumulative[segment] || 1;
          const fraction = (vehicle.distance - corridor.cumulative[segment]) / segmentLength;
          dx = (end[0] - start[0]) / segmentLength * vehicle.direction;
          dz = (end[1] - start[1]) / segmentLength * vehicle.direction;
          x = start[0] + (end[0] - start[0]) * fraction;
          z = start[1] + (end[1] - start[1]) * fraction;
          y = roadSurfaceHeightAt(x, z) + (corridor.road.verticalOffset || 0) + (corridor.road.surfaceOffset || 0) + 0.02;
        }
        if (!terrainValidAt(x, z)) continue;
        carPosition.set(x, y, z);
        carQuaternion.setFromAxisAngle(carUp, heading ?? Math.atan2(dx, dz));
        const size = vehicle.scale;
        carScale.set(size, size, size);
        const modelSpec = ambientCarSpecs[fleet.model];
        for (const wheelX of [-modelSpec.body[0] * 0.46, modelSpec.body[0] * 0.46]) {
          for (const wheelZ of [-modelSpec.wheelZ, modelSpec.wheelZ]) {
            ambientWheelLocal.set(wheelX, 0.31, wheelZ).multiplyScalar(size).applyQuaternion(carQuaternion);
            ambientWheelPosition.copy(carPosition).add(ambientWheelLocal);
            ambientWheelPosition.add(ambientLanePosition.set(dz * (vehicle.lane || 0), 0, -dx * (vehicle.lane || 0)));
            ambientWheelMatrix.compose(ambientWheelPosition, carQuaternion, carScale);
            fleet.wheels.setMatrixAt(wheelInstance++, ambientWheelMatrix);
            fleet.rims.setMatrixAt(wheelInstance - 1, ambientWheelMatrix);
          }
        }
        carPosition.add(ambientLanePosition.set(dz * (vehicle.lane || 0), 0, -dx * (vehicle.lane || 0)));
        carMatrix.compose(carPosition, carQuaternion, carScale);
        fleet.body.setMatrixAt(instance, carMatrix);
        fleet.cabin.setMatrixAt(instance, carMatrix);
        instance += 1;
        if (vehicle.parked && !vehicle.arrival) vehicle.rendered = true;
      }
      fleet.body.count = instance;
      fleet.cabin.count = instance;
      fleet.wheels.count = wheelInstance;
      fleet.rims.count = wheelInstance;
      for (const mesh of [fleet.body, fleet.cabin, fleet.wheels, fleet.rims]) mesh.instanceMatrix.needsUpdate = true;
    }
  }

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
    return removeTrafficSelectionById(nearest.edge.id);
  }

  function removeTrafficSelectionById(removedId) {
    if (!trafficState.selectedEdgeIds.includes(removedId)) return false;
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

  function updateTrafficSelectionList() {
    if (!trafficSelectionList) return;
    trafficSelectionList.replaceChildren();
    const selected = trafficState.selectedEdgeIds
      .map(edgeId => trafficState.edgesById.get(edgeId))
      .filter(Boolean);
    trafficSelectionList.hidden = selected.length === 0;
    for (const edge of selected) {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = trafficEdgeName(edge);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'traffic-section-remove';
      remove.dataset.trafficEdgeId = edge.id;
      remove.setAttribute('aria-label', `Remove ${trafficEdgeName(edge)} section`);
      remove.title = 'Remove this section';
      remove.textContent = '×';
      row.append(name, remove);
      trafficSelectionList.append(row);
    }
  }

  function trafficEdgeName(edge) {
    return edge?.name && edge.name !== 'Unnamed road'
      ? edge.name
      : edge?.official?.name || `edge:${edge?.id || 'unknown'}`;
  }

  function trafficSelectionLabel() {
    const names = [...new Set(trafficState.selectedEdgeIds
      .map(edgeId => trafficEdgeName(trafficState.edgesById.get(edgeId)))
      .filter(name => name && !name.startsWith('edge:')))];
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
    updateTrafficSelectionList();
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
    cancelRequests('traffic');
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
    cancelRequests('traffic');
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
    trafficState.strokeStartScreen = null;
    trafficState.strokePoints = [];
    trafficState.selectedEdgeIds = [];
    updateTrafficSelectionList();
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
    if (trafficSelectionStatus) trafficSelectionStatus.textContent = 'Choose a closure tool. Draw to add sections; tap a selected section or right-click to remove it, then confirm.';
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
      trafficDrawPopupStatus.textContent = 'Draw to add road sections. Tap a selected section to remove it. Confirm when the selection is complete.';
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
        ? `${added} ${added === 1 ? 'section' : 'sections'} added · ${count} total selected. Draw again, tap a selected section to remove it, or confirm.`
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

  function cancelInterruptedTrafficStroke(message = 'Stroke interrupted. Draw again or confirm the existing selection.') {
    if (!trafficState.stroking) return;
    trafficState.stroking = false;
    trafficState.pointerId = null;
    trafficState.lastScreen = null;
    trafficState.strokePoints = [];
    trafficState.strokeStartScreen = null;
    updateTrafficDrawPopup(message);
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
    if (trafficSelectionStatus) trafficSelectionStatus.textContent = `${trafficSelectionEffect()} · ${label} · ${trafficSelectionDetails()}. Tap a selected section or right-click to remove it.${directionHint}`;
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
    if (trafficSelectionStatus) trafficSelectionStatus.textContent = `${closingWhat} · ${label} · ${trafficSelectionDetails()}. Tap a selected section or right-click to remove it.`;
    if (trafficStatus) trafficStatus.textContent = `${label} confirmed (direction flipped) · adjust the scenario or run the comparison.`;
  }

  function syncTrafficDrawingToolAvailability() {
    const available = trafficState.networkEdges.length > 0;
    const title = available
      ? ''
      : trafficState.roadsLoading
        ? 'Loading the road network…'
        : 'Road network unavailable; retrying automatically';
    for (const button of [trafficDrawLane, trafficDrawRoad, trafficDrawOneWay]) {
      if (!button) continue;
      button.disabled = !available;
      if (title) button.title = title;
      else button.removeAttribute('title');
    }
  }

  function scheduleTrafficRoadRetry() {
    if (trafficState.networkEdges.length || trafficState.roadsRetryTimer) return;
    const delay = Math.min(30000, 1500 * (2 ** Math.min(trafficState.roadsLoadAttempts, 4)));
    trafficState.roadsRetryTimer = setTimeout(() => {
      trafficState.roadsRetryTimer = null;
      if (!trafficState.sceneActive) return;
      void loadTrafficRoads();
    }, delay);
  }

  function loadTrafficRoads() {
    if (trafficState.networkEdges.length) return Promise.resolve();
    if (trafficState.roadsLoadPromise) return trafficState.roadsLoadPromise;
    trafficState.roadsLoading = true;
    syncTrafficDrawingToolAvailability();
    const request = (async () => {
      try {
        const response = await fetch(`${windApi}/traffic/roads`, { timeoutMs: 15000 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const roads = payload.roads || [];
        trafficState.roadsByName = new Map(roads.map(road => [road.name, road]));
        trafficState.networkEdges = payload.network_edges || [];
        if (!trafficState.networkEdges.length) throw new Error('the server returned no drawable road sections');
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
        trafficState.roadsLoadAttempts = 0;
        if (trafficState.roadsRetryTimer) {
          clearTimeout(trafficState.roadsRetryTimer);
          trafficState.roadsRetryTimer = null;
        }
        if (trafficState.networkEdges.length && trafficStatus) {
          const matched = payload.road_data?.municipal_matched_edges || 0;
          trafficStatus.textContent = `${trafficState.networkEdges.length} road sections ready · ${matched} matched to City road-centre data.`;
        }
      } catch (error) {
        trafficState.roadsLoadAttempts += 1;
        if (trafficStatus && !trafficState.networkEdges.length) {
          trafficStatus.textContent = `Road list unavailable (${error.message}) · retrying automatically…`;
        }
        scheduleTrafficRoadRetry();
      } finally {
        trafficState.roadsLoading = false;
        syncTrafficDrawingToolAvailability();
      }
    })();
    trafficState.roadsLoadPromise = request.finally(() => {
      trafficState.roadsLoadPromise = null;
    });
    return trafficState.roadsLoadPromise;
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
        const fetchedAt = payload.fetched_at ? new Date(payload.fetched_at) : null;
        const timeLabel = fetchedAt && Number.isFinite(fetchedAt.getTime())
          ? fetchedAt.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'short', timeStyle: 'short' })
          : '';
        trafficFreshness.textContent = `${payload.stale ? 'Cached' : 'Live'}${timeLabel ? ` · ${timeLabel}` : ''}`;
        trafficFreshness.classList.toggle('stale', Boolean(payload.stale));
      }
      const level = (payload.congestion_level || 'unknown').replace(/_/g, ' ');
      trafficState.liveRoads = payload.sampled_roads || [];
      ambientTraffic.speedByName.clear();
      const speedSamplesByName = new Map();
      for (const road of trafficState.liveRoads) {
        const name = normalizeTrafficRoadName(road.name);
        const ratio = Number(road.speed_ratio);
        if (!name || !Number.isFinite(ratio)) continue;
        const samples = speedSamplesByName.get(name) || [];
        samples.push(ratio);
        speedSamplesByName.set(name, samples);
      }
      for (const [name, samples] of speedSamplesByName) {
        ambientTraffic.speedByName.set(name, samples.reduce((total, ratio) => total + ratio, 0) / samples.length);
      }
      ambientTraffic.cityRatio = Number.isFinite(Number(payload.average_speed_ratio))
        ? Number(payload.average_speed_ratio) : 0.62;
      // The fleet is a persistent simulation. Speed ratios are read on every
      // frame, so rebuilding here would only respawn every car on refresh.
      requestRender();
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

  async function loadTrafficCalibrationStatus() {
    if (!trafficCalibrationStatus) return;
    try {
      const response = await fetch(`${windApi}/traffic/calibration-status`);
      const status = await response.json();
      if (!response.ok) throw new Error(status.detail || `HTTP ${response.status}`);
      const profiles = Object.values(status.profiles || {});
      const readyProfiles = profiles.filter(profile => profile.ready);
      const days = Number(status.distinct_days) || 0;
      const requiredDays = Math.max(0, ...profiles.map(profile => Number(profile.minimum_distinct_weekdays) || 0));
      const routeScenarios = Object.values(status.route_sampler?.scenarios || {});
      const countCalibrated = routeScenarios.some(item => item.enabled);
      trafficCalibrationBadge.textContent = countCalibrated ? 'Counts configured' : `${days}/${requiredDays || 5} weekdays`;
      trafficCalibrationBadge.classList.toggle('is-ready', countCalibrated || readyProfiles.length > 0);
      trafficCalibrationStatus.textContent = countCalibrated
        ? 'Observed edge or turning counts are configured for at least one scenario. Check each comparison report for the calibration actually applied.'
        : readyProfiles.length
          ? `Peak timing profiles are ready for ${readyProfiles.length} period${readyProfiles.length === 1 ? '' : 's'} from ${days} observed weekdays. This is speed-pattern calibration; vehicle demand is still synthetic.`
          : `${Number(status.observation_rows) || 0} TomTom speed snapshots across ${days} distinct weekdays. ${Math.max(0, requiredDays - days)} more weekday${requiredDays - days === 1 ? '' : 's'} needed for peak timing profiles; these observations do not provide vehicle counts.`;
    } catch (error) {
      trafficCalibrationBadge.textContent = 'Status unavailable';
      trafficCalibrationStatus.textContent = `Could not load traffic calibration status (${error.message}).`;
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
        action: impact.ensemble?.applied && impact.ensemble?.assessment_ready === false
          ? `Only ${reportNumber(impact.ensemble.assessment_ready_runs, 0)} of ${reportNumber(impact.ensemble.run_count, 0)} seed runs passed quality checks; ${reportNumber(impact.ensemble.required_assessment_ready_runs, 0)} are required. The failed-run diagnostics have been retained for review.`
          : impact.simulation_complete === false
          ? 'One or both simulation runs reached the processing time limit. Reduce the selected area or demand and rerun the comparison.'
          : impact.physically_solved === false
            ? `${reportNumber((impact.teleport_count_baseline || 0) + (impact.teleport_count_closure || 0), 0)} vehicles were moved through gridlock by the simulator. Revise the closure or demand and rerun before using the result.`
          : impact.baseline_gridlock_stable === false
            ? `${reportNumber(impact.persistent_gridlock_count_baseline, 0)} vehicles (${reportNumber(Number(impact.baseline_gridlock_ratio || 0) * 100, 1, '%')}) remained stopped for at least five minutes with the road open. The maximum acceptable baseline share is ${reportNumber(Number(impact.maximum_baseline_gridlock_ratio || 0) * 100, 0, '%')}. Reduce demand or correct the baseline network before using the comparison.`
          : impact.baseline_insertion_stable === false
            ? `${reportNumber(impact.insertion_failure_count_baseline, 0)} generated vehicles could not enter the open-road network. Reduce demand or correct its entry lanes before using the comparison.`
          : impact.baseline_stable === false
            ? `The open-road baseline completed only ${reportNumber(Number(impact.completed_trip_ratio_baseline || 0) * 100, 0, '%')} of generated trips; at least ${reportNumber(Number(impact.minimum_baseline_completion_ratio || 0) * 100, 0, '%')} is required. Reduce synthetic demand or shorten the selected area and rerun it.`
          : impact.paired_sample_sufficient === false
            ? `Only ${Number(impact.compared_trip_count) || 0} trips completed both runs (${reportNumber(Number(impact.paired_trip_ratio || 0) * 100, 0, '%')} of generated trips). Increase the sampling window or reduce disruption and rerun it.`
            : 'No trip completed in both runs, so a like-for-like travel-time comparison is not available. Revise the closure or demand and rerun it.',
      };
    }
    const journeyTimeReady = impact.ensemble?.applied
      ? Number(impact.ensemble.journey_time_ready_runs) > 0
      : impact.journey_time_ready !== false;
    const rawDurationChange = impact.ensemble?.journey_time_change_pct?.median
      ?? impact.mean_journey_time_change_pct ?? impact.mean_duration_change_pct;
    const rawDurationChangeS = impact.ensemble?.journey_time_change_s?.median
      ?? impact.mean_journey_time_change_s ?? impact.mean_duration_change_s;
    const durationChange = journeyTimeReady && rawDurationChange !== null
      && rawDurationChange !== undefined ? Number(rawDurationChange) || 0 : null;
    const durationChangeS = journeyTimeReady && rawDurationChangeS !== null
      && rawDurationChangeS !== undefined ? Number(rawDurationChangeS) || 0 : null;
    const completionChange = Number(
      impact.ensemble?.completion_change_percentage_points?.median
      ?? ((impact.completed_trip_ratio_closure ?? 0) - (impact.completed_trip_ratio_baseline ?? 0)) * 100,
    );
    const completionDrop = Math.max(0, -completionChange);
    const queueIncrease = Math.max(0,
      (Number(impact.max_queue_closure) || 0) - (Number(impact.max_queue_baseline) || 0));
    const majorDelay = durationChange >= 35 && durationChangeS >= 30;
    const significantDelay = durationChange >= 18 && durationChangeS >= 15;
    const noticeableDelay = durationChange >= 7 && durationChangeS >= 5;
    let severity = 'minor';
    if (majorDelay || completionDrop >= 15) severity = 'major';
    else if (significantDelay || completionDrop >= 8) severity = 'significant';
    else if (noticeableDelay || completionDrop >= 3) severity = 'noticeable';

    // Peak queue is retained as supporting evidence, but an absolute count is
    // not comparable across differently sized demand samples and must not, by
    // itself, determine the verdict.
    const durationBand = majorDelay ? 3 : significantDelay ? 2 : noticeableDelay ? 1 : 0;
    const completionBand = completionDrop >= 15 ? 3 : completionDrop >= 8 ? 2 : completionDrop >= 3 ? 1 : 0;
    const primaryDriver = completionBand > durationBand ? 'completion' : durationBand > completionBand ? 'delay'
      : completionBand > 0 ? 'both' : 'none';

    const genericHeadline = {
      major: 'Major modelled disruption — revise the option',
      significant: 'Significant modelled disruption — test mitigation',
      noticeable: 'Noticeable modelled disruption — mitigation is advisable',
      minor: 'Limited modelled disruption in this scenario',
    }[severity];
    const completionHeadline = {
      major: 'Major modelled completion loss — revise the option',
      significant: 'Significant modelled completion loss — test mitigation',
      noticeable: 'Noticeable modelled completion loss — mitigation is advisable',
      minor: genericHeadline,
    }[severity];
    const headline = primaryDriver === 'completion' ? completionHeadline : genericHeadline;
    const action = {
      major: 'Revise the option before progressing it. Shorten or phase the work zone, retain available capacity where possible, or move it outside the peak, then compare the revision.',
      significant: 'Test a shorter or off-peak work zone and explicit junction or diversion management before taking the option forward.',
      noticeable: 'Compare practical mitigation such as off-peak timing, a shorter work zone, and monitoring of the busiest diversion roads.',
      minor: 'Retain this option for further assessment, alongside diversion signing, monitoring, emergency access and an operational contingency.',
    }[severity];
    return {
      durationChange, durationChangeS, completionChange, completionDrop, queueIncrease,
      primaryDriver, severity, headline, action,
    };
  }

  function publicOccupancyChange(value) {
    const numeric = Number(value) || 0;
    if (Math.abs(numeric) < 0.05) return 'about the same number of recorded edge exits';
    return `${reportNumber(Math.abs(numeric), 0)} ${numeric > 0 ? 'more' : 'fewer'} recorded edge exits`;
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

  function travelTimeText(seconds) {
    const value = Math.abs(Number(seconds) || 0);
    if (value < 90) {
      const digits = value > 0 && value < 10 && Math.abs(value - Math.round(value)) > 0.05 ? 1 : 0;
      const rounded = Number(value.toFixed(digits));
      return `${reportNumber(rounded, digits)} ${rounded === 1 ? 'second' : 'seconds'}`;
    }
    const minutes = value / 60;
    const digits = minutes < 10 && Math.abs(minutes - Math.round(minutes)) > 0.05 ? 1 : 0;
    const rounded = Number(minutes.toFixed(digits));
    return `${reportNumber(rounded, digits)} ${rounded === 1 ? 'minute' : 'minutes'}`;
  }

  function impactEvidenceText(impact = {}, assessment = trafficImpactAssessment(impact)) {
    const ensemble = impact.ensemble || {};
    if (ensemble.applied) {
      if (!ensemble.journey_time_change_s) {
        return `Across ${reportNumber(ensemble.run_count, 0)} seed runs, the closure produced a capacity failure in ${reportNumber(ensemble.capacity_failure_runs, 0)}: too few trips finished for a defensible journey-time estimate. The median completion change was <b>${assessment.completionChange >= 0 ? '+' : ''}${assessment.completionChange.toFixed(1)} percentage points</b>.`;
      }
      const journey = ensemble.journey_time_change_s || {};
      const median = Number(journey.median) || 0;
      const direction = median >= 0 ? 'longer' : 'shorter';
      return `Across ${reportNumber(ensemble.journey_time_ready_runs, 0)} seed runs with sufficient paired trips, the median journey change was <b>${travelTimeText(median)} ${direction}</b> `
        + `(arithmetic mean ${reportChange(journey.mean, 1, ' seconds')}; range ${reportNumber(journey.minimum, 1)} to ${reportNumber(journey.maximum, 1)} seconds), and the median completion change was <b>${assessment.completionChange >= 0 ? '+' : ''}${assessment.completionChange.toFixed(1)} percentage points</b>.`;
    }
    if (impact.closure_capacity_failure) {
      return `<b>${assessment.completionDrop.toFixed(1)} percentage points fewer trips finished by the scoring cutoff.</b> Too few trips survived the closure for a defensible journey-time estimate; this is reported as a capacity failure, not as an incomplete simulation.`;
    }
    const compared = Number(impact.compared_trip_count) || 0;
    const average = Number(impact.mean_journey_time_change_s) || 0;
    const averageDirection = average >= 0 ? 'longer' : 'shorter';
    const pairedText = `Among the ${reportNumber(compared, 0)} trips that finished in both runs, the average journey was <b>${travelTimeText(average)} ${averageDirection}</b> (${assessment.durationChange === null ? '—' : `${assessment.durationChange >= 0 ? '+' : ''}${assessment.durationChange.toFixed(1)}%`}).`;
    if (assessment.completionDrop >= 0.05) {
      const unfinished = Number(impact.net_additional_unfinished_trip_count) || 0;
      const driverText = `<b>${assessment.completionDrop.toFixed(1)} percentage points fewer trips finished by the scoring cutoff</b>${unfinished ? ` (${reportNumber(unfinished, 0)} additional unfinished trips)` : ''}.`;
      const caution = 'Trips that did not finish are excluded from the journey-time average, so the completion and delay results must be read together.';
      return `${assessment.primaryDriver === 'completion' ? driverText : pairedText} ${assessment.primaryDriver === 'completion' ? pairedText : driverText} ${caution}`;
    }
    return `${pairedText} About the same share of generated trips finished by the scoring cutoff.`;
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
            <tr><th>Prepared by</th><td>Conditions traffic simulation</td></tr>
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
    const ensemble = impact.ensemble || demand.run_seeds || {};
    const ensembleJourney = ensemble.journey_time_change_s || {};
    const automaticStability = ensemble.automatic_stability || {};
    const stabilityText = automaticStability.applied
      ? `Automatic baseline stabilization applied ${reportNumber(Number(automaticStability.applied_scale) * 100, 0, '%')} of the requested synthetic load after ${reportNumber((automaticStability.attempts || []).length, 0)} attempts.`
      : 'The requested synthetic load passed baseline stability without automatic adjustment.';
    const ensembleText = ensemble.applied
      ? `${reportNumber(ensemble.run_count, 0)} paired random seeds · ${reportNumber(ensemble.assessment_ready_runs, 0)}/${reportNumber(ensemble.run_count, 0)} assessment-ready · median journey change ${reportChange(ensembleJourney.median, 1, ' sec')} · mean ${reportChange(ensembleJourney.mean, 1, ' sec')} (range ${reportNumber(ensembleJourney.minimum, 1)} to ${reportNumber(ensembleJourney.maximum, 1)} sec)`
      : 'single paired random seed';
    const reportedJourneyChangeS = ensemble.applied
      ? ensembleJourney.median : impact.mean_journey_time_change_s;
    const reportedJourneyChangePct = ensemble.applied
      ? ensemble.journey_time_change_pct?.median : impact.mean_journey_time_change_pct;
    const reportedBaselineCompletion = ensemble.applied
      ? ensemble.completed_trip_ratio_baseline?.median : impact.completed_trip_ratio_baseline;
    const reportedClosureCompletion = ensemble.applied
      ? ensemble.completed_trip_ratio_closure?.median : impact.completed_trip_ratio_closure;
    const reportedQueueBaseline = ensemble.applied
      ? ensemble.max_queue_baseline?.median : impact.max_queue_baseline;
    const reportedQueueClosure = ensemble.applied
      ? ensemble.max_queue_closure?.median : impact.max_queue_closure;
    const reportedSpeedChangeMps = ensemble.applied
      ? ensemble.speed_change_mps?.median : impact.mean_speed_change_mps;
    const reportedSpeedChangePct = ensemble.applied
      ? ensemble.speed_change_pct?.median : impact.mean_speed_change_pct;
    const reportedCo2ChangeKg = ensemble.applied
      ? ensemble.co2_change_kg?.median : reportedEnvironment.co2_kg?.change;
    const reportedCo2ChangePct = ensemble.applied
      ? ensemble.co2_change_pct?.median : reportedEnvironment.co2_kg?.change_pct;
    const decisionValue = value => assessmentReady ? value : null;
    const toKmh = value => value === null || value === undefined ? null : Number(value) * 3.6;
    const generated = new Intl.DateTimeFormat('en-ZA', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Johannesburg',
    }).format(new Date());
    const reportReference = `TRF-${Number(demand.seed || 0).toString(16).toUpperCase().padStart(8, '0')}`;
    const percent = value => value !== null && value !== undefined && Number.isFinite(Number(value))
      ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`
      : '—';
    const flowItems = (payload.street_flow_summary || []).slice(0, 5).map(street => `
      <li><b>${reportEscape(street.name)}</b><span>${publicOccupancyChange(street.vehicle_delta)}</span></li>`).join('')
      || '<li><b>No nearby street noticeably affected</b><span>—</span></li>';
    const durationDetail = assessment.severity === 'incomplete'
      ? reportEscape(assessment.action)
      : impactEvidenceText(impact, assessment);

    trafficReportDocument.innerHTML = `
      <header class="report-header">
        <div class="report-brand-title">
          <img class="report-brand" src="/branding/MissionWordmark.webp" alt="Mission for Inner City Cape Town">
          <div>
          <p class="report-kicker">Cape Town CBD Conditions</p>
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
          <div class="report-stat"><span>Journey time</span><strong>${reportChange(decisionValue(reportedJourneyChangeS), Math.abs(Number(reportedJourneyChangeS)) < 10 ? 1 : 0, ' sec')}</strong><small>${percent(decisionValue(reportedJourneyChangePct))} · ${ensemble.applied ? 'median across seeds' : 'trips completed in both runs only'}</small></div>
          <div class="report-stat"><span>Queuing</span><strong>${reportNumber(reportedQueueClosure, 0, ' vehicles')}</strong><small>Busiest moment · was ${reportNumber(reportedQueueBaseline, 0)} before${ensemble.applied ? ' · medians' : ''}</small></div>
          <div class="report-stat"><span>Trips finished</span><strong>${reportNumber(reportedClosureCompletion === null || reportedClosureCompletion === undefined ? null : reportedClosureCompletion * 100, 0, '%')}</strong><small>By scoring cutoff · was ${reportNumber(reportedBaselineCompletion === null || reportedBaselineCompletion === undefined ? null : reportedBaselineCompletion * 100, 0, '%')} before${ensemble.applied ? ' · medians' : ''}</small></div>
          <div class="report-stat"><span>Traffic speed</span><strong>${reportChange(toKmh(decisionValue(reportedSpeedChangeMps)), 1, ' km/h', true)}</strong><small>${percent(decisionValue(reportedSpeedChangePct))} on average${ensemble.applied ? ' · median' : ''}</small></div>
          <div class="report-stat"><span>Modelled tailpipe CO₂</span><strong>${percent(decisionValue(reportedCo2ChangePct))}</strong><small>${reportChange(decisionValue(reportedCo2ChangeKg), 2, ' kg')} · whole run, not paired trips${ensemble.applied ? ' · median' : ''}</small></div>
          <div class="report-stat"><span>Lanes closed</span><strong>${reportNumber(payload.closure?.lanes_closed, 0)}</strong><small>${reportEscape(payload.closure?.description || '—')}</small></div>
        </div>
      </section>

      <section class="report-section report-two-column">
        <div>
          <div class="report-section-heading"><h2>Most affected nearby roads</h2><span>Recorded edge exits, not unique vehicles</span></div>
          <ul class="report-list">${flowItems}</ul>
        </div>
        <div>
          <div class="report-section-heading"><h2>Within the simulated corridor</h2><span>Mapped street inventory</span></div>
          <ul class="report-list">
            <li><b>Parking spaces nearby</b><span>${reportNumber(activity.parking_spaces, 0)}</span></li>
            <li><b>Pedestrian crossings nearby</b><span>${reportNumber(activity.pedestrian_crossings, 0)}</span></li>
            <li><b>Raised crossings</b><span>${reportNumber(activity.raised_crossings, 0)}</span></li>
          </ul>
        </div>
      </section>

      <section class="report-section">
        <div class="report-section-heading"><h2>Comparison provenance</h2><span>Reproduce and compare this run</span></div>
        <div class="report-note">Demand seed <b>${reportNumber(demand.seed, 0)}</b> · ${ensembleText} · ${reportNumber(demand.planned_vehicle_count, 0)} measured-window trips after a ${reportNumber(payload.playback?.warmup_s, 0, ' sec')} warm-up · ${reportNumber(impact.compared_trip_count, 0)} paired completions (${reportNumber(Number(impact.paired_trip_ratio || 0) * 100, 1, '%')}) · ${reportNumber(impact.rerouted_vehicle_count, 0)} routes changed · ${reportNumber(impact.persistent_gridlock_count_baseline, 0)} → ${reportNumber(impact.persistent_gridlock_count_closure, 0)} persistently blocked vehicles · open-road completion ${reportNumber(Number(impact.completed_trip_ratio_baseline || 0) * 100, 1, '%')} · ${reportEscape(payload.signal_data_source || 'signal source not recorded')}. ${stabilityText}</div>
      </section>

      <section class="report-section">
        <div class="report-section-heading"><h2>How to read this report</h2><span>In plain terms</span></div>
        <div class="report-note">This is a ${ensemble.applied ? 'multi-seed' : 'single-seed'} "what-if" traffic simulation: the same boundary-weighted demand is sent through a warmed-up network twice — once as normal, once with this closure. Mapped pedestrian crossings and kerbside activity create repeatable yield and loading stops. ${demand.observed_count_calibration ? 'Observed traffic counts calibrate this scenario.' : 'Observed traffic counts have not yet been supplied, so demand volume remains an estimate; live speed data does not supply vehicle counts.'} Nearby-road changes are recorded edge exits summed across road segments, not unique vehicles. Emergency access and unmapped driveway activity remain outside the model. Treat it as option screening, not a certified traffic study.</div>
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
    const ensemble = impact.ensemble || {};
    const displayedJourneyPct = ensemble.applied
      ? ensemble.journey_time_change_pct?.median : impact.mean_journey_time_change_pct;
    const displayedSpeedPct = ensemble.applied
      ? ensemble.speed_change_pct?.median : impact.mean_speed_change_pct;
    const displayedQueueBaseline = ensemble.applied
      ? ensemble.max_queue_baseline?.median : impact.max_queue_baseline;
    const displayedQueueClosure = ensemble.applied
      ? ensemble.max_queue_closure?.median : impact.max_queue_closure;
    const displayedBaselineCompletion = ensemble.applied
      ? ensemble.completed_trip_ratio_baseline?.median : impact.completed_trip_ratio_baseline;
    const displayedClosureCompletion = ensemble.applied
      ? ensemble.completed_trip_ratio_closure?.median : impact.completed_trip_ratio_closure;
    const displayedCo2Pct = ensemble.applied
      ? ensemble.co2_change_pct?.median : environment.co2_kg?.change_pct;
    const journeyExplanation = impact.assessment_ready === false
      ? ''
      : impactEvidenceText(impact);
    const formatPercent = value => (value === null || value === undefined)
      ? '—'
      : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
    if (trafficResults) {
      trafficResults.hidden = false;
      trafficResults.innerHTML = `
        <span><b>${formatPercent(displayedJourneyPct)}</b>Journey time${ensemble.applied ? ' median' : ''}</span>
        <span><b>${formatPercent(displayedSpeedPct)}</b>Mean speed${ensemble.applied ? ' median' : ''}</span>
        <span><b>${reportNumber(displayedQueueBaseline, 0)} → ${reportNumber(displayedQueueClosure, 0)}</b>Peak queue${ensemble.applied ? ' median' : ''}</span>
        <span><b>${displayedBaselineCompletion === null || displayedBaselineCompletion === undefined ? '—' : `${Math.round(displayedBaselineCompletion * 100)}%`} → ${displayedClosureCompletion === null || displayedClosureCompletion === undefined ? '—' : `${Math.round(displayedClosureCompletion * 100)}%`}</b>Trips completed${ensemble.applied ? ' median' : ''}</span>
        <span><b>${formatPercent(displayedCo2Pct)}</b>CO₂${ensemble.applied ? ' median' : ''}</span>
        <span><b>${payload.closure?.lanes_closed || 0}</b>Lanes closed</span>
        ${journeyExplanation ? `<span class="traffic-result-explanation">${journeyExplanation}</span>` : ''}`;
    }
    if (trafficImpactSummary) {
      const assessment = trafficImpactAssessment(impact);
      trafficImpactSummary.className = `traffic-impact-summary ${assessment.severity}`;
      const qualityLabel = impact.assessment_ready === false
        ? '<span class="traffic-quality-pill is-incomplete">Quality checks failed</span>'
        : '<span class="traffic-quality-pill">Quality checks passed</span>';
      trafficImpactSummary.innerHTML = `${qualityLabel}<strong>${assessment.headline}</strong>`
        + (assessment.severity === 'incomplete'
          ? assessment.action
          : `${assessment.action} ${formatPercent(assessment.durationChange)} paired journey time · `
            + `${assessment.completionChange >= 0 ? '+' : ''}${assessment.completionChange.toFixed(1)} percentage-point completion change.`);
      trafficImpactSummary.hidden = false;
    }
    if (trafficUncertainty) {
      if (ensemble.applied) {
        const range = ensemble.journey_time_change_pct || {};
        const goodRuns = reportNumber(ensemble.assessment_ready_runs, 0);
        const totalRuns = reportNumber(ensemble.run_count, 0);
        const hasRange = Number.isFinite(Number(range.minimum)) && Number.isFinite(Number(range.maximum));
        trafficUncertainty.textContent = hasRange
          ? `${goodRuns} of ${totalRuns} seed runs passed · median journey-time change ${formatPercent(range.median)} (range ${formatPercent(range.minimum)} to ${formatPercent(range.maximum)}).`
          : `${goodRuns} of ${totalRuns} seed runs passed. Journey-time range is unavailable for this comparison.`;
        trafficUncertainty.hidden = false;
      } else {
        trafficUncertainty.textContent = 'Single random seed · variation between runs is not estimated. Select 3 or 5 seeds for a range.';
        trafficUncertainty.hidden = false;
      }
    }
    if (trafficStatus) {
      const automaticStability = impact.ensemble?.automatic_stability || {};
      const stabilitySuffix = automaticStability.applied
        ? ` · baseline auto-stabilized to ${Math.round(Number(automaticStability.applied_scale) * 100)}% load`
        : '';
      trafficStatus.textContent = `${payload.road_name} · ${payload.baseline.trip_count} before · `
        + `${payload.closure_metrics.trip_count} with closure${stabilitySuffix}`;
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
    const selectionKey = () => JSON.stringify({ edges: trafficState.selectedEdgeIds, mode: trafficState.closureMode,
      oneWay: trafficState.oneWay, duration: trafficDuration?.value, scenario: trafficScenario?.value,
      control: trafficControlModel?.value, demand: trafficDemand?.value, seeds: trafficSeedCount?.value });
    const submittedSelection = selectionKey();
    trafficRun.disabled = true;
    trafficRun.textContent = 'Simulating…';
    trafficStatus.textContent = 'Starting paired SUMO simulations (road open vs closed)…';
    try {
      const requestBody = {
        road_name: trafficSelectionLabel(),
        edge_ids: trafficState.selectedEdgeIds,
        duration_min: Number(trafficDuration?.value) || 10,
        scenario: trafficScenario?.value || 'am_peak',
        closure_mode: trafficState.closureMode,
        traffic_control: trafficControlModel?.value || 'signalized',
        demand_multiplier: Number(trafficDemand?.value) || 1,
        seed_count: Number(trafficSeedCount?.value) || 3,
        one_way: trafficState.oneWay,
      };
      const startResponse = await fetch(`${windApi}/traffic/closure-preview/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        timeoutMs: 30000,
      });
      const job = await startResponse.json();
      if (!job.job_id) throw new Error('The traffic simulation did not return a job identifier.');
      const pollingStarted = performance.now();
      let completedResponse = null;
      let payload = null;
      while (performance.now() - pollingStarted < 15 * 60 * 1000) {
        await new Promise(resolve => setTimeout(resolve, Math.max(500, Number(job.poll_after_ms) || 1000)));
        const pollResponse = await fetch(
          `${windApi}/traffic/closure-preview/jobs/${encodeURIComponent(job.job_id)}`,
          { timeoutMs: 30000 },
        );
        const progress = await pollResponse.json();
        if (progress.status === 'complete') {
          completedResponse = pollResponse;
          payload = progress.result;
          break;
        }
        const elapsed = Math.max(0, Math.round(Number(progress.elapsed_s) || 0));
        const phase = progress.status === 'queued' ? 'Queued' : 'Running paired simulations';
        trafficStatus.textContent = `${phase}… ${elapsed}s elapsed. You can leave this panel open.`;
      }
      if (!payload) throw new Error('The traffic simulation exceeded the 15-minute job limit.');
      if (submittedSelection !== selectionKey()) return;
      buildTrafficResult(payload);
      dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'traffic', metadata: {
        description: 'Paired synthetic SUMO runs. Reliability gates and scenario assumptions are retained in the traffic report.',
        requestId: completedResponse?.headers.get('X-Request-ID'), job_id: job.job_id,
        source_provenance: job.source_provenance || null,
        scenario: { ...requestBody, selected_edge_ids: [...trafficState.selectedEdgeIds] },
        kpis: (() => {
          const impact = payload.impact || {}, ensemble = impact.ensemble || {}, environment = impact.environment || {};
          return {
            journey_time_change_pct: ensemble.applied ? ensemble.journey_time_change_pct?.median : impact.mean_journey_time_change_pct,
            mean_speed_change_pct: ensemble.applied ? ensemble.speed_change_pct?.median : impact.mean_speed_change_pct,
            baseline_peak_queue: ensemble.applied ? ensemble.max_queue_baseline?.median : impact.max_queue_baseline,
            closure_peak_queue: ensemble.applied ? ensemble.max_queue_closure?.median : impact.max_queue_closure,
            baseline_completion_share: ensemble.applied ? ensemble.completed_trip_ratio_baseline?.median : impact.completed_trip_ratio_baseline,
            closure_completion_share: ensemble.applied ? ensemble.completed_trip_ratio_closure?.median : impact.completed_trip_ratio_closure,
            co2_change_pct: ensemble.applied ? ensemble.co2_change_pct?.median : environment.co2_kg?.change_pct,
            assessment_ready: impact.assessment_ready !== false,
          };
        })(),
      } } }));
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

  function sampleCfd(x, worldY, z, includeTurbulenceGradient = false) {
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
    const kValues = includeTurbulenceGradient ? [] : null;
    const kWeights = includeTurbulenceGradient ? [] : null;
    const kWeightGradients = includeTurbulenceGradient ? [] : null;
    for (let dz = 0; dz <= 1; dz += 1) {
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const ix = lower[0] + dx;
          const iy = lower[1] + dy;
          const iz = lower[2] + dz;
          const sampleIndex = iz * dimensions[0] * dimensions[1] + iy * dimensions[0] + ix;
          if (!cfd.mask[sampleIndex]) continue;
          const wx = dx ? fraction[0] : 1 - fraction[0];
          const wy = dy ? fraction[1] : 1 - fraction[1];
          const wz = dz ? fraction[2] : 1 - fraction[2];
          const weight = wx * wy * wz;
          if (includeTurbulenceGradient) {
            const derivatives = [
              (dx ? 1 : -1) * wy * wz / spacing[0],
              (dy ? 1 : -1) * wx * wz / spacing[1],
              (dz ? 1 : -1) * wx * wy / spacing[2],
            ];
            kValues.push(cfd.fields[sampleIndex * cfd.channelCount + cfd.channels.k]);
            kWeights.push(weight);
            kWeightGradients.push(derivatives);
          }
          for (let channel = 0; channel < cfd.channelCount; channel += 1) {
            result[channel] += cfd.fields[sampleIndex * cfd.channelCount + channel] * weight;
          }
          weightTotal += weight;
        }
      }
    }
    if (weightTotal < 0.05) return null;
    for (let channel = 0; channel < result.length; channel += 1) result[channel] /= weightTotal;
    const sample = {
      u: result[cfd.channels.u_viewer_x],
      w: result[cfd.channels.w_up],
      v: result[cfd.channels.v_viewer_z],
      speed: result[cfd.channels.speed],
      p: result[cfd.channels.p],
      k: result[cfd.channels.k],
      epsilon: result[cfd.channels.epsilon],
    };
    if (includeTurbulenceGradient) {
      const turbulenceSample = normalizedMaskedInterpolationGradient(kValues, kWeights, kWeightGradients, 0.05);
      if (!turbulenceSample) return null;
      const coordinates = cfd.manifest.coordinates;
      const downwind = coordinates.x_downwind_in_viewer_xz;
      const crosswind = coordinates.y_crosswind_in_viewer_xz;
      sample.k = turbulenceSample.value;
      const gradientFoam = turbulenceSample.gradient;
      const varianceGradientFoam = gradientFoam.map(value => 2 * value / 3);
      const varianceGradient = [
        varianceGradientFoam[0] * downwind[0] + varianceGradientFoam[1] * crosswind[0],
        varianceGradientFoam[2],
        varianceGradientFoam[0] * downwind[1] + varianceGradientFoam[1] * crosswind[1],
      ];
      sample.variance = Math.max(0, sample.k) * 2 / 3;
      sample.varianceGradient = sample.variance > 0 ? varianceGradient : [0, 0, 0];
    }
    return [sample.u, sample.w, sample.v, sample.speed, sample.p, sample.k, sample.epsilon,
      ...(includeTurbulenceGradient ? [sample.variance, ...sample.varianceGradient] : [])].every(Number.isFinite)
      ? sample : null;
  }

  function cfdFieldRange(name) {
    return windState.cfdLocalRange?.[name] || windState.cfd?.manifest.ranges?.[name] || [0, 1];
  }

  // Use the central 80% of the current view's samples for local colour bounds.
  // Clipping the lowest and highest deciles keeps isolated extremes from
  // washing out the spatial pattern while the full sample range remains in
  // the underlying data and rankings.
  function computeLocalRange(field, values) {
    if (!values.length) return null;
    const minimumSpan = field === 'speed' ? 1.5 : field === 'p' ? 4 : 0.05;
    const sorted = values.slice().sort((a, b) => a - b);
    const quantile = fraction => {
      const position = (sorted.length - 1) * fraction;
      const lower = Math.floor(position), upper = Math.ceil(position);
      return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    };
    let minimum = quantile(0.1);
    let maximum = quantile(0.9);
    if (maximum - minimum < minimumSpan) {
      const midpoint = (minimum + maximum) * 0.5;
      minimum = midpoint - minimumSpan * 0.5;
      maximum = midpoint + minimumSpan * 0.5;
      if (field === 'speed' && minimum < 0) {
        minimum = 0;
        maximum = minimumSpan;
      }
    }
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
    const speedField = windState.cfdField === 'speed';
    if (windLegendField) windLegendField.textContent = CFD_FIELD_LABELS[windState.cfdField] || windState.cfdField;
    const formatBound = value => speedField
      ? `${value.toFixed(2)} m/s · ${(value * 3.6).toFixed(1)} km/h`
      : `${value.toFixed(2)} m²/s²`;
    const localPercentileRange = Boolean(windState.cfdLocalRange?.[windState.cfdField]);
    windLegendLow.innerHTML = `<b>${formatBound(minimum)}</b> · ${localPercentileRange ? 'P10 · low' : 'low'}`;
    windLegendHigh.innerHTML = `<b>${formatBound(maximum)}</b> · ${localPercentileRange ? 'P90 · high' : 'high'}`;
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
    const categories = windState.field?.comfort_categories || [];
    windComfortChips.innerHTML = categories.map(category => `
      <span><i style="background:${COMFORT_CHIP_COLORS[category.code]}"></i>${category.label}${
        category.max_speed_mps ? ` ≤${category.max_speed_mps} m/s · ${(category.max_speed_mps * 3.6).toFixed(0)} km/h` : ''}</span>`).join('');
  }

  // Registry of converted OpenFOAM cases available to the browser. A solved
  // case is not browser-ready until convert_openfoam_vtk.py has emitted its
  // volume.json, fields.f32 and valid.u8 files. Direction and Comfort both
  // read this registry and never synthesize an unlisted direction.
  const CFD_CASES = [
    { direction_deg: 0, sector: 'n', label: 'N 0°', base: '/assets/cfd/cbd_n_full/' },
    { direction_deg: 22.5, sector: 'nne', label: 'NNE 22.5°', base: '/assets/cfd/cbd_22p5_full/' },
    { direction_deg: 45, sector: 'ne', label: 'NE 45°', base: '/assets/cfd/cbd_ne_full/' },
    { direction_deg: 67.5, sector: 'ene', label: 'ENE 67.5°', base: '/assets/cfd/cbd_67p5_full/' },
    { direction_deg: 90, sector: 'e', label: 'E 90°', base: '/assets/cfd/cbd_e_full/' },
    { direction_deg: 112.5, sector: 'ese', label: 'ESE 112.5°', base: '/assets/cfd/cbd_112p5_full/' },
    { direction_deg: 135, sector: 'se', label: 'SE 135°', base: '/assets/cfd/cbd_se_full/' },
    { direction_deg: 157.5, sector: 'sse', label: 'SSE 157.5°', base: '/assets/cfd/cbd_157p5_full/' },
    { direction_deg: 180, sector: 's', label: 'S 180°', base: '/assets/cfd/cbd_s_full/' },
    { direction_deg: 202.5, sector: 'ssw', label: 'SSW 202.5°', base: '/assets/cfd/cbd_202p5_full/' },
    { direction_deg: 225, sector: 'sw', label: 'SW 225°', base: '/assets/cfd/cbd_sw_full/' },
    { direction_deg: 247.5, sector: 'wsw', label: 'WSW 247.5°', base: '/assets/cfd/cbd_247p5_full/' },
    { direction_deg: 270, sector: 'w', label: 'W 270°', base: '/assets/cfd/cbd_w_full/' },
    { direction_deg: 292.5, sector: 'wnw', label: 'WNW 292.5°', base: '/assets/cfd/cbd_292p5_full/' },
    { direction_deg: 315, sector: 'nw', label: 'NW 315°', base: '/assets/cfd/cbd_nw_full/' },
    { direction_deg: 337.5, sector: 'nnw', label: 'NNW 337.5°', base: '/assets/cfd/cbd_337p5_full/' },
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
  let windStudyRevision = 0;
  const invalidateWindStudy = () => { windStudyRevision++; cancelRequests('wind'); };
  addEventListener('climate-cancel-analysis', event => {
    if (event.detail?.tool === 'wind') invalidateWindStudy();
    if (event.detail?.tool === 'sun') cancelSunHours('Sunlight analysis cancelled.');
  });
  const invalidateWindStudyForControl = event => {
    if (event.target?.id !== 'wind-toggle') invalidateWindStudy();
  };
  document.querySelector('#menu-wind')?.addEventListener('input', invalidateWindStudyForControl, true);
  document.querySelector('#menu-wind')?.addEventListener('change', invalidateWindStudyForControl, true);
  document.querySelector('#menu-wind')?.addEventListener('click', event => {
    if (event.target.closest('[data-wind-lens], [data-wind-direction]')) invalidateWindStudy();
  }, true);
  const checkWindRevision = revision => {
    if (revision !== windStudyRevision) throw new DOMException('Wind settings changed; run again.', 'AbortError');
  };
  async function ensureCfdCaseLoaded(directionDeg, revision = windStudyRevision, onProgress = () => {}) {
    const cfdCase = typeof directionDeg === 'object' ? directionDeg : findCfdCase(directionDeg);
    if (!cfdCase) throw new Error(`no solved OpenFOAM case for ${directionDeg}°`);
    const base = cfdCase.base;
    onProgress(`Loading ${cfdCase.label} OpenFOAM manifest…`);
    const manifest = await fetch(`${base}volume.json`, { cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
      return response.json();
    });
    checkWindRevision(revision);
    const assetVersion = `${manifest.solver.case_id}-${manifest.result_time}-${manifest.dimensions.join('x')}`;
    const download = async (url, name) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
      if (!response.body?.getReader) return response.arrayBuffer();
      const reader = response.body.getReader(), chunks = [];
      const total = Number(response.headers.get('content-length')) || 0;
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.byteLength;
        const amount = total ? `${(100 * loaded / total).toFixed(0)}%` : `${(loaded / 1048576).toFixed(0)} MB`;
        onProgress(`Loading ${cfdCase.label} OpenFOAM ${name} · ${amount}…`);
      }
      const buffer = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      return buffer.buffer;
    };
    onProgress(`Downloading ${cfdCase.label} OpenFOAM velocity and mask fields…`);
    const [fieldBuffer, maskBuffer] = await Promise.all([
      download(`${base}${manifest.fields}?v=${assetVersion}`, 'velocity'),
      download(`${base}${manifest.valid_mask}?v=${assetVersion}`, 'valid-cell mask'),
    ]);
    checkWindRevision(revision);
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
    const revision = ++windStudyRevision;
    cancelRequests('wind');
    windSimulate.disabled = true;
    windSimulate.textContent = 'Loading CFD volume…';
    windStatus.textContent = 'Loading compact OpenFOAM fields…';
    if (windCfdLoadingMessage) windCfdLoadingMessage.textContent = `Loading ${Math.round(directionDeg)}° OpenFOAM field…`;
    if (windCfdLoading) windCfdLoading.hidden = false;
    if (windState.analysisMode === 'direction' && windPoints) windPoints.visible = false;
    try {
      const showLoading = message => {
        windStatus.textContent = message;
        if (windCfdLoadingMessage) windCfdLoadingMessage.textContent = message;
        if (windCfdLoading) windCfdLoading.hidden = false;
      };
      const cfdCase = await ensureCfdCaseLoaded(directionDeg, revision, showLoading);
      checkWindRevision(revision);
      const base = cfdCase.base;
      showLoading(`Building ${cfdCase.label} pedestrian heatmap…`);
      windState.loadedCfdCase = cfdCase;
      const manifest = windState.cfd.manifest;
      windState.direction = manifest.direction_deg_from;
      if (pollutionDirection) pollutionDirection.value = String(windState.direction);
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
      await buildCfdView();
      checkWindRevision(revision);
      // Keep the base map interactive while the solved field is being
      // prepared. Reveal the wind layer once its sampled ground surface is
      // ready, avoiding an early full-scene redraw during loading.
      if (document.querySelector('[data-menu-target="wind"].active') && windToggle && !windToggle.checked) {
        windToggle.checked = true;
        windToggle.dispatchEvent(new Event('change'));
      }
      primeWindSurfaceMotion();
      // buildCfdPedestrianSurface already emits the map's sampled field for
      // baseline saving. Avoid a second full-domain sampling pass here.
      resetWindParticles();
      updateCfdLegend();
      updateWindBox();
      const solver = manifest.solver;
      const coverage = manifest.building_coverage;
      const coverageLabel = coverage
        ? `${coverage.centroids_in_domain}/${coverage.scene_buildings} buildings`
        : 'solved domain';
      if (windModeBadge) windModeBadge.textContent = coverage?.fraction >= 0.99 ? 'CFD · FULL CBD' : 'CFD · PILOT';
      windDirectionPresets.forEach(button => button.classList.toggle('active', Number(button.dataset.windDirection) === windState.direction));
      windStatus.textContent = `${windState.designGeometryDirty ? 'Baseline geometry · ' : ''}OpenFOAM ${solver.version} · ${windState.cfdGroundHeight.toFixed(1)} m · ${coverageLabel}`;
      dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'wind', metadata: {
        description: `${cfdCase.label} · ${coverageLabel} · ${manifest.validation_status || 'unvalidated'}. Native spacing ${manifest.spacing_foam_m.join(' × ')} m.`,
        solver, direction: manifest.direction_deg_from, validation: manifest.validation_status, spacing: manifest.spacing_foam_m,
        case_id: manifest.solver.case_id, manifest_url: `${base}volume.json`,
        asset_version: `${manifest.solver.case_id}-${manifest.result_time}-${manifest.dimensions.join('x')}`,
        asset_hashes: manifest.asset_hashes || null,
        kpis: {
          case_direction_deg: manifest.direction_deg_from,
          volume_cells: manifest.dimensions.reduce((product, value) => product * Number(value), 1),
          building_domain_coverage_pct: Number.isFinite(Number(coverage?.fraction)) ? Number(coverage.fraction) * 100 : null,
        },
      } } }));
      if (!windState.cfdCameraFramed) {
        const half = windState.domainSize * 0.52;
        frameBounds([
          windState.domainCenter[0] - half, windState.domainCenter[1] - half,
          windState.domainCenter[0] + half, windState.domainCenter[1] + half,
        ], { elevation: 0.38 });
        windState.cfdCameraFramed = true;
      }
    } catch (error) {
      if (revision !== windStudyRevision) return;
      windStatus.textContent = `CFD volume unavailable (${error.message})`;
    } finally {
      if (revision !== windStudyRevision) return;
      if (windCfdLoading) windCfdLoading.hidden = true;
      windSimulate.disabled = false;
      windSimulate.textContent = windState.analysisMode === 'pollution'
        ? pollutionRunActionLabel() : 'Reload CFD result';
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

  async function rankWindLocations(field, isCancelled = () => false) {
    if (!field?.speed?.length || !field.width || !field.height) return { areas: [], streets: [] };
    const directional = Array.isArray(field.basis_xz) && Array.isArray(field.basis_z);
    const speedValue = index => {
      const speed = Number(field.speed[index]);
      return field.analysis_mode === 'comfort' && field.coverage_fraction > 0
        ? speed / field.coverage_fraction : speed;
    };
    const sample = (x, z) => {
      let column, row;
      if (directional) {
        const dx = x - field.origin[0], dz = z - field.origin[1];
        column = Math.round((dx * field.basis_xz[0] + dz * field.basis_xz[1]) / field.dx);
        row = Math.round((dx * field.basis_z[0] + dz * field.basis_z[1]) / field.dz);
      } else {
        column = Math.floor((x - field.origin[0]) / field.dx);
        row = Math.floor((z - field.origin[1]) / field.dz);
      }
      if (column < 0 || row < 0 || column >= field.width || row >= field.height) return null;
      const index = row * field.width + column;
      if (field.valid && !field.valid[index]) return null;
      const value = speedValue(index);
      return Number.isFinite(value) ? value : null;
    };
    const streets = new Map();
    const roads = data.roads || [];
    let streetSamplesSinceYield = 0;
    for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
      if (roadIndex % 24 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (isCancelled()) return { areas: [], streets: [] };
      }
      const road = roads[roadIndex];
      const name = String(road?.[3]?.name || '').trim();
      const points = road?.[2];
      if (!name || !Array.isArray(points) || points.length < 2) continue;
      for (let index = 1; index < points.length; index += 1) {
        const [x1, z1] = points[index - 1], [x2, z2] = points[index];
        const length = Math.hypot(x2 - x1, z2 - z1);
        if (!(length > 0)) continue;
        const steps = Math.max(1, Math.ceil(length / 20));
        const weight = length / steps;
        let item = streets.get(name);
        if (!item) streets.set(name, item = { name, total: 0, weight: 0, x: 0, z: 0 });
        for (let step = 0; step < steps; step += 1) {
          if (streetSamplesSinceYield++ % 256 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (isCancelled()) return { areas: [], streets: [] };
          }
          const fraction = (step + 0.5) / steps;
          const x = x1 + (x2 - x1) * fraction, z = z1 + (z2 - z1) * fraction;
          const value = sample(x, z);
          if (value == null) continue;
          item.total += value * weight;
          item.weight += weight;
          item.x += x * weight;
          item.z += z * weight;
        }
      }
    }
    const rankedStreets = [...streets.values()].filter(item => item.weight > 0).map(item => ({
      name: item.name, value: item.total / item.weight, x: item.x / item.weight, z: item.z / item.weight,
    })).sort((a, b) => b.value - a.value).slice(0, 5);

    const cells = [];
    for (let row = 0; row < field.height; row += 1) {
      if (row % 12 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (isCancelled()) return { areas: [], streets: [] };
      }
      for (let column = 0; column < field.width; column += 1) {
        const index = row * field.width + column;
        if ((field.valid && !field.valid[index]) || !Number.isFinite(Number(field.speed[index]))) continue;
        const x = directional
          ? field.origin[0] + column * field.dx * field.basis_xz[0] + row * field.dz * field.basis_z[0]
          : field.origin[0] + (column + 0.5) * field.dx;
        const z = directional
          ? field.origin[1] + column * field.dx * field.basis_xz[1] + row * field.dz * field.basis_z[1]
          : field.origin[1] + (row + 0.5) * field.dz;
        cells.push({ x, z, value: speedValue(index) });
      }
    }
    cells.sort((a, b) => b.value - a.value);
    const areas = [];
    for (const cell of cells) {
      if (areas.some(item => Math.hypot(item.x - cell.x, item.z - cell.z) < 120)) continue;
      const street = nearestMappedStreetName(cell.x, cell.z);
      areas.push({
        name: street ? `Near ${street}` : `CBD area · ${cell.x.toFixed(0)} m east / ${cell.z.toFixed(0)} m south`,
        value: cell.value, x: cell.x, z: cell.z,
      });
      if (areas.length >= 5) break;
    }
    return { areas, streets: rankedStreets };
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
    clearPollutantStudy(true);
    restoreStreetLayersAfterWind();
  }

  function syncPollutionView() {
    const active = windState.analysisMode === 'pollution';
    if (active) for (const object of [windHeatMesh, windPoints, windCfdSlice, windFacadePressure, windBox, windEdges, windHandle]) {
      if (object) object.visible = false;
    }
    pollutionGroup.visible = active;
  }

  function clearPollutantStudy(removeSource = false, invalidate = true) {
    if (invalidate) pollutionStudyRevision += 1;
    for (const object of [pollutionSourceMarker, pollutionReceivingAreaMarker, pollutionSurface]) {
      if (!object) continue;
      pollutionGroup.remove(object);
      if (object === pollutionSourceMarker) object.children.filter(child => child.isSprite).forEach(child => child.material?.map?.dispose());
      disposeObject(object);
    }
    pollutionSourceMarker = null;
    pollutionReceivingAreaMarker = null;
    pollutionSurface = null;
    pollutionSurfaceTexture?.dispose();
    pollutionSurfaceTexture = null;
    pollutionState.trajectories = [];
    pollutionState.exposureBins = [];
    pollutionState.sourceResidenceByEdge = new Map();
    pollutionState.currentExposureSmooth = null;
    pollutionState.exposureThresholds = null;
    pollutionState.runExposureThresholds = null;
    pollutionState.topExposureHotspots = [];
    pollutionState.escaped = 0;
    pollutionState.topEmissionRoads = [];
    pollutionState.demandMetadata = null;
    pollutionState.parcelWeightG = 1;
    pollutionState.mappedEmissionMassG = null;
    pollutionState.cfdSourceMassG = null;
    pollutionState.studyReady = false;
    pollutionState.playing = false;
    pollutionState.timeS = 0;
    syncPollutionLegend();
    if (pollutionTime) {
      pollutionTime.value = '0';
      pollutionTime.disabled = true;
    }
    if (pollutionTimeLabel) pollutionTimeLabel.textContent = '0 min';
    if (pollutionPlay) {
      pollutionPlay.disabled = true;
      pollutionPlay.textContent = 'Play timeline';
    }
    if (pollutionInspectToggle) pollutionInspectToggle.disabled = true;
    if (invalidate && windState.analysisMode === 'pollution' && windSimulate) {
      windSimulate.disabled = false;
      windSimulate.textContent = pollutionRunActionLabel();
    }
    if (pollutionResults) {
      pollutionResults.replaceChildren();
      pollutionResults.hidden = true;
    }
    if (pollutionLegend) pollutionLegend.hidden = windState.analysisMode !== 'pollution';
    if (pollutionInspectResult) pollutionInspectResult.hidden = true;
    if (pollutionScaleReference) pollutionScaleReference.hidden = true;
    if (removeSource) pollutionSourceMarker = null;
  }

  function pollutionProperties() {
    return { label: 'overall pollutants', settlingMps: 0 };
  }


  function buildPollutionSourceMarker() {
    if (pollutionState.sourceMode !== 'point') {
      if (pollutionSourceMarker) {
        pollutionGroup.remove(pollutionSourceMarker);
        pollutionSourceMarker.children.filter(child => child.isSprite).forEach(child => child.material?.map?.dispose());
        disposeObject(pollutionSourceMarker);
        pollutionSourceMarker = null;
      }
      return;
    }
    if (pollutionSourceMarker) {
      pollutionGroup.remove(pollutionSourceMarker);
      pollutionSourceMarker.children.filter(child => child.isSprite).forEach(child => child.material?.map?.dispose());
      disposeObject(pollutionSourceMarker);
    }
    const [x, z] = pollutionState.source;
    const ground = terrainSurfaceHeightAt(x, z);
    const height = pollutionState.sourceHeight;
    const marker = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5.5, 0.65, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x7dffca, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = ground + 0.8;
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 1.7, Math.max(height, 3), 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x5ce8bc, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
    );
    stem.position.y = ground + Math.max(height, 3) * 0.5;
    const emitter = new THREE.Mesh(
      new THREE.SphereGeometry(2.8, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xd5ff75, depthWrite: false }),
    );
    emitter.position.y = ground + height;
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256; labelCanvas.height = 64;
    const labelContext = labelCanvas.getContext('2d');
    labelContext.fillStyle = 'rgba(14, 30, 25, 0.94)';
    labelContext.beginPath();
    labelContext.roundRect(3, 3, 250, 58, 20);
    labelContext.fill();
    labelContext.strokeStyle = 'rgba(125,255,202,0.9)';
    labelContext.lineWidth = 3;
    labelContext.stroke();
    labelContext.fillStyle = '#a9ffe1';
    labelContext.font = '700 27px system-ui, sans-serif';
    labelContext.textAlign = 'center';
    labelContext.textBaseline = 'middle';
    labelContext.fillText('POLLUTANT SOURCE', 128, 33);
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: labelTexture, transparent: true, depthTest: false, depthWrite: false,
    }));
    label.scale.set(36, 9, 1);
    label.position.set(x, ground + height + 10, z);
    marker.add(ring, stem, emitter, label);
    marker.name = 'pollutant-source';
    marker.renderOrder = 8;
    pollutionGroup.add(marker);
    pollutionSourceMarker = marker;
  }

  function buildPollutionReceivingAreaMarker() {
    if (pollutionReceivingAreaMarker) {
      pollutionGroup.remove(pollutionReceivingAreaMarker);
      disposeObject(pollutionReceivingAreaMarker);
      pollutionReceivingAreaMarker = null;
    }
    const area = pollutionState.receivingArea;
    if (!pollutionState.studyReady || pollutionState.sourceMode !== 'traffic' || !area) return;
    const points = [];
    for (let step = 0; step < 72; step += 1) {
      const angle = step * 2 * Math.PI / 72;
      const x = area.x + Math.cos(angle) * area.radiusM;
      const z = area.z + Math.sin(angle) * area.radiusM;
      points.push(new THREE.Vector3(x, terrainSurfaceHeightAt(x, z) + 2.2, z));
    }
    pollutionReceivingAreaMarker = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    pollutionReceivingAreaMarker.renderOrder = 21;
    pollutionGroup.add(pollutionReceivingAreaMarker);
  }

  function pollutionRunActionLabel() {
    return 'Run overall pollutant heat map';
  }

  function pollutionRunProgressLabel() {
    return pollutionState.sourceMode === 'traffic' ? 'Running traffic scenario…' : 'Calculating pollutant map…';
  }

  function syncPollutionControls() {
    const trafficMode = pollutionState.sourceMode === 'traffic';
    for (const option of pollutionDirection?.options || []) {
      option.disabled = !findCfdCase(Number(option.value));
    }
    if (pollutionTrafficOptions) pollutionTrafficOptions.hidden = !trafficMode;
    if (pollutionTrafficLoadControl) pollutionTrafficLoadControl.hidden = !trafficMode;
    if (pollutionAreaRadius) pollutionAreaRadius.closest('.pollution-area-control').hidden = !trafficMode;
    if (pollutionPointControls) pollutionPointControls.hidden = trafficMode;
    if (!trafficMode && pollutionAdvanced) pollutionAdvanced.open = true;
    if (pollutionTimelineTitle) pollutionTimelineTitle.textContent = trafficMode ? 'Traffic pollutant timeline' : 'Release timeline';
    if (pollutionTimeEndpoints) pollutionTimeEndpoints.innerHTML = trafficMode
      ? '<span>0 · traffic release begins</span><span>10 · traffic sample ends</span><span>15 min · map record</span>'
      : '<span>0 · release begins</span><span>6 · source ends</span><span>15 min · map record</span>';
    syncPollutionLegend();
    if (windState.analysisMode === 'pollution' && windSimulate && !windSimulate.disabled) {
      windSimulate.textContent = pollutionRunActionLabel();
    }
  }

  function pollutionCell(x, z) {
    const columns = POLLUTION_GRID_SIZE;
    const rows = POLLUTION_GRID_SIZE;
    const width = (right - left) / columns;
    const depth = (maxZ - minZ) / rows;
    const column = Math.floor((x - left) / width);
    const row = Math.floor((z - minZ) / depth);
    if (column < 0 || row < 0 || column >= columns || row >= rows) return -1;
    return { index: row * columns + column, column, row, columns, rows, width, depth };
  }

  const POLLUTION_TIER_COLORS = [0x49b8d2, 0xf1d45b, 0xff923f, 0xe84d56];
  const POLLUTION_TIER_NAMES = ['Lower', 'Moderate', 'High', 'Very high'];
  const POLLUTION_EXPOSURE_PALETTE = [0x204750, ...POLLUTION_TIER_COLORS].map(color => new THREE.Color(color));

  function writePollutionExposureColor(value, thresholds, pixels, offset) {
    const levels = [0, thresholds?.[0] || 0, thresholds?.[1] || 0, thresholds?.[2] || 0, thresholds?.[3] || thresholds?.[2] || 0];
    let lower = 0;
    while (lower < levels.length - 1 && value >= levels[lower + 1]) lower += 1;
    const upper = Math.min(POLLUTION_EXPOSURE_PALETTE.length - 1, lower + 1);
    const span = levels[upper] - levels[lower];
    const amount = span > 1e-9 ? clamp((value - levels[lower]) / span, 0, 1) : 1;
    const from = POLLUTION_EXPOSURE_PALETTE[lower], to = POLLUTION_EXPOSURE_PALETTE[upper];
    pixels[offset] = Math.round((from.r + (to.r - from.r) * amount) * 255);
    pixels[offset + 1] = Math.round((from.g + (to.g - from.g) * amount) * 255);
    pixels[offset + 2] = Math.round((from.b + (to.b - from.b) * amount) * 255);
  }

  function pollutionQuantile(sortedValues, quantile) {
    if (!sortedValues.length) return 0;
    return sortedValues[Math.floor((sortedValues.length - 1) * quantile)];
  }

  function pollutionTier(value, thresholds = pollutionState.exposureThresholds) {
    if (!(value > 0) || !thresholds) return -1;
    if (value >= thresholds[2]) return 3;
    if (value >= thresholds[1]) return 2;
    if (value >= thresholds[0]) return 1;
    return 0;
  }

  function smoothPollutionGrid(values) {
    const columns = POLLUTION_GRID_SIZE, rows = POLLUTION_GRID_SIZE;
    const radius = 3, sigma = 1.35;
    const weights = [];
    let weightTotal = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
      weights.push(weight);
      weightTotal += weight;
    }
    for (let index = 0; index < weights.length; index += 1) weights[index] /= weightTotal;
    const horizontal = new Float32Array(values.length);
    const smooth = new Float32Array(values.length);
    for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
      let total = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceColumn = clamp(column + offset, 0, columns - 1);
        total += values[row * columns + sourceColumn] * weights[offset + radius];
      }
      horizontal[row * columns + column] = total;
    }
    for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
      let total = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceRow = clamp(row + offset, 0, rows - 1);
        total += horizontal[sourceRow * columns + column] * weights[offset + radius];
      }
      smooth[row * columns + column] = total;
    }
    return smooth;
  }

  function nearestPollutionRoadName(x, z) {
    let bestDistance = Infinity;
    let bestName = 'Unnamed street';
    for (const road of trafficState.networkEdges) {
      if (!road.points?.length) continue;
      for (let index = 1; index < road.points.length; index += 1) {
        const [ax, az] = road.points[index - 1], [bx, bz] = road.points[index];
        const dx = bx - ax, dz = bz - az;
        const lengthSquared = dx * dx + dz * dz;
        if (lengthSquared < 0.04) continue;
        const t = clamp(((x - ax) * dx + (z - az) * dz) / lengthSquared, 0, 1);
        const distance = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestName = road.name || road.road_name || 'Unnamed street';
        }
      }
    }
    return { name: bestName, distance: bestDistance };
  }

  function summarizePollutionExposure() {
    const count = POLLUTION_GRID_SIZE * POLLUTION_GRID_SIZE;
    const total = new Float64Array(count);
    for (const bin of pollutionState.exposureBins) {
      if (!bin) continue;
      for (let index = 0; index < count; index += 1) total[index] += bin[index];
    }
    const smooth = smoothPollutionGrid(total);
    const positive = [];
    for (const value of smooth) if (value > 0) positive.push(value);
    positive.sort((a, b) => a - b);
    pollutionState.runExposureThresholds = positive.length ? [
      pollutionQuantile(positive, 0.5), pollutionQuantile(positive, 0.8),
      pollutionQuantile(positive, 0.95), pollutionQuantile(positive, 0.99),
    ] : null;
    if (pollutionState.sourceMode === 'traffic' && pollutionState.runExposureThresholds) {
      if (!pollutionComparisonScale) pollutionComparisonScale = [...pollutionState.runExposureThresholds];
      pollutionState.exposureThresholds = pollutionComparisonScale;
    } else {
      pollutionState.exposureThresholds = pollutionState.runExposureThresholds;
    }
    pollutionState.topExposureHotspots = [];
    if (!pollutionState.exposureThresholds || !trafficState.networkEdges.length) return;

    const columns = POLLUTION_GRID_SIZE, rows = POLLUTION_GRID_SIZE;
    const spacingX = (right - left) / columns, spacingZ = (maxZ - minZ) / rows;
    const candidates = [];
    for (let row = 3; row < rows - 3; row += 1) for (let column = 3; column < columns - 3; column += 1) {
      const index = row * columns + column;
      const value = smooth[index];
      if (value < pollutionState.exposureThresholds[1]) continue;
      let localMaximum = true;
      for (let dy = -3; dy <= 3 && localMaximum; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
        if (smooth[(row + dy) * columns + column + dx] > value) { localMaximum = false; break; }
      }
      if (!localMaximum) continue;
      const x = left + (column + 0.5) * spacingX;
      const z = minZ + (row + 0.5) * spacingZ;
      if (!pointInLidarFootprint(x, z) || !terrainValidAt(x, z)) continue;
      candidates.push({ x, z, value, tier: pollutionTier(value) });
    }
    candidates.sort((a, b) => b.value - a.value);
    for (const candidate of candidates) {
      if (pollutionState.topExposureHotspots.some(item => Math.hypot(item.x - candidate.x, item.z - candidate.z) < 180)) continue;
      if (windPointInsideBuilding(candidate.x, candidate.z, terrainSurfaceHeightAt(candidate.x, candidate.z) + 1.5)) continue;
      const road = nearestPollutionRoadName(candidate.x, candidate.z);
      pollutionState.topExposureHotspots.push({ ...candidate, road: road.name, roadDistance: road.distance });
      if (pollutionState.topExposureHotspots.length >= 5) break;
    }
  }

  function syncPollutionLegend() {
    if (pollutionLegendTitle) pollutionLegendTitle.textContent = 'Overall pollutant exposure';
    if (pollutionGradientLegend) pollutionGradientLegend.hidden = true;
    if (pollutionContinuousLabels) pollutionContinuousLabels.hidden = true;
    if (pollutionTierLegend) pollutionTierLegend.hidden = false;
    if (pollutionScaleReference) pollutionScaleReference.hidden = !pollutionState.studyReady || pollutionState.sourceMode !== 'traffic';
    if (pollutionTierLegend) {
      const [half, eighty, ninetyFive] = pollutionState.exposureThresholds || [];
      const format = value => Number(value).toPrecision(3);
      const labels = pollutionState.exposureThresholds
        ? [`Lower · <${format(half)}`, `Moderate · ${format(half)}–${format(eighty)}`,
          `High · ${format(eighty)}–${format(ninetyFive)}`, `Very high · ≥${format(ninetyFive)}`]
        : ['Lower', 'Moderate', 'High', 'Very high'];
      pollutionTierLegend.querySelectorAll('span').forEach((item, index) => {
        item.lastChild.textContent = labels[index];
      });
    }
    if (pollutionLegendNote) pollutionLegendNote.textContent = pollutionState.studyReady
      ? pollutionState.sourceMode === 'traffic'
        ? 'Shared scale from the first traffic run: combined NOx and exhaust PMx tracer residence (g·s) per grid cell. Blank areas do not establish clean air; this is not concentration.'
        : 'Colours rank modelled exposure within this run. Blank areas may have no recorded pollutant residence or only trace; they do not prove clean air.'
      : 'After running, colours rank relative overall pollutant residence within this scenario. They are not measured concentrations.';
  }

  function buildPollutionSurface() {
    pollutionSurfaceTexture?.dispose();
    pollutionSurfaceTexture = null;
    if (pollutionSurface) {
      pollutionGroup.remove(pollutionSurface);
      disposeObject(pollutionSurface);
      pollutionSurface = null;
    }
    syncPollutionLegend();
    if (!pollutionState.studyReady || !windState.cfd) return;
    const columns = POLLUTION_GRID_SIZE, rows = POLLUTION_GRID_SIZE, count = columns * rows;
    const values = new Float64Array(count);
    const timeBin = Math.min(pollutionState.exposureBins.length - 1, Math.ceil(pollutionState.timeS / 5) - 1);
    for (let bin = 0; bin <= timeBin; bin += 1) {
      const source = pollutionState.exposureBins[bin];
      if (!source) continue;
      for (let cell = 0; cell < count; cell += 1) values[cell] += source[cell];
    }
    // Smooth only the displayed field to reduce parcel-sampling speckle; the
    // underlying time-binned residence values remain unchanged.
    const smooth = smoothPollutionGrid(values);
    pollutionState.currentExposureSmooth = smooth;
    let maximum = 0;
    for (const value of smooth) maximum = Math.max(maximum, value);
    if (!(maximum > 0)) return;
    const validCells = new Uint8Array(count);
    const cellWidth = (right - left) / columns;
    const cellDepth = (maxZ - minZ) / rows;
    for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
      const centerX = left + (column + 0.5) * cellWidth;
      const centerZ = minZ + (row + 0.5) * cellDepth;
      validCells[row * columns + column] = pointInLidarFootprint(centerX, centerZ)
        && !windPointInsideBuilding(centerX, centerZ, terrainSurfaceHeightAt(centerX, centerZ) + 1.5) ? 1 : 0;
    }

    // Interpolate the smoothed field into a higher-resolution texture so the
    // severity colours blend continuously instead of outlining source cells.
    const textureSize = columns * 2;
    const pixels = new Uint8Array(textureSize * textureSize * 4);
    const bilinearValue = (x, y) => {
      const sampleX = clamp(x, 0, columns - 1), sampleY = clamp(y, 0, rows - 1);
      const x0 = Math.floor(sampleX), y0 = Math.floor(sampleY);
      const x1 = Math.min(columns - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1);
      const tx = sampleX - x0, ty = sampleY - y0;
      const a = smooth[y0 * columns + x0] * (1 - tx) + smooth[y0 * columns + x1] * tx;
      const b = smooth[y1 * columns + x0] * (1 - tx) + smooth[y1 * columns + x1] * tx;
      return a * (1 - ty) + b * ty;
    };
    for (let row = 0; row < textureSize; row += 1) for (let column = 0; column < textureSize; column += 1) {
      const offset = (row * textureSize + column) * 4;
      const u = (column + 0.5) / textureSize;
      const v = (row + 0.5) / textureSize;
      const sourceColumn = u * columns - 0.5;
      const sourceRow = v * rows - 0.5;
      const maskColumn = clamp(Math.floor(u * columns), 0, columns - 1);
      const maskRow = clamp(Math.floor(v * rows), 0, rows - 1);
      if (!validCells[maskRow * columns + maskColumn]) continue;
      const value = bilinearValue(sourceColumn, sourceRow);
      const displayCutoff = Math.max(1e-9, (pollutionState.exposureThresholds?.[0] || maximum) * 0.001);
      if (!(value > displayCutoff)) continue;
      writePollutionExposureColor(value, pollutionState.exposureThresholds, pixels, offset);
      const lowReference = Math.max(1e-9, (pollutionState.exposureThresholds?.[0] || maximum) * 0.35);
      const highReference = Math.max(1e-9, pollutionState.exposureThresholds?.[3] || pollutionState.exposureThresholds?.[2] || maximum);
      const feather = clamp(value / lowReference, 0, 1);
      const strength = 0.22 + 0.78 * Math.sqrt(clamp(value / highReference, 0, 1));
      pixels[offset + 3] = Math.round(clamp(strength * feather, 0, 0.97) * 255);
    }
    pollutionSurfaceTexture = new THREE.DataTexture(pixels, textureSize, textureSize, THREE.RGBAFormat);
    pollutionSurfaceTexture.magFilter = THREE.LinearFilter;
    pollutionSurfaceTexture.minFilter = THREE.LinearFilter;
    pollutionSurfaceTexture.generateMipmaps = false;
    pollutionSurfaceTexture.needsUpdate = true;

    const meshResolution = textureSize;
    const vertexCount = (meshResolution + 1) * (meshResolution + 1);
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    let positionOffset = 0, uvOffset = 0;
    for (let row = 0; row <= meshResolution; row += 1) for (let column = 0; column <= meshResolution; column += 1) {
      const x = left + (right - left) * column / meshResolution;
      const z = minZ + (maxZ - minZ) * row / meshResolution;
      positions[positionOffset++] = x;
      positions[positionOffset++] = terrainSurfaceHeightAt(x, z) + 0.62;
      positions[positionOffset++] = z;
      uvs[uvOffset++] = column / meshResolution;
      uvs[uvOffset++] = row / meshResolution;
    }
    const indices = new Uint16Array(meshResolution * meshResolution * 6);
    let indexOffset = 0;
    const verticesPerRow = meshResolution + 1;
    for (let row = 0; row < meshResolution; row += 1) for (let column = 0; column < meshResolution; column += 1) {
      const a = row * verticesPerRow + column, b = a + 1;
      const d = a + verticesPerRow, c = d + 1;
      indices[indexOffset++] = a; indices[indexOffset++] = b; indices[indexOffset++] = c;
      indices[indexOffset++] = a; indices[indexOffset++] = c; indices[indexOffset++] = d;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    pollutionSurface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      map: pollutionSurfaceTexture, transparent: true, opacity: 0.96,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.NormalBlending,
      polygonOffset: true, polygonOffsetFactor: -3,
    }));
    pollutionSurface.name = 'relative-overall-pollutant-exposure';
    pollutionSurface.renderOrder = 6;
    pollutionGroup.add(pollutionSurface);
  }

  function pollutionRng(seed) {
    let state = seed >>> 0;
    return () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function pollutionNormal(random) {
    const u = Math.max(1e-9, random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  }

  function createPollutionMarkerAtSource() {
    const [x, z] = pollutionState.source;
    const terrainY = terrainSurfaceHeightAt(x, z);
    if (!terrainValidAt(x, z)) throw new Error('Choose a point inside the mapped city terrain.');
    if (windPointInsideBuilding(x, z, terrainY + pollutionState.sourceHeight)) {
      let candidate = null;
      for (let radius = 10; radius <= 180 && !candidate; radius += 10) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) {
          const cx = x + Math.cos(angle) * radius, cz = z + Math.sin(angle) * radius;
          if (terrainValidAt(cx, cz) && !windPointInsideBuilding(cx, cz, terrainSurfaceHeightAt(cx, cz) + pollutionState.sourceHeight)) {
            candidate = [cx, cz];
            break;
          }
        }
      }
      if (!candidate) throw new Error('No open-air source location was found near that point.');
      pollutionState.source = candidate;
      if (pollutionSourceStatus) pollutionSourceStatus.textContent = `Snapped to nearby open air · ${candidate[0].toFixed(0)} m east, ${candidate[1].toFixed(0)} m south.`;
    }
    buildPollutionSourceMarker();
  }

  function createPollutionVisuals() {
    buildPollutionSurface();
  }

  function updatePollutionVisuals(now, force = false) {
    if (!pollutionState.studyReady) return;
    if (pollutionState.playing && !force) {
      const elapsed = Math.min(0.12, (now - pollutionState.lastTime) / 1000);
      pollutionState.timeS = Math.min(pollutionState.durationS, pollutionState.timeS + elapsed * 30);
      if (pollutionState.timeS >= pollutionState.durationS) {
        pollutionState.playing = false;
        if (pollutionPlay) pollutionPlay.textContent = 'Replay timeline';
      }
      if (pollutionTime) pollutionTime.value = String(Math.round(pollutionState.timeS / 5) * 5);
      if (pollutionTimeLabel) pollutionTimeLabel.textContent = `${(pollutionState.timeS / 60).toFixed(1)} min`;
      const bin = Math.floor(pollutionState.timeS / 30);
      if (bin !== pollutionState.lastSurfaceBin) {
        pollutionState.lastSurfaceBin = bin;
        buildPollutionSurface();
      }
    }
    pollutionState.lastTime = now;
  }

  function updatePollutionResults() {
    if (!pollutionResults) return;
    const properties = pollutionProperties();
    const trafficData = pollutionState.sourceMode === 'traffic' ? pollutionState.trafficRunData : null;
    const massLabel = 'overall NOx + exhaust PMx';
    const totalTrafficMassG = trafficData
      ? Number(trafficData.emissions?.nox_g || 0) + Number(trafficData.emissions?.pmx_g || 0)
      : 0;
    const mappedEmissionShare = totalTrafficMassG > 0 && Number.isFinite(pollutionState.mappedEmissionMassG)
      ? pollutionState.mappedEmissionMassG / totalTrafficMassG * 100
      : 0;
    const cfdSourceMassShare = totalTrafficMassG > 0 && Number.isFinite(pollutionState.cfdSourceMassG)
      ? pollutionState.cfdSourceMassG / totalTrafficMassG * 100
      : 0;
    const hotspotSummary = pollutionState.topExposureHotspots.length
      ? `<span class="pollution-summary-wide"><b>Highest relative pollutant pockets · full 15-minute run</b>${pollutionState.topExposureHotspots.map((hotspot, index) => `<i>${index + 1}. ${reportEscape(hotspot.road)} · ${POLLUTION_TIER_NAMES[hotspot.tier]}${hotspot.roadDistance < 80 ? '' : ` · ${Math.round(hotspot.roadDistance)} m from mapped road`}</i>`).join('')}</span>`
      : '<span class="pollution-summary-wide"><b>Relative pollutant pockets</b><i>No persistent near-ground hotspot was resolved in this run.</i></span>';
    let receivingSummary = '';
    if (trafficData && pollutionState.receivingArea && pollutionState.sourceResidenceByEdge.size) {
      const totalCells = new Float64Array(POLLUTION_GRID_SIZE * POLLUTION_GRID_SIZE);
      for (const bin of pollutionState.exposureBins) {
        for (let cell = 0; cell < totalCells.length; cell += 1) totalCells[cell] += bin[cell];
      }
      const area = pollutionState.receivingArea;
      const result = summarizeSourceResidence(pollutionState.sourceResidenceByEdge, totalCells, area,
        { left, minZ, right, maxZ, columns: POLLUTION_GRID_SIZE, rows: POLLUTION_GRID_SIZE });
      const historyKey = [trafficData.scenario?.key || pollutionTrafficScenario?.value,
        pollutionTrafficLoad?.value, windState.cfd.manifest.solver.case_id,
        Math.round(area.x), Math.round(area.z), area.radiusM].join('|');
      if (!pollutionSeedHistory.has(historyKey)) pollutionSeedHistory.set(historyKey, new Map());
      const history = pollutionSeedHistory.get(historyKey);
      history.set(Number(trafficData.seed), result.sources.slice(0, 3).map(source => source.edgeId));
      const leading = new Set([...history.values()].flat());
      const stableRoads = [...leading].map(edgeId => ({
        edgeId, appearances: [...history.values()].filter(edges => edges.includes(edgeId)).length,
      })).sort((a, b) => b.appearances - a.appearances || a.edgeId.localeCompare(b.edgeId));
      const stability = history.size < 2
        ? '<i>One seed so far. Run the other two seeds with this area, traffic period and wind field to check whether leading source links persist.</i>'
        : `<i>Top-three source links across ${history.size} seeds: ${stableRoads.map(item => {
          const road = trafficState.edgesById.get(item.edgeId);
          return `${reportEscape(road?.name || 'Unnamed road')} (${reportEscape(item.edgeId)}) ${item.appearances}/${history.size}`;
        }).join('; ')}. Counts show appearances, not statistical confidence.</i>`;
      const nearRoad = nearestPollutionRoadName(area.x, area.z);
      const rows = result.sources.slice(0, 8).map((source, index) => {
        const road = trafficState.edgesById.get(source.edgeId);
        return `<i>${index + 1}. ${reportEscape(road?.name || road?.road_name || 'Unnamed road')} · ${reportEscape(source.edgeId)} · ${(source.share * 100).toFixed(1)}% · ${source.residence.toPrecision(3)} g·s</i>`;
      }).join('');
      const other = result.sources.slice(8).reduce((sum, source) => sum + source.residence, 0);
      receivingSummary = `<span class="pollution-summary-wide"><b>Sources reaching a ${area.radiusM} m area near ${reportEscape(nearRoad.name)}</b>
        <i>Receiving centre ${area.x.toFixed(1)} m east, ${area.z.toFixed(1)} m south · full 15-minute run · ${result.areaTotal.toPrecision(4)} g·s unblurred near-ground residence across ${result.cellCount} cells · ${result.sources.length} source links · SUMO seed ${Number(trafficData.seed)}</i>
        ${rows || '<i>No sampled parcel residence in this area.</i>'}
        ${other > 0 ? `<i>Other ${result.sources.length - 8} links · ${(other / result.sourceTotal * 100).toFixed(1)}%</i>` : ''}
        <i>${result.sourceTotal > 0 ? 'All source shares sum to 100%' : 'No source shares to report'}; source total ${result.sourceTotal.toPrecision(4)} g·s, accounting difference ${result.difference.toPrecision(2)} g·s (grid rounding).</i>
        ${stability}
        <i>Relative tracer residence only; this is neither ambient concentration nor personal dose. Re-run SUMO if a proposal changes traffic routes.</i>
      </span>`;
    }
    const trafficSummary = trafficData ? `
      <span><b>${totalTrafficMassG.toFixed(2)} g</b>SUMO HBEFA3 ${massLabel} in this run</span>
      <span><b>${(pollutionState.mappedEmissionMassG || 0).toFixed(2)} g · ${mappedEmissionShare.toFixed(1)}%</b>emissions assigned to mapped road sources</span>
      <span><b>${(pollutionState.cfdSourceMassG || 0).toFixed(2)} g · ${cfdSourceMassShare.toFixed(1)}%</b>estimated mapped emissions released inside the valid CFD and terrain footprint</span>
      <span><b>${Number(trafficData.departed_vehicle_count || 0).toLocaleString()}</b>vehicles inserted across the CBD</span>
      <span class="pollution-summary-wide"><b>${trafficData.scenario?.label || 'Synthetic weekday traffic'}</b>${Number(trafficData.duration_min || 10)}-minute source window · ${trafficData.traffic_demand?.observed_count_calibration ? 'configured edge counts used' : 'synthetic demand'}</span>
      ${hotspotSummary}
      ${receivingSummary}
      <span class="pollution-summary-wide"><b>Top emitting roads · ${massLabel}</b>${pollutionState.topEmissionRoads.slice(0, 5).map((road, index) => `<i>${index + 1}. ${reportEscape(road.name)} · ${road.value.toFixed(3)} g</i>`).join('') || '<i>No mapped road emissions in this run</i>'}</span>` : `
      <span class="pollution-summary-wide">Surface deposition and pollutant chemistry are not modelled.</span>`;
    const mapLabel = 'relative overall pollutant residence near the ground';
    pollutionResults.innerHTML = `${trafficSummary}
      <span class="pollution-summary-wide"><b>${Math.round(windState.direction)}° · ${properties.label}</b>OpenFOAM ${windState.cfd.manifest.solver.version} · ${windState.cfd.manifest.solver.case_id} · 10 m/s reference inflow</span>
      <span class="pollution-summary-wide">Colours show ${mapLabel}. No map layer represents concentration in µg/m³.</span>`;
    pollutionResults.hidden = false;
  }

  async function loadCityTrafficEmissions(revision) {
    const scenario = pollutionTrafficScenario?.value || 'am_peak';
    const demandMultiplier = Number(pollutionTrafficLoad?.value) || 1;
    const seed = Number(pollutionTrafficSeed?.value) || 240917;
    const cacheKey = `${scenario}|${demandMultiplier}|${seed}`;
    if (pollutionState.trafficRunData?.cacheKey === cacheKey) return pollutionState.trafficRunData;
    windStatus.textContent = 'Loading SUMO road network…';
    if (!trafficState.networkEdges.length) await loadTrafficRoads();
    if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return null;
    if (!trafficState.networkEdges.length) throw new Error('Run the FastAPI app to load the SUMO road network.');
    windStatus.textContent = 'Running whole-CBD SUMO traffic and HBEFA3 emissions…';
    const startResponse = await fetch(`${windApi}/traffic/emissions-preview/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_min: 10, scenario, demand_multiplier: demandMultiplier, seed }),
    });
    const startPayload = await startResponse.json();
    if (!startResponse.ok) throw new Error(startPayload.detail || `SUMO job HTTP ${startResponse.status}`);
    const jobId = startPayload.job_id;
    if (!jobId) throw new Error('SUMO did not return a traffic job identifier.');
    let status = startPayload.status;
    let payload = startPayload;
    while (status !== 'complete') {
      if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return null;
      if (status === 'error') throw new Error(payload.detail || 'The SUMO emissions job failed.');
      await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await fetch(`${windApi}/traffic/emissions-preview/jobs/${encodeURIComponent(jobId)}`);
      payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `SUMO job HTTP ${response.status}`);
      status = payload.status;
      if (status !== 'complete') {
        const elapsed = Math.max(0, Math.round(Number(payload.elapsed_s) || 0));
        windStatus.textContent = `Simulating CBD traffic and tailpipe emissions… ${elapsed}s`;
      }
    }
    const result = payload.result;
    if (!result?.road_emissions?.length) throw new Error('The traffic run returned no road-level emissions.');
    result.cacheKey = cacheKey;
    pollutionState.trafficRunData = result;
    return result;
  }

  function prepareTrafficReleaseSources(result) {
    const byRoad = new Map();
    const rows = [];
    let mappedGeometryMassG = 0;
    let totalMassG = 0;
    for (const item of result.road_emissions || []) {
      const road = trafficState.edgesById.get(item.edge_id);
      const massG = combinedTrafficMassG(item);
      if (!road?.points?.length || !(massG > 0)) continue;
      const clipped = clipPolylineToValidSamples(road.points, (x, z) => {
        if (!terrainValidAt(x, z) || !pointInLidarFootprint(x, z)) return false;
        const releaseY = terrainSurfaceHeightAt(x, z) + 1.2;
        return !windPointInsideBuilding(x, z, releaseY) && Boolean(sampleCfd(x, releaseY, z));
      });
      const { segments, totalLengthM: lengthM, validLengthM } = clipped;
      if (!(lengthM > 0)) continue;
      mappedGeometryMassG += massG;
      if (!segments.length || !(validLengthM > 0)) continue;
      const cfdMassG = massG * validLengthM / lengthM;
      rows.push({ edge: road, item, massG: cfdMassG, segments, lengthM: validLengthM });
      const name = item.road_name || road.name || 'Unnamed road';
      byRoad.set(name, (byRoad.get(name) || 0) + cfdMassG);
      totalMassG += cfdMassG;
    }
    if (!(totalMassG > 0) || !rows.length) {
      throw new Error('No emitted road pollutant mass overlaps the valid CFD and terrain footprint for this traffic run.');
    }
    const topRoads = [...byRoad.entries()].map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value).slice(0, 12);
    pollutionState.topEmissionRoads = topRoads;
    pollutionState.demandMetadata = result.traffic_demand;
    pollutionState.mappedEmissionMassG = mappedGeometryMassG;
    pollutionState.cfdSourceMassG = totalMassG;
    pollutionState.parcelWeightG = totalMassG / pollutionState.particleCount;
    pollutionState.emissionWindowS = Math.min(pollutionState.durationS, Math.round(Number(result.duration_min || 10) * 60));
    return { rows, totalMassG, mappedGeometryMassG };
  }

  function sampleTrafficRoadSource(sourceDistribution, random, massFraction) {
    let roll = massFraction * sourceDistribution.totalMassG;
    let selected = sourceDistribution.rows.at(-1);
    for (const row of sourceDistribution.rows) {
      roll -= row.massG;
      if (roll <= 0) { selected = row; break; }
    }
    const distance = random() * selected.lengthM;
    const segment = selected.segments.find(item => distance <= item.endAtM) || selected.segments.at(-1);
    const previousEnd = segment.endAtM - segment.lengthM;
    const along = clamp((distance - previousEnd) / segment.lengthM, 0, 1);
    return {
      x: segment.a[0] + (segment.b[0] - segment.a[0]) * along,
      z: segment.a[1] + (segment.b[1] - segment.a[1]) * along,
      edgeId: selected.item.edge_id,
    };
  }

  async function runPollutantDispersal() {
    const revision = ++pollutionStudyRevision;
    pollutionState.sourceMode = pollutionSourceType?.value || pollutionState.sourceMode;
    syncPollutionControls();
    pollutionResults.hidden = true;
    pollutionLegend.hidden = false;
    windSimulate.disabled = true;
    windSimulate.textContent = pollutionRunProgressLabel();
    if (!windState.cfd || Math.round(windState.cfd.manifest.direction_deg_from) !== Math.round(windState.direction)) {
      try {
        await loadCfdWind(windState.direction);
      } catch (error) {
        if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return;
        windStatus.textContent = `OpenFOAM field unavailable (${error.message})`;
        windSimulate.disabled = false;
        windSimulate.textContent = pollutionRunActionLabel();
        return;
      }
    }
    if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return;
    if (!windState.cfd || Math.round(windState.cfd.manifest.direction_deg_from) !== Math.round(windState.direction)) {
      windStatus.textContent = 'The selected OpenFOAM direction could not be loaded. Choose a solved direction and retry.';
      windSimulate.disabled = false;
      windSimulate.textContent = pollutionRunActionLabel();
      return;
    }
    windSimulate.disabled = true;
    windSimulate.textContent = pollutionRunProgressLabel();
    try {
      let trafficData = null;
      if (pollutionState.sourceMode === 'traffic') {
        trafficData = await loadCityTrafficEmissions(revision);
        if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return;
        if (!trafficData) return;
      } else {
        pollutionState.sourceHeight = Number(pollutionHeight?.value) || 2;
        createPollutionMarkerAtSource();
      }
      if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return;
      clearPollutantStudy(false, false);
      pollutionState.sourceMode = pollutionSourceType?.value || pollutionState.sourceMode;
      pollutionState.sourceHeight = pollutionState.sourceMode === 'traffic' ? 1.2 : Number(pollutionHeight?.value) || 2;
      buildPollutionSourceMarker();
      const sourceDistribution = trafficData ? prepareTrafficReleaseSources(trafficData) : null;
      if (trafficData) pollutionState.trafficRunData = trafficData;
      else {
        pollutionState.emissionWindowS = 360;
        pollutionState.parcelWeightG = 1;
        pollutionState.topEmissionRoads = [];
        pollutionState.demandMetadata = null;
      }
      // Residence is accumulated many times per cell. Keep the accounting in
      // Float64 so small parcel visits are not rounded away as bins grow.
      pollutionState.exposureBins = Array.from({ length: 181 }, () => new Float64Array(POLLUTION_GRID_SIZE * POLLUTION_GRID_SIZE));
      const properties = pollutionProperties();
      const sourceSeed = trafficData
        ? `${trafficData.seed}|overall-pollutants|${windState.direction}`
        : `${pollutionState.source[0]}|${pollutionState.source[1]}|${windState.direction}|${pollutionState.sourceHeight}`;
      let seedValue = 0;
      for (let index = 0; index < sourceSeed.length; index += 1) seedValue = (Math.imul(seedValue, 31) + sourceSeed.charCodeAt(index)) >>> 0;
      const random = pollutionRng(seedValue);
      const sourceMassFractions = sourceDistribution
        ? stratifiedFractions(pollutionState.particleCount, random) : null;
      windStatus.textContent = `Calculating the overall pollutant heat map with the ${Math.round(windState.direction)}° OpenFOAM field…`;
    let escaped = 0;
    let buildingCollisionSteps = 0;
    const trajectories = [];
    const domain = windState.cfd.manifest;
    const horizontalSpacing = Math.min(...domain.spacing_foam_m.slice(0, 2).map(Math.abs));
    const cellSpacing = [horizontalSpacing, Math.abs(domain.spacing_foam_m[2]), horizontalSpacing];
    if (!cellSpacing.every(value => value > 0 && Number.isFinite(value))) throw new Error('The OpenFOAM grid has invalid cell spacing.');
    const topY = domain.coordinates.vertical_datum_m + domain.origin_foam_m[2]
      + domain.spacing_foam_m[2] * (domain.dimensions[2] - 1);
    for (let particleIndex = 0; particleIndex < pollutionState.particleCount; particleIndex += 1) {
      const emittedAt = stratifiedSampleTime(particleIndex, pollutionState.particleCount, pollutionState.emissionWindowS);
      const release = sourceDistribution
        ? sampleTrafficRoadSource(sourceDistribution, random, sourceMassFractions[particleIndex]) : null;
      const [sourceX, sourceZ] = release ? [release.x, release.z] : pollutionState.source;
      let x = sourceX, z = sourceZ;
      let y = terrainSurfaceHeightAt(x, z) + pollutionState.sourceHeight;
      let turbulent = null;
      let endAge = pollutionState.durationS - emittedAt;
      let age = 0;
      let currentTerrainValid = terrainValidAt(x, z);
      let currentFootprintValid = pointInLidarFootprint(x, z);
      while (age < endAge) {
        const local = sampleCfd(x, y, z, true);
        if (!local) { escaped += 1; endAge = age; break; }
        const k = Math.max(0, local.k || 0);
        const epsilon = Math.max(1e-6, local.epsilon || 0);
        const tau = lagrangianTimeScale(k, epsilon);
        const sigma = Math.sqrt(2 * k / 3);
        if (!turbulent) turbulent = [sigma * pollutionNormal(random), sigma * pollutionNormal(random), sigma * pollutionNormal(random)];
        const stepDt = Math.min(endAge - age, pollutantTimeStep({
          cellSpacing,
          velocity: [local.u + turbulent[0], local.w + turbulent[1], local.v + turbulent[2]],
          sigma,
          variance: local.variance,
          varianceGradient: local.varianceGradient,
          timeScale: tau,
        }));
        const stepStartTime = emittedAt + age;
        const previousX = x, previousY = y, previousZ = z;
        const previousDomainValid = currentTerrainValid && Boolean(local);
        let segmentMidpoint = null, midpointCfdSample = null;
        const step = advancePollutantStep([x, y, z], turbulent, local, sigma, tau, stepDt,
          () => pollutionNormal(random), (midX, midY, midZ) => {
            segmentMidpoint = [midX, midY, midZ];
            const midpoint = sampleCfd(midX, midY, midZ, true);
            midpointCfdSample = midpoint;
            return windPointInsideBuilding(midX, midZ, midY)
              ? redirectWindFlow(midX, midZ, midpoint || local, true, midY)
              : midpoint;
          }, properties.settlingMps);
        turbulent = step.turbulentVelocity;
        const [rawNextX, rawNextY, rawNextZ] = step.position;
        let nextX = rawNextX, nextY = rawNextY, nextZ = rawNextZ;
        const rawTerrainValid = terrainValidAt(rawNextX, rawNextZ);
        const rawFootprintValid = pointInLidarFootprint(rawNextX, rawNextZ);
        const rawInsideScene = rawTerrainValid && rawFootprintValid;
        let insideScene = rawInsideScene;
        const endBuilding = rawInsideScene && windPointInsideBuilding(rawNextX, rawNextZ, rawNextY);
        const sweptBuildingIntervals = windBuildingIntervalsAlongSegment(
          previousX, previousY, previousZ, rawNextX, rawNextY, rawNextZ,
        );
        const buildingCollision = sweptBuildingIntervals.find(([start, end]) => end > start && start < 1 - 1e-9) || null;
        let endpointTerrainValid = rawTerrainValid, endpointFootprintValid = rawFootprintValid;
        if (buildingCollision) {
          buildingCollisionSteps += 1;
          const [entryStart, entryEnd] = buildingCollision;
          const segmentLength = Math.hypot(rawNextX - previousX, rawNextY - previousY, rawNextZ - previousZ);
          const probeOffset = Math.min((entryEnd - entryStart) * 0.5, Math.max(1e-7, 0.05 / Math.max(segmentLength, 0.05)));
          const probeFraction = entryStart + probeOffset;
          const probeX = previousX + (rawNextX - previousX) * probeFraction;
          const probeY = previousY + (rawNextY - previousY) * probeFraction;
          const probeZ = previousZ + (rawNextZ - previousZ) * probeFraction;
          const collisionSurface = windBuildingOutwardNormal(probeX, probeY, probeZ);
          if (collisionSurface) {
            turbulent = reflectVelocityAtBoundary(
              [local.u, local.w - properties.settlingMps, local.v], turbulent, collisionSurface,
            );
            if (Math.abs(collisionSurface[1]) > 0.5) {
              const boundary = nearestWindBoundary(probeX, probeZ, probeY);
              nextX = probeX;
              nextZ = probeZ;
              nextY = collisionSurface[1] > 0
                ? boundary.building.roofY + 0.05 : boundary.building.baseY - 0.05;
            } else {
              [nextX, nextZ] = pushWindPointOutsideBuilding(probeX, probeZ, probeY);
              nextY = probeY;
            }
          } else {
            [nextX, nextZ] = pushWindPointOutsideBuilding(rawNextX, rawNextZ, rawNextY);
          }
          endpointTerrainValid = terrainValidAt(nextX, nextZ);
          endpointFootprintValid = pointInLidarFootprint(nextX, nextZ);
          insideScene = endpointTerrainValid && endpointFootprintValid;
        } else if (endBuilding) {
          [nextX, nextZ] = pushWindPointOutsideBuilding(nextX, nextZ, nextY);
          endpointTerrainValid = terrainValidAt(nextX, nextZ);
          endpointFootprintValid = pointInLidarFootprint(nextX, nextZ);
          insideScene = endpointTerrainValid && endpointFootprintValid;
        }
        const ground = terrainSurfaceHeightAt(nextX, nextZ);
        const rawGround = terrainSurfaceHeightAt(rawNextX, rawNextZ);
        const previousGround = terrainSurfaceHeightAt(previousX, previousZ);
        const previousHeightAgl = previousY - previousGround;
        const rawNextHeightAgl = rawNextY - rawGround;
        const rawEndpointSample = !endBuilding ? sampleCfd(rawNextX, rawNextY, rawNextZ) : null;
        const rawEndpointDomainValid = rawTerrainValid && rawNextY < topY && (
          endBuilding || (rawNextHeightAgl < 0.45
            ? Boolean(sampleCfd(rawNextX, rawGround + 0.45, rawNextZ))
            : Boolean(rawEndpointSample))
        );
        const [midpointX, midpointY, midpointZ] = segmentMidpoint;
        const midpointGround = terrainSurfaceHeightAt(midpointX, midpointZ);
        const midpointHeightAgl = midpointY - midpointGround;
        const midpointTerrainValid = terrainValidAt(midpointX, midpointZ);
        const midpointFootprintValid = pointInLidarFootprint(midpointX, midpointZ);
        const midpointInsideBuilding = midpointFootprintValid && windPointInsideBuilding(midpointX, midpointZ, midpointY);
        const midpointMapSample = midpointCfdSample || (midpointTerrainValid && !midpointInsideBuilding
          && midpointHeightAgl >= 0.45 && midpointY < topY
          ? sampleCfd(midpointX, midpointY, midpointZ) : null);
        const midpointDomainValid = midpointTerrainValid && midpointY < topY && (
          midpointHeightAgl < 0.45
            ? Boolean(sampleCfd(midpointX, midpointGround + 0.45, midpointZ))
            : midpointInsideBuilding || Boolean(midpointMapSample)
        );
        const domainIntervals = clipSegmentToValidIntervals(
          [previousX, previousY, previousZ], [rawNextX, rawNextY, rawNextZ], (sampleX, sampleY, sampleZ) => {
            if (!terrainValidAt(sampleX, sampleZ)) return false;
            const heightAgl = sampleY - terrainSurfaceHeightAt(sampleX, sampleZ);
            if (heightAgl < 0.45) {
              return Boolean(sampleCfd(sampleX, terrainSurfaceHeightAt(sampleX, sampleZ) + 0.45, sampleZ));
            }
            if (windPointInsideBuilding(sampleX, sampleZ, sampleY)) return true;
            return sampleY < topY && Boolean(sampleCfd(sampleX, sampleY, sampleZ));
          }, 24, {
            startIsValid: previousDomainValid,
            midpointIsValid: midpointDomainValid,
            endIsValid: rawEndpointDomainValid,
          },
        );
        const footprintIntervals = lidarFootprintSegmentIntervals(
          previousX, previousZ, rawNextX, rawNextZ, currentFootprintValid,
        );
        const validIntervals = intersectIntervals(domainIntervals, footprintIntervals);
        const nearGroundInterval = clipReflectedSegmentWithinRange(
          previousHeightAgl, rawNextHeightAgl, 0.45, 10,
        );
        const buildingLimit = buildingCollision ? buildingCollision[0] : 1;
        const boundedNearGround = nearGroundInterval && validIntervals
          ? validIntervals.map(([start, end]) => [Math.max(nearGroundInterval[0], start), Math.min(nearGroundInterval[1], end, buildingLimit)])
            .filter(([start, end]) => end > start)
          : [];
        const nearGroundIntervals = boundedNearGround.flatMap(interval => subtractIntervals([interval], sweptBuildingIntervals));
        const groundBoundary = ground + 0.45;
        if (!buildingCollision && insideScene && rawNextHeightAgl < 0.45) {
          // Do not silently remove mass: this combined tracer has no calibrated
          // deposition velocity or species-specific surface chemistry.
          nextY = groundBoundary + (groundBoundary - nextY);
          turbulent[1] = reflectNormalVelocityAtBoundary(
            local.w - properties.settlingMps, turbulent[1],
          );
        }
        if (nearGroundIntervals.length) {
          const crossedCells = segmentCellFractions(previousX, previousZ, rawNextX, rawNextZ, {
            left, minZ, right, maxZ, columns: POLLUTION_GRID_SIZE, rows: POLLUTION_GRID_SIZE,
          });
          for (const cell of crossedCells) {
            for (const layerInterval of nearGroundIntervals) {
              const startFraction = Math.max(cell.startFraction, layerInterval[0]);
              const endFraction = Math.min(cell.endFraction, layerInterval[1]);
              if (!(endFraction > startFraction)) continue;
              const cellStart = stepStartTime + stepDt * startFraction;
              const cellEnd = stepStartTime + stepDt * endFraction;
              const residence = accumulateResidenceBins(pollutionState.exposureBins,
                cellStart, cellEnd, cell.index, pollutionState.parcelWeightG);
              if (release) recordSourceResidence(pollutionState.sourceResidenceByEdge, release.edgeId,
                cell.index, residence, POLLUTION_GRID_SIZE * POLLUTION_GRID_SIZE);
            }
          }
        }
        const endpointUnchanged = nextX === rawNextX && nextY === rawNextY && nextZ === rawNextZ;
        const endpointSample = endpointUnchanged ? rawEndpointSample : sampleCfd(nextX, nextY, nextZ);
        if (!endpointSample || nextY >= topY) {
          escaped += 1;
          endAge = age;
          break;
        } else {
          x = nextX; y = nextY; z = nextZ;
          currentTerrainValid = endpointTerrainValid;
          currentFootprintValid = endpointFootprintValid;
        }
        age += stepDt;
      }
      trajectories.push({
        emittedAt, endAge,
      });
      if (particleIndex % 20 === 19) {
        windStatus.textContent = `Building overall pollutant heat map… ${particleIndex + 1}/${pollutionState.particleCount}`;
        await new Promise(resolve => setTimeout(resolve, 0));
        if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return;
      }
    }
    pollutionState.trajectories = trajectories;
    pollutionState.escaped = escaped;
    summarizePollutionExposure();
    pollutionState.timeS = 0;
    pollutionState.lastSurfaceBin = -1;
    pollutionState.studyReady = true;
    syncPollutionLegend();
    buildPollutionReceivingAreaMarker();
    pollutionState.playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    pollutionState.lastTime = performance.now();
    if (pollutionPlay) {
      pollutionPlay.disabled = false;
      pollutionPlay.textContent = pollutionState.playing ? 'Pause timeline' : 'Play timeline';
    }
    if (pollutionTime) pollutionTime.value = '0';
    if (pollutionTime) pollutionTime.disabled = false;
    pollutionTimeLabel.textContent = '0.0 min';
    if (pollutionInspectToggle) pollutionInspectToggle.disabled = false;
    updatePollutionResults();
    createPollutionVisuals();
    windStatus.textContent = pollutionState.sourceMode === 'traffic'
      ? 'Mapped road emissions inside this CFD footprint are traced · playback shows relative near-ground residence.'
      : 'Overall pollutant heat map ready · scrub the release timeline to inspect near-ground residence.';
    windSimulate.disabled = false;
    windSimulate.textContent = 'Run scenario again';
    dispatchEvent(new CustomEvent('climate-analysis-result', { detail: { tool: 'wind', metadata: {
      description: `Exploratory Lagrangian ${properties.label} dispersal, driven by OpenFOAM ${windState.cfd.manifest.solver.case_id}. Relative near-ground tracer residence only; no scalar concentration solve.`,
      solver: windState.cfd.manifest.solver, direction: windState.direction,
      tracer_parcels: trajectories.length, escaped_parcels: escaped,
      building_collision_steps: buildingCollisionSteps,
      traffic_emissions: trafficData ? trafficData.emissions : undefined,
      traffic_scenario: trafficData?.scenario,
      traffic_source_accounting: trafficData ? (() => {
        const totalMassG = combinedTrafficMassG(trafficData.emissions);
        const mappedRoadMassG = pollutionState.mappedEmissionMassG || 0;
        const cfdSourceMassG = pollutionState.cfdSourceMassG || 0;
        return {
          overall_nox_pmx_mass_g: totalMassG,
          mapped_road_mass_g: mappedRoadMassG,
          valid_cfd_source_mass_g: cfdSourceMassG,
          mapped_road_fraction: totalMassG > 0 ? mappedRoadMassG / totalMassG : null,
          valid_cfd_source_fraction: totalMassG > 0 ? cfdSourceMassG / totalMassG : null,
          emission_window_s: pollutionState.emissionWindowS,
        };
      })() : undefined,
      validation: windState.cfd.manifest.validation_status,
    } } }));
    requestRender();
    } catch (error) {
      if (revision !== pollutionStudyRevision || windState.analysisMode !== 'pollution') return;
      pollutionState.playing = false;
      windStatus.textContent = `Pollutant dispersal unavailable (${error.message})`;
      windSimulate.disabled = false;
      windSimulate.textContent = pollutionRunActionLabel();
    }
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

  let cfdSurfaceBuildRevision = 0;
  function buildWindUiYield() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  async function buildCfdPedestrianSurface() {
    const buildRevision = ++cfdSurfaceBuildRevision;
    const previousWindHeatMesh = windHeatMesh;
    if (!windState.cfd || windState.cfdView !== 'ground') {
      if (previousWindHeatMesh) {
        windGroup.remove(previousWindHeatMesh);
        disposeObject(previousWindHeatMesh);
        windHeatMesh = null;
      }
      return;
    }
    const manifest = windState.cfd.manifest;
    const nativeSpacing = manifest.spacing_foam_m;
    const domainSizeX = nativeSpacing[0] * (manifest.dimensions[0] - 1);
    const domainSizeY = nativeSpacing[1] * (manifest.dimensions[1] - 1);
    const origin = manifest.origin_foam_m;
    // Sample on sub-native cells. Cell-centred validity avoids dropping a
    // whole quad just because one of its shared corners falls inside a
    // building or outside the CFD mask.
    // Retain the normal 10 m pedestrian display resolution. Yield between row
    // batches below so this full-detail mesh does not block scene interaction.
    const groundResolution = 10;
    const columns = Math.max(2, Math.round(domainSizeX / groundResolution));
    const rows = Math.max(2, Math.round(domainSizeY / groundResolution));
    const spacing = [domainSizeX / columns, domainSizeY / rows];
    const points = [];
    for (let row = 0; row <= rows; row += 1) {
      if (row % 8 === 0) {
        await buildWindUiYield();
        if (buildRevision !== cfdSurfaceBuildRevision) return;
      }
      for (let column = 0; column <= columns; column += 1) {
        const foamX = origin[0] + column * spacing[0];
        const foamY = origin[1] + row * spacing[1];
        const [x, , z] = foamToViewerPoint(foamX, foamY, 0);
        const worldY = terrainHeightAt(x, z) + windState.cfdGroundHeight;
        points.push([x, worldY, z]);
      }
    }
    // Keep solver samples for inspection/statistics, while tracking building
    // masks separately so the display mesh can sit on the ground and let the
    // actual building geometry define a clean edge.
    const cellSamples = [];
    const cellCenters = [];
    const blockedByBuilding = [];
    for (let row = 0; row < rows; row += 1) {
      if (row % 6 === 0) {
        await buildWindUiYield();
        if (buildRevision !== cfdSurfaceBuildRevision) return;
      }
      for (let column = 0; column < columns; column += 1) {
        const a = row * (columns + 1) + column;
        const d = a + columns + 2;
        const x = (points[a][0] + points[d][0]) * 0.5;
        const z = (points[a][2] + points[d][2]) * 0.5;
        const worldY = terrainHeightAt(x, z) + windState.cfdGroundHeight;
        const inFootprint = pointInLidarFootprint(x, z);
        const blocked = inFootprint && windPointInsideBuilding(x, z, worldY);
        const sample = inFootprint && !blocked
          ? sampleCfd(x, worldY, z) : null;
        cellCenters.push([x, z]);
        cellSamples.push(sample);
        blockedByBuilding.push(blocked);
      }
    }
    windState.cfdLocalRange = {
      [windState.cfdField]: computeLocalRange(
        windState.cfdField,
        cellSamples.filter(Boolean).map(sample => sample[windState.cfdField]),
      ),
    };
    const positions = [];
    const colors = [];
    const surfaceUvs = [];
    const valid = [];
    const indices = [];
    const cornerCount = (columns + 1) * (rows + 1);
    const cornerSums = new Float32Array(cornerCount);
    const cornerSamples = new Uint8Array(cornerCount);
    for (let row = 0; row < rows; row += 1) {
      if (row % 12 === 0) {
        await buildWindUiYield();
        if (buildRevision !== cfdSurfaceBuildRevision) return;
      }
      for (let column = 0; column < columns; column += 1) {
        const sample = cellSamples[row * columns + column];
        if (!sample) continue;
        const value = sample[windState.cfdField];
        for (const corner of [
          row * (columns + 1) + column,
          (row + 1) * (columns + 1) + column,
          (row + 1) * (columns + 1) + column + 1,
          row * (columns + 1) + column + 1,
        ]) {
          cornerSums[corner] += value;
          cornerSamples[corner] += 1;
        }
      }
    }
    for (let row = 0; row < rows; row += 1) {
      if (row % 6 === 0) {
        await buildWindUiYield();
        if (buildRevision !== cfdSurfaceBuildRevision) return;
      }
      for (let column = 0; column < columns; column += 1) {
        const cell = row * columns + column;
        const sample = cellSamples[cell];
        valid.push(Boolean(sample));
        let displaySample = sample;
        let nearbyCount = 0;
        if (!displaySample && !blockedByBuilding[cell]) {
          for (let nearbyRow = Math.max(0, row - 1); nearbyRow <= Math.min(rows - 1, row + 1); nearbyRow += 1) {
            for (let nearbyColumn = Math.max(0, column - 1); nearbyColumn <= Math.min(columns - 1, column + 1); nearbyColumn += 1) {
              if (cellSamples[nearbyRow * columns + nearbyColumn]) nearbyCount += 1;
            }
          }
        }
        if (!displaySample && (blockedByBuilding[cell] || nearbyCount >= 6)) {
          let total = 0, count = 0;
          for (let nearbyRow = Math.max(0, row - 2); nearbyRow <= Math.min(rows - 1, row + 2); nearbyRow += 1) {
            for (let nearbyColumn = Math.max(0, column - 2); nearbyColumn <= Math.min(columns - 1, column + 2); nearbyColumn += 1) {
              const nearby = cellSamples[nearbyRow * columns + nearbyColumn];
              if (!nearby) continue;
              total += nearby[windState.cfdField];
              count += 1;
            }
          }
          if (count) displaySample = { [windState.cfdField]: total / count };
        }
        if (!displaySample) continue;
        const a = row * (columns + 1) + column;
        const b = a + 1;
        const c = a + columns + 1;
        const d = c + 1;
        for (const corner of [a, c, d, b]) {
          const [x, , z] = points[corner];
          positions.push(x, terrainHeightAt(x, z) + 0.035, z);
          const cornerValue = cornerSamples[corner] ? cornerSums[corner] / cornerSamples[corner] : displaySample[windState.cfdField];
          const color = cfdColor(cornerValue);
          colors.push(color.r, color.g, color.b);
          surfaceUvs.push((corner % (columns + 1)) / columns, Math.floor(corner / (columns + 1)) / rows);
        }
        const vertex = positions.length / 3 - 4;
        indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('windSurfaceUv', new THREE.Float32BufferAttribute(surfaceUvs, 2));
    geometry.setIndex(indices);
    const materialParameters = {
      vertexColors: true, transparent: true, opacity: 0.82, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    };
    let material;
    if (windState.cfdField === 'speed') {
      const range = cfdFieldRange('speed');
      const palette = new Float32Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const color = cfdColor(range[0] + (range[1] - range[0]) * i / 255, 'speed');
        palette.set([color.r, color.g, color.b, 1], i * 4);
      }
      material = createWindSurfaceMaterial(materialParameters, {
        columns, rows, samples: cellSamples,
        basisX: manifest.coordinates.x_downwind_in_viewer_xz,
        basisZ: manifest.coordinates.y_crosswind_in_viewer_xz,
        sizeX: domainSizeX, sizeZ: domainSizeY, range, palette,
      });
    } else material = makeWindLayerMaterial(materialParameters);
    const nextWindHeatMesh = new THREE.Mesh(geometry, material);
    nextWindHeatMesh.name = `cfd-terrain-following-${windState.cfdGroundHeight}m-${windState.cfdField}`;
    nextWindHeatMesh.renderOrder = 3;
    windGroup.add(nextWindHeatMesh);
    if (previousWindHeatMesh) {
      windGroup.remove(previousWindHeatMesh);
      disposeObject(previousWindHeatMesh);
    }
    windHeatMesh = nextWindHeatMesh;
    hideStreetLayersForWind();
    primeWindSurfaceMotion();
    requestRender();
    if (windState.analysisMode === 'direction') {
      const result = {
        analysis_mode: 'direction', cfd: true,
        version: windState.cfd.manifest.solver?.case_id || 'openfoam-cfd',
        validation_status: windState.cfd.manifest.validation_status || 'exploratory_unvalidated_pilot',
        direction_deg: windState.direction, height_m: windState.cfdGroundHeight,
        season: windState.season, stability: windState.stability,
        model_kind: 'steady_openfoam_rans',
        origin: [cellCenters[0][0], cellCenters[0][1]], width: columns, height: rows,
        dx: spacing[0], dz: spacing[1],
        basis_xz: windState.cfd.manifest.coordinates.x_downwind_in_viewer_xz,
        basis_z: windState.cfd.manifest.coordinates.y_crosswind_in_viewer_xz,
        speed: cellSamples.map(sample => sample?.speed || 0), valid: Uint8Array.from(valid, value => value ? 1 : 0),
      };
      result.wind_rankings = await rankWindLocations(result, () => buildRevision !== cfdSurfaceBuildRevision);
      if (buildRevision !== cfdSurfaceBuildRevision) return;
      dispatchEvent(new CustomEvent('climate-wind-result', { detail: result }));
    }
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

  async function buildCfdView() {
    if (windState.cfdView !== 'ground') restoreStreetLayersAfterWind();
    // Ground/slice recompute this for whichever field is showing; reset
    // first so switching to Flow/Façades never colours with a stale range
    // left over from a different view (that range can be much narrower than
    // what those views actually span, which would blow the colours out).
    windState.cfdLocalRange = null;
    await buildCfdPedestrianSurface();
    buildCfdSlice();
    buildCfdFacadePressure();
    if (windPoints) {
      windPoints.visible = windState.analysisMode === 'direction'
        && windState.cfdView === 'flow' && windState.flowlinesVisible
        && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    updateCfdLegend();
    syncPollutionView();
    if (windState.analysisMode === 'pollution') restoreStreetLayersAfterWind();
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
    if (comfortMode) {
      // Subdivide the display mesh and blend colours between nearby solved
      // cells. A few masked building cells and isolated one-cell mesh gaps
      // are filled for rendering only; the field and inspector stay masked.
      const nearestComfortCategory = (column, row) => {
        let nearest = null, nearestDistance = Infinity;
        for (let radius = 0; radius <= 3 && nearest === null; radius += 1) {
          for (let r = Math.max(0, row - radius); r <= Math.min(field.height - 1, row + radius); r += 1) {
            for (let c = Math.max(0, column - radius); c <= Math.min(field.width - 1, column + radius); c += 1) {
              const index = r * field.width + c;
              if (!field.valid?.[index]) continue;
              const distance = (c - column) ** 2 + (r - row) ** 2;
              if (distance < nearestDistance) {
                nearest = field.comfort_category[index];
                nearestDistance = distance;
              }
            }
          }
        }
        return nearest;
      };
      const comfortColorAt = (x, z) => {
        const gx = clamp((x - field.origin[0]) / field.dx - 0.5, 0, field.width - 1);
        const gz = clamp((z - field.origin[1]) / field.dz - 0.5, 0, field.height - 1);
        const c0 = Math.floor(gx), r0 = Math.floor(gz);
        const c1 = Math.min(c0 + 1, field.width - 1), r1 = Math.min(r0 + 1, field.height - 1);
        const tx = gx - c0, tz = gz - r0;
        const centerColumn = clamp(Math.round((x - field.origin[0]) / field.dx - 0.5), 0, field.width - 1);
        const centerRow = clamp(Math.round((z - field.origin[1]) / field.dz - 0.5), 0, field.height - 1);
        const fallbackCategory = nearestComfortCategory(centerColumn, centerRow);
        if (fallbackCategory === null) return null;
        const category = (c, r) => field.valid?.[r * field.width + c]
          ? field.comfort_category[r * field.width + c] : nearestComfortCategory(c, r) ?? fallbackCategory;
        const top = category(c0, r0) * (1 - tx) + category(c1, r0) * tx;
        const bottom = category(c0, r1) * (1 - tx) + category(c1, r1) * tx;
        const value = top * (1 - tz) + bottom * tz;
        const low = Math.floor(value), high = Math.min(5, low + 1), mix = value - low;
        const color = new THREE.Color(comfortColors[low]).lerp(new THREE.Color(comfortColors[high]), mix);
        return color;
      };
      const subdivisions = 4;
      for (let row = 0; row < field.height; row += 1) {
        for (let column = 0; column < field.width; column += 1) {
          const cell = row * field.width + column;
          const centerX = field.origin[0] + (column + 0.5) * field.dx;
          const centerZ = field.origin[1] + (row + 0.5) * field.dz;
          const centerY = terrainHeightAt(centerX, centerZ) + field.height_m;
          const blockedByBuilding = windPointInsideBuilding(centerX, centerZ, centerY);
          let nearbySamples = 0;
          for (let nearbyRow = Math.max(0, row - 1); nearbyRow <= Math.min(field.height - 1, row + 1); nearbyRow += 1) {
            for (let nearbyColumn = Math.max(0, column - 1); nearbyColumn <= Math.min(field.width - 1, column + 1); nearbyColumn += 1) {
              if (field.valid?.[nearbyRow * field.width + nearbyColumn]) nearbySamples += 1;
            }
          }
          const isolatedDataGap = !field.valid?.[cell] && nearbySamples >= 6;
          if ((!field.valid?.[cell] && !blockedByBuilding && !isolatedDataGap) || !pointInLidarFootprint(centerX, centerZ)) continue;
          for (let sy = 0; sy < subdivisions; sy += 1) for (let sx = 0; sx < subdivisions; sx += 1) {
            const x0 = field.origin[0] + (column + sx / subdivisions) * field.dx;
            const x1 = field.origin[0] + (column + (sx + 1) / subdivisions) * field.dx;
            const z0 = field.origin[1] + (row + sy / subdivisions) * field.dz;
            const z1 = field.origin[1] + (row + (sy + 1) / subdivisions) * field.dz;
            if (!pointInLidarFootprint((x0 + x1) * 0.5, (z0 + z1) * 0.5)) continue;
            const corners = [[x0, z0], [x0, z1], [x1, z1], [x1, z0]];
            const cornerColors = corners.map(([x, z]) => comfortColorAt(x, z));
            if (cornerColors.some(color => !color)) continue;
            const vertex = positions.length / 3;
            corners.forEach(([x, z], index) => {
              positions.push(x, terrainHeightAt(x, z) + 0.035, z);
              const color = cornerColors[index];
              colors.push(color.r, color.g, color.b);
            });
            indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
          }
        }
      }
    } else {
      const subdivisions = 4;
      for (let row = 0; row < field.height; row += 1) {
        for (let column = 0; column < field.width; column += 1) {
          const centerX = field.origin[0] + (column + 0.5) * field.dx;
          const centerZ = field.origin[1] + (row + 0.5) * field.dz;
          if (!pointInLidarFootprint(centerX, centerZ)) continue;
          for (let sy = 0; sy < subdivisions; sy += 1) for (let sx = 0; sx < subdivisions; sx += 1) {
            const x0 = field.origin[0] + (column + sx / subdivisions) * field.dx;
            const x1 = field.origin[0] + (column + (sx + 1) / subdivisions) * field.dx;
            const z0 = field.origin[1] + (row + sy / subdivisions) * field.dz;
            const z1 = field.origin[1] + (row + (sy + 1) / subdivisions) * field.dz;
            if (!pointInLidarFootprint((x0 + x1) * 0.5, (z0 + z1) * 0.5)) continue;
            const vertex = positions.length / 3;
            [[x0, z0], [x0, z1], [x1, z1], [x1, z0]].forEach(([x, z]) => {
              const color = windColor(sampleWind(x, z).speed, minimum, maximum);
              positions.push(x, terrainHeightAt(x, z) + 0.035, z);
              colors.push(color.r, color.g, color.b);
            });
            indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const layerMaterial = makeWindLayerMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.76,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    windHeatMesh = new THREE.Mesh(geometry, layerMaterial);
    windHeatMesh.name = 'wind-speed-heatmap';
    windHeatMesh.renderOrder = 2;
    windHeatMesh.visible = windState.surfaceVisible;
    windGroup.add(windHeatMesh);
    if (windState.enabled && windState.surfaceVisible) hideStreetLayersForWind();
  }

  function windFieldCellValid(field, x, z) {
    const column = Math.floor((x - field.origin[0]) / field.dx);
    const row = Math.floor((z - field.origin[1]) / field.dz);
    if (column < 0 || column >= field.width || row < 0 || row >= field.height) return false;
    return !field.valid || Boolean(field.valid[row * field.width + column]);
  }

  function spawnWindParticle(field) {
    const makeParticle = (x, worldY, z, age, heightAboveGround) => ({
      x, worldY, z, spawnX: x, spawnY: worldY, spawnZ: z, age, heightAboveGround, u: 0, w: 0, v: 0,
      trail: Array.from({ length: windTrailPoints }, () => [x, worldY, z]),
    });
    if (windState.analysisMode === 'comfort' && field.valid) {
      const minX = field.origin[0], maxX = minX + field.width * field.dx;
      const minZ = field.origin[1], maxZ = minZ + field.height * field.dz;
      const heightAboveGround = Math.max(1.5, windState.cfdGroundHeight + 0.8);
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const x = minX + Math.random() * (maxX - minX);
        const z = minZ + Math.random() * (maxZ - minZ);
        const worldY = terrainHeightAt(x, z) + heightAboveGround;
        if (windFieldCellValid(field, x, z) && pointInLidarFootprint(x, z) && !windPointInsideBuilding(x, z, worldY)) {
          return makeParticle(x, worldY, z, Math.random() * 7, heightAboveGround);
        }
      }
      const x = clamp(0, minX, maxX), z = clamp(0, minZ, maxZ);
      return makeParticle(x, terrainHeightAt(x, z) + heightAboveGround, z, 0, heightAboveGround);
    }
    if (windState.dataMode === 'cfd' && windState.cfd) {
      // Seed across the user's flow box (like the old "draw a box, then
      // simulate" domain), not a fixed curtain over the whole ~2600 m solved
      // domain — that mostly seeded particles far upstream of the streets
      // anyone actually wanted to look at, so they read as a small,
      // disconnected patch of dashes rather than flow through the city.
      const groundFlowMode = windState.analysisMode === 'direction' && windState.cfdView === 'ground'
        && windState.cfdField === 'speed';
      const center = groundFlowMode ? windState.domainCenter : windState.center;
      const half = (groundFlowMode ? windState.domainSize : windState.size) / 2;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const x = center[0] + (Math.random() * 2 - 1) * half;
        const z = center[1] + (Math.random() * 2 - 1) * half;
        const groundY = terrainHeightAt(x, z);
        const heightAboveGround = groundFlowMode
          ? windState.cfdGroundHeight
          : windState.volumeVisible
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
    const particleAnimationMode = windState.analysisMode === 'direction'
      && windState.cfdView === 'flow' && windState.flowlinesVisible;
    const count = particleAnimationMode ? Math.round(clamp(windState.particleCount, 200, 1600)) : 0;
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
    const motionAllowed = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    windPoints.visible = motionAllowed && particleAnimationMode;
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
    if (windState.designGeometryDirty && windState.analysisMode === 'comfort') {
      windStatus.textContent = 'Annual comfort uses baseline directional cases. Use the quick single-direction estimate in Design to compare edited massing.';
      return;
    }
    if (windState.designGeometryDirty && windState.analysisMode === 'pollution') {
      windStatus.textContent = 'Pollution remains on baseline geometry. Design changes have a quick wind-speed estimate, not a pollutant-dispersion rerun.';
      return;
    }
    if (windState.analysisMode === 'comfort') {
      await runComfortStudy();
      return;
    }
    if (windState.analysisMode === 'pollution') {
      await runPollutantDispersal();
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

  let windCriteriaCatalog = null;
  async function loadWindCriteriaCatalog() {
    if (!windCriteriaCatalog) {
      const response = await fetch(`${windApi}/wind/criteria`);
      if (!response.ok) throw new Error(`wind criteria catalog HTTP ${response.status}`);
      windCriteriaCatalog = await response.json();
    }
    const criteria = windCriteriaCatalog.criteria || [];
    if (windComfortCriterion && criteria.length) {
      const selectedId = windComfortCriterion.value || windState.comfortCriterionId;
      windComfortCriterion.replaceChildren(...criteria.map(criterion => {
        const option = document.createElement('option');
        option.value = criterion.id;
        option.textContent = `${criterion.name} · v${criterion.version}${criterion.implemented ? '' : ' · unavailable'}`;
        option.disabled = !criterion.implemented;
        if (criterion.unavailable_reason) option.title = criterion.unavailable_reason;
        return option;
      }));
      windComfortCriterion.value = criteria.some(item => item.id === selectedId && item.implemented)
        ? selectedId : windCriteriaCatalog.default_criterion_id;
      windState.comfortCriterionId = windComfortCriterion.value;
    }
    const criterion = criteria.find(item => item.id === windState.comfortCriterionId);
    if (!criterion) throw new Error('selected wind comfort criterion is unavailable');
    if (windCriterionProvenance) {
      const source = criterion.source?.citation || 'No external source declared';
      const sourceUrl = criterion.source?.url ? ` Source: ${criterion.source.url}${criterion.source.location ? ` (${criterion.source.location})` : ''}.` : '';
      windCriterionProvenance.textContent = `${criterion.name} · v${criterion.version} · ${Number(criterion.exceedance_probability) * 100}% exceedance. ${criterion.wind_speed_basis} ${criterion.averaging_period} Gust treatment: ${criterion.gust_treatment} ${source}.${sourceUrl}`;
    }
    return criterion;
  }

  // Comfort as "weighted screening across 16 directions" only made sense
  // while every direction shared one fast proxy solver. Now that Direction
  // is OpenFOAM, Comfort weights whichever directions actually have a solved
  // case by their ERA5 wind-rose frequency and Weibull exceedance — the same
  // math server/field.py used, just summed over 1 term instead of 16. It
  // never interpolates or assumes calm for the missing sectors; it excludes
  // them, so the result is an honest lower bound, not a full annual study.
  async function runComfortStudy(reportRequestId = null) {
    if (windState.designGeometryDirty) {
      windStatus.textContent = 'This comfort study uses baseline directional cases. Solve proposed-geometry cases for multiple directions before comparing annual comfort.';
      return;
    }
    const revision = ++windStudyRevision;
    cancelRequests('wind');
    const announceStudy = (state, message = '') => dispatchEvent(new CustomEvent('climate-request-status', {
      detail: { tool: 'wind', key: 'comfort-compute', path: '/comfort-compute', state, message },
    }));
    announceStudy('loading');
    if (reportRequestId) dispatchEvent(new CustomEvent('climate-report-area-progress', {
      detail: { requestId: reportRequestId, tool: 'wind', message: 'Running the multi-direction wind comfort study…' },
    }));
    windSimulate.disabled = true;
    windSimulate.textContent = 'Weighting OpenFOAM sectors…';
    windStatus.textContent = 'Loading ERA5 sector frequencies…';
    try {
      const criterion = await loadWindCriteriaCatalog();
      const categories = criterion.categories;
      const comfortThresholds = categories.slice(0, -1).map(category => Number(category.max_speed_mps));
      const acceptedProbability = Number(criterion.exceedance_probability);
      const params = new URLSearchParams({ season: windState.season, stability: windState.stability });
      const response = await fetch(`${windApi}/wind/climatology/sectors?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const climatology = await response.json();
      checkWindRevision(revision);
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
      const resolution = 12;
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
      const exceedanceByThreshold = comfortThresholds.map(() => new Array(cellCount).fill(0));
      // Load and sample one case's volume at a time — every resolved
      // direction contributes its own weighted share to the same grid, never
      // interpolated with the others, only summed.
      for (const [sectorIndex, { cfdCase, sector }] of resolved.entries()) {
        windStatus.textContent = `Sampling ${cfdCase.label}…`;
        if (reportRequestId) dispatchEvent(new CustomEvent('climate-report-area-progress', {
          detail: { requestId: reportRequestId, tool: 'wind', message: `Running the comfort study · direction ${sectorIndex + 1} of ${resolved.length}…` },
        }));
        await ensureCfdCaseLoaded(cfdCase.direction_deg, revision, message => {
          windStatus.textContent = message;
          if (reportRequestId) dispatchEvent(new CustomEvent('climate-report-area-progress', {
            detail: { requestId: reportRequestId, tool: 'wind', message },
          }));
        });
        checkWindRevision(revision);
        for (let row = 0; row < height; row += 1) {
          if (row % 8 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            checkWindRevision(revision);
            if (reportRequestId) dispatchEvent(new CustomEvent('climate-report-area-progress', {
              detail: { requestId: reportRequestId, tool: 'wind', message: `Sampling the comfort map · direction ${sectorIndex + 1} of ${resolved.length} · ${Math.round((row + 1) / height * 100)}%…` },
            }));
          }
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
            comfortThresholds.forEach((threshold, thresholdIndex) => {
              exceedanceByThreshold[thresholdIndex][index]
                += weibullExceedance(sample.speed, threshold, sector.weibull_shape) * sector.frequency_fraction;
            });
          }
        }
      }
      const uncomfortableCode = Number(categories.at(-1).code);
      const comfortCategory = new Array(cellCount).fill(uncomfortableCode);
      for (let index = 0; index < cellCount; index += 1) {
        if (!valid[index]) continue;
        for (let thresholdIndex = 0; thresholdIndex < comfortThresholds.length; thresholdIndex += 1) {
          if (exceedanceByThreshold[thresholdIndex][index] <= acceptedProbability) {
            comfortCategory[index] = Number(categories[thresholdIndex].code);
            break;
          }
        }
      }
      // The second activity threshold is the representative exceedance shown
      // in the compact report summary; the map retains every criterion class.
      const representativeIndex = Math.min(1, comfortThresholds.length - 1);
      windState.field = {
        analysis_mode: 'comfort',
        cfd: true,
        version: 'cfd-comfort-v1',
        validation_status: windState.cfd?.manifest.validation_status || 'exploratory_unvalidated_pilot',
        comfort_standard: `${criterion.name} v${criterion.version}`,
        comfort_criterion: criterion,
        season: windState.season,
        stability: windState.stability,
        height_m: windState.cfdGroundHeight,
        origin: [originX, originZ], width, height, dx, dz,
        speed, u, v, valid, comfort_category: comfortCategory,
        comfort_categories: categories,
        exceedance: { threshold_mps: comfortThresholds[representativeIndex], probability: exceedanceByThreshold[representativeIndex] },
        uncertainty: { relative_fraction: 0.35 },
        direction_count: resolved.length,
        coverage_fraction: coverage,
        forcing_coverage: climatology.coverage || null,
        forcing_dataset_version: climatology.dataset_version || null,
      };
      windState.field.wind_rankings = await rankWindLocations(windState.field, () => revision !== windStudyRevision);
      if (revision !== windStudyRevision) return;
      const sectorList = resolved.map(entry => entry.sector.sector.toUpperCase()).join(', ');
      windStatus.textContent = `OpenFOAM comfort · ${resolved.length}/16 sectors resolved (${sectorList}) · `
        + `${(coverage * 100).toFixed(1)}% of ${windState.season} wind hours covered · lower-bound estimate, `
        + `unsolved directions excluded.`;
    } catch (error) {
      if (revision !== windStudyRevision) {
        windSimulate.disabled = false;
        windSimulate.textContent = 'Run comfort assessment';
        announceStudy('error', 'Wind settings changed or study cancelled. Run again for the current settings.');
        return;
      }
      windState.field = null;
      windStatus.textContent = `Comfort study unavailable (${error.message})`;
    }
    announceStudy(windState.field ? 'ready' : 'error', windState.field ? '' : windStatus.textContent);
    windSimulate.disabled = false;
    windSimulate.textContent = 'Run comfort assessment';
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
    resetWindParticles();
    dispatchEvent(new CustomEvent('climate-wind-result', { detail: windState.field }));
    buildWindHeatmap();
    requestRender();
  }

  function reportViewshedPoint(bounds) {
    const center = bounds.center || { x: (bounds.min_x + bounds.max_x) / 2, z: (bounds.min_z + bounds.max_z) / 2 };
    let nearest = null;
    let nearestDistance = Infinity;
    for (let z = bounds.min_z + 10; z < bounds.max_z; z += 20) {
      for (let x = bounds.min_x + 10; x < bounds.max_x; x += 20) {
        if (!terrainValidAt(x, z)) continue;
        const ground = terrainSurfaceHeightAt(x, z);
        const eye = ground + viewshedState.eyeHeight;
        const obstructed = viewshedBuildingsAt(x, z).some(building => eye >= building.ground && eye < building.top);
        if (obstructed) continue;
        const distance = (x - center.x) ** 2 + (z - center.z) ** 2;
        if (distance < nearestDistance) { nearest = { x, z }; nearestDistance = distance; }
      }
    }
    return nearest;
  }

  function calculateReportViewshed(bounds) {
    const observer = reportViewshedPoint(bounds);
    if (!observer) throw new Error('No open mapped observer position was found inside this square.');
    viewshedState.active = false;
    viewshedState.pickMode = false;
    viewshedState.shape = 'full';
    viewshedState.radius = Math.min(1200, Math.max(150, bounds.size_m / Math.sqrt(2)));
    if (viewshedShape) viewshedShape.value = 'full';
    if (viewshedRadius) viewshedRadius.value = String(Math.round(viewshedState.radius / 50) * 50);
    if (viewshedRadiusValue) viewshedRadiusValue.textContent = `${Math.round(viewshedState.radius)} m`;
    let metadata = null;
    const captureResult = event => {
      if (event.detail?.tool === 'viewshed') metadata = event.detail.metadata;
    };
    addEventListener('climate-analysis-result', captureResult);
    try {
      if (!buildViewshed(observer.x, observer.z, { kind: 'terrain' }, bounds) || !metadata) {
        throw new Error(viewshedStatus?.textContent || 'Viewshed could not be calculated in this square.');
      }
    } finally {
      removeEventListener('climate-analysis-result', captureResult);
    }
    return {
      description: `${Number(metadata.visible_ground_pct).toFixed(1)}% of sampled ground inside the square is visible from an open point near its centre.`,
      observer_label: 'Open ground near the square centre',
      kpis: {
        visible_ground_pct: metadata.visible_ground_pct,
        hidden_ground_pct: 100 - metadata.visible_ground_pct,
        visible_samples: metadata.visible_samples,
        sampled_ground_count: metadata.sampled_ground_count,
        viewing_distance_m: viewshedState.radius,
        observer_height_m: viewshedState.eyeHeight,
      },
      method: 'Mapped terrain and building massing; visibility samples and the chart are limited to ground locations inside the selected square. Trees and small unmapped objects are not visibility blockers.',
    };
  }

  async function calculateReportDirectionalWind(bounds, requestId, revision, height, directionOverride = null) {
    const previous = { cfd: windState.cfd, dataMode: windState.dataMode, loadedCfdCase: windState.loadedCfdCase };
    const requestedDirection = Number(directionOverride ?? windState.direction);
    const direction = Number.isFinite(requestedDirection) ? requestedDirection : 135;
    const cfdCase = findCfdCase(direction);
    if (!cfdCase) throw new Error(`No solved OpenFOAM case is available for ${direction}°.`);
    try {
      dispatchEvent(new CustomEvent('climate-report-area-progress', {
        detail: { requestId, tool: 'wind', message: `Preparing the ${cfdCase.label} direction-specific wind study…` },
      }));
      let criterion = null;
      try { criterion = await loadWindCriteriaCatalog(); } catch { /* Use the built-in default guide if the catalog is unavailable. */ }
      if (!criterion?.categories?.length) {
        if (windState.comfortCriterionId !== 'lawson_lddc_style_screening_v1') {
          throw new Error('The selected wind comfort guide could not be loaded for the fallback map.');
        }
        criterion = {
          name: 'Lawson LDDC screening guide', version: '1', exceedance_probability: 0.05,
          categories: [
            { code: 0, key: 'long_sitting', label: 'Long sitting', max_speed_mps: 2.5 },
            { code: 1, key: 'short_sitting', label: 'Short sitting', max_speed_mps: 4 },
            { code: 2, key: 'standing', label: 'Standing', max_speed_mps: 6 },
            { code: 3, key: 'strolling', label: 'Strolling', max_speed_mps: 8 },
            { code: 4, key: 'business_walking', label: 'Business walking', max_speed_mps: 10 },
            { code: 5, key: 'uncomfortable', label: 'Uncomfortable', max_speed_mps: null },
          ],
        };
      }
      let shape = ({ unstable: 1.7, neutral: 2.0, stable: 2.5 })[windState.stability] || 2.0;
      try {
        const params = new URLSearchParams({ season: windState.season, stability: windState.stability });
        const response = await fetch(`${windApi}/wind/climatology/sectors?${params}`);
        if (response.ok) {
          const sectors = (await response.json()).sectors || [];
          const sector = sectors.reduce((best, item) => {
            const delta = Math.abs(((Number(item.direction_deg) - direction + 540) % 360) - 180);
            return !best || delta < best.delta ? { item, delta } : best;
          }, null)?.item;
          if (Number.isFinite(Number(sector?.weibull_shape))) shape = Number(sector.weibull_shape);
        }
      } catch { /* The selected stability profile supplies a fallback shape. */ }
      const existingDirection = Number(previous.cfd?.manifest?.direction_deg_from);
      if (!previous.cfd || Math.abs(existingDirection - direction) > 0.01) {
        const loaded = await ensureCfdCaseLoaded(cfdCase, revision, message => dispatchEvent(new CustomEvent('climate-report-area-progress', {
          detail: { requestId, tool: 'wind', message },
        })));
        windState.loadedCfdCase = loaded;
      }
      checkWindRevision(revision);
      const columns = Math.max(1, Math.ceil(bounds.size_m / 12)), rows = columns;
      const dx = bounds.size_m / columns, dz = bounds.size_m / rows, cellCount = columns * rows;
      const speed = new Array(cellCount).fill(0);
      const comfortCategory = new Array(cellCount).fill(Number(criterion.categories.at(-1).code));
      const valid = new Uint8Array(cellCount), thresholds = criterion.categories.slice(0, -1);
      for (let row = 0; row < rows; row += 1) {
        if (row % 8 === 0) {
          await buildWindUiYield();
          checkWindRevision(revision);
          dispatchEvent(new CustomEvent('climate-report-area-progress', {
            detail: { requestId, tool: 'wind', message: `Sampling the available wind direction · ${Math.round((row + 1) / rows * 100)}%` },
          }));
        }
        for (let column = 0; column < columns; column += 1) {
          const index = row * columns + column;
          const x = bounds.min_x + (column + 0.5) * dx, z = bounds.min_z + (row + 0.5) * dz;
          if (!pointInLidarFootprint(x, z) || windPointInsideBuilding(x, z, terrainHeightAt(x, z) + height)) continue;
          const sample = sampleCfd(x, terrainHeightAt(x, z) + height, z);
          if (!sample || !Number.isFinite(sample.speed) || sample.speed < 0) continue;
          speed[index] = sample.speed;
          valid[index] = 1;
          for (const category of thresholds) {
            if (weibullExceedance(sample.speed, Number(category.max_speed_mps), shape) <= Number(criterion.exceedance_probability)) {
              comfortCategory[index] = Number(category.code);
              break;
            }
          }
        }
      }
      if (!valid.some(Boolean)) throw new Error('No solved wind cells overlap this square.');
      return {
        origin: [bounds.min_x, bounds.min_z], width: columns, height: rows, dx, dz,
        speed, comfort_category: comfortCategory, valid, comfort_categories: criterion.categories,
        comfort_standard: `${criterion.name} v${criterion.version}`, comfort_criterion: criterion,
        analysis_mode: 'comfort', direction_deg: direction, direction_count: 1,
        season: windState.season, stability: windState.stability, height_m: height,
        model_kind: 'OpenFOAM single-direction comfort screen',
        validation_status: previous.cfd?.manifest?.validation_status || 'exploratory_unvalidated_pilot',
      };
    } finally {
      windState.cfd = previous.cfd;
      windState.dataMode = previous.dataMode;
      windState.loadedCfdCase = previous.loadedCfdCase;
    }
  }

  async function calculateReportWind(bounds, requestId, directionDegrees = null) {
    let revision = windStudyRevision;
    if (windState.designGeometryDirty) throw new Error('The wind comfort screen uses baseline building geometry; reset the proposed building changes before including it in this report.');
    const directionalStudy = directionDegrees !== null;
    const directionCase = directionalStudy ? findCfdCase(Number(directionDegrees)) : null;
    if (directionalStudy && !directionCase) throw new Error(`No solved OpenFOAM case is available for ${directionDegrees}°.`);
    dispatchEvent(new CustomEvent('climate-report-area-progress', {
      detail: { requestId, tool: 'wind', message: directionalStudy
        ? `Running the ${directionCase.label} direction-specific wind study…`
        : 'Running the multi-direction wind comfort study…' },
    }));
    const height = Math.min(10, Math.max(1, Number(windState.cfdGroundHeight) || 2));
    let field = null, resultSource = directionalStudy ? 'directional-study' : 'report-comfort-study';
    if (directionalStudy) {
      field = await calculateReportDirectionalWind(bounds, requestId, revision, height, Number(directionDegrees));
    } else {
      const currentComfort = windState.field?.analysis_mode === 'comfort'
        && windState.field.season === windState.season
        && windState.field.comfort_criterion?.id === windState.comfortCriterionId
        && (!windState.field.stability || windState.field.stability === windState.stability)
        && Math.abs(Number(windState.field.height_m) - height) < 0.01;
      if (currentComfort) {
        field = windState.field;
        resultSource = 'existing-comfort-study';
      } else {
        try {
          const revisionBeforeStudy = windStudyRevision;
          await runComfortStudy(requestId);
          revision = windStudyRevision;
          if (revision !== revisionBeforeStudy + 1) throw new DOMException('Wind settings changed; run again.', 'AbortError');
          field = windState.field;
          const matchesStudySettings = field?.analysis_mode === 'comfort'
            && field.season === windState.season
            && field.comfort_criterion?.id === windState.comfortCriterionId
            && field.stability === windState.stability
            && Math.abs(Number(field.height_m) - height) < 0.01;
          if (!matchesStudySettings) throw new Error('The multi-direction wind comfort study could not be completed.');
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          revision = windStudyRevision;
          field = await calculateReportDirectionalWind(bounds, requestId, revision, height);
          resultSource = 'single-direction-fallback';
        }
      }
    }
    checkWindRevision(revision);
    const categories = field.comfort_categories || [];
    if (!categories.length || !Array.isArray(field.comfort_category) || !Array.isArray(field.speed)) {
      throw new Error('The wind comfort study returned an incomplete map.');
    }
    const columns = Number(field.width), rows = Number(field.height);
    const origin = field.origin || [bounds.min_x, bounds.min_z];
    const dx = Number(field.dx), dz = Number(field.dz);
    if (!columns || !rows || !(dx > 0) || !(dz > 0)) throw new Error('The wind comfort map grid could not be read.');
    const speedScale = resultSource !== 'single-direction-fallback' && Number(field.coverage_fraction) > 0
      ? 1 / Number(field.coverage_fraction) : 1;
    const available = new Uint8Array(columns * rows);
    const cells = [];
    const values = [];
    const categoryCounts = new Map(categories.map(category => [Number(category.code), 0]));
    for (let row = 0; row < rows; row += 1) {
      if (row % 8 === 0) {
        await buildWindUiYield();
        checkWindRevision(revision);
      }
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const x = origin[0] + (column + 0.5) * dx;
        const z = origin[1] + (row + 0.5) * dz;
        if (!pointInLidarFootprint(x, z) || windPointInsideBuilding(x, z, terrainHeightAt(x, z) + height)) continue;
        const speed = Number(field.speed[index]) * speedScale;
        const categoryCode = Number(field.comfort_category[index]);
        if (!Number.isFinite(speed) || !Number.isFinite(categoryCode)) continue;
        available[index] = 1;
        values.push(speed);
        categoryCounts.set(categoryCode, (categoryCounts.get(categoryCode) || 0) + 1);
        cells.push({ x, z, size_m: Math.min(dx, dz), speed_mps: speed, category_code: categoryCode });
      }
    }
    if (!cells.length) throw new Error('No valid wind comfort locations overlap this square.');
    const comfortAt = (x, z) => {
      const column = Math.floor((x - origin[0]) / dx), row = Math.floor((z - origin[1]) / dz);
      if (column < 0 || row < 0 || column >= columns || row >= rows) return null;
      const index = row * columns + column;
      if (!available[index]) return null;
      return { speed: Number(field.speed[index]) * speedScale, category: Number(field.comfort_category[index]) };
    };
    const streetTotals = new Map(), streetPaths = [];
    const clipSegment = (first, second) => {
      const x1 = first[0], z1 = first[1], deltaX = second[0] - x1, deltaZ = second[1] - z1;
      let start = 0, end = 1;
      const p = [-deltaX, deltaX, -deltaZ, deltaZ];
      const q = [x1 - bounds.min_x, bounds.max_x - x1, z1 - bounds.min_z, bounds.max_z - z1];
      for (let edge = 0; edge < 4; edge += 1) {
        if (Math.abs(p[edge]) < 1e-9) { if (q[edge] < 0) return null; continue; }
        const ratio = q[edge] / p[edge];
        if (p[edge] < 0) { if (ratio > end) return null; start = Math.max(start, ratio); }
        else { if (ratio < start) return null; end = Math.min(end, ratio); }
      }
      return [[x1 + start * deltaX, z1 + start * deltaZ], [x1 + end * deltaX, z1 + end * deltaZ]];
    };
    for (const road of data.roads || []) {
      const name = String(road?.[3]?.name || '').trim(), points = road?.[2];
      if (!name || !Array.isArray(points) || points.length < 2) continue;
      for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
        const segment = clipSegment(points[pointIndex - 1], points[pointIndex]);
        if (!segment) continue;
        const [first, second] = segment;
        const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
        if (!(length > 0)) continue;
        streetPaths.push({ name, points: [first, second], length_m: length });
        const steps = Math.max(1, Math.ceil(length / 12)), sampleWeight = length / steps;
        let totals = streetTotals.get(name);
        if (!totals) streetTotals.set(name, totals = { name, length: 0, speedTotal: 0, categoryTotal: 0, categories: new Map() });
        for (let step = 0; step < steps; step += 1) {
          const fraction = (step + 0.5) / steps;
          const sample = comfortAt(first[0] + (second[0] - first[0]) * fraction, first[1] + (second[1] - first[1]) * fraction);
          if (!sample) continue;
          totals.length += sampleWeight;
          totals.speedTotal += sample.speed * sampleWeight;
          totals.categoryTotal += sample.category * sampleWeight;
          totals.categories.set(sample.category, (totals.categories.get(sample.category) || 0) + sampleWeight);
        }
      }
    }
    const rankedStreets = [...streetTotals.values()].filter(item => item.length >= 18).map(item => {
      const mostCommon = [...item.categories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const category = categories.find(entry => Number(entry.code) === Number(mostCommon));
      return {
        name: item.name, mean_speed_mps: item.speedTotal / item.length,
        comfort_score: item.categoryTotal / item.length, dominant_category: category?.label || 'Unclassified',
        sampled_length_m: item.length,
      };
    });
    const bestStreets = [...rankedStreets].sort((a, b) => a.comfort_score - b.comfort_score || a.mean_speed_mps - b.mean_speed_mps).slice(0, 3);
    const worstStreets = [...rankedStreets].sort((a, b) => b.comfort_score - a.comfort_score || b.mean_speed_mps - a.mean_speed_mps).slice(0, 3);
    const sorted = [...values].sort((a, b) => a - b);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const classShares = Object.fromEntries(categories.map(category => {
      const count = categoryCounts.get(Number(category.code)) || 0;
      return [String(category.key || category.label || category.code).toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, ''), count / cells.length * 100];
    }));
    const dominantCode = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const dominantCategory = categories.find(category => Number(category.code) === Number(dominantCode));
    const colorByCode = ['#287f69', '#55aa70', '#a8c84c', '#e5bd3f', '#df8039', '#c7473f'];
    const method = resultSource === 'single-direction-fallback'
      ? `The multi-direction comfort study could not be completed, so this map uses one solved ${Math.round(Number(field.direction_deg) || Number(windState.direction))}° wind direction and the selected comfort guide. Treat it as a directional screen rather than a seasonal comfort result.`
      : resultSource === 'directional-study'
        ? `This map shows the solved ${directionCase.label} OpenFOAM wind field at ${height.toFixed(1)} m above ground, sampled inside the selected square and grouped by the selected comfort guide. It is a single-direction planning screen, not a seasonal average or a certified wind-safety assessment.`
      : resultSource === 'existing-comfort-study'
        ? 'This map reuses the current multi-direction comfort result shown in the explorer, clipped to the selected square. It remains an exploratory screen, not a street measurement or a certified wind-safety assessment.'
        : `This report ran the multi-direction wind comfort study and clipped its map to the selected square. It combines ${Number(field.direction_count) || 16} solved compass directions using seasonal ERA5 wind patterns (${(Number(field.coverage_fraction || 0) * 100).toFixed(1)}% of seasonal wind hours represented). Unsolved directions are excluded, so where coverage is partial this is a lower-bound planning estimate, not a street measurement or a certified wind-safety assessment.`;
    const result = {
      description: `${directionalStudy ? `${directionCase.label} wind` : 'The wind comfort map'} shows ${dominantCategory?.label || 'the mapped comfort categories'} most often across this square. The best and most exposed named streets are listed below.`,
      result_source: resultSource,
      direction_count: Number(field.direction_count) || 16,
      season: field.season || windState.season,
      comfort_standard: field.comfort_standard || categories[0]?.label || 'Selected wind comfort guide',
      comfort_categories: categories.map(category => ({
        code: Number(category.code), key: category.key, label: category.label,
        color: colorByCode[Number(category.code)] || '#c7473f',
      })),
      cells,
      street_paths: streetPaths,
      street_rankings: { best: bestStreets, worst: worstStreets },
      height_m: height,
      model_kind: field.model_kind || 'wind comfort screening model',
      validation_status: field.validation_status || 'exploratory_not_engineering_grade',
      grid: { resolution_m: Math.min(dx, dz), columns, rows },
      speed_values_mps: values,
      kpis: {
        mean_speed_mps: average,
        p95_speed_mps: sorted[Math.floor((sorted.length - 1) * 0.95)],
        maximum_speed_mps: sorted.at(-1),
        sampled_cell_count: cells.length,
        total_cell_count: columns * rows,
        grid_coverage_pct: cells.length / (columns * rows) * 100,
        direction_count: Number(field.direction_count) || 16,
        comfort_class_share_pct: classShares,
        sampling_height_m: height,
      },
      method,
    };
    if (!directionalStudy) {
      result.directional_studies = [];
      for (const study of [
        { key: 'se', label: 'Southeast (SE)', direction_deg: 135 },
        { key: 'nw', label: 'Northwest (NW)', direction_deg: 315 },
      ]) {
        try {
          const directionalResult = await calculateReportWind(bounds, requestId, study.direction_deg);
          result.directional_studies.push({ ...directionalResult, ...study, status: 'ready' });
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          result.directional_studies.push({ ...study, status: 'unavailable', message: error.message || `${study.label} wind study unavailable.` });
        }
      }
    }
    return result;
  }

  addEventListener('climate-report-area-analysis-request', async event => {
    const { requestId, bounds } = event.detail || {};
    if (!requestId || !bounds) return;
    const results = {};
    for (const tool of ['viewshed', 'wind']) {
      dispatchEvent(new CustomEvent('climate-report-area-progress', {
        detail: { requestId, tool, message: tool === 'viewshed' ? 'Calculating visibility inside the square…' : 'Preparing the wind comfort map…' },
      }));
      try {
        results[tool] = { status: 'ready', ...(tool === 'viewshed'
          ? calculateReportViewshed(bounds)
          : await calculateReportWind(bounds, requestId)) };
      } catch (error) {
        results[tool] = { status: 'unavailable', message: error.message || `${tool} analysis unavailable.` };
      }
    }
    dispatchEvent(new CustomEvent('climate-report-area-analysis-result', { detail: { requestId, results } }));
  });

  function updateWindParticles(now) {
    if (!windState.enabled || !windState.field || !windPoints?.visible) return;
    const elapsed = Math.min(0.06, (now - windState.lastTime) / 1000) * windState.animationSpeed;
    windState.lastTime = now;
    const half = windState.size * 0.5;
    const positions = windPoints.geometry.attributes.position.array;
    const colors = windPoints.geometry.attributes.color.array;
    const fieldSpeeds = windState.field.speed || [];
    const comfortMode = windState.analysisMode === 'comfort' && windState.field.analysis_mode === 'comfort';
    const directionSurfaceMode = windState.analysisMode === 'direction' && windState.cfdView === 'ground'
      && windState.cfdField === 'speed';
    const minimumSpeed = fieldSpeeds.length ? Math.min(...fieldSpeeds) : 0;
    const maximumSpeed = Math.max(...fieldSpeeds, windState.speed, 0.1) * (windState.volumeVisible ? 1.8 : 1);
    windState.particles.forEach((particle, index) => {
      const cfdMode = !comfortMode && windState.dataMode === 'cfd' && windState.cfd;
      const worldY = cfdMode ? particle.worldY : terrainHeightAt(particle.x, particle.z) + particle.heightAboveGround;
      const target = redirectWindFlow(
        particle.x, particle.z,
        comfortMode ? sampleWind(particle.x, particle.z) : sampleWindAtHeight(particle.x, particle.z, particle.heightAboveGround, worldY),
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
      const outsideDomain = comfortMode
        ? !windFieldCellValid(windState.field, nextX, nextZ)
          || !pointInLidarFootprint(nextX, nextZ)
          || Math.abs(nextX - windState.field.origin[0]) > windState.field.width * windState.field.dx
          || Math.abs(nextZ - windState.field.origin[1]) > windState.field.height * windState.field.dz
        : cfdMode
        ? !sampleCfd(nextX, nextY, nextZ)
          || (!directionSurfaceMode && (Math.abs(nextX - windState.center[0]) > half + 60
            || Math.abs(nextZ - windState.center[1]) > half + 60))
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
        comfortMode ? sampleWind(particle.x, particle.z) : sampleWindAtHeight(particle.x, particle.z, particle.heightAboveGround, respawnWorldY),
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
        const segmentSample = comfortMode ? sampleWind(headX, headZ)
          : cfdMode ? sampleCfd(headX, headY, headZ) : sampleWindAtHeight(headX, headZ, particle.heightAboveGround);
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

  function reportSquareFromDrag(start, current) {
    const maximum = Math.min(1200, right - left, maxZ - minZ);
    if (!(maximum >= 100)) return null;
    const size = clamp(Math.max(Math.abs(current.x - start.x), Math.abs(current.z - start.z)), 100, maximum);
    const directionX = current.x < start.x ? -1 : 1;
    const directionZ = current.z < start.z ? -1 : 1;
    const centerX = clamp(start.x + directionX * size / 2, left + size / 2, right - size / 2);
    const centerZ = clamp(start.z + directionZ * size / 2, minZ + size / 2, maxZ - size / 2);
    return { min_x: centerX - size / 2, min_z: centerZ - size / 2,
      max_x: centerX + size / 2, max_z: centerZ + size / 2, size_m: size,
      center: { x: centerX, z: centerZ } };
  }

  function reportAreaCorners(bounds) {
    return [
      [bounds.min_x, bounds.min_z], [bounds.max_x, bounds.min_z],
      [bounds.max_x, bounds.max_z], [bounds.min_x, bounds.max_z],
    ];
  }

  function updateReportAreaHandles(bounds) {
    const visible = Boolean(bounds) && !reportAreaLocked;
    reportAreaHandles.visible = visible;
    if (!visible) return;
    const [x, z] = reportAreaCorners(bounds)[reportAreaHandleCornerIndex];
    const groundY = terrainSurfaceHeightAt(x, z);
    const distance = camera.position.distanceTo(new THREE.Vector3(x, groundY, z));
    const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      / Math.max(canvas.clientHeight, 1);
    const radius = worldPerPixel * 7;
    reportAreaHandle.position.set(x, groundY + radius, z);
    reportAreaHandle.scale.setScalar(radius);
  }

  function reportSquareFromResize(anchor, current) {
    const directionX = current.x < anchor.x ? -1 : 1;
    const directionZ = current.z < anchor.z ? -1 : 1;
    const maximum = Math.min(1200,
      directionX > 0 ? right - anchor.x : anchor.x - left,
      directionZ > 0 ? maxZ - anchor.z : anchor.z - minZ);
    if (maximum < 100) return null;
    const size = clamp(Math.max(Math.abs(current.x - anchor.x), Math.abs(current.z - anchor.z)), 100, maximum);
    const endX = anchor.x + directionX * size, endZ = anchor.z + directionZ * size;
    const minX = Math.min(anchor.x, endX), maxX = Math.max(anchor.x, endX);
    const minZ = Math.min(anchor.z, endZ), maxZValue = Math.max(anchor.z, endZ);
    return {
      min_x: minX, min_z: minZ, max_x: maxX, max_z: maxZValue, size_m: size,
      center: { x: (minX + maxX) / 2, z: (minZ + maxZValue) / 2 },
    };
  }

  function reportSquareFromMove(start, current, original) {
    const half = original.size_m / 2;
    const centerX = clamp(original.center.x + current.x - start.x, left + half, right - half);
    const centerZ = clamp(original.center.z + current.z - start.z, minZ + half, maxZ - half);
    return {
      min_x: centerX - half, min_z: centerZ - half,
      max_x: centerX + half, max_z: centerZ + half,
      size_m: original.size_m, center: { x: centerX, z: centerZ },
    };
  }

  function reportAreaScreenPoint(x, z) {
    const projected = new THREE.Vector3(x, terrainSurfaceHeightAt(x, z) + 1.8, z).project(camera);
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height };
  }

  function chooseReportAreaHandleCorner(bounds) {
    const viewport = canvas.getBoundingClientRect();
    const visible = { left: viewport.left + 14, top: viewport.top + 14,
      right: viewport.right - 14, bottom: viewport.bottom - 14 };
    const panel = document.querySelector('.panel')?.getBoundingClientRect();
    if (panel) {
      const overlap = Math.min(viewport.bottom, panel.bottom) - Math.max(viewport.top, panel.top);
      const panelIsSideSheet = overlap > viewport.height * 0.6;
      if (panelIsSideSheet && panel.left >= (viewport.left + viewport.right) / 2) {
        visible.right = Math.min(visible.right, panel.left - 14);
      } else if (panelIsSideSheet && panel.right <= (viewport.left + viewport.right) / 2) {
        visible.left = Math.max(visible.left, panel.right + 14);
      }
    }
    const center = { x: (visible.left + visible.right) / 2, y: (visible.top + visible.bottom) / 2 };
    let bestIndex = 0, bestScore = Infinity;
    reportAreaCorners(bounds).forEach(([x, z], index) => {
      const point = reportAreaScreenPoint(x, z);
      const outsideX = Math.max(visible.left - point.x, 0, point.x - visible.right);
      const outsideY = Math.max(visible.top - point.y, 0, point.y - visible.bottom);
      const centerDistance = Math.hypot(point.x - center.x, point.y - center.y);
      const score = Math.hypot(outsideX, outsideY) * 100 + centerDistance;
      if (score < bestScore) { bestIndex = index; bestScore = score; }
    });
    return bestIndex;
  }

  function reportAreaGroundPoint(event, bounds, flat = false) {
    if (!flat) {
      const point = pointerGround(event);
      if (point || !bounds?.center) return point;
    }
    if (!bounds?.center) return null;
    const groundY = terrainSurfaceHeightAt(bounds.center.x, bounds.center.z);
    const fallbackPoint = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY);
    return pointerRaycaster(event).ray.intersectPlane(plane, fallbackPoint) ? fallbackPoint : null;
  }

  function reportAreaInteractionAt(event) {
    if (!reportAreaBounds || reportAreaLocked) return null;
    const corners = reportAreaCorners(reportAreaBounds).map(([x, z]) => reportAreaScreenPoint(x, z));
    const cornerTolerance = event.pointerType === 'touch' ? 32 : 20;
    const handleScreen = corners[reportAreaHandleCornerIndex];
    if (Math.hypot(event.clientX - handleScreen.x, event.clientY - handleScreen.y) <= cornerTolerance) {
      const opposite = reportAreaCorners(reportAreaBounds)[(reportAreaHandleCornerIndex + 2) % 4];
      const anchor = { x: opposite[0], z: opposite[1] };
      const anchorScreen = corners[(reportAreaHandleCornerIndex + 2) % 4];
      const dx = handleScreen.x - anchorScreen.x, dy = handleScreen.y - anchorScreen.y;
      return { mode: 'resize-corner', anchor, cursor: dx * dy >= 0 ? 'nwse-resize' : 'nesw-resize' };
    }
    const point = reportAreaGroundPoint(event, reportAreaBounds);
    return pointInReportArea(point, reportAreaBounds) ? { mode: 'move', cursor: 'move' } : null;
  }

  function pointInReportArea(point, bounds) {
    return Boolean(point && bounds && point.x >= bounds.min_x && point.x <= bounds.max_x
      && point.z >= bounds.min_z && point.z <= bounds.max_z);
  }

  function updateReportAreaOutline(bounds) {
    if (!bounds) {
      reportAreaOutline.visible = false;
      updateReportAreaHandles(null);
      return;
    }
    const corners = reportAreaCorners(bounds);
    reportAreaOutline.geometry.dispose();
    reportAreaOutline.geometry = new THREE.BufferGeometry().setFromPoints(corners.map(([x, z]) =>
      new THREE.Vector3(x, terrainSurfaceHeightAt(x, z) + 1.8, z)));
    reportAreaOutline.visible = true;
    updateReportAreaHandles(bounds);
    requestRender();
  }

  addEventListener('climate-report-area-pick', event => {
    reportAreaPickMode = !reportAreaLocked && Boolean(event.detail?.enabled);
    reportAreaDrag = null;
    if (reportAreaPickMode) {
      requestGroundPick(null);
      streetViewState.placing = false;
      sunDrag = null;
      windDrag = null;
      sliceDrag = null;
      clickCandidate = null;
      drag = null;
      canvas.style.cursor = 'crosshair';
    } else if (!placeInspectorPickMode && !groundPickHandler) canvas.style.cursor = '';
  });
  addEventListener('climate-report-area-clear', () => {
    reportAreaBounds = null;
    updateReportAreaOutline(null);
  });
  addEventListener('climate-report-area-lock', () => {
    reportAreaLocked = true;
    reportAreaPickMode = false;
    reportAreaDrag = null;
    canvas.style.cursor = '';
    updateReportAreaOutline(reportAreaBounds);
  });
  addEventListener('climate-report-area-unlock', () => {
    reportAreaLocked = false;
    updateReportAreaOutline(reportAreaBounds);
  });

  function pointerRaycaster(event) {
    const rect = canvas.getBoundingClientRect();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ), camera);
    return raycaster;
  }

  function pointerViewshedBuilding(event) {
    if (!layerGroups.buildings.visible) return null;
    const hit = pointerRaycaster(event).intersectObjects(layerGroups.buildings.children, true)
      .find(candidate => candidate.object.isMesh && candidate.face && Number.isFinite(candidate.point.y));
    if (!hit) return null;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    const normal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    const roof = normal.y > 0.55;
    return {
      kind: 'building',
      x: hit.point.x,
      y: hit.point.y,
      z: hit.point.z,
      roof,
      normal: [normal.x, normal.y, normal.z],
    };
  }

  function requestGroundPick(handler) {
    groundPickHandler = handler;
    canvas.style.cursor = handler || windInspectToggle?.getAttribute('aria-pressed') === 'true' ? 'crosshair' : '';
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

  function beginCameraTouchGesture() {
    if (cameraTouchPointers.size < 2) {
      cameraTouchGesture = null;
      return;
    }
    const points = [...cameraTouchPointers.values()].slice(0, 2);
    cameraTouchGesture = {
      centerX: (points[0].x + points[1].x) * 0.5,
      centerY: (points[0].y + points[1].y) * 0.5,
      spacing: Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)),
      distance: cameraState.distance,
      azimuth: cameraState.azimuth,
      target: cameraState.target.clone(),
    };
    drag = null;
    clickCandidate = null;
  }

  canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', event => {
    cameraIntro = null;
    if (event.button === 0 && !reportAreaLocked) {
      let point = reportAreaPickMode ? pointerGround(event) : null;
      if (reportAreaPickMode && !point) return;
      let mode = null, anchor = null, cursor = '', worldOffset = null;
      if (point && reportAreaPickMode) {
        mode = 'draw';
      } else if (reportAreaBounds) {
        const interaction = reportAreaInteractionAt(event);
        if (interaction) {
          point = reportAreaGroundPoint(event, reportAreaBounds, true);
          if (point) {
            mode = interaction.mode;
            anchor = interaction.anchor || null;
            cursor = interaction.cursor || '';
            if (mode === 'resize-corner') {
              const [handleX, handleZ] = reportAreaCorners(reportAreaBounds)[reportAreaHandleCornerIndex];
              worldOffset = { x: handleX - point.x, z: handleZ - point.z };
              point = { x: handleX, y: point.y, z: handleZ };
            }
          }
        }
      }
      if (mode) {
        if (!point) return;
        reportAreaDrag = {
          mode, anchor, worldOffset, pointerId: event.pointerId,
          start: { x: point.x, z: point.z }, current: { x: point.x, z: point.z },
          initialBounds: reportAreaBounds ? { ...reportAreaBounds, center: { ...reportAreaBounds.center } } : null,
          previewBounds: null, screenStart: [event.clientX, event.clientY],
        };
        clickCandidate = null;
        drag = null;
        canvas.style.cursor = cursor || (mode === 'draw' ? 'crosshair' : 'move');
        capturePointer(event);
        event.preventDefault();
        return;
      }
    }
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
      trafficState.strokeStartScreen = [event.clientX, event.clientY];
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
          mode: handleDistance <= (event.pointerType === 'touch' ? 32 : 20) ? 'resize' : 'move',
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
        const handleTolerance = event.pointerType === 'touch' ? 32 : 20;
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
    if (event.pointerType === 'touch') {
      cameraTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      capturePointer(event);
      if (cameraTouchPointers.size > 1) {
        beginCameraTouchGesture();
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
    if (reportAreaDrag && event.pointerId === reportAreaDrag.pointerId) {
      const point = reportAreaDrag.mode === 'draw'
        ? pointerGround(event) : reportAreaGroundPoint(event, reportAreaDrag.initialBounds, true);
      if (point) {
        reportAreaDrag.current = {
          x: point.x + (reportAreaDrag.worldOffset?.x || 0),
          z: point.z + (reportAreaDrag.worldOffset?.z || 0),
        };
        const distance = Math.hypot(event.clientX - reportAreaDrag.screenStart[0], event.clientY - reportAreaDrag.screenStart[1]);
        if (distance >= 8) {
          const bounds = reportAreaDrag.mode === 'draw'
            ? reportSquareFromDrag(reportAreaDrag.start, reportAreaDrag.current)
            : reportAreaDrag.mode === 'resize-corner'
              ? reportSquareFromResize(reportAreaDrag.anchor, reportAreaDrag.current)
              : reportSquareFromMove(reportAreaDrag.start, reportAreaDrag.current, reportAreaDrag.initialBounds);
          if (bounds) {
            reportAreaDrag.previewBounds = bounds;
            updateReportAreaOutline(bounds);
          }
        }
      }
      return;
    }
    if (event.pointerType === 'touch' && cameraTouchPointers.has(event.pointerId)) {
      cameraTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (cameraTouchGesture && cameraTouchPointers.size >= 2) {
        const points = [...cameraTouchPointers.values()].slice(0, 2);
        const centerX = (points[0].x + points[1].x) * 0.5;
        const centerY = (points[0].y + points[1].y) * 0.5;
        const spacing = Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y));
        cameraState.distance = clamp(cameraTouchGesture.distance * cameraTouchGesture.spacing / spacing, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
        const dx = centerX - cameraTouchGesture.centerX;
        const dy = centerY - cameraTouchGesture.centerY;
        const pan = panFromDrag(cameraTouchGesture.distance, dx, dy);
        const rightVector = new THREE.Vector3(Math.sin(cameraTouchGesture.azimuth), 0, -Math.cos(cameraTouchGesture.azimuth));
        const forwardVector = new THREE.Vector3(-Math.cos(cameraTouchGesture.azimuth), 0, -Math.sin(cameraTouchGesture.azimuth));
        cameraState.target.copy(cameraTouchGesture.target)
          .addScaledVector(rightVector, pan.right)
          .addScaledVector(forwardVector, pan.forward);
        updateCamera();
        return;
      }
    }
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
    if (!drag && !reportAreaLocked && reportAreaBounds && !reportAreaPickMode) {
      canvas.style.cursor = reportAreaInteractionAt(event)?.cursor || '';
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.pan) {
      const pan = panFromDrag(cameraState.distance, dx, dy);
      const rightVector = new THREE.Vector3(Math.sin(drag.azimuth), 0, -Math.cos(drag.azimuth));
      const forwardVector = new THREE.Vector3(-Math.cos(drag.azimuth), 0, -Math.sin(drag.azimuth));
      cameraState.target.copy(drag.target).addScaledVector(rightVector, pan.right).addScaledVector(forwardVector, pan.forward);
    } else {
      const orbit = orbitFromDrag(drag, dx, dy);
      cameraState.azimuth = orbit.azimuth;
      cameraState.elevation = orbit.elevation;
    }
    updateCamera();
  });
  canvas.addEventListener('pointerup', event => {
    if (reportAreaDrag && event.pointerId === reportAreaDrag.pointerId) {
      const point = reportAreaDrag.mode === 'draw'
        ? pointerGround(event) : reportAreaGroundPoint(event, reportAreaDrag.initialBounds, true);
      if (point) {
        reportAreaDrag.current = {
          x: point.x + (reportAreaDrag.worldOffset?.x || 0),
          z: point.z + (reportAreaDrag.worldOffset?.z || 0),
        };
      }
      const screenDistance = Math.hypot(event.clientX - reportAreaDrag.screenStart[0], event.clientY - reportAreaDrag.screenStart[1]);
      const mode = reportAreaDrag.mode;
      const bounds = screenDistance < 8 ? null : mode === 'draw'
        ? reportSquareFromDrag(reportAreaDrag.start, reportAreaDrag.current)
        : mode === 'resize-corner'
          ? reportSquareFromResize(reportAreaDrag.anchor, reportAreaDrag.current)
          : reportSquareFromMove(reportAreaDrag.start, reportAreaDrag.current, reportAreaDrag.initialBounds);
      reportAreaDrag = null;
      if (mode === 'draw') reportAreaPickMode = false;
      clickCandidate = null;
      drag = null;
      canvas.style.cursor = '';
      if (bounds) {
        reportAreaBounds = bounds;
        if (mode === 'draw') {
          cameraIntro = null;
          frameBounds([bounds.min_x, bounds.min_z, bounds.max_x, bounds.max_z], { elevation: 0.55, accountForPanel: true });
        }
        reportAreaHandleCornerIndex = chooseReportAreaHandleCorner(bounds);
        updateReportAreaOutline(bounds);
        dispatchEvent(new CustomEvent('climate-report-area-selected', { detail: { ...bounds, operation: mode } }));
      } else {
        updateReportAreaOutline(reportAreaBounds);
        if (mode === 'draw') dispatchEvent(new CustomEvent('climate-report-area-pick-cancelled', { detail: { reason: 'drag-too-short' } }));
      }
      event.preventDefault();
      return;
    }
    if (trafficState.drawing && trafficState.stroking && event.pointerId === trafficState.pointerId) {
      const touchTap = event.pointerType === 'touch' && trafficState.strokeStartScreen
        && Math.hypot(event.clientX - trafficState.strokeStartScreen[0], event.clientY - trafficState.strokeStartScreen[1]) <= 12;
      if (touchTap) {
        trafficState.stroking = false;
        trafficState.pointerId = null;
        trafficState.strokePoints = [];
        trafficState.strokeStartScreen = null;
        if (removeTrafficSelectionAt(event)) return;
        trafficState.stroking = true;
        trafficState.pointerId = event.pointerId;
        appendTrafficClosurePoint(event, true);
      } else {
        appendTrafficClosurePoint(event, true);
      }
      commitTrafficStroke();
      trafficState.strokeStartScreen = null;
      return;
    }
    if (event.pointerType === 'touch' && cameraTouchPointers.has(event.pointerId)) {
      const wasGesture = Boolean(cameraTouchGesture);
      cameraTouchPointers.delete(event.pointerId);
      if (wasGesture) {
        cameraTouchGesture = null;
        drag = null;
        clickCandidate = null;
        if (cameraTouchPointers.size === 1) {
          const remaining = [...cameraTouchPointers.values()][0];
          drag = {
            x: remaining.x, y: remaining.y,
            azimuth: cameraState.azimuth, elevation: cameraState.elevation,
            target: cameraState.target.clone(), pan: false,
          };
        }
        return;
      }
    }
    const cameraTouchTap = event.pointerType === 'touch' && clickCandidate
      && Math.hypot(event.clientX - clickCandidate.x, event.clientY - clickCandidate.y) < 12;
    if (cameraTouchTap && performance.now() - lastCameraTouchTap < 350) {
      lastCameraTouchTap = 0;
      clickCandidate = null;
      drag = null;
      fitScene();
      return;
    }
    if (cameraTouchTap) lastCameraTouchTap = performance.now();
    drag = null;
    const isMapClick = clickCandidate
      && Math.hypot(event.clientX - clickCandidate.x, event.clientY - clickCandidate.y) < (event.pointerType === 'touch' ? 12 : 5);
    if (isMapClick && viewshedState.active && viewshedState.pickMode) {
      const buildingPlacement = event.altKey ? null : pointerViewshedBuilding(event);
      const point = buildingPlacement ? null : pointerGround(event);
      if (buildingPlacement) buildViewshed(buildingPlacement.x, buildingPlacement.z, buildingPlacement);
      else if (point) buildViewshed(point.x, point.z, { kind: 'terrain' });
      else if (viewshedStatus) viewshedStatus.textContent = 'Click the terrain, a roof, or a building face to place the observer.';
      clickCandidate = null;
      drag = null;
      requestRender();
      return;
    }
    if (isMapClick && placeInspectorPickMode) {
      const point = pointerGround(event);
      dispatchEvent(new CustomEvent('climate-place-inspector-picked', {
        detail: point ? { x: point.x, z: point.z } : {},
      }));
      clickCandidate = null;
      drag = null;
      requestRender();
      return;
    }
    if (isMapClick && windInspectToggle?.getAttribute('aria-pressed') === 'true'
      && windState.enabled && windHeatMesh?.visible) {
      const point = pointerGround(event);
      if (point) {
        const x = point.x, z = point.z;
        const ground = terrainHeightAt(x, z);
        let speed = null, category = null;
        if (windState.analysisMode === 'comfort' && windState.field?.comfort_category) {
          const field = windState.field;
          const column = Math.floor((x - field.origin[0]) / field.dx);
          const row = Math.floor((z - field.origin[1]) / field.dz);
          const index = row * field.width + column;
          if (column >= 0 && row >= 0 && column < field.width && row < field.height && field.valid?.[index]
            && pointInLidarFootprint(x, z) && !windPointInsideBuilding(x, z, ground + field.height_m)) {
            speed = field.coverage_fraction > 0 ? field.speed[index] / field.coverage_fraction : field.speed[index];
            category = ['Long sitting', 'Short sitting', 'Standing', 'Strolling', 'Business walking', 'Uncomfortable'][field.comfort_category[index]] || 'Unclassified';
          }
        } else if (windState.cfd) {
          if (pointInLidarFootprint(x, z) && !windPointInsideBuilding(x, z, ground + windState.cfdGroundHeight)) {
            const sample = sampleCfd(x, ground + windState.cfdGroundHeight, z);
            if (sample) speed = sample.speed;
          }
        }
        windInspectResult.textContent = speed == null
          ? 'No solved wind value at this point. Try a coloured part of the layer.'
          : `${speed.toFixed(1)} m/s · ${(speed * 3.6).toFixed(1)} km/h${category ? ` · ${category}` : ' · switch to Wind comfort for the comfort class'} · ${x.toFixed(0)} m east, ${z.toFixed(0)} m south`;
        windInspectResult.hidden = false;
        dispatchEvent(new CustomEvent('climate-wind-focus', { detail: {
          x, z, name: 'Inspected location', speed, focusCamera: false,
        } }));
      }
    }
    if (isMapClick && scenePickHandlers.size
      && Math.hypot(event.clientX - clickCandidate.x, event.clientY - clickCandidate.y) < (event.pointerType === 'touch' ? 12 : 5)) {
      const raycaster = pointerRaycaster(event);
      for (const handler of scenePickHandlers) {
        if (handler({ raycaster, event })) break;
      }
    }
    clickCandidate = null;
    if (sunDrag) {
      sunSeasonalResults = null;
      sunCompareSwitch.hidden = true;
      sunCompareSummary.hidden = true;
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
    cameraTouchPointers.delete(event.pointerId);
    cameraTouchGesture = null;
    if (event.pointerId === reportAreaDrag?.pointerId) {
      const mode = reportAreaDrag.mode;
      reportAreaDrag = null;
      if (mode === 'draw') reportAreaPickMode = false;
      updateReportAreaOutline(reportAreaBounds);
      if (mode === 'draw') dispatchEvent(new CustomEvent('climate-report-area-pick-cancelled', { detail: { reason: 'pointer-cancelled' } }));
    }
    if (event.pointerId === trafficState.pointerId) {
      cancelInterruptedTrafficStroke('Stroke cancelled by the pointer. Draw again or confirm the existing selection.');
    }
    sunDrag = null;
    drag = null;
    windDrag = null;
    sliceDrag = null;
  });
  canvas.addEventListener('lostpointercapture', event => {
    if (event.pointerId === trafficState.pointerId) cancelInterruptedTrafficStroke();
  });
  addEventListener('blur', () => cancelInterruptedTrafficStroke());
  addEventListener('online', () => {
    if (!trafficState.networkEdges.length) void loadTrafficRoads();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    cameraIntro = null;
    cameraState.distance = clamp(cameraState.distance * Math.exp(event.deltaY * 0.0008), CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
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
      if (document.querySelector('[data-menu-target].active')?.dataset.menuTarget === 'tools') {
        savedVisibility[event.target.dataset.layer] = group.visible;
      }
    }
    if (event.target.dataset.layer === 'groundcover') {
      const summary = document.querySelector('#groundcover-summary');
      if (summary) summary.hidden = !event.target.checked;
      if (event.target.checked) void loadGroundcoverInventory();
    }
    if (event.target.dataset.layer === 'cycling') {
      const summary = document.querySelector('#cycling-summary');
      if (summary) summary.hidden = !event.target.checked;
      if (event.target.checked) buildCyclingLayer();
    }
    if (event.target.dataset.layer === 'runoff') {
      const summary = document.querySelector('#runoff-summary');
      if (summary) summary.hidden = !event.target.checked;
      if (event.target.checked) void loadRunoffScreening();
    }
    if (event.target.dataset.layer === 'publicRealm') {
      layerGroups.cityFurniture.visible = event.target.checked;
      savedVisibility.publicRealm = event.target.checked;
      savedVisibility.cityFurniture = event.target.checked;
      const summary = document.querySelector('#public-realm-summary');
      if (summary) summary.hidden = !event.target.checked;
      if (event.target.checked) void ensurePublicRealm();
      scheduleLightingAreaLoad(true);
    }
    refreshTransportVehicleLayers();
    requestRender();
  }));

  document.querySelector('#runoff-rainfall')?.addEventListener('input', event => {
    runoffRainfallDepthMm = clamp(Number(event.target.value) || 25, 5, 100);
    updateRunoffSummary();
  });

  heatToggle?.addEventListener('change', event => setHeatMode(event.target.checked));
  heatStreetMapToggle?.addEventListener('change', event => {
    if (event.target.checked && heatToggle && !heatToggle.checked) {
      heatToggle.checked = true;
      heatToggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
    buildHeatStreetOverlay();
    requestRender();
  });
  heatMetric?.addEventListener('change', event => {
    loadHeat(event.target.value);
  });
  heatSaveComparison?.addEventListener('click', () => {
    if (!heatCurrentSummary) {
      if (heatComparison) { heatComparison.hidden = false; heatComparison.textContent = 'Wait for a heat result before saving a comparison.'; }
      return;
    }
    heatSavedComparison = { ...heatCurrentSummary };
    if (heatComparison) { heatComparison.hidden = false; heatComparison.textContent = `Saved ${heatSavedComparison.label} · ${heatSavedComparison.date} · mean ${heatSavedComparison.mean.toFixed(1)}${heatSavedComparison.unit}. Change the view or time to compare.`; }
  });
  heatInspectButton?.addEventListener('click', () => {
    if (!heatInspectResult) return;
    if (heatToggle && !heatToggle.checked) { heatToggle.checked = true; heatToggle.dispatchEvent(new Event('change', { bubbles: true })); }
    heatInspectResult.hidden = false;
    heatInspectResult.textContent = 'Click a mapped place on the heat surface to inspect it.';
    requestGroundPick((x, z) => {
      void (async () => {
        try {
          if (heatPayload?.thermal) {
            if (heatMetric.value === 'sky_view_factor') {
              const manifest = heatPayload.manifest;
              const { width, height, resolution_m: resolution, bounds } = manifest.grid;
              const [minX, minZ, maxX, maxZ] = bounds.map(Number);
              if (x < minX || x >= maxX || z < minZ || z >= maxZ) throw new Error('That point is outside the sky-view-factor grid.');
              const column = Math.floor((x - minX) / resolution), row = Math.floor((z - minZ) / resolution);
              if (column < 0 || row < 0 || column >= width || row >= height) throw new Error('That point is outside the sky-view-factor grid.');
              const raw = heatPayload.values[row * width + column];
              if (raw === manifest.nodata) throw new Error('That surface cell has no calculated sky-view-factor value.');
              const value = raw * heatPayload.manifest.channels[0].scale;
              heatInspectResult.textContent = `Sky-view factor: ${value.toFixed(1)}% at ${x.toFixed(0)}, ${z.toFixed(0)} m. Static SOLWEIG geometry estimate.`;
              return;
            }
            if (heatPayload.climatology) {
              const manifest = heatPayload.manifest;
              const { width, height, resolution_m: resolution, bounds } = manifest.grid;
              const [minX, minZ, maxX, maxZ] = bounds.map(Number);
              if (x < minX || x >= maxX || z < minZ || z >= maxZ) throw new Error('That point is outside the historical climate grid.');
              const column = Math.floor((x - minX) / resolution), row = Math.floor((z - minZ) / resolution);
              if (column < 0 || row < 0 || column >= width || row >= height) throw new Error('That point is outside the historical climate grid.');
              const channel = thermalChannel(manifest, heatMetric.value);
              const channelSlot = manifest.channels.findIndex(item => item.name === heatMetric.value);
              const raw = heatPayload.values[(row * width + column) * manifest.channels.length + channelSlot];
              if (raw === manifest.nodata) throw new Error('That historical grid cell has no calculated value.');
              const value = raw * channel.scale + Number(channel.offset || 0);
              const period = heatClimateAggregate?.selectedOptions[0]?.textContent || 'Historical climate';
              heatInspectResult.textContent = `${heatMetric.value === 'utci_c' ? 'UTCI' : 'Mean radiant temperature'}: ${Number(value).toFixed(1)}°C at ${x.toFixed(0)}, ${z.toFixed(0)} m · ${period}, ${heatClimateHourLabel?.textContent || ''} · 2016–2025 climate estimate.`;
              return;
            }
            const frame = selectedThermalFrame();
            if (!thermalManifest || !frame) throw new Error('No forecast frame is available for this time.');
            const params = new URLSearchParams({ x: String(x), z: String(z), run_id: thermalManifest.run_id, frame_id: frame.id });
            const response = await fetch(`${windApi}/thermal/point?${params}`);
            if (!response.ok) throw new Error('That point is outside the current forecast grid or has no value.');
            const point = await response.json();
            const name = heatMetric.value === 'tmrt_c' ? 'tmrt_c' : 'utci_c';
            const value = point.values?.[name];
            heatInspectResult.textContent = value == null
              ? `No ${name === 'utci_c' ? 'UTCI' : 'radiant-temperature'} value at ${x.toFixed(0)}, ${z.toFixed(0)} m.`
              : `${name === 'utci_c' ? 'UTCI' : 'Mean radiant temperature'} at ${x.toFixed(0)}, ${z.toFixed(0)} m: ${Number(value).toFixed(1)}°C${name === 'utci_c' && point.utci_category ? ` · ${point.utci_category}` : ''}. Model estimate, not an observation.`;
            return;
          }
          const contains = (ring, px, pz) => {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const [xi, zi] = ring[i], [xj, zj] = ring[j];
              if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / ((zj - zi) || 1e-12) + xi) inside = !inside;
            }
            return inside;
          };
          const feature = heatPayload?.features?.find(item => geometryPolygons(item.geometry).some(polygon =>
            contains(polygon[0] || [], x, z) && !(polygon.slice(1).some(hole => contains(hole, x, z)))));
          const value = feature?.value ?? feature?.properties?.[heatMetric.value];
          if (value == null) throw new Error('No screening value covers that point. Try another place on the coloured surface.');
          heatInspectResult.textContent = `${heatPayload.metric_label || heatMetric.selectedOptions[0]?.textContent}: ${formatHeatValue(value, heatPayload.metric_metadata)} at ${x.toFixed(0)}, ${z.toFixed(0)} m. ${heatPayload.source || 'Screening product'} · ${heatPayload.window?.label || 'source period'}.`;
        } catch (error) {
          heatInspectResult.textContent = error.message || 'Could not inspect this place.';
        }
      })();
    });
  });
  heatDate?.addEventListener('change', event => {
    shadowState.date = event.target.value || shadowState.date;
    updateDesignShadePreview();
    loadHeat(heatMetric?.value);
  });
  heatTime?.addEventListener('change', event => {
    shadowState.minutes = Number(event.target.value);
    updateDesignShadePreview();
    loadHeat(heatMetric?.value);
  });
  heatForecastTime?.addEventListener('input', () => {
    updateDesignShadePreview();
    if (['utci_c', 'tmrt_c'].includes(heatMetric?.value)) loadHeat(heatMetric.value);
  });
  // The experience layer cancels in-flight heat reads during the bubbling
  // change event. Reload after that cancellation so the final slider value
  // still gets a request once the user releases the forecast slider.
  heatForecastTime?.addEventListener('change', () => {
    updateDesignShadePreview();
    if (['utci_c', 'tmrt_c'].includes(heatMetric?.value)) loadHeat(heatMetric.value);
  });
  heatScenarioPick?.addEventListener('click', () => {
    if (heatScenarioStatus) heatScenarioStatus.textContent = 'Click the map where the tree or shade structure should be centred.';
    requestGroundPick((x, z) => {
      thermalScenarioCenter = { x, z };
      thermalScenarioPayload = null;
      if (heatScenarioRun) heatScenarioRun.disabled = false;
      if (heatScenarioDelta) heatScenarioDelta.disabled = true;
      if (heatScenarioBaseline) heatScenarioBaseline.disabled = true;
      if (heatScenarioStatus) heatScenarioStatus.textContent = `Intervention centre selected (${x.toFixed(1)}, ${z.toFixed(1)} m).`;
    });
  });
  heatPointPick?.addEventListener('click', () => {
    if (heatScenarioStatus) heatScenarioStatus.textContent = 'Click a valid ground cell to compare its UTCI.';
    requestGroundPick((x, z) => {
      void inspectThermalComparisonPoint(x, z).catch(error => {
        if (heatScenarioStatus) heatScenarioStatus.textContent = error.message || 'No UTCI value at that point.';
      });
    });
  });
  heatScenarioRun?.addEventListener('click', () => void calculateThermalScenario());
  heatScenarioDelta?.addEventListener('click', showThermalScenarioDifference);
  heatScenarioBaseline?.addEventListener('click', showThermalBaseline);
  heatScenarioRadius?.addEventListener('input', () => {
    if (heatScenarioRadiusLabel) heatScenarioRadiusLabel.textContent = `${heatScenarioRadius.value} m`;
    thermalScenarioPayload = null;
    if (heatScenarioDelta) heatScenarioDelta.disabled = true;
    if (heatScenarioBaseline) heatScenarioBaseline.disabled = true;
    if (heatScenarioSummary) heatScenarioSummary.hidden = true;
  });
  heatScenarioShade?.addEventListener('input', () => {
    if (heatScenarioShadeLabel) heatScenarioShadeLabel.textContent = `${heatScenarioShade.value}%`;
    thermalScenarioPayload = null;
    if (heatScenarioDelta) heatScenarioDelta.disabled = true;
    if (heatScenarioBaseline) heatScenarioBaseline.disabled = true;
    if (heatScenarioSummary) heatScenarioSummary.hidden = true;
  });
  heatScenarioType?.addEventListener('change', () => {
    if (heatScenarioRadius) {
      heatScenarioRadius.max = heatScenarioType.value === 'tree' ? '20' : '40';
      if (Number(heatScenarioRadius.value) > Number(heatScenarioRadius.max)) heatScenarioRadius.value = heatScenarioRadius.max;
      if (heatScenarioRadiusLabel) heatScenarioRadiusLabel.textContent = `${heatScenarioRadius.value} m`;
    }
    thermalScenarioPayload = null;
    if (heatScenarioDelta) heatScenarioDelta.disabled = true;
    if (heatScenarioBaseline) heatScenarioBaseline.disabled = true;
    if (heatScenarioSummary) heatScenarioSummary.hidden = true;
  });
  heatPeriod?.addEventListener('change', () => {
    syncHeatTemporalControls();
    loadHeat(heatMetric?.value);
  });
  heatClimateMonth?.addEventListener('input', () => {
    const month = Number(heatClimateMonth.value);
    if (heatClimateMonthLabel) heatClimateMonthLabel.textContent = new Date(Date.UTC(2020, month - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
    renderClimateProfiles();
    updateDesignShadePreview();
  });
  heatClimateMonth?.addEventListener('change', () => loadHeat(heatMetric?.value));
  heatClimateHour?.addEventListener('input', () => {
    const hour = Number(heatClimateHour.value);
    if (heatClimateHourLabel) heatClimateHourLabel.textContent = `${hour.toString().padStart(2, '0')}:00 SAST`;
    renderClimateProfiles();
    updateDesignShadePreview();
  });
  heatClimateHour?.addEventListener('change', () => loadHeat(heatMetric?.value));
  heatClimateAggregate?.addEventListener('change', () => {
    syncHeatTemporalControls();
    loadHeat(heatMetric?.value);
  });
  heatClimateSeason?.addEventListener('change', () => loadHeat(heatMetric?.value));
  [heatSeasonProfile, heatMonthProfile, heatDayProfile].forEach(profile => profile?.addEventListener('click', event => {
    const button = event.target.closest('.heat-climate-bar');
    if (!button) return;
    if (button.dataset.month) heatClimateMonth.value = button.dataset.month;
    if (button.dataset.hour) heatClimateHour.value = button.dataset.hour;
    if (button.dataset.season) {
      heatClimateAggregate.value = 'season';
      heatClimateSeason.value = button.dataset.season;
      syncHeatTemporalControls();
    }
    if (button.dataset.month) {
      heatClimateAggregate.value = 'month';
      syncHeatTemporalControls();
    }
    renderClimateProfiles();
    loadHeat(heatMetric?.value);
  }));
  sunToggle?.addEventListener('change', event => setShadowMode(event.target.checked));
  sunDetailButtons.forEach(button => button.addEventListener('click', () => setSunDetail(button.dataset.sunDetail)));
  sunDate?.addEventListener('change', event => {
    sunSeasonalResults = null;
    sunCompareSwitch.hidden = true;
    sunCompareSummary.hidden = true;
    shadowState.date = event.target.value || shadowState.date;
    if (sunAnalysisDate) sunAnalysisDate.value = shadowState.date;
    updateDesignShadePreview();
    if (shadowState.mode === 'shadows') queueLiveShadowUpdate();
    else {
      cancelSunHours('Date changed · calculate sun hours again.');
    }
  });
  sunAnalysisDate?.addEventListener('change', event => {
    sunSeasonalResults = null;
    sunCompareSwitch.hidden = true;
    sunCompareSummary.hidden = true;
    shadowState.date = event.target.value || shadowState.date;
    if (sunDate) sunDate.value = shadowState.date;
    updateDesignShadePreview();
    cancelSunHours('Study date changed · calculate sun hours again.');
  });
  sunTime?.addEventListener('input', event => {
    shadowState.minutes = Number(event.target.value);
    updateDesignShadePreview();
    if (shadowState.mode === 'shadows') queueLiveShadowUpdate();
  });
  const stopSunPlayback = () => {
    if (sunPlaybackTimer) clearInterval(sunPlaybackTimer);
    sunPlaybackTimer = 0;
    if (sunPlay) { sunPlay.textContent = '▶ Play day'; sunPlay.setAttribute('aria-pressed', 'false'); }
  };
  sunPlay?.addEventListener('click', () => {
    if (sunPlaybackTimer) { stopSunPlayback(); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sunStatus.textContent = 'Day playback is disabled by your reduced-motion preference. Use the time slider or solar shortcuts.';
      return;
    }
    if (shadowState.mode !== 'shadows') setSunAnalysisMode('shadows');
    if (shadowState.minutes >= 1430) {
      shadowState.minutes = 360;
      if (sunTime) sunTime.value = '360';
    }
    sunPlay.textContent = 'Ⅱ Pause';
    sunPlay.setAttribute('aria-pressed', 'true');
    sunPlaybackTimer = setInterval(() => {
      const next = Math.min(1430, shadowState.minutes + 10);
      shadowState.minutes = next;
      if (sunTime) sunTime.value = String(next);
      updateSunStatus();
      queueLiveShadowUpdate();
      if (next >= 1430) stopSunPlayback();
    }, 500);
  });
  sunDate?.addEventListener('input', stopSunPlayback);
  sunTime?.addEventListener('input', stopSunPlayback);
  document.querySelectorAll('[data-sun-time]').forEach(button => button.addEventListener('click', () => {
    const target = button.dataset.sunTime;
    let sunrise = null, sunset = null, noon = 0, peak = -Infinity, wasAbove = false;
    for (let minute = 0; minute <= 1430; minute += 10) {
      const altitude = sunPosition(shadowState.date, minute).altitude;
      if (altitude > peak) { peak = altitude; noon = minute; }
      const above = altitude > 0.008;
      if (above && !wasAbove && sunrise == null) sunrise = minute;
      if (!above && wasAbove && sunset == null) sunset = minute - 10;
      wasAbove = above;
    }
    const value = target === 'sunrise' ? sunrise : target === 'sunset' ? sunset : noon;
    if (value == null) {
      sunStatus.textContent = 'The sun does not rise on this date at this location.';
      return;
    }
    stopSunPlayback();
    shadowState.minutes = value;
    if (sunTime) sunTime.value = String(value);
    updateSunStatus();
    if (shadowState.mode === 'shadows') queueLiveShadowUpdate();
  }));
  sunModeButtons.forEach(button => button.addEventListener('click', () => setSunAnalysisMode(button.dataset.sunMode)));
  sunDomainSize?.addEventListener('change', event => {
    shadowState.size = Number(event.target.value) || 500;
    sunSeasonalResults = null;
    sunCompareSwitch.hidden = true;
    sunCompareSummary.hidden = true;
    cancelSunHours(`Analysis area resized to ${shadowState.size} m · calculate sun hours.`);
    updateSunBox();
  });
  for (const control of [sunStartTime, sunEndTime, sunStepTime, sunAnalysisSurfaces, sunSurfaceResolution]) {
    control?.addEventListener('change', () => {
      sunSeasonalResults = null;
      sunCompareSwitch.hidden = true;
      sunCompareSummary.hidden = true;
      sunInspect.hidden = true;
      cancelSunHours('Sun-hours settings changed · calculate again.');
    });
  }
  sunMoveDomain?.addEventListener('click', () => {
    shadowState.moveMode = !shadowState.moveMode;
    sunMoveDomain.classList.toggle('active', shadowState.moveMode);
    sunMoveDomain.setAttribute('aria-pressed', String(shadowState.moveMode));
    sunMoveDomain.textContent = shadowState.moveMode ? 'Done moving' : 'Move / resize analysis area';
    updateSunBox();
  });
  sunGenerate?.addEventListener('click', () => {
    if (shadowState.mode === 'hours') {
      sunSeasonalResults = null;
      sunCompareSwitch.hidden = true;
      sunCompareSummary.hidden = true;
      generateSunHours();
    }
    else generateShadows();
  });
  sunCompare?.addEventListener('click', async () => {
    const firstDate = sunAnalysisDate?.value || sunDate?.value || shadowState.date;
    const secondDate = sunCompareDate?.value;
    if (!secondDate || firstDate === secondDate) {
      sunStatus.textContent = 'Choose two different dates for a seasonal comparison.';
      return;
    }
    sunCompare.disabled = true;
    sunCompare.textContent = 'Comparing…';
    sunCompareSummary.hidden = true;
    sunCompareSwitch.hidden = true;
    try {
      const first = await generateSunHours(firstDate, false);
      if (!first) throw new Error('The first date did not finish.');
      const second = await generateSunHours(secondDate, false);
      if (!second) throw new Error('The comparison date did not finish.');
      sunSeasonalResults = { first, second, difference: makeSunDifference(first, second) };
      const firstLabel = new Date(`${firstDate}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
      const secondLabel = new Date(`${secondDate}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
      sunResultButtons.find(button => button.dataset.sunResult === 'first').textContent = firstLabel;
      sunResultButtons.find(button => button.dataset.sunResult === 'second').textContent = secondLabel;
      sunCompareSwitch.hidden = false;
      sunInspect.hidden = false;
      sunCompareSummary.textContent = `${firstLabel}: ${first.average.toFixed(1)} h mean · ${secondLabel}: ${second.average.toFixed(1)} h mean · change ${second.average - first.average > 0 ? '+' : ''}${(second.average - first.average).toFixed(1)} h. Same area, surfaces and time window; clear-sky model comparison.`;
      sunCompareSummary.hidden = false;
      sunResultButtons.forEach(button => {
        const selected = button.dataset.sunResult === 'first';
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      displaySunHoursResult(first);
    } catch (error) {
      sunStatus.textContent = `Seasonal comparison unavailable (${error.message})`;
    } finally {
      sunCompare.disabled = false;
      sunCompare.textContent = 'Compare dates';
    }
  });
  sunResultButtons.forEach(button => button.addEventListener('click', () => {
    if (!sunSeasonalResults) return;
    const view = button.dataset.sunResult;
    sunResultButtons.forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    if (view === 'difference') displaySunHoursResult(sunSeasonalResults.difference, true);
    else displaySunHoursResult(sunSeasonalResults[view]);
  }));
  sunInspect?.addEventListener('click', () => {
    if (!activeSunResult) return;
    sunInspectResult.hidden = false;
    sunInspectResult.textContent = 'Click a coloured ground, roof or façade cell in the scene.';
    requestGroundPick((x, z) => {
      requestGroundPick(null);
      const inside = (ring, px, pz) => {
        let result = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          if ((ring[i][1] > pz) !== (ring[j][1] > pz)
            && px < (ring[j][0] - ring[i][0]) * (pz - ring[i][1]) / ((ring[j][1] - ring[i][1]) || 1e-12) + ring[i][0]) result = !result;
        }
        return result;
      };
      const groundCell = activeSunResult.payload.features?.find(feature => {
        const polygon = feature.geometry?.type === 'Polygon' ? feature.geometry.coordinates
          : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates[0] : null;
        return polygon && inside(polygon[0] || [], x, z) && !polygon.slice(1).some(hole => inside(hole, x, z));
      });
      const buildingCell = activeSunResult.buildings?.features?.find(feature => {
        if (feature.surface === 'roof') {
          const polygons = geometryPolygons(feature.geometry);
          return polygons.some(polygon => inside(polygon[0] || [], x, z) && !polygon.slice(1).some(hole => inside(hole, x, z)));
        }
        return feature.vertices?.length >= 4 && inside(feature.vertices.map(vertex => [vertex[0], vertex[2]]), x, z);
      });
      const feature = buildingCell || groundCell;
      if (!feature) { sunInspectResult.textContent = 'No analysed cell at this point. Try a coloured surface inside the study area.'; return; }
      const surface = feature.surface || 'ground';
      const rawValue = Number(feature.value || 0);
      const value = rawValue.toFixed(1);
      const label = activeSunResult.payload.metric === 'utci_delta_c'
        ? `Δ ${rawValue > 0 ? '+' : ''}${value} h direct sun (${sunSeasonalResults.first.scenario.date} → ${sunSeasonalResults.second.scenario.date})`
        : `${value} h direct sun · ${activeSunResult.scenario.date}`;
      sunInspectResult.textContent = `${surface[0].toUpperCase()}${surface.slice(1)} · ${label} · clear-sky estimate.`;
    });
  });

  let initializedSunOnOpen = false;
  const showCurrentSun = () => {
    if (!initializedSunOnOpen) {
      initializedSunOnOpen = true;
      const now = new Date();
      shadowState.date = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
      const hour = Number(parts.find(part => part.type === 'hour')?.value || 12);
      const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
      if (sunDate) sunDate.value = shadowState.date;
      if (sunAnalysisDate) sunAnalysisDate.value = shadowState.date;
      if (sunTime) sunTime.value = String(clamp(Math.round((hour * 60 + minute) / 10) * 10, Number(sunTime.min), Number(sunTime.max)));
      shadowState.minutes = Number(sunTime?.value) || 0;
      const alternateSolstice = shadowState.date.slice(5, 7) === '06' ? '12-21' : '06-21';
      if (sunCompareDate) sunCompareDate.value = `${shadowState.date.slice(0, 4)}-${alternateSolstice}`;
    }
    if (!sunToggle?.checked) setShadowMode(true);
    if (shadowState.mode === 'shadows') generateShadows();
  };
  addEventListener('climate-menu-change', event => {
    if (event.detail?.name === 'sun') showCurrentSun();
    else scheduleLightingAreaLoad();
  });

  function setWindAnalysisMode(mode) {
    if (!['direction', 'comfort', 'pollution'].includes(mode)) return;
    const previousMode = windState.analysisMode;
    if (previousMode === 'pollution' && mode !== 'pollution'
      && (pollutionPickSource?.getAttribute('aria-pressed') === 'true'
        || pollutionInspectToggle?.getAttribute('aria-pressed') === 'true')) {
      requestGroundPick(null);
      pollutionPickSource?.setAttribute('aria-pressed', 'false');
      pollutionPickSource.textContent = 'Place source on map';
      pollutionInspectToggle?.setAttribute('aria-pressed', 'false');
      pollutionInspectToggle.textContent = 'Inspect an area';
      canvas.style.cursor = '';
    }
    windState.analysisMode = mode;
    if (mode !== 'direction') {
      if (windCfdLoading) windCfdLoading.hidden = true;
      if (windSimulate) windSimulate.disabled = false;
      windState.particles = [];
      if (windPoints) windPoints.visible = false;
    }
    // All three lenses use the converted OpenFOAM volumes. The older
    // screening proxy is retired from this WebGL panel; dataMode stays 'cfd'
    // so the existing CFD sampling paths remain shared.
    windState.dataMode = 'cfd';
    windLensButtons.filter(button => ['direction', 'comfort', 'pollution'].includes(button.dataset.windLens)).forEach(button => {
      const active = button.dataset.windLens === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (windDirectionControls) windDirectionControls.hidden = !['direction', 'pollution'].includes(mode);
    const compassPresets = windDirectionControls?.querySelector('.wind-compass-presets');
    if (compassPresets) compassPresets.hidden = mode === 'pollution';
    if (windCfdControls) {
      windCfdControls.hidden = mode !== 'direction';
      if (mode === 'direction') windCfdControls.open = true;
    }
    if (windClimateControls) windClimateControls.hidden = mode !== 'comfort';
    if (pollutionControls) pollutionControls.hidden = mode !== 'pollution';
    if (mode === 'pollution') syncPollutionControls();
    // Flow region (box move/resize + flowline appearance) only applies to
    // Direction's Flow view.
    if (windFlowBoxControls) windFlowBoxControls.hidden = mode !== 'direction' || windState.cfdView !== 'flow';
    updateWindBox();
    windPanel?.classList.add('cfd-active');
    if (windModeBadge) windModeBadge.textContent = mode === 'comfort' ? 'CFD · COMFORT (PARTIAL)' : mode === 'pollution' ? 'CFD · DISPERSION SCREEN' : 'CFD · FULL CBD';
    const windModeHelp = document.querySelector('#wind-mode-help');
    if (windModeHelp) windModeHelp.textContent = mode === 'comfort'
      ? 'Combines available solved directions with Cape Town’s wind rose. Unsolved directions are excluded, so coverage is partial.'
      : mode === 'pollution'
        ? 'Choose a traffic period and wind direction, then run the plume screen.'
        : 'Inspect one solved wind direction. The full-CBD OpenFOAM result loads automatically and animates pedestrian-level flow.';
    const directionHint = windDirectionControls?.querySelector('.wind-cfd-hint');
    if (directionHint) directionHint.textContent = mode === 'pollution'
      ? 'The city plume uses road-level SUMO emissions and this steady OpenFOAM flow and turbulence field.'
      : 'Comfort uses all 16 solved sectors. Direction view offers the eight main compass points. Results are exploratory and unvalidated.';
    if (windFlowlinesVisible) windFlowlinesVisible.disabled = mode !== 'direction';
    if (windVolumeVisible) windVolumeVisible.disabled = mode !== 'direction';
    if (mode === 'comfort' && windState.volumeVisible) {
      windState.volumeVisible = false;
      if (windVolumeVisible) windVolumeVisible.checked = false;
    }
    windSimulate.textContent = mode === 'comfort' ? 'Run comfort assessment' : mode === 'pollution' ? pollutionRunActionLabel() : 'Load direction result';
    windState.field = null;
    clearWindSimulation();
    if (mode === 'pollution') {
      if (previousMode !== 'pollution') {
        pollutionState.streetVisibilityBeforePollution = {
          roads: layerGroups.roads.visible,
          paths: layerGroups.paths.visible,
        };
      }
      layerGroups.roads.visible = true;
      layerGroups.paths.visible = true;
      syncLayerControls();
      refreshTransportVehicleLayers();
      windState.enabled = true;
      if (windToggle) windToggle.checked = true;
      windGroup.visible = true;
      pollutionState.sourceHeight = Number(pollutionHeight?.value) || pollutionState.sourceHeight;
      if (pollutionDirection) pollutionDirection.value = String(windState.direction);
      buildPollutionSourceMarker();
    } else if (previousMode === 'pollution' && pollutionState.streetVisibilityBeforePollution) {
      layerGroups.roads.visible = pollutionState.streetVisibilityBeforePollution.roads;
      layerGroups.paths.visible = pollutionState.streetVisibilityBeforePollution.paths;
      pollutionState.streetVisibilityBeforePollution = null;
      syncLayerControls();
      refreshTransportVehicleLayers();
    }
    const legacyLegend = document.querySelector('.wind-legend-scale');
    const legacyInspect = document.querySelector('.wind-map-tools');
    const windCompareCard = document.querySelector('.wind-compare-card');
    const windValidationCard = document.querySelector('.wind-validation-card');
    if (legacyLegend) legacyLegend.hidden = mode === 'pollution';
    if (legacyInspect) legacyInspect.hidden = mode === 'pollution';
    if (windCompareCard) windCompareCard.hidden = mode === 'pollution';
    if (windValidationCard) windValidationCard.hidden = mode === 'pollution';
    if (mode === 'pollution' && windResults) windResults.hidden = true;
    syncPollutionView();
    if (pollutionLegend) pollutionLegend.hidden = mode !== 'pollution';
    if (mode === 'pollution' && windReport) windReport.hidden = true;
    windStatus.textContent = mode === 'comfort'
      ? 'Weights solved OpenFOAM directions by ERA5 wind-rose frequency. Unsolved directions are excluded, not assumed calm.'
      : mode === 'pollution'
        ? 'Choose a wind direction and run the plume scenario.'
        : 'Select a compass direction to load its OpenFOAM result. The current map stays visible while the new case loads.';
    requestRender();
    if (mode === 'direction') {
      if (!windState.cfd
        || Math.round(windState.cfd.manifest.direction_deg_from) !== Math.round(windState.direction)) {
        void loadCfdWind(windState.direction);
      } else {
        // Switching lenses disposes the displayed layers but keeps the solved
        // volume in memory. Rebuild the selected CFD view when returning.
        void buildCfdView().then(() => {
          primeWindSurfaceMotion();
          resetWindParticles();
          requestRender();
        });
      }
    }
  }

  windLensButtons.forEach(button => button.addEventListener('click', () => {
    const lens = button.dataset.windLens;
    if (lens === 'direction' || lens === 'comfort' || lens === 'pollution') setWindAnalysisMode(lens);
  }));

  function invalidatePollutionStudy(message) {
    clearPollutantStudy(true);
    if (windState.analysisMode === 'pollution') buildPollutionSourceMarker();
    if (message) windStatus.textContent = message;
    requestRender();
  }

  pollutionPickSource?.addEventListener('click', () => {
    const active = pollutionPickSource.getAttribute('aria-pressed') !== 'true';
    pollutionPickSource.setAttribute('aria-pressed', String(active));
    pollutionPickSource.textContent = active ? 'Click the map to place source · Esc to cancel' : 'Place source on map';
    if (!active) {
      requestGroundPick(null);
      return;
    }
    requestGroundPick((x, z) => {
      pollutionPickSource.setAttribute('aria-pressed', 'false');
      pollutionPickSource.textContent = 'Place source on map';
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      pollutionState.source = [x, z];
      try {
        createPollutionMarkerAtSource();
        clearPollutantStudy(false);
        buildPollutionSourceMarker();
        pollutionSourceStatus.textContent = `Source set · ${pollutionState.source[0].toFixed(0)} m east, ${pollutionState.source[1].toFixed(0)} m south.`;
        windStatus.textContent = 'Source moved · run the dispersion study again to trace this plume.';
      } catch (error) {
        pollutionSourceStatus.textContent = error.message;
      }
      requestRender();
    });
  });

  pollutionSourceType?.addEventListener('change', event => {
    pollutionState.sourceMode = event.target.value === 'point' ? 'point' : 'traffic';
    syncPollutionControls();
    clearPollutantStudy(true);
    if (windState.analysisMode === 'pollution') buildPollutionSourceMarker();
    windStatus.textContent = pollutionState.sourceMode === 'traffic'
      ? 'Run a citywide SUMO traffic profile to locate the strongest road-emission hotspots.'
      : 'Choose a map location and run a single-source plume screen.';
    requestRender();
  });

  for (const control of [pollutionTrafficScenario, pollutionTrafficLoad, pollutionTrafficSeed]) {
    control?.addEventListener('change', () => {
      pollutionState.trafficRunData = null;
      invalidatePollutionStudy('Traffic profile changed · run the citywide emissions scenario again.');
    });
  }

  pollutionDirection?.addEventListener('change', event => {
    const direction = Number(event.target.value);
    if (!findCfdCase(direction)) {
      windStatus.textContent = `No converted OpenFOAM case is available for ${direction}°.`;
      return;
    }
    windState.direction = direction;
    windDirectionPresets.forEach(button => button.classList.toggle('active', Number(button.dataset.windDirection) === direction));
    const label = event.target.selectedOptions[0]?.textContent.trim() || `${direction}°`;
    invalidatePollutionStudy(`${label} selected · run the dispersion study when ready.`);
  });
  pollutionHeight?.addEventListener('change', event => {
    pollutionState.sourceHeight = Number(event.target.value) || 2;
    invalidatePollutionStudy('Release height changed · run the dispersion study again.');
  });
  pollutionTime?.addEventListener('input', event => {
    if (!pollutionState.studyReady) return;
    pollutionState.playing = false;
    pollutionState.timeS = Number(event.target.value) || 0;
    pollutionState.lastSurfaceBin = -1;
    pollutionTimeLabel.textContent = `${(pollutionState.timeS / 60).toFixed(1)} min`;
    pollutionPlay.textContent = pollutionState.timeS >= pollutionState.durationS ? 'Replay timeline' : 'Play timeline';
    buildPollutionSurface();
    updatePollutionVisuals(performance.now(), true);
    requestRender();
  });
  pollutionPlay?.addEventListener('click', () => {
    if (!pollutionState.studyReady) return;
    if (pollutionState.playing) {
      pollutionState.playing = false;
      pollutionPlay.textContent = 'Play timeline';
    } else {
      if (pollutionState.timeS >= pollutionState.durationS) pollutionState.timeS = 0;
      pollutionState.playing = true;
      pollutionState.lastSurfaceBin = -1;
      pollutionState.lastTime = performance.now();
      pollutionPlay.textContent = 'Pause timeline';
    }
    requestRender();
  });
  pollutionInspectToggle?.addEventListener('click', () => {
    const active = pollutionInspectToggle.getAttribute('aria-pressed') !== 'true';
    pollutionInspectToggle.setAttribute('aria-pressed', String(active));
    pollutionInspectToggle.textContent = active ? 'Click the map · Esc to cancel' : 'Inspect an area';
    canvas.style.cursor = active ? 'crosshair' : '';
    if (!active) {
      requestGroundPick(null);
      return;
    }
    requestGroundPick((x, z) => {
      pollutionInspectToggle.setAttribute('aria-pressed', 'false');
      pollutionInspectToggle.textContent = 'Inspect an area';
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      if (!pollutionState.studyReady) {
        pollutionInspectResult.textContent = 'Run a dispersion study first.';
      } else {
        const cell = pollutionCell(x, z);
        if (!cell || typeof cell !== 'object') pollutionInspectResult.textContent = 'Outside the modelled city area.';
        else {
          let seconds = 0;
          for (let bin = 0; bin <= Math.ceil(pollutionState.timeS / 5) - 1; bin += 1) seconds += pollutionState.exposureBins[bin]?.[cell.index] || 0;
          const smoothedValue = pollutionState.currentExposureSmooth?.[cell.index] || 0;
          if (pollutionState.sourceMode === 'traffic') {
            pollutionState.receivingArea = { x, z, radiusM: Number(pollutionAreaRadius?.value) || 100 };
            buildPollutionReceivingAreaMarker();
            updatePollutionResults();
          }
          if (!(smoothedValue > 0)) {
            pollutionInspectResult.textContent = 'No pollutant residence was recorded in this cell at this timeline position. The full-run source roads for the selected area are listed below, if any. This sample cannot establish that the air is clean.';
          } else {
            const tier = pollutionTier(smoothedValue);
            const location = pollutionState.sourceMode === 'traffic'
              ? nearestPollutionRoadName(x, z)
              : { name: `${Math.hypot(x - pollutionState.source[0], z - pollutionState.source[1]).toFixed(0)} m from the source`, distance: Infinity };
            pollutionInspectResult.textContent = `${POLLUTION_TIER_NAMES[tier] || 'Lower'} overall pollutant band · ${location.name}${Number.isFinite(location.distance) ? ` (${Math.round(location.distance)} m)` : ''}. The unblurred cell total is ${seconds.toFixed(3)} emission-weighted parcel-seconds. ${pollutionState.sourceMode === 'traffic' ? 'Source roads for the selected receiving area are listed below.' : 'Bands rank positive cells across this run.'} This is not an ambient concentration.`;
          }
        }
      }
      pollutionInspectResult.hidden = false;
      requestRender();
    });
  });
  pollutionScaleReference?.addEventListener('click', () => {
    if (!pollutionState.studyReady || pollutionState.sourceMode !== 'traffic' || !pollutionState.runExposureThresholds) return;
    pollutionComparisonScale = [...pollutionState.runExposureThresholds];
    summarizePollutionExposure();
    buildPollutionSurface();
    updatePollutionResults();
    requestRender();
  });
  pollutionAreaRadius?.addEventListener('change', () => {
    if (!pollutionState.receivingArea) return;
    pollutionState.receivingArea.radiusM = Number(pollutionAreaRadius.value) || 100;
    if (pollutionState.studyReady) {
      buildPollutionReceivingAreaMarker();
      updatePollutionResults();
      requestRender();
    }
  });

  windDirectionPresets.forEach(button => button.addEventListener('click', () => {
    const directionDeg = Number(button.dataset.windDirection);
    if (!findCfdCase(directionDeg)) return;
    windState.direction = directionDeg;
    if (pollutionDirection) pollutionDirection.value = String(directionDeg);
    windDirectionPresets.forEach(item => item.classList.toggle('active', Number(item.dataset.windDirection) === directionDeg));
    if (windState.analysisMode === 'pollution') {
      windState.field = null;
      clearWindSimulation();
      buildPollutionSourceMarker();
      windStatus.textContent = `${button.textContent} selected · run the dispersion study when ready.`;
      requestRender();
    } else if (windState.analysisMode === 'direction') {
      void loadCfdWind(directionDeg);
    }
  }));
  windFlowlinesVisible?.addEventListener('change', event => {
    windState.flowlinesVisible = event.target.checked;
    if (windState.cfdView === 'flow' && windState.flowlinesVisible) resetWindParticles();
    else if (windPoints) windPoints.visible = false;
    requestRender();
  });
  windGroundMotion?.addEventListener('change', event => {
    windState.groundMotionVisible = event.target.checked;
    requestRender();
  });
  windGroundAnimationSpeed?.addEventListener('input', event => {
    windState.animationSpeed = Number(event.target.value) / 100;
    if (windGroundAnimationSpeedValue) windGroundAnimationSpeedValue.textContent = `${event.target.value}%`;
    if (windAnimationSpeed) windAnimationSpeed.value = event.target.value;
    if (windAnimationSpeedValue) windAnimationSpeedValue.textContent = `${event.target.value}%`;
  });
  windInspectToggle?.addEventListener('click', () => {
    const active = windInspectToggle.getAttribute('aria-pressed') !== 'true';
    windInspectToggle.setAttribute('aria-pressed', String(active));
    windInspectToggle.textContent = active ? 'Click the map…' : 'Inspect a place';
    canvas.style.cursor = active ? 'crosshair' : '';
    if (windInspectResult) {
      windInspectResult.textContent = active ? 'Click a point on the map to inspect it.' : 'Map inspection is off.';
      windInspectResult.hidden = false;
    }
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
    if (windGroundAnimationSpeed) windGroundAnimationSpeed.value = event.target.value;
    if (windGroundAnimationSpeedValue) windGroundAnimationSpeedValue.textContent = `${event.target.value}%`;
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
    if (windFlowBoxControls) {
      windFlowBoxControls.hidden = windState.cfdView !== 'flow';
      if (windState.cfdView === 'flow') windFlowBoxControls.open = true;
    }
    if (windState.cfd && (windState.cfdView === 'flow'
      || (windState.cfdView === 'ground' && windState.cfdField === 'speed'))) resetWindParticles();
    updateWindBox();
    void buildCfdView();
    if (windState.cfd) {
      windStatus.textContent = windState.cfdView === 'ground'
        ? `${windState.cfdGroundHeight.toFixed(1)} m · terrain-following field`
        : windState.cfdView === 'slice'
          ? 'Adjust the slice plane and crop.'
          : windState.cfdView === 'facade'
            ? 'OpenFOAM pressure on solved façades.'
            : '3D pathlines · drag the box to move it.';
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
    void buildCfdView();
    if (windState.cfd && windState.cfdView === 'ground' && windState.cfdField === 'speed') resetWindParticles();
    requestRender();
  });
  windCfdGroundHeight?.addEventListener('change', event => {
    windState.cfdGroundHeight = Number(event.target.value) || 2;
    void buildCfdPedestrianSurface();
    windStatus.textContent = `${windState.cfdGroundHeight.toFixed(1)} m · terrain-following field`;
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

  addEventListener('climate-wind-baseline-saved', event => {
    designWindBaseline = event.detail || null;
    updateDesignWindPreview();
    requestRender();
  });
  addEventListener('climate-wind-baseline-cleared', () => {
    designWindBaseline = null;
    updateDesignWindPreview();
    requestRender();
  });
  windToggle?.addEventListener('change', event => {
    if (event.target.checked && heatGroup.visible) {
      if (heatToggle) heatToggle.checked = false;
      setHeatMode(false);
    }
    windState.enabled = event.target.checked;
    windGroup.visible = windState.enabled;
    syncWindBuildingDetail();
    updateDesignWindPreview();
    if (!windState.enabled) windFocusMarker.visible = false;
    syncGroundSurfaceMaterials();
    syncLayerControls();
    if (windState.enabled) {
      if (windState.field && windState.surfaceVisible) hideStreetLayersForWind();
      if (['direction', 'pollution'].includes(windState.analysisMode)
        && !windSimulate.disabled
        && (!windState.cfd || Math.round(windState.cfd.manifest.direction_deg_from) !== Math.round(windState.direction))) loadCfdWind();
    } else {
      restoreStreetLayersAfterWind();
    }
    windStatus.textContent = windState.enabled
      ? (windState.analysisMode === 'pollution'
      ? 'Pollutant dispersal view shown · run the overall pollutant heat map.'
        : windState.field ? 'Existing wind heatmap and gusts shown.' : '3D domain ready · position it, then simulate.')
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
  windComfortCriterion?.addEventListener('change', event => {
    windState.comfortCriterionId = event.target.value;
    windState.field = null;
    clearWindSimulation();
    windStatus.textContent = 'Comfort criterion changed · calculating its wind-rose categories.';
    if (windState.enabled && windState.analysisMode === 'comfort') simulateWind();
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
  trafficSeedCount?.addEventListener('change', () => invalidateTrafficResult('Random-seed sample changed · run the comparison again.'));
  trafficControlModel?.addEventListener('change', () => invalidateTrafficResult('Junction behaviour changed · run the comparison again.'));
  trafficOneWayToggle?.addEventListener('change', () => {
    trafficState.oneWay = Boolean(trafficOneWayToggle.checked);
    invalidateTrafficResult('One-way conversion changed · run the comparison again.');
  });
  trafficFlipDirection?.addEventListener('click', flipTrafficDirection);
  trafficRefresh?.addEventListener('click', () => {
    void loadTrafficRoads();
    void loadTrafficLive(true);
  });
  trafficDrawLane?.addEventListener('click', () => beginTrafficDrawing('lane'));
  trafficDrawRoad?.addEventListener('click', () => beginTrafficDrawing('full'));
  trafficDrawOneWay?.addEventListener('click', () => beginTrafficDrawing('oneway'));
  trafficDrawConfirm?.addEventListener('click', confirmTrafficDrawing);
  trafficDrawCancel?.addEventListener('click', clearTrafficSelection);
  trafficSelectionList?.addEventListener('click', event => {
    const button = event.target.closest('[data-traffic-edge-id]');
    if (!button) return;
    removeTrafficSelectionById(button.dataset.trafficEdgeId);
  });
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
    syncLayerControls();
    if (trafficState.enabled) {
      trafficState.lastTime = performance.now();
      requestRender();
    }
  });
  trafficRestrictionsToggle?.addEventListener('change', () => {
    syncTrafficSceneVisibility();
    requestRender();
  });
  function openWindWithDefaultCase() {
    // Opening Wind is an invitation to explore the live directional CFD
    // layer. Put the panel in that mode and show the map automatically; the
    // ground motion control remains on by default for its moving tracers.
    if (windState.analysisMode !== 'direction') setWindAnalysisMode('direction');
    if (windToggle && !windToggle.checked) {
      windToggle.checked = true;
      windToggle.dispatchEvent(new Event('change'));
    }
    if (windDirection) windDirection.value = String(windState.direction);
    windDirectionPresets.forEach(button => {
      button.classList.toggle('active', Number(button.dataset.windDirection) === windState.direction);
    });
    windCfdViewButtons.forEach(button => {
      const active = button.dataset.cfdView === windState.cfdView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (windState.analysisMode === 'direction' && !windSimulate?.disabled) {
      if (!windState.cfd
        || Math.round(windState.cfd.manifest.direction_deg_from) !== Math.round(windState.direction)) {
        void loadCfdWind(windState.direction);
      } else if (!windHeatMesh && !windCfdSlice && !windFacadePressure) {
        void buildCfdView().then(() => {
          primeWindSurfaceMotion();
          resetWindParticles();
          requestRender();
        });
      }
    }
  }
  addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (reportAreaPickMode || reportAreaDrag) {
      event.preventDefault();
      reportAreaPickMode = false;
      reportAreaDrag = null;
      clickCandidate = null;
      drag = null;
      canvas.style.cursor = '';
      updateReportAreaOutline(reportAreaBounds);
      dispatchEvent(new CustomEvent('climate-report-area-pick-cancelled', { detail: { reason: 'escape' } }));
      return;
    }
    if (groundPickHandler) {
      event.preventDefault();
      const handler = groundPickHandler;
      requestGroundPick(null);
      if (pollutionPickSource) {
        pollutionPickSource.setAttribute('aria-pressed', 'false');
        pollutionPickSource.textContent = 'Place source on map';
      }
      if (pollutionInspectToggle) {
        pollutionInspectToggle.setAttribute('aria-pressed', 'false');
        pollutionInspectToggle.textContent = 'Inspect an area';
      }
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
    if (name !== 'viewshed' && viewshedPersonCamera) setViewshedPersonView(false);
    viewshedState.active = name === 'viewshed';
    viewshedState.pickMode = viewshedState.active;
    if (viewshedState.active) void ensureLightingInventory(false);
    viewshedState.group.visible = viewshedState.active && Boolean(viewshedState.point);
    viewshedPickButton?.setAttribute('aria-pressed', String(viewshedState.pickMode));
    if (viewshedState.active) {
      canvas.style.cursor = 'crosshair';
      if (viewshedStatus && !viewshedState.point) viewshedStatus.textContent = 'Click the terrain, a roof, or a building face to place the observer.';
    } else if (!placeInspectorPickMode && !groundPickHandler) canvas.style.cursor = '';
    syncGroundSurfaceMaterials();
    requestRender();
    if (name === 'wind') {
      openWindWithDefaultCase();
    }
    if (name !== 'wind' && windState.analysisMode === 'pollution') {
      pollutionState.playing = false;
        if (pollutionPlay && pollutionState.studyReady) pollutionPlay.textContent = 'Play timeline';
      if (!pollutionState.studyReady && windSimulate?.disabled) {
        pollutionStudyRevision += 1;
        windSimulate.disabled = false;
        windSimulate.textContent = pollutionRunActionLabel();
      }
      if (pollutionPickSource?.getAttribute('aria-pressed') === 'true'
        || pollutionInspectToggle?.getAttribute('aria-pressed') === 'true') {
        requestGroundPick(null);
        pollutionPickSource?.setAttribute('aria-pressed', 'false');
        pollutionPickSource.textContent = 'Place source on map';
        pollutionInspectToggle?.setAttribute('aria-pressed', 'false');
        pollutionInspectToggle.textContent = 'Inspect an area';
        canvas.style.cursor = '';
      }
    }
    if (name === 'traffic') {
      if (!trafficState.networkEdges.length) void loadTrafficRoads();
      void loadTrafficLive(false);
      void loadTrafficCalibrationStatus();
    }
    if (name === 'transport') void ensureTransportLayer();
    transportLayer?.setSceneVisible(name !== 'viewshed');
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
      if (name === 'heat') {
        if (heatToggle && !heatToggle.checked) {
          heatToggle.checked = true;
          setHeatMode(true);
        }
        if (!heatLoaded) void loadHeat(heatMetric?.value);
      } else if (name === 'sun' && !shadowState.enabled) {
        setShadowMode(true);
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
    if (name !== 'viewshed' && document.body.classList.contains('viewshed-mode')) restoreNormalVisibility();
    applySectionLayerProfile(name);
    if (name === 'viewshed') {
      setViewshedContextMaterials(true);
      void ensurePublicRealm();
      setSunMaterials(true);
      document.body.classList.add('viewshed-mode');
    } else if (document.body.classList.contains('viewshed-mode')) {
      setViewshedContextMaterials(false);
      setSunMaterials(shadowState.enabled);
      document.body.classList.remove('viewshed-mode');
    }
    syncLayerControls();
    if (name === 'wind' && windState.analysisMode === 'pollution') {
      layerGroups.roads.visible = true;
      layerGroups.paths.visible = true;
      syncLayerControls();
      refreshTransportVehicleLayers();
    }
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
  const walkingRouteColors = { fastest: 0xb99cff, least_sun: 0x42d8cf, lowest_heat: 0xff8465 };
  let walkingRoutes = [];
  let selectedWalkingRoute = 'fastest';
  let walkingPoints = { origin: null, destination: null };
  let localNotes = [];
  const walkingReplayMarker = new THREE.Mesh(
    new THREE.SphereGeometry(4.2, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }),
  );
  walkingReplayMarker.visible = false;
  walkingReplayMarker.renderOrder = 1003;
  scene.add(walkingReplayMarker);
  const clearWalkingRouteGroup = () => {
    for (const child of [...walkingRouteGroup.children]) {
      walkingRouteGroup.remove(child);
      disposeObject(child);
    }
  };
  const routeRibbon = (points, width, color, opacity, order) => {
    const vertices = [];
    const sides = points.map((point, index) => {
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const dx = after.x - before.x;
      const dz = after.z - before.z;
      const length = Math.hypot(dx, dz) || 1;
      const ox = -dz / length * width / 2;
      const oz = dx / length * width / 2;
      return [
        [point.x + ox, terrainHeightAt(point.x + ox, point.z + oz) + 2.3, point.z + oz],
        [point.x - ox, terrainHeightAt(point.x - ox, point.z - oz) + 2.3, point.z - oz],
      ];
    });
    for (let index = 1; index < sides.length; index += 1) {
      const [a, b] = sides[index - 1];
      const [c, d] = sides[index];
      vertices.push(...a, ...b, ...c, ...b, ...d, ...c);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = order;
    return mesh;
  };
  const drawWalkingRoutes = () => {
    clearWalkingRouteGroup();
    for (const route of [...walkingRoutes].sort((a, b) => Number(a.id === selectedWalkingRoute) - Number(b.id === selectedWalkingRoute))) {
      const coordinates = route.geometry || [];
      if (coordinates.length < 2) continue;
      const color = walkingRouteColors[route.id] || 0xe8e8e8;
      const selected = route.id === selectedWalkingRoute;
      const points = coordinates.map(([x, z]) => new THREE.Vector3(
        Number(x), terrainHeightAt(Number(x), Number(z)) + 2.1, Number(z),
      ));
      const outline = routeRibbon(points, selected ? 9 : 5, 0x071719, selected ? 0.94 : 0.5, selected ? 1000 : 998);
      const ribbon = routeRibbon(points, selected ? 6.5 : 2.7, color, selected ? 1 : 0.55, selected ? 1001 : 999);
      ribbon.userData.walkingRouteId = route.id;
      walkingRouteGroup.add(outline, ribbon);
    }
    for (const [role, markerColor] of [['origin', 0x77d89d], ['destination', 0xf39d73]]) {
      const point = walkingPoints[role];
      if (!point) continue;
      const markerPosition = new THREE.Vector3(Number(point.x), terrainHeightAt(Number(point.x), Number(point.z)) + 7, Number(point.z));
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(6.2, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }),
      );
      halo.position.copy(markerPosition);
      halo.renderOrder = 1002;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(4.8, 16, 12),
        new THREE.MeshBasicMaterial({ color: markerColor, depthTest: false, depthWrite: false }),
      );
      marker.position.copy(markerPosition);
      marker.renderOrder = 1003;
      walkingRouteGroup.add(halo, marker);
    }
    requestRender();
  };
  addEventListener('climate-route-pick-request', event => {
    const role = event.detail?.role;
    requestGroundPick(role ? (x, z) => dispatchEvent(new CustomEvent('climate-route-point', { detail: { role, x, z } })) : null);
  });
  addEventListener('climate-local-note-pick-mode', event => {
    requestGroundPick(event.detail?.enabled
      ? (x, z) => dispatchEvent(new CustomEvent('climate-local-note-point', { detail: { x, z } }))
      : null);
  });
  addEventListener('climate-local-notes', event => {
    localNotes = Array.isArray(event.detail) ? event.detail : [];
    for (const child of [...localNotesGroup.children]) {
      localNotesGroup.remove(child);
      disposeObject(child);
    }
    for (const note of localNotes) {
      const marker = new THREE.Group();
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.75, 1, 11, 8),
        new THREE.MeshBasicMaterial({ color: 0xffb900, depthTest: false, depthWrite: false }),
      );
      stem.position.y = 5.5;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(4.5, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffd34e, depthTest: false, depthWrite: false }),
      );
      head.position.y = 13;
      marker.add(stem, head);
      marker.position.set(Number(note.x), terrainHeightAt(Number(note.x), Number(note.z)), Number(note.z));
      marker.renderOrder = 1004;
      localNotesGroup.add(marker);
    }
    requestRender();
  });
  addEventListener('climate-walking-routes', event => {
    walkingRoutes = event.detail?.routes || [];
    selectedWalkingRoute = walkingRoutes.some(route => route.id === selectedWalkingRoute)
      ? selectedWalkingRoute : walkingRoutes[0]?.id;
    drawWalkingRoutes();
  });
  addEventListener('climate-walking-route-select', event => {
    selectedWalkingRoute = event.detail?.routeId || 'fastest';
    drawWalkingRoutes();
  });
  addEventListener('climate-walking-points', event => {
    walkingPoints = event.detail || { origin: null, destination: null };
    drawWalkingRoutes();
  });
  addEventListener('climate-walking-progress', event => {
    const point = event.detail?.point;
    walkingReplayMarker.visible = Boolean(point);
    if (point) walkingReplayMarker.position.set(Number(point[0]), terrainHeightAt(Number(point[0]), Number(point[1])) + 6, Number(point[1]));
    requestRender();
  });
  addEventListener('climate-walking-routes-clear', () => {
    walkingRoutes = [];
    walkingReplayMarker.visible = false;
    drawWalkingRoutes();
  });
  addEventListener('climate-walking-clear', () => {
    walkingRoutes = [];
    selectedWalkingRoute = 'fastest';
    walkingPoints = { origin: null, destination: null };
    walkingReplayMarker.visible = false;
    clearWalkingRouteGroup();
    requestGroundPick(null);
    requestRender();
  });
  addEventListener('climate-current-weather', event => {
    const weather = event.detail || {};
    updateWeatherSky(weather);
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
      if (sunAnalysisDate) sunAnalysisDate.value = shadowState.date;
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
  addEventListener('climate-weather-sky', event => {
    const weather = event.detail || {};
    if (!skyWeather && weather.valid_at) {
      const valid = new Date(weather.valid_at);
      if (!Number.isNaN(valid.getTime())) {
        shadowState.date = valid.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(valid);
        const hour = Number(parts.find(part => part.type === 'hour')?.value || 12);
        const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
        shadowState.minutes = Math.round((hour * 60 + minute) / 10) * 10;
        if (sunDate) sunDate.value = shadowState.date;
        if (sunAnalysisDate) sunAnalysisDate.value = shadowState.date;
        if (sunTime) sunTime.value = String(shadowState.minutes);
      }
    }
    updateWeatherSky(weather, sunPosition());
    updateSunStatus();
    requestRender();
  });

  function render(now = performance.now()) {
    animationFrame = 0;
    if (document.hidden) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (cameraIntro) {
      const progress = clamp((now - cameraIntro.startedAt) / cameraIntro.duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      cameraState.distance = cameraIntro.startDistance + (cameraIntro.endDistance - cameraIntro.startDistance) * eased;
      cameraState.elevation = cameraIntro.startElevation + (cameraIntro.endElevation - cameraIntro.startElevation) * eased;
      const horizontal = Math.cos(cameraState.elevation) * cameraState.distance;
      camera.position.set(
        cameraState.target.x + Math.cos(cameraState.azimuth) * horizontal,
        cameraState.target.y + Math.sin(cameraState.elevation) * cameraState.distance,
        cameraState.target.z + Math.sin(cameraState.azimuth) * horizontal,
      );
      camera.lookAt(cameraState.target);
      const atmosphereScale = Math.max(1, cameraState.distance / 1600);
      scene.fog.near = 1900 * atmosphereScale;
      scene.fog.far = 4600 * atmosphereScale;
      updateMapHud();
      if (progress >= 1) {
        cameraIntro = null;
        updateCamera();
      }
    }
    resize();
    updateStreetNameLabels();
    resizePostProcessing();
    skySphere.visible = shadowState.enabled && !viewshedState.active;
    skySphere.position.copy(camera.position);
    skyUniforms.cloudTime.value = now * 0.001;
    const demolitionAnimating = updateDemolitionAnimations(now);
    const windSurfaceAnimating = updateWindSurfaceMotion(now);
    updateWindParticles(now);
    updatePollutionVisuals(now);
    updateTrafficCars(now);
    updateAmbientTraffic(now);
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
    renderer.setRenderTarget(postTarget);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(postScene, postCamera);
    renderRequested = false;
    scheduleAmbientTrafficSetup();
    const ambientTrafficAnimating = Boolean(ambientTraffic.group?.visible && layerGroups.roads.visible
      && cameraState.distance <= ambientTrafficAnimationDistance);
    const otherAnimatedLayerActive = demolitionAnimating || windSurfaceAnimating || (windState.enabled && windState.field && windPoints?.visible)
      || (windState.enabled && pollutionState.playing)
      || (trafficGroup.visible && trafficState.tracks.length)
      || (trafficStatusGroup.visible && scenarioStatusGroup.children.length);
    const animatedLayerActive = ((!reducedMotion || pollutionState.playing)
      && (otherAnimatedLayerActive || transportAnimating || ambientTrafficAnimating)) || Boolean(cameraIntro);
    if (animatedLayerActive) {
      if (((transportAnimating && !otherAnimatedLayerActive)
        || (ambientTrafficAnimating && !otherAnimatedLayerActive && !transportAnimating)) && !reducedMotion) {
        animationTimer = window.setTimeout(() => {
          animationTimer = 0;
          if (sceneReadyToRender && !document.hidden && !animationFrame) animationFrame = requestAnimationFrame(render);
        }, 1000 / 18);
      } else {
        animationFrame = requestAnimationFrame(render);
      }
    } else if (!reducedMotion && skySphere.visible && skyUniforms.cloudCover.value > 0.03
      && cameraState.elevation < THREE.MathUtils.degToRad(camera.fov * 0.5) + 0.08) {
      // Only animate clouds while a portion of the real upper sky is in view.
      animationTimer = window.setTimeout(() => {
        animationTimer = 0;
        if (sceneReadyToRender && !document.hidden && !animationFrame) animationFrame = requestAnimationFrame(render);
      }, 1000 / 8);
    } else if (!reducedMotion && transportLayer?.needsIdleTick()) {
      animationTimer = window.setTimeout(() => {
        animationTimer = 0;
        if (sceneReadyToRender && !document.hidden && !animationFrame) animationFrame = requestAnimationFrame(render);
      }, 500);
    }
  }

  addEventListener('resize', requestRender);
  addEventListener('climate-wind-focus', event => {
    const x = Number(event.detail?.x), z = Number(event.detail?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    windFocusMarker.position.set(x, terrainHeightAt(x, z), z);
    windFocusMarker.visible = true;
    const label = String(event.detail?.name || 'Selected location');
    const speed = Number(event.detail?.speed);
    const focusStatus = document.querySelector('#wind-focus-status');
    if (focusStatus) focusStatus.textContent = Number.isFinite(speed)
      ? `Highlighted ${label} · ${speed.toFixed(2)} m/s (${(speed * 3.6).toFixed(1)} km/h).`
      : `Highlighted ${label} on the map.`;
    if (event.detail?.focusCamera) {
      cameraState.target.set(x, terrainHeightAt(x, z) + 18, z);
      cameraState.distance = Math.max(CAMERA_MIN_DISTANCE, 520);
      updateCamera();
    } else requestRender();
  });
  addEventListener('climate-wind-focus-clear', () => {
    windFocusMarker.visible = false;
    requestRender();
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-menu-target]')) requestRender();
  });
  addEventListener('visibilitychange', () => { if (!document.hidden) requestRender(); });
  addEventListener('climate-retry-analysis', event => {
    const tool = event.detail?.tool;
    if (tool === 'heat') void loadHeat();
    if (tool === 'sun') { if (shadowState.mode === 'hours') void generateSunHours(); else generateShadows(); }
    if (tool === 'wind') void simulateWind();
    if (tool === 'traffic') {
      void loadTrafficRoads();
      void loadTrafficLive(false);
      void loadTrafficCalibrationStatus();
    }
    if (tool === 'transport') void ensureTransportLayer();
  });
  fitScene({ intro: true });
  setWindAnalysisMode(windState.analysisMode);
  updateWindBox();
  windGroup.visible = windState.enabled;
  syncTrafficSceneVisibility();
  const roofTriangles = roofSurfaceBuffer ? manifest.layers?.roof_surface?.triangles : 0;
  const roofStatus = roofTriangles ? `${roofTriangles.toLocaleString()} detailed roof triangles · `
    : manifest.assets?.roof_surface ? 'detailed roof surfaces loading · ' : '';
  status.textContent = `${data.buildings.length} buildings · ${railwayCount} railway lines · ${roofStatus}${canopyCount} canopy footprints`;
  updateSunStatus();
  if (document.querySelector('[data-menu-target="sun"]')?.classList.contains('active')) showCurrentSun();
  if (document.querySelector('[data-menu-target="heat"]')?.classList.contains('active')) {
    void loadHeat(heatMetric?.value);
  }
  setHeatMode(Boolean(heatToggle?.checked));
  applySectionLayerProfile(document.querySelector('[data-menu-target].active')?.dataset.menuTarget || 'tools');
  let thermalManifestPollInFlight = false;
  setInterval(async () => {
    const panel = document.querySelector('#menu-heat');
    if (document.hidden || panel?.hidden || !thermalManifest || heatPeriod?.value === 'climatology'
      || !['utci_c', 'tmrt_c'].includes(heatMetric?.value) || thermalManifestPollInFlight) return;
    thermalManifestPollInFlight = true;
    try {
      const response = await fetch(`${windApi}/thermal/forecast`, { cache: 'no-store' });
      if (!response.ok) return;
      const latest = await response.json();
      if (latest.available && latest.run_id !== thermalManifest.run_id) {
        // Reload only after the hourly worker publishes a complete new run.
        thermalManifest = null;
        thermalEnergy = null;
        void loadHeat(heatMetric.value);
      }
    } catch {
      // Keep the currently displayed forecast if metadata polling is offline.
    } finally {
      thermalManifestPollInFlight = false;
    }
  }, 300000);
  if (trafficState.sceneActive) {
    void loadTrafficRoads();
    void loadTrafficLive(false);
    void loadTrafficCalibrationStatus();
  }
  async function ensureTransportLayer() {
    if (transportLayer) return transportLayer;
    if (transportLoading) return transportLoading;
    transportLoading = createTransportLayer({
      THREE, scene, terrainHeightAt, terrainValidAt, requestRender, frameBounds,
      requestGroundPick, addScenePickHandler,
      layerVisible: name => Boolean(layerGroups[name]?.visible),
    }).then(layer => {
      transportLayer = layer;
      layer.setSceneVisible(!viewshedState.active);
      layer.setPanelActive(document.querySelector('[data-menu-target].active')?.dataset.menuTarget === 'transport');
      requestRender();
      return layer;
    }).catch(error => {
      const transportStatus = document.querySelector('#transport-status');
      if (transportStatus) transportStatus.textContent = `Transport unavailable (${error.message}). Reopen this tab to retry.`;
    }).finally(() => { transportLoading = null; });
    return transportLoading;
  }
  const initialPanel = document.querySelector('[data-menu-target].active')?.dataset.menuTarget;
  if (initialPanel === 'viewshed') {
    viewshedState.active = true;
    viewshedState.pickMode = true;
    viewshedPickButton?.setAttribute('aria-pressed', 'true');
    if (viewshedStatus) viewshedStatus.textContent = 'Click the terrain, a roof, or a building face to place the observer.';
    canvas.style.cursor = 'crosshair';
    applySectionLayerProfile('viewshed');
    setViewshedContextMaterials(true);
    void ensurePublicRealm();
    void ensureLightingInventory(false);
    setSunMaterials(true);
    document.body.classList.add('viewshed-mode');
  }
  if (initialPanel === 'transport') await ensureTransportLayer();
  if (initialPanel === 'wind') {
    openWindWithDefaultCase();
  }
  sceneReadyToRender = true;
  requestRender();
  if (savedVisibility.publicRealm) {
    const beginPublicRealmLoad = () => { if (savedVisibility.publicRealm) void ensurePublicRealm(); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(beginPublicRealmLoad, { timeout: 1800 });
    else setTimeout(beginPublicRealmLoad, 400);
  }
  // The municipal inventory contains thousands of records. The camera loads
  // only its nearby area on close zoom; analysis views request their current
  // area explicitly.
  addEventListener('climate-viewer-ready', () => {
    const beginRoofLoad = () => {
      void loadRoofSurface().then(buffer => {
        if (!buffer || !buffer.byteLength) {
          status.textContent = `${data.buildings.length} buildings · ${railwayCount} railway lines · detailed roof surfaces unavailable · ${canopyCount} canopy footprints`;
          return;
        }
        roofSurfaceBuffer = buffer;
        for (const mesh of [buildingMeshes.walls, buildingMeshes.roofs, buildingMeshes.surface].filter(Boolean)) {
          layerGroups.buildings.remove(mesh);
          mesh.geometry.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach(material => material.dispose());
          else mesh.material.dispose();
          mesh.userData.normalMaterial?.dispose();
          mesh.userData.sunMaterial?.dispose();
        }
        buildingMeshes = makeBuildings();
        buildingMeshes.surface = makeDetailedRoofSurface();
        syncWindBuildingDetail();
        setBuildingAppearance(buildingAppearance?.value || 'neutral');
        setBuildingDrawTransparency(buildingDrawTransparencyEnabled);
        setSunMaterials(shadowState.enabled || viewshedState.active);
        const triangles = manifest.layers?.roof_surface?.triangles || 0;
        status.textContent = `${data.buildings.length} buildings · ${railwayCount} railway lines · ${triangles ? `${triangles.toLocaleString()} detailed roof triangles · ` : ''}${canopyCount} canopy footprints`;
        requestRender();
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(beginRoofLoad, { timeout: 1500 });
    else setTimeout(beginRoofLoad, 250);
  }, { once: true });
  void ensureTransportLayer().then(layer => layer?.setAmbientDisplay(true));

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
  let viewshedRefreshTimer = 0;
  const refreshViewshed = () => {
    window.clearTimeout(viewshedRefreshTimer);
    viewshedRefreshTimer = window.setTimeout(() => {
      viewshedRefreshTimer = 0;
      if (viewshedState.point) buildViewshed(viewshedState.point.x, viewshedState.point.z, viewshedState.point.placement);
    }, 120);
  };
  viewshedRadius?.addEventListener('input', () => {
    viewshedState.radius = Number(viewshedRadius.value) || 500;
    if (viewshedRadiusValue) viewshedRadiusValue.textContent = `${viewshedState.radius} m`;
    refreshViewshed();
  });
  const compassLabel = bearing => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];
  viewshedShape?.addEventListener('change', () => {
    viewshedState.shape = viewshedShape.value === 'full' ? 'full' : 'cone';
    refreshViewshed();
  });
  viewshedHeading?.addEventListener('input', () => {
    viewshedState.heading = Number(viewshedHeading.value) || 0;
    if (viewshedHeadingValue) viewshedHeadingValue.textContent = `${viewshedState.heading}° · ${compassLabel(viewshedState.heading)}`;
    if (viewshedPersonCamera) {
      updateCamera();
      requestRender();
    }
    refreshViewshed();
  });
  viewshedSpread?.addEventListener('input', () => {
    viewshedState.spread = Number(viewshedSpread.value) || 60;
    if (viewshedSpreadValue) viewshedSpreadValue.textContent = `${viewshedState.spread}°`;
    refreshViewshed();
  });
  viewshedHeight?.addEventListener('input', () => {
    viewshedState.eyeHeight = Number(viewshedHeight.value) || 1.7;
    if (viewshedHeightValue) viewshedHeightValue.textContent = `${viewshedState.eyeHeight.toFixed(1)} m`;
    refreshViewshed();
  });
  viewshedPickButton?.addEventListener('click', () => {
    viewshedState.active = true;
    viewshedState.pickMode = true;
    canvas.style.cursor = 'crosshair';
    viewshedPickButton.setAttribute('aria-pressed', 'true');
    if (viewshedStatus) viewshedStatus.textContent = viewshedState.point
      ? 'Click the map to move the observer and recalculate.'
      : 'Click the terrain, a roof, or a building face to place the observer.';
  });
  viewshedPersonButton?.addEventListener('click', () => setViewshedPersonView(!viewshedPersonCamera));
  document.querySelector('#viewshed-clear')?.addEventListener('click', clearViewshedResult);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !viewshedState.pickMode) return;
    viewshedState.pickMode = false;
    viewshedPickButton?.setAttribute('aria-pressed', 'false');
    canvas.style.cursor = '';
    if (viewshedStatus) viewshedStatus.textContent = viewshedState.point
      ? 'Viewshed retained. Select Pick viewpoint to move the observer.'
      : 'Pick mode cancelled.';
  });

  attachSceneExperience({
    canvas, requestRender, fitScene,
    readCamera: () => ({ azimuth: cameraState.azimuth, elevation: cameraState.elevation, distance: cameraState.distance,
      x: cameraState.target.x, y: cameraState.target.y, z: cameraState.target.z }),
    writeCamera: c => { Object.assign(cameraState, { azimuth: c.azimuth, elevation: c.elevation, distance: c.distance }); cameraState.target.set(c.x, c.y, c.z); updateCamera(); },
    useLocation: (tool, point) => {
      if (!terrainValidAt(point.x, point.z)) return;
      const state = tool === 'sun' ? shadowState : windState;
      const half = state.size / 2;
      state.center = [clamp(point.x, left + half, right - half), clamp(point.z, minZ + half, maxZ - half)];
      if (tool === 'sun') { cancelSunHours('Analysis centre changed · calculate sun hours again.'); updateSunBox(); }
      else {
        windState.flowBoxInitialized = true;
        updateWindBox();
        if (windState.analysisMode === 'direction' && windState.field) resetWindParticles();
      }
      cameraState.target.set(point.x, terrainHeightAt(point.x, point.z), point.z);
      updateCamera();
    },
  });
  attachPlaceInspector({
    buildings: data.buildings,
    roads: data.roads || [],
    onSelect: focusPlaceInspector,
    onPickMode: active => {
      placeInspectorPickMode = active;
      canvas.style.cursor = active ? 'crosshair' : '';
    },
  });
  createDesignMassing({
    THREE, scene, camera, terrainMesh, terrainSurfaceHeightAt, terrainValidAt, requestRender,
    focusPlacedBlock: (x, z) => {
      cameraState.distance = Math.min(cameraState.distance, 460);
      const right = new THREE.Vector3(Math.sin(cameraState.azimuth), 0, -Math.cos(cameraState.azimuth));
      cameraState.target.set(x, terrainSurfaceHeightAt(x, z) + 12, z)
        .addScaledVector(right, cameraState.distance * 0.14);
      updateCamera();
    },
    addScenePickHandler, canvas, buildingRecords: data.buildings, onChange: rebuildDesignGeometry,
  });
  return { renderer, scene, camera };
}
