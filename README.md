# Climate Explorer

Standalone lightweight Cape Town CBD 3D viewer. It does not depend on forge3d.

## Build the scene

```bash
python scripts/build_scene.py
```

## Run locally

```bash
python -m http.server 8000 -d public
```

Open http://localhost:8000 in a WebGL2-capable browser.
