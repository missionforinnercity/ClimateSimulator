# Conditions roadmap: open work

This file tracks work that is still open. Start with small, inspectable studies
on the current Cape Town CBD scene. Record source dates, coverage, assumptions,
model versions and uncertainty. Synthetic behaviour and screening outputs must
not be presented as observed activity, measured exposure or validated benefits.

## Next implementable slices

| Order | Work item | First useful version | Done when / boundary |
| --- | --- | --- | --- |
| 1 | **Test missing walking connections** | Field-check the mapped gap shortlist in [walking link field checks](docs/WALKING_LINK_FIELD_CHECKS.md), then add a small, reviewed set of candidate crossings, opened passages or repaired links to a copy of the existing walking graph. Compare reachable destinations, detour distance and travel time across multiple origins and time windows. | Each candidate has a field-checked location, access rules and uncertainty. Results distinguish a modelled link from an existing one and make no wheelchair-accessibility or safety claim without surveyed evidence. |

## Scoped pilots after their inputs are available

| Pilot | Smallest credible scope | Required inputs and limits |
| --- | --- | --- |
| **Pedestrian activity and dwell scenarios** | One square or a few blocks; agents walk to a destination, wait, queue, sit or leave under explicit opening-hour, crossing-delay and seating rules. Compare plausible scenarios with manually observed counts and dwell times. | Obtain destination/activity and footfall observations first. The existing matched walkers are independent route-exposure samples, not a crowd model. Investigate JuPedSim only if close interactions or queue spillover require it; do not infer that a design causes a particular footfall gain. |
| **Time-based kerb allocation** | One commercial street; assign each kerb segment a daily loading, pickup, parking or seating schedule and model arrivals, dwell times, capacity and spillover. Report waiting, search distance, obstruction and space gained. | Survey stopping activity, bay dimensions, legal rules and local access demand. Existing parking geometry and illustrative parked cars are not occupancy or demand data. Connect the pilot to SUMO only after its local-demand assumptions can be checked. |
| **Physical pedestrian lighting** | One audited block; compare existing lights, selected outages and one redesign using pavement/crossing illuminance, dark gaps and energy use. | Measure pole height, aim, operating status and luminaire photometry; current rendered lights and inferred support heights cannot yield lux. A photometric workflow such as Radiance is a candidate to evaluate. Report lighting coverage, not crime risk or a general safety score. |
| **Bounded intervention option search** | Search a small set of seating or shade placements in one public space under explicit space, access and cost constraints; show several trade-offs side by side. | Needs a versioned proposal layer, costs and a reproducible baseline from the intervention laboratory in [the broader feature roadmap](docs/FEATURE_ROADMAP.md). Re-solve geometry-dependent wind cases; use fast approximations only within a tested validity range. |
| **C3 complaint-based inspection priorities** | If a suitable C3 dataset becomes available, model one weather-sensitive complaint category and suggest candidate inspection areas or a small route. Show expected reporting ranges, comparable past events and missing data. | Obtain dated, geocoded records with a usable category history and appropriate access rights, then test on future dates and whole storms withheld from training. The repo has no C3 pipeline or complaint dataset. A complaint forecast predicts reporting, not every physical failure or the benefit of drain clearing. |

## Other open work from the previous roadmap

| Work item | Next gate |
| --- | --- |
| **Drainage-aware runoff validation** | Add documented rainfall events, infiltration and drainage connectivity, then compare the terrain-only screen with observed ponding or an authoritative study before flood-depth or benefit claims. |
| **Bioswale and rain-garden comparisons** | Revisit proposed polygons after a reviewable drainage method and local runoff parameters exist. The former intervention editor has been removed. |
| **Acoustic comfort** | Acquire traffic and fleet observations, then document and validate a sound propagation method; relative SUMO edge-noise emissions alone are insufficient. |
| **Cycling reachability** | Acquire a connected, checked cycling-cost network and actual bike-share or scooter hubs before 5/10-minute isochrones. Keep mapped cycleway gaps separate from a safety ranking. |
| **Walking access audit** | Survey pavement widths, kerbs, crossings and barriers before making route accessibility claims. Keep the current route evidence separate from any safety score. |
| **Retail activity analysis** | Obtain storefront, use, footfall and dwell observations before testing correlations or economic effects. Coordinate with the pedestrian activity pilot. |
| **Citizen feedback and public voting** | The browser-local map note prototype is available. Public feedback and voting remain open until hosting, persistence, moderation, privacy and operator workflows are defined and scenario packages are reproducible. |
| **Construction phasing** | Supply project stages, work-zone rules and pedestrian detours before linking month-by-month traffic and walking scenarios. |

## Shared acceptance rules

- Show source dates, licences, coverage, unknown areas and missing tags; keep
  observed, inferred and synthetic values distinct.
- Use matched baselines, recorded seeds and consistent units/scales for scenario
  comparisons. Preserve the input geometry, source hashes and model version.
- Report separate outcomes and trade-offs rather than an opaque city score.
- Require field checks or independent validation before making engineering,
  safety, accessibility, exposure or intervention-benefit claims.

The broader evidence and validation programme remains in
[docs/FEATURE_ROADMAP.md](docs/FEATURE_ROADMAP.md).
The [input checklist](docs/ROADMAP_INPUTS.md) specifies the data and field
checks needed before each remaining pilot.
