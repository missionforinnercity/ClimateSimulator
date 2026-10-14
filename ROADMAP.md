# Conditions roadmap: resilience and placemaking

This roadmap evaluates the proposed community, water, cycling, and civic layers
against the current Conditions code and checked-in data. It favours small
extensions to existing scene assets and analysis workflows. Outputs must retain
their source, coverage, assumptions, and evidence status; screening views must
not be presented as validated engineering or safety results.

## Recommended next work

| Order | Work item | Fit and first useful scope | Effort / dependencies |
| --- | --- | --- | --- |
| 1 | **Surface and permeability audit** | Reuse the mapped groundcover and green-area layers to show mapped paved versus vegetated surfaces, report areas and coverage, and identify unmapped ground separately. This is an inventory screen, not a measured infiltration map. | **Easy–moderate.** Existing GeoJSON; document OSM source and incomplete tagging. |
| 2 | **Mapped cycling network and gap screen** | Make existing OSM cycleway links visible as a named mobility layer. Identify disconnected ends and missing links between connected components; show mapped infrastructure only and label OSM coverage gaps. | **Easy–moderate.** Existing OSM extract and road rendering; basic graph/connectivity summary. Do not label routes protected or safe without facility and traffic-stress evidence. |
| 3 | **Walking route stress context** | Add optional route context using existing walking routes, mapped crossings, traffic proximity/closure results, shade and heat exposure. Start with segment-level indicators and missing-data flags; leave width/accessibility unknown where not mapped. | **Moderate.** Reuses current route graph and traffic/crossing layers. No composite “safety score” or wheelchair-accessibility claim. |
| 4 | **Stormwater runoff screening (MVP)** | Explore a bounded intense-rain scenario over the existing terrain and mapped paved/vegetated cover. First deliverable: derive flow accumulation / likely ponding paths and summarize where runoff may concentrate, with rainfall and infiltration assumptions visible. | **Moderate–high.** Existing LiDAR/SRTM terrain is a useful base, but rainfall inputs, surface coefficients and drainage validation are needed. Terrain-only output is a screening result; it does not model storm drains or predict flood depth. |

## Evaluation of the suggestions

| Suggestion | Decision | Reason |
| --- | --- | --- |
| Permeable surface audits | **Add (order 1).** | `data/osm_cbd_groundcover.geojson` already distinguishes mapped paved and vegetated features. Useful and relatively small, but absence of a mapped polygon cannot be treated as permeable ground. |
| Flood risk and runoff visualization | **Add as the MVP in order 4.** | High-value use of existing terrain, but a credible drainage/flood model needs rainfall design events, soil/infiltration parameters, drainage assets and validation. Begin with transparent terrain-flow screening only. |
| Paint bioswales/rain gardens and calculate runoff reduction | **Defer beyond MVP.** | The current intervention editor was removed and there is no drainage model or locally calibrated runoff coefficient set. Later, add proposed polygons and compare scenarios only after the runoff method and assumptions can be reviewed. |
| Day/night footfall heatmaps | **Defer; data-gated.** | There is no pedestrian count or cellular dataset. Synthetic walkers in the route tool are route exposure agents, not observed footfall. Do not invent density values. |
| Acoustic comfort propagation | **Defer; model/data-gated.** | SUMO reports relative edge-noise emissions, not sound pressure or propagation. A useful map needs a documented acoustic model plus traffic volumes, speeds, fleet mix and building/reflection assumptions. Existing edge-noise results can remain clearly labelled traffic context. |
| Retail activation / dwell-time correlation | **Defer; data-gated.** | No storefront activity, land-use, footfall or dwell-time observations exist. Shade and traffic can be compared now, but a correlation or economic benefit claim would be unsupported. |
| Cycling corridors and network gaps | **Add (order 2).** | OSM cycleway geometry is already included in the road data and scene width rules. A mapped-link and graph-connectivity view is a small fit; high-stress ratings require better facility, speed, volume and junction data. |
| 5/10-minute micromobility isochrones | **Defer.** | Technically feasible as graph reachability, but there are no bike-share/scooter hubs or dedicated cycling-cost network. Revisit after the cycling layer and hub data are available. |
| Route safety scoring | **Add a limited context view (order 3); defer scoring.** | Walking routes, crossings, traffic and climate layers exist. Pavement width and complete crossing/stress attributes do not. Show explainable indicators and gaps, not a safety ranking. |
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
