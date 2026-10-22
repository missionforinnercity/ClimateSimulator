# Walking-network gap field checks

The checked-in walking graph has 8,278 nodes and 25 undirected components;
8,023 nodes are in the largest component. These are **map candidates for
inspection**, not proposed or existing crossings. A short gap between OpenStreetMap
path endpoints can also mean a wall, fence, different level, private access or
an OSM digitising error. The nearest municipal crossing *point* is context,
not evidence that a legal crossing spans the gap.

This screening used `data/derived/walking_network.json.gz` (built
14 October 2026, schema 1, OSM source
SHA-256 `8b9c2927d893694c50d32f16e8093d6042c47b3804064486ec50fc1b69de4830`).
It compared each disconnected component to the largest component by nearest
node distance. Coordinates are approximate WGS84 longitude, latitude for
finding the location. The OSM extract's capture date is not recorded in the
graph artifact; OSM data is © OpenStreetMap contributors, ODbL. No site below
has been field checked.

| Check | Nearest mapped street cue | Gap between path endpoints | Disconnected component | Approximate endpoint A (lon, lat) | Approximate endpoint B (lon, lat) | Nearest municipal crossing point |
| --- | --- | ---: | ---: | --- | --- | ---: |
| W1 | Loader Street | 4.3 m | 22 nodes | 18.415687, −33.914743 | 18.415727, −33.914723 | 237 m |
| W2 | Castle Street | 7.7 m | 10 nodes | 18.425721, −33.925794 | 18.425646, −33.925824 | 33 m |
| W3 | Heerengracht Boulevard | 13.9 m | 17 nodes | 18.428298, −33.917268 | 18.428446, −33.917287 | 23 m |
| W4 | Roeland Street | 8.9 m | 36 nodes | 18.424089, −33.931050 | 18.424024, −33.931109 | 63 m |

The street cue is the nearest named OSM road to the gap midpoint; it does not
identify which side of a road, parcel or structure each endpoint occupies.
W3 and W4 are near major roads and need particular care to establish whether
the gap represents a permitted ground-level pedestrian connection. W1 may be
a path-mapping discontinuity rather than a missing physical passage.

## What to return from a site visit

For each candidate, record the check ID, visit date, a photo or short map
annotation, and one of **open existing link**, **closed or obstructed link**,
**possible new crossing or passage**, or **not a valid link**. Mark the actual
connectable endpoints as WGS84 coordinates or a drawn line. Record:

- whether a person can walk between the endpoints today, any steps or level
  change, and barriers or traffic conflict;
- public/private status, signs, permitted directions and opening hours;
- crossing controls, refuge and kerb arrangement where a road is crossed;
- any closure or change needed to make a proposed link usable;
- uncertainty and who verified the access rule.

The [field-check CSV template](walking_link_field_checks_template.csv) has one
row per candidate. Enter local visit times with an explicit UTC offset, such
as `2026-10-21T14:00:00+02:00`. A map or GeoJSON with the same check IDs can
replace the coordinate columns. Leave unknown fields blank and explain them
in `uncertainty_notes`.

The first comparison will add only confirmed or explicitly proposed links to
a **copy** of the baseline graph, then compare reachable destinations, detour
distance and travel time for several origins and departure windows. It will
label proposals separately from existing links. No wheelchair accessibility or
safety conclusion follows from these gap locations.
