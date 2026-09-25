# Thermal radiation audit, 23 September 2026

## Results

Three single-hour SOLWEIG runs used the same air state (19.6°C, 80% RH),
wind, CFD sector, geometry, and archived 14:00 satellite radiation. The old
surface-material raster and corrected raster produce almost identical
pedestrian results. This rules out the discovered cover-code mismatch as a
large UTCI hot bias. It still needed correction because SOLWEIG was treating
project grass and water codes as undefined paved ground, and canopy code as
bare soil instead of ground beneath the canopy.

| Run | Radiation at 14:00 | Mean pedestrian UTCI | P90 | Mean Tmrt |
| --- | ---: | ---: | ---: | ---: |
| Old material codes, ground cells only | 314.5 W/m² | 23.67°C | 25.8°C | 29.48°C |
| Corrected material codes, ground cells only | 314.5 W/m² | 23.63°C | 25.7°C | 29.35°C |
| Old output, including roofs in the area mean | 314.5 W/m² | 24.73°C | 26.8°C | 29.48°C |

The last row demonstrates that including 232,842 roof cells raised the reported
mean by about 1.06°C in this frame. New pedestrian summaries exclude building
pixels. The old surface raster was also using the wrong material class for
some vegetation and water pixels, so the corrected raster is now in use.

The satellite endpoint returns native 10-minute samples for Cape Town. At
14:50 SAST it reported **37 W/m²** global radiation (0 direct, 37 diffuse),
compared with **314.5 W/m²** for the preceding hourly satellite average used
at 14:00. With corrected surface codes and unchanged 19.6°C air, the
14:50 sample gives **20.35°C mean / 21.2°C P90 UTCI**, versus
**23.63°C / 25.7°C** at 14:00. This change includes the different timestamp
and solar position as well as the cloud change; it is not an isolated
radiation-only experiment. The strongest evidence is that the incoming
satellite estimate fell from 314.5 to 37 W/m² within the hour. The hourly mean
was too slow to represent the clearing or thickening cloud at that later time.

For the corrected 14:00 run, mean downwelling shortwave was 166 W/m²,
reflected shortwave 34 W/m², downwelling longwave 400 W/m², and upwelling
longwave 423 W/m². Mean Tmrt was 29.35°C while air was 19.6°C. Recomputing
UTCI with Tmrt set to air temperature reduced mean UTCI from 23.63°C to
20.59°C, a 3.04°C radiant contribution in that diagnostic. This bundles
shortwave and longwave, geometry and shadows; it does not determine which
individual contribution is biased. It is a model counterfactual, not a field
measurement.

## Changes

- Translate project ground-cover classes into SOLWEIG/UMEP codes: paved 1,
  buildings 2, grass 5, water 7, bare soil 6, and nodata 255. Keep tree canopy
  in the separate CDSM and retain the actual grass/pavement below it.
- Fail the thermal worker if the surface grid has not been rebuilt with this
  material convention. Keep the independent SUEWS surface classes unchanged.
- Exclude roofs from pedestrian UTCI summaries and raster values.
- Request native satellite radiation, keep its exact interval-ending time and
  average length, and use it for a separate current-hour snapshot. Keep the
  air and wind forecast time explicit in that frame.
- Refresh at least ten minutes after each completed model run, and expose radiation source, interval, age,
  horizontal flux means, Tmrt, and the radiation counterfactual in diagnostics.

The native 10-minute sample is still a satellite retrieval, not an instrument
on the CBD ground. SOLWEIG's horizontal flux outputs are not the complete
six-direction human radiation balance. The Tmrt-equals-air counterfactual
measures combined radiant influence, not shortwave bias in isolation. A
co-located radiometer/globe and shielded air-temperature measurement remains
the way to establish model accuracy; see
[the field validation procedure](THERMAL_VALIDATION.md).

Source definitions: [Open-Meteo satellite radiation API](https://open-meteo.com/en/docs/satellite-radiation-api), [SOLWEIG radiation equations](https://umep-dev.github.io/solweig/physics/radiation/).
