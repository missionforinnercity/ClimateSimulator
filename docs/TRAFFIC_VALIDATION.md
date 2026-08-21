# Cape Town CBD traffic model review

Reviewed 7 August 2026 against reports `TRF-1B09B04C` and `TRF-308C2696`.

## Finding

The model is suitable for exploratory option comparison after the calibration
changes below. It is not a forecast of observed Cape Town traffic. The route
network, left-hand lane operation, same-demand paired runs, trip-level pairing,
municipal road enrichment and explicit completion reporting are sound
foundations. Demand, origin-destination movements, signal plans, fleet
composition and pedestrian/public-transport operations remain assumptions.

- `TRF-1B09B04C` is invalid as an impact assessment. Both runs reached the
  processing limit and the report correctly called it incomplete, but pages 2
  and 3 still printed impact percentages. Reports now withhold paired and
  environmental comparison values whenever validity checks fail.
- `TRF-308C2696` gives a credible *direction* of effect for removing 23
  kerbside lanes across Adderley and Wale during the morning peak: diversion,
  queues and lower completion are expected. Its `+36.4%` journey-time and
  `+16.0%` CO2 figures are not reliable magnitudes. Only 69% of generated trips
  completed in the open-road baseline, so the scenario began in synthetic
  oversaturation. Under the new validity gate it is marked incomplete.
- A 23-section intervention across two streets is a corridor-scale staged-work
  scenario, not a typical single-block lane closure. Operational conclusions
  should be tested per phase/block as well as for the combined worst case.

## Stability calibration

The former base rate of 160 departures/minute was selected for animation
density, not from counts. A repeatable 10-minute Adderley corridor sweep on the
supplied SUMO network produced:

| Synthetic rate | Open-road completion by 15 min | Mean queue | Peak queue |
| ---: | ---: | ---: | ---: |
| 50/min | 92.4% | 88 | 187 |
| 60/min | 84.1% | 102 | 226 |
| 70/min | 72.5% | 134 | 267 |
| 80/min | 82.9%* | not retained | not retained |
| 120/min | 63.5%* | not retained | not retained |
| 160/min | 46.8%* | not retained | not retained |

`*` Separate paired sweep and seed; useful as a stability check, not a strict
cross-row performance comparison.

The base rate is now 50/min. This is a stable synthetic loading rate, **not an
observed traffic count**. A result is withheld when the open-road completion is
below 85%, either run times out, or fewer than 20% of generated trips complete
both runs. These gates prevent survivor bias from being presented as a usable
impact estimate.

A post-change 20-minute AM-peak sanity run for all modelled Adderley Street
multi-lane sections generated 995 trips. The open-road run completed 100%, the
lane-closure run 77.1%, and 77.1% formed the paired sample; neither run timed
out. The model estimated +64 s (+27.3%) paired journey time and 542 kg versus
640 kg corridor tailpipe CO2. These are coherent scenario outputs, not observed
effect sizes, and the exact Adderley/Wale drawing in the supplied reports should
be rerun in the interface after this change.

## Corridor-size demand scaling (2026-08-07)

Reviewed against reports `TRF-7DDFAAB4` (Adderley/Wale, 24 drawn sections)
and `TRF-5B70A334` (Bree Street, 10 drawn sections), generated minutes apart.
Bree's smaller-looking closure produced *worse* outcomes than Adderley/Wale's
larger one: open-road baseline completion was 100% for Adderley/Wale but only
93% for Bree, and 89% of Bree trips finished with the closure in place versus
99% for the two-street scenario. A smaller intervention should not look more
disruptive than a bigger one, and it did not for a road-network reason -- it
was an artifact of the demand model.

`BASE_VEHICLES_PER_MIN` was a flat rate applied regardless of corridor size:
every closure preview generated ~1,000 synthetic trips for a 20-minute
am-peak run, whether the 250 m buffer around the selected road sections
produced a 4 lane-km pocket or a 30 lane-km sprawl. The same absolute demand
concentrated into a small drawn selection gridlocked it, while the identical
demand spread across a large corridor left it barely stressed -- so the
reported severity tracked how much unrelated road happened to fall inside the
buffer, not the closure itself.

Demand is now scaled by each request's own corridor capacity (total
lane-km across corridor edges) relative to the Adderley reference corridor
the original sweep used (19.3 lane-km), holding vehicles-per-lane-km, not
vehicles, constant. Scaling is clamped to `[0.3, 1.0]`: only down-scaling for
small corridors, never up-scaling past the sweep-validated rate for large
ones. Testing the up side directly (0.9 lane-km-Bree`s corridor) at scale
1.3-1.6 reproduced the exact saturation-inversion failure mode already
documented below -- closure completion *higher* than baseline, negative
journey-time change -- so scaling up was reverted; a large corridor diluting
a closure's average effect across more alternative routes is a legitimate
property of that corridor, not something to compensate for.

Post-fix spot check, 20-minute am-peak, `lane` closure mode:

| Selection | Corridor lane-km | Rate/min | Baseline completion | Journey-time change |
| --- | ---: | ---: | ---: | ---: |
| 10 sections, Bree Street | 22.7 | 50.0 (scale 1.0, capped) | 97.6% | +5.2% |
| 24 sections, Adderley + Wale | 19.3 | 50.0 (scale 1.0) | 100.0% | +49.8% |

The smaller, single-street selection now reads as a minor penalty and the
larger, two-street corridor-wide selection as the major one -- the ordering
the two source reports got backwards. The full-road Adderley reference run
used for the original sweep is unaffected (its own lane-km already sits at
scale ≈1.0).

## Cape Town context represented

- Left-hand traffic and kerbside lane index are encoded in the network.
- Morning demand is inward-biased and afternoon demand outward-biased. The
  City's 2024 transport-plan update describes strong directional peak travel
  and estimates work trips at 57.5% private transport, 22.4% minibus taxi,
  5.4% bus and 1.5% BRT. Those are passenger mode shares, so they support the
  importance of minibus and bus operations but must not be copied directly as
  vehicle shares.
- The City reports 1,725 signalised intersections, 454 on SCOOT. The current
  SUMO programs are generated network programs, not the CBD's field timing,
  coordination or detector logic.
- HBEFA3 outputs are comparative tailpipe estimates. They exclude vehicles
  waiting to enter the network, cold-start adjustment, non-exhaust particles
  and lifecycle emissions. The noise value is an edge emission indicator, not
  a facade or pedestrian receptor level.

## One-way conversion (2026-08-19)

SUMO/`netconvert` bakes edge direction into the network at build time; there
is no live "reverse this lane" call in TraCI. A two-way street is modelled as
two directional edges between the same pair of nodes, so a one-way
conversion is implemented by fully closing the opposite-direction sibling
edge (the same `edge.setDisallowed` mechanism a full closure already uses),
not by mutating direction. This is representative for a low-volume access
street, such as a single-block residential road, but will understate impact
on a street where the closed direction itself carries significant flow —
that traffic simply has nowhere to be generated in the model, rather than
being displaced onto it. Edges that are already one-way in the source OSM
data have no opposite sibling to close; the resolver reports this rather
than fabricating a closure.

The technical drawing-sheet report's cross-section is illustrative only: it
draws SUMO's default lane width, not a surveyed measurement, since the
network carries no per-lane survey data. It should not be read against a
concept design's dimensioned cross-section.

## Signal timing: actuated control tested and reverted (2026-08-20)

Following up on "the current SUMO programs are generated network programs,
not the CBD's field timing" above: inspected the built network directly and
confirmed all 181 `tlLogic` programs use the exact same 90 s cycle
(`netconvert`'s blind default), regardless of intersection size or
approach count -- a two-lane residential crossing and a major Adderley/Strand
junction currently run an identical fixed cycle.

Real per-intersection field timing is not available (same "evidence still
needed" gap as below), but SUMO's `actuated` signal type -- which extends or
cuts short green time based on real-time detector occupancy instead of a
blind fixed cycle -- does not require any such data and is a standard,
well-established improvement. Tested by rebuilding the network with
`netconvert --tls.default-type actuated` (plus `--tls.max-dur 90` so
actuated green could extend at least as long as the original static green,
not less):

- Topology was unaffected: identical edge/junction/tlLogic counts and edge
  IDs to the current network, only the `tlLogic` definitions changed.
- At light demand (5-minute Adderley sample) it measurably helped: baseline
  completion rose from 80.6% to 88.7% for the same request.
- At the calibration sweep's own reference point (10-minute Adderley,
  am-peak, `lane` closure, demand scale 1.0) it reproduced the
  saturation-inversion failure mode from the Stability calibration section
  above: journey time came back **negative** (-3.2%) for a plain lane
  closure, with closure completion *below* baseline completion. The sign
  only became sane again around demand_multiplier ≈ 0.7 -- i.e. actuated
  signals shift this network's effective capacity enough that
  `BASE_VEHICLES_PER_MIN = 50` is no longer inside the validated stability
  band.

**Reverted** -- `data/sumo/cbd.net.xml` is unchanged, still the `static`
signal build. Actuated control is a real, low-risk-in-principle accuracy
improvement (SUMO-standard, needs no unavailable data), but it moves the
demand-model's calibration point and must not ship without redoing the full
stability sweep (the 50/60/70/80/120/160-departures/min table above) against
an actuated network first, the same way the original sweep was done for the
static one. Treat as a scoped follow-up, not a drop-in swap.

## Evidence still needed for calibration

1. Weekday AM, interpeak and PM turning counts for Adderley/Wale and diversion
   junctions, including minibus taxis, buses, freight and bicycles.
2. Observed travel times and maximum/mean queues for at least one normal week.
3. Signal phase, cycle, offset, pedestrian phase and SCOOT/controller data.
4. CBD origin-destination or cordon data, parking entry/exit demand, loading
   activity and public-transport stops/dwell times.
5. Local vehicle-age/fuel-class observations for emissions calibration.

Calibration should target held-out counts, journey times and queues, report
error measures by period, and retain a separate validation day before the tool
is labelled forecast- or engineering-grade.

## Sources

- City of Cape Town, [Comprehensive Integrated Transport Plan 2023-2028: 2024
  Annual Update](https://resource.capetown.gov.za/documentcentre/Documents/City%20strategies%2C%20plans%20and%20frameworks/CITP_2024_Annual_Update.pdf)
- Eclipse SUMO, [Traffic Lights](https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html)
- Eclipse SUMO, [Emissions](https://sumo.dlr.de/docs/Models/Emissions.html)
- Eclipse SUMO, [Scenario Guide](https://sumo.dlr.de/docs/Tutorials/ScenarioGuide.html)
