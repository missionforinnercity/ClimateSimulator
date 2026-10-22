# Focused CBD mean radiant temperature campaign

## Decision this campaign tests

Test whether the experimental hourly pedestrian mean radiant temperature
(Tmrt) map reproduces the size and timing of sun, building-shade and tree-shade
differences in central Cape Town. Tmrt is the **one primary variable** for site
selection and the first analysis. Air temperature and wind are recorded as
supporting inputs, not substitutes for a Tmrt observation. This is a measurement
plan; no equipment has been installed and no CBD Tmrt observations are in the
repository.

## Candidate shortlist

The coordinates below are **OpenStreetMap wayfinding label points** in
`data/osm_cbd_wayfinding.geojson`, not approved sensor positions. Their source
capture date and point accuracy are not recorded in that derived file. OSM data
is subject to the Open Database License. A field visit must locate the actual
public-space position, check it against the model footprint, record its local
`x,z` coordinates and obtain permission before installation.

The provisional score is a **planning judgement**, not observed Tmrt error or
footfall. Each criterion scores 0–2: distinct street-condition coverage,
diagnostic priority for a plausible model disagreement, likely public use, and
apparent ease of mounting without obstruction. A higher number is a reason to
inspect a candidate first. Unknown mounting permission limits every mounting
score to at most 1. No site-specific model residuals exist yet; the disagreement
score expresses a testable hypothesis and must be replaced after model-frame
extraction and field measurements.

| Provisional rank | Candidate and label point (lon, lat) | Planning scores: condition / disagreement / use / mounting (total) | Street condition and test | Public use and mounting screen | Model disagreement to test |
| --- | --- | --- | --- | --- | --- |
| 1 | Grand Parade (18.424429, −33.924773) | 2 / 2 / 2 / 1 (**7**) | Open paved space; test midday solar load and the onset of building shade. | Public square; look for a secure, unobstructed position with permission and no event conflict. Use a freestanding, guarded rig only if allowed. | The 23 September 2026 radiation audit found large model-versus-satellite differences for one hour; test whether these produce a Tmrt bias in an open setting. No site-specific disagreement has yet been measured. |
| 2 | Saint George's Mall, near Shortmarket Street (18.420984, −33.922981) | 2 / 2 / 2 / 0 (**6**) | Pedestrian street canyon; test the timing of façade shade and reflected radiation. | Public pedestrian route; avoid blocking circulation, vendors and shop access. Check whether a permitted mount sees the relevant sky and façades. | Compare model shade transition time and measured Tmrt. The likely local error is a hypothesis, not an existing residual. |
| 3 | Company's Garden (18.416900, −33.927825) | 2 / 2 / 1 / 0 (**5**) | Tree-shaded pedestrian setting; test canopy transmission and patchy shade. | Public garden; check opening hours, irrigation, vegetation protection and mounting permission. | Compare under-canopy Tmrt with the mapped-canopy model; LiDAR outlines do not measure seasonal leaf transmission. |
| Hold-out | Church Square (18.421400, −33.925063) | Reserved, unscored | Separate paved square with adjacent building shade; test whether conclusions transfer. | Public space; verify safe unattended mounting, power or battery access, and event schedules. | Reserve this site, or a separate full observation period, from all model tuning and site selection based on residuals. |

The order favours three different radiation environments and commonly used
public places. Actual footfall, current access, sensor security, power, permits
and site-specific model error are **unknown**. Before ordering equipment or
finalising positions, walk all four sites and record those constraints. Then
extract the same candidate hours from a versioned model run and rank measured
model disagreement separately from the access screen. Replace this provisional
order if the field and model checks change it; do not call it an empirical
hotspot ranking.

## Measurement and analysis protocol

1. Record the surveyed sensor position, height, nearby obstructions, surface,
   canopy cover, permissions, instrument ID, calibration, accuracy and the
   model run ID. Photograph the horizon and shade at each position. Retain
   rejected candidate positions and the reason for rejection.
2. Measure Tmrt with a calibrated radiometer if available. For a globe
   thermometer, record globe diameter, emissivity, aspiration/shielding and
   co-located wind, then name the validated conversion method. Record
   shielded air temperature and wind as supporting inputs. Follow the
   instrument manufacturer's calibration and siting requirements.
3. Observe the three primary sites at the same time over multiple clear and
   cloudy days, including before, during and after expected shade transitions.
   Log local clock time and UTC offset, averaging interval, wet surfaces,
   temporary shade, activity around the instrument and failures. Do not move
   an instrument during an averaging interval.
4. Match each observation to the nearest retained hourly model frame within
   15 minutes, with no time interpolation. Archive the raw observations and
   model arrays before the worker prunes old runs. Analyse Tmrt residual
   (model minus measured), bias, MAE and RMSE by site, sun/shade state and
   time of day, with sample counts and excluded intervals. Plot the transition
   timing separately from average error. Use the workflow in
   [THERMAL_VALIDATION.md](THERMAL_VALIDATION.md) and its observation CSV
   template; its script can also report UTCI, but Tmrt remains this study's
   primary outcome.
5. Keep Church Square, or a predeclared separate period, untouched until
   choices and corrections are frozen. Repeat the residual analysis there.
   Report the hold-out result and uncertainty even if it performs poorly.

The initial visit is a siting check, not validation. Instrument deployment,
calibration checks, permissions and before/after intervention studies require
real equipment and observations. Do not infer personal heat exposure or a
validated UTCI product from this shortlist.
