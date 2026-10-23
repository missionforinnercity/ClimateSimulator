import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateResidenceBins, advanceOu, advancePollutantStep, combinedTrafficMassG, pollutantTimeStep,
  clipPolylineToValidSamples, clipSegmentBelowThreshold, clipSegmentWithinRange, clipReflectedSegmentWithinRange,
  intersectIntervals, lagrangianTimeScale, mergeIntervals, normalizedMaskedInterpolationGradient,
  clipSegmentToValidIntervals, reflectNormalVelocityAtBoundary, reflectVelocityAtBoundary,
  segmentBuildingIntervals, segmentCellFractions,
  segmentPolygonSetIntervals, segmentRingIntervals, stratifiedFractions, stratifiedSampleTime,
  subtractIntervals, wellMixedTurbulenceAcceleration,
} from '../public/pollutantTransport.js';

function normalGenerator(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

function uniformGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

test('integrated OU step preserves stationary velocity and displacement moments', () => {
  const sigma = 1.7, timeScale = 0.8, dt = 2.4;
  const decay = Math.exp(-dt / timeScale);
  const expectedDisplacementVariance = 2 * sigma ** 2 * timeScale ** 2
    * (dt / timeScale - (1 - decay));
  const expectedCovariance = sigma ** 2 * timeScale * (1 - decay);
  const random = normalGenerator(20261022);
  const samples = 80_000;
  let velocitySum = 0, displacementSum = 0;
  let velocitySquareSum = 0, displacementSquareSum = 0, crossSum = 0;
  for (let index = 0; index < samples; index += 1) {
    const initialVelocity = sigma * random();
    const step = advanceOu(initialVelocity, sigma, timeScale, dt, random(), random());
    velocitySum += step.velocity;
    displacementSum += step.displacement;
    velocitySquareSum += step.velocity ** 2;
    displacementSquareSum += step.displacement ** 2;
    crossSum += step.velocity * step.displacement;
  }
  const meanVelocity = velocitySum / samples;
  const meanDisplacement = displacementSum / samples;
  const velocityVariance = velocitySquareSum / samples - meanVelocity ** 2;
  const displacementVariance = displacementSquareSum / samples - meanDisplacement ** 2;
  const covariance = crossSum / samples - meanVelocity * meanDisplacement;
  assert.ok(Math.abs(meanVelocity) < 0.02);
  assert.ok(Math.abs(meanDisplacement) < 0.03);
  assert.ok(Math.abs(velocityVariance - sigma ** 2) / sigma ** 2 < 0.025);
  assert.ok(Math.abs(displacementVariance - expectedDisplacementVariance) / expectedDisplacementVariance < 0.03);
  assert.ok(Math.abs(covariance - expectedCovariance) / expectedCovariance < 0.03);
});

test('integrated OU displacement remains stable for a very small time step', () => {
  const result = advanceOu(0.3, 0.7, 20, 1e-5, -0.2, 0.5);
  assert.ok(Number.isFinite(result.velocity));
  assert.ok(Number.isFinite(result.displacement));
  assert.ok(Math.abs(result.displacement) < 1e-3);
  assert.throws(() => advanceOu(Number.NaN, 1, 1, 1, 0, 0), RangeError);
});

test('multi-step homogeneous plume preserves analytic mean and long-time displacement variance', () => {
  const sigma = 1.3, timeScale = 0.8, meanWind = 2.1, timeStep = 0.05, steps = 200, samples = 8000;
  const random = normalGenerator(41927);
  const positions = new Float64Array(samples);
  const turbulence = Array.from({ length: samples }, () => [sigma * random(), 0, 0]);
  const flow = { u: meanWind, w: 0, v: 0 };
  for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
    for (let particle = 0; particle < samples; particle += 1) {
      const next = advancePollutantStep([positions[particle], 0, 0], turbulence[particle], flow,
        sigma, timeScale, timeStep, random, () => flow);
      positions[particle] = next.position[0];
      turbulence[particle] = next.turbulentVelocity;
    }
  }
  const duration = steps * timeStep;
  const mean = positions.reduce((sum, value) => sum + value, 0) / samples;
  const variance = positions.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples;
  const expectedVariance = 2 * sigma ** 2 * timeScale
    * (duration - timeScale * (1 - Math.exp(-duration / timeScale)));
  assert.ok(Math.abs(mean - meanWind * duration) < 0.12, `mean displacement: ${mean}`);
  assert.ok(Math.abs(variance - expectedVariance) / expectedVariance < 0.025,
    `displacement variance: ${variance} vs ${expectedVariance}`);
});

test('pollutant step uses midpoint flow and applies settling along the vertical axis', () => {
  const flow = { u: 2, w: 0.5, v: -1 };
  const result = advancePollutantStep([1, 3, 5], [0, 0, 0], flow, 0, 1, 0.2,
    () => 0, () => flow, 0.1);
  assert.deepEqual(result.position, [1.4, 3.08, 4.8]);
  const accelerating = advancePollutantStep([1, 0, 0], [0, 0, 0], { u: 1, w: 0, v: 0 }, 0, 1, 0.4,
    () => 0, x => ({ u: x, w: 0, v: 0 }));
  assert.ok(Math.abs(accelerating.position[0] - 1.48) < 1e-12);
  const invalidMidpoint = advancePollutantStep([1, 0, 0], [0, 0, 0], flow, 0, 1, 0.2,
    () => 0, () => ({ u: Number.NaN, w: 0, v: 0 }));
  assert.deepEqual(invalidMidpoint.position, [1.4, 0.1, -0.2]);
  assert.throws(() => advancePollutantStep([1, 0], [0, 0, 0], flow, 0, 1, 1, () => 0, () => flow), RangeError);
});

test('isotropic well-mixed acceleration includes covariance-gradient and path-rate terms', () => {
  const acceleration = wellMixedTurbulenceAcceleration([1, -2, 0.5], [2, 0, 0], 4, [0.2, 0, 0]);
  assert.ok(Math.abs(acceleration[0] - 0.175) < 1e-12);
  assert.ok(Math.abs(acceleration[1] + 0.15) < 1e-12);
  assert.ok(Math.abs(acceleration[2] - 0.0375) < 1e-12);
  assert.deepEqual(wellMixedTurbulenceAcceleration([1, 2, 3], [0, 0, 0], 0, [1, 2, 3]), [0, 0, 0]);
  assert.throws(() => wellMixedTurbulenceAcceleration([0, 0], [0, 0, 0], 1, [0, 0, 0]), RangeError);
});

test('isotropic Gaussian drift satisfies the stationary 1D well-mixed Fokker-Planck balance', () => {
  const variance = 1.3, varianceGradient = 0.22, meanVelocity = 2.2, timeScale = 0.8;
  const diffusion = 2 * variance / timeScale;
  for (const fluctuation of [-2, -0.5, 0, 1.2, 3]) {
    const pdf = Math.exp(-(fluctuation ** 2) / (2 * variance)) / Math.sqrt(2 * Math.PI * variance);
    const dPdfDx = pdf * (-0.5 * varianceGradient / variance
      + 0.5 * fluctuation ** 2 * varianceGradient / variance ** 2);
    const acceleration = -fluctuation / timeScale
      + wellMixedTurbulenceAcceleration([fluctuation, 0, 0], [meanVelocity, 0, 0], variance,
        [varianceGradient, 0, 0])[0];
    const dAccelerationPdfDu = pdf * (
      -1 / timeScale + 0.5 * varianceGradient * (meanVelocity + 2 * fluctuation) / variance
      - acceleration * fluctuation / variance
    );
    const d2PdfDu2 = pdf * (fluctuation ** 2 / variance ** 2 - 1 / variance);
    const residual = -(meanVelocity + fluctuation) * dPdfDx
      - dAccelerationPdfDu + 0.5 * diffusion * d2PdfDu2;
    assert.ok(Math.abs(residual) / pdf < 1e-12, `Fokker-Planck residual at u=${fluctuation}: ${residual / pdf}`);
  }
});

test('isotropic Gaussian drift preserves a 3D uniform joint position-velocity PDF', () => {
  const variance = 1.7, timeScale = 0.9;
  const mean = [2.4, -0.7, 0.3], fluctuation = [1.2, -1.8, 0.45];
  const gradient = [0.18, -0.11, 0.07];
  const drift = wellMixedTurbulenceAcceleration(fluctuation, mean, variance, gradient);
  const rate = mean.reduce((sum, value, axis) => sum + (value + fluctuation[axis]) * gradient[axis], 0);
  let divergenceDriftPdf = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const acceleration = -fluctuation[axis] / timeScale + drift[axis];
    const derivativeAcceleration = -1 / timeScale
      + 0.5 * (gradient[axis] * fluctuation[axis] + rate) / variance;
    divergenceDriftPdf += derivativeAcceleration - acceleration * fluctuation[axis] / variance;
  }
  const divergenceAdvectionPdf = rate * (-1.5 / variance
    + 0.5 * fluctuation.reduce((sum, value) => sum + value * value, 0) / variance ** 2);
  const diffusion = 2 * variance / timeScale;
  const laplacianPdf = fluctuation.reduce((sum, value) => sum + value * value, 0) / variance ** 2 - 3 / variance;
  const residual = -divergenceAdvectionPdf - divergenceDriftPdf + 0.5 * diffusion * laplacianPdf;
  assert.ok(Math.abs(residual) < 1e-12, `3D Fokker-Planck residual: ${residual}`);
});

test('well-mixed step avoids artificial concentration in a periodic variable-turbulence field', () => {
  const random = normalGenerator(7281), initial = uniformGenerator(929);
  const count = 2000, binCount = 8, length = 2 * Math.PI, timeStep = 0.01;
  const steps = 500, timeScale = 0.8;
  const varianceAt = x => 1.2 + 0.4 * Math.sin(x);
  const varianceGradientAt = x => 0.4 * Math.cos(x);
  const positions = new Float64Array(count);
  const velocities = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    positions[index] = initial() * length;
    velocities[index] = Math.sqrt(varianceAt(positions[index])) * random();
  }
  for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
    for (let particle = 0; particle < count; particle += 1) {
      const x = ((positions[particle] % length) + length) % length;
      const variance = varianceAt(x);
      const local = {
        u: 0, w: 0, v: 0, variance,
        varianceGradient: [varianceGradientAt(x), 0, 0],
      };
      const next = advancePollutantStep([x, 0, 0], [velocities[particle], 0, 0], local,
        Math.sqrt(variance), timeScale, timeStep, random, midpointX => {
          const midpoint = ((midpointX % length) + length) % length;
          return {
            u: 0, w: 0, v: 0, variance: varianceAt(midpoint),
            varianceGradient: [varianceGradientAt(midpoint), 0, 0],
          };
        });
      positions[particle] = next.position[0];
      velocities[particle] = next.turbulentVelocity[0];
    }
  }
  const counts = new Array(binCount).fill(0);
  for (const unwrapped of positions) {
    const x = ((unwrapped % length) + length) % length;
    counts[Math.min(binCount - 1, Math.floor(x / length * binCount))] += 1;
  }
  const expected = count / binCount;
  assert.ok(Math.max(...counts.map(value => Math.abs(value / expected - 1))) < 0.15,
    `uniform tracer developed a spatial bias: ${counts.join(', ')}`);
});

test('pollutant step applies isotropic well-mixed drift to position and velocity', () => {
  const result = advancePollutantStep([0, 0, 0], [0, 0, 0], {
    u: 0, w: 0, v: 0, variance: 1, varianceGradient: [0.4, 0, 0],
  }, 1, 1, 0.1, () => 0, () => ({
    u: 0, w: 0, v: 0, variance: 1, varianceGradient: [0.4, 0, 0],
  }));
  assert.ok(Math.abs(result.turbulentVelocity[0] - 0.02) < 1e-12);
  assert.ok(Math.abs(result.position[0] - 0.001) < 1e-12);
});

test('pollutant timestep respects the CFL, correlation-time, and maximum bounds', () => {
  assert.equal(pollutantTimeStep({ cellSpacing: [10, 10, 10], velocity: [1, 0, 0], timeScale: 3 }), 0.5);
  assert.ok(Math.abs(pollutantTimeStep({ cellSpacing: [2, 2, 2], velocity: [10, 0, 0], timeScale: 8 }) - 0.07) < 1e-12);
  assert.ok(Math.abs(pollutantTimeStep({ cellSpacing: [10, 2, 10], velocity: [1, 10, 1], timeScale: 8 }) - 0.07) < 1e-12);
  assert.equal(pollutantTimeStep({ cellSpacing: [100, 100, 100], velocity: [1, 1, 1], timeScale: 0.4 }), 0.2);
  assert.ok(Math.abs(pollutantTimeStep({ cellSpacing: [10, 10, 10], velocity: [1, 0, 0],
    sigma: 0, variance: 0.1, varianceGradient: [1, 0, 0], timeScale: 8 }) - 0.025) < 1e-12);
  assert.throws(() => pollutantTimeStep({ cellSpacing: [0, 1, 1], velocity: [1, 0, 0], timeScale: 1 }), RangeError);
  assert.throws(() => pollutantTimeStep({ cellSpacing: [1, 1, 1], velocity: [Number.NaN, 0, 0], timeScale: 1 }), RangeError);
});

test('overall traffic tracer mass adds NOx and PMx and ignores invalid masses', () => {
  assert.equal(combinedTrafficMassG({ nox_g: 1.25, pmx_g: 0.75 }), 2);
  assert.equal(combinedTrafficMassG({ nox_g: -1, pmx_g: 2 }), 2);
  assert.equal(combinedTrafficMassG({ nox_g: Infinity, pmx_g: 'invalid' }), 0);
  assert.equal(combinedTrafficMassG(null), 0);
});

test('Lagrangian time scale matches the isotropic k-epsilon closure and applies explicit bounds', () => {
  assert.ok(Math.abs(lagrangianTimeScale(1.5, 0.2) - 4 / 1.2) < 1e-12);
  assert.equal(lagrangianTimeScale(0.01, 1), 0.7);
  assert.ok(Math.abs(lagrangianTimeScale(100, 0.001) - 4 * 100 / (9 * 0.001)) < 1e-9);
  assert.equal(lagrangianTimeScale(0, 0), 0.7);
  assert.equal(lagrangianTimeScale(1, 0), 1e6);
  assert.throws(() => lagrangianTimeScale(-1, 0.1), RangeError);
});

test('masked trilinear turbulence gradients match exact and finite-difference references', () => {
  const field = (x, y, z) => 2 + 3 * x - 4 * y + 5 * z;
  const interpolate = (fraction, masked = false) => {
    const values = [], weights = [], gradients = [];
    for (let dz = 0; dz <= 1; dz += 1) for (let dy = 0; dy <= 1; dy += 1) for (let dx = 0; dx <= 1; dx += 1) {
      if (masked && dx === 1 && dy === 1 && dz === 1) continue;
      const wx = dx ? fraction[0] : 1 - fraction[0];
      const wy = dy ? fraction[1] : 1 - fraction[1];
      const wz = dz ? fraction[2] : 1 - fraction[2];
      values.push(field(dx, dy, dz));
      weights.push(wx * wy * wz);
      gradients.push([
        (dx ? 1 : -1) * wy * wz,
        (dy ? 1 : -1) * wx * wz,
        (dz ? 1 : -1) * wx * wy,
      ]);
    }
    return normalizedMaskedInterpolationGradient(values, weights, gradients);
  };
  const full = interpolate([0.3, 0.4, 0.6]);
  assert.ok(Math.abs(full.value - field(0.3, 0.4, 0.6)) < 1e-12);
  assert.ok(full.gradient.every((value, axis) => Math.abs(value - [3, -4, 5][axis]) < 1e-12));
  const point = [0.3, 0.4, 0.6], masked = interpolate(point, true), delta = 1e-5;
  for (let axis = 0; axis < 3; axis += 1) {
    const low = [...point], high = [...point];
    low[axis] -= delta; high[axis] += delta;
    const finiteDifference = (interpolate(high, true).value - interpolate(low, true).value) / (2 * delta);
    assert.ok(Math.abs(masked.gradient[axis] - finiteDifference) < 1e-8,
      `masked gradient axis ${axis}: ${masked.gradient[axis]} vs ${finiteDifference}`);
  }
  assert.throws(() => normalizedMaskedInterpolationGradient([1], [1], [[0, Number.NaN, 0]]), RangeError);
});

test('stratified traffic-source fractions cover each mass stratum and are repeatable', () => {
  const first = stratifiedFractions(32, uniformGenerator(17));
  const second = stratifiedFractions(32, uniformGenerator(17));
  const sorted = [...first].sort((a, b) => a - b);
  assert.deepEqual(first, second);
  assert.equal(first.length, 32);
  for (let index = 0; index < sorted.length; index += 1) {
    assert.ok(sorted[index] >= index / 32 && sorted[index] < (index + 1) / 32);
  }
  assert.throws(() => stratifiedFractions(0, Math.random), RangeError);
});

test('uniform emissions use centered, equal-duration source-time strata', () => {
  const count = 420, duration = 600;
  const times = Array.from({ length: count }, (_, index) => stratifiedSampleTime(index, count, duration));
  assert.equal(times[0], duration / count / 2);
  assert.equal(times.at(-1), duration - duration / count / 2);
  assert.ok(times.every((time, index) => time >= index * duration / count
    && time < (index + 1) * duration / count));
  assert.ok(Math.abs(times.reduce((sum, time) => sum + time, 0) / count - duration / 2) < 1e-10);
  assert.throws(() => stratifiedSampleTime(420, 420, duration), RangeError);
  assert.throws(() => stratifiedSampleTime(0, 1, Number.NaN), RangeError);
});

test('traffic source clipping preserves only road length inside the valid model footprint', () => {
  const clipped = clipPolylineToValidSamples([[0, 0], [10, 0]], x => x >= 3 && x <= 8, 2);
  assert.equal(clipped.totalLengthM, 10);
  assert.equal(clipped.validLengthM, 6);
  assert.deepEqual(clipped.segments.map(segment => [segment.a[0], segment.b[0]]), [[2, 4], [4, 6], [6, 8]]);
  assert.equal(clipped.validLengthM / clipped.totalLengthM, 0.6);
  assert.throws(() => clipPolylineToValidSamples([[0, 0], [1, Number.NaN]], () => true), RangeError);
});

test('segment residence is split across traversed cells and clipped at map edges', () => {
  const grid = { left: 0, minZ: 0, right: 2, maxZ: 2, columns: 2, rows: 2 };
  const straight = segmentCellFractions(0.25, 0.25, 1.75, 0.25, grid);
  assert.deepEqual(straight, [
    { index: 0, startFraction: 0, endFraction: 0.5 },
    { index: 1, startFraction: 0.5, endFraction: 1 },
  ]);
  const diagonal = segmentCellFractions(0.25, 0.25, 1.75, 1.75, grid);
  assert.deepEqual(diagonal.map(cell => cell.index), [0, 3]);
  assert.deepEqual(diagonal.map(cell => cell.endFraction - cell.startFraction), [0.5, 0.5]);
  const clipped = segmentCellFractions(-1, 0.25, 3, 0.25, grid);
  assert.equal(clipped.reduce((sum, cell) => sum + cell.endFraction - cell.startFraction, 0), 0.5);
  assert.deepEqual(segmentCellFractions(-1, -1, -0.5, -0.5, grid), []);
  const bins = Array.from({ length: 2 }, () => new Float64Array(4));
  let totalResidence = 0;
  for (const cell of straight) {
    totalResidence += accumulateResidenceBins(bins, 4.5 + 2 * cell.startFraction,
      4.5 + 2 * cell.endFraction, cell.index, 2);
  }
  assert.equal(totalResidence, 4);
  assert.equal(bins.flatMap(bin => [...bin]).reduce((sum, value) => sum + value, 0), 4);
  assert.throws(() => segmentCellFractions(0, 0, 1, 1, { ...grid, columns: 0 }), RangeError);
});

test('trajectory residence clips to valid entry and exit fractions at a domain boundary', () => {
  const valid = x => x <= 0.625;
  const exiting = clipSegmentToValidIntervals([0, 2, 0], [1, 2, 0], valid);
  assert.ok(exiting);
  assert.ok(Math.abs(exiting[0][1] - 0.625) < 1e-6);
  assert.deepEqual(clipSegmentToValidIntervals([1, 2, 0], [0, 2, 0], valid), [[0.375, 1]]);
  assert.deepEqual(clipSegmentToValidIntervals([0, 2, 0], [0.5, 2, 0], valid), [[0, 1]]);
  const suffix = clipSegmentToValidIntervals([0, 2, 0], [0.5, 2, 0], x => x >= 0.25);
  assert.ok(suffix);
  assert.ok(Math.abs(suffix[0][0] - 0.5) < 1e-6);
  assert.deepEqual(clipSegmentToValidIntervals([0, 2, 0], [1, 2, 0], x => x >= 0.25 && x <= 0.75), [[0.25, 0.75]]);
  const split = clipSegmentToValidIntervals([0, 2, 0], [1, 2, 0], x => x < 0.4 || x > 0.6);
  assert.equal(split.length, 2);
  assert.equal(split[0][0], 0);
  assert.ok(Math.abs(split[0][1] - 0.4) < 1e-6);
  assert.ok(Math.abs(split[1][0] - 0.6) < 1e-6);
  assert.equal(split[1][1], 1);
  let probes = 0;
  clipSegmentToValidIntervals([0, 2, 0], [1, 2, 0], x => { probes += 1; return x < 0.5; }, 12,
    { startIsValid: true, midpointIsValid: false, endIsValid: false });
  assert.equal(probes, 12);
  assert.throws(() => clipSegmentToValidIntervals([0, 0], [1, 1], valid), RangeError);
});

test('building footprint intervals and holes are clipped from trajectory residence', () => {
  const outer = [[1, 1], [3, 1], [3, 3], [1, 3]];
  const courtyard = [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]];
  const footprint = segmentRingIntervals(0, 2, 4, 2, outer);
  const hole = segmentRingIntervals(0, 2, 4, 2, courtyard);
  assert.deepEqual(footprint, [[0.25, 0.75]]);
  assert.deepEqual(hole, [[0.375, 0.625]]);
  assert.deepEqual(subtractIntervals(footprint, hole), [[0.25, 0.375], [0.625, 0.75]]);
  assert.deepEqual(mergeIntervals([[0.4, 0.7], [0.1, 0.3], [0.2, 0.5]]), [[0.1, 0.7]]);
  assert.deepEqual(intersectIntervals([[0, 0.5], [0.7, 1]], [[0.25, 0.8]]), [[0.25, 0.5], [0.7, 0.8]]);
  assert.deepEqual(segmentPolygonSetIntervals(0, 2, 4, 2, [[outer, courtyard]], null, false),
    [[0.25, 0.375], [0.625, 0.75]]);
  const edges = [outer, courtyard].flatMap(ring => ring.map((point, index) => [
    ...point, ...ring[(index + 1) % ring.length],
  ]));
  assert.deepEqual(segmentPolygonSetIntervals(0, 2, 4, 2, [[outer, courtyard]], edges, false),
    [[0.25, 0.375], [0.625, 0.75]]);
  assert.deepEqual(segmentPolygonSetIntervals(1.1, 1.1, 1.2, 1.2, [[outer, courtyard]], [], true), [[0, 1]]);
  const building = { ring: outer, holes: [courtyard], baseY: 2, roofY: 8 };
  assert.deepEqual(segmentBuildingIntervals(0, 4, 2, 4, 4, 2, [building]), [[0.25, 0.375], [0.625, 0.75]]);
  assert.deepEqual(segmentBuildingIntervals(1.25, 0, 2, 1.25, 10, 2, [building]), [[0.2, 0.8]]);
  assert.deepEqual(segmentBuildingIntervals(0, 1, 2, 4, 1, 2, [building]), []);
  assert.deepEqual(segmentRingIntervals(2, 2, 2, 2, outer), [[0, 1]]);
  assert.throws(() => segmentRingIntervals(0, 0, 1, 1, [[0, 0], [1, 1]]), RangeError);
  assert.throws(() => segmentBuildingIntervals(0, 0, 0, 1, 1, 1, [{ ...building, roofY: 1 }]), RangeError);
});

test('near-ground residence is limited to the time fraction below the layer ceiling', () => {
  assert.deepEqual(clipSegmentBelowThreshold(12, 2, 10), [0.2, 1]);
  assert.deepEqual(clipSegmentBelowThreshold(2, 12, 10), [0, 0.8]);
  assert.deepEqual(clipSegmentBelowThreshold(2, 8, 10), [0, 1]);
  assert.equal(clipSegmentBelowThreshold(12, 11, 10), null);
  assert.throws(() => clipSegmentBelowThreshold(1, Number.NaN, 10), RangeError);
});

test('near-ground residence excludes trajectory time below the ground layer', () => {
  assert.deepEqual(clipSegmentWithinRange(2, -1, 0.45, 10), [0, 31 / 60]);
  assert.deepEqual(clipSegmentWithinRange(-1, 2, 0.45, 10), [29 / 60, 1]);
  assert.deepEqual(clipSegmentWithinRange(0.45, 10, 0.45, 10), [0, 1]);
  assert.equal(clipSegmentWithinRange(-3, -1, 0.45, 10), null);
  assert.equal(clipSegmentWithinRange(11, 12, 0.45, 10), null);
  assert.throws(() => clipSegmentWithinRange(1, 2, 3, 2), RangeError);
});

test('reflected ground crossings count both the approach and rebound portions of a step', () => {
  assert.deepEqual(clipReflectedSegmentWithinRange(2, -1, 0.45, 10), [0, 1]);
  assert.deepEqual(clipReflectedSegmentWithinRange(12, -1, 0.45, 10), [2 / 13, 1]);
  const reboundAboveCeiling = clipReflectedSegmentWithinRange(2, -20, 0.45, 10);
  assert.ok(reboundAboveCeiling);
  assert.equal(reboundAboveCeiling[0], 0);
  assert.ok(reboundAboveCeiling[1] < 1);
  assert.deepEqual(clipReflectedSegmentWithinRange(-1, 2, 0.45, 10), [29 / 60, 1]);
  assert.equal(clipReflectedSegmentWithinRange(-3, -1, 0.45, 10), null);
  assert.throws(() => clipReflectedSegmentWithinRange(1, 2, 3, 2), RangeError);
});

test('ground reflection reverses net normal velocity, including mean wind and settling', () => {
  const reflected = reflectNormalVelocityAtBoundary(-1, -0.5);
  assert.equal(reflected, 2.5);
  assert.equal(-1 + reflected, 1.5);
  assert.ok(Math.abs(reflectNormalVelocityAtBoundary(0.3, -1.2) - 0.6) < 1e-12);
  assert.equal(reflectNormalVelocityAtBoundary(0, -2), 2);
  assert.throws(() => reflectNormalVelocityAtBoundary(Number.NaN, 1), RangeError);
});

test('building reflection reverses incoming total velocity at a 3D wall and preserves tangent speed', () => {
  const mean = [1, 0, 0.5];
  const turbulence = [-3, 2, 1.5];
  const reflected = reflectVelocityAtBoundary(mean, turbulence, [2, 0, 0]);
  assert.deepEqual(reflected, [1, 2, 1.5]);
  const incoming = mean.map((value, axis) => value + turbulence[axis]);
  const outgoing = mean.map((value, axis) => value + reflected[axis]);
  assert.equal(outgoing[0], -incoming[0]);
  assert.deepEqual(outgoing.slice(1), incoming.slice(1));
  assert.deepEqual(reflectVelocityAtBoundary(mean, [1, 0, 0], [1, 0, 0]), [1, 0, 0]);
  assert.throws(() => reflectVelocityAtBoundary(mean, turbulence, [0, 0, 0]), RangeError);
});

test('perfect reflection preserves a uniform distribution in homogeneous Gaussian turbulence', () => {
  const count = 30_000, height = 20, sigma = 0.7, timeScale = 0.4;
  for (const dt of [0.025, 0.5 * timeScale]) {
    const random = normalGenerator(19177), uniform = uniformGenerator(28601);
    const positions = Float64Array.from({ length: count }, () => height * uniform());
    const velocities = Float64Array.from({ length: count }, () => sigma * random());
    for (let stepIndex = 0; stepIndex < Math.round(2 / dt); stepIndex += 1) {
      for (let particle = 0; particle < count; particle += 1) {
        const step = advanceOu(velocities[particle], sigma, timeScale, dt, random(), random());
        let nextPosition = positions[particle] + step.displacement;
        let nextVelocity = step.velocity;
        if (nextPosition < 0) {
          nextPosition = -nextPosition;
          nextVelocity = reflectNormalVelocityAtBoundary(0, nextVelocity);
        } else if (nextPosition > height) {
          nextPosition = 2 * height - nextPosition;
          nextVelocity = -Math.abs(nextVelocity);
        }
        positions[particle] = nextPosition;
        velocities[particle] = nextVelocity;
      }
    }
    const bins = new Uint32Array(20);
    for (const position of positions) bins[Math.min(bins.length - 1, Math.floor(position / height * bins.length))] += 1;
    const expected = count / bins.length;
    const maximumRelativeError = Math.max(...Array.from(bins, value => Math.abs(value - expected) / expected));
    assert.ok(maximumRelativeError < 0.1, `dt ${dt}: maximum bin error ${maximumRelativeError}`);
  }
});

test('residence accumulation conserves weighted time across timeline-bin boundaries', () => {
  const bins = Array.from({ length: 3 }, () => new Float64Array(2));
  const added = accumulateResidenceBins(bins, 4.25, 10.75, 1, 2);
  assert.equal(added, 13);
  assert.deepEqual(bins.map(bin => bin[1]), [1.5, 10, 1.5]);
  assert.equal(accumulateResidenceBins(bins, 0, 0, 0, 3), 0);
  assert.throws(() => accumulateResidenceBins(bins, 1, 2, -1, 1), RangeError);
  assert.throws(() => accumulateResidenceBins(bins, 14, 16, 0, 1), RangeError);
});
