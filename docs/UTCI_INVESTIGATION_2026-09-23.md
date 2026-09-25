# UTCI discrepancy, 23 September 2026

## Reproduced evidence

The saved 14:00 SAST frame (`thermal_20260923T120033Z`, frame
`20260923T1200Z`) contains mean UTCI **27.87°C**, peak **31.6°C**.
It uses forecast air temperature **21.2°C**, humidity **76%**, wind
**3.31 m/s**, global horizontal radiation **595 W/m²**, horizontal direct
radiation **293 W/m²**, and diffuse radiation **302 W/m²**.

The user's Google weather panel for Wednesday 14:00 reports **16°C**, **88%**
humidity, **11 km/h** wind and cloudy conditions. Its exact location/source
station is not supplied in the copied panel. The weather providers disagree;
the model was not calculating comfort from 16°C air.

Live checks at approximately 14:12 SAST found CBD forecasts for 14:00 of
19.9°C (ICON), 21.2°C (ECMWF), and 21.6°C (GFS). Open-Meteo best-match current
conditions gave 20.2°C. Switching to best match therefore does not resolve
this discrepancy. FACT airport reported 19°C at 13:00 SAST; it is about 17 km
away and is not a CBD temperature measurement.

Latest satellite radiation ended at 13:00 SAST, one hour before the selected
frame: global 586.3, direct horizontal 90.3, diffuse 496.0 W/m². Those data do
not validate the selected hour's much stronger direct beam. Conversely, a
cloudy sky does not by itself imply zero or very low total solar radiation;
cloud fraction does not specify optical thickness.

## Confirmed defects and fixes

- The map originally rescaled each frame to its own 10th–90th percentiles.
  Forecast maps retain the temperature-aware adaptive scale, with more shades
  within its blue, green, yellow, orange and red groups. Historical maps use
  their shared scale for seasonal comparison. Forecast map rendering averages
  source samples, blends adjacent cells, and fills masked display cells for
  continuity; point values and summaries still use calculated cells only.
- The legend could call forecast radiation satellite radiation because the
  *run* contained satellite data for earlier hours. Radiation attribution
  now uses the selected frame's provenance, including older field names.
  Missing current-hour satellite data generates an explicit warning.
- The adapter passed Open-Meteo direct **horizontal** radiation to SOLWEIG's
  direct **normal** beam input. It now converts using SOLWEIG's own solar
  elevation at the midpoint of the preceding hour and handles nighttime
  without division by zero. This fixes a physical inconsistency; it does
  **not** explain the warm bias and can increase sun-exposed estimates.
- Forecast air temperature and lack of assimilated local temperature
  observations now appear prominently above the results. The status no
  longer describes these values as observed/current weather.
- Existing fallback-provider warnings are retained when adding quality checks.

## What remains unresolved

These fixes do not establish the true CBD temperature or calibrate the model.
The live model still depends on forecasts that are warmer than the supplied
Google reading. No temperature offset, cloud attenuation factor, or target
UTCI was fitted to that reading. Google apparent temperature and UTCI are
also different indices, so exact numerical agreement is not a validation test.

As a sensitivity check only, replacing air temperature/humidity with 16°C/88%
while retaining the archived radiant temperature and wind gives mean UTCI
25.04°C and peak 29.3°C. This is **not** a corrected forecast: surface/radiant
temperatures would need to be rerun with verified weather inputs. It shows
why correcting air temperature alone cannot establish accuracy.

Next evidence needed: the precise location/provider behind the Google reading
and time-aligned CBD air temperature and radiation observations. Use the
existing [field validation procedure](THERMAL_VALIDATION.md) for measured
comparisons. Do not replace CBD forcing with an airport reading or carry a
previous hour's satellite values forward as though they were current observations.

## Source contracts

- [Open-Meteo radiation definitions](https://open-meteo.com/en/docs/satellite-radiation-api):
  hourly direct radiation is horizontal, averaged over the preceding hour.
- [SOLWEIG radiation equations](https://umep-dev.github.io/solweig/physics/radiation/):
  direct beam is multiplied by sine of solar altitude to obtain horizontal radiation.

## Rebuild and continued refresh

The 14:16 SAST publication (`thermal_20260923T121504Z`) used newly available
14:00 satellite radiation: **314.5 W/m² global, 0 direct, 314.5 diffuse**.
With the same 21.2°C forecast air input, mean/peak UTCI became **25.68/28.3°C**.
This confirms a substantial radiation forecast error in the original frame.
It does not resolve the 5.2°C air-temperature difference.

The worker now refreshes on the hour and again at 15 minutes past **every**
hour. Previously the follow-up happened only once after startup and subsequent
runs drifted to that offset. Satellite delivery is not guaranteed at the
refresh time; missing data remains explicitly labelled as forecast.

Google Weather is an optional comparison source, not a prerequisite for these
fixes. Its API combines observations and models; Google does not identify its
current conditions as direct station observations everywhere. The documented
hourly response lacks the direct/diffuse solar radiation required by SOLWEIG,
so satellite radiation would still be needed. Compare the same CBD coordinates
and hour before adopting another provider. See the
[Google Weather FAQ](https://developers.google.com/maps/documentation/weather/faq)
and [hourly fields](https://developers.google.com/maps/documentation/weather/reference/rest/v1/forecast.hours/lookup).
