import * as THREE from './vendor/three.module.min.js';

// Transport a display scalar on the GPU, rather than shade a fixed colour map.
// Velocity and the solid mask come from CFD. The moving display texture is a
// passive tracer, not an unsteady momentum/turbulence solve.
export function createWindSurfaceMaterial(parameters, grid) {
  const { columns, rows, samples, basisX, basisZ, sizeX, sizeZ, range, palette } = grid;
  const field = new Float32Array(columns * rows * 4);
  const turbulence = new Float32Array(columns * rows * 4);
  let maxCellsPerSecond = 0;
  samples.forEach((sample, i) => {
    if (!sample) return;
    const u = (sample.u * basisX[0] + sample.v * basisX[1]) / sizeX;
    const v = (sample.u * basisZ[0] + sample.v * basisZ[1]) / sizeZ;
    field.set([u, v, sample.speed, 1], i * 4);
    turbulence.set([Math.sqrt(2 * Math.max(0, sample.k || 0) / 3), 0, 0, 1], i * 4);
    maxCellsPerSecond = Math.max(maxCellsPerSecond, Math.abs(u) * columns, Math.abs(v) * rows);
  });
  const dataTexture = (data, width, height) => {
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
  };
  const fieldTexture = dataTexture(field, columns, rows);
  const turbulenceTexture = dataTexture(turbulence, columns, rows);
  const paletteTexture = dataTexture(palette, palette.length / 4, 1);
  const targets = [0, 1].map(() => new THREE.WebGLRenderTarget(columns, rows, {
    type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false,
  }));
  const size = new THREE.Vector2(columns, rows);
  // Normalise over valid neighbours only, including at the irregular footprint
  // and building boundaries. Never interpolate an invalid cell as zero speed.
  const sampling = `
    uniform vec2 windGridSize;
    vec4 windSample(sampler2D map, vec2 uv) {
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
      vec2 p = uv * windGridSize - 0.5;
      vec2 cell = floor(p), f = fract(p);
      vec4 sum = vec4(0.0);
      for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
        vec2 at = cell + vec2(float(x), float(y));
        if (any(lessThan(at, vec2(0.0))) || any(greaterThanEqual(at, windGridSize))) continue;
        vec4 value = texture2D(map, (at + 0.5) / windGridSize);
        float weight = (x == 0 ? 1.0-f.x : f.x) * (y == 0 ? 1.0-f.y : f.y) * value.a;
        sum += vec4(value.rgb * weight, weight);
      }
      return sum.a > 0.001 ? vec4(sum.rgb / sum.a, 1.0) : vec4(0.0);
    }
  `;
  const simulation = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: {
      windGridSize: { value: size }, field: { value: fieldTexture },
      turbulence: { value: turbulenceTexture }, previous: { value: null },
      dt: { value: 0 }, time: { value: 0 }, initialise: { value: true },
    },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D field, turbulence, previous;
      uniform float dt, time;
      uniform bool initialise;
      ${sampling}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
          mix(hash(i+vec2(0.0,1.0)),hash(i+1.0),f.x),f.y);
      }
      void main() {
        vec4 local = texture2D(field, vUv);
        if (local.a < 0.5) { gl_FragColor = vec4(0.0); return; }
        float sigma = texture2D(turbulence, vUv).r;
        // Slowly renewed source colours keep the display from diffusing into
        // a uniform tint. k controls their amplitude, not invented velocities.
        vec2 p = vUv * windGridSize;
        float n = 0.65 * noise(p / 3.5 + vec2(time / 23.0, 0.0))
                + 0.35 * noise(p / 1.7 + vec2(9.1, time / 31.0));
        float source = max(0.0, local.b + sigma * (n - 0.5) * 2.0);
        if (initialise) { gl_FragColor = vec4(source, 0.0, 0.0, 1.0); return; }
        // Midpoint backtrace. The CPU bounds each step to < half a native
        // cell, so it cannot skip across a masked wall in one update.
        vec2 midpoint = vUv - local.rg * dt * 0.5;
        vec4 middle = windSample(field, midpoint);
        vec2 departure = vUv - middle.rg * dt;
        vec4 departed = windSample(previous, departure);
        bool inside = all(greaterThanEqual(departure,vec2(0.0))) && all(lessThanEqual(departure,vec2(1.0)));
        bool openPath = inside && texture2D(field, midpoint).a > 0.5
          && texture2D(field, departure).a > 0.5 && middle.a > 0.5 && departed.a > 0.5;
        float carried = openPath ? departed.r : texture2D(previous, vUv).r;
        float value = mix(carried, source, 1.0-exp(-dt/18.0));
        gl_FragColor = vec4(max(0.0,value), 0.0, 0.0, 1.0);
      }
    `,
  });
  const simulationScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simulation);
  simulationScene.add(quad);
  const camera = new THREE.Camera();
  const material = new THREE.MeshBasicMaterial(parameters);
  const motion = { enabled: { value: 0 }, texture: { value: null }, time: { value: 0 } };
  let ready = false, current = 0, elapsed = 0;
  motion.update = (renderer, seconds) => {
    const previousTarget = renderer.getRenderTarget();
    try {
      if (!ready) {
        renderer.setRenderTarget(targets[current]);
        renderer.render(simulationScene, camera);
        simulation.uniforms.initialise.value = false;
        ready = true;
      }
      const steps = Math.max(1, Math.ceil(seconds * maxCellsPerSecond / 0.45));
      const dt = seconds / steps;
      for (let i = 0; i < steps && dt > 0; i++) {
        elapsed += dt;
        motion.time.value = elapsed;
        simulation.uniforms.dt.value = dt;
        simulation.uniforms.time.value = elapsed;
        simulation.uniforms.previous.value = targets[current].texture;
        const next = 1 - current;
        renderer.setRenderTarget(targets[next]);
        renderer.render(simulationScene, camera);
        current = next;
      }
      motion.texture.value = targets[current].texture;
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
  };
  material.userData.surfaceMotion = motion;
  material.customProgramCacheKey = () => 'wind-surface-transport-v6';
  material.onBeforeCompile = shader => {
    shader.uniforms.windMotionEnabled = motion.enabled;
    shader.uniforms.windTransport = motion.texture;
    shader.uniforms.windField = { value: fieldTexture };
    shader.uniforms.windTurbulence = { value: turbulenceTexture };
    shader.uniforms.windMotionTime = motion.time;
    shader.uniforms.windGridSize = { value: size };
    shader.uniforms.windPalette = { value: paletteTexture };
    shader.uniforms.windRange = { value: new THREE.Vector2(...range) };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `
      #include <common>
      attribute vec2 windSurfaceUv;
      varying vec2 windUv;
    `).replace('#include <begin_vertex>', `
      #include <begin_vertex>
      windUv = windSurfaceUv;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
      #include <common>
      uniform float windMotionEnabled;
      uniform sampler2D windTransport, windField, windTurbulence, windPalette;
      uniform float windMotionTime;
      uniform vec2 windRange;
      varying vec2 windUv;
      ${sampling}
      float windHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float windNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(windHash(i), windHash(i + vec2(1.0, 0.0)), f.x),
          mix(windHash(i + vec2(0.0, 1.0)), windHash(i + vec2(1.0, 1.0)), f.x), f.y);
      }

    `).replace('#include <color_fragment>', `
      #include <color_fragment>
      if (windMotionEnabled > 0.5) {
        vec4 transported = windSample(windTransport, windUv);
        if (transported.a > 0.5) {
          // A second continuous colour layer rides over the transported heatmap.
          // Aperiodic, smooth noise avoids the tight repeating ripples from the
          // old sine bands. Its drift follows the local OpenFOAM velocity;
          // solved k limits its colour excursion without changing reported speed.
          vec4 localFlow = windSample(windField, windUv);
          vec4 localTurbulence = windSample(windTurbulence, windUv);
          vec2 cells = windUv * windGridSize;
          vec2 advected = cells - localFlow.rg * windGridSize * windMotionTime;
          vec2 warp = vec2(windNoise(advected * 0.027 + vec2(13.4, 2.7)),
                           windNoise(advected * 0.027 + vec2(5.1, 21.8))) - 0.5;
          float broad = windNoise((advected + warp * 7.0) * 0.035);
          float detail = windNoise((advected + warp * 4.0) * 0.082 + vec2(17.0, 8.0));
          float pattern = broad * 0.72 + detail * 0.28;
          float rangeSpan = max(windRange.y-windRange.x, 0.001);
          float amplitude = min(localTurbulence.r * 0.9, rangeSpan * 0.22);
          float visualSpeed = clamp(transported.r + (pattern - 0.5) * 2.0 * amplitude,
            windRange.x, windRange.y);
          float t = clamp((visualSpeed-windRange.x)/rangeSpan,0.0,1.0);
          float index = t * 255.0;
          vec3 a = texture2D(windPalette, vec2((floor(index)+0.5)/256.0,0.5)).rgb;
          vec3 b = texture2D(windPalette, vec2((min(floor(index)+1.0,255.0)+0.5)/256.0,0.5)).rgb;
          diffuseColor.rgb = mix(a,b,fract(index));
        }
      }
    `);
  };
  material.addEventListener('dispose', () => {
    fieldTexture.dispose(); turbulenceTexture.dispose(); paletteTexture.dispose();
    targets.forEach(target => target.dispose());
    quad.geometry.dispose(); simulation.dispose();
  });
  return material;
}
