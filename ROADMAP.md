# Conditions roadmap: resilience and placemaking

This roadmap evaluates the proposed community, water, cycling, and civic layers
against the current Conditions code and checked-in data. It favours small
extensions to existing scene assets and analysis workflows. Outputs must retain
their source, coverage, assumptions, and evidence status; screening views must
not be presented as validated engineering or safety results.

## Completed low-effort layer

**Mapped surface inventory:** the optional 3D layer now displays mapped paved,
vegetated and water polygons, reports area and footprint coverage, and leaves
unmapped ground visibly unclassified. It does not estimate infiltration or
runoff. The layer loads only when enabled.

**Mapped cycleways:** the optional layer highlights dedicated OSM cycleway
features, reports mapped length, components linked within 8 m and unmatched
mapped ends. The small extract is not a complete cycling network and does not
support safety or access claims.

**Walking route street evidence:** each route now reports nearby municipal
crossing points and route-length-weighted OSM lighting, sidewalk and width tag
coverage. Unknown tags stay unknown, crossing proximity is not treated as a
crossing on the path, and the indicators do not produce a safety score.

## Completed terrain-only screen

**Stormwater runoff concentration:** the optional layer routes mapped paved
cells over the 2 m hybrid terrain using Priority-Flood depression filling and
single-direction D8 accumulation. It displays relative mapped contributing
area and a rainfall-depth slider that scales gross rainfall volume. It is a
terrain-only screen with explicit source and coverage assumptions; it does not
predict flood depth or model drainage. The validation dependencies below
remain open.

## Recommended next work

| Order | Work item | Fit and first useful scope | Effort / dependencies |
| --- | --- | --- | --- |
| — | **Drainage-aware runoff validation** | Add documented rainfall events, infiltration and drainage assets, then compare with observed ponding or an authoritative drainage study before expanding claims. | **High.** Requires local engineering inputs, drainage connectivity and independent validation. |

## Evaluation of the suggestions

| Suggestion | Decision | Reason |
| --- | --- | --- |
| Permeable surface audits | **Added as a mapped inventory.** | `data/osm_cbd_groundcover.geojson` distinguishes mapped paved, vegetated and water features. The layer reports source coverage only; it does not infer permeability or treat absence of a polygon as vegetation. |
| Flood risk and runoff visualization | **Terrain-only concentration screen added.** | High-value use of existing terrain. This first view makes mapped pavement inputs visible but cannot estimate flood depth; a credible drainage model needs rainfall design events, soil/infiltration parameters, drainage assets and validation. |
| Paint bioswales/rain gardens and calculate runoff reduction | **Defer beyond MVP.** | The current intervention editor was removed and there is no drainage model or locally calibrated runoff coefficient set. Later, add proposed polygons and compare scenarios only after the runoff method and assumptions can be reviewed. |
| Day/night footfall heatmaps | **Defer; data-gated.** | There is no pedestrian count or cellular dataset. Synthetic walkers in the route tool are route exposure agents, not observed footfall. Do not invent density values. |
| Acoustic comfort propagation | **Defer; model/data-gated.** | SUMO reports relative edge-noise emissions, not sound pressure or propagation. A useful map needs a documented acoustic model plus traffic volumes, speeds, fleet mix and building/reflection assumptions. Existing edge-noise results can remain clearly labelled traffic context. |
| Retail activation / dwell-time correlation | **Defer; data-gated.** | No storefront activity, land-use, footfall or dwell-time observations exist. Shade and traffic can be compared now, but a correlation or economic benefit claim would be unsupported. |
| Cycling corridors and network gaps | **Added as a mapped-link screen.** | OSM cycleway geometry is highlighted and nearby endpoints are grouped. The extract is sparse; high-stress ratings and a citywide gap claim require better facility, speed, volume and junction data. |
| 5/10-minute micromobility isochrones | **Defer.** | Technically feasible as graph reachability, but there are no bike-share/scooter hubs or dedicated cycling-cost network. Revisit after the cycling layer and hub data are available. |
| Route safety scoring | **Limited context view added; scoring remains deferred.** | Walking routes show municipal crossing proximity and OSM lighting, sidewalk and width tag coverage with explicit unknowns. Pavement width and complete crossing/stress attributes remain incomplete; the indicators do not support a safety ranking. |
| Citizen feedback pins | **Defer; product and operations decision.** | A public-facing submission flow needs persistent storage, moderation, abuse controls, retention rules and an operator workflow. A private local annotation prototype could be considered separately, but it is not a citywide civic feedback service. |
| Public Before/After voting | **Defer; product and operations decision.** | Current snapshots are local to one tab and share settings rather than complete results; there is no public hosting, identity, vote integrity or moderation system. First improve reproducible scenario packages before collecting votes. |
| Month-by-month construction phasing | **Defer; scenario model extension.** | Current closures compare paired traffic runs and do not model a construction schedule or changing pedestrian routes over time. Could later build on traffic scenarios once project phases, work-zone rules and pedestrian detours are supplied. |

## Scope and acceptance notes

- Keep all new layers optional and preserve the existing static viewer where a
  feature can be prepared as a scene asset.
- Include source date/licence, spatial coverage, unknown areas, units and
  assumptions in map legends and summaries.
- Treat mapped absence as unknown unless the source explicitly establishes
  absence. Keep synthetic, inferred and observed values distinct.
- Do not combine climate, traffic, accessibility or economic measures into an
  opaque city score. Prefer inspectable indicators and side-by-side trade-offs.
- For runoff work, write a method note and validate against observed rainfall,
  known ponding locations or an authoritative drainage study before making
  flood-risk or intervention-benefit claims.

The broader evidence and validation roadmap remains in
[`docs/FEATURE_ROADMAP.md`](docs/FEATURE_ROADMAP.md).
