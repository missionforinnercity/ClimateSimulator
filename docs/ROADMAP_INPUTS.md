# Inputs needed for the remaining CBD studies

Use this as a sourcing checklist for [the open roadmap](../ROADMAP.md). A useful
delivery includes the raw file, source organisation, licence or access terms,
collection and update dates, coordinate reference system, geographic coverage,
attribute definitions, known gaps, and permission to use it for this project.
For observations, retain the original timestamps with time zone and the
measurement method. An example record or data dictionary is enough to review a
source before a full transfer.

| Roadmap work | What is already here | Minimum additional input before its proposed pilot |
| --- | --- | --- |
| Plume source roads | SUMO network, road-emission estimates and OpenFOAM fields. | No new source file for the exploratory calculation. Run the same receiving area over three seeds and check the road-share accounting. Real-world exposure claims would additionally need calibrated traffic counts, local air-quality observations and a validated dispersion model. |
| Missing walking connections | OSM walking graph and municipal crossing points. | Field-check a few candidate link endpoints, public access and hours, barriers, road-crossing controls, and whether each link exists or is only proposed. Start with [the gap shortlist](WALKING_LINK_FIELD_CHECKS.md), or supply better local candidates. |
| Pedestrian activity and dwell | Walking paths and POI context; no observed activity. | For one chosen square or block: dated destination/opening-hour inventory, pedestrian counts by entrance and 15-minute window, observed dwell/queue times, seating capacity and crossing waits on several weekdays and a weekend. |
| Time-based kerb allocation | Municipal parking **points**, not bay extents or occupancy. | One street's surveyed bay/kerb polygons, legal time restrictions, loading and pickup permissions, arrivals, dwell, observed occupancy and spillover by time window, plus delivery and local access requirements. |
| Physical pedestrian lighting | Municipal light points and wattage/support classes; heights are inferred. | One block's surveyed pole/fixture height and position, lamp model with IES/LDT photometry, aim/tilt, operating and outage status, measured pavement/crossing illuminance, and tariff or energy assumptions. |
| Bounded seating/shade options | City geometry and sun/wind screens; no approved proposal layer or costs. | One public-space boundary, candidate footprints, access clearances, ownership/permissions, capital and maintenance costs, and a dated baseline. Wind-changing geometry needs a new solved case or tested approximation. |
| C3 complaint priorities | No complaint pipeline or C3 dataset. | Dated, geocoded complaint records for one consistent weather-sensitive category, category history, duplicate/status fields and access rights; matched storm dates and rainfall, with future storms reserved for testing. |
| Drainage-aware runoff and bioswales | No runoff map layer is currently exposed. | Dated rainfall intensity series, inlet/pipe/outfall connectivity and capacity, local infiltration/soil and imperviousness evidence, observed ponding or authoritative flood-study comparisons. Bioswale options additionally need site boundaries, ownership and design constraints. |
| Acoustic comfort | Relative SUMO edge-noise emissions only. | Traffic counts, vehicle/fleet mix and speeds by time window, sound-level observations (location, height, averaging period, calibration), source/receiver geometry and a documented propagation method. |
| Cycling reachability | Mapped OSM cycleway-gap context, without a connected cycling-cost graph. | Surveyed cycle links, directions, restrictions and barriers with a consistent travel-time rule, plus the locations and actual operating status of any bike-share or scooter hubs. |
| Walking access audit | Partial OSM sidewalk/width tags and crossing points. | Surveyed pavement width and surface, kerb height/dropped kerbs, crossing geometry/control, steps, grades and temporary barriers with date and positional accuracy. |
| Retail activity | POI context, not a storefront or demand census. | Dated storefront boundaries and use/vacancy, opening hours, pedestrian counts and dwell by location/time; any economic analysis also needs comparable sales or tenancy outcomes with permission and privacy safeguards. |
| Citizen feedback and voting | Browser-local map notes plus local scenario export; no public hosting or moderation. | Choose operator, hosting and retention policy, moderation workflow, privacy notice and data rights; identify reproducible scenario packages and a decision process for acting on feedback. |
| Construction phasing | Current traffic and walking models, no project sequence. | Stage start/end dates, work-zone polygons, lane/footway restrictions, signed detours, operating hours and emergency/local-access rules. |

The current source files cannot establish safety, accessibility, measured
exposure, flood depth, intervention benefit or demand. A pilot should preserve
raw observations and compare matched baselines with explicit coverage and
uncertainty. If a source is unavailable, its pilot remains open rather than
using invented observations.
