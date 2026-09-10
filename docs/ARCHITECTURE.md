# Climate Explorer architecture

## Runtime boundaries

| Concern | Entry points | Contract |
| --- | --- | --- |
| Landing and methodology | `public/index.html`, `public/landing.*`, `public/docs/` | Static introduction and scientific interpretation |
| App shell | `public/app/index.html`, `public/app.js`, `public/style.css` | Native controls, tabs, loading, weather, report dialogs |
| Shared experience | `public/explorerExperience.js` | Evidence, guide, contextual help, snapshots, export and request status |
| Scenario schema | `public/scenarioState.js` | Versioned allow-list; bounded numeric/date/mode/camera validation; no event names or secrets |
| Requests | `public/requestClient.js` | Abort previous request with same key; bound request/body lifetime; retry only a small metadata GET allow-list |
| Map interaction adapter | `public/sceneExperience.js` | Keyboard camera control, camera restore/capture, selected-location handoff |
| 3D viewer | `public/webglRenderer.js` | Pinned Three.js, compact terrain/buildings, CFD sampling and analysis overlays |
| Compatibility viewer | `public/sceneRenderer.js` | Canvas geometry and screening API; not equivalent to the CFD viewer |
| Transport | `public/transportLayer.js` | Timetable-derived vehicles and event access; no live GPS |
| API boundary | `server/app.py` | FastAPI validation, protected routes, bounded concurrency and rate history, request IDs |
| Domain models | `server/heat.py`, `sunlight.py`, `field.py`, `traffic.py`, supporting modules | Existing scientific calculations; keep units, source dates, validation and coverage explicit |
| Build/offline jobs | `scripts/build_*`, OpenFOAM export/conversion scripts | Generate assets from source records. Never hand-edit generated scene files |
| Deployment | `compose.yaml`, `deploy/nginx.conf` | Static serving/proxy, compression/cache policies; no deployment was performed for this change |

## Data and identity

`public/assets/manifest.json` version 3 identifies the compact renderer asset, canopy, semantic model and roof surface. Source build inputs, cache keys, source IDs, CRS, geometry confidence, and terrain provenance belong to the scientific record. The runtime validates the supported manifest before interpreting scene geometry. Health reports required scene failures separately from optional SUMO/database availability.

`city_model.json` is a CityGML-aligned application encoding, not a conformant CityGML exchange document. The initial renderer uses `fallback.json`, not the much larger semantic asset. The LiDAR-plus-SRTM footprint must remain irregular; do not colour NoData as mapped ground.

CFD assets are offline solved volumes. WebGL comfort weights solved directions only; omitted sectors must not become calm or interpolated evidence. Canvas uses a different screening API and must say so. If that API fails, it now reports unavailable data instead of constructing a synthetic animated field.

## Scenario exchange

Settings links carry an allow-listed `scenario` JSON query value and selected `tool`. Unknown fields, unsupported versions, invalid dates, out-of-range coordinates, disabled select choices and oversized input are ignored. Local x/z coordinates are viewer coordinates, not longitude/latitude.

Before/After snapshots live only in the current browser tab. JSON export preserves the captured settings, timestamp, evidence metadata and manifest identifiers. Event names, arbitrary query strings, API keys and result arrays are excluded. This is a settings comparison, not a scenario solver or an intervention-benefit estimate. Drawn traffic closure geometry is not serialised/restored; traffic reports remain the complete record of a completed traffic comparison. A link uses the recipient's current asset release; use the exported manifest record to check reproducibility.

## Browser events

| Event | Meaning |
| --- | --- |
| `climate-menu-change` | Active panel changed; existing renderer owns layer visibility |
| `climate-manifest` | Validated current scene manifest |
| `climate-viewer-ready` | Renderer initialized; restore validated controls now |
| `climate-capture-view` / `climate-scene-state` | Synchronous camera snapshot request/response |
| `climate-restore-view` | Bounded camera restore |
| `climate-use-location` | Hand a local x/z point to sun/wind; each renderer checks coverage |
| `climate-request-status` | Loading/ready/error with tool, key, timestamp and request reference where available |
| `climate-analysis-result` | Small completed-result metadata; never a second copy of the CFD or traffic arrays |
| `climate-wind-result` | Existing wind-result contract; preserved for report consumers |

## Failure and operations

The API returns `X-Request-ID` on early authentication/rate/busy responses as well as normal responses. IDs supplied by clients are restricted in length and character set. Logs include path, status, elapsed time and request ID, but not API keys or request bodies. Unhandled failures return a generic message and log their traceback on the server.

`SIMULATION_RATE_MAX_CLIENTS` bounds the number of retained client budgets (default 10,000). Expired entries are removed; active budgets are not evicted to accommodate a new client. API concurrency and rates remain per process. Review proxy client-address handling before scaling beyond the existing single-worker deployment.

Client cancellation aborts requests and prevents superseded response bodies from being used. It does not generally terminate backend CPU work; sunlight also has an existing explicit cancellation endpoint. An expensive simulation is never automatically retried. Optional service outages must leave the map and other controls usable.

See [QA checklist](QA_CHECKLIST.md), [implementation status](IMPLEMENTATION_STATUS.md) and [feature roadmap](FEATURE_ROADMAP.md).
