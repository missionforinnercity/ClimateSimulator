export const CAMERA_DRAG_SENSITIVITY = 0.006;
export const CAMERA_MIN_DISTANCE = 80;
export const CAMERA_MAX_DISTANCE = 7000;
export const CAMERA_MIN_ELEVATION = 0.35;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

// Pointer Events feed mouse and one-finger touch through the same orbit math.
export function orbitFromDrag(start, dx, dy) {
  return {
    // Move the camera against the pointer so the scene follows the drag.
    azimuth: start.azimuth - dx * CAMERA_DRAG_SENSITIVITY,
    elevation: clamp(start.elevation - dy * CAMERA_DRAG_SENSITIVITY, CAMERA_MIN_ELEVATION, 1.35),
  };
}

// Shift/middle/right mouse drag and two-finger touch pan share screen-space
// movement. Pixel scaling follows the camera's perspective and canvas size.
export function panFromDrag(distance, dx, dy, viewportHeight = 850, fieldOfView = 46) {
  const height = Math.max(1, viewportHeight);
  const scale = (2 * distance * Math.tan(fieldOfView * Math.PI / 360)) / height;
  return { right: -dx * scale, forward: -dy * scale };
}
