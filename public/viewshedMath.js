// A footprint can have several disjoint crossings along a ray, including
// courtyards and openings. Return only the distances spent inside solid plan.
export function rayFootprintIntervals(originX, originZ, dx, dz, radius, outer, holes = []) {
  const crossings = [0, radius];
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i += 1) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const ex = bx - ax, ez = bz - az;
      const denominator = dx * ez - dz * ex;
      if (Math.abs(denominator) < 1e-10) continue;
      const px = ax - originX, pz = az - originZ;
      const distance = (px * ez - pz * ex) / denominator;
      const edgeFraction = (px * dz - pz * dx) / denominator;
      if (distance > 0 && distance < radius && edgeFraction >= 0 && edgeFraction <= 1) crossings.push(distance);
    }
  }
  crossings.sort((a, b) => a - b);
  const inside = (x, z, ring) => {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) result = !result;
    }
    return result;
  };
  const intervals = [];
  for (let i = 1; i < crossings.length; i += 1) {
    const start = crossings[i - 1], end = crossings[i];
    if (end - start < 1e-5) continue;
    const middle = (start + end) * 0.5;
    const x = originX + dx * middle, z = originZ + dz * middle;
    if (inside(x, z, outer) && !holes.some(hole => inside(x, z, hole))) intervals.push([start, end]);
  }
  return intervals;
}

// The angular span occupied by a building between two distances. A ray below
// the underside never enters the span, so ground remains visible under it.
export function addVerticalOccluder(intervals, base, top, eye, near, far) {
  if (!(top > base) || !(far > near)) return;
  const lower = Math.min(Math.atan2(base - eye, near), Math.atan2(base - eye, far));
  const upper = Math.max(Math.atan2(top - eye, near), Math.atan2(top - eye, far));
  let start = lower, end = upper;
  let index = 0;
  while (index < intervals.length && intervals[index][1] < start - 1e-6) index += 1;
  while (index < intervals.length && intervals[index][0] <= end + 1e-6) {
    start = Math.min(start, intervals[index][0]);
    end = Math.max(end, intervals[index][1]);
    intervals.splice(index, 1);
  }
  intervals.splice(index, 0, [start, end]);
}

export function blockedByVerticalOccluder(intervals, angle) {
  return intervals.some(([lower, upper]) => angle >= lower - 1e-6 && angle <= upper + 1e-6);
}

// A terrain cell is split along u + v = integer. Along a ray, elevation is
// linear between these crossings; its sightline slope can peak only at one of
// the crossings. Include output rings so classification is exact there too.
export function viewshedRingDistances(radius) {
  const distances = [0];
  for (let distance = 1; distance <= Math.min(30, radius); distance += 1) distances.push(distance);
  for (let distance = 32; distance <= Math.min(100, radius); distance += 2) distances.push(distance);
  for (let distance = 104; distance < radius; distance += 4) distances.push(distance);
  if (distances.at(-1) !== radius) distances.push(radius);
  return distances;
}

export function terrainRayDistances(originX, originZ, dx, dz, radius, left, minZ, cellWidth, cellDepth, ringDistances) {
  const u = (originX - left) / cellWidth;
  const v = (originZ - minZ) / cellDepth;
  const du = dx / cellWidth, dv = dz / cellDepth;
  const distances = [radius];
  const addCrossings = (start, slope) => {
    if (Math.abs(slope) < 1e-12) return;
    const end = start + slope * radius;
    for (let boundary = Math.ceil(Math.min(start, end)); boundary <= Math.floor(Math.max(start, end)); boundary += 1) {
      const distance = (boundary - start) / slope;
      if (distance > 1e-6 && distance < radius - 1e-6) distances.push(distance);
    }
  };
  addCrossings(u, du);
  addCrossings(v, dv);
  addCrossings(u + v, du + dv);
  for (const distance of ringDistances.slice(1, -1)) distances.push(distance);
  distances.sort((a, b) => a - b);
  return distances.filter((distance, index) => index === 0 || distance - distances[index - 1] > 1e-6);
}
