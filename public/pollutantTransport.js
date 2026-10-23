// Exact finite-step update for a stationary Ornstein–Uhlenbeck turbulent
// velocity and its integrated displacement. Sampling displacement as U(t+dt)*dt
// overstates travel whenever dt is not small relative to the Lagrangian time.
export function advanceOu(velocity, sigma, timeScale, dt, normalVelocity, normalDisplacement) {
  if (![velocity, sigma, timeScale, dt, normalVelocity, normalDisplacement].every(Number.isFinite)
    || !(dt > 0) || !(timeScale > 0) || !(sigma >= 0)) {
    throw new RangeError('OU step requires positive time and timescale, and non-negative sigma.');
  }
  if (sigma === 0) {
    const decay = Math.exp(-dt / timeScale);
    const nextVelocity = velocity * decay;
    return {
      velocity: nextVelocity,
      displacement: velocity * timeScale * -Math.expm1(-dt / timeScale),
    };
  }

  const ratio = dt / timeScale;
  const decay = Math.exp(-ratio);
  const oneMinusDecay = -Math.expm1(-ratio);
  const oneMinusDecaySquared = -Math.expm1(-2 * ratio);
  const velocityVariance = sigma * sigma * oneMinusDecaySquared;
  const covariance = sigma * sigma * timeScale * oneMinusDecay * oneMinusDecay;
  // Cancellation in r - 2(1-e^-r) + (1-e^-2r)/2 is material for
  // small r, so use its Taylor expansion in that range.
  const integratedVarianceFactor = ratio < 1e-3
    ? ratio ** 3 / 3 - ratio ** 4 / 4 + 7 * ratio ** 5 / 60
    : ratio - 2 * oneMinusDecay + 0.5 * oneMinusDecaySquared;
  const displacementVariance = Math.max(0, 2 * sigma * sigma * timeScale * timeScale * integratedVarianceFactor);
  const correlatedDisplacement = velocityVariance > 0 ? covariance / Math.sqrt(velocityVariance) : 0;
  const independentVariance = Math.max(0, displacementVariance - correlatedDisplacement ** 2);
  const nextVelocity = decay * velocity + Math.sqrt(velocityVariance) * normalVelocity;
  const displacement = timeScale * oneMinusDecay * velocity
    + correlatedDisplacement * normalVelocity
    + Math.sqrt(independentVariance) * normalDisplacement;
  return { velocity: nextVelocity, displacement };
}

export function wellMixedTurbulenceAcceleration(turbulentVelocity, meanVelocity, variance, varianceGradient) {
  if (!Array.isArray(turbulentVelocity) || turbulentVelocity.length !== 3 || !turbulentVelocity.every(Number.isFinite)
    || !Array.isArray(meanVelocity) || meanVelocity.length !== 3 || !meanVelocity.every(Number.isFinite)
    || !Array.isArray(varianceGradient) || varianceGradient.length !== 3 || !varianceGradient.every(Number.isFinite)
    || !Number.isFinite(variance) || variance < 0) {
    throw new RangeError('Well-mixed drift requires finite 3D velocities, variance, and variance gradient.');
  }
  if (variance <= 1e-9) return [0, 0, 0];
  const varianceRate = turbulentVelocity.reduce((sum, component, axis) => (
    sum + (meanVelocity[axis] + component) * varianceGradient[axis]
  ), 0);
  return varianceGradient.map((gradient, axis) => (
    0.5 * gradient + 0.5 * varianceRate / variance * turbulentVelocity[axis]
  ));
}

export function advancePollutantStep(position, turbulentVelocity, localFlow, sigma, timeScale, dt, normalSample, sampleFlow, settlingMps = 0) {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)
    || !Array.isArray(turbulentVelocity) || turbulentVelocity.length !== 3 || !turbulentVelocity.every(Number.isFinite)
    || ![localFlow?.u, localFlow?.w, localFlow?.v, sigma, timeScale, dt, settlingMps].every(Number.isFinite)
    || !(sigma >= 0) || !(timeScale > 0) || !(dt > 0)
    || typeof normalSample !== 'function' || typeof sampleFlow !== 'function') {
    throw new RangeError('Pollutant step received invalid position, flow, turbulence, or time values.');
  }
  const components = ['u', 'w', 'v'];
  const turbulentSteps = components.map((_, axis) => advanceOu(
    turbulentVelocity[axis], sigma, timeScale, dt, normalSample(), normalSample(),
  ));
  const nextTurbulence = turbulentSteps.map(step => step.velocity);
  const stochasticDisplacement = turbulentSteps.map(step => step.displacement);
  const localVelocity = [localFlow.u, localFlow.w - settlingMps, localFlow.v];
  const midpoint = position.map((value, axis) => value + (localVelocity[axis] * dt + stochasticDisplacement[axis]) * 0.5);
  const sampledFlow = sampleFlow(...midpoint);
  const midpointFlow = sampledFlow && [sampledFlow.u, sampledFlow.w, sampledFlow.v].every(Number.isFinite)
    ? sampledFlow : localFlow;
  const meanVelocity = [midpointFlow.u, midpointFlow.w - settlingMps, midpointFlow.v];
  let turbulenceAcceleration = [0, 0, 0];
  if (Number.isFinite(midpointFlow.variance)
    && Array.isArray(midpointFlow.varianceGradient) && midpointFlow.varianceGradient.length === 3) {
    const midpointTurbulence = turbulentVelocity.map((value, axis) => 0.5 * (value + nextTurbulence[axis]));
    turbulenceAcceleration = wellMixedTurbulenceAcceleration(midpointTurbulence,
      [midpointFlow.u, midpointFlow.w, midpointFlow.v], midpointFlow.variance, midpointFlow.varianceGradient);
  }
  return {
    position: position.map((value, axis) => value + meanVelocity[axis] * dt + stochasticDisplacement[axis]
      + 0.5 * turbulenceAcceleration[axis] * dt * dt),
    turbulentVelocity: nextTurbulence.map((value, axis) => value + turbulenceAcceleration[axis] * dt),
  };
}

// Keep parcel steps small relative to both the CFD cell crossing time and the
// velocity-correlation time. Bounds also keep browser work predictable.
export function pollutantTimeStep({ cellSpacing, velocity, sigma = 0, timeScale, variance = sigma * sigma,
  varianceGradient = [0, 0, 0], maxStep = 0.5 }) {
  if (!Array.isArray(cellSpacing) || cellSpacing.length !== 3 || !cellSpacing.every(Number.isFinite)
    || !cellSpacing.every(value => value > 0)
    || !Array.isArray(velocity) || velocity.length !== 3 || !velocity.every(Number.isFinite)
    || !Array.isArray(varianceGradient) || varianceGradient.length !== 3 || !varianceGradient.every(Number.isFinite)
    || ![sigma, variance, timeScale, maxStep].every(Number.isFinite)
    || sigma < 0 || variance < 0 || !(timeScale > 0) || !(maxStep > 0)) {
    throw new RangeError('Pollutant timestep requires three positive grid spacings, finite velocity, and positive time bounds.');
  }
  const cflStep = Math.min(...cellSpacing.map((spacing, axis) => (
    0.35 * spacing / Math.max(Math.abs(velocity[axis]) + 3 * sigma, 1e-6)
  )));
  const correlationStep = 0.5 * timeScale;
  const gradientMagnitude = Math.hypot(...varianceGradient);
  const gradientStep = gradientMagnitude > 0 && variance > 0
    ? 0.25 * variance / (gradientMagnitude * Math.max(Math.hypot(...velocity) + 3 * sigma, 1e-6))
    : Infinity;
  return Math.min(maxStep, cflStep, correlationStep, gradientStep);
}

export function combinedTrafficMassG(item) {
  const positiveFinite = value => {
    const mass = Number(value);
    return Number.isFinite(mass) && mass > 0 ? mass : 0;
  };
  return positiveFinite(item?.nox_g) + positiveFinite(item?.pmx_g);
}

export function lagrangianTimeScale(k, epsilon, c0 = 3, minimum = 0.7) {
  if (![k, epsilon, c0, minimum].every(Number.isFinite)
    || k < 0 || epsilon < 0 || !(c0 > 0) || !(minimum > 0)) {
    throw new RangeError('Lagrangian time scale requires non-negative k and epsilon and positive model constants.');
  }
  if (k === 0) return minimum;
  if (epsilon === 0) return 1e6;
  // For isotropic turbulence sigma_i^2 = 2k/3. Matching the OU variance
  // 2 sigma_i^2 / T_L to the Langevin diffusion C0 epsilon gives this scale.
  return Math.max(minimum, 4 * k / (3 * c0 * epsilon));
}

export function normalizedMaskedInterpolationGradient(values, weights, weightGradients, minimumWeight = 0.05) {
  if (!Array.isArray(values) || !values.length || !Array.isArray(weights) || weights.length !== values.length
    || !Array.isArray(weightGradients) || weightGradients.length !== values.length
    || !values.every(Number.isFinite) || !weights.every(value => Number.isFinite(value) && value >= 0)
    || weightGradients.some(gradient => !Array.isArray(gradient) || gradient.length !== 3 || !gradient.every(Number.isFinite))
    || !Number.isFinite(minimumWeight) || minimumWeight < 0) {
    throw new RangeError('Masked interpolation requires finite values, weights, gradients, and a non-negative weight threshold.');
  }
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal < minimumWeight || !(weightTotal > 0)) return null;
  const weightedValue = values.reduce((sum, value, index) => sum + value * weights[index], 0);
  const weightedGradient = [0, 0, 0];
  const weightGradient = [0, 0, 0];
  for (let index = 0; index < values.length; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      weightedGradient[axis] += values[index] * weightGradients[index][axis];
      weightGradient[axis] += weightGradients[index][axis];
    }
  }
  return {
    value: weightedValue / weightTotal,
    gradient: weightedGradient.map((value, axis) => (
      (value * weightTotal - weightedValue * weightGradient[axis]) / (weightTotal * weightTotal)
    )),
  };
}

export function segmentCellFractions(x0, z0, x1, z1, { left, minZ, right, maxZ, columns, rows }) {
  if (![x0, z0, x1, z1, left, minZ, right, maxZ].every(Number.isFinite)
    || !(right > left) || !(maxZ > minZ) || !Number.isInteger(columns) || columns <= 0
    || !Number.isInteger(rows) || rows <= 0) {
    throw new RangeError('Segment traversal requires finite endpoints and a positive grid geometry.');
  }
  const dx = x1 - x0, dz = z1 - z0;
  let enter = 0, exit = 1;
  for (const [start, delta, minimum, maximum] of [[x0, dx, left, right], [z0, dz, minZ, maxZ]]) {
    if (delta === 0) {
      if (start < minimum || start > maximum) return [];
      continue;
    }
    const first = (minimum - start) / delta, second = (maximum - start) / delta;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter >= exit) return [];
  }
  const width = (right - left) / columns, depth = (maxZ - minZ) / rows;
  if (dx === 0 && dz === 0) {
    if (x0 < left || z0 < minZ || x0 > right || z0 > maxZ) return [];
    const column = Math.min(columns - 1, Math.floor((x0 - left) / width));
    const row = Math.min(rows - 1, Math.floor((z0 - minZ) / depth));
    return [{ index: row * columns + column, startFraction: 0, endFraction: 1 }];
  }
  const cells = [];
  let current = enter;
  const maxCrossings = columns + rows + 4;
  for (let crossing = 0; crossing < maxCrossings && current < exit; crossing += 1) {
    const probe = Math.min(exit, current + Math.max(1e-12, (exit - enter) * 1e-10));
    const px = x0 + dx * probe, pz = z0 + dz * probe;
    const column = Math.max(0, Math.min(columns - 1, Math.floor((px - left) / width)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor((pz - minZ) / depth)));
    const nextX = dx > 0 ? (left + (column + 1) * width - x0) / dx
      : dx < 0 ? (left + column * width - x0) / dx : Infinity;
    const nextZ = dz > 0 ? (minZ + (row + 1) * depth - z0) / dz
      : dz < 0 ? (minZ + row * depth - z0) / dz : Infinity;
    const next = Math.min(exit, nextX > current ? nextX : Infinity, nextZ > current ? nextZ : Infinity);
    if (!(next > current)) break;
    const index = row * columns + column;
    const previous = cells.at(-1);
    if (previous?.index === index && Math.abs(previous.endFraction - current) < 1e-10) {
      previous.endFraction = next;
    } else {
      cells.push({ index, startFraction: current, endFraction: next });
    }
    current = next;
  }
  return cells;
}

export function clipSegmentToValidIntervals(start, end, isValid, iterations = 24, knownValidity = {}) {
  if (!Array.isArray(start) || start.length !== 3 || !start.every(Number.isFinite)
    || !Array.isArray(end) || end.length !== 3 || !end.every(Number.isFinite)
    || typeof isValid !== 'function' || !Number.isInteger(iterations) || iterations < 1 || iterations > 52
    || !knownValidity || typeof knownValidity !== 'object'
    || (knownValidity.startIsValid !== undefined && typeof knownValidity.startIsValid !== 'boolean')
    || (knownValidity.midpointIsValid !== undefined && typeof knownValidity.midpointIsValid !== 'boolean')
    || (knownValidity.endIsValid !== undefined && typeof knownValidity.endIsValid !== 'boolean')) {
    throw new RangeError('Segment clipping requires finite 3D endpoints, a validity function, and 1-52 iterations.');
  }
  const validity = [
    knownValidity.startIsValid ?? isValid(...start),
    knownValidity.midpointIsValid ?? isValid(...start.map((value, axis) => (value + end[axis]) / 2)),
    knownValidity.endIsValid ?? isValid(...end),
  ];
  const isValidAt = fraction => isValid(...start.map((value, axis) => value + (end[axis] - value) * fraction));
  const boundaryBetween = (startFraction, startValid, endFraction, endValid) => {
    let invalid = startValid ? endFraction : startFraction;
    let valid = startValid ? startFraction : endFraction;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const midpoint = (invalid + valid) / 2;
      if (isValidAt(midpoint)) valid = midpoint;
      else invalid = midpoint;
    }
    return valid;
  };
  const intervals = [];
  for (let index = 0; index < 2; index += 1) {
    const startFraction = index * 0.5, endFraction = (index + 1) * 0.5;
    const startValid = validity[index], endValid = validity[index + 1];
    if (startValid && endValid) intervals.push([startFraction, endFraction]);
    else if (startValid) intervals.push([startFraction,
      boundaryBetween(startFraction, startValid, endFraction, endValid)]);
    else if (endValid) intervals.push([
      boundaryBetween(startFraction, startValid, endFraction, endValid), endFraction,
    ]);
  }
  return mergeIntervals(intervals);
}

export function segmentRingIntervals(x0, z0, x1, z1, ring) {
  if (![x0, z0, x1, z1].every(Number.isFinite) || !Array.isArray(ring) || ring.length < 3
    || ring.some(point => !Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(Number.isFinite))) {
    throw new RangeError('Polygon clipping requires finite segment endpoints and a finite ring with at least three points.');
  }
  const dx = x1 - x0, dz = z1 - z0;
  const cuts = [0, 1];
  for (let index = 0; index < ring.length; index += 1) {
    const [ax, az] = ring[index], [bx, bz] = ring[(index + 1) % ring.length];
    const edgeX = bx - ax, edgeZ = bz - az;
    const denominator = dx * edgeZ - dz * edgeX;
    if (Math.abs(denominator) < 1e-12) continue;
    const offsetX = ax - x0, offsetZ = az - z0;
    const fraction = (offsetX * edgeZ - offsetZ * edgeX) / denominator;
    const edgeFraction = (offsetX * dz - offsetZ * dx) / denominator;
    if (fraction >= -1e-10 && fraction <= 1 + 1e-10
      && edgeFraction >= -1e-10 && edgeFraction <= 1 + 1e-10) {
      cuts.push(Math.max(0, Math.min(1, fraction)));
    }
  }
  cuts.sort((a, b) => a - b);
  const uniqueCuts = cuts.filter((value, index) => index === 0 || value - cuts[index - 1] > 1e-10);
  const intervals = [];
  const inside = (x, z) => {
    let result = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [xi, zi] = ring[index], [xj, zj] = ring[previous];
      if (((zi > z) !== (zj > z)) && x < (xj - xi) * (z - zi) / ((zj - zi) || Number.EPSILON) + xi) result = !result;
    }
    return result;
  };
  for (let index = 1; index < uniqueCuts.length; index += 1) {
    const start = uniqueCuts[index - 1], end = uniqueCuts[index];
    if (!(end > start)) continue;
    const midpoint = (start + end) / 2;
    if (inside(x0 + dx * midpoint, z0 + dz * midpoint)) intervals.push([start, end]);
  }
  return intervals;
}

export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.some(interval => (
    !Array.isArray(interval) || interval.length !== 2 || !interval.every(Number.isFinite) || interval[1] < interval[0]
  ))) throw new RangeError('Interval merging requires ordered finite interval pairs.');
  const ordered = intervals.filter(([start, end]) => end > start)
    .map(([start, end]) => [Math.max(0, start), Math.min(1, end)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of ordered) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1e-10) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function intersectIntervals(firstIntervals, secondIntervals) {
  const first = mergeIntervals(firstIntervals);
  const second = mergeIntervals(secondIntervals);
  const intersections = [];
  for (const [firstStart, firstEnd] of first) {
    for (const [secondStart, secondEnd] of second) {
      const start = Math.max(firstStart, secondStart);
      const end = Math.min(firstEnd, secondEnd);
      if (end > start) intersections.push([start, end]);
    }
  }
  return mergeIntervals(intersections);
}

export function segmentPolygonSetIntervals(x0, z0, x1, z1, polygons, candidateEdges = null, knownStartInside = undefined) {
  if (![x0, z0, x1, z1].every(Number.isFinite) || !Array.isArray(polygons)
    || (candidateEdges !== null && (!Array.isArray(candidateEdges) || candidateEdges.some(edge => (
      !Array.isArray(edge) || edge.length !== 4 || !edge.every(Number.isFinite)
    ))))
    || (knownStartInside !== undefined && typeof knownStartInside !== 'boolean')
    || polygons.some(polygon => !Array.isArray(polygon) || !polygon.length || polygon.some(ring => (
      !Array.isArray(ring) || ring.length < 3 || ring.some(point => (
        !Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(Number.isFinite)
      ))
    )))) {
    throw new RangeError('Polygon-set clipping requires finite endpoints and valid polygon rings.');
  }
  if (!polygons.length) return [[0, 1]];
  const edges = candidateEdges || polygons.flatMap(polygon => polygon.flatMap(ring => ring.flatMap((point, index) => {
    const next = ring[(index + 1) % ring.length];
    return [[point[0], point[1], next[0], next[1]]];
  })));
  const dx = x1 - x0, dz = z1 - z0;
  const cuts = [0, 1];
  for (const [ax, az, bx, bz] of edges) {
    const edgeX = bx - ax, edgeZ = bz - az;
    const denominator = dx * edgeZ - dz * edgeX;
    if (Math.abs(denominator) < 1e-12) continue;
    const offsetX = ax - x0, offsetZ = az - z0;
    const fraction = (offsetX * edgeZ - offsetZ * edgeX) / denominator;
    const edgeFraction = (offsetX * dz - offsetZ * dx) / denominator;
    if (fraction >= -1e-10 && fraction <= 1 + 1e-10
      && edgeFraction >= -1e-10 && edgeFraction <= 1 + 1e-10) {
      cuts.push(Math.max(0, Math.min(1, fraction)));
    }
  }
  cuts.sort((a, b) => a - b);
  const uniqueCuts = cuts.filter((value, index) => index === 0 || value - cuts[index - 1] > 1e-10);
  if (uniqueCuts.length === 2 && knownStartInside !== undefined) return knownStartInside ? [[0, 1]] : [];
  const pointInRing = (x, z, ring) => {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [xi, zi] = ring[index], [xj, zj] = ring[previous];
      if (((zi > z) !== (zj > z)) && x < (xj - xi) * (z - zi) / ((zj - zi) || Number.EPSILON) + xi) inside = !inside;
    }
    return inside;
  };
  const pointInside = (x, z) => polygons.some(([outer, ...holes]) => (
    pointInRing(x, z, outer) && !holes.some(hole => pointInRing(x, z, hole))
  ));
  const intervals = [];
  for (let index = 1; index < uniqueCuts.length; index += 1) {
    const start = uniqueCuts[index - 1], end = uniqueCuts[index];
    if (!(end > start)) continue;
    const midpoint = (start + end) / 2;
    if (pointInside(x0 + dx * midpoint, z0 + dz * midpoint)) intervals.push([start, end]);
  }
  return intervals;
}

export function subtractIntervals(intervals, exclusions) {
  if (!Array.isArray(intervals) || !Array.isArray(exclusions)) {
    throw new RangeError('Interval subtraction requires interval arrays.');
  }
  const bases = mergeIntervals(intervals);
  const blocked = mergeIntervals(exclusions);
  const remaining = [];
  for (const [baseStart, baseEnd] of bases) {
    let cursor = baseStart;
    for (const [blockStart, blockEnd] of blocked) {
      if (blockEnd <= cursor) continue;
      if (blockStart >= baseEnd) break;
      if (blockStart > cursor) remaining.push([cursor, Math.min(blockStart, baseEnd)]);
      cursor = Math.max(cursor, blockEnd);
      if (cursor >= baseEnd) break;
    }
    if (cursor < baseEnd) remaining.push([cursor, baseEnd]);
  }
  return remaining;
}

export function segmentBuildingIntervals(x0, y0, z0, x1, y1, z1, buildings) {
  if (![x0, y0, z0, x1, y1, z1].every(Number.isFinite) || !Array.isArray(buildings)) {
    throw new RangeError('Building clipping requires finite 3D segment endpoints and a building array.');
  }
  const blocked = [];
  for (const building of buildings) {
    if (!Number.isFinite(building?.baseY) || !Number.isFinite(building?.roofY)
      || building.roofY < building.baseY || !Array.isArray(building.ring) || building.ring.length < 3
      || !Array.isArray(building.holes || [])) {
      throw new RangeError('Building clipping requires finite vertical bounds and polygon rings.');
    }
    const vertical = clipSegmentWithinRange(y0, y1, building.baseY, building.roofY);
    if (!vertical) continue;
    let footprint = segmentRingIntervals(x0, z0, x1, z1, building.ring);
    for (const hole of building.holes || []) {
      footprint = subtractIntervals(footprint, segmentRingIntervals(x0, z0, x1, z1, hole));
    }
    for (const [start, end] of footprint) {
      const clippedStart = Math.max(start, vertical[0]);
      const clippedEnd = Math.min(end, vertical[1]);
      if (clippedEnd > clippedStart) blocked.push([clippedStart, clippedEnd]);
    }
  }
  return mergeIntervals(blocked);
}

export function clipSegmentBelowThreshold(startValue, endValue, threshold) {
  if (![startValue, endValue, threshold].every(Number.isFinite)) {
    throw new RangeError('Threshold clipping requires finite endpoint values and threshold.');
  }
  const startInside = startValue <= threshold, endInside = endValue <= threshold;
  if (startInside && endInside) return [0, 1];
  if (!startInside && !endInside) return null;
  const crossing = Math.max(0, Math.min(1, (threshold - startValue) / (endValue - startValue)));
  return startInside ? [0, crossing] : [crossing, 1];
}

export function clipSegmentWithinRange(startValue, endValue, minimum, maximum) {
  if (![startValue, endValue, minimum, maximum].every(Number.isFinite) || maximum < minimum) {
    throw new RangeError('Range clipping requires finite endpoint values and an ordered range.');
  }
  const delta = endValue - startValue;
  if (delta === 0) return startValue >= minimum && startValue <= maximum ? [0, 1] : null;
  const firstCrossing = (minimum - startValue) / delta;
  const secondCrossing = (maximum - startValue) / delta;
  const startFraction = Math.max(0, Math.min(firstCrossing, secondCrossing));
  const endFraction = Math.min(1, Math.max(firstCrossing, secondCrossing));
  return endFraction > startFraction ? [startFraction, endFraction] : null;
}

export function clipReflectedSegmentWithinRange(startValue, endValue, minimum, maximum) {
  if (![startValue, endValue, minimum, maximum].every(Number.isFinite) || maximum < minimum) {
    throw new RangeError('Reflected range clipping requires finite endpoint values and an ordered range.');
  }
  const direct = clipSegmentWithinRange(startValue, endValue, minimum, maximum);
  if (endValue >= minimum || startValue < minimum) return direct;

  // The renderer mirrors an endpoint that crossed the lower boundary. Unfold
  // that reflected path into its two linear pieces so residence after contact
  // is counted during the remainder of the same time step.
  const crossing = (startValue - minimum) / (startValue - endValue);
  const reflectedEnd = 2 * minimum - endValue;
  const approach = clipSegmentWithinRange(startValue, minimum, minimum, maximum);
  const departure = clipSegmentWithinRange(minimum, reflectedEnd, minimum, maximum);
  if (!approach || !departure) return null;
  return [crossing * approach[0], crossing + (1 - crossing) * departure[1]];
}

export function reflectNormalVelocityAtBoundary(meanNormalVelocity, fluctuatingNormalVelocity) {
  if (![meanNormalVelocity, fluctuatingNormalVelocity].every(Number.isFinite)) {
    throw new RangeError('Velocity reflection requires finite mean and fluctuating normal velocities.');
  }
  const incomingVelocity = meanNormalVelocity + fluctuatingNormalVelocity;
  return Math.abs(incomingVelocity) - meanNormalVelocity;
}

export function reflectVelocityAtBoundary(meanVelocity, fluctuatingVelocity, outwardNormal) {
  if (![meanVelocity, fluctuatingVelocity, outwardNormal].every(vector => Array.isArray(vector) && vector.length === 3
    && vector.every(Number.isFinite)) || Math.hypot(...outwardNormal) < 1e-12) {
    throw new RangeError('Vector reflection requires finite 3D velocities and a non-zero outward normal.');
  }
  const normalLength = Math.hypot(...outwardNormal);
  const normal = outwardNormal.map(value => value / normalLength);
  const totalVelocity = meanVelocity.map((value, axis) => value + fluctuatingVelocity[axis]);
  const incomingNormal = totalVelocity.reduce((sum, value, axis) => sum + value * normal[axis], 0);
  if (incomingNormal >= 0) return [...fluctuatingVelocity];
  return fluctuatingVelocity.map((value, axis) => value - 2 * incomingNormal * normal[axis]);
}

export function stratifiedFractions(count, random) {
  if (!Number.isInteger(count) || count <= 0 || typeof random !== 'function') {
    throw new RangeError('Stratified source sampling requires a positive sample count and random function.');
  }
  const draw = () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random function must return values in [0, 1).');
    return value;
  };
  const fractions = Array.from({ length: count }, (_, index) => (index + draw()) / count);
  for (let index = count - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(draw() * (index + 1));
    [fractions[index], fractions[swapIndex]] = [fractions[swapIndex], fractions[index]];
  }
  return fractions;
}

export function stratifiedSampleTime(index, count, durationS) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 0 || index < 0 || index >= count
    || !Number.isFinite(durationS) || durationS < 0) {
    throw new RangeError('Stratified time sampling requires a valid sample index, count, and non-negative duration.');
  }
  return ((index + 0.5) / count) * durationS;
}

export function clipPolylineToValidSamples(points, isValid, maxSegmentM = 5) {
  if (!Array.isArray(points) || points.length < 2 || typeof isValid !== 'function'
    || !Number.isFinite(maxSegmentM) || !(maxSegmentM > 0)
    || points.some(point => !Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(Number.isFinite))) {
    throw new RangeError('Road source clipping requires finite points, a validity callback, and positive segment spacing.');
  }
  const segments = [];
  let totalLengthM = 0;
  let validLengthM = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1].slice(0, 2), b = points[index].slice(0, 2);
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const lengthM = Math.hypot(dx, dz);
    if (lengthM < 0.2) continue;
    totalLengthM += lengthM;
    const partitions = Math.max(1, Math.ceil(lengthM / maxSegmentM));
    for (let part = 0; part < partitions; part += 1) {
      const start = part / partitions, end = (part + 1) / partitions;
      const midpoint = (start + end) / 2;
      if (!isValid(a[0] + dx * midpoint, a[1] + dz * midpoint)) continue;
      const segmentLengthM = lengthM / partitions;
      validLengthM += segmentLengthM;
      segments.push({
        a: [a[0] + dx * start, a[1] + dz * start],
        b: [a[0] + dx * end, a[1] + dz * end],
        lengthM: segmentLengthM,
        endAtM: validLengthM,
      });
    }
  }
  return { segments, totalLengthM, validLengthM };
}

export function accumulateResidenceBins(bins, startTime, endTime, cellIndex, massG, binWidth = 5) {
  if (!Array.isArray(bins) || !Number.isInteger(cellIndex) || cellIndex < 0
    || !Number.isFinite(binWidth) || !(binWidth > 0) || !Number.isFinite(startTime) || !Number.isFinite(endTime)
    || !Number.isFinite(massG) || !(massG > 0) || endTime < startTime) {
    throw new RangeError('Residence accumulation received invalid bins, time, cell, mass, or bin width.');
  }
  const firstBin = Math.floor(Math.max(0, startTime) / binWidth);
  const lastBin = endTime > Math.max(0, startTime) ? Math.ceil(endTime / binWidth) - 1 : firstBin - 1;
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    if (!bins[bin] || cellIndex >= bins[bin].length) throw new RangeError('Residence bins do not cover the requested time and cell.');
  }
  let added = 0;
  for (let time = Math.max(0, startTime); time < endTime;) {
    const bin = Math.floor(time / binWidth);
    const target = bins[bin];
    const pieceEnd = Math.min(endTime, (bin + 1) * binWidth);
    const residence = (pieceEnd - time) * massG;
    target[cellIndex] += residence;
    added += residence;
    time = pieceEnd;
  }
  return added;
}
