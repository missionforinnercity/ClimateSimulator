# Traffic emissions and pollutant dispersal screening

## Citywide traffic mode

The Wind panel's **Pollutant dispersal** lens defaults to a whole-CBD road
traffic scenario. The API starts one bounded SUMO run for a selected weekday
profile (AM peak, midday, PM peak or evening), applies a short warm-up, then
samples ten minutes of road activity. The run uses the existing synthetic
car, minibus-taxi, delivery-van and shuttle fleet and SUMO's HBEFA3 tailpipe
estimates. Each monitored edge accumulates its own NOx, exhaust PMx and CO2
emissions; the browser joins these values to the road geometry.

The **Road emissions** layer colours road links by relative modelled tailpipe
NOx per road length and lists the streets with the highest total. Inspecting a
map cell reports estimated source mass from road links crossing that cell
during the SUMO sample. Choose **Near-ground plume** to release 420
emission-weighted tracer parcels along those road links and follow them through
a solved OpenFOAM direction. The map displays the relative plume persistence
near pedestrian height as a smoothed street-scale field. A four-band legend
and a ranked list of up to five separated hotspot pockets help distinguish
where the modelled plume lingers from where traffic emits most. Each pocket is
labelled with its nearest mapped road; it is a location to investigate, not a
measured neighbourhood pollution rank. NOx is treated as a gas-like tracer
with no gravitational settling; the deposition layer is disabled for it.

The plume bands are recalculated for each run from its positive near-ground
map cells: lower half, middle 30%, high next 15%, and very high top 5%. The
timeline colours the cumulative field using those full-run thresholds, so
scrubbing time does not change the legend's scale. Display smoothing and the
filtered terrain-following texture soften cell boundaries; they do not change
the underlying residence values. The animated soft smoke puffs are a visual
trail over the sampled parcel paths, not a resolved concentration cloud. A
an uncoloured location may have no parcel residence or only a trace below the
display cutoff; it does not mean the air is clean.

SUMO's aggregate exhaust-PMx output is not split into PM2.5 and PM10, so traffic
mode deliberately focuses on NOx instead of presenting a size-specific
particle deposition result. The size-based PM2.5 and PM10 settling controls
remain available in single-source mode, where they demonstrate particle paths
without claiming to represent the city's traffic PM mix.

The scenario selector changes the weekday demand pattern and direction of
commute. The lower, typical and busy activity choices multiply the synthetic
demand. If a scenario has an enabled `route_sampler` profile backed by
configured edge or turning counts, SUMO uses those observations; otherwise
demand is synthetic. TomTom's speed ratios do not provide traffic counts, and
the synthetic departure rate used for this whole-CBD screen has not been
calibrated as a citywide count. The SUMO/HBEFA estimates are comparative
tailpipe outputs, not an observed emissions inventory; they exclude non-
exhaust particles, cold starts, lifecycle emissions and atmospheric chemistry.

## Single-source comparison

Choose **Single source on map** to retain the controlled release workflow.
Place a source in open air and select street level (2 m), low roof (12 m) or
stack height (35 m). PM2.5 and PM10 use a Stokes settling estimate; NOx uses a
gas-like tracer with no settling. The accelerated 15-minute timeline shows
airborne paths and relative near-ground residence. PM screens also show
relative ground contacts and glowing contacts with mapped buildings.

## Shared calculation and interpretation

- The browser samples the selected steady OpenFOAM velocity at each parcel
  position and advances it at one-second steps with a midpoint velocity sample.
- Correlated stochastic motion estimates unresolved turbulence from the case's
  `k` and `epsilon` fields: component variance is `2k/3`, and correlation time
  is estimated from `2k/(3 epsilon)`, bounded to 0.7–25 seconds. This is not a
  transient turbulence solve.
- The traffic plume is importance-sampled from road-level SUMO emission mass.
  Its parcels all carry an equal share of the selected run's modelled tailpipe
  mass; this supports relative comparisons but does not create a concentration
  field.
- PM settling assumes spherical mineral particles with density 1,500 kg/m³ in
  air at viscosity 1.81×10⁻⁵ Pa·s, with representative diameters of 2.5 and
  10 µm. Ground and building contacts stop a parcel in this visual screen; they
  are not a calibrated deposition process.
- Near-ground colour accumulates relative emission-weighted particle-seconds
  in a 112×112 map grid. A display-only Gaussian blur and filtered,
  terrain-following texture reduce parcel noise and cell edges; values and
  trajectories remain unchanged. Plume bands and ranked pockets
  are relative to the selected run, and road source emissions use a separate
  scale. None of these layers has µg/m³ units or represents ambient
  concentration.
- Parcels leaving the sampled CFD volume are removed. The steady OpenFOAM
  cases have a uniform neutral 10 m/s reference inlet and are exploratory,
  unvalidated urban-wind solves.

The traffic mode is intended to help locate streets and public spaces for
further investigation and potential greening. It does not simulate how trees
change emissions, wind, deposition or human exposure: mapped trees are not
porous obstacles in the CFD cases. Do not use these colours for health-risk,
regulatory or compliance decisions, or to claim that a proposed intervention
will reduce pollution.

To advance this beyond a planning screen, supply locally observed traffic
counts and fleet composition, validate the OpenFOAM wind and turbulence
fields, add a documented species-transport equation with appropriate source,
chemistry and deposition terms, and compare against independent CBD
air-quality observations. Keep the traffic profile, source assumptions, CFD
case and validation record with any exported result.
