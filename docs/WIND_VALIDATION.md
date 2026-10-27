# Wind validation and comfort workflow

## Published Cape Town measurement candidate

An archival pedestrian-level case study is available around the Cape Town Civic
Centre: Louise Loubser, “The influence of buildings on ground level wind
conditions,” based on a 1989 Stellenbosch study. The paper describes 45 sidewalk
and plaza stations and reports measurements made during the 2 October 1989
south-south-easterly event. It says a handheld anemometer/compass recorded the
maximum gust during a ten-minute visit at each station; the local free-wind
condition was assumed to be 9 m/s SSE from dock and nearby open-site records.
The article includes a station plan with annotated speeds and directions. See
the [University of the Free State journal copy](https://journals.ufs.ac.za/index.php/trp/article/download/2818/2736/5376)
or [searchable PDF copy](https://distantreader.org/stacks/journals/trp/trp-2818.pdf).

This is genuine local field evidence and is useful as a **qualitative historical
challenge case**, especially for checking whether a modern model reproduces the
reported high-wind passageways, corner stream and reversals around the Civic
Centre. It is not currently a valid numeric holdout for the present OpenFOAM
volume: the paper reports ten-minute maximum gusts rather than mean velocity,
does not provide exact station coordinates, instrument heights, calibration
records, per-station timestamps, or a simultaneous upstream reference series,
and describes the scene as it existed in 1989. The present steady CFD volume
does not resolve gusts. Do not enter values read approximately from the paper's
figure into the quantitative scorer as if they were matched means. A numerical
retrospective comparison would require the underlying field sheets or a
digitized, georeferenced dataset plus documented sensor height/exposure and
matching CFD geometry/forcing. Even then, it would be an event-specific
external check, not a replacement for a new campaign or a separate holdout.

## Wind panel workflow

The wind panel opens on the comfort screen. Results show sitting/standing
share first; resolved model-cell coverage, solved wind-hour coverage, ERA5
hourly archive coverage and model status sit under **Evidence, coverage &
assumptions**. Direction mode reports the solved pedestrian-height CFD speed
field and can be compared with another direction. Comfort results can be
compared across periods. Comparisons use the same analysis type and show a
cell difference map only when both grids have matching geometry and valid
cells.

**Compare scenarios** keeps a baseline in the current browser session. It is
not a saved study package. **Check against measurements** has separate targets.
**OpenFOAM pedestrian field** samples the selected converted CFD volume
directly; **Screening proxy** continues to call `/api/wind/validate` and is
diagnostic only. OpenFOAM scoring calls `/api/wind/validate-openfoam` and
requires at least three rows with `split=calibration` or `split=holdout`,
`split_group`, viewer-local `x,z`, pedestrian `speed_mps` and `height_m`, plus
simultaneous upstream `reference_speed_mps`, `reference_direction_deg` and
`reference_height_m`. A timezone-aware ISO 8601 `observed_at` and
`averaging_period_s` are required so the measurement time and averaging window
are explicit. Optional `wind_direction_deg`, `site_name`, sensor calibration,
`sensor_id`, `sensor_model`, `calibration_date` and notes are retained in the
paired report when supplied. The report hashes the normalized observation
payload, OpenFOAM volume manifest/fields/mask, terrain DEM and scene manifest.
The reference direction must be within 11.25° of the selected solved case.

For a joint wind/thermal field campaign, use
[`cbd_validation_campaign_template.csv`](cbd_validation_campaign_template.csv).
Enter one row per pedestrian site and synchronized averaging window. In this
row, `speed_mps` and `height_m` are the pedestrian wind measurement;
`reference_speed_mps`, `reference_direction_deg` and `reference_height_m` are
the simultaneous upstream reference. `averaging_period_s` is the averaging
window used for those wind values. Use the same predeclared `split` for
both wind and thermal scoring. Every calibration and holdout row needs a
`split_group` identifying its complete evaluation unit, for example
`site:grand-parade` or `period:2026-10-01..2026-10-07`; keep all rows in a unit
on the same split. Holdout groups remain untouched during tuning.
The scorer rejects groups assigned to both splits and reports metrics by
group. The template also has the thermal input fields,
so the same CSV can be used by the Heat observation comparison. Retain
channel-specific sensor IDs, instrument logs, calibration certificates and
original survey coordinates/CRS with the campaign record; the CSV does not
replace those source records.

## What the application reports now

Every `/api/wind/preview` response reports a field at the requested height
(2 m by default), the atmospheric stability assumption, conditional
exceedance probability, a five-percent-exceedance comfort class, and lower /
upper screening speeds. The interval represents model-form and height-profile
uncertainty; it is not a statistical confidence interval.

The Wind panel now separates two different questions:

- **Direction** calls `/api/wind/preview` for one selected inflow sector. It is
  a diagnostic velocity/speedup study and its exceedance is conditional on
  that direction occurring.
- **Comfort** calls `/api/wind/comfort` and combines 16 directional fields.
  For every grid cell and Lawson-LDDC-style activity threshold, the API sums
  the sector Weibull exceedance multiplied by its normalized seasonal/annual
  ERA5 wind-rose frequency. The first activity with no more than 5% combined
  exceedance becomes the displayed comfort class.

In Direction mode, the selected forcing speed is treated as the conditional
mean speed for the selected direction. A Weibull distribution estimates the
fraction of that sector's hours above the selected threshold. In Comfort mode,
all 16 conditional curves are frequency weighted and summed.

## Versioned comfort criteria

`GET /api/wind/criteria` returns criterion IDs, versions, activity thresholds,
exceedance probability, averaging basis, gust treatment and source record. The
WebGL Comfort lens lets users select the supported versions; the selected
criterion and provenance travel with the result and print report.

| ID | Thresholds used | Averaging and gust handling | Status |
| --- | --- | --- | --- |
| `lawson_lddc_style_screening_v1` | 2.5, 4, 6, 8 and 10 m/s; 5% exceedance | Weibull exceedance from hourly ERA5 mean speeds and steady CFD mean velocities; no gust-equivalent mean or safety test. | Screening profile retained from the existing app. It is explicitly **Lawson-LDDC-style**, not formal LDDC compliance. |
| `davenport_1972_mean_5pct_v1` | 3.5 m/s long exposure, 5.5 short exposure, 7.5 strolling/skating and 10 fast walking; 5% exceedance | Hourly mean wind-speed criterion; Weibull exceedance and ERA5 directional-frequency weighting; no gust adjustment or safety assessment. | Implemented as a screening interpretation of the published threshold bands. The band ceilings are used as activity cut-offs. |
| `lawson_lddc_2001_gem_v1` | 4 m/s sitting, 6 standing, 8 walking at 5% GEM exceedance; separate 15 m/s annual maximum gust safety check. | Comfort requires gust-equivalent mean `max(hourly mean, 3-second gust / 1.85)`; safety uses annual maximum gust. | Listed in the API but disabled. Current steady CFD fields do not provide a validated 3-second gust or annual-maximum distribution. |

The Davenport thresholds follow A.G. Davenport (1972), *An approach to human
comfort criteria for environmental conditions*. The table is reproduced in
Windtech Consultants' [pedestrian wind environment study](https://docs.planning.org.uk/20210719/129/DCAPR_155865/nfidamevhegvfr1h.pdf),
Appendix A, Table A.2 (PDF pages 50–51). The Lawson LDDC GEM and safety
thresholds and the GEM definition are reproduced in the same report, Section
5.2, Tables 3–4 (PDF page 21); the report cites T.V. Lawson (April 2001) and
ASCE (2003) for those definitions.

Do not compare categories across criteria as if their labels or exposure
definitions were interchangeable. The app currently uses regional hourly
ERA5 means, Weibull fits and partial solved-sector coverage; it does not have
the gust inputs needed for a complete GEM or pedestrian-safety criterion. The
Lawson-style option therefore remains screening even though its thresholds
are now versioned and explicit. The official [NEN 8100:2006 publisher record](https://www.nen.nl/en/nen-8100-2006-nl-107592)
confirms that standard is current and copyrighted; no NEN option is exposed
until its full criteria and required calculations are sourced and reviewed.

## Solver scope

The application uses precomputed diagnostic mass-conserving terrain and
building fields. It resolves regional terrain steering and local speed-factor
effects for comparative planning studies. It does not resolve transient
turbulence, time-averaged wake structures, or tower-scale vortex shedding.
Those effects require project-specific RANS/LES modelling or wind-tunnel
analysis. Results remain planning-grade until the field-benchmarking gates
below are met.

## ERA5 Cape Town forcing

The active `data/wind_climatology/cape_town_era5.json` profile was built from
the 60 monthly files in `data/era5_monthly_2021_2025/`. Its manifest reports
43,824 hourly samples from 2021-01-01 00:00 UTC through 2025-12-31 23:00 UTC,
all 24 UTC hours, and complete hourly coverage for those five calendar years.
The monthly GRIB files' combined SHA-256 matches the active profile's source
digest. The eight variables are 10 m/100 m wind, neutral 10 m wind, maximum
gust and instantaneous gust. The application uses them for conditional mean
speed, Weibull shape, gust factor, sector occurrence, and 10–100 m shear by
season, direction and stability group.

The separate legacy file `data/Era5data.grib` contains only 4,901 samples and
11 UTC hours (35.4% of its covered calendar interval). It is **not** the source
of the active five-year profile. Keep it labelled incomplete; do not rebuild
the live climatology from that file. This completes temporal coverage for the
wind-frequency input, but ERA5 is still reanalysis rather than independent
local validation. Compare it with quality-controlled station records and
retain the station distance/exposure caveat.

The supplied SENSOTO NOAA ISD device `688190-99999` resolves to Molteno
Reservoir, 18.417°E, 33.933°S, about 314 m outside the scene footprint. Its
hourly temperature, mean wind speed and direction history last returned
2025-08-24 21:00 UTC. A 2026-10-27 API recheck found no non-null values for
these sensors from 2025-08-25 through 2026-10-26. SENSOTO metadata does not
state sensor elevation/height or exposure. The
2021–2025 exact-hour comparison against ERA5 is preserved in
[`evidence/sensoto-noaa-isd-688190-2021-2025.json.gz`](evidence/sensoto-noaa-isd-688190-2021-2025.json.gz)
and summarized in [validation status](VALIDATION_STATUS.md). The ERA5 point
resolved for the station is 21.7 km away and station-hour coverage is 32.9%.
This is a regional forcing cross-check, not OpenFOAM pedestrian-field
validation. It must not be used to adjust wind speeds until height and
exposure are documented and a separate holdout assessment is designed.

To reproduce or extend the five-year archive, `ERA5API` in `.env` is consumed
without being logged by the downloader:

```bash
python scripts/download_era5_wind.py --year 2025 --month 1
python scripts/download_era5_wind_archive.py --start-year 2021 --end-year 2025
python scripts/build_era5_wind_climatology.py --input data/era5_monthly_2021_2025
```

The archive downloader resumes by skipping complete monthly files. It requests
all 24 hours and calendar days for five complete years, storing them in
`data/era5_monthly_2021_2025`. Rebuild the JSON only after all monthly requests
finish; the builder reports coverage and checks for a fully hourly timeline.
Review `coverage.complete_hourly_climatology`, `coverage.records`, the time
range, and the source digest before publishing the profile.

## Proposed geometry comparison

Create a proposal JSON with a name, forcing direction, removed building record
indexes, and added building records. Each added record is
`[ground_m, height_m, [[x,z], ...]]` in the viewer's local metre coordinates.
Indexes refer to `public/assets/fallback.json`'s original building order.

```bash
python scripts/build_wind_design_case.py proposal.json
python scripts/build_wind_design_case.py proposal.json --solve --workers 4
```

The first command writes a candidate scene for review. `--solve` exports a new
OpenFOAM case, meshes and solves it, converts the result to browser assets, and
registers the solved proposal in `public/assets/cfd/design-cases.json`. In the
Wind panel, save the baseline, load the proposed design, and compare pedestrian
speed for the same direction. The candidate and baseline use the same solver
and forcing settings; different geometry requires a new mesh and solve.

## WindNinja reference cases

WindNinja is an optional external reference solver and is not silently
substituted for the application's building model. After installing
`WindNinja_cli`, provide a projected regional DEM that covers Table Mountain,
the Cape Flats, Table Bay and the CBD. Generate ERA5-conditioned cases with:

```bash
python scripts/generate_windninja_cases.py \
  --dem /path/to/regional_cape_town_dem.tif \
  --season summer --stability neutral \
  --directions se sse s nw nnw

# Add --run after checking the generated configuration files.
```

The supplied CBD hybrid DEM is too small for a credible regional WindNinja
case. It omits most of the mountain and upstream fetch, so it should only be
used to smoke-test configuration generation.

## Benchmark observations

Use [`wind_observations_template.csv`](wind_observations_template.csv) as the
field log. Replace the example rows; do not treat them as real observations.
Record each sensor's calibration details, averaging window, height, wind
direction, stability assessment and whether the site is for calibration or
holdout evaluation. Use one batch per synchronized averaging window and
forcing scenario. Coordinates use viewer-local metres (`x` east, `z`
south-positive); retain the original survey coordinates and CRS in the field
notes so the transformation can be reproduced.

Start with SE/Cape Doctor, NW, W and SSW flow. At each campaign window, measure
the upstream reference wind and at least three pedestrian locations at the
same time, preferably with fixed sensors. Repeat across unstable, neutral and
stable conditions. Keep holdout sites out of any tuning and do not mix them
into calibration batches. Use the same mean-wind averaging period at reference
and pedestrian sensors; retain gust and direction as separate fields. Obtain
site access and follow the sensor maker's exposure and mounting guidance.

For OpenFOAM scoring, the browser samples the selected converted CFD volume at
terrain elevation plus measured sensor height, using mask-normalized trilinear
interpolation. Since current cases use a steady 10 m/s inlet, the scorer scales
sampled velocity by the simultaneous upstream observed speed divided by case
inlet speed. The input records the upstream sensor height, but the current
uniform inlet has no atmospheric vertical profile and the scorer does not
transform between that height and the pedestrian sensor height. Record the
reference height, preferably use a consistent documented 10 m reference, and
interpret scaled speeds with this profile limitation in mind. The measured
averaging period is retained for review; the steady RANS field does not model
gusts or averaging-period-dependent turbulence. This linear scaling does not
correct stability-dependent flow or turbulence. Metrics include pedestrian
speed bias/MAE/RMSE in m/s and dimensionless speed-up-ratio bias/MAE/RMSE,
reported separately for calibration, holdout and each `split_group`. Direction
MAE is included when pedestrian direction is provided. The response includes
CFD and terrain/supporting-asset hashes, an observation-payload hash,
sample/exclusion counts and per-row residuals. Its
status is `holdout_scored_not_validated`; a score does not promote the model to
validated or engineering-grade use.

After scoring in the Wind panel, export the climate report to retain the
imported CSV/JSON source, per-row predictions and residuals, split metrics,
observation-payload hash and typed reference. Run
`scripts/archive_climate_report.py` while the matching checkout is available;
the archive includes the original input and matching OpenFOAM volume, terrain
DEM and scene manifest when their hashes match. The archive is evidence
preservation, not a solver rerun.

The screening path remains available for legacy comparisons. It uses the
selected stability profile to adjust observation height and does not validate
OpenFOAM.

```json
{
  "scenario": {
    "center_local": [0, 0],
    "size_m": 250,
    "direction_deg": 150,
    "season": "summer",
    "stability": "neutral",
    "reference_speed_mps": 10,
    "reference_height_m": 10,
    "height_m": 2,
    "exceedance_threshold_mps": 6
  },
  "observations": [
    {"id": "A01", "x": -40, "z": -20, "speed_mps": 4.8, "height_m": 2, "observed_at": "2026-01-15T12:00:00+02:00"},
    {"id": "A02", "x": 20, "z": -10, "speed_mps": 6.1, "height_m": 2, "observed_at": "2026-01-15T12:00:00+02:00"},
    {"id": "A03", "x": 35, "z": 45, "speed_mps": 3.9, "height_m": 2, "observed_at": "2026-01-15T12:00:00+02:00"}
  ]
}
```

The response contains bias, MAE, RMSE, point residuals, an inverse-distance
signed error map, and distance to the nearest observation. It remains marked
`benchmark_only_not_validated`; sparse interpolation is a diagnostic, not
evidence of accuracy away from sensors.

## Reference campaign

For each representative sector (start with SE/Cape Doctor, NW, W and SSW),
collect simultaneous forcing and pedestrian observations under unstable,
neutral and stable conditions. Keep calibration sites separate from final
holdout validation sites. Use the field log template above and preserve its
raw rows unchanged alongside any cleaned analysis dataset.

For the OpenFOAM scorer, use a solved 22.5° case direction (for example SE
135°, NW 315°, W 270° or SSW 202.5°) and assign the concurrent reference
observations to that case. Cape Doctor 150° has no exact solved case; solve a
150° case or leave those rows out of direct case scoring when they exceed the
explicit 11.25° direction tolerance. Keep at least one complete site or
measurement period out of calibration. Do not split simultaneous measurements
from one sensor window between calibration and holdout.

Benchmark the same geometry and boundary conditions against:

1. canonical flat terrain and isolated-building cases;
2. the regional terrain in WindNinja or an equivalent terrain-flow solver;
3. building-resolved RANS/LES cases in OpenFOAM at pedestrian height;
4. fixed anemometers and repeated pedestrian transects in the CBD.

Use a versioned case manifest containing geometry hash, solver and mesh
versions, inlet profile, roughness, stability, run period, measurement source,
coordinate reference system and excluded observations.

## Promotion to validated mode

Validated mode should be unlocked per direction, stability class, height and
geographic coverage—not globally. Before promotion, define project-specific
acceptance gates for hold-out speed bias/MAE/RMSE, direction error, spatial
coverage and comfort-category agreement. The API currently advertises only
`available_modes: ["preview"]`; this is intentional until those datasets and
gates exist.
