// Estimate the share of a selected square covered by mapped canopy polygons.
// One sample per grid cell avoids double-counting overlapping footprints.
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function summarizeMappedCanopy(bounds, canopyRecords) {
  const width = Number(bounds?.max_x) - Number(bounds?.min_x);
  const height = Number(bounds?.max_z) - Number(bounds?.min_z);
  if (!(width > 0) || !(height > 0) || !Array.isArray(canopyRecords)) return null;
  const columns = Math.max(1, Math.ceil(width / Math.max(2, width / 250)));
  const rows = Math.max(1, Math.ceil(height / Math.max(2, height / 250)));
  const dx = width / columns, dz = height / rows;
  const covered = new Uint8Array(columns * rows);
  for (const record of canopyRecords) {
    const rings = record?.[5];
    if (!Array.isArray(rings) || !rings.length) continue;
    const exterior = rings[0];
    if (!Array.isArray(exterior) || exterior.length < 3) continue;
    const xs = exterior.map(point => Number(point[0])), zs = exterior.map(point => Number(point[1]));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    if (maxX < bounds.min_x || minX > bounds.max_x || maxZ < bounds.min_z || minZ > bounds.max_z) continue;
    const colStart = Math.max(0, Math.ceil((minX - bounds.min_x) / dx - .5));
    const colEnd = Math.min(columns - 1, Math.floor((maxX - bounds.min_x) / dx - .5));
    const rowStart = Math.max(0, Math.ceil((minZ - bounds.min_z) / dz - .5));
    const rowEnd = Math.min(rows - 1, Math.floor((maxZ - bounds.min_z) / dz - .5));
    for (let row = rowStart; row <= rowEnd; row++) {
      const z = Number(bounds.min_z) + (row + .5) * dz;
      for (let column = colStart; column <= colEnd; column++) {
        const index = row * columns + column;
        if (covered[index]) continue;
        const x = Number(bounds.min_x) + (column + .5) * dx;
        if (!pointInRing(x, z, exterior)) continue;
        if (rings.slice(1).some(hole => pointInRing(x, z, hole))) continue;
        covered[index] = 1;
      }
    }
  }
  const coveredCells = covered.reduce((sum, value) => sum + value, 0);
  return { status: 'ready', canopy_cover_pct: coveredCells / covered.length * 100,
    sample_spacing_m: Math.max(dx, dz), covered_cells: coveredCells, sampled_cells: covered.length,
    source: 'Mapped canopy footprints in the scene; approximate area share from a square sampling grid.' };
}
