let canvas = document.querySelector('#scene');
const windCanvas = document.querySelector('#wind-overlay');
const windContext = windCanvas.getContext('2d');
const status = document.querySelector('#status');

function freshCanvas() {
  const replacement = canvas.cloneNode(false);
  canvas.replaceWith(replacement);
  canvas = replacement;
}

function loadScene() {
  status.textContent = 'Loading scene…';
  const guide = document.querySelector('#wind-box-guide');
  if (guide) guide.hidden = false;
  import('./sceneRenderer.js?v=29')
    .then(module => module.startScene(canvas, status))
    .then(() => {
      const guide = document.querySelector('#wind-box-guide');
      if (guide) guide.hidden = true;
      windContext.clearRect(0, 0, windCanvas.width, windCanvas.height);
    })
    .catch(error => {
      console.error(error);
      status.textContent = `Compatibility view failed: ${error.message}`;
    });
}

// WebGL rendering was unreliable across browsers/GPUs in this environment, so
// the viewer always uses the Canvas 2D compatibility renderer.
freshCanvas();
loadScene();
