# Public transport 3D mode

## What is implemented

The Transport tab runs a browser-side, timetable-driven simulation in the
existing Three.js city scene. It currently provides:

- procedural MyCiTi buses styled from `data/transport/bus-0539hr.jpg`;
- procedural blue-and-silver Metrorail sets styled from
  `data/transport/metrorail1-tw-20220128.jpg`;
- terrain-following movement, route overlays, clickable stop and station
  markers, an accelerated model clock, per-mode and per-route filtering, and
  route framing;
- 50 in-scope MyCiTi route directions and 69 active stops clipped to the CBD;
- a neutral **track layer**: every operating railway fragment stitched back
  into continuous polylines and clipped to the view, so the Cape Town station
  throat renders as the fan of tracks it is;
- nine named Metrorail corridors as **services** over that track. Only the two
  with in-view geometry (Strand, Monte Vista) carry drawn trains; the rest
  reach the CBD over shared trunk track and plan through the hub station;
- all 114 named rail stations for event-origin analysis;
- weekday departures extracted from the supplied MyCiTi timetable PDFs;
- directional weekday and weekend PRASA arrivals/departures loaded from the
  supplied structured CSV, with a labelled fallback only where no trip matches;
- an event-access planner whose venue is either a hub from the list or **any
  point clicked on the map**, with date, start/end time, arrival window,
  walking catchment, dispersal window, attendance and mode-share inputs;
- connected origin areas, arrival/return service counts, dispersal coverage,
  highlighted useful corridors, and a ranked list of interventions naming the
  corridors and route directions to extend, the target time, the number of
  extra trips, and the capacity shortfall; and
- an explicit link to the official Metrorail Western Cape update account.

Clicking a bus stop lists the routes calling there and the next modelled
departures from the model clock; clicking a rail station lists the corridors
terminating there and the next scheduled outbound service.

Every moving position is labelled as an estimate. The app does not currently
have AVL/GPS data, and it must never call a timetable interpolation “live”.

Rebuild the compact generated browser asset after changing source data:

```bash
python scripts/build_transport_asset.py
```

The builder needs `pyproj` and the Poppler `pdftotext` command. It reads
`data/transport/prasa_schedules.csv` directly and writes
`public/assets/transport.json`; the raw PDFs and GIS files remain outside the
public bundle.

## Data confidence

| Layer | Geometry | Time | Position label |
|---|---|---|---|
| MyCiTi | Supplied City GIS routes/stops | Supplied weekday PDF tables where extractable | Timetable-derived estimate |
| Metrorail | Supplied municipal railway line/station GIS, stitched and checked against the OSM rail layer the scene draws | Supplied directional PRASA CSV by weekday/Saturday/Sunday; planning cadence on unmatched corridors | Timetable-derived estimate |
| Service alerts | Official account link only | User checks the source | Not applied to vehicles |

Corridor centrelines in the municipal file include generalised and freight
alignments. The builder rejects any run whose median offset from
`data/osm_cbd_railways.geojson` exceeds 25 m, so a service line is never
painted across roads or buildings. The filter is skipped if that file is
missing.

Motion is speed-based, not stretched: a vehicle exists only while a scheduled
departure is inside the modelled view, crossing it at 18 km/h (bus) or 40 km/h
(rail). Vehicle counts therefore rise and fall with the real headways instead of
showing one crawling vehicle per route.

The event capacity proxy assumes 60 places per bus movement and 800 per train
movement, applied to attendance × the mode-share slider. It is intentionally
conservative planning arithmetic, not vehicle allocation, loading or observed
demand. Walking catchments use shortest paths over the mapped pedestrian and
street network at 4.8 km/h. Cape Town Station uses the complete mapped
multi-part station building and routes to its nearest public entrance rather
than its centroid. "Extend to" targets assume the crowd needs
the full dispersal window to reach a stop.

The structured PRASA CSV is now the simulator source. It contains some blank
cells (`..`), which the builder rejects rather than inventing a time. Eight of
the nine mapped rail corridors currently match at least one published service;
the Muldersvlei corridor retains the explicit planning-cadence fallback.

## Continuation 2 — actionable build order

1. **Promote the CSV to a verified GTFS-like dataset.** Reconcile its blank
   cells and corridor aliases against the source pages, then export `stops`,
   `routes`, `trips`, `stop_times`, `calendar`, and `calendar_dates`. Extend
   the MyCiTi parser to retain Saturday and Sunday
   service and exact stop-time sequences instead of only trip endpoints.

2. **Build the route graph.** Match timetable stop names to stop IDs with a
   reviewed alias table, snap each stop to the correct directional shape, and
   use RAPTOR or CSA for transfers, walking legs, service calendars, and
   wheelchair constraints. Report unmatched names during the asset build and
   fail CI when coverage regresses.

3. **Use lawful update ingestion.** Add a server-side connector using X's
   authenticated API (not brittle page scraping), persist post IDs and fetch
   timestamps, and parse only operational events: line, direction, station
   range, delay/cancellation, start time, and expiry. Keep the original post
   link and require a confidence threshold or manual approval before changing
   a trip. Never infer a precise train coordinate from a vague disruption post.

4. **Add a real-time state model.** Adopt GTFS-Realtime-shaped entities for
   `TripUpdate`, `VehiclePosition`, and `Alert` even while the feed is inferred.
   Store `source`, `observed_at`, `confidence`, and `uncertainty_seconds` on
   every state. When official AVL becomes available, it can replace the
   estimator without rebuilding the UI.

5. **Upgrade motion fidelity.** Interpolate between exact stop times, reserve
   15–30 second dwell windows, add acceleration/braking curves, choose the
   correct carriageway direction, articulate multi-car trains along the rail
   spline, and add distance-based LoD. Keep wheels and carriage joints animated
   only at street-level zoom.

6. **Upgrade the visual system.** Replace the procedural meshes with optimized
   authored GLB assets (shared materials, Draco/Meshopt, under 100k triangles
   per vehicle at LoD0), add route-number destination displays and doors, and
   use instancing for distant vehicles. Preserve the procedural versions as a
   no-download fallback.

7. **Validate and monitor.** Add golden timetable-parser fixtures, route/stop
   match tests, timezone and midnight tests, planner tests, screenshot tests,
   frame-time budgets, and an on-map confidence legend. Compare inferred
   arrivals against a week of manual observations before publishing accuracy
   numbers.

8. **Planning features.** Add transfer itineraries, walk isochrones, fare
   rules, accessibility filters, saved trips, occupancy only when sourced, and
   disruption-aware alternatives. Keep transport simulation separate from the
   synthetic road-closure traffic model until bus priority and demand inputs
   are calibrated.
