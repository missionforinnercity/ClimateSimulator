# Climate Explorer

Standalone lightweight Cape Town CBD 3D viewer.

## Build the scene

```bash
python scripts/build_hybrid_dem.py
python scripts/build_hybrid_buildings.py
python scripts/build_scene.py
```

`build_hybrid_dem.py` retains every valid 2025 LiDAR cell, then fills only the
Company's Garden supplement with locally calibrated 30 m SRTM. The supplement
includes the garden and mapped surrounding edge streets, uses a rounded
boundary, and records provenance per 2 m output cell (`1=LiDAR`, `2=SRTM`).
The current product adds about 110,080 m² of lower-accuracy terrain and applies
a documented −7.923 m SRTM-to-local offset plus seam blending.

This writes `public/assets/city_model.json` (the canonical CityGML 3.0-aligned
semantic application model), `public/assets/fallback.json` (a legacy compact
renderer asset), `public/assets/canopy.json` (the footprint-preserving LiDAR canopy),
`public/assets/roof_surface.bin` (the footprint-clipped 1 m height-map roof
surface sampled at 2 m), and `public/assets/manifest.json`. Roof processing
tests raster coverage per building, anchors samples to surveyed height, rejects
robust height outliers, fills small gaps, and fits credible flat, gently sloped,
gable, and hip roof volumes. Ambiguous surfaces become regularized flat roofs
instead of retaining tree, façade-edge, or pixel-scale spikes. Buildings
without enough raster coverage retain their mapped `BLD_HGT` extrusion. The
supplied height map already stores height above ground, so roof vertices are
placed at DTM elevation plus the raster value; the DTM is not subtracted a
second time.

Building geometry is a hybrid: current OpenStreetMap outlines and mapped
`building:part` shapes supply stepped massing, while the municipal
photogrammetry layer fills places where OSM has no reliable coverage. Explicit
OSM `height` values are retained; otherwise each OSM part is fitted to the 2025
LiDAR height and roof surface. This avoids treating incomplete OSM level tags
as authoritative while preserving curved and setback geometry. The derived
footprint product remains subject to ODbL attribution and share-alike terms.
The scene boundary is derived from the hybrid DTM's valid-pixel mask, not the
rectangular GeoTIFF envelope. Terrain triangles, buildings, canopy, roads,
railways, grass, heat zones, and interaction are clipped to the irregular
LiDAR-plus-Company's-Garden footprint; remaining NoData pixels are not
presented as mapped ground.
The viewer uses a vendored, pinned
Three.js WebGL renderer for the city, terrain-following wind heatmaps, white
GPU gusts, heat geometry, and directional-light shadow maps. The existing
Canvas 2D renderer remains an automatic compatibility fallback when WebGL 2
is unavailable.

The semantic model gives each object a stable `identifier` and version-specific
`featureId`, named geometry, source records, lifecycle fields, geometry quality,
and an LoD. It separates buildings from their roof surfaces and represents
roads, pedestrian routes, railways, terrain, plant cover, and individual tree
instances as typed objects. Empty WaterBody and CityFurniture modules document
known coverage gaps. The JSON is intentionally described as a CityGML-aligned
application encoding rather than a conformant CityGML GML/XML exchange file.

When `data/street_data` is present, the build clips its City of Cape Town road
centrelines, public lights, monuments, public toilets, pedestrian crossings,
on-street parking, survey marks, and festoon lighting to the actual terrain
footprint. Municipal road keys and attributes become the authoritative semantic
carriageway records; OSM footways and pedestrian paths are retained as a
complementary source because they are not represented in the municipal road
product. Point-only street assets render as lightweight instanced context and
remain explicitly LoD0 until surveyed dimensions or 3D templates are available.
The street-data building-footprint file is byte-for-byte identical to the
existing raw footprint source, so it is intentionally referenced once rather
than duplicating all buildings in the city model.

Festoon-lighting alignments render as building-mounted installations rather
than flat map lines. Open corridors are resampled into short zig-zag spans with
anchors snapped to alternating nearby façades at a height allowed by each
building. Closed gallery alignments follow their nearest façade. Every span has
a sagging cable, wall anchors, sockets, warm emissive bulbs, additive glow, and
a limited set of façade-filling lights for performance.

Municipal public lights use their actual support class, wattage, lamp count,
and nearest-road direction to select a South African-style post-top, whip,
side-entry, bracket, double-arm, floodlight, or high-mast assembly. Since the
inventory has no measured pole height, the semantic object explicitly records
a low-confidence 6/8/10/12/18 m support-and-wattage inference. Parking points
render as oriented 5.2 x 2.4 m marked bays. Crossings use the municipal road
direction and inferred full carriageway width to render zebra markings. The
St George's Mall / Strand Street installation uniquely renders the supplied
African-daisy field between two zebra bands; nearby duplicate crossing points
are suppressed. Public toilets use a recognizable generic WC facility model,
while monuments remain semantic-only until object-specific models are supplied.
Crossing records are additionally consolidated by road, position, and bearing
before rendering, and all markings sit above the highest road ribbon. Parking
points form straight curbside runs with shared edges and dividers instead of
overlapping boxes; their paint is deliberately muted and semi-transparent.
Parking, crossings, and fine street furniture are distance-culled at district
scale and return automatically when zooming toward street level.

Mapped OpenStreetMap point amenities round out the public realm with
lightweight procedural fountains, benches, litter bins, bicycle stands,
bollards, street clocks, and bus-stop markers. Their positions and tags come
from OSM; dimensions and unmapped orientations remain explicitly inferred
rather than being presented as surveyed object-specific models. These details
are instanced and distance-culled so they do not materially inflate the scene
or district-scale draw cost.

Municipal road geometry is simplified before export and implausible source
widths are replaced with lane-derived widths capped at 18 m. The renderer builds
each centreline segment as an independent terrain-following quad, then closes
the joins with bounded round patches. A duplicate point or sharp source
reversal therefore cannot fold a triangle strip across a block. Crossing and
parking extents only combine parallel halves of the same named street, keeping
paint aligned to the carriageway at junctions and around unnamed service roads.
The complete OSM network remains the visible carriageway layer so split City
records cannot leave gaps and OSM primary, secondary, tertiary, and local-road
classes retain their distinct hierarchy colours. Municipal centrelines remain
available as non-rendered semantic and traffic-enrichment records.

Active rail and tram centre-lines come from `data/osm_cbd_railways.geojson`.
The renderer places tracks below road ribbons so roads cover rails at
crossings. Road and path ribbons use their mapped class widths, render as
separate layers, and use capped endpoints plus deterministic class priority at
overlaps.

Sun shadows use the complete building footprint geometry rather than a convex
outline approximation. The shadow map is regenerated only when **Generate
shadows** is clicked after changing the date or time; orbiting the camera reuses
the GPU depth texture. A dedicated shadow-catching terrain layer keeps the
ground shadows solid and visually separate from building surface lighting.
Canopy shadows use all clipped components from `tree_canopy.geojson`, including
holes, rather than sampled ellipsoid crowns.

## Run locally

Python 3.12 is the supported runtime. Direct dependencies are declared in
`server/requirements.txt`; `requirements.lock` and `requirements-dev.txt` pin
the complete runtime and test environments for reproducible installs.

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m http.server 8000 -d public
```

Open http://localhost:8000 in any modern browser.

For the API-backed application, use `.venv/bin/uvicorn server.app:app --port
8000`. Production deployments can run `docker compose up --build`: Nginx serves
and compresses the static assets while proxying `/api` to one bounded API
worker. Versioned scene assets receive immutable cache headers; the manifest
and viewer shell revalidate so incompatible code and assets are not mixed.

Deployment controls are environment variables:

- `ALLOWED_ORIGINS` is a comma-separated CORS allow-list (local port 8000 only
  by default).
- `CLIMATE_EXPLORER_API_KEY`, when set, requires `X-API-Key` on API routes other
  than the health check.
- `SIMULATION_RATE_LIMIT` and `SIMULATION_RATE_WINDOW_S` control the per-client
  expensive-request budget (12 per minute by default).
- `HEAT_CONCURRENCY`, `SUNLIGHT_CONCURRENCY`, `WIND_CONCURRENCY`,
  `WIND_COMFORT_CONCURRENCY`, `FLOOD_CONCURRENCY`, and `TRAFFIC_CONCURRENCY`
  bound CPU-heavy work. Over-capacity requests fail quickly instead of forming
  an unbounded queue.

`GET /api/health` checks generated assets and model compatibility, the SUMO
binary/network, and the optional database connection. Request logs are
structured JSON and include an `X-Request-ID`. `.env` is excluded from both Git
and the Docker build context.

## Public transport explorer

The Transport tab adds timetable-derived 3D MyCiTi buses and Metrorail trains,
bold network-map routes, a neutral rail track layer, clickable
stops and stations, an accelerated service clock, and event-access planning.

Set the event venue either from the hub list or by clicking anywhere on the
map ("Pick venue on map", Esc to cancel). With a date, time window, walking
catchment, dispersal window, attendance and public-transport mode share, the
panel reports connected origin areas, arrival and return service counts, how
much of an event-demand proxy the return services' nominal scheduled capacity
actually covers, and a ranked list of interventions: which corridors and
route directions to extend and until when, how many extra trips that is, and
how much nominal capacity is missing. Every capacity figure is a scheduled
places-per-departure assumption (60 for a bus, 800 for a train), not measured
or validated real occupancy data, so treat coverage and capacity-gap numbers
as a planning proxy and verify them with the operator. Clicking a
stop shows the routes calling there and the next modelled departures.

Rail arrivals and departures use `data/transport/prasa_schedules.csv` for
weekday and weekend service on matched corridors; unmatched service remains
clearly labelled as an estimate. Vehicle positions are inferred from schedules
and are not live GPS. Rebuild the
compact transport asset with
`python scripts/build_transport_asset.py`. Implementation notes, confidence
rules, and the next development phase are in `docs/PUBLIC_TRANSPORT.md`.

## Traffic and street-status explorer

Run the FastAPI application to enable paired SUMO closure previews. The
traffic panel lets you draw a short or long closure directly on the 3D map. The
freehand pen snaps to the SUMO road network and can close one lane or the whole
street, then compare mapped traffic-signal programs with priority right-of-way
and replay baseline or
closure traffic. Demand uses a representative car, minibus-taxi, delivery-van,
and shuttle fleet; it remains synthetic and is not a calibrated transport
forecast.

The 3D street-status layer distinguishes permanent OSM pedestrian streets,
live provider closures, the simulated closure, and roads gaining or losing
traffic after rerouting. The selected road carries directional arrows, while
closure blocks use barricades, beacons, and a floating road-closure sign.
The SUMO network is generated with left-hand traffic for South African lane
placement and junction behaviour. In lane mode, each selected directional road
section closes its left-side kerbside lane; select both opposing sections to
model one closed lane in each direction. The orange overlay follows the actual
lane geometry rather than the shared road centreline. Closure results include
queue, route-length, completion, speed, delay, and road-level diversion metrics. The representative
fleet carries HBEFA3 emission classes, allowing both runs to compare corridor
CO₂, NOx, exhaust PMx, fuel use, and relative edge-noise emissions. Nearby mapped parking
and pedestrian crossings are reported as context only; they do not create
invented occupancy or pedestrian demand. Completed comparisons can generate a
print-ready A4 report with a plain-language finding, recommended action,
scenario definition, impact diagram, before/after tables, environmental
estimates, and data provenance; the browser print dialog can save it as PDF.
The synthetic base load is stability-tuned at 50 corridor departures per
minute. Reports withhold impact claims if the open-road run completes less than
85% of demand, either run times out, or the paired sample is below 20%. This is
not a substitute for observed counts or an origin-destination calibration; see
`docs/TRAFFIC_VALIDATION.md` for the report review, sweep results and evidence
needed to promote the model beyond exploratory use.
Changing the sampling window extends the same reproducible traffic stream, so
a 20-minute comparison is a longer observation of the 10-minute scenario rather
than a newly randomised population. Rebuild the SUMO
network after refreshing OSM data with:

```bash
python scripts/build_sumo_network.py --reuse-osm
```

## Wind explorer API

The viewer can run as a single FastAPI application. It loads `DATABASE_URL`
from `.env` on the server only; the database URL is never sent to the browser.

```bash
uvicorn server.app:app --reload --port 8000
```

Open http://localhost:8000. The Wind explorer separates single-direction
diagnostics from 16-direction wind-rose-weighted comfort screening. Its
Jifto-inspired controls expose the editable domain, result height, grid,
period, stability, activity threshold, surface layer and flowline appearance.
Clicking the city
normally orbits the camera; use **Move / resize domain** when repositioning the
box, or drag its corner handle to resize it. Gusts are constrained to free
pedestrian ground and use a wall-normal/tangential response to slide around
building footprints. Editing clears the old field; click **Run direction
study** or **Run 16-direction comfort study** to calculate the new domain.

The **Urban heat** layer reads the generated local product in
`data/raw/scene_footprint_heat_2026_academic_v3_zones.geojson` and renders a
set of simplified vector zones on the scene ground. It defaults to an
intervention-priority view combining the fixed Summer 2025-26 surface-temperature
baseline (70% weight) with a shade deficit computed for the user-selected date
and time (30% weight). Because the temperature term does not vary with the
selected date, only the shade term does, this is labelled a "summer thermal
baseline + selected-date shade scenario" rather than a fully date-specific
result — a winter date pairs winter shade geometry with the summer-baseline
temperature. Priority and shade retain
every surface-temperature zone rather than dropping building-heavy cells, so
the screening surface remains continuous.
Users can switch to pedestrian thermal exposure (a proxy thermal-exposure
delta, not UTCI/PET or a measured pedestrian temperature), shade deficit, the
original `heat_model_lst_c` surface temperature, or a rooftop-temperature view clipped
to mapped building footprints and conformed to the detailed rendered roof
surface rather than the LiDAR terrain. Ground-level heat views hide roads and
paths so those layers do not cover the thermal surface; rooftop mode retains
them for orientation alongside white buildings, green trees, and the heat surface. The
database `climate.heat_zones` table remains a fallback when the local product
is absent.

The **Sunlight** panel provides both instantaneous GPU shadows and cumulative
direct-sun hours. Ground sun is accumulated from mapped shadow overlap. The 3D
building study places analysis cells on roofs and outward-facing façades, casts
a clear-sky ray toward every sampled sun position, and tests it against mapped
opaque building prisms and canopy volumes. Ground, building, or combined
surfaces can be selected over an editable daily window at 15, 30, or 60 minute
steps. Full-CBD building grids are available at 20 m (faster) and 10 m
(detailed); a 20 m all-surface study contains roughly 25,000 cells. Unlike
Jifto's OptiX implementation, this CPU planning approximation uses flat roof
planes and does not ray-test terrain, detailed roof slopes, diffuse light, or
reflections, so it is not a regulatory solar-radiation calculation.

The former intervention-painting preview has been removed. Heat outputs remain
screening evidence rather than measured or engineering-grade performance
claims. Rooftop values are the source model's land-surface temperature painted
directly onto the detailed roof triangles; they are not measured roof-membrane
temperatures.

Wind results include stability-dependent pedestrian-height conversion,
Lawson-LDDC-style screening categories, conditional threshold exceedance,
wind-rose-weighted seasonal/annual comfort, and model-form uncertainty bands.
The interface and API label these outputs **Screening**. The installed ERA5
archive covers only 35.4% of possible hours, so its directional frequencies
and comfort results remain provisional. See `docs/WIND_VALIDATION.md` for the
calculation, Jifto comparison, benchmark workflow, observation schema, error
maps, and promotion criteria for a future validated mode.

When `data/wind_climatology/cape_town_era5.json` is present, the Wind panel
defaults to ERA5 forcing. Direction, season and stability select the measured
reanalysis subset; its conditional mean speed, Weibull distribution, gust
factor and 10–100 m shear replace the generic forcing assumptions. Rebuild the
compact profile with `python scripts/build_era5_wind_climatology.py` after
updating the GRIB archive.

After a wind simulation completes, **Generate detailed wind report** opens a
print-ready assessment containing the scenario definition, captured 3D view,
reproducible pedestrian-speed field map, comfort distribution, exceedance and
uncertainty indicators, ERA5 evidence, data-quality notes, and model
limitations. Use **Print / Save PDF** in the report toolbar for an A4 report.

## Current conditions and planning guidance

Run the FastAPI application to enable **Current conditions**. The server
proxies and normalizes Open-Meteo's modelled Cape Town CBD weather, caches it
for ten minutes, and retains the last successful value when a refresh fails.
Activating Current updates Cape Town local sun time and shadows, then uses the
10 m wind as forcing for the exploratory 2 m pedestrian wind field. Set
`WEATHER_API_BASE_URL` to use a compatible paid or self-hosted endpoint.

The current weather is not a station observation, and the heat layer remains
the explicitly labelled Summer 2025–26 baseline. The heat panel combines the
map with an area-weighted summary, a top-decile priority-hotspot measure and
response guidance for shade, planting, hard surfaces and roofs. Relevant
stormwater responses sit in the flood panel so that possible interventions are
read alongside the evidence and limitations they depend on. These are
screening prompts, not measurements or engineering-grade recommendations.

## Surface flood simulator

The WebGL viewer includes a rain-on-grid surface-flood tool. It runs a
local-inertial 2D shallow-water solve over the hybrid terrain grid and returns
maximum depth, final velocity, arrival time, wet area, and model metadata.
Buildings are impermeable barriers; rainfall on their roofs is conserved and
routed to the nearest open ground cell without inventing downpipe locations.
Rainfall intensity, storm duration, infiltration, Manning roughness, domain,
and grid resolution are editable.

The model deliberately excludes unknown stormwater drains and unverified OSM
curbs. It therefore represents a conservative above-ground surface-water
scenario, not a drainage-capacity or engineering flood study. Results should
be read as rainfall accumulation within the drawn box, not general flood
depth for the selected place: there is no represented upstream inflow from
outside the box. The user drags a rectangular analysis box; most of its
perimeter is a closed hydraulic boundary, but the solver automatically leaves
a box edge open for outflow where the terrain slopes downhill through it, so
water can drain off a downhill edge instead of pooling against a wall that
does not exist on the ground. The API reports which edges were left open in
`model.boundary_open_sides`. The API returns 21 physical depth states and
the WebGL viewer animates the box filling from dry terrain to storm completion.
The supplied Town Survey Marks are used for LiDAR QA only: 62 valid marks
overlap the original LiDAR DTM, whose sampled levels are about 0.343 m higher
at the median with 0.377 m RMSE. No vertical correction is applied until datum
compatibility is confirmed. SRTM cells are explicitly reported as a
lower-accuracy percentage in every flood result.

Run the FastAPI application, open the **Flood** tool, choose **Draw flood box**,
and drag between opposite corners on the terrain before simulating. A 4 m grid
is the practical detailed default; 2 m scenarios are substantially slower.
The API also enforces a combined cell-count × duration budget; oversized jobs
must use a smaller box, shorter storm, or coarser grid.
The complete rectangular flood box must fall inside available terrain
coverage; the browser marks an invalid box red and the API independently
rejects it.

Install the API dependencies with:

```bash
.venv/bin/python -m pip install -r requirements.txt
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
