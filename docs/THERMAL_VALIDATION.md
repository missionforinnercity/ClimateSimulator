# UTCI field validation

## Current status

The hourly UTCI/Tmrt product is an experimental model estimate. No CBD field
observations have been supplied yet, so this workflow can calculate paired
residuals but cannot establish accuracy or promote the product to validated
status. A successful script run with a small sample is diagnostic evidence only.

## Observation campaign

For an initial **Tmrt-focused** CBD campaign, use the ranked candidate
shortlist and siting checks in
[TMRT_MEASUREMENT_CAMPAIGN.md](TMRT_MEASUREMENT_CAMPAIGN.md).

Start with three simultaneous sites selected to span distinct street settings:

1. an open, sun-exposed paved space;
2. a shaded street canyon;
3. a tree-shaded pedestrian space.

Record viewer-local `x,z` coordinates (metres; `z` is south-positive) for the
sensor location, sensor IDs and calibration, timestamp with timezone, averaging
period, air temperature at 2 m, relative humidity, mean radiant temperature,
and wind at 10 m. Treat `observed_at` as the midpoint of the averaging window;
also retain the actual start/end times in field notes. Use co-located
instruments and align each sample midpoint to within 15 minutes of a model
frame. Do not substitute the 1.5 m pedestrian-wind channel for the UTCI 10 m
wind input.

For one synchronized dataset that can feed both the wind and thermal
comparisons, use
[`cbd_validation_campaign_template.csv`](cbd_validation_campaign_template.csv).
Its `speed_mps`/`height_m` fields are pedestrian-wind observations and its
`reference_speed_mps`/`reference_direction_deg` fields are the simultaneous
upstream reference; these are separate from `wind_10m_mps`, which is the wind
input to UTCI. Give every calibration and holdout unit a shared `split` and
`split_group` assignment; all rows in a site or period must stay in that group.
Keep holdout units untouched during tuning. Retain the
per-channel sensor IDs, calibration certificates, survey
coordinates and full instrument log alongside the CSV.

Measure Tmrt with a calibrated radiometer where available. If using a globe
thermometer, retain globe diameter, emissivity, shield/aspiration details and
wind data, and document the validated method used to derive Tmrt. Measure air
temperature in a radiation-shielded, ventilated position. Keep one site or
measurement period aside as a hold-out set; do not tune and assess on the same
observations.

Sample each site across sun and shade transitions and more than one day. Three
locations on one overcast afternoon are a useful pipeline check, not a
representative accuracy study. Avoid moving sensors during an averaging
period. Log obstructions, temporary shade, wet surfaces and instrument
malfunctions.

## Prepare and run a comparison

Use [`cbd_validation_campaign_template.csv`](cbd_validation_campaign_template.csv)
for a combined campaign, or copy
[`thermal_observations_template.csv`](thermal_observations_template.csv) for
thermal-only analysis. Add one row per site and synchronized time window. The
required thermal fields are:

- `id`, `observed_at` (ISO 8601 with timezone), `x`, `z`;
- `air_temp_2m_c`, `relative_humidity_pct`, measured `tmrt_c`;
- `wind_10m_mps`, positive `averaging_period_s`, `split`, and `split_group`
  identifying the complete site or period evaluation unit.

Keep `site_name`, `sensor_ids`, `sensor_calibration`, and `measurement_notes`
for traceability. Use
`split=calibration` for observations available during diagnosis/tuning and
`split=holdout` for an untouched site or period. Prefer holding out a whole
site or complete set of days, not random rows from one sensor time series.
Give every row in that unit the same `split_group`; the comparison rejects a
group accidentally assigned to both splits and reports metrics by group. Do
not put longitude/latitude in `x,z`; these are the viewer's local projected
coordinates.

Run the comparison soon after the observation while its thermal run is still
retained by the worker (currently the latest three runs):

```bash
.venv/bin/python scripts/validate_thermal_observations.py /path/to/thermal_observations.csv
```

Add `--output /path/to/thermal-validation.json` to save the machine-readable
result. In Heat → **Attach thermal validation to report**, select that JSON
and the exact original CSV; the browser verifies the CSV SHA-256 before
embedding paired rows and holdout metrics in the next HTML report.
Archive the exported report while the referenced thermal run is retained:
`scripts/archive_climate_report.py conditions-climate-report.html`. The archive includes the
original observation bytes, run manifest and every paired frame whose hash
still matches. This preserves evidence; it does not rerun the model.

To compare against a specific retained run, pass `--run-id thermal_...`.
The script pairs each observation to the nearest published hourly frame, with
no temporal interpolation, and rejects samples more than 15 minutes away by
default. UTCI reference values are calculated from the *measured* air
temperature, humidity, Tmrt and 10 m wind using the same UTCI implementation
as the model. Measurements outside the standard UTCI input range are excluded
rather than silently clipped.

The comparison basis differs by variable: air temperature and humidity are
compared with the run's spatially uniform weather forcing values, not with
spatial SUEWS air-temperature or humidity outputs. Tmrt is sampled from the
spatial SOLWEIG raster; 10 m wind is sampled from the OpenFOAM directional
atlas scaled by 10 m weather forcing; UTCI is sampled from its spatial raster
and compared with UTCI recalculated from measured inputs. The SUEWS T2/RH2
energy-balance product is not independently scored by this workflow.

The JSON report gives point-by-point model and measured inputs, residuals, and
bias / MAE / RMSE for air temperature, humidity, Tmrt, 10 m wind and UTCI. It
reports all paired rows, calibration rows and holdout rows separately, with
holdout summaries grouped by site and explicit split group. Residual sign is
model minus observed. A
`holdout_scored_not_validated` status means holdout rows were scored; it is not
a quality threshold or validation claim. Preserve the JSON output alongside
the run ID, sensor calibration notes and original field file. Provenance
records the observation-file hash, manifest hash, frame hashes, model versions
and UTCI package version. New thermal-run manifests also identify the worker
source, thermal container configuration and model dependency lock by SHA-256;
older runs may not have those fields. Paired rows retain sensor identifiers and any
calibration notes supplied. The model run must
contain `wind_10m_mps`; older runs predate that channel and cannot be used by
this comparison. The thermal worker must publish a new run after it is updated.

The Heat panel's comfort KPIs use the standard UTCI categories: cold stress
below 9°C, no thermal stress from 9°C to below 26°C, and heat stress at or
above 26°C. Those categories describe modelled UTCI values; they do not replace
the numeric UTCI map or establish health outcomes. Historical area-time KPIs
are explicitly composite estimates and are not counted observed hours. See
[the climatology limits and KPI method](THERMAL_CLIMATOLOGY.md).

## Interpreting results

Review component errors before changing the UTCI calculation. Large Tmrt error
points to radiation, geometry or surface inputs; large wind error points to
the forcing or CFD wind field; large air-temperature/humidity error points to
the weather forcing. UTCI residuals combine those effects. Report sample
count, excluded rows, time offsets, sites and weather conditions with every
metric. Do not claim validation from the in-sample fit; repeat on hold-out
locations and times before changing the model or its validation label.

The worker retains only three complete runs to limit storage. During an
initial campaign, run the comparison as measurements are collected and archive
the JSON report. Longer historical campaigns will need a separate compact
observation-time archive policy before old model frames are pruned.

## No-fieldwork forcing checks

### SENSOTO Molteno Reservoir station cross-check

SENSOTO's NOAA ISD device `688190-99999` resolves to Molteno Reservoir
(18.417°E, 33.933°S). The live metadata exposes hourly mean air temperature,
wind speed and wind direction, but no relative humidity, radiation, Tmrt,
sensor elevation, sensor height or station-exposure assessment. A fresh API query on 2026-10-27 found no non-null hourly values for any of the
three sensors from 2025-08-25 through 2026-10-26; the last returned observation
was 2025-08-24 21:00 UTC. Treat this as delayed historical data, not live CBD
weather. Its point is 313.9 m outside the mapped
scene footprint. A [WMO station list](https://www.rnd.tmd.go.th/imo/doc/8.%20wmo_9-2012-A.pdf)
lists Molteno Reservoir's site elevation as 97 m; this does not establish the
measurement-instrument height or current exposure.

The SENSOTO comparison script downloads exact-hour station observations and
matches them to ERA5 at the requested station coordinates without temporal
interpolation. ERA5 resolves those coordinates to a 0.25° grid point 21.7 km
away. For 2021-01-01 through 2025-08-24, the station supplies 13,413 observed
hours out of 40,728 possible (32.9%). ERA5-minus-station errors are:

| Variable | n | Bias | MAE | RMSE |
| --- | ---: | ---: | ---: | ---: |
| Air temperature | 13,384 | −1.12°C | 2.07°C | 2.77°C |
| Wind speed | 13,385 | +2.22 m/s | 2.34 m/s | 2.80 m/s |
| Wind direction | 11,067 | — | 55.1° circular MAE | — |

Direction errors omit observations below 1 m/s. ERA5 assimilates surface
observations and its coarse grid is spatially distant, so this is a regional
forcing consistency check, not independent forecast validation or CBD street
validation. Do not apply these aggregate residuals as correction factors.
Humidity, radiation, Tmrt and UTCI still require other references or local
instrumentation. The complete paired rows, coverage metadata and residuals are
preserved in [`evidence/sensoto-noaa-isd-688190-2021-2025.json.gz`](evidence/sensoto-noaa-isd-688190-2021-2025.json.gz).

To reproduce the report, set `SENSOTO_API_TOKEN` in the ignored local `.env`
file, then run:

```bash
.venv/bin/python scripts/backtest_sensoto_station.py \
  --start 2021-01-01 --end 2025-08-24 \
  --output /tmp/sensoto-molteno-era5-backtest.json
```

The report uses public [NOAA ISD](https://www.ncei.noaa.gov/products/land-based-station/integrated-surface-database)
observations delivered through SENSOTO. It records token-free source
metadata, station and reanalysis coordinates, pairing rules, missing-hour
coverage, per-row values and residuals. It does not send this station data to
the runtime weather feed.

When CBD instruments are unavailable, run the 30-day forcing backtest:

```bash
.venv/bin/python scripts/backtest_thermal_forcing.py --days 30 \
  --output /tmp/thermal-forcing-backtest.json
```

It compares archived hourly forecast inputs with FACT METAR observations,
forecast radiation with EUMETSAT-derived satellite radiation, and forecast
weather with ERA5 reanalysis. It also checks non-negative radiation and
shortwave closure (`global ≈ direct + diffuse`). The METAR station is an
airport proxy; ERA5 is a model-assimilation product; satellite radiation is a
retrieval estimate. None validate pedestrian-level CBD UTCI or Tmrt.

The first 30-day run on 23 September 2026 produced these diagnostics:

| Comparison | Sample | Result |
| --- | ---: | --- |
| Forecast temperature vs FACT METAR | 332 hours | bias +0.08°C; MAE 1.31°C |
| Forecast wind speed vs FACT METAR | 332 hours | bias −1.69 m/s; MAE 2.12 m/s |
| Forecast wind direction vs FACT METAR | 317 hours | mean absolute angular error 36.6° |
| Forecast relative humidity vs FACT METAR | 332 hours | bias +5.33 percentage points; MAE 8.51 points |
| Forecast global radiation vs satellite estimate | 709 hours | bias −5.78 W/m²; MAE 19.21 W/m² |
| Forecast temperature vs ERA5 | 600 values | bias +0.49°C; MAE 1.32°C |

The selected 23 September 2026 12:00 SAST screenshot hour is a notable
radiation-partition outlier: the archived forecast was 118 W/m² higher in
global radiation, 332 W/m² higher in direct radiation, and 213 W/m² lower in
diffuse radiation than the satellite estimate for that hour. Total radiation
alone would obscure this difference, which matters to SOLWEIG's Tmrt
calculation. At the time the screenshot run was generated, the exact-hour
satellite value had not arrived, so that frame used forecast radiation.

## Live forcing safeguards

The thermal worker now uses the median of the ECMWF IFS, ICON and GFS grid
forecasts for air temperature, humidity, wind, cloud and the other forecast
variables. It retains each available model's low/high range in the forcing
record. This is a deterministic multi-model consensus, not a probability
interval; its skill still needs a separate holdout evaluation. Model radiation
components are kept physically closed, and delayed EUMETSAT satellite
radiation replaces the model components for completed hours when available.

FACT airport air temperature is excluded from the thermal runtime and the
current-weather endpoint. FACT is too far from the CBD to stand in for its
street-level air temperature. Its wind is shown only as a remote proxy check;
it is never substituted into the CBD field. The interface flags a wide spread
between forecast models and a large difference from the FACT wind proxy, so a
single UTCI value is accompanied by its weather-input disagreement.
These safeguards expose uncertainty; they do not validate the CBD temperature
or guarantee street-level UTCI accuracy.

For the 23 September 2026 13:00 SAST follow-up, the three-model median was
20.8°C (model range 19.6–22.2°C); median 10 m wind was 2.24 m/s (range
0.98–2.62 m/s). Satellite GHI was 586 W/m², while the forecast-model GHI
range was 432–735 W/m². The resulting map mean UTCI was 28.4°C. This still
does not agree with the user's reported 16°C CBD air temperature. It is a
documented limitation, not a successful correction: without a current local
observation, the multi-model median cannot establish which value is right.
The interface now flags the 2.6°C air-temperature spread, 1.6 m/s wind
spread, and 303 W/m² radiation spread for that hour, and FACT air temperature
is excluded from runtime data entirely.

The user then reported Google Weather at 16°C with a 15°C feels-like value for
the same cold, overcast CBD conditions. Open-Meteo's separate current model
feed returned 20.1°C; the thermal multi-model median was 20.8°C. Re-evaluating
the existing raster with air temperature changed to 16°C, while keeping its
modeled Tmrt and wind fixed, reduced mean UTCI from 28.4°C to 25.5°C. That
sensitivity check shows that the air-temperature disagreement explains only
part of the result; the modelled radiant load and pedestrian wind also need
local validation. Google "feels like" is not the UTCI definition, so the two
values are not treated as interchangeable observations. Frames with flagged
input disagreement now label their UTCI category low confidence.

This points to a targeted operational improvement: make the exact-hour
satellite value available before publishing the final current-hour thermal
frame, or clearly retain the model-radiation provenance when it is unavailable.
It does **not** justify a global radiation multiplier. The 30-day total
radiation errors are small on average, and the FACT wind/temperature biases
must not be transferred to the CBD because the airport is a different
microclimate. The 30-day radiation components also passed the closure check;
that confirms arithmetic consistency, not physical accuracy.

Re-run this report before considering any bias correction. Keep the raw JSON
with its period and software version. Any calibration must be evaluated on a
separate time window and must not use the same samples that selected its
correction.

The worker publishes immediately, then waits one hour after each run attempt.
This limits the full SUEWS/SOLWEIG calculation to an hourly cadence while
keeping the newest available satellite radiation estimate at each run.
While the heat forecast is open, the browser checks for a newer run every two
minutes and reloads it when one is published. If satellite input is still
unavailable, the model-radiation provenance remains visible and no arbitrary
radiation correction is applied.
