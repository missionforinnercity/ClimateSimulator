# Conditions

Conditions is an interactive 3D urban climate and mobility explorer for central
Cape Town. It combines a detailed city scene with tools for urban heat, sunlight,
wind, traffic, and current weather. Timetable-derived MyCiTi buses and Metrorail
trains continue moving through the scene as background simulation. The browser
app is served by a FastAPI backend for modelled conditions and bounded analysis
jobs; several layers also work as a static-only viewer when their data assets
are available.

The app includes evidence and provenance cards, keyboard map controls, and a
report workspace with **Draw square area** and **Generate HTML report**. Drag
across the map to select an area; the view zooms and centres on that square.
Generating the report runs heat, sunlight, viewshed and wind analysis for the
selected area, then downloads a printable HTML report. A short decision brief
leads with the available measures and named streets to review; maps, findings,
charts and method notes follow. The selected-square page also estimates mapped
canopy cover from footprint shapes on an approximately 2–5 m sampling grid. This is neither
a tree count nor a species inventory. The included SANBI indigenous plant
checklist is cited as a future planting reference, not as evidence that a
species occurs in or suits the selected square.
Result references state their retention limits; the report does not guarantee
that every analysis can be replayed later. Shared settings links do not carry
completed simulation arrays or drawn traffic closures.

## Application overview

- **Tools:** Explore the 3D city, inspect current modelled weather, compare
  mapped paved, vegetated and water coverage, change building appearance, and
  open a map location in Street View. The separate Design scenario panel can
  modify a mapped building's footprint and height while preserving its polygon,
  demolish or replace buildings, and place, resize, move, and stack concept
  blocks. Design edits are saved in the current browser. Save a pedestrian
  wind field as the baseline in Wind, then Design can show an instant,
  simplified building-wake estimate on the same grid. This is a screening
  approximation, not a new CFD result. Proposal geometry JSON can be downloaded
  and re-imported to reopen a draft. The Design
  panel also runs a matched baseline/proposal clear-sky direct-sun comparison
  for edited building geometry, reporting paired ground-cell means and a
  difference map. Viewshed and current shadows update with edits; the wind
  wake remains a visual screening overlay. UTCI/Tmrt, annual comfort, traffic
  and route outputs remain on baseline geometry until recalculated or solved
  for the proposal. See [docs/DESIGN_COUPLING.md](docs/DESIGN_COUPLING.md).
  The panel also displays mapped shade-deficit maps plus the app's fixed-temperature heat-priority
  screen for nearby heat zones. Satellite surface
  temperature remains a fixed baseline, and traffic still uses its baseline
  geometry. Runoff is not currently exposed as a map layer.
  A separate mapped-cycleway layer highlights dedicated OpenStreetMap links
  and reports network proximity groups; it does not rate cycling safety or
  imply that other roads are unavailable to cyclists.
- **Urban heat:** Compare experimental near-live UTCI/Tmrt estimates, an
  historical ERA5 climate profile, and separate satellite-based screening
  layers. The panel includes map summaries, provenance and local inspection.
- **Sunlight:** View date/time-specific shadows or run cumulative direct-sun
  studies for ground, roofs and façades.
- **3D Viewshed:** Screen terrain visibility from a selected viewpoint using
  mapped terrain and building massing; mapped trees provide context but are not
  visibility blockers.
- **Design comparisons:** Compare proposal geometry against the mapped baseline
  for clear-sky direct sun and heat/shade screening. The screening comparison
  recalculates shade but holds its summer surface-temperature input fixed; it
  does not claim proposal UTCI/Tmrt or CFD results.
- **Wind:** Inspect solved OpenFOAM direction fields and a wind-rose-weighted
  Comfort view where solved data exists; the horizontal screening proxy remains
  available through its API and as a diagnostic validation target.
- **Traffic:** Draw road closures and compare paired SUMO runs, including
  routing, queue, emissions and report outputs. Demand is synthetic and
  exploratory.
- **Transit simulation:** Watch timetable-derived MyCiTi buses and Metrorail
  trains move through the CBD scene. Positions are estimates, not live GPS or
  confirmed arrival times.
- **Walking routes:** Compare fastest, lower-sun and (when thermal coverage is
  available) lower-heat CBD walks using OSM footways, mapped shade, UTCI and
  pedestrian wind. Matched synthetic walker cohorts are included per path. See
  [walking route method and limits](docs/WALKING_ROUTES.md).

Scientific status and coverage matter: the OpenFOAM wind cases are exploratory,
thermal outputs are experimental model estimates, and traffic results depend on
stated assumptions. See the validation and data-coverage
documents linked below and in each feature section.

Developer handoff: [architecture](docs/ARCHITECTURE.md),
[QA checklist](docs/QA_CHECKLIST.md),
[validation status and evidence needed](docs/VALIDATION_STATUS.md),
[dataset-by-dataset validation checklist](docs/DATA_VALIDATION_CHECKLIST.md),
[report reference verifier](scripts/verify_climate_report.py) and [result
archiver](scripts/archive_climate_report.py),
[VM update guide](docs/VM_UPDATE_GUIDE.md),
[walking routes](docs/WALKING_ROUTES.md),
[thermal deployment](docs/THERMAL_DEPLOYMENT.md), and
[proposed feature roadmap](docs/FEATURE_ROADMAP.md).

## Build the scene

Trees keep their LiDAR-mapped canopy outlines at every zoom level, with clean
rounded crowns, restrained green variation, and instanced trunks that read
clearly at both city and street scales.

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
semantic application model), `public/assets/fallback.json` (the compact scene
asset used by the viewer and analyses), `public/assets/canopy.json` (the
footprint-preserving LiDAR canopy),
`public/assets/roof_surface.bin` (an empty compatibility buffer), and
`public/assets/manifest.json`. Visible buildings prefer OpenStreetMap footprints
and mapped `building:part` polygons; municipal photogrammetry footprints fill
places where OSM has no building coverage. Parts preserve mapped stepped
massing, and parent outlines fill uncovered areas so a parent does not hide
its parts. Aligned municipal survey heights take precedence, followed by robust
interior LiDAR samples and then OSM height or level tags. LiDAR supplies the
overall height only: its sampled roof surface is not drawn. Mapped
`roof:shape`, `roof:height`, and `roof:direction` tags create simple gable or
hip roofs; other buildings render as clean flat caps. The derived
footprint product remains subject to ODbL attribution and share-alike terms.
The scene boundary is derived from the hybrid DTM's valid-pixel mask, not the
rectangular GeoTIFF envelope. Terrain triangles, buildings, canopy, roads,
railways, grass, heat zones, and interaction are clipped to the irregular
LiDAR-plus-Company's-Garden footprint; remaining NoData pixels are not
presented as mapped ground.
The viewer uses a vendored, pinned
Three.js WebGL renderer for the city, terrain-following wind heatmaps, white
GPU gusts, heat geometry, and directional-light shadow maps. The viewer requires
WebGL 2; if it is unavailable or disabled, the app asks users to enable WebGL
and hardware acceleration or use a current browser that supports WebGL 2.

The Wind panel's Direction and Comfort lenses are both driven by full-CBD
OpenFOAM volumes, not the older screening proxy — Direction loads whichever
solved directional case you pick (16 converted 22.5° sectors are registered;
the compass enables a direction only when its assets are present) and shows
a flowing colour texture on its pedestrian speed heatmap, plus resolved 3D
flowlines, a movable/resizable flow box with an adjustable seed height,
horizontal/vertical speed and turbulence slices you can drag directly in the
scene, and pressure mapped onto building façades. Its pedestrian view is
sampled from the same 3D CFD volume at a terrain-following 1.5, 2 or 4 m
height. Comfort weights every *solved* direction's pedestrian field by its
ERA5 wind-rose frequency and Weibull exceedance and reports the resulting
annual-hours coverage explicitly — unsolved directions are excluded from the
weighted sum, never interpolated or assumed calm, so today's Comfort result is
a labelled lower bound, not a complete annual study. The fast horizontal
screening proxy (mass-conserving terrain + building/canopy drag) still powers
`/api/wind/preview`, `/api/wind/comfort`, and `/api/wind/validate`, but no
longer drives the WebGL wind panel. The CFD cases are explicitly exploratory
rather than validated planning evidence.
The animated heatmap transports the speed colours themselves through the
horizontal CFD field on a GPU grid. A second smooth colour wave continuously
travels along the local CFD velocity as the transported regions deform, while
building masks prevent transport across solids. These are visual tracers,
not solved time-varying wind speeds. Switch motion off to read the mean-speed
map; inspected values and statistics always retain the solved mean. The
animation respects the system reduced-motion preference.
Comfort offers versioned Lawson-LDDC-style screening and Davenport 1972 hourly-
mean criteria, with thresholds, source, averaging basis and gust treatment
carried into results. The formal Lawson LDDC gust-equivalent-mean/safety option
is listed as unavailable until its gust inputs are supported. See
[docs/WIND_VALIDATION.md](docs/WIND_VALIDATION.md) for criterion definitions,
scoring API requirements and limits. No local CBD campaign observations have
been provided, so the CFD fields remain exploratory and unvalidated. Case
generation, result refresh and validation requirements are documented in
[docs/OPENFOAM.md](docs/OPENFOAM.md).

The semantic model gives each object a stable `identifier` and version-specific
`featureId`, named geometry, source records, lifecycle fields, geometry quality,
and an LoD. It separates buildings from their roof surfaces and represents
roads, pedestrian routes, railways, terrain, plant cover, and individual tree
instances as typed objects. WaterBody and CityFurniture objects record the
available mapped coverage, including point-only municipal street assets. The
JSON is intentionally described as a CityGML-aligned application encoding
rather than a conformant CityGML GML/XML exchange file.

When `data/street_data` is present, the build clips its City of Cape Town road
centrelines, public lights, monuments, public toilets, pedestrian crossings,
on-street parking, survey marks, and festoon lighting to the actual terrain
footprint. Municipal road keys and attributes become the authoritative semantic
carriageway records; OSM footways and pedestrian paths are retained as a
complementary source because they are not represented in the municipal road
product. Municipal public-light records are exported to a compact lighting
sidecar for the interactive renderer; other point-only assets remain LoD0 until
surveyed dimensions or 3D templates are available.
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
scale and return automatically when zooming toward street level. A stable 28%
sample of mapped curb bays also holds illustrative parked cars; surface lots
use their own simplified parking layouts. Neither sample represents observed
occupancy.
Municipal pole assemblies use instanced meshes without shadow casting and are
loaded during idle time; street glow and road washes are deferred until Sun is
opened. Parking-aisle service roads render above their mapped lot surfaces so
their circulation lanes remain visible.

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
./scripts/run_local.sh
```

Open http://localhost:8000 in a current browser with WebGL 2 enabled. The
launcher starts the API and serves the app from the same terminal; press
Ctrl+C to stop it. To use a different port, run
`PORT=8001 ./scripts/run_local.sh`.

The static-only viewer can still be served with
`.venv/bin/python -m http.server 8000 -d public`. Production deployments can run `docker compose up --build`: Nginx serves
and compresses the static assets while proxying `/api` to one bounded API
worker. Versioned scene assets receive immutable cache headers; the manifest
and viewer shell revalidate so incompatible code and assets are not mixed.

The near-live UTCI and Tmrt layers also need the separate thermal model worker.
In another terminal, install its dependencies and run it alongside Uvicorn:

```bash
.venv/bin/python -m pip install -r requirements-models.txt
.venv/bin/python -m server.thermal_worker
```

Rebuild the SOLWEIG surface rasters with
`.venv/bin/python scripts/build_thermal_surfaces.py` after changing the thermal
surface inputs or material mapping; the worker checks their material-code
version before publishing. The worker publishes its first forecast before
those layers can display data.
For a containerized run, `docker compose up --build` starts the API and thermal
worker together.
The worker publishes one full thermal forecast per hour, waiting an hour after
each run attempt. SOLWEIG's prepared surface cache persists in the thermal
product volume, so sky-view factor and geometry preprocessing are reused
between runs. The worker prepares or refreshes the static SVF grid before it
requests live weather, so an upstream forecast outage does not hide a valid
geometry product. Select **Sky-view factor (SVF)** in Urban heat to inspect the
cached surface result; it is a static geometry layer, not an hourly weather
forecast. A restarted worker respects the last successful publish time, and
scheduled model runs execute in a one-shot child process so solver memory is
released after each refresh. Abandoned temporary run folders older than a day
are removed automatically.

The Compose web container binds to `127.0.0.1:18081` on the VM by default.
If a host reverse proxy routes to this app, point its upstream at port `18081`.
Set `WEB_HOST_PORT` in the deployment environment to choose another unused
loopback port; the proxy upstream must use the same port.

The UTCI/Tmrt forecast remains experimental until compared with co-located CBD
measurements. A combined wind/thermal field template, thermal-only CSV,
three-site collection protocol, and script for paired input/result residuals
are in [docs/THERMAL_VALIDATION.md](docs/THERMAL_VALIDATION.md). The thermal
worker publishes local 10 m wind alongside pedestrian-height wind for that comparison.
The resulting JSON and its exact input CSV can be attached in Heat and retained
in the climate report, including hashes for the thermal frames it sampled.
For a no-fieldwork check of weather inputs against FACT METAR, satellite
radiation and ERA5, run
`.venv/bin/python scripts/backtest_thermal_forcing.py --days 30`; interpret
station and reanalysis comparisons as context, not CBD street-level validation.
The SENSOTO NOAA ISD Molteno Reservoir station also provides historical hourly
temperature and wind observations. Its 2021–2025 ERA5 comparison and exact
paired rows are documented in [docs/THERMAL_VALIDATION.md](docs/THERMAL_VALIDATION.md)
and [docs/VALIDATION_STATUS.md](docs/VALIDATION_STATUS.md); coverage is sparse,
and it cannot validate pedestrian CFD, humidity, Tmrt or UTCI.
Each hourly run uses the latest available native satellite radiation estimate;
each map frame shows its radiation interval and the separate air/wind forecast
time. See
[docs/THERMAL_RADIATION_AUDIT_2026-09-23.md](docs/THERMAL_RADIATION_AUDIT_2026-09-23.md)
for the matched before/after results and model limits.

For a longer-term view, the Heat tool also supports a historical UTCI/Tmrt
profile across seasons, months and local hours. Its 2016–2025 ERA5 composite is
a separate offline product; build and provision it as described in
[docs/THERMAL_CLIMATOLOGY.md](docs/THERMAL_CLIMATOLOGY.md). The application host
serves the prepared maps and does not run the historical simulations.
The historical UTCI view reports cold/no-thermal-stress/heat-stress area-time
shares and representative-year equivalent hours per mapped cell. These are
classified composite estimates, not observed historical exceedance hours; the
near-live view reports the category area for its selected hour only.
UTCI results remain experimental model estimates until co-located CBD field
observations support validation. Deployment artifact preparation and VM
transfer steps are in [docs/THERMAL_DEPLOYMENT.md](docs/THERMAL_DEPLOYMENT.md).

Deployment controls are environment variables:

- `ALLOWED_ORIGINS` is a comma-separated CORS allow-list (local port 8000 only
  by default).
- `CONDITIONS_API_KEY`, when set, requires `X-API-Key` on API routes other
  than the health check.
- `SIMULATION_RATE_LIMIT` and `SIMULATION_RATE_WINDOW_S` control the per-client
  expensive-request budget (12 per minute by default).
- `HEAT_CONCURRENCY`, `SUNLIGHT_CONCURRENCY`, `WIND_CONCURRENCY`,
  `WIND_COMFORT_CONCURRENCY`, and `TRAFFIC_CONCURRENCY`
  bound CPU-heavy work. Over-capacity requests fail quickly instead of forming
  an unbounded queue.

`GET /api/health` checks generated assets and model compatibility, the SUMO
binary/network, and the optional database connection. Request logs are
structured JSON and include an `X-Request-ID`. `.env` is excluded from both Git
and the Docker build context.

## Transit simulation

Timetable-derived MyCiTi buses and Metrorail trains animate as background
vehicles in the city scene. Their positions are schedule estimates, not live
GPS or confirmed arrivals. The animation uses the supplied weekday MyCiTi
timetables where available and matched PRASA schedules; some directions and
corridors use estimated cadence. Weekend MyCiTi buses are omitted because
weekend tables are not supplied. Rebuild the compact vehicle asset with
`python scripts/build_transport_asset.py`; see
[`docs/TRANSIT_SIMULATION.md`](docs/TRANSIT_SIMULATION.md).

## Traffic and street status in Conditions

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
For drawn one-way options, both directional edges of the selected physical
section now form a direction-neutral comparison key. Flipping the arrow keeps
the same corridor, demand seed and through-traffic population. The selected
section is excluded from trip endpoints so displaced vehicles reroute rather
than disappearing, while local driveway, loading and parking-access demand is
explicitly left for an operational assessment. Reports print the direction
kept open and the provenance fields needed to verify an apples-to-apples run.
TomTom live-flow snapshots are collected every 30 minutes while the API is
running. After at least five adequately covered weekdays, the AM and PM
profiles search broad morning (05:00-11:00) and afternoon (14:00-20:00) bands
for the most congested two-hour window. Low-confidence samples are rejected,
road samples are collapsed into robust half-hour/day values, and the detected
window gently adjusts the stability-tested demand scale. This calibrates peak
timing and relative congestion only—not absolute vehicle demand. Readiness and
the detected windows are exposed at `GET /api/traffic/calibration-status` and
printed in generated reports.
Changing the sampling window extends the same reproducible traffic stream, so
a 20-minute comparison is a longer observation of the 10-minute scenario rather
than a newly randomised population. Rebuild the SUMO
network after refreshing OSM data with:

```bash
python scripts/build_sumo_network.py --reuse-osm
```

## Conditions wind API

The viewer can run as a single FastAPI application. It loads `DATABASE_URL`
from `.env` on the server only; the database URL is never sent to the browser.

```bash
uvicorn server.app:app --reload --port 8000
```

Open http://localhost:8000. The **Wind** tool's **Direction** lens loads a
solved OpenFOAM volume for the picked compass direction (only directions with
a converted case are selectable) and exposes four diagnostic views: a
terrain-following pedestrian surface at 1.5/2/4 m, resolved 3D flowlines
seeded inside a movable/resizable **flow region** box (drag it directly in
the scene, or use its handle to resize; its height and whether it seeds
ground-level-only or through the box's full height are both adjustable),
horizontal/vertical **slice** planes you can drag directly in the 3D scene as
well as from the panel controls, and kinematic **pressure** mapped onto
building façades. **Comfort** instead weights every solved direction's
pedestrian field by ERA5 wind-rose frequency and Weibull exceedance and
reports its actual annual-hours coverage — it never interpolates a direction
that hasn't been solved. Clicking the city normally orbits the camera;
dragging the flow box or a slice plane takes over only when the click lands
on that object.

The **Urban heat** layer opens on experimental UTCI thermal comfort, with a
near-live forecast and a separate historical climate profile. Mean radiant
temperature is available as an explanatory companion layer. Satellite-based
heat-screening layers remain available in a separate group; they are not UTCI.
The main screening view combines a fixed summer surface-temperature baseline
with a shade deficit computed for the user-selected date and time. Because the
temperature term does not vary with the selected date, only the shade term
does, this is labelled a summer baseline plus selected-date shade scenario.
The layer also reads the generated local product in
`data/raw/scene_footprint_heat_2026_academic_v3_zones.geojson` and renders a
set of simplified vector zones on the scene ground. The intervention-priority
view combines the fixed Summer 2025–26 surface-temperature baseline (70% weight)
with a shade deficit computed for the selected date and time (30% weight). A
winter date therefore pairs winter shade geometry with the summer baseline.
Priority and shade retain every surface-temperature zone to keep the screening
surface continuous. Other screening views include pedestrian thermal exposure
(a proxy, not UTCI/PET or a measured pedestrian temperature), shade deficit,
the original `heat_model_lst_c` surface temperature, and rooftop temperature
clipped to mapped building footprints and conformed to the detailed rendered
roof surface. Ground-level heat views hide roads and paths so they do not cover
the thermal surface; rooftop mode retains them for orientation. The database
`climate.heat_zones` table remains a fallback when the local product is absent.

The **Sunlight** panel provides both instantaneous GPU shadows and cumulative
direct-sun hours. Ground sun is accumulated from mapped shadow overlap. The 3D
building study places analysis cells on roofs and outward-facing façades, casts
a clear-sky ray toward every sampled sun position, and tests it against mapped
opaque building prisms and canopy volumes. Ground, building, or combined
surfaces can be selected over an editable daily window at 15, 30, or 60 minute
steps. Building-surface grids are available at 20 m (city overview), 10 m
(quicker local study), and 5 m (more detail); a 20 m all-surface study contains
roughly 25,000 cells. The
cumulative building study uses CPU ray tests against simplified roof planes
and mapped blockers. It focuses on direct sunlight; terrain occlusion,
detailed roof slopes, diffuse light and reflections are outside its current
scope. Regulatory solar-radiation work should use a dedicated detailed model.

The former intervention-painting preview has been removed. Heat outputs remain
screening evidence rather than measured or engineering-grade performance
claims. Rooftop values are the source model's land-surface temperature painted
directly onto the detailed roof triangles; they are not measured roof-membrane
temperatures.

The retained screening proxy (fast horizontal mass-conserving model, still
used by `/api/wind/preview`, `/api/wind/comfort`, and `/api/wind/validate`)
applies stability-dependent pedestrian-height conversion, Lawson-LDDC-style
screening categories, conditional threshold exceedance, wind-rose-weighted
seasonal/annual comfort, and model-form uncertainty bands. The API labels
these outputs **Screening**; they are not
the OpenFOAM Direction/Comfort lenses described above. The installed ERA5
wind profile now uses a complete 2021–2025 monthly archive (43,824 hourly
records, all UTC hours). ERA5 frequency coverage is complete for that baseline,
but remains reanalysis rather than independent local validation. The separate
legacy `data/Era5data.grib` file is incomplete and is not the active profile's
source. See `docs/WIND_VALIDATION.md` for the coverage evidence, benchmark
workflow, observation schema, error maps, and promotion criteria for a future
validated mode.

`data/wind_climatology/cape_town_era5.json` backs both wind paths: the
screening proxy's default forcing (conditional mean speed, Weibull
distribution, gust factor and 10–100 m shear replacing generic assumptions)
and the lightweight `GET /api/wind/climatology/sectors` endpoint the
OpenFOAM Comfort lens calls to weight each solved direction by its observed
frequency. Rebuild the compact profile with
`python scripts/build_era5_wind_climatology.py` after updating the GRIB
archive.

**Generate detailed wind report** (screening's print-ready assessment with
the scenario definition, a reproducible pedestrian-speed field map, comfort
distribution, exceedance/uncertainty indicators, ERA5 evidence and
data-quality notes) is wired to the screening proxy's output shape and is not
currently offered for the OpenFOAM Direction/Comfort lenses.

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
response guidance for shade, planting, hard surfaces and roofs. These are
screening prompts, not measurements or engineering-grade recommendations.

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

## Terrain-aware regional wind

The city renderer displays measured CBD terrain with neutral gray mapped
buildings against a dark background. Bus and rail models follow schedule-derived
routes and do not represent live vehicle positions. Regional wind fields still
account for terrain shaping airflow
(especially the SE "Cape Doctor") before it reaches the CBD. Build those
terrain-resolved fields from the supplied SRTM tiles with:

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
