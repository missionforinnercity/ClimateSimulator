# Conditions architecture

## Runtime boundaries

| Concern | Entry points | Contract |
| --- | --- | --- |
| Landing and methodology | `public/index.html`, `public/landing.*`, `public/docs/` | Static introduction and scientific interpretation |
| App shell | `public/app/index.html`, `public/app.js`, `public/style.css` | Native controls, tabs, loading, weather, report dialogs |
| Shared experience | `public/explorerExperience.js` | Evidence, guide, contextual help, snapshots, export and request status |
| Scenario schema | `public/scenarioState.js` | Versioned allow-list; bounded numeric/date/mode/camera validation; no event names or secrets |
| Requests | `public/requestClient.js` | Abort previous request with same key; bound request/body lifetime; retry only a small metadata GET allow-list |
| Map interaction adapter | `public/sceneExperience.js` | Keyboard camera control, camera restore/capture, selected-location handoff |
| 3D viewer | `public/webglRenderer.js` | Pinned Three.js, compact terrain/buildings, CFD sampling, wind analysis and OpenFOAM-driven pollutant dispersion overlays. Shared `SCENE_LAYERS` profiles assign render tiers and small terrain lifts to draped surfaces; depth testing handles real 3D occlusion. |
| Transport | `public/transportLayer.js` | Timetable-derived vehicles and event access; no live GPS |
| API boundary | `server/app.py` | FastAPI validation, protected routes, bounded concurrency and rate history, request IDs |
| Domain models | `server/heat.py`, `sunlight.py`, `field.py`, `traffic.py`, supporting modules | Existing scientific calculations; keep units, source dates, validation and coverage explicit |
| Build/offline jobs | `scripts/build_*`, OpenFOAM export/conversion scripts | Generate assets from source records. Never hand-edit generated scene files |
| Deployment | `compose.yaml`, `deploy/nginx.conf` | Static serving/proxy, compression/cache policies; no deployment was performed for this change |

## Data and identity

`public/assets/manifest.json` version 3 identifies the compact scene asset, canopy, semantic model and roof surface. The browser viewer requires WebGL 2 and reports when the capability is unavailable. Source build inputs, cache keys, source IDs, CRS, geometry confidence, and terrain provenance belong to the scientific record. The runtime validates the supported manifest before interpreting scene geometry. Health reports required scene failures separately from optional SUMO/database availability.

`city_model.json` is a CityGML-aligned application encoding, not a conformant CityGML exchange document. The WebGL viewer loads the compact `fallback.json` scene rather than the much larger semantic asset. The LiDAR-plus-SRTM footprint must remain irregular; do not colour NoData as mapped ground.

CFD assets are offline solved volumes. WebGL comfort weights solved directions only; omitted sectors must not become calm or interpolated evidence. The separate screening API remains available for explicit API clients.

`GET /api/wind/criteria` publishes the versioned activity-threshold profiles
used by WebGL comfort and screening responses. Each field and printable report
retains the selected criterion, probability threshold, averaging basis, gust
handling and source. Criteria requiring unavailable gust inputs are visible in
the catalog as disabled and are rejected by calculation routes.

Thermal forecast and historical climatology products publish manifests and
masked binary rasters. Both products include per-frame SHA-256 values and
report references include the source hashes and run/product manifest hash.
`GET /api/thermal/runs/{run_id}/source-manifest` and
`GET /api/thermal/climatology/source-manifest` return the exact manifest bytes
whose SHA-256 appears in a report. The corresponding normal manifest routes
add derived status/forcing metadata for the application.
[`scripts/verify_climate_report.py`](../scripts/verify_climate_report.py) checks
saved report references against available manifests and binary hashes before
reuse; it reports expired jobs and settings-only analyses separately, without
rerunning models. [`scripts/archive_climate_report.py`](../scripts/archive_climate_report.py)
packages retrievable thermal frames, OpenFOAM assets and completed traffic
results with SHA-256 records; unavailable or non-retained analyses stay marked
as such. The archive preserves artifacts but does not rerun models or establish
scientific accuracy. `GET /api/thermal/climatology/kpis` derives UTCI
category area-time shares from the monthly/local-hour composite rasters; its
equivalent hours are therefore composite estimates, not observed frequency
counts. The forecast UI reports UTCI band area for its selected frame only.
Both retain the physical UTCI values and expose the relevant validation status.
The `/api/wind/validate-openfoam` endpoint scores site/period-split observations
against a converted CFD volume, while
`scripts/validate_thermal_observations.py` compares a measured CSV with retained
hourly thermal frames. Their residuals remain diagnostic until independent
holdout campaigns exist. Reports identify observation and model artifacts by
hash; synthetic scorer tests verify this bookkeeping, not field accuracy.

Design massing emits `climate-design-geometry-change` with removed building
indexes and added proposal prisms. The viewer rebuilds geometry, current
shadows/Viewshed, and a qualitative baseline-field wake overlay; these are not
thermal or CFD recalculations. `POST /api/sunlight/design-comparison` runs
matched baseline/proposal direct-sun studies and returns a geometry hash,
settings, paired ground rasters and summaries. `POST /api/heat/design-comparison`
returns matched shade-deficit and heat-priority screening summaries with a
shared proposal geometry hash and heat-zone/building/canopy asset hashes; its
satellite surface-temperature input remains fixed at the baseline. Neither
endpoint recalculates proposal UTCI/Tmrt or CFD. See
[design coupling](DESIGN_COUPLING.md).

OpenFOAM measurement scores are emitted by `/api/wind/validate-openfoam` and
can be captured in the client report with the original uploaded/pasted input,
per-row predictions, holdout metrics and source hashes. The report archiver
packages the matching CFD volume, terrain DEM and scene manifest from the
checkout. Thermal observation scores are produced as JSON by
`scripts/validate_thermal_observations.py`; they retain observation-file,
frame, manifest, model and UTCI implementation provenance. Attach the JSON and
exact input CSV in Heat before exporting and archiving to package the input and
paired thermal frames with the client report.

## Scenario exchange

Settings links carry an allow-listed `scenario` JSON query value and selected `tool`. Unknown fields, unsupported versions, invalid dates, out-of-range coordinates, disabled select choices and oversized input are ignored. Local x/z coordinates are viewer coordinates, not longitude/latitude.

Before/After snapshots live only in the current browser tab. `Export scenario JSON` preserves settings and evidence metadata. `Export climate report` downloads printable HTML plus a `conditions-climate-report/1` JSON package with current and saved Before/After map images, app health, scene manifest/build-input hashes, result KPI summaries, matching KPI deltas for saved Before/After snapshots, and typed references to retained thermal frames, deployed OpenFOAM volumes, sunlight analysis IDs, traffic jobs and design heat/shade screens. OpenFOAM references include case/time version and field/mask SHA-256 hashes; thermal references include run-manifest and frame SHA-256 hashes, model versions and grid metadata; traffic references include selected edge IDs, request settings, the SUMO network SHA-256 and API field version. Design heat/shade references include proposal geometry/settings and source-asset hashes, area-weighted KPIs and per-zone result values; the verifier checks report consistency, while `scripts/archive_climate_report.py` packages matching local source inputs. This is traceable result data, not replay or scientific validation. The report excludes arbitrary query strings, API keys and raw CFD/traffic arrays. Server-side immutable result storage and replay validation remain future work; settings links use the recipient's current release.

The Scenario workspace also has optional client-report metadata fields for the
project name, client, project reference, preparer, location, reporting dates and
notes. Values persist in browser local storage and are copied into the HTML and
JSON export; they do not alter model inputs. The report rejects an end date
earlier than its start date.

The `/api/health` snapshot also records the FastAPI application version and a
runtime-source fingerprint. Its aggregate SHA-256 and per-file hashes cover the
server Python modules, browser JavaScript, app shell/style, thermal observation
scorer and container/dependency lock files. The report can therefore identify
which code/configuration generated it; these hashes do not package that source
or guarantee that its environment can still be installed.

## Browser events

| Event | Meaning |
| --- | --- |
| `climate-menu-change` | Active panel changed; the WebGL viewer owns layer visibility |
| `climate-manifest` | Validated current scene manifest |
| `climate-viewer-ready` | Renderer initialized; restore validated controls now |
| `climate-capture-view` / `climate-scene-state` | Synchronous camera snapshot request/response |
| `climate-restore-view` | Bounded camera restore |
| `climate-use-location` | Hand a local x/z point to sun/wind; the WebGL viewer checks coverage |
| `climate-request-status` | Loading/ready/error with tool, key, timestamp and request reference where available |
| `climate-analysis-result` | Small completed-result metadata; never a second copy of the CFD or traffic arrays |
| `climate-wind-result` | Existing wind-result contract; preserved for report consumers |

## Failure and operations

The API returns `X-Request-ID` on early authentication/rate/busy responses as well as normal responses. IDs supplied by clients are restricted in length and character set. Logs include path, status, elapsed time and request ID, but not API keys or request bodies. Unhandled failures return a generic message and log their traceback on the server.

`SIMULATION_RATE_MAX_CLIENTS` bounds the number of retained client budgets (default 10,000). Expired entries are removed; active budgets are not evicted to accommodate a new client. API concurrency and rates remain per process. Review proxy client-address handling before scaling beyond the existing single-worker deployment.

Client cancellation aborts requests and prevents superseded response bodies from being used. It does not generally terminate backend CPU work; sunlight also has an existing explicit cancellation endpoint. An expensive simulation is never automatically retried. Optional service outages must leave the map and other controls usable.

See the [QA checklist](QA_CHECKLIST.md), [validation status](VALIDATION_STATUS.md), and [feature roadmap](FEATURE_ROADMAP.md).
