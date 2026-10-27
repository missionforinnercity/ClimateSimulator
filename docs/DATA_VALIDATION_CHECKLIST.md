# What to validate, exactly

This checklist distinguishes **input-data QA** (is the dataset correctly
located, complete and represented?) from **model validation** (does a computed
result agree with independent observations?). Passing QA does not validate a
simulation. Keep source files, metadata, checks, exclusions and comparison
outputs together so each conclusion can be reproduced.

## First: validate every incoming file

For each source or field-observation file, preserve an untouched original and
record its provider, product/version, retrieval date, licence, valid time
range, units, timestamp convention, CRS and vertical datum, spatial extent,
resolution, processing steps, and SHA-256. Then check:

1. **Structure:** required columns/bands, data types, geometry validity,
   coordinate order, nodata encoding, duplicate identifiers and parse errors.
2. **Coverage:** spatial footprint, valid-cell/feature coverage, missing
   periods, temporal cadence and gaps. Report denominators and percentages;
   do not silently fill missing data.
3. **Physical plausibility:** units and ranges, impossible values, negative
   radiation/precipitation where not meaningful, valid direction angles,
   geometry dimensions, and cross-variable consistency (for example,
   shortwave global ≈ direct + diffuse within a stated tolerance).
4. **Geospatial alignment:** CRS transformation, vertical datum, grid origin,
   resolution, raster alignment, positional error and whether locations fall
   inside the actual model domain. Retain original coordinates as well as
   transformed viewer coordinates.
5. **Provenance and quality:** source date/version, sensor ID and calibration,
   quality flags, averaging period, processing exclusions and reason for each
   exclusion. Never infer a missing sensor height, source date or quality flag.
6. **Independence:** identify whether the reference was used to create, tune,
   assimilate into, or calibrate the product. A source can be a useful
   consistency check without being independent validation.

## Project-specific validation matrix

| Data/model in this project | What to compare it with | Exact checks and reported evidence | Current state / what is still needed |
| --- | --- | --- | --- |
| **Terrain DEM** (`company_gardens_hybrid_dem_2m.tif`) | Independent surveyed spot heights, breaklines or higher-accuracy LiDAR withheld from DEM construction | Check CRS and vertical datum first. Co-register; report point count, coverage, mean error/bias, MAE, RMSE, 95th-percentile absolute error and spatial error map. Stratify by source class (LiDAR vs coarse infill), slope and terrain type. | Manifest records a 2 m hybrid grid, valid area and LiDAR/coarse cell counts, but those are provenance/coverage, not elevation accuracy. Need independent checkpoints and datum/source-date metadata. |
| **Buildings, footprints, heights and roofs** (`BuildingFootprintsHybrid.geojson`, roof mesh) | Current authoritative building survey, municipal/LiDAR footprints and measured heights; representative roof surveys | Match by stable ID. Report footprint intersection-over-union and boundary distance; height bias/MAE/RMSE; count and area coverage; roof type/plane/edge error on sampled roofs. Stratify measured, inferred and fallback heights/roofs. Check building ground elevation against terrain and record source dates. | 1,891 buildings and roof-model counts are known. Need independent reference geometry/heights and a sampled roof audit; the fallback population must remain separately identified. |
| **Trees/canopy** (`tree_canopy.geojson`, canopy layer) | Current aerial imagery or LiDAR canopy delineation plus field inventory for sampled trees | Compare canopy presence/absence, crown polygon IoU/area and boundary distance; tree count and species/height only where observed. Report omission/commission and coverage by block. Check overlaps, holes, multipolygons and source date. | Count and area drift are recorded; these do not establish positional or crown-shape accuracy. Need dated independent imagery/LiDAR and field checks. |
| **Roads, rail, land cover and public realm** (OSM and derived layers) | Dated municipal/cadastral transport and public-realm inventory; field audit on a stratified sample | By class, report feature precision/recall, positional offset, completeness by block, topology gaps/duplicates, surface-class confusion matrix and mapped-vs-unknown area. For crossings, parking, lights and amenities, count and locate sampled features against field inventory; record access/operational status separately. | Manifest counts and source hashes exist. Counts are not completeness. Need dated authoritative inventory and field sample; OSM tags can be missing or stale. |
| **Weather forcing** (ERA5, forecast providers, satellite radiation, SENSOTO/ISD) | Time-matched independent station observations with known height/exposure; radiation station or quality-controlled satellite product | For each variable report valid paired n, coverage, time offset, bias, MAE, RMSE, correlation and seasonal/day-night breakdown. Wind direction needs circular error and a calm-wind rule. Radiation: compare global, direct and diffuse separately and test closure. Keep station distance, elevation, sensor height/exposure and assimilation dependence visible. | ERA5 wind archive is complete for 2021–2025. SENSOTO 688190-99999 is Molteno Reservoir, outside the scene, sparse (32.9% of possible hours), with undocumented instrument height/exposure and no humidity/radiation/Tmrt; it is a regional check only. A 2019 paper reports five-minute 2015–2016 winds from six Cape Town SAWS sites, but raw records are not directly linked. The Western Cape agriculture portal lists 37 stations, with its nearest 33.8 km outside the footprint and data marked unverified. Obtain the SAWS records and resolve station identity before use; local, well-documented CBD measurements are still needed. |
| **OpenFOAM pedestrian wind fields** (directional CFD volumes) | Calibrated, simultaneous pedestrian-height wind sensors inside the scene plus an upstream reference sensor | Survey sensor coordinates/height and document instrument, calibration and averaging interval. Match model direction and forcing; require the reference direction within the solved-sector tolerance. Score independent holdout sites or periods: speed bias/MAE/RMSE, speed-up ratio error, circular direction error where reliable, sample/coverage count, and residuals by height, direction and urban form. Assign each complete holdout unit a `split_group`, reject groups appearing in both splits, and report metrics by group. | The sampler/scorer exists. A published 1989 Civic Centre study contains local pedestrian gust observations, but lacks the coordinates, heights, calibration and time-matched upstream data needed for numeric comparison to the current steady-mean CFD. Treat it as a qualitative historical challenge case, not validation. New local matched mean-wind observations remain needed. See [wind procedure](WIND_VALIDATION.md). |
| **Thermal air temperature, humidity, Tmrt and UTCI** (weather forcing, SOLWEIG and OpenFOAM fields) | Co-located calibrated CBD observations at open sun, canyon shade and tree shade; direct Tmrt measurement preferred | Synchronize measured air temp (2 m), RH, Tmrt and 10 m wind to within 15 min; record positive averaging periods and sensor details. Air temperature/RH compare with weather forcing, not spatial SUEWS output; Tmrt compares with SOLWEIG, wind with the scaled OpenFOAM atlas, and UTCI with the spatial UTCI raster. Score each component separately (bias/MAE/RMSE) and compute reference UTCI from measured inputs using the same UTCI routine. Use whole-site or whole-period holdout; `split_group` leakage is rejected; report holdout by group/site, weather, sun/shade transition and sample coverage. | Comparison workflow exists, but there are no CBD field measurements. UTCI remains experimental/unvalidated. SENSOTO lacks required thermal channels and is outside the scene. See [thermal procedure](THERMAL_VALIDATION.md) and [campaign plan](TMRT_MEASUREMENT_CAMPAIGN.md). |
| **Thermal climatology and comfort-hour/area KPI** | Complete observed hourly records or a validated forcing/model record over the same period; independent check of classified maps where possible | Verify time coverage and missing hours; expose the underlying UTCI distribution/map; recompute stress-band area-time shares from raw grid-hours; report valid area, valid hours, denominator, thresholds and representative-year conversion. Compare any claimed observed frequency against actual observed hours, not a composite profile. | Area-time KPIs are implemented, but historical products are composite climate profiles. Equivalent hours are model-derived representative-year estimates, not observed hourly comfort. |
| **Direct sunlight / shadow / solar exposure** | Time-stamped georeferenced shadow observations or calibrated fisheye/sky-view imagery; pyranometer for radiation/energy claims | At matched locations and timestamps compare shadow boundaries/area, sunlit fraction and timing; report spatial boundary error and time error. For irradiance/energy compare measured direct/diffuse/global radiation separately. State clear-sky and surface-reflection assumptions. | Direct-sun design comparison exists, but no independent shadow/radiation benchmark is recorded. Sunlight hours do not validate irradiance or thermal comfort. |
| **Runoff screening** | Rain gauge/radar event data, surveyed drains/inlets and levels, drainage-capacity records, observed ponding/flood extent or authoritative hydraulic study | Check rainfall units/time series and event total; survey flow paths, inlets, barriers and drain connectivity. For an observed event, compare ponding occurrence, depth/extent and timing; report hit/false-alarm/miss and depth/extent error where measurements allow. Separate terrain accumulation from hydraulic prediction. | Current layer is terrain-only screening. Need local drainage and event observations before claiming flood depth, capacity or safety. |
| **Traffic/SUMO** | Matched-period turning counts, classified volumes, travel times, speeds, queues and signal timing | Compare by approach, movement and time interval; report count bias/MAE or GEH where appropriate, travel-time/speed error, queue length error and completion/route coverage. Calibrate on one period and validate on a separate day/period. Record demand, vehicle mix, signal program and incidents. | Synthetic demand/stability checks exist. They do not calibrate actual traffic. Real counts, travel times and signal timings are still needed. See [traffic evidence list](TRAFFIC_VALIDATION.md). |
| **Walking links, transit and accessibility** | Field audits and current operator schedules; observed pedestrian crossing/access constraints and arrivals where available | Stratified route audit for existence, access, barriers, crossing, surface, grade and closure; report audited length/completeness and errors by class. Verify schedules against operator-published effective dates; compare predicted/observed arrivals only with actual service observations. | Network-derived accessibility is a screening estimate. Need field link audits, current schedules and operational access/capacity evidence. |
| **Pollutant dispersion** | Co-located calibrated pollutant monitors, source activity/emissions and meteorology over matched periods | Validate concentration by species and averaging period; report bias/MAE/RMSE, exceedance detection, spatial/temporal coverage, and source/emission uncertainty. Hold out receptors or time periods. Check background concentration separately from road-source increment. | Current output depends on baseline CFD and estimated road emissions. No receptor-monitor validation campaign is supplied. |
| **Design proposal comparisons** | Same evidence as each physical layer, recomputed on proposal geometry under matched forcing | Pair baseline/proposal only when period, forcing, method, domain and KPI definitions match. Attach proposal geometry hash and both result references. Explicitly label recalculated, baseline-only, screening and offline-required layers. | Matched direct-sun and heat/shade-screen pairs are available. The heat screen holds summer surface temperature fixed and is not proposal UTCI/Tmrt. Other proposal layers are not coupled; baseline outputs must not be represented as proposal results. See [design coupling](DESIGN_COUPLING.md). |

## The first field campaign to run

To address the highest-risk scientific claims, prioritize **one synchronized
CBD campaign** that supports both wind and thermal validation:

- At least three fixed, surveyed sites: open/sun-exposed paving, shaded street
  canyon, and tree shade. Choose an additional site or complete days as the
  untouched holdout; declare the split before inspecting residuals.
- Co-located calibrated measurements: pedestrian wind speed/direction at the
  CFD comparison height (record exact height), upstream reference wind speed
  and direction, 2 m shielded air temperature, RH, Tmrt, and 10 m wind needed
  by the UTCI calculation. Log 1–10 minute raw observations and retain the
  averaging window used for model pairing.
- Sample multiple days and wind directions, including sun/shade transitions;
  avoid a single weather episode. Survey each sensor in the project CRS and
  record instrument height above local ground, calibration, serial/ID,
  exposure, obstructions and quality flags.
- Keep raw data immutable. Produce a cleaned CSV with a reason for each
  exclusion, then run the existing wind and thermal comparison workflows.
  Archive the model run IDs, source/weather hashes, cleaned data, field notes,
  scoring JSON and a site/period holdout report together.

For a synchronized campaign, start with the combined
[`cbd_validation_campaign_template.csv`](cbd_validation_campaign_template.csv).
It contains both current scoring schemas: use the same row for thermal scoring
and for OpenFOAM wind scoring, retaining columns that are not consumed by one
of the scripts as field provenance. `sensor_id`, `sensor_model`,
`calibration_date` and `sensor_calibration` describe the pedestrian wind
sensor; put the remaining channel-specific sensor IDs/calibration details in
`sensor_ids` and `measurement_notes`, and retain the full instrument log and
certificates separately. Use one row per site and synchronized averaging
window. Do not put an upstream reference measurement into `speed_mps`; that
column is the pedestrian sensor. The separate existing observation templates
and scripts are
[`wind_observations_template.csv`](wind_observations_template.csv),
[`thermal_observations_template.csv`](thermal_observations_template.csv),
[`validate_thermal_observations.py`](../scripts/validate_thermal_observations.py),
and the OpenFOAM workflow in [WIND_VALIDATION.md](WIND_VALIDATION.md). The
templates do not replace a full instrument log: retain calibration
certificates, original coordinates/CRS, height/exposure notes, raw cadence,
quality flags and averaging method separately.

## Acceptance and reporting rules

- Define use case, target variable, averaging interval, holdout split and
  acceptance limits **before** opening holdout scores. Limits should come
  from the intended decision and applicable domain guidance, not be selected
  to fit the result.
- Report calibration and holdout separately, including sample count, valid
  coverage, excluded rows/reasons, temporal offsets, sites, conditions and
  uncertainty. Give each whole site or time block a stable `split_group`, and
  never assign the same group to both splits. Stratify errors; a good citywide mean can conceal systematic
  failures in a street type or weather regime.
- Preserve measured/modelled components with physical units. A normalized KPI
  or category cannot replace underlying temperature, wind, radiation or UTCI.
- A validation label applies only to the tested variable, sites, period,
  heights, forcing, geometry and model version. It does not transfer to a
  related output or a proposal geometry without new evidence.

See [validation status](VALIDATION_STATUS.md) for current evidence and
remaining gaps across the project.
