# Cape Town Climate Digital Twin Roadmap

## 1. Target state

The target is a Cape Town simulation and scenario-analysis twin focused first
on climate resilience. It should represent the physical environment, allow
proposed changes to be placed into that context, run defensible impact models,
and publish the result as an interactive 3D experience.

This system is deliberately separate from the existing business and property
dashboard. It is not a property-management, valuation, sales, leasing,
ownership, tenant, or commercial intelligence product.

The important distinction is:

- **3D city model:** what exists and what it looks like.
- **Planning twin:** what is allowed or proposed, with measurable development
  metrics.
- **Operational climate twin:** what is happening now and how the city may
  respond under weather, heat, wind, flood, or other scenarios.

The current project is a strong prototype for the third category's climate
visualisation layer, but it needs stronger validation and scenario tooling
before it can be used for real planning decisions.

## 2. Product boundary

### In scope

- Physical city representation: terrain, buildings, roads, trees, land cover,
  water, and infrastructure relevant to simulation.
- Environmental simulation: heat, wind, shade, solar, runoff/flooding, and
  related climate-resilience analysis.
- Planning scenarios: proposed buildings, public-realm interventions, zoning
  envelopes, and before/after model comparisons.
- Scientific and planning metadata: source, date, resolution, uncertainty,
  model version, and validation status.
- Spatial references needed to connect a simulation result to a place.

### Explicitly out of scope

- Property listings, sales, leasing, tenants, owners, valuations, rent,
  financial performance, or market analytics.
- Business profiles, customer data, company intelligence, footfall/commercial
  analytics, or property-dashboard visualisations.
- Rebuilding dashboard features that already exist elsewhere.
- Exposing confidential property or business data to simulation users.

### Boundary between systems

The simulation twin may consume a minimal, approved spatial reference such as a
parcel/building ID or geometry. It may return simulation outputs such as heat
exposure, wind comfort, shade coverage, runoff, or scenario impacts. It should
not copy or store business/property attributes.

Keep the systems separated at the database, API, permissions, and UI layers.
If a future workflow needs property context, resolve it in the separate
dashboard rather than adding that data to this project.

## 3. Current baseline

Already present in this repository:

- LiDAR-derived 2 m terrain and a detailed local terrain mesh.
- 2,322 building footprints, with approximate building heights.
- 4,591 canopy components and 4,903 tree instances.
- 3,048 roads and green areas.
- Three.js WebGL viewer with Canvas compatibility fallback.
- Terrain-resolved and building-resolved exploratory wind fields.
- Heat zones, current modelled weather, sun/shadow analysis, and mitigation
  previews.
- FastAPI endpoints, reproducible asset-building scripts, migrations, and
  automated tests.

Current limitations explicitly acknowledged by the code and README:

- Wind and mitigation outputs are exploratory/planning estimates, not
  engineering-grade CFD, observations, or drainage models.
- Weather is modelled current conditions, not station observations.
- Heat is a labelled baseline product rather than a live, calibrated urban
  climate model.
- The viewer is a single local CBD scene rather than a tiled, city-scale,
  multi-resolution platform.
- Building geometry is mostly extruded footprint data rather than authoritative
  roof forms, façades, interiors, or BIM.
- There is no formal data catalogue, provenance system, scenario/version
  workflow, planning-rule engine, or approval/audit workflow.

## 4. Recommended product boundary

Start with one high-value planning question:

> Where should Cape Town prioritise heat, shade, canopy, cool-surface, and
> public-realm interventions, and what is the likely effect under defined
> weather scenarios?

Keep the first production area bounded to the CBD and a small set of adjacent
neighbourhoods. Expand only after the data pipeline, model validation, and
performance budgets work at that scale.

## 5. Roadmap

### Phase 0 — Define the twin and its evidence (1–2 weeks)

**Deliverables**

- Product brief: users, decisions, spatial extent, update frequency, and
  required outputs.
- Data dictionary and source register for every layer and model.
- Model risk labels: visualisation, planning estimate, calibrated prediction,
  or engineering/operational result.
- Coordinate-system, vertical-datum, time-zone, and unit conventions.
- Baseline performance targets: initial load, frame rate, API latency, and
  maximum asset size.
- Ground-truth plan: weather stations, mobile transects, tree surveys, building
  checks, and heat observations.

**Exit criteria**

- Every displayed metric has an owner, timestamp, source, unit, uncertainty,
  and refresh policy.
- A planner can describe exactly what decision the first release supports.

### Phase 1 — Make the current 3D city authoritative (3–6 weeks)

**Data and city objects**

- Replace approximate building heights with a versioned building dataset whose
  attributes include height, roof type, use, floors, year, source, and
  confidence.
- Separate `Building`, `BuildingPart`, `RoofSurface`, `Road`, `LandCover`,
  `Tree`, `Water`, and `Terrain` as stable feature types with persistent IDs.
- Add authoritative planning geometry such as land parcels, zoning, public
  land, land use, transport, drainage, and utility references where licensing
  permits. Do not import ownership or commercial attributes.
- Add stable spatial building/parcel references and a change-detection report
  between data releases.

**Mesh and geometry**

- Keep the LiDAR DTM as the analysis terrain; create a separate visual terrain
  mesh with a documented simplification tolerance.
- Produce building LoD1/LoD2 geometry from footprints, roof attributes, and
  LiDAR/photogrammetry. Preserve the source feature ID on every rendered
  object.
- Add a reality mesh for the selected area from aerial/drone imagery and
  photogrammetry. Use it for visual realism, not as the sole analysis source.
- Generate tiled assets rather than one JSON blob: terrain tiles, building
  tiles, tree tiles, and reality-mesh tiles with level-of-detail metadata.

**Exit criteria**

- A user can click any building or parcel and see its source, date, geometry
  level, height confidence, and linked planning attributes.
- Visual mesh and analytical surfaces agree within a documented vertical and
  horizontal tolerance.

### Phase 2 — Build a real 3D/mesh delivery stack (4–8 weeks)

Recommended initial stack: retain the current Three.js viewer while adding a
standard tiled interchange layer. Use 3D Tiles for streamed terrain, buildings,
trees, and reality mesh; use glTF/GLB for individual assets and CityGML or
GeoJSON/PostGIS as authoritative interchange/storage where appropriate.

**Pipeline**

1. Normalise source CRS and vertical datum.
2. Validate geometry, repair invalid polygons, and assign persistent IDs.
3. Generate LoD0/LoD1/LoD2 building products.
4. Generate terrain TIN/quantised-mesh or equivalent tiled heightfield.
5. Generate textured reality mesh from aligned imagery and point clouds.
6. Convert to GLB/3D Tiles with batch metadata and bounding volumes.
7. Build a tile index and CDN/object-storage deployment.
8. Add automated visual and geometric QA for every build.

**Mesh quality gates**

- No holes, inverted normals, self-intersections, or unbounded triangles.
- Maximum geometric error recorded per LOD and tile.
- Texture resolution, colour balance, and seasonal imagery date recorded.
- Occlusion/culling and tile memory budgets tested on a mid-range laptop and
  phone.
- Reality mesh and analytical terrain can be toggled independently.

**Exit criteria**

- CBD loads progressively from overview to street scale without shipping the
  entire scene at once.
- Tile builds are reproducible from source version + pipeline version.
- The mesh is visually convincing while calculations continue to use clean,
  attributable analytical surfaces.

### Phase 3 — Upgrade models from proxies to calibrated models (6–12 weeks)

Prioritise models that answer the product question, not every possible urban
process.

**Urban heat**

- Fuse land-surface temperature, air temperature, shade, imperviousness,
  vegetation, building materials, wind, and topography.
- Add a calibrated pedestrian-level heat/exposure model with time-of-day and
  seasonal scenarios.
- Quantify uncertainty and validate against fixed sensors and transects.

**Wind**

- Preserve the current regional and building-resolved fields as a fast preview.
- Generate a validated reference library with CFD or WindNinja/OpenFOAM-class
  workflows for representative wind directions, seasons, and stability cases.
- Compare preview fields against reference simulations and observations;
  publish error metrics, not just a `model_kind` label.
- Add pollutant/ventilation only after wind speed and direction are validated.

**Water and flooding**

- Add catchments, stormwater assets, imperviousness, drainage capacity, and
  rainfall design events.
- Introduce a 2D surface-runoff model for priority areas.
- Treat drainage results as a separate model with its own calibration and
  uncertainty; do not infer drainage performance from the current mitigation
  buffers.

**Energy and buildings — later**

- Add solar potential, shading, roof suitability, and building-energy proxies.
- Connect detailed BIM/IFC only for selected projects; do not make BIM a
  prerequisite for the citywide twin.

**Exit criteria**

- Each model has a benchmark dataset, calibration report, version, input
  assumptions, uncertainty range, and known failure modes.
- The UI distinguishes measured, modelled, forecast, and scenario values.

### Phase 4 — Add planning scenarios and a rules engine (4–8 weeks)

- Introduce scenario objects: baseline, proposal, alternatives, and approved
  state.
- Support edit/compare/duplicate/restore, with immutable scenario versions.
- Add zoning envelopes, maximum height, floor-area ratio, coverage, setbacks,
  land use, heritage, and public-realm constraints.
- Add development metrics: floors, floor area, dwelling count, population,
  jobs, tree canopy, shade coverage, runoff, solar potential, and cost bands.
- Allow a proposed building or intervention to be imported as GLB/IFC and
  linked to its parcel/project.
- Add before/after split view, swipe, timeline, and scenario comparison.

**Exit criteria**

- A planner can create a proposal, run the agreed metrics, compare it with the
  baseline, and export a review package.
- Every result can be reproduced from the scenario version and model version.

### Phase 5 — Operational data, governance, and collaboration (6–10 weeks)

- Add ingestion jobs for stations, IoT, weather forecasts, satellite/LST,
  construction updates, and new surveys.
- Store observations separately from forecasts and simulations.
- Add data freshness, lineage, quality flags, and model health dashboards.
- Add role-based access, project permissions, moderation, and audit history.
- Provide exports: GeoPackage, GeoJSON, CSV, glTF/GLB, 3D Tiles, report PDF,
  and machine-readable scenario JSON.
- Add public views with deliberately reduced precision where privacy or safety
  requires it.

### Phase 6 — Scale beyond the CBD (ongoing)

- Expand by tile and neighbourhood, not by copying a monolithic scene.
- Add regional terrain and citywide land-cover products first.
- Add detailed mesh and high-resolution models only where a planning question
  needs them.
- Introduce a spatial data catalogue, object storage, PostGIS, tile cache/CDN,
  job queue, and model registry.

## 5. Highest-value next 10 tickets

1. Add `ROADMAP.md`-backed product/data dictionary and model confidence labels
   to API responses and the UI.
2. Define persistent IDs and metadata for buildings, parcels, roads, trees,
   terrain tiles, and heat/wind products.
3. Replace the single-scene JSON delivery with a first tiled terrain/building
   prototype.
4. Create an authoritative building-height/roof-data ingestion path and QA
   report.
5. Add scenario persistence: baseline, draft, saved version, author, date,
   and model versions.
6. Add planning geometry/zoning layers and a first height/FAR/setback rule
   check, without property/business attributes.
7. Add a validation dashboard for heat and wind against observations/reference
   simulations.
8. Replace mitigation point estimates with explicit assumptions, uncertainty
   ranges, and sensitivity tests in the UI.
9. Add GLB/3D Tiles import for a proposed building and compare it with the
   current city model.
10. Add automated asset QA, tile-size budgets, and a reproducible data-build
    manifest.

## 7. Suggested architecture

```text
Sources: LiDAR | imagery | planning geometry | OSM | weather | sensors
                                  |
                    ingestion + CRS/vertical-datum QA
                                  |
           PostGIS feature store + object storage + data catalogue
                 /                 |                 \
        3D tile builder       model registry       scenario store
        terrain/buildings     heat/wind/flood       baseline/proposals
                 \                 |                 /
                   API + tile service + auth/audit
                                  |
                    Three.js/Cesium-style web client
```

The current FastAPI service can remain the first API boundary. The main change
is to make assets, scenarios, and models versioned products rather than files
that are implicitly tied to one local build. Any integration with the separate
business/property dashboard should use only an approved spatial-ID/result
contract.

## 8. Definition of “ready for planning use”

Do not call the system a planning-grade twin until it has:

- authoritative geometry and persistent feature IDs;
- documented source dates, lineage, CRS, vertical datum, and update cadence;
- tiled multi-resolution 3D delivery;
- saved and reproducible scenarios;
- planning constraints and measurable before/after metrics;
- calibrated model outputs with uncertainty and validation evidence;
- clear labels separating observation, forecast, model, and assumption;
- access control, audit history, and exportable review packages.

## 9. Strategic choice

Build the next milestone as a **climate-resilience planning twin for the CBD**,
not as a generic replica of the whole city. It is the shortest route from the
current working prototype to a useful Zurich-like experience: authoritative 3D
context, scenario editing, planning metrics, and defensible climate analysis.
