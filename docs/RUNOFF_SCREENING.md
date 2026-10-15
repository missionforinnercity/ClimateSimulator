# Terrain-only runoff concentration screen

The optional **Runoff concentration** map layer reuses the checked-in 2 m
hybrid terrain and mapped surface inventory. It routes mapped paved cells over
the terrain to show relative contributing area; the rainfall slider reports
gross rainfall volume on the mapped pavement footprint for an illustrative
depth.

## Method and inputs

- `data/derived/company_gardens_hybrid_dem_2m.tif`: 2 m terrain grid.
- `data/osm_cbd_groundcover.geojson`: paved polygons rasterized to that grid.
- Priority-Flood fills closed depressions, then a single-direction D8 graph
  routes accumulated area toward the terrain grid edge. The browser asset keeps
  cells with at least 64 m² of mapped contributing area.
- The slider defaults to 25 mm and changes only the gross volume summary:
  mapped paved area × rainfall depth. It does not rerun terrain processing.

Rebuild the static display asset after either input changes:

```bash
.venv/bin/python scripts/build_runoff_screening.py
```

The builder writes `public/assets/runoff_screening.bin` and its JSON manifest.
The frontend fetches them only after the layer is enabled.

## Interpretation limits

The source assumption is 100% immediate runoff from rainfall on mapped paved
cells. Vegetation, water and unmapped cells add no source area in this screen.
The terrain route is relative flow concentration, not a prediction of water
depth or flood extent. Rainfall duration, intensity and return period, soil
infiltration, roofs, surface losses, kerbs, culverts, storm drains, observed
ponding and flood depth are not modelled. Mapped absence is unknown. Do not use
the display to rank flood risk or claim intervention benefits without drainage
data and validation against observations or an authoritative study.
