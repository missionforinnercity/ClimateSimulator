# Traffic emissions and pollutant dispersal screening

## Citywide traffic mode

The Wind panel's **Pollutant dispersal** lens runs a whole-CBD SUMO traffic
scenario for a selected weekday profile (AM peak, midday, PM peak or evening).
After a short warm-up, it samples ten minutes of road activity using the
existing synthetic car, minibus-taxi, delivery-van and shuttle fleet with
SUMO's HBEFA3 tailpipe estimates. Each monitored edge accumulates NOx, exhaust
PMx and CO2 emissions; the browser joins these values to road geometry.

The pollutant heat map combines NOx and exhaust PMx emissions by mass, then
traces 420 weighted parcels from the emitting road links through one solved
OpenFOAM wind direction. A four-band legend and ranked hotspot pockets show
relative near-ground pollutant residence. This combined mass is treated as one
tracer with no gravitational settling. The model does not represent pollutant
chemistry or species-specific behavior, and the colours are not measured
concentrations or an observed neighbourhood pollution rank.

The plume bands are recalculated for each run from its positive near-ground
map cells: lower half, middle 30%, high next 15%, and very high top 5%. The
timeline colours the cumulative field using those full-run thresholds, so
scrubbing time does not change the legend's scale. Display smoothing and the
filtered terrain-following texture soften cell boundaries; they do not change
the underlying residence values. Parcel paths and smoke visuals are not shown.
An uncoloured location may have no parcel residence or only a trace below the
display cutoff; it does not mean the air is clean.

SUMO's aggregate exhaust-PMx output is not split into PM2.5 and PM10. The
scenario selector changes weekday demand patterns and commute direction. The
lower, typical and busy activity choices multiply synthetic demand. If a
scenario has an enabled `route_sampler` profile backed by configured edge or
turning counts, SUMO uses those observations; otherwise demand is synthetic.
TomTom's speed ratios do not provide traffic counts, and the synthetic
departure rate has not been calibrated as a citywide count. The SUMO/HBEFA
estimates are comparative tailpipe outputs, not an observed emissions
inventory; they exclude non-exhaust particles, cold starts, lifecycle
emissions and atmospheric chemistry.

## Single-source comparison

The optional **Single source on map** workflow uses the same generic tracer and
overall near-ground heat map. It can compare release locations and heights,
but does not represent a specific pollutant species.

## Shared calculation and interpretation

- The browser samples the selected steady OpenFOAM velocity at each parcel
  position and uses midpoint advection with a variable time step.
- The stochastic velocity uses an exact finite-step Ornstein–Uhlenbeck update
  for both velocity and integrated displacement. Adaptive steps are limited by
  the CFD-cell crossing time and local Lagrangian time scale.
- This is still a screening random walk: it assumes independent, locally
  isotropic Gaussian velocity fluctuations inferred from `k` and `epsilon`.
  The shipped CFD volumes contain `U`, `p`, `k` and `epsilon`, but no Reynolds-
  stress components, so turbulence anisotropy cannot be recovered from these
  inputs.
  Its Langevin drift includes the isotropic Gaussian well-mixed covariance
  gradient and along-trajectory variance terms, but it does not use the full
  anisotropic Reynolds-stress tensor available in a complete generalized
  Langevin model. It has not been validated against a tracer release or
  ambient concentration measurements.
- With variance `s² = 2k/3`, the well-mixed acceleration added to the OU
  velocity is `0.5 ∇s² + 0.5 u ((U + u) · ∇s²) / s²`. The gradient comes from
  the trilinear CFD interpolation, including its valid-mask normalization.
  This is the isotropic specialization of the generalized Langevin model
  described by [Margairaz et al. (2023)](https://doi.org/10.5194/gmd-16-5729-2023).
- Correlated stochastic motion estimates unresolved turbulence from the case's
  `k` and `epsilon` fields: component variance is `2k/3`, and correlation time
  is `4k/(3 C0 epsilon)` with `C0 = 3`. It has a 0.7 s lower bound and no
  positive-`epsilon` upper cap; the integration step remains capped at 0.5 s.
  This follows the isotropic Langevin variance relation; the constant and
  lower bound are model assumptions, not calibrated to local turbulence
  measurements. This is not a transient turbulence solve. The direction-
  specific CFD volumes are present, but their manifests classify the steady
  RANS results as exploratory and unvalidated; the empty `design-cases.json`
  applies only to added proposals.
- Traffic parcels use shuffled stratified sampling over combined road-level
  SUMO NOx and exhaust PMx emission mass. Each carries an equal share of the
  run's modelled tailpipe mass; this reduces road-source sampling variance but
  does not create a concentration field. Release times use the midpoint of
  equal-duration strata across the SUMO source window, representing a uniform
  emission rate without over-weighting the window endpoints. The results report
  the mass and share of whole-run emissions assigned to mapped road links,
  then the portion released on sampled road segments inside the valid CFD and
  terrain footprint.
  Road-link emission mass is distributed uniformly by road length and the
  footprint is checked at up to 5 m intervals for this estimate; unmatched and
  out-of-domain mass is excluded from parcel release.
- At a ground crossing, the endpoint is mirrored about the 0.45 m contact
  height, and the net normal particle velocity (mean plus fluctuation minus
  settling) is reflected with equal speed in the outward direction. Swept
  trajectory segments are checked against building walls, roofs and bases;
  mapped residence stops at first contact and the incoming total velocity is
  reflected at the nearest surface. The remaining fraction of that step is not
  reintegrated, so this is a discrete collision approximation. No calibrated
  dry deposition, wet scavenging, chemistry or species-specific particle
  settling is applied.
- Near-ground colour accumulates relative emission-weighted parcel-seconds in
  a 112×112 map grid. Each step's interval from 0.45 to 10 m above ground is
  linearly clipped using endpoint heights above the same triangulated DEM
  surface rendered in the scene, then split across
  the crossed horizontal cells. A reflected ground crossing is unfolded into
  its approach and rebound portions so near-ground time after contact remains
  in the same step's accounting; time below the ground-contact boundary is not
  counted. Intervals inside mapped building footprints are removed using their
  polygon rings, courtyard holes and vertical extents. A final step that exits
  the valid terrain or CFD footprint is clipped to its last valid fraction.
  Terrain-footprint polygon crossings are clipped directly, including holes;
  the integrator's midpoint validity check can also split a step around an
  invalid CFD patch when both endpoints are valid. This preserves in-grid
  residence weight and reduces endpoint-cell bias.
  Display-only Gaussian smoothing and a filtered,
  terrain-following texture soften cell edges. Plume bands and ranked pockets
  are relative to the selected run. The map has no µg/m³ units and does not
  represent ambient concentration.
- Perfect reflection is consistent with the well-mixed condition for
  homogeneous Gaussian normal-velocity turbulence, but not generally for
  inhomogeneous or asymmetric normal-velocity distributions. The present
  near-ground boundary treatment is therefore approximate;
  [Wilson and Flesch (1993)](https://journals.ametsoc.org/view/journals/apme/32/11/1520-0450_1993_032_1695_fbirfd_2_0_co_2.xml).
- Parcels leaving the sampled CFD volume are removed. The steady OpenFOAM
  cases have a uniform neutral 10 m/s reference inlet and are exploratory,
  unvalidated urban-wind solves.

The traffic mode is intended to help locate streets and public spaces for
further investigation and potential greening. It does not simulate how trees
change emissions, wind, deposition or human exposure: mapped trees are not
porous obstacles in the CFD cases. Do not use these colours for health-risk,
regulatory or compliance decisions, or to claim that a proposed intervention
will reduce pollution.

## Measurement-based validation

The City lists CBD monitoring sites including Foreshore, City Hall and Molteno
in its [Air Quality Management Plan](https://resource.capetown.gov.za/documentcentre/Documents/City%20strategies%2C%20plans%20and%20frameworks/Air_Quality_Management_Plan_2024.pdf).
The Department of Forestry, Fisheries and the Environment says the City's
station observations are reported in real time to
[SAAQIS](https://saaqis.environment.gov.za/). These records are a possible
validation source, but no time-matched observation series has been imported or
compared with this model. The current generic combined-mass residence field
cannot be directly calibrated to an individual species concentration; a
validation study must compare like-for-like species, periods and wind
conditions and keep monitor quality flags and missing-data coverage.

To advance this beyond a planning screen, supply locally observed traffic
counts and fleet composition, validate the OpenFOAM wind and turbulence
fields, add a documented species-transport equation with appropriate source,
chemistry and deposition terms, and compare against independent CBD
air-quality observations. Keep the traffic profile, source assumptions, CFD
case and validation record with any exported result.
