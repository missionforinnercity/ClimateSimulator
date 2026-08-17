#!/usr/bin/env python3
"""Build the compact, local-coordinate public transport viewer asset.

MyCiTi geometry and stops are authoritative supplied GIS records. Bus movement
times come from the supplied weekday PDFs where they can be extracted. Rail
times come from the supplied structured PRASA CSV; unmatched corridors retain
a clearly labelled planning-cadence fallback.
"""

from __future__ import annotations

import csv
import json
import math
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from pyproj import Transformer


ROOT = Path(__file__).resolve().parents[1]
TRANSPORT = ROOT / "data" / "transport"
OUT = ROOT / "public" / "assets" / "transport.json"
LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
TIME_RE = re.compile(r"\b([012]?\d):([0-5]\d)\b")
RAIL_SERVICE_START = 300
RAIL_SERVICE_END = 1230

# Keyed on the municipal TYPE field. Every one of these corridors terminates at
# Cape Town station, which is the only rail station inside the modelled view, so
# each is a usable origin corridor for an event in the CBD even when its own
# track geometry starts outside the scene.
RAIL_CORRIDORS = (
    ("SOUTHERN SUBURBS", "southern", "Southern Suburbs (Simon's Town)", "#e2544a"),
    ("STRAND", "strand", "Strand (via Bellville)", "#f0a63a"),
    ("MONTE VISTA", "monte-vista", "Monte Vista (via Century City)", "#3fb26e"),
    ("WELLINGTON", "wellington", "Wellington (via Bellville)", "#2f8fd6"),
    ("MULDERSVLEI", "muldersvlei", "Muldersvlei", "#8f6fd0"),
    ("CAPE FLATS", "cape-flats", "Cape Flats", "#c0824e"),
    ("KHAYELITSHA", "khayelitsha", "Khayelitsha", "#2ec2b4"),
    ("MITCHELL'S PLAIN", "mitchells-plain", "Mitchells Plain", "#d76ba8"),
    ("LAVIS", "lavis", "Bellville via Lavis", "#9ccb35"),
)


def minutes(value: str) -> int:
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def extract_direction(pdf: Path, page: int) -> dict | None:
    try:
        text = subprocess.run(
            ["pdftotext", "-f", str(page), "-l", str(page), "-layout", str(pdf), "-"],
            check=True, capture_output=True, text=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    direction = re.search(r"Direction:\s*(.+)", text)
    rows = []
    for line in text.splitlines():
        matches = list(TIME_RE.finditer(line))
        if len(matches) < 2:
            continue
        name = line[:matches[0].start()].replace("Dep", "").replace("Arr", "").strip()
        if not name or name.lower().startswith(("page ", "peak ", "saver ")):
            continue
        rows.append({"name": name, "times": [minutes(match.group(0)) for match in matches]})
    if len(rows) < 2:
        return None
    count = min(len(row["times"]) for row in rows)
    trips = []
    for index in range(count):
        start, end = rows[0]["times"][index], rows[-1]["times"][index]
        if end < start:
            end += 1440
        trips.append([start, end])
    plausible = [end - start for start, end in trips if 4 <= end - start <= 180]
    if plausible:
        plausible.sort()
        typical_duration = plausible[len(plausible) // 2]
        trips = [[start, end if 4 <= end - start <= 180 else start + typical_duration] for start, end in trips]
    else:
        # A few PDF tables split a wide set of columns across text blocks.
        # Keep their real departure columns but do not turn that extraction
        # artefact into an hours-long trip in the viewer.
        trips = [[start, start + 45] for start, _ in trips]
    return {
        "direction": direction.group(1).strip() if direction else rows[-1]["name"],
        "stops": [row["name"] for row in rows],
        "trips": trips,
    }


def point_segment_distance(point, start, end):
    px, pz = point
    ax, az = start
    bx, bz = end
    dx, dz = bx - ax, bz - az
    denominator = dx * dx + dz * dz
    amount = 0 if denominator == 0 else max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / denominator))
    x, z = ax + dx * amount, az + dz * amount
    return math.hypot(px - x, pz - z)


def line_length(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def stitch_lines(lines, tolerance=1.5):
    """Join the supplied rail fragments back into continuous polylines.

    Railway_Lines.geojson stores each corridor as hundreds of short segments
    (median 133 m in the CBD view). Drawn as-is they read as disconnected
    stubs, so shared endpoints are welded before anything is clipped or
    measured.
    """
    def cell(point):
        return round(point[0] / tolerance), round(point[1] / tolerance)

    endpoints: dict[tuple, list[tuple[int, int]]] = {}
    for index, line in enumerate(lines):
        endpoints.setdefault(cell(line[0]), []).append((index, 0))
        endpoints.setdefault(cell(line[-1]), []).append((index, 1))

    used = [False] * len(lines)
    chains = []
    for index, line in enumerate(lines):
        if used[index]:
            continue
        used[index] = True
        chain = list(line)
        for forward in (True, False):
            while True:
                tip = chain[-1] if forward else chain[0]
                candidate = None
                for other, end in endpoints.get(cell(tip), ()):
                    if used[other]:
                        continue
                    points = lines[other] if end == 0 else lines[other][::-1]
                    if math.dist(points[0], tip) <= tolerance:
                        candidate = (other, points)
                        break
                if candidate is None:
                    break
                other, points = candidate
                used[other] = True
                if forward:
                    chain.extend(points[1:])
                else:
                    chain[:0] = points[::-1][:-1]
        chains.append(chain)
    return sorted(chains, key=line_length, reverse=True)


def rail_cadence(offset: int) -> list[int]:
    """Weekday planning cadence, in minutes past midnight.

    This is an explicit planning assumption, not a published timetable: the
    supplied PRASA PDFs are page images. Peak headways are tighter than the
    interpeak so the event analysis reacts to when the event actually falls.
    """
    times, minute = [], RAIL_SERVICE_START + offset
    while minute <= RAIL_SERVICE_END:
        times.append(minute)
        peak = 360 <= minute < 510 or 960 <= minute < 1110
        minute += 20 if peak else 40
    return times


def prasa_corridor(line: str, stations: list[str]) -> str | None:
    """Map a PRASA train's published stopping pattern to a GIS corridor."""
    names = " | ".join(stations).upper()
    if line == "Southern Line":
        return "southern"
    if line == "Cape Flats Line":
        return "cape-flats"
    if line == "Northern Line (Monte Vista)":
        return "monte-vista"
    if line == "Malmesbury Line":
        return "wellington"
    if line == "Northern Line":
        return "strand" if "STRAND" in names or "SOMERSET" in names else "wellington"
    if line == "Central Line":
        if "KAPTEINSKLIP" in names or "MITCHELL" in names:
            return "mitchells-plain"
        if any(name in names for name in ("CHRIS HANI", "NOLUNGILE", "NONKQUBELA")):
            return "khayelitsha"
        return "lavis"
    return None


def load_prasa_schedules() -> tuple[dict[str, dict], str | None]:
    path = TRANSPORT / "prasa_schedules.csv"
    if not path.exists():
        return {}, None
    grouped: dict[tuple[str, str, str, str], list[dict]] = {}
    effective_dates = set()
    with path.open(newline="", encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            key = row["line"], row["direction"], row["day_type"], row["train_no"]
            grouped.setdefault(key, []).append(row)
            if row.get("effective_date"):
                effective_dates.add(row["effective_date"])

    result: dict[str, dict] = {}
    for (line, _direction, day_type, _train_no), rows in grouped.items():
        rows.sort(key=lambda row: int(row["station_sequence"]))
        stations = [row["station"].strip() for row in rows]
        corridor = prasa_corridor(line, stations)
        if corridor is None:
            continue
        if stations[0].upper() == "CAPE TOWN":
            movement, raw_time = "outboundDepartures", rows[0]["time"]
        elif stations[-1].upper() == "CAPE TOWN":
            movement, raw_time = "inboundArrivals", rows[-1]["time"]
        else:
            continue
        if not TIME_RE.fullmatch(raw_time.strip()):
            continue
        time = minutes(raw_time)
        days = ("weekday", "saturday") if day_type == "Weekday+Saturday" else (
            ("saturday", "sunday") if day_type == "Weekend" else ("weekday",)
        )
        corridor_data = result.setdefault(corridor, {
            day: {"outboundDepartures": [], "inboundArrivals": []}
            for day in ("weekday", "saturday", "sunday")
        })
        for day in days:
            corridor_data[day][movement].append(time)

    for corridor_data in result.values():
        for day_data in corridor_data.values():
            for movement in ("outboundDepartures", "inboundArrivals"):
                day_data[movement] = sorted(set(day_data[movement]))
    return result, max(effective_dates) if effective_dates else None


def main() -> None:
    manifest = json.loads((ROOT / "public" / "assets" / "manifest.json").read_text())
    origin_x, origin_y = manifest["origin"]
    left, bottom, right, top = manifest["bounds"]
    min_z, max_z = -top, -bottom
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)

    def local(coordinate):
        x, y = transformer.transform(float(coordinate[0]), float(coordinate[1]))
        return [round(x - origin_x, 1), round(-(y - origin_y), 1)]

    def in_view(point, padding=80):
        return left - padding <= point[0] <= right + padding and min_z - padding <= point[1] <= max_z + padding

    # Compact pedestrian graph used for true network-distance catchments.
    # Street centrelines are a planning proxy for sidewalks where dedicated
    # footways are absent; motorways and inaccessible ways are excluded.
    walk_nodes: list[list[float]] = []
    walk_node_index: dict[tuple[float, float], int] = {}
    walk_edges: dict[tuple[int, int], float] = {}

    def walk_node(point):
        key = round(point[0] * 2) / 2, round(point[1] * 2) / 2
        if key not in walk_node_index:
            walk_node_index[key] = len(walk_nodes)
            walk_nodes.append([key[0], key[1]])
        return walk_node_index[key]

    excluded_walk_classes = {"motorway", "motorway_link", "construction", "proposed", "raceway"}
    walk_source = ROOT / "data" / "osm_cbd_roads.geojson"
    if walk_source.exists():
        for feature in json.loads(walk_source.read_text())["features"]:
            props = feature.get("properties") or {}
            if props.get("highway") in excluded_walk_classes:
                continue
            coordinates = feature["geometry"].get("coordinates") or []
            points = [local(coordinate) for coordinate in coordinates]
            for a, b in zip(points, points[1:]):
                if not (in_view(a, 1400) or in_view(b, 1400)):
                    continue
                start, end = walk_node(a), walk_node(b)
                if start == end:
                    continue
                distance = round(math.dist(walk_nodes[start], walk_nodes[end]), 1)
                key = (min(start, end), max(start, end))
                walk_edges[key] = min(distance, walk_edges.get(key, math.inf))

    def clip_segment(start, end, padding):
        x0, z0 = start
        dx, dz = end[0] - x0, end[1] - z0
        bounds = (left - padding, right + padding, min_z - padding, max_z + padding)
        entering, leaving = 0.0, 1.0
        for direction, remaining in (
            (-dx, x0 - bounds[0]), (dx, bounds[1] - x0),
            (-dz, z0 - bounds[2]), (dz, bounds[3] - z0),
        ):
            if abs(direction) < 1e-9:
                if remaining < 0:
                    return None
                continue
            amount = remaining / direction
            if direction < 0:
                entering = max(entering, amount)
            else:
                leaving = min(leaving, amount)
            if entering > leaving:
                return None
        return (
            [round(x0 + dx * entering, 1), round(z0 + dz * entering, 1)],
            [round(x0 + dx * leaving, 1), round(z0 + dz * leaving, 1)],
        )

    def visible_runs(points, padding=20):
        runs, current = [], []
        for start, end in zip(points, points[1:]):
            clipped = clip_segment(start, end, padding)
            if clipped is None:
                if len(current) > 1:
                    runs.append(current)
                current = []
                continue
            clipped_start, clipped_end = clipped
            if current and math.dist(current[-1], clipped_start) < 0.25:
                current.append(clipped_end)
            else:
                if len(current) > 1:
                    runs.append(current)
                current = [clipped_start, clipped_end]
        if len(current) > 1:
            runs.append(current)
        return runs

    stop_source = json.loads((TRANSPORT / "MyCiTi_Bus_Stops.geojson").read_text())
    stops = []
    for feature in stop_source["features"]:
        point = local(feature["geometry"]["coordinates"])
        props = feature["properties"]
        if props.get("STOP_STS") == "Active" and in_view(point):
            stops.append({
                "id": str(props["OBJECTID"]), "name": props["STOP_NAME"], "point": point,
                "kind": "station" if "Station" in (props.get("STOP_TYPE") or "") else "stop",
                "shelter": props.get("STOP_DSCR") or "Unknown",
            })

    route_source = json.loads((TRANSPORT / "Integrated_rapid_transit_(IRT)_system_MyCiTi_Bus_Routes.geojson").read_text())
    routes = []
    direction_index: dict[str, int] = {}
    for feature in route_source["features"]:
        props = feature["properties"]
        route_id = str(props.get("RT_NMBR") or "").upper()
        coordinates = feature["geometry"]["coordinates"]
        source_lines = coordinates if feature["geometry"]["type"] == "MultiLineString" else [coordinates]
        local_lines = [local_line for source in source_lines if len(local_line := [local(point) for point in source]) > 1]
        runs = [run for line in local_lines for run in visible_runs(line)]
        if not runs:
            continue
        direction = direction_index.get(route_id, 0)
        direction_index[route_id] = direction + 1
        schedule = extract_direction(TRANSPORT / f"{route_id}-timetable.pdf", direction + 1)
        if schedule is None and route_id == "T02X":
            schedule = extract_direction(TRANSPORT / "T02X-timetable.pdf", direction + 1)
        flattened = max(runs, key=line_length)
        nearby = []
        for stop in stops:
            distance = min(point_segment_distance(stop["point"], a, b) for a, b in zip(flattened, flattened[1:]))
            if distance <= 42:
                nearby.append(stop["id"])
        routes.append({
            "id": f"{route_id}-{direction + 1}", "number": route_id,
            "name": props.get("RT_NAME") or route_id, "type": props.get("RT_TYPE") or "Bus",
            "direction": schedule["direction"] if schedule else ("Inbound" if direction else "Outbound"),
            "lines": runs, "stopIds": nearby,
            "trips": schedule["trips"] if schedule else [[value, value + 35] for value in range(360 + direction * 10, 1261, 30)],
            "timetableStops": schedule["stops"] if schedule else [],
            "confidence": "timetable" if schedule else "estimated-cadence",
        })

    def rail_corridor(raw_type):
        value = (raw_type or "").upper()
        for pattern, key, name, color in RAIL_CORRIDORS:
            if pattern in value:
                return key, name, color
        return None

    municipal_rail = json.loads((TRANSPORT / "Railway_Lines.geojson").read_text())
    corridor_sources: dict[str, dict] = {}
    operating_fragments = []
    for feature in municipal_rail["features"]:
        props = feature["properties"]
        if props.get("USG") != "OPERATING":
            continue
        coordinates = feature["geometry"]["coordinates"]
        source_lines = coordinates if feature["geometry"]["type"] == "MultiLineString" else [coordinates]
        fragments = [points for source in source_lines if len(points := [local(point) for point in source]) > 1]
        operating_fragments.extend(fragments)
        corridor = rail_corridor(props.get("TYPE"))
        if corridor is None:
            continue
        key, name, color = corridor
        record = corridor_sources.setdefault(key, {"id": key, "name": name, "color": color, "fragments": []})
        record["fragments"].extend(fragments)

    # The municipal corridor centrelines include generalised and freight
    # alignments that are up to 150 m off the track the scene actually draws.
    # The OSM layer build_scene.py renders is the reference: a run that does not
    # follow it would paint a service line across roads and buildings.
    reference_path = ROOT / "data" / "osm_cbd_railways.geojson"
    reference_segments = []
    if reference_path.exists():
        for feature in json.loads(reference_path.read_text())["features"]:
            if feature["properties"].get("railway") != "rail":
                continue
            geometry = feature["geometry"]
            lines = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
            for line in lines:
                points = [local(point) for point in line]
                reference_segments.extend(zip(points, points[1:]))

    def follows_track(run, tolerance=25.0):
        if not reference_segments:
            return True
        offsets = sorted(
            min(point_segment_distance(point, a, b) for a, b in reference_segments)
            for point in run
        )
        return offsets[len(offsets) // 2] <= tolerance

    # The physical track layer. Every operating track is stitched and clipped so
    # the Cape Town station throat renders as the fan of tracks it actually is,
    # instead of a service line being stretched over it.
    rail_tracks = [
        run for chain in stitch_lines(operating_fragments)
        for run in visible_runs(chain, 15) if line_length(run) >= 20 and follows_track(run, 40.0)
    ]

    for record in corridor_sources.values():
        record["chains"] = stitch_lines(record["fragments"])
        # A corridor's in-view service line has to be a through movement that
        # sits on real track, not a 40 m siding stub or a generalised centreline.
        record["runs"] = sorted(
            (run for chain in record["chains"] for run in visible_runs(chain, 15)
             if line_length(run) >= 150 and follows_track(run)),
            key=line_length, reverse=True,
        )

    station_source = json.loads((TRANSPORT / "Railway_Stations.geojson").read_text())
    rail_stations = []
    for feature in station_source["features"]:
        point = local(feature["geometry"]["coordinates"])
        matches = []
        for key, corridor in corridor_sources.items():
            nearest = min(
                (point_segment_distance(point, a, b) for line in corridor["chains"] for a, b in zip(line, line[1:])),
                default=math.inf,
            )
            if nearest <= 450:
                matches.append((nearest, key))
        matches.sort()
        rail_stations.append({
            "id": f"rail-station-{feature['properties']['OBJECTID']}",
            "name": feature["properties"].get("NAME") or "Rail station",
            "point": point, "inView": in_view(point, 20),
            "corridors": [key for _, key in matches[:2]],
        })

    hub = next(
        (station for station in rail_stations if station["inView"] and "CAPE TOWN" in station["name"].upper()),
        next((station for station in rail_stations if station["inView"]), None),
    )

    prasa_schedules, prasa_effective_date = load_prasa_schedules()
    rail = []
    for index, key, name, color in ((index, *entry[1:]) for index, entry in enumerate(RAIL_CORRIDORS)):
        corridor = corridor_sources.get(key)
        if corridor is None:
            continue
        station_ids = [station["id"] for station in rail_stations if key in station["corridors"]]
        if hub and hub["id"] not in station_ids:
            station_ids.append(hub["id"])
        schedule = prasa_schedules.get(key)
        fallback_departures = rail_cadence(index * 3)
        weekday = schedule.get("weekday") if schedule else None
        departures = (weekday or {}).get("outboundDepartures") or fallback_departures
        arrivals = (weekday or {}).get("inboundArrivals") or departures
        rail.append({
            "id": key, "name": name, "color": color,
            # Movement geometry: present only where the corridor is actually in
            # the scene. Corridors that reach the CBD over shared trunk track
            # still plan as origin corridors through the hub station.
            "line": corridor["runs"][0] if corridor["runs"] else None,
            "lines": corridor["runs"],
            "inView": bool(corridor["runs"]),
            "stationIds": station_ids,
            "hubStationId": hub["id"] if hub else None,
            "departures": departures,
            "arrivals": arrivals,
            "fallbackDepartures": fallback_departures,
            "schedule": schedule,
            "trips": [[value, value + 14] for value in departures],
            "firstDeparture": min(departures), "lastDeparture": max(departures),
            "confidence": "published-timetable" if schedule else "planning-estimate",
        })

    # Cape Town Station is a multi-part building, not a point. Preserve every
    # mapped component of the named OSM station outline and its public entrance
    # nodes. Walking analysis routes to the nearest entrance, never to an
    # arbitrary platform or track point.
    city_model = json.loads((ROOT / "public" / "assets" / "city_model.json").read_text())
    station_footprints = [
        item["geometry"]["footprint"]
        for key, item in city_model.get("cityObjects", {}).items()
        if item.get("type") == "Building" and "osm-way-424212273" in key
    ]
    station_entrances = []
    osm_path = ROOT / "data" / "osm_cbd.osm.xml"
    if station_footprints and osm_path.exists():
        station_points = [point for ring in station_footprints for point in ring]
        station_bounds = (
            min(point[0] for point in station_points), min(point[1] for point in station_points),
            max(point[0] for point in station_points), max(point[1] for point in station_points),
        )
        root = ET.parse(osm_path).getroot()
        for node in root.findall("node"):
            tags = {tag.attrib["k"]: tag.attrib["v"] for tag in node.findall("tag")}
            if tags.get("entrance") in (None, "no") or tags.get("access") in ("no", "private") or tags.get("foot") == "no":
                continue
            point = local([node.attrib["lon"], node.attrib["lat"]])
            if not (station_bounds[0] - 40 <= point[0] <= station_bounds[2] + 40
                    and station_bounds[1] - 40 <= point[1] <= station_bounds[3] + 40):
                continue
            edge_distance = min(
                point_segment_distance(point, a, b)
                for ring in station_footprints for a, b in zip(ring, ring[1:] + ring[:1])
            )
            if edge_distance <= 35:
                station_entrances.append({
                    "id": node.attrib["id"], "point": point,
                    "kind": "main" if tags.get("entrance") == "main" else "entrance",
                    "wheelchair": tags.get("wheelchair") == "yes",
                })

    # Collapse duplicate door nodes while preserving entrances on distinct
    # sides of the building.
    distinct_entrances = []
    for entrance in sorted(station_entrances, key=lambda item: item["kind"] != "main"):
        if all(math.dist(entrance["point"], kept["point"]) >= 12 for kept in distinct_entrances):
            distinct_entrances.append(entrance)
    station_entrances = distinct_entrances

    payload = {
        "version": 4,
        "generatedAt": manifest.get("generatedAt"),
        "disclaimer": "Vehicle positions are timetable-derived estimates, not live AVL/GPS telemetry.",
        "sources": {
            "busGeometry": "City of Cape Town MyCiTi route and stop GIS files supplied in data/transport",
            "busTimes": "Supplied MyCiTi weekday timetable PDFs",
            "railGeometry": "Supplied City of Cape Town Railway_Lines and Railway_Stations GIS files",
            "railTimes": "Supplied structured PRASA schedule CSV",
        },
        "prasaEffectiveDate": prasa_effective_date,
        "railService": {
            "start": RAIL_SERVICE_START, "end": RAIL_SERVICE_END,
            "note": "Published PRASA times where matched; planning cadence only on unmatched GIS corridors.",
        },
        "hubStationId": hub["id"] if hub else None,
        "hubFootprints": station_footprints,
        "hubEntrances": station_entrances,
        "walkNetwork": {"nodes": walk_nodes, "edges": [[a, b, length] for (a, b), length in walk_edges.items()]},
        "stops": stops, "routes": routes, "rail": rail,
        "railStations": rail_stations, "railTracks": rail_tracks,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(
        f"Wrote {OUT}: {len(routes)} route directions, {len(stops)} bus stops, "
        f"{len(rail)} rail corridors ({sum(1 for item in rail if item['inView'])} with in-view track), "
        f"{len(rail_tracks)} track runs, {len(rail_stations)} rail stations"
    )


if __name__ == "__main__":
    main()
