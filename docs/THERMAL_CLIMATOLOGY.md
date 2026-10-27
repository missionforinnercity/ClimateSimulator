# Historical UTCI climate profile

The Heat tool offers a **Historical climate profile** alongside its near-live
forecast. The profile compares four Cape Town seasons, all twelve months,
and local time through the day. Selecting a profile bar changes the month/hour
map. Map colours share one UTCI temperature range across every profile slice.

## Build the product

Build on a model workstation with the thermal Python dependencies, prepared
SOLWEIG surfaces, and all sixteen pedestrian-wind atlas sectors available:

```bash
.venv/bin/python scripts/build_thermal_climatology.py \
  --start-year 2016 --end-year 2025
```

The script retrieves hourly ERA5 reanalysis through the
[Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api),
averages meteorology by month and South African local hour, then
runs SOLWEIG and UTCI for the 15th of each month. It writes 288 two-channel
Tmrt/UTCI map frames at 8 m resolution under `data/thermal/climatology/`.
The climate product is generated output and is ignored by Git.

Copy the generated `data/thermal/climatology/` directory to the same path on
the application host before starting the release. Compose mounts that prepared
directory read-only into the API container, so the VM does not have to fetch
the historical archive or run the spatial model. The normal near-live worker
continues to use its separate writable thermal-products volume.

## Interpretation

The historical inputs are ERA5 grid-cell reanalysis, about 25 km resolution.
SOLWEIG resolves local geometry, shade and surface response; the wind atlas
supplies local pedestrian wind variation. Air temperature, humidity and the
other weather inputs are composite city-scale conditions, not street-level
observations.

The product averages weather inputs first and then models each composite hour.
It is a representative climate comparison, not a reconstruction of hourly
observations, a typical individual day, or a forecast. UTCI is nonlinear, so
the result is not equal to the mean of UTCI values from every historical hour.
The output remains an experimental, unvalidated model estimate until it has
been compared with co-located CBD observations; see
[the field validation procedure](THERMAL_VALIDATION.md).

## Thermal comfort area-time KPIs

In the historical UTCI view, the KPI panel classifies each valid ground cell
in every monthly/local-hour composite using these UTCI bands: cold stress
below 9°C, no thermal stress from 9°C to below 26°C, and heat stress from
26°C upward. It weights each local-hour composite by the average number of
calendar days in that month over the baseline and reports the area-time share
and representative-period equivalent hours per mapped cell. The selected
month, season or annual period controls the summary; the displayed map remains
the selected local-hour view.

These are **composite area-time estimates**, not measured historical hours,
hour-by-hour exceedance probabilities, or person-level exposure. Classifying
the mean condition for a month/hour cannot recover the distribution of actual
historical UTCI values. The near-live forecast reports spatial area by UTCI
band for its selected modelled hour only, rather than extrapolating one frame
into a time-period KPI. The underlying UTCI map and temperatures remain
available for inspection; the bands do not replace the physical values.
