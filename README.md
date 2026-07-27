# Climate Explorer

Standalone lightweight Cape Town CBD 3D viewer.

## Build the scene

```bash
python scripts/build_scene.py
```

This writes `public/assets/fallback.json` (the footprint/tree/road/grass scene
data) and `public/assets/manifest.json`. The viewer renders everything with
Canvas 2D — there is no WebGL/GPU mesh path.

## Run locally

```bash
python -m http.server 8000 -d public
```

Open http://localhost:8000 in any modern browser.

## Wind explorer API

The viewer can run as a single FastAPI application. It loads `DATABASE_URL`
from `.env` on the server only; the database URL is never sent to the browser.

```bash
uvicorn server.app:app --reload --port 8000
```

Open http://localhost:8000. The Wind explorer supports an explicitly editable
analysis domain, directional and seasonal scenarios, a speed slider, and a
particle-first flow display without a blocky raster overlay. Clicking the city
normally orbits the camera; use **Move / resize domain** when repositioning the
box. Existing flow remains visible while editing and changes only when
**Simulate wind** is clicked.

The **Urban heat** layer reads the generated local product in
`data/raw/scene_footprint_heat_2026_academic_v3_zones.geojson` and renders a
the simplified vector `heat_model_lst_c` zones on the scene ground. Heat mode
focuses the view on white buildings, green trees, and the heat surface; the
database `climate.heat_zones` table remains a fallback when the local product
is absent.

Install the API dependencies with:

```bash
python -m pip install -r requirements.txt
```

The additive database migration is `migrations/001_wind_fields.sql`. It adds
version metadata and compressed vector-tile storage for future validated fields;
the existing `wind.ventilation_*` tables are preserved. To export reproducible
proxy fields for all 16 compass directions plus Cape Doctor:

```bash
python scripts/export_wind_proxy_fields.py
```

Current fields combine two sources: the database's directional speed-factor
polygons (a micro-scale ventilation classification, still not measured local
vector directions or validated CFD results) multiplied against a terrain-
resolved direction and speed factor from the mass-conserving regional wind
model described below. Neither replaces validated CFD.

In Canvas compatibility mode, animated streamline particles use the selected
direction and combined speed field, then apply footprint-aware building
deflection, downstream wake cues, and porous tree-canopy drag. This local
interaction is intended for exploratory visualisation; physically validated
wakes and vortices still require CFD-derived `u/v` fields.

## Terrain-aware regional wind

The CBD LiDAR mesh is intentionally detailed and local, but Table Mountain and
its surrounding peaks sit several km away and physically shape how wind
(especially the SE "Cape Doctor") arrives at the CBD. The viewer only ever
renders the CBD itself — no regional mountain backdrop — but the wind
simulation still accounts for how the mountain shapes airflow before it
reaches the city. Build the terrain-resolved wind fields from the supplied
SRTM tiles with:

```bash
python scripts/export_regional_wind_fields.py \
  --dem /home/anees/mission_projects/shadow_and_wind/s34_e018_1arc_v3.tif \
       /home/anees/mission_projects/shadow_and_wind/s35_e018_1arc_v3.tif
```

`export_regional_wind_fields.py` runs a diagnostic mass-conserving
(WindNinja-style) solver over an 8km regional heightfield for every compass
direction: an initial terrain-following flow seeded from local slope, then an
iterative divergence-removal pass (`server/terrain_wind.py`) that treats
terrain rising more than ~50m above its surrounding 1km neighbourhood as a
blocking wall, so flow channels through gaps/saddles and decelerates in the
lee instead of running in one constant direction irrespective of the
mountain. Results are cached as `data/wind_fields/regional/<direction>.npz`;
`server/field.py::build_field` crops/resamples the nearest direction's field
to the requested preview window and multiplies it into the existing
ventilation-polygon speed factor. If this cache is absent (e.g. a bare
checkout), `build_field` falls back to the original constant-vector proxy.
