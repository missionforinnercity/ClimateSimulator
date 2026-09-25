# UTCI field validation

## Current status

The hourly UTCI/Tmrt product is an experimental model estimate. No CBD field
observations have been supplied yet, so this workflow can calculate paired
residuals but cannot establish accuracy or promote the product to validated
status. A successful script run with a small sample is diagnostic evidence only.

## Observation campaign

Start with three simultaneous sites selected to span distinct street settings:

1. an open, sun-exposed paved space;
2. a shaded street canyon;
3. a tree-shaded pedestrian space.

Record viewer-local `x,z` coordinates (metres; `z` is south-positive) for the
sensor location, sensor IDs and calibration, timestamp with timezone, averaging
period, air temperature at 2 m, relative humidity, mean radiant temperature,
and wind at 10 m. Use co-located instruments and align each averaged sample to
within 15 minutes of a model frame. Keep the actual measurement time and
averaging window in field notes. Do not substitute the 1.5 m pedestrian-wind
channel for the UTCI 10 m wind input.

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

Copy [`thermal_observations_template.csv`](thermal_observations_template.csv)
and add one row per site and time. The required fields are:

- `id`, `observed_at` (ISO 8601 with timezone), `x`, `z`;
- `air_temp_2m_c`, `relative_humidity_pct`, measured `tmrt_c`;
- `wind_10m_mps`.

Keep `site_name`, `sensor_ids`, `averaging_period_s` and `measurement_notes`
filled in for traceability. Do not put longitude/latitude in `x,z`; these are
the viewer's local projected coordinates.

Run the comparison soon after the observation while its thermal run is still
retained by the worker (currently the latest three runs):

```bash
.venv/bin/python scripts/validate_thermal_observations.py /path/to/thermal_observations.csv
```

To compare against a specific retained run, pass `--run-id thermal_...`.
The script pairs each observation to the nearest published hourly frame, with
no temporal interpolation, and rejects samples more than 15 minutes away by
default. UTCI reference values are calculated from the *measured* air
temperature, humidity, Tmrt and 10 m wind using the same UTCI implementation
as the model. Measurements outside the standard UTCI input range are excluded
rather than silently clipped.

The JSON report gives point-by-point model and measured inputs, residuals, and
bias / MAE / RMSE for air temperature, humidity, Tmrt, 10 m wind and UTCI.
Residual sign is model minus observed. Preserve the JSON output alongside the
run ID, sensor calibration notes and original field file. The model run must
contain `wind_10m_mps`; older runs predate that channel and cannot be used by
this comparison. The thermal worker must publish a new run after it is updated.

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

The worker now publishes immediately, then refreshes once after 25 minutes
before continuing its hourly cadence. That second run lets the current-hour
satellite estimate arrive without hiding the first forecast during startup.
While the heat forecast is open, the browser checks for a newer run every two
minutes and reloads it when one is published. If satellite input is still
unavailable, the model-radiation provenance remains visible and no arbitrary
radiation correction is applied.
