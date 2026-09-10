export const CAMERA_DRAG_SENSITIVITY = 0.006;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

// Direct camera controls: dragging right/down moves the orbit right/down.
// Pointer Events feed both mouse and touch through this same calculation.
export function orbitFromDrag(start, dx, dy) {
  return {
    azimuth: start.azimuth + dx * CAMERA_DRAG_SENSITIVITY,
    elevation: clamp(start.elevation + dy * CAMERA_DRAG_SENSITIVITY, 0.16, 1.35),
  };
}

// Shift/middle/right mouse drag and two-finger touch pan use identical signs.
export function panFromDrag(distance, dx, dy) {
  const scale = distance / 850;
  return { right: dx * scale, forward: -dy * scale };
}
