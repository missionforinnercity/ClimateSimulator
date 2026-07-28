let canvas = document.querySelector('#scene');
const windCanvas = document.querySelector('#wind-overlay');
const windContext = windCanvas.getContext('2d');
const status = document.querySelector('#status');

function freshCanvas() {
  const replacement = canvas.cloneNode(false);
  canvas.replaceWith(replacement);
  canvas = replacement;
}

async function loadScene() {
  status.textContent = 'Loading scene…';
  const guide = document.querySelector('#wind-box-guide');
  if (guide) guide.hidden = false;
  try {
    const module = await import('./webglRenderer.js?v=12');
    await module.startWebGLScene(canvas, status);
  } catch (webglError) {
    console.warn('WebGL renderer unavailable; loading Canvas fallback:', webglError);
    status.textContent = 'GPU renderer unavailable · loading compatibility view…';
    freshCanvas();
    try {
      const module = await import('./sceneRenderer.js?v=52');
      await module.startScene(canvas, status);
    } catch (fallbackError) {
      console.error(fallbackError);
      status.textContent = `Viewer failed: ${fallbackError.message}`;
      return;
    }
  }
  const currentGuide = document.querySelector('#wind-box-guide');
  if (currentGuide) currentGuide.hidden = true;
  windContext.clearRect(0, 0, windCanvas.width, windCanvas.height);
}

freshCanvas();
loadScene();
