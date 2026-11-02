# Features that could make Conditions a leading urban evidence tool

This is a proposed roadmap, not a claim that the current app is validated or state of the art. Prioritize decisions people need to make: where to add shade, how an event affects access, which scenarios deserve engineering study, and whether an apparent change is supported by evidence.

## Recommended order

| Priority | Feature | User value | Prerequisites / scale |
| --- | --- | --- | --- |
| 1 | Place and street inspector | Search, keyboard selection and empty/out-of-terrain pick handling are browser-checked in WebGL. Regression fixtures cover duplicate names, missing source IDs and points outside the mapped feature radius. | Existing semantic IDs; indexed compact scene records. Initial release and QA complete; maintain coverage as scene records change. |
| 2 | Reproducible scenario packages | Reopen a study with exact geometry, dates, model version, closure edges, evidence and report | Printable HTML presents readable Heat, Sunlight, Viewshed and Wind findings and retains typed result references in an embedded report payload; design heat/shade includes per-zone values. The verifier and archiver accept the HTML report directly. The archive packages retrievable thermal/OpenFOAM/traffic results plus matching local design heat/shade inputs. Still needs durable per-model result storage and replay execution for remaining analyses. Medium |
| 3 | Observation and validation workbench | OpenFOAM pedestrian-wind scoring and thermal component/UTCI comparisons now have timestamp, height, averaging-period and grouped holdout handling. Traffic still needs its matched-observation scorer. | CBD wind/thermal scorers and combined field template are ready; real local campaign data and traffic counts remain prerequisites. High, data-gated |
| 4 | Shade-aware walking alternatives | Compare shortest vs shaded routes for a chosen date/time; explain trade-offs | Connected walk graph, directional access, calibrated shade sampling and surveyed accessibility where claimed. High |
| 5 | Intervention comparison laboratory | Compare a real proposed canopy, tree configuration or street design against a controlled baseline | Geometry editor with separate proposal layer, offline solve queue, matched forcing and validation gates. High |
| 6 | Time-series and seasonal explorer | Show hourly/seasonal ranges and data gaps instead of one attractive snapshot | Versioned time-series, aggregation rules and coverage masks. Medium–high |
| 7 | Event access scenario pack | Compare event timings and selected street closures with explicit traffic assumptions | Traffic workflows, operator permissions and consistent scenario linkage. Medium |
| 8 | Data freshness and change detection | See which buildings/streets changed and which source releases are stale | Successive dated releases, stable-ID crosswalk and quality-reviewed change detection. High |
| 9 | Uncertainty and robustness explorer | Show whether scenario rankings survive plausible assumptions | Expert-defined parameter ranges, ensemble compute budget and separate epistemic vs observational uncertainty. High |
| 10 | Priority and equity assessment | Compare cooling/access need across public spaces, with transparent weighting | Licensed aggregate population/use/access data; documented weights and privacy review. High, data-gated |
| 11 | Open geospatial catalogue and exports | Bring traceable outputs into municipal GIS workflows | Stable schemas, CRS metadata, licences and export validation. Medium |
| 12 | Streamed regional expansion | Extend beyond the CBD without loading the entire city | Tile-generation pipeline, LoD/error budgets, source coverage and measured renderer need. High |

## First three implementation briefs

### Place and street inspector

The initial release searches compact scene records by name or OSM ID, highlights selected buildings and streets in WebGL, and shows source tags, roof/height representation, and explicit unknowns. Search results support Arrow, Home, End, Enter and Escape, and show source IDs or an explicit missing-ID label plus mapped centre coordinates to distinguish same-name features. Browser checks exercise search, keyboard selection and map picking, plus the Wind handoff. Each analysis remains responsible for its own coverage check. Add automated regression fixtures for duplicate names, missing IDs, and picks outside the mapped footprint.

Done when a keyboard user can search, select and inspect a feature; selections remain stable after a rebuild; tests include duplicate names, missing IDs and points outside the footprint. No address geocoder or account is required for the first release.

### Reproducible scenario packages

Extend the HTML climate report and its embedded data payload. Persist exact closure edge IDs and direction, analysis domains, model parameters, source hashes and validation status. Store completed result references separately from editable settings. Add durable results or clearly governed retention, per-result maps/KPIs, and replay checks that detect unavailable/changed assets before attempting comparison.

Done when a clean checkout with the required data reproduces a deterministic fixture result; changing one input creates a new lineage record; mismatched data disables numerical comparison with a clear explanation. Start with local files. Multi-user accounts, cloud sharing and approval workflows require a separate product decision.

### Observation and validation workbench

Wind and thermal observation comparison now use administrator-supplied local files. The OpenFOAM scorer samples the converted pedestrian CFD volume; it requires a timezone-aware timestamp, pedestrian and upstream sensor heights, averaging period and explicit `split_group`, and reports separate group metrics. The thermal scorer pairs to hourly frames and reports air-temperature, humidity, Tmrt, wind and UTCI errors by holdout group. Use [`cbd_validation_campaign_template.csv`](cbd_validation_campaign_template.csv) for synchronized CBD measurements. No CBD observations have been supplied, so neither model is validated. Traffic still needs an observed-count/travel-time comparison. Do not relabel any model “validated” based solely on a good aggregate metric.

Done when known fixtures recover expected errors, poor coverage remains visible, withheld observations cannot leak into calibration, and a domain reviewer has signed off the interpretation rules. Sensor procurement, measurement campaigns and operator agreements are external work, not something a coding agent can invent.

## Advanced features: scientific gates

Shade-aware routes should display travel-time/shade trade-offs and segments with missing sidewalk/access data. Do not label a route wheelchair-accessible or safe without the necessary surveyed attributes. Version the result by sun/shade model and time window; routes should update predictably at intersections and network gaps.

Interventions need an explicit proposed geometry version. Tree effects require crown/leaf-area/seasonal assumptions; CFD must be re-meshed/re-solved when geometry changes. A cheap surrogate may be useful later, but it needs a validated training domain, out-of-distribution rejection and comparison against held-out full solves. Never colour a guessed intervention outcome as CFD.

An uncertainty explorer should prioritize robust rankings over a false single “best” design. Keep measured variability, missing coverage and modelling assumptions distinct. Record random seeds and paired baseline conditions. Coupled thermal comfort, air quality, drainage and energy modelling each require a separately scoped scientific pipeline.

Equity assessment should use aggregate data at a justified resolution, show missingness and permit inspecting the weights. Do not infer individual vulnerability, publish household-level information or automatically allocate municipal services.

## Interoperability choices to investigate

- OGC 3D Tiles is designed to stream large 3D geospatial datasets. Consider it when a measured need to expand coverage warrants a tiled scene pipeline, while keeping stable semantic IDs and per-tile provenance. [OGC 3D Tiles](https://www.ogc.org/standards/3dtiles/)
- STAC offers a common structure for describing spatiotemporal assets. A catalogue of dated terrain, canopy, imagery and model-result releases could make data discovery and reproducibility easier. It does not itself validate the science. [STAC specification](https://stacspec.org/en/)
- OGC SensorThings provides an observation/metadata model for heterogeneous sensors. Evaluate an adapter for a future sensor programme; using the standard is not evidence of calibrated or complete measurements. [OGC SensorThings overview](https://ogcapi-workshop.ogc.org/api-deep-dive/sensorthings/)

These are candidate standards for new work, not reasons to rewrite the current renderer or backend immediately. The priority ordering and feature designs above are project-specific recommendations based on this repository, not claims made by those standards bodies.

## Intervention comparison progress

The Design panel runs matched clear-sky direct-sun comparison and a matched
heat/shade screening pair. The latter recalculates proposal shade and the
screening score while holding the summer surface-temperature baseline fixed;
it is not a UTCI/Tmrt recalculation. Wind wake remains a visual screen.
Proposed-geometry UTCI/Tmrt, multi-direction wind comfort, pollutant
dispersion, runoff, traffic and route metrics still require their own
recomputation or offline-solve paths. See [design coupling](DESIGN_COUPLING.md)
for the current recalculation matrix.

## Features to continue excluding

Do not add a generic planning chatbot, ungrounded AI forecasts, photorealistic scenery for its own sake, social feeds, gamification, or a black-box “city score”. Do not advertise live vehicles without a real licensed feed. Avoid broad framework migrations and citywide multi-physics promises before validating a smaller use case.

The strongest differentiator would be an auditable chain from source data through scenario and uncertainty to a useful decision—not the number of animated layers.
