# Climate-aware walking routes

The walking panel compares pedestrian paths across the checked-in Cape Town CBD. It returns a fastest route, a least-direct-sun route, and a lowest-heat route when current UTCI data can support that comparison. Matching paths are shown as separate objectives with a note that their geometry is the same.

## Network and endpoint

The route graph is generated from `data/osm_cbd.osm.xml`, which retains OSM foot, access, sidewalk, surface, incline, and steps tags that are absent from the compact road layer. Rebuild the compressed runtime graph after updating the source extract:

```bash
.venv/bin/python scripts/build_walking_network.py
```

The builder uses OSMnx to parse and clip the local extract, then writes `data/derived/walking_network.json.gz`. The API loads that artifact as a cached NetworkX directed multigraph. Explicitly prohibited pedestrian ways and motorways are filtered. Trunk roads, busways, and cycleways require mapped foot access or a sidewalk. Mapped steps remain in the graph. Segments without foot access, pedestrian-way, or sidewalk evidence remain marked uncertain; each route reports their share and its mapped steps distance. The data is © OpenStreetMap contributors and distributed under the ODbL.

`POST /api/walking/routes` accepts viewer-local metre coordinates and a departure time. Naive date-times are interpreted in `Africa/Johannesburg`; the browser submits that local time. Each endpoint is projected onto its nearest directed walkable segment, and requests more than 50 m away are rejected. The route geometry starts and ends at those projected points.

```json
{
  "origin": {"x": -250, "z": 0},
  "destination": {"x": 250, "z": 100},
  "departure_at": "2026-01-15T12:00:00"
}
```

The route response includes geometries, length and 4.8 km/h estimated walking time, per-layer coverage, network source hash, thermal forecast version, and route exposure metrics. It also includes `agent_job_id`; poll `GET /api/walking/agents/jobs/{job_id}` for the separate matched-walker result. The route objectives remain separate: walking time, direct-sun walking time, and cumulative UTCI degree-minutes above 26°C. Environmental graph costs use each edge's earliest estimated walking arrival from the chosen departure. This is an approximation for an alternative that takes longer than the fastest path. Route exposure summaries then sample the selected path every 15 m at its actual expected traversal time. Shade timestamps are grouped into nearest five-minute bins. UTCI and pedestrian wind use the nearest complete hourly frame within 30 minutes. Missing or stale thermal data removes the heat-ranked alternative but leaves the other routes available and marks the thermal layer unavailable.

## Matched walker comparison

Each path is sampled by 100 synthetic walkers with speeds drawn once from a seeded uniform range of 4.0–5.6 km/h. The same speed assigned to a walker is reused on every route. The agent job reports each walker's sun minutes, UTCI heat load, mean 1.5 m wind, and data coverage, plus P50/P90 route summaries and a representative cumulative exposure trace with map coordinates. The browser shows the routes first, then adds the cohort distributions and a replay of one representative walker when that job completes. These agents are independent; they do not represent demographic vulnerability, crowding, or interactions between people.

## Traffic context and limits

The optional traffic action starts the existing five-minute citywide SUMO/HBEFA emissions job for the selected time period. It sums modeled road NOx on named streets used by the returned paths and remains separate from route ranking. This is a synthetic road-emissions source estimate, not pedestrian pollutant concentration or personal dose.

The first version only covers the current CBD scene. OSM access tags can be incomplete; mapped steps are included, and there is no wheelchair-accessibility claim. Thermal values are forecast/model products rather than street observations. If thermal or traffic data is missing, the API reports its coverage state instead of blocking pedestrian routing.
