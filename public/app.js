let canvas = document.querySelector('#scene');
const status = document.querySelector('#status');
const contextOptions = { antialias: true, powerPreference: 'high-performance' };
const query = new URLSearchParams(location.search);
const forceWebGL1 = query.get('webgl') === '1';
const forceCanvas = query.get('renderer') === 'canvas';

function freshCanvas() {
  const replacement = canvas.cloneNode(false);
  canvas.replaceWith(replacement);
  canvas = replacement;
}

function requestContext(type) {
  return canvas.getContext(type, contextOptions) || canvas.getContext(type, { antialias: true }) || canvas.getContext(type);
}

function loadFallback(reason) {
  if (reason) console.warn('Using Canvas 2D compatibility:', reason);
  status.textContent = 'GPU rendering unavailable · loading Canvas 2D compatibility…';
  import('./fallback2d.js?v=18')
    .then(module => module.startFallback(canvas, status))
    .catch(error => {
      console.error(error);
      status.textContent = `Compatibility view failed: ${error.message}`;
    });
}

let gl = forceWebGL1 || forceCanvas ? null : requestContext('webgl2');
const isWebGL2 = Boolean(gl);
if (!gl && !forceCanvas) {
  freshCanvas();
  gl = requestContext('webgl');
}
if (!gl && !forceCanvas) {
  freshCanvas();
  gl = requestContext('experimental-webgl');
}
if (!gl) {
  freshCanvas();
  loadFallback('WebGL contexts were refused');
}

if (gl) {
try {
const vaoExtension = isWebGL2 ? null : gl.getExtension('OES_vertex_array_object');
const instancingExtension = isWebGL2 ? null : gl.getExtension('ANGLE_instanced_arrays');
const uintIndicesExtension = isWebGL2 ? true : gl.getExtension('OES_element_index_uint');
if (!isWebGL2 && (!vaoExtension || !instancingExtension || !uintIndicesExtension)) {
  status.textContent = 'This browser lacks the WebGL extensions needed by the city model.';
  throw new Error('Required WebGL extensions are unavailable.');
}

const vertexArrays = isWebGL2
  ? { create: () => gl.createVertexArray(), bind: value => gl.bindVertexArray(value) }
  : { create: () => vaoExtension.createVertexArrayOES(), bind: value => vaoExtension.bindVertexArrayOES(value) };
const setAttributeDivisor = isWebGL2
  ? (location, divisor) => gl.vertexAttribDivisor(location, divisor)
  : (location, divisor) => instancingExtension.vertexAttribDivisorANGLE(location, divisor);
const drawInstanced = isWebGL2
  ? (count, instances) => gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0, instances)
  : (count, instances) => instancingExtension.drawElementsInstancedANGLE(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0, instances);

const vertexSource = isWebGL2 ? `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
in vec3 aInstanceOffset;
in vec3 aInstanceScale;
in float aInstanceRotation;
uniform mat4 uProjection;
uniform mat4 uView;
uniform bool uInstanced;
out vec3 vNormal;
out vec3 vPosition;
void main() {
  vec3 position = aPosition;
  vec3 normal = aNormal;
  if (uInstanced) {
    float c = cos(aInstanceRotation);
    float s = sin(aInstanceRotation);
    vec3 scaled = aPosition * aInstanceScale;
    position = vec3(c * scaled.x - s * scaled.z, scaled.y, s * scaled.x + c * scaled.z) + aInstanceOffset;
    normal = normalize(vec3(c * aNormal.x - s * aNormal.z, aNormal.y, s * aNormal.x + c * aNormal.z));
  }
  vNormal = normal;
  vPosition = position;
  gl_Position = uProjection * uView * vec4(position, 1.0);
}` : `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aInstanceOffset;
attribute vec3 aInstanceScale;
attribute float aInstanceRotation;
uniform mat4 uProjection;
uniform mat4 uView;
uniform bool uInstanced;
varying vec3 vNormal;
varying vec3 vPosition;
void main() {
  vec3 position = aPosition;
  vec3 normal = aNormal;
  if (uInstanced) {
    float c = cos(aInstanceRotation);
    float s = sin(aInstanceRotation);
    vec3 scaled = aPosition * aInstanceScale;
    position = vec3(c * scaled.x - s * scaled.z, scaled.y, s * scaled.x + c * scaled.z) + aInstanceOffset;
    normal = normalize(vec3(c * aNormal.x - s * aNormal.z, aNormal.y, s * aNormal.x + c * aNormal.z));
  }
  vNormal = normal;
  vPosition = position;
  gl_Position = uProjection * uView * vec4(position, 1.0);
}`;
const fragmentSource = isWebGL2 ? `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vPosition;
uniform vec3 uColor;
uniform vec3 uLight;
uniform float uBuildingDetail;
out vec4 outColor;
void main() {
  float diffuse = max(dot(normalize(vNormal), normalize(uLight)), 0.0);
  float heightShade = clamp((vPosition.y + 10.0) / 130.0, 0.0, 1.0);
  float faceShade = 0.72 + diffuse * 0.72;
  float wallMask = 1.0 - abs(normalize(vNormal).y);
  float floorBand = smoothstep(0.82, 0.98, fract((vPosition.y + 0.4) / 3.15));
  float facadeDetail = 1.0 - uBuildingDetail * wallMask * floorBand * 0.13;
  outColor = vec4(uColor * faceShade * (0.84 + heightShade * 0.32) * facadeDetail, 1.0);
}` : `
precision highp float;
varying vec3 vNormal;
varying vec3 vPosition;
uniform vec3 uColor;
uniform vec3 uLight;
uniform float uBuildingDetail;
void main() {
  float diffuse = max(dot(normalize(vNormal), normalize(uLight)), 0.0);
  float heightShade = clamp((vPosition.y + 10.0) / 130.0, 0.0, 1.0);
  float faceShade = 0.72 + diffuse * 0.72;
  float wallMask = 1.0 - abs(normalize(vNormal).y);
  float floorBand = smoothstep(0.82, 0.98, fract((vPosition.y + 0.4) / 3.15));
  float facadeDetail = 1.0 - uBuildingDetail * wallMask * floorBand * 0.13;
  gl_FragColor = vec4(uColor * faceShade * (0.84 + heightShade * 0.32) * facadeDetail, 1.0);
}`;

function makeShader(type, source) {
  const value = gl.createShader(type);
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
  return value;
}
const program = gl.createProgram();
gl.attachShader(program, makeShader(gl.VERTEX_SHADER, vertexSource));
gl.attachShader(program, makeShader(gl.FRAGMENT_SHADER, fragmentSource));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);
const locations = {
  position: gl.getAttribLocation(program, 'aPosition'),
  normal: gl.getAttribLocation(program, 'aNormal'),
  instanceOffset: gl.getAttribLocation(program, 'aInstanceOffset'),
  instanceScale: gl.getAttribLocation(program, 'aInstanceScale'),
  instanceRotation: gl.getAttribLocation(program, 'aInstanceRotation'),
  projection: gl.getUniformLocation(program, 'uProjection'),
  view: gl.getUniformLocation(program, 'uView'),
  instanced: gl.getUniformLocation(program, 'uInstanced'),
  color: gl.getUniformLocation(program, 'uColor'),
  light: gl.getUniformLocation(program, 'uLight'),
  buildingDetail: gl.getUniformLocation(program, 'uBuildingDetail'),
};

function normalize(v) { const length = Math.hypot(...v) || 1; return v.map(x => x / length); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function perspective(fov, aspect, near, far) { const f = 1 / Math.tan(fov / 2); const nf = 1 / (near - far); return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]); }
function lookAt(eye, target, up) {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function parseMesh(buffer) {
  const view = new DataView(buffer);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== 'CM3D') throw new Error('Invalid scene mesh');
  const vertices = view.getUint32(8, true);
  const indices = view.getUint32(12, true);
  const positionsOffset = 16;
  const normalsOffset = positionsOffset + vertices * 12;
  const indicesOffset = normalsOffset + vertices * 12;
  return { vertices, indices, positions: new Float32Array(buffer, positionsOffset, vertices * 3), normals: new Float32Array(buffer, normalsOffset, vertices * 3), indexData: new Uint32Array(buffer, indicesOffset, indices) };
}

function parseInstances(buffer) {
  const view = new DataView(buffer);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== 'CINS') throw new Error('Invalid scene instances');
  const count = view.getUint32(8, true);
  return { count, data: new Float32Array(buffer, 12, count * 7) };
}

const layers = {};
const colors = {
  terrain: [0.19, 0.21, 0.22],
  base: [0.22, 0.24, 0.25],
  grass: [0.20, 0.34, 0.23],
  roads: [0.55, 0.43, 0.20],
  buildings: [0.30, 0.32, 0.34],
  roofs: [0.48, 0.50, 0.52],
  trees: [0.09, 0.25, 0.13],
  trunks: [0.34, 0.19, 0.085],
};
let manifest;
let camera = { azimuth: 0.75, elevation: 0.68, distance: 1600, target: [0, 20, 0] };
let drag = null;
let dirty = true;
let frame = 0;

function requestRender() {
  dirty = true;
  if (!frame) frame = requestAnimationFrame(render);
}

function uploadLayer(name, mesh) {
  const vao = vertexArrays.create();
  vertexArrays.bind(vao);
  const positions = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positions);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);
  const normals = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normals);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(locations.normal);
  gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, 0, 0);
  const indices = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indexData, gl.STATIC_DRAW);
  vertexArrays.bind(null);
  layers[name] = { vao, count: mesh.indices, visible: true, vertices: mesh.vertices };
}

function uploadInstancedLayer(name, mesh, instances) {
  uploadLayer(name, mesh);
  const layer = layers[name];
  vertexArrays.bind(layer.vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, instances.data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(locations.instanceOffset);
  gl.vertexAttribPointer(locations.instanceOffset, 3, gl.FLOAT, false, 28, 0);
  setAttributeDivisor(locations.instanceOffset, 1);
  gl.enableVertexAttribArray(locations.instanceScale);
  gl.vertexAttribPointer(locations.instanceScale, 3, gl.FLOAT, false, 28, 12);
  setAttributeDivisor(locations.instanceScale, 1);
  gl.enableVertexAttribArray(locations.instanceRotation);
  gl.vertexAttribPointer(locations.instanceRotation, 1, gl.FLOAT, false, 28, 24);
  setAttributeDivisor(locations.instanceRotation, 1);
  vertexArrays.bind(null);
  layer.instances = instances.count;
}

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const width = Math.floor(innerWidth * dpr);
  const height = Math.floor(innerHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; gl.viewport(0, 0, width, height); }
}
function render() {
  frame = 0;
  if (!dirty) return;
  dirty = false;
  resize();
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.106, 0.129, 0.145, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const horizontal = Math.cos(camera.elevation) * camera.distance;
  const eye = [camera.target[0] + Math.cos(camera.azimuth) * horizontal, camera.target[1] + Math.sin(camera.elevation) * camera.distance, camera.target[2] + Math.sin(camera.azimuth) * horizontal];
  gl.useProgram(program);
  gl.uniformMatrix4fv(locations.projection, false, perspective(Math.PI / 4, canvas.width / canvas.height, 1, 10000));
  gl.uniformMatrix4fv(locations.view, false, lookAt(eye, camera.target, [0, 1, 0]));
  gl.uniform3f(locations.light, -0.45, 0.85, 0.35);
  for (const [name, layer] of Object.entries(layers)) {
    if (!layer.visible) continue;
    gl.uniform3fv(locations.color, colors[name]);
    gl.uniform1f(locations.buildingDetail, name === 'buildings' ? 1 : 0);
    gl.uniform1i(locations.instanced, layer.instances ? 1 : 0);
    vertexArrays.bind(layer.vao);
    if (layer.instances) drawInstanced(layer.count, layer.instances);
    else gl.drawElements(gl.TRIANGLES, layer.count, gl.UNSIGNED_INT, 0);
  }
  vertexArrays.bind(null);
}

function fitScene() {
  camera.target = [0, 20, 0];
  camera.distance = Math.max(500, Math.min(2500, Math.hypot(manifest.bounds[2] - manifest.bounds[0], manifest.bounds[3] - manifest.bounds[1]) * 0.82));
  camera.elevation = 0.68;
}

function applyViewFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, property] of [['distance', 'distance'], ['elevation', 'elevation'], ['azimuth', 'azimuth']]) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (Number.isFinite(value)) camera[property] = value;
  }
  for (const [key, index] of [['targetX', 0], ['targetY', 1], ['targetZ', 2]]) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (Number.isFinite(value)) camera.target[index] = value;
  }
}

canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, azimuth: camera.azimuth, elevation: camera.elevation, target: [...camera.target], pan: event.shiftKey || event.button === 1 || event.button === 2 };
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
    camera.elevation = Math.max(0.16, Math.min(1.35, drag.elevation - dy * 0.006));
  }
  requestRender();
});
for (const name of ['pointerup', 'pointercancel']) canvas.addEventListener(name, () => { drag = null; });
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
  camera.distance = Math.max(80, Math.min(7000, camera.distance * Math.exp(delta * 0.0008)));
  requestRender();
}, { passive: false });
canvas.addEventListener('dblclick', () => { fitScene(); requestRender(); });
document.querySelector('#fit').addEventListener('click', () => { fitScene(); requestRender(); });
document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', event => {
  const name = event.target.dataset.layer;
  if (!layers[name]) return;
  layers[name].visible = event.target.checked;
  if (name === 'terrain' && layers.base) layers.base.visible = event.target.checked;
  if (name === 'buildings' && layers.roofs) layers.roofs.visible = event.target.checked;
  if (name === 'trees' && layers.trunks) layers.trunks.visible = event.target.checked;
  requestRender();
}));
addEventListener('resize', requestRender);

async function start() {
  try {
    manifest = await (await fetch('assets/manifest.json')).json();
    for (const name of ['terrain', 'base', 'grass', 'roads', 'buildings', 'roofs']) uploadLayer(name, parseMesh(await (await fetch(`assets/${manifest.assets[name]}`)).arrayBuffer()));
    const instances = parseInstances(await (await fetch(`assets/${manifest.assets.tree_instances}`)).arrayBuffer());
    for (const name of ['trees', 'trunks']) uploadInstancedLayer(name, parseMesh(await (await fetch(`assets/${manifest.assets[name]}`)).arrayBuffer()), instances);
    fitScene();
    applyViewFromUrl();
    const buildings = manifest.layers.buildings.features || 0;
    const trees = manifest.layers.trees.features || 0;
    const renderer = isWebGL2 ? 'WebGL2' : 'WebGL1 compatibility';
    const roads = manifest.layers.roads.features || 0;
    status.textContent = `${buildings} buildings · ${trees} trees · ${roads} OSM roads · ${renderer}`;
    requestRender();
  } catch (error) { console.error(error); status.textContent = `Scene failed to load: ${error.message}`; }
}
start();
} catch (error) {
  freshCanvas();
  loadFallback(error.message);
}
}
