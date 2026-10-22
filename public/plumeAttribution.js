// Source attribution uses the same unsmoothed cell visits as the plume grid.
// It is a tracer-residence accounting tool, not an ambient concentration model.
export function recordSourceResidence(byEdge, edgeId, cellIndex, weight, cellCount) {
  if (!edgeId || !Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= cellCount || !(weight > 0)) return;
  let cells = byEdge.get(edgeId);
  if (!cells) {
    cells = new Float64Array(cellCount);
    byEdge.set(edgeId, cells);
  }
  cells[cellIndex] += weight;
}

export function summarizeSourceResidence(byEdge, totalCells, area, grid) {
  const { left, minZ, right, maxZ, columns, rows } = grid;
  const width = (right - left) / columns;
  const depth = (maxZ - minZ) / rows;
  const indices = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = left + (column + 0.5) * width;
      const z = minZ + (row + 0.5) * depth;
      if (Math.hypot(x - area.x, z - area.z) <= area.radiusM) indices.push(row * columns + column);
    }
  }
  const areaTotal = indices.reduce((sum, index) => sum + totalCells[index], 0);
  const sources = [...byEdge].map(([edgeId, cells]) => ({
    edgeId,
    residence: indices.reduce((sum, index) => sum + cells[index], 0),
  })).filter(item => item.residence > 0).sort((a, b) => b.residence - a.residence);
  const sourceTotal = sources.reduce((sum, item) => sum + item.residence, 0);
  for (const source of sources) source.share = sourceTotal > 0 ? source.residence / sourceTotal : 0;
  return { areaTotal, sourceTotal, sources, cellCount: indices.length, difference: sourceTotal - areaTotal };
}
