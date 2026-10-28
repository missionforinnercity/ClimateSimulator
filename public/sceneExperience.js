import { validateScenario } from './scenarioState.js';
import { CAMERA_MAX_DISTANCE, CAMERA_MIN_DISTANCE, CAMERA_MIN_ELEVATION } from './cameraControls.js';

// Adapter keeps saved views independent of Three.js camera classes.
export function attachSceneExperience({ canvas, readCamera, writeCamera, requestRender, fitScene, useLocation }) {
  const publish = () => dispatchEvent(new CustomEvent('climate-scene-state', { detail: { camera: readCamera() } }));
  addEventListener('climate-capture-view', publish);
  addEventListener('climate-restore-view', event => {
    const camera = validateScenario({ version: 1, tool: 'tools', camera: event.detail?.camera }, {}).camera;
    if (!camera) return;
    writeCamera(camera); requestRender(); publish();
  });
  addEventListener('climate-use-location', event => {
    const p = validateScenario({ version: 1, tool: 'tools', location: event.detail }, {}).location;
    if (p && ['sun', 'wind'].includes(event.detail.tool)) useLocation(event.detail.tool, p);
  });
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') fitScene();
    else {
      const camera = readCamera();
      if (event.key === 'ArrowLeft') camera.azimuth -= .08;
      if (event.key === 'ArrowRight') camera.azimuth += .08;
      // Match the direct mouse/touch orbit convention: left/up decrease the
      // corresponding screen axis and right/down increase it.
      if (event.key === 'ArrowUp') camera.elevation = Math.max(CAMERA_MIN_ELEVATION, camera.elevation - .06);
      if (event.key === 'ArrowDown') camera.elevation = Math.min(1.35, camera.elevation + .06);
      if (['+', '='].includes(event.key)) camera.distance = Math.max(CAMERA_MIN_DISTANCE, camera.distance * .9);
      if (event.key === '-') camera.distance = Math.min(CAMERA_MAX_DISTANCE, camera.distance / .9);
      writeCamera(camera);
    }
    requestRender(); publish();
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    const status = document.querySelector('#status');
    status.textContent = 'Graphics context lost. Save your settings, then reload the viewer.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Reload graphics';
    retry.addEventListener('click', () => location.reload()); status.after(retry);
  }, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestRender(); });
  publish();
}
