# Wind validation and comfort workflow

## What the application reports now

Every `/api/wind/preview` response reports a field at the requested height
(2 m by default), the atmospheric stability assumption, conditional
exceedance probability, a five-percent-exceedance comfort class, and lower /
upper screening speeds. The interval represents model-form and height-profile
uncertainty; it is not a statistical confidence interval.

The selected forcing speed is treated as the conditional mean speed for the
selected direction. A Weibull distribution estimates the fraction of that
sector's hours above the selected threshold. It is not multiplied by an
annual or seasonal sector occurrence until a Cape Town climatology is
installed.

## ERA5 Cape Town forcing

`data/Era5data.grib` has been converted into
`data/wind_climatology/cape_town_era5.json`. It contains 4,901 sampled times
from 2025-01-01 through 2026-07-31 and includes 10 m/100 m wind, neutral wind,
and two gust products. The application uses it to select a conditional mean
speed, fitted Weibull shape, gust factor, sector occurrence, and observed
10–100 m shear exponent for each season, direction and stability group.

The archive contains only 11 UTC hours and 35.4% of the possible hourly
records. Frequencies therefore remain provisional. The `ERA5API` value in
`.env` is consumed without being logged by the monthly downloader:

```bash
python scripts/download_era5_wind.py --year 2025 --month 1
python scripts/build_era5_wind_climatology.py --input data/era5_monthly
```

Use all 24 hours and all calendar days for a final wind rose. For a defensible
climatology, extend the archive to at least ten years rather than tuning only
to 2025–26.

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

Send at least three co-located measurements to `POST /api/wind/validate`.
Coordinates use viewer-local metres (`x` east, `z` south-positive). Speeds at
other sensor heights are converted to the scenario result height with the
selected stability profile.

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
neutral and stable conditions. Record sensor model, calibration, averaging
period, height, coordinates, timestamp, mean speed, gust speed and direction.
Keep calibration sites separate from final hold-out validation sites.

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
