# Traffic simulation calibration

The closure simulator reaches a steady state with a three-minute warm-up,
maintains demand throughout the complete measurement window, and drains the
network afterward for scoring. Warm-up vehicles affect traffic conditions but
are excluded from reported trip metrics.

Longer windows receive progressively larger processing budgets and slightly
coarser playback samples: 3 seconds for five minutes, 4 seconds for ten, 5
seconds for fifteen, and 6 seconds for twenty. The microscopic simulation
continues to advance in one-second steps. This keeps 10–20 minute requests
within the API timeout without reducing traffic-model time resolution.

Most trips use edges near the corridor boundary. A small local-access share is
retained. Baseline and closure runs use the same vehicles, departure times,
vehicle types, street-activity decisions, and random seed.

## Adding observed data

Copy `data/traffic_calibration.example.json` to
`data/traffic_calibration.json`. The live file is optional and is not checked
in with placeholder observations. Restart the API process after changing the
live file because calibration is cached per process.

For each scenario:

- `departures_per_min` is the observed total entry flow for the modelled
  corridor. When present, it replaces the synthetic volume rate and the
  scenario's synthetic demand scaling. The user sensitivity multiplier still
  applies.
- `through_trip_share` is the observed share of trips that pass through the
  area rather than starting and ending locally.
- `edge_weights` adjusts the relative likelihood that a SUMO edge supplies an
  origin or destination. Values are multipliers; `1.0` leaves the network
  weight unchanged.

### Count-calibrated routes with routeSampler.py

Set `route_sampler.enabled` for a scenario only after replacing every
placeholder with a real SUMO edge ID and observed count. `edge_counts` are
counts passing one edge; `turn_counts` are movements from an incoming edge to
an outgoing edge. Counts are assumed to cover `observation_period_min` and are
converted to a rate, then scaled across the three-minute warm-up plus the
requested measurement window. Warm-up vehicles shape traffic but are excluded
from reported trip metrics. The user's demand multiplier is retained as an
explicit sensitivity test.

For each request the server:

1. generates a broad, corridor-specific candidate trip population;
2. routes those candidates with `duarouter`;
3. passes the candidate routes and configured counts to SUMO's
   `routeSampler.py`;
4. rejects the request if the absolute count fit is below
   `minimum_match_ratio`; and
5. uses exactly the same sampled vehicles, types and departure times in the
   open and closed runs. A vehicle is forced onto a new legal route at
   departure only if its sampled route crosses a fully closed edge. Lane
   reductions leave the route legal, so those drivers rely on the configured
   periodic congestion-aware rerouting instead of receiving perfect advance
   knowledge.

`candidate_multiplier` controls route diversity and is clamped to 2–12.
Increase it when real count locations are not covered by enough plausible
routes. `turn_max_gap` permits intermediate edges between the recorded
incoming and outgoing edges when the count location does not map to directly
adjacent SUMO edges. The response records candidate count, scaled observation
totals, absolute mismatch, match ratio and maximum GEH statistic under
`demand_model.route_sampler`.

Do not combine overlapping edge counts by adding them and treating the sum as
the number of unique trips: one route can pass several count locations.
`routeSampler.py` handles those simultaneous constraints. Keep
`departures_per_min` as a candidate-pool sizing hint; the sampled population
is determined by the configured counts when route sampling is enabled.

The tools are supplied by the pinned `eclipse-sumo` dependency. A separate
system SUMO installation is not required in the application container.

### Uncertainty with multiple seeds

Choose 1, 3, or 5 random seeds in the traffic panel (three is the default), or
set `run_seeds.enabled` and supply 2–5 distinct integer seeds in the calibration
file. The service varies both the demand population and SUMO's random behaviour
for every seed, then reports the mean, median, and min/max range for journey-time
and completion changes. The decision summary uses the median because it is less
sensitive to one unusually congested run. The map and animation show the run
nearest the median journey-time effect.

This follows the purpose of SUMO's `runSeeds.py`, while retaining this
application's TraCI-applied lane closures. The stock script can only launch
static SUMO configurations and cannot apply the interactive closure state.
An ensemble is materially slower: three seeds means six microscopic runs.
The report is assessment-ready when a strict majority of seed runs passes the
quality gates (two of three or three of five); failed runs are excluded from
the reported medians and retained in the diagnostics. This prevents one
stochastic outlier from vetoing an otherwise stable ensemble.

If the open-road baseline is sound but fewer than 20% of trips finish after
the closure, the result is reported as a closure-capacity failure rather than
an incomplete comparison. Journey-time magnitude remains withheld because
the paired survivor sample is too small, while completion loss and queues stay
available for assessing the intervention.

For uncalibrated synthetic demand, directional profiles can overload the open
network differently even at the same nominal volume. If fewer than a majority
of seed baselines pass, the service retries the complete paired ensemble at
80% and then 64% of the requested vehicle target. The response and report
record the requested target, effective target, applied scale and every attempt.
Observed-count and route-sampler scenarios are never altered automatically.

### Dynamic user assignment

Set `dynamic_assignment.enabled` to run SUMO's `duaIterate.py` before the
paired closure simulations. It iteratively assigns each trip to routes using
the travel times produced by previous iterations, reducing the all-drivers-
choose-the-empty-network-fastest-route artefact. `iterations` is clamped to
1–5 and `aggregation_s` to 30–900 seconds; start with 3 iterations and a
60-second aggregation period.

DUA output is used as the baseline route choice. When a closure is applied,
routes crossing a fully closed edge are rerouted legally at departure; lane
reductions retain the assigned route initially. All vehicles retain the normal
periodic rerouting behaviour thereafter. Do not enable DUA and
`route_sampler` together: routeSampler's measured-count fit is the stronger
constraint and a subsequent DUA pass would invalidate it.

Signal programs are keyed by the SUMO traffic-light ID in
`data/sumo/cbd.net.xml`. Each phase requires its observed duration and a SUMO
red/yellow/green state string with exactly one character per controlled link.
`offset_s` positions the program within its cycle so adjacent signals can be
coordinated.
Invalid or unmatched programs are reported in each run's
`signal_calibration` diagnostics and generated network programs remain in use.

`network_overrides` applies surveyed corrections identically to the baseline
and closure. Use `disabled_lane_ids` for lanes that exist in the generated
network but not in the field, `disabled_edge_ids` for inaccessible road
sections, and `edge_speed_limits_kph` for checked speed limits. Adding lanes
or changing turn connections still requires rebuilding `data/sumo/cbd.net.xml`
from corrected OSM input.

Street-activity settings control deterministic stops at mapped pedestrian
crossings and kerbside activity locations. A vehicle can receive at most one
such stop. Parking bays are collapsed to one event location per road edge, so
a detailed bay inventory does not multiply stopping probability.

The default routing model gives 70% of vehicles congestion-aware rerouting at
60-second intervals. A route changes only when the alternative is at least
10% better, which limits route oscillation and does not assume every driver
has perfect traffic information. These values can be changed in `routing`.

## Result validity

Gridlock teleporting is disabled. Vehicles that cannot move remain queued and
their unfinished trips affect the closure result. The result is withheld from
assessment when the baseline is overloaded, more than 5% of baseline vehicles
remain stopped for at least five minutes, too few trips complete both runs, a
run reaches its wall-clock budget, or more than 2% of baseline vehicles cannot enter. The
response reports insertion failures, unfinished vehicles, persistent gridlock,
changed routes, unique vehicle throughput per edge, occupancy, speed, and
queues separately.

The response also includes a representative affected journey selected from
the paired completed trips near the median affected delay. Its named origin,
destination, before time, closure time, and extra time support the plain-language
journey example shown in the interface and report. The overall paired mean is
shown alongside it so the example is not mistaken for every driver's outcome.

Use held-out entry counts, turning counts, travel times, and maximum queue
lengths to validate a calibration. Do not tune and validate against the same
observation period.
