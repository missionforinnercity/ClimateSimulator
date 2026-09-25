// Keep the blue/green/yellow/orange/red stress groups, with extra shades inside
// each group so neighboring values remain easier to distinguish.
const anchors = [
  [-40, 0x49379b], [-27, 0x3f48ad], [-13, 0x3454bd], [0, 0x2589ce],
  [6, 0x1a9bdc], [9, 0x1683e5], [13, 0x14a5df], [16, 0x12b9d2],
  [19, 0x1ccf9c], [20.5, 0x31d17d], [22, 0x48d260], [24, 0x7bd443],
  [26, 0xb4dc35], [27, 0xd8d52c], [28, 0xf4cf24], [30, 0xf7ad20],
  [32, 0xfa8d1d], [35, 0xf36a20], [38, 0xed4825], [42, 0xd83732], [46, 0xbd293c],
];
export const UTCI_COLOR_MIN = anchors[0][0];
export const UTCI_COLOR_MAX = anchors.at(-1)[0];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function percentileColorPosition(value, percentileValues) {
  if (!Number.isFinite(value) || !Array.isArray(percentileValues) || percentileValues.length < 2) {
    throw new Error('Percentile color scale requires finite, ordered thresholds');
  }
  const last = percentileValues.length - 1;
  if (!Number.isFinite(percentileValues[0]) || !Number.isFinite(percentileValues[last])) {
    throw new Error('Percentile color scale requires finite, ordered thresholds');
  }
  if (percentileValues[0] === percentileValues[last]) return 0.5;
  if (value < percentileValues[0]) return 0;
  if (value > percentileValues[last]) return 1;

  let low = 0, high = percentileValues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (percentileValues[middle] < value) low = middle + 1;
    else high = middle;
  }
  if (percentileValues[low] === value) {
    let end = low + 1;
    while (end < percentileValues.length && percentileValues[end] === value) end += 1;
    return (low + end - 1) / (2 * last);
  }
  const previous = low - 1;
  const amount = (value - percentileValues[previous]) / (percentileValues[low] - percentileValues[previous]);
  return (previous + amount) / last;
}

export function temperatureColor(value) {
  let upper = 1;
  while (upper < anchors.length - 1 && value > anchors[upper][0]) upper += 1;
  const [low, a] = anchors[upper - 1], [high, b] = anchors[upper];
  const t = clamp((value - low) / (high - low), 0, 1);
  return [16, 8, 0].reduce((hex, shift) => hex | Math.round(
    ((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t,
  ) << shift, 0);
}
let cached;
let fixedCached;
export function utciAbsolutePalette() {
  if (fixedCached) return fixedCached;
  const stops = anchors.map(([temperature, color]) => [
    (temperature - UTCI_COLOR_MIN) / (UTCI_COLOR_MAX - UTCI_COLOR_MIN), color,
  ]);
  const gradient = `linear-gradient(90deg, ${stops.map(([t, hex]) =>
    `#${hex.toString(16).padStart(6, '0')} ${(t * 100).toFixed(3)}%`).join(', ')})`;
  fixedCached = { min: UTCI_COLOR_MIN, max: UTCI_COLOR_MAX, stops, gradient };
  return fixedCached;
}
export function utciPalette(minimum, maximum) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) {
    throw new Error('UTCI palette requires a finite ordered temperature range');
  }
  if (cached?.min === minimum && cached?.max === maximum) return cached;
  const midpoint = (minimum + maximum) / 2;
  // Stretch narrow frames across most of the prevailing thermal palette so
  // relative hotspots stand out. Temperature bands keep cool hours blue/green
  // and hotter hours yellow/orange/red.
  const band = midpoint < 9 ? [-40, 9] : midpoint < 26 ? [9, 26]
    : midpoint < 38 ? [28, 38] : [38, 46];
  const flat = maximum - minimum < 0.1;
  const low = flat ? midpoint : Math.min(minimum, Math.max(band[0], minimum - 8));
  const high = flat ? midpoint : Math.max(maximum, Math.min(band[1], maximum + 8));
  const stops = flat ? [[0, temperatureColor(midpoint)], [1, temperatureColor(midpoint)]] : [
    [0, temperatureColor(low)],
    ...anchors.filter(([temp]) => temp > low && temp < high)
      .map(([temp, color]) => [(temp - low) / (high - low), color]),
    [1, temperatureColor(high)],
  ];
  const gradient = `linear-gradient(90deg, ${stops.map(([t, hex]) =>
    `#${hex.toString(16).padStart(6, '0')} ${(t * 100).toFixed(3)}%`).join(', ')})`;
  cached = { min: minimum, max: maximum, stops, gradient };
  return cached;
}
