"""Live traffic conditions (TomTom) and SUMO-based lane-closure impact simulation.

Mirrors the caching shape of ``server/weather.py`` for the live-conditions
half, and the ``lru_cache``-memoized-parse shape of ``server/mitigation.py``/
``server/flood.py`` for the road-network half. The closure simulation itself
runs two SUMO microsimulations (via ``traci``) against the same synthetic
demand -- one with the target road untouched, one with a lane (or the whole
road) closed -- and diffs the resulting trip metrics.

Three deliberate scoping choices keep this both watchable and honest:

* **Corridor, not city.** Demand is generated only between edges within
  ``CORRIDOR_RADIUS_M`` of the selected road *and* inside the visible terrain
  footprint. Spreading a few hundred vehicles over the whole 1,900-edge
  network put roughly half of them off the rendered map and left the rest too
  sparse to read as traffic; concentrating the same budget on one corridor
  gives a dense, legible stream where the user is actually looking.
* **Time of day, not just "now".** Scenarios scale demand and bias trip
  direction (inbound to the CBD in the morning, outbound in the afternoon),
  so a closure can be compared at peak and off-peak.
* **Selectable junction control.** Mapped SUMO signal programs are retained
  by default; a priority-right-of-way comparison mode switches them off.

This is an estimate, not a calibrated traffic model: demand is synthetic,
scaled by road class, time-of-day profile and live TomTom congestion, not
real origin-destination counts.
"""

from __future__ import annotations

import json
import math
import os
import random
import re
import tempfile
import threading
import time
import xml.etree.ElementTree as ElementTree
import zlib
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.ops import transform as transform_geometry, unary_union
from shapely.strtree import STRtree

from .field import LOCAL_CRS, WEB_CRS, load_viewer_config

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ROADS_PATH = PROJECT_ROOT / "data" / "osm_cbd_roads.geojson"
SUMO_NET_PATH = PROJECT_ROOT / "data" / "sumo" / "cbd.net.xml"
SCENE_FOOTPRINT_PATH = PROJECT_ROOT / "data" / "scene_footprint.geojson"
CITY_MODEL_PATH = PROJECT_ROOT / "public" / "assets" / "city_model.json"

TOMTOM_PROVIDER = "TomTom Traffic Flow"
TOMTOM_BASE_URL = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"
CACHE_SECONDS = 300
SAMPLE_ROAD_LIMIT = 16

# Highway classes that carry general vehicle traffic; footways, steps, tracks
# etc. are excluded from both the live sample and the closable-road list.
VEHICLE_HIGHWAY_CLASSES = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service", "busway",
}
_HIGHWAY_PRIORITY = {"motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4}

SIM_STEP_LENGTH_S = 1.0
# 3 s of simulated time per stored sample: fine enough that the viewer's
# linear interpolation between samples still looks like a car following a
# street rather than cutting corners, without inflating the payload.
TRAJECTORY_SAMPLE_INTERVAL_S = 3
# Cap how many vehicles are followed *at once* rather than in total. A total
# cap silently thins the animation out over the run -- once it is reached no
# newly departed vehicle is ever recorded again, so the last minutes play
# back nearly empty. Capping concurrency keeps the street equally busy from
# start to finish, and the total is a separate payload guard.
MAX_CONCURRENT_TRACKED = 500
MAX_TOTAL_TRACKS = 3200
# closure_preview runs two full SUMO simulations synchronously inside a
# single HTTP request, so these are deliberately conservative: a 5-15
# simulated-minute run finishes in low tens of seconds end-to-end (measured
# on this network).
DEFAULT_DURATION_MIN = 10.0
MIN_DURATION_MIN = 5.0
MAX_DURATION_MIN = 20.0
# Wall-clock safety net per SUMO run, independent of simulated duration --
# an unlucky random seed or pathological road closure could in principle
# make rerouting far more expensive than the common case; this keeps a
# synchronous API request bounded rather than hanging indefinitely.
SIMULATION_WALL_CLOCK_BUDGET_S = 45.0

# How far either side of the selected road counts as "the corridor". 250 m
# is roughly one CBD block, enough to contain the parallel streets traffic
# actually diverts onto when a lane closes, without spreading the vehicle
# budget so thin that the street looks deserted.
CORRIDOR_RADIUS_M = 250.0
MIN_CORRIDOR_EDGES = 12
# Vehicles inserted per simulated minute at demand scale 1.0. Tuned against a
# demand sweep on the Bree Street corridor: this holds roughly 300 cars on
# screen at once -- dense enough to read as weekday CBD traffic -- while
# still letting most trips complete. Pushing it far higher saturates the
# unsignalised junctions, and once vehicles stop completing at all the
# before/after comparison inverts, because only the easiest trips finish.
BASE_VEHICLES_PER_MIN = 160.0
# Representative weekday CBD fleet. These remain in SUMO's passenger class
# so every type obeys the same lane closure, while physical and behavioural
# differences change queue storage and junction discharge.
FLEET_MIX = {
    "car": 0.68,
    "minibus_taxi": 0.18,
    "delivery_van": 0.09,
    "city_shuttle": 0.05,
}
# Stop inserting vehicles partway through the window so the last departures
# still have time to arrive. Otherwise trips that simply ran out of clock are
# counted as incomplete, which muddies the completion ratio the closure
# impact is read from.
DEPARTURE_WINDOW_FRACTION = 0.7
# After the animated window ends, keep stepping (without recording positions)
# until the vehicles still en route arrive. Scoring at the end of the window
# instead would count "hasn't arrived yet" as "couldn't arrive", which is the
# difference between a closure looking mildly disruptive and looking
# impossible -- and, worse, makes a severe closure appear to *speed traffic
# up*, because the trips it delays are the ones that get truncated away.
DRAIN_FACTOR = 1.5

# Time-of-day demand profiles. `inbound_bias` runs -1..1: +1 sends most trips
# toward the CBD core (morning commute), -1 away from it (afternoon), 0 is
# undirected. These are representative weekday shapes for the Cape Town CBD,
# not counts from a traffic survey.
SCENARIOS: dict[str, dict[str, Any]] = {
    "am_peak": {
        "label": "Morning peak · 07:00–09:00",
        "demand_scale": 1.0,
        "inbound_bias": 0.75,
        "free_flow_ratio": 0.45,
    },
    "midday": {
        "label": "Midday off-peak · 11:00–14:00",
        "demand_scale": 0.45,
        "inbound_bias": 0.0,
        "free_flow_ratio": 0.8,
    },
    "pm_peak": {
        "label": "Afternoon peak · 16:00–18:00",
        "demand_scale": 1.0,
        "inbound_bias": -0.75,
        "free_flow_ratio": 0.4,
    },
    "evening": {
        "label": "Evening · 19:00–21:00",
        "demand_scale": 0.3,
        "inbound_bias": -0.3,
        "free_flow_ratio": 0.9,
    },
    "live": {
        "label": "Live conditions now",
        "demand_scale": None,  # derived from the TomTom snapshot
        "inbound_bias": 0.0,
        "free_flow_ratio": None,
    },
}
DEFAULT_SCENARIO = "am_peak"

CLOSURE_MODES = ("lane", "full")
DEFAULT_CLOSURE_MODE = "lane"
CLOSURE_SCOPES = ("block", "road")
DEFAULT_CLOSURE_SCOPE = "block"
TRAFFIC_CONTROLS = ("signalized", "priority")
DEFAULT_TRAFFIC_CONTROL = "signalized"
MIN_DEMAND_MULTIPLIER = 0.5
MAX_DEMAND_MULTIPLIER = 1.5

_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cache_monotonic = 0.0


# --------------------------------------------------------------------------
# Road-network parsing (data/osm_cbd_roads.geojson)
# --------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _road_features() -> tuple[dict[str, Any], ...]:
    if not ROADS_PATH.exists():
        return ()
    collection = json.loads(ROADS_PATH.read_text(encoding="utf-8"))
    return tuple(collection.get("features", []))


@lru_cache(maxsize=1)
def named_roads() -> tuple[dict[str, Any], ...]:
    """Distinct named, vehicle-carrying roads with a representative sample point."""
    config = load_viewer_config()
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = config["origin"]
    footprint = _scene_footprint_local()
    by_name: dict[str, list[dict[str, Any]]] = {}
    for feature in _road_features():
        properties = feature.get("properties") or {}
        name = properties.get("name")
        highway = properties.get("highway")
        if not name or highway not in VEHICLE_HIGHWAY_CLASSES:
            continue
        by_name.setdefault(name, []).append(feature)

    roads = []
    for name in sorted(by_name):
        features = by_name[name]
        coordinates = features[0]["geometry"]["coordinates"]
        longitude, latitude = coordinates[len(coordinates) // 2]
        projected_x, projected_y = transformer.transform(longitude, latitude)
        local_x, local_z = projected_x - origin_x, -(projected_y - origin_y)
        highway_classes = sorted({(f.get("properties") or {}).get("highway") for f in features})
        geometry_local = []
        direction_segments = []
        for feature in features:
            points = []
            for lon, lat, *_ in feature.get("geometry", {}).get("coordinates", []):
                x, y = transformer.transform(lon, lat)
                points.append([round(x - origin_x, 1), round(-(y - origin_y), 1)])
            if len(points) >= 2:
                source_line = LineString(points)
                clipped = source_line.intersection(footprint)
                parts = clipped.geoms if clipped.geom_type == "MultiLineString" else (clipped,)
                for part in parts:
                    if not part.is_empty and len(part.coords) >= 2:
                        part_points = list(part.coords)
                        # GEOS does not promise to retain source-line order
                        # after clipping. Restore it before exposing arrows.
                        if source_line.project(Point(part_points[0])) > source_line.project(Point(part_points[-1])):
                            part_points.reverse()
                        oneway = str((feature.get("properties") or {}).get("oneway") or "").lower()
                        if oneway == "-1":
                            part_points.reverse()
                        rounded = [[round(x, 1), round(z, 1)] for x, z in part_points]
                        geometry_local.append(rounded)
                        direction_segments.append({
                            "points": rounded,
                            "direction": "oneway" if oneway in {"yes", "true", "1", "-1"} else "both",
                        })
        roads.append(
            {
                "name": name,
                "highway": highway_classes[0] if len(highway_classes) == 1 else highway_classes,
                "segment_count": len(features),
                "sample_point": {"lon": longitude, "lat": latitude},
                "local": {"x": local_x, "z": local_z},
                "geometry_local": geometry_local,
                "direction_segments": direction_segments,
            }
        )
    return tuple(roads)


@lru_cache(maxsize=1)
def permanent_road_statuses() -> tuple[dict[str, Any], ...]:
    """Permanent non-motorised road segments for the viewer status layer.

    The lightweight scene asset intentionally stores only road class and
    geometry. This API preserves names and access semantics so a user can
    distinguish a pedestrian street from an ordinary narrow road.
    """
    config = load_viewer_config()
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = config["origin"]
    footprint = _scene_footprint_local()
    statuses = []
    for index, feature in enumerate(_road_features()):
        properties = feature.get("properties") or {}
        highway = properties.get("highway")
        if highway != "pedestrian":
            continue
        coordinates = feature.get("geometry", {}).get("coordinates") or []
        points = []
        for longitude, latitude, *_ in coordinates:
            x, y = transformer.transform(longitude, latitude)
            points.append([round(x - origin_x, 1), round(-(y - origin_y), 1)])
        if len(points) < 2:
            continue
        clipped = LineString(points).intersection(footprint)
        parts = clipped.geoms if clipped.geom_type == "MultiLineString" else (clipped,)
        for part_index, part in enumerate(parts):
            if part.is_empty or len(part.coords) < 2:
                continue
            statuses.append({
                "id": f"osm-pedestrian-{index}-{part_index}",
                "name": properties.get("name") or "Pedestrian street",
                "status": "pedestrianised",
                "closure_type": "permanent",
                "vehicle_access": False,
                "pedestrian_access": True,
                "source": "OpenStreetMap",
                "points": [[round(x, 1), round(z, 1)] for x, z in part.coords],
            })
    return tuple(statuses)


def _sample_road_points(limit: int = SAMPLE_ROAD_LIMIT) -> tuple[dict[str, Any], ...]:
    """Pick a highway-class-ranked sample of named roads for the live snapshot."""
    ranked = sorted(
        (road for road in named_roads() if isinstance(road["highway"], str)),
        key=lambda road: _HIGHWAY_PRIORITY.get(road["highway"], 5),
    )
    return tuple(ranked[:limit])


# --------------------------------------------------------------------------
# Live conditions (TomTom Traffic Flow), cached like server/weather.py
# --------------------------------------------------------------------------


def _fetch_json(url: str, timeout: float = 8.0) -> dict[str, Any]:
    with urlopen(url, timeout=timeout) as response:  # noqa: S310 - configurable trusted provider
        if getattr(response, "status", 200) != 200:
            raise RuntimeError(f"traffic provider returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def _tomtom_api_key() -> str:
    key = os.environ.get("TOMTOM_API")
    if not key:
        raise RuntimeError("TOMTOM_API is not configured in the environment")
    return key


def _fetch_flow_segment(latitude: float, longitude: float, api_key: str) -> dict[str, Any] | None:
    base_url = os.environ.get("TOMTOM_API_BASE_URL", TOMTOM_BASE_URL)
    parameters = {"point": f"{latitude:.6f},{longitude:.6f}", "unit": "KMPH", "key": api_key}
    payload = _fetch_json(f"{base_url}?{urlencode(parameters)}")
    return payload.get("flowSegmentData")


def _congestion_level(average_ratio: float) -> str:
    if average_ratio >= 0.85:
        return "free_flow"
    if average_ratio >= 0.65:
        return "moderate"
    if average_ratio >= 0.4:
        return "heavy"
    return "severe"


def _normalize_live(sample_roads: tuple[dict[str, Any], ...], fetched_at: str) -> dict[str, Any]:
    api_key = _tomtom_api_key()
    per_road = []
    for road in sample_roads:
        point = road["sample_point"]
        try:
            segment = _fetch_flow_segment(point["lat"], point["lon"], api_key)
        except Exception:
            continue
        if not segment:
            continue
        current_speed = float(segment.get("currentSpeed") or 0.0)
        free_flow_speed = float(segment.get("freeFlowSpeed") or 0.0)
        ratio = current_speed / free_flow_speed if free_flow_speed > 0 else None
        per_road.append(
            {
                "name": road["name"],
                "highway": road["highway"],
                "current_speed_kmh": current_speed,
                "free_flow_speed_kmh": free_flow_speed,
                "speed_ratio": ratio,
                "confidence": segment.get("confidence"),
                "road_closure": bool(segment.get("roadClosure", False)),
            }
        )
    if not per_road:
        raise RuntimeError("TomTom did not return usable flow data for any sampled road")

    ratios = [road["speed_ratio"] for road in per_road if road["speed_ratio"] is not None]
    average_ratio = sum(ratios) / len(ratios) if ratios else 1.0
    return {
        "provider": TOMTOM_PROVIDER,
        "provider_url": "https://www.tomtom.com/traffic-index/",
        "data_kind": "live_flow_segment_sample",
        "fetched_at": fetched_at,
        "stale": False,
        "sampled_roads": per_road,
        "sampled_count": len(per_road),
        "requested_count": len(sample_roads),
        "average_speed_ratio": average_ratio,
        "congestion_level": _congestion_level(average_ratio),
    }


def clear_traffic_cache() -> None:
    """Test/helper hook; production callers normally rely on the TTL."""
    global _cache, _cache_monotonic
    with _lock:
        _cache = None
        _cache_monotonic = 0.0


def current_traffic(force: bool = False) -> dict[str, Any]:
    """Return a normalized live-conditions snapshot, falling back to stale cached data."""
    global _cache, _cache_monotonic
    now = time.monotonic()
    with _lock:
        if _cache is not None and not force and now - _cache_monotonic < CACHE_SECONDS:
            return {**_cache, "stale": False}

        sample_roads = _sample_road_points()
        fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            normalized = _normalize_live(sample_roads, fetched_at)
        except Exception as error:
            if _cache is None:
                raise RuntimeError(f"current traffic unavailable: {error}") from error
            return {
                **_cache,
                "stale": True,
                "warning": f"Live refresh failed; showing the last successful response ({error}).",
            }

        _cache = normalized
        _cache_monotonic = now
        return dict(normalized)


# --------------------------------------------------------------------------
# SUMO network + closure-impact simulation
# --------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _sumo_net() -> Any:
    if not SUMO_NET_PATH.exists():
        raise RuntimeError(
            "SUMO network not found; run `python scripts/build_sumo_network.py` first"
        )
    import sumolib

    return sumolib.net.readNet(str(SUMO_NET_PATH))


def resolve_road_edges(road_name: str) -> list[str]:
    net = _sumo_net()
    matches = [edge.getID() for edge in net.getEdges() if edge.getName() == road_name]
    if not matches:
        raise ValueError(f"unknown road name: {road_name!r}")
    return matches


def _demand_scale(average_speed_ratio: float) -> float:
    """Heavier live congestion (lower speed ratio) -> more simulated demand.

    Only used by the ``live`` scenario; the fixed time-of-day profiles carry
    their own demand scale. Rough heuristic, not a calibrated OD count -- see
    validation_status in the closure_preview response.
    """
    ratio = max(0.15, min(1.0, average_speed_ratio))
    return max(0.4, min(2.0, 1.9 - ratio * 1.5))


@lru_cache(maxsize=1)
def _scene_footprint_local() -> Any:
    """The visible terrain polygon, in viewer-local metres.

    Roughly half the SUMO network lies outside the rendered terrain, so this
    is what keeps generated demand on ground the user can actually see.
    """
    collection = json.loads(SCENE_FOOTPRINT_PATH.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = load_viewer_config()["origin"]
    polygons = []
    for feature in collection.get("features", []):
        projected = transform_geometry(
            lambda x, y, z=None: transformer.transform(x, y),
            shape(feature["geometry"]),
        )
        local = transform_geometry(
            lambda x, y, z=None: (x - origin_x, -(y - origin_y)),
            projected,
        )
        if not local.is_empty:
            polygons.append(local)
    if not polygons:
        raise RuntimeError(f"no usable scene footprint in {SCENE_FOOTPRINT_PATH}")
    return unary_union(polygons)


def _normalise_road_name(value: Any) -> str:
    """Normalise OSM and municipal naming conventions for spatial matching."""
    words = re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper()).split()
    suffixes = {
        "ST", "STREET", "RD", "ROAD", "AVE", "AVENUE", "BLVD", "BOULEVARD",
        "DR", "DRIVE", "LN", "LANE", "WAY", "SQ", "SQUARE", "CRESCENT",
        "CIRCLE", "TERRACE", "QUAY", "PLEIN", "RAMP", "PASS",
    }
    while words and words[-1] in suffixes:
        words.pop()
    return " ".join(words)


@lru_cache(maxsize=1)
def _city_objects() -> tuple[dict[str, Any], ...]:
    if not CITY_MODEL_PATH.exists():
        return ()
    model = json.loads(CITY_MODEL_PATH.read_text(encoding="utf-8"))
    return tuple(model.get("cityObjects", {}).values())


@lru_cache(maxsize=1)
def _municipal_road_records() -> tuple[dict[str, Any], ...]:
    """Clipped City road-centre records already embedded in the scene asset."""
    records = []
    for item in _city_objects():
        if "municipalRoads" not in item.get("sources", []):
            continue
        points = (item.get("geometry") or {}).get("centerline") or []
        if len(points) < 2:
            continue
        attributes = item.get("attributes") or {}
        try:
            lanes = max(1, int(attributes.get("lanes") or 1))
        except (TypeError, ValueError):
            lanes = 1
        try:
            speed_limit_kph = float(attributes.get("speedLimitKph"))
        except (TypeError, ValueError):
            speed_limit_kph = None
        records.append({
            "id": item.get("identifier"),
            "line": LineString(points),
            "name": attributes.get("name"),
            "normalised_name": _normalise_road_name(attributes.get("name")),
            "road_class": attributes.get("class"),
            "right_of_way_class": attributes.get("rightOfWayClass"),
            "route_number": attributes.get("routeNumber"),
            "lane_count": lanes,
            "speed_limit_kph": speed_limit_kph,
            "speed_limit_source": attributes.get("speedLimitSource"),
            "surface": attributes.get("surface"),
            "one_way": attributes.get("oneWay"),
            "bus": attributes.get("bus"),
            "owner": attributes.get("owner"),
        })
    return tuple(records)


@lru_cache(maxsize=1)
def _street_activity_records() -> tuple[dict[str, Any], ...]:
    """Mapped kerbside and crossing inventory clipped into viewer coordinates."""
    records = []
    for item in _city_objects():
        attributes = item.get("attributes") or {}
        activity_type = attributes.get("class")
        if activity_type not in {"parkingSpace", "pedestrianCrossing"}:
            continue
        coordinates = (item.get("geometry") or {}).get("coordinates")
        if not coordinates or len(coordinates) < 2:
            continue
        records.append({
            "id": item.get("identifier"),
            "type": activity_type,
            "point": Point(float(coordinates[0]), float(coordinates[1])),
            "raised": bool(attributes.get("RAISED")),
        })
    return tuple(records)


def _street_activity_summary(corridor: list[dict[str, Any]]) -> dict[str, Any]:
    """Count mapped street activity near simulated roads without inventing demand."""
    if not corridor:
        return {"parking_spaces": 0, "pedestrian_crossings": 0, "raised_crossings": 0}
    road_area = unary_union([record["line"] for record in corridor]).buffer(18.0)
    nearby = [record for record in _street_activity_records() if road_area.covers(record["point"])]
    return {
        "parking_spaces": sum(record["type"] == "parkingSpace" for record in nearby),
        "pedestrian_crossings": sum(record["type"] == "pedestrianCrossing" for record in nearby),
        "raised_crossings": sum(
            record["type"] == "pedestrianCrossing" and record["raised"] for record in nearby
        ),
        "simulation_effect": "context_only_not_modelled_as_demand_or_delay",
        "note": "Mapped inventory near corridor roads; no occupancy or pedestrian counts are available.",
    }


def _speed_limit_overrides(corridor: list[dict[str, Any]]) -> tuple[dict[str, float], dict[str, int]]:
    """Return municipal speed overrides, retaining confidence counts.

    Confirmed and inferred City records are both useful for an exploratory
    comparison. Records without a declared source remain excluded so an empty
    or ambiguous value cannot silently alter the network.
    """
    overrides: dict[str, float] = {}
    counts = {"confirmed": 0, "inferred": 0}
    for record in corridor:
        municipal = record.get("municipal") or {}
        source = str(municipal.get("speed_limit_source") or "").lower()
        speed_kph = municipal.get("speed_limit_kph")
        if source not in counts or not speed_kph:
            continue
        speed_mps = float(speed_kph) / 3.6
        if not 5.0 <= speed_mps <= 40.0:
            continue
        overrides[record["id"]] = speed_mps
        counts[source] += 1
    return overrides, counts


@lru_cache(maxsize=1)
def _municipal_road_tree() -> STRtree | None:
    records = _municipal_road_records()
    return STRtree([record["line"] for record in records]) if records else None


def _line_alignment(first: LineString, second: LineString) -> float:
    def direction(line: LineString) -> tuple[float, float]:
        start, end = line.coords[0], line.coords[-1]
        dx, dz = end[0] - start[0], end[1] - start[1]
        length = math.hypot(dx, dz) or 1.0
        return dx / length, dz / length

    ax, az = direction(first)
    bx, bz = direction(second)
    return abs(ax * bx + az * bz)


def _municipal_match(line: LineString, road_name: Any) -> dict[str, Any] | None:
    """Find the best nearby, parallel City centreline for one SUMO edge."""
    records = _municipal_road_records()
    tree = _municipal_road_tree()
    if tree is None:
        return None
    candidate_indices = tree.query(line.buffer(24.0))
    wanted_name = _normalise_road_name(road_name)
    best: tuple[float, dict[str, Any]] | None = None
    for raw_index in candidate_indices:
        candidate = records[int(raw_index)]
        distance = line.distance(candidate["line"])
        if distance > 24.0:
            continue
        alignment = _line_alignment(line, candidate["line"])
        names_match = bool(wanted_name and candidate["normalised_name"] == wanted_name)
        # At junctions several centre-lines can be equally close. Parallelism
        # and a normalised name match prevent snapping to the crossing street.
        score = distance + (1.0 - alignment) * 18.0 + (0.0 if names_match else 12.0)
        if best is None or score < best[0]:
            best = (score, candidate)
    return best[1] if best else None


def _longest_line(geometry: Any) -> LineString | None:
    if geometry.geom_type == "LineString":
        return geometry if len(geometry.coords) >= 2 else None
    parts = [part for part in getattr(geometry, "geoms", ()) if part.geom_type == "LineString"]
    return max(parts, key=lambda part: part.length) if parts else None


@lru_cache(maxsize=1)
def _edge_index() -> dict[str, dict[str, Any]]:
    """Every passenger-carrying edge, pre-projected into viewer-local metres.

    Projecting on demand inside the request would repeat this for each of the
    ~1,900 edges on every preview; doing it once at import-time cost keeps
    corridor selection to pure geometry.
    """
    net = _sumo_net()
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = load_viewer_config()["origin"]
    footprint = _scene_footprint_local()
    records: dict[str, dict[str, Any]] = {}
    for edge in net.getEdges():
        if not edge.allows("passenger"):
            continue
        points = []
        for x, y in edge.getShape():
            longitude, latitude = net.convertXY2LonLat(x, y)
            projected_x, projected_y = transformer.transform(longitude, latitude)
            points.append((projected_x - origin_x, -(projected_y - origin_y)))
        if len(points) < 2:
            continue
        source_line = LineString(points)
        clipped = source_line.intersection(footprint)
        if clipped.is_empty:
            continue
        if clipped.geom_type == "MultiLineString":
            line = max(clipped.geoms, key=lambda part: part.length)
        elif clipped.geom_type == "LineString":
            line = clipped
        else:
            continue
        midpoint = line.interpolate(0.5, normalized=True)
        municipal = _municipal_match(line, edge.getName())
        snap_line = line
        if municipal:
            official_near_edge = _longest_line(municipal["line"].intersection(line.buffer(18.0)))
            if official_near_edge is not None and official_near_edge.length >= 3.0:
                snap_line = official_near_edge
        records[edge.getID()] = {
            "id": edge.getID(),
            "name": edge.getName(),
            "line": line,
            "midpoint": midpoint,
            "lane_count": edge.getLaneNumber(),
            "length_m": edge.getLength(),
            "speed_mps": edge.getSpeed(),
            "visible": footprint.covers(midpoint),
            "snap_line": snap_line,
            "municipal": municipal,
        }
    return records


def corridor_edges(road_name: str, radius_m: float = CORRIDOR_RADIUS_M) -> list[dict[str, Any]]:
    """Visible edges within `radius_m` of the named road, including the road itself."""
    index = _edge_index()
    focus_ids = [edge_id for edge_id in resolve_road_edges(road_name) if edge_id in index]
    return corridor_edges_for_ids(focus_ids, road_name, radius_m)


def corridor_edges_for_ids(
    focus_ids: list[str],
    selection_label: str = "drawn closure",
    radius_m: float = CORRIDOR_RADIUS_M,
) -> list[dict[str, Any]]:
    """Visible edges around an exact set of user-selected SUMO edges."""
    index = _edge_index()
    focus_ids = [edge_id for edge_id in dict.fromkeys(focus_ids) if edge_id in index]
    if not focus_ids:
        raise ValueError(f"{selection_label!r} has no drivable edges in the simulation network")
    catchment = unary_union([index[edge_id]["line"] for edge_id in focus_ids]).buffer(radius_m)
    corridor = [
        record for record in index.values()
        if record["visible"] and record["line"].intersects(catchment)
    ]
    if len(corridor) < MIN_CORRIDOR_EDGES:
        # A road hugging the edge of the LiDAR footprint can leave too little
        # visible network to route between; widening beats failing outright.
        catchment = catchment.buffer(radius_m)
        corridor = [
            record for record in index.values()
            if record["visible"] and record["line"].intersects(catchment)
        ]
    if len(corridor) < MIN_CORRIDOR_EDGES:
        raise ValueError(
            f"{selection_label!r} does not have enough visible surrounding network to simulate"
        )
    return corridor


@lru_cache(maxsize=1)
def drawable_road_edges() -> tuple[dict[str, Any], ...]:
    """Visible SUMO edge geometry used by the browser's road-snap tool."""
    return tuple(
        {
            "id": record["id"],
            "name": record.get("name") or "Unnamed road",
            "lane_count": record["lane_count"],
            "points": [[round(x, 1), round(z, 1)] for x, z in record["line"].coords],
            "snap_points": [[round(x, 1), round(z, 1)] for x, z in record["snap_line"].coords],
            "official": ({
                "source": "City of Cape Town road centreline",
                "name": record["municipal"].get("name"),
                "road_class": record["municipal"].get("road_class"),
                "route_number": record["municipal"].get("route_number"),
                "lanes": record["municipal"].get("lane_count"),
                "speed_limit_kph": record["municipal"].get("speed_limit_kph"),
                "speed_limit_source": record["municipal"].get("speed_limit_source"),
                "surface": record["municipal"].get("surface"),
                "bus_route": str(record["municipal"].get("bus") or "").upper() in {"Y", "YES"},
            } if record.get("municipal") else None),
        }
        for record in _edge_index().values()
        if record["visible"] and len(record["line"].coords) >= 2
    )


def _road_bounds_local(road_name: str) -> list[float] | None:
    """Viewer-local bounding box of a named road's visible edges."""
    index = _edge_index()
    lines = [
        index[edge_id]["line"] for edge_id in resolve_road_edges(road_name)
        if edge_id in index and index[edge_id]["visible"]
    ]
    if not lines:
        return None
    min_x, min_z, max_x, max_z = unary_union(lines).bounds
    return [round(min_x, 1), round(min_z, 1), round(max_x, 1), round(max_z, 1)]


def _lines_payload(records: list[dict[str, Any]]) -> list[list[list[float]]]:
    """Compact viewer-local line coordinates for road overlays."""
    return [
        [[round(x, 1), round(z, 1)] for x, z in record["line"].coords]
        for record in records
        if len(record["line"].coords) >= 2
    ]


def _lines_payload_with_junction_bridges(
    records: list[dict[str, Any]],
    maximum_gap_m: float = 48.0,
) -> list[list[list[float]]]:
    """Return edge lines plus same-road bridges across SUMO junction gaps."""
    lines = _lines_payload(records)
    bridges: list[list[list[float]]] = []
    for first_index, first in enumerate(records):
        first_line = first.get("line")
        if first_line is None or first_line.is_empty or len(first_line.coords) < 2:
            continue
        first_name = _normalise_road_name(first.get("name"))
        if not first_name:
            continue
        for second in records[first_index + 1:]:
            second_line = second.get("line")
            if (
                second_line is None or second_line.is_empty or len(second_line.coords) < 2
                or _normalise_road_name(second.get("name")) != first_name
            ):
                continue
            best: tuple[float, tuple[float, float], tuple[float, float]] | None = None
            first_points = list(first_line.coords)
            second_points = list(second_line.coords)
            for first_start in (True, False):
                a = first_points[0] if first_start else first_points[-1]
                a_neighbour = first_points[1] if first_start else first_points[-2]
                for second_start in (True, False):
                    b = second_points[0] if second_start else second_points[-1]
                    b_neighbour = second_points[1] if second_start else second_points[-2]
                    gap_x, gap_z = b[0] - a[0], b[1] - a[1]
                    gap = math.hypot(gap_x, gap_z)
                    if not 0.75 <= gap <= maximum_gap_m:
                        continue
                    ax, az = a[0] - a_neighbour[0], a[1] - a_neighbour[1]
                    bx, bz = b_neighbour[0] - b[0], b_neighbour[1] - b[1]
                    a_length, b_length = math.hypot(ax, az), math.hypot(bx, bz)
                    if not a_length or not b_length:
                        continue
                    continuation = (ax * bx + az * bz) / (a_length * b_length)
                    gap_alignment = (gap_x * ax + gap_z * az) / (gap * a_length)
                    if continuation < 0.45 or gap_alignment < 0.55:
                        continue
                    score = gap + (1.0 - continuation) * 18.0
                    if best is None or score < best[0]:
                        best = (score, a, b)
            if best:
                bridges.append([
                    [round(best[1][0], 1), round(best[1][1], 1)],
                    [round(best[2][0], 1), round(best[2][1], 1)],
                ])
    return lines + bridges


def _records_bounds(records: list[dict[str, Any]]) -> list[float] | None:
    if not records:
        return None
    min_x, min_z, max_x, max_z = unary_union([record["line"] for record in records]).bounds
    return [round(min_x, 1), round(min_z, 1), round(max_x, 1), round(max_z, 1)]


def resolve_scenario(scenario: str, live_average_ratio: float | None = None) -> dict[str, Any]:
    """Resolve a named time-of-day profile into concrete demand parameters."""
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario: {scenario!r} (expected one of {sorted(SCENARIOS)})")
    profile = SCENARIOS[scenario]
    demand_scale = profile["demand_scale"]
    if demand_scale is None:
        ratio = 0.85 if live_average_ratio is None else live_average_ratio
        demand_scale = _demand_scale(ratio)
    return {
        "key": scenario,
        "label": profile["label"],
        "demand_scale": float(demand_scale),
        "inbound_bias": float(profile["inbound_bias"]),
    }


def resolve_closure_lanes(
    road_name: str,
    closure_mode: str,
    closure_scope: str = "road",
) -> dict[str, Any]:
    """Work out exactly which lanes a closure removes.

    ``lane`` closes the kerbside lane (SUMO lane index 0) of every
    multi-lane edge of the road, which is the "one lane coned off" case --
    single-lane edges are left alone, since removing their only lane would
    silently sever the street rather than narrow it. ``full`` closes every
    lane, i.e. pedestrianising the road.
    """
    if closure_mode not in CLOSURE_MODES:
        raise ValueError(f"closure_mode must be one of {list(CLOSURE_MODES)}")
    if closure_scope not in CLOSURE_SCOPES:
        raise ValueError(f"closure_scope must be one of {list(CLOSURE_SCOPES)}")
    net = _sumo_net()
    edges = [
        edge for edge in net.getEdges()
        if edge.getName() == road_name and edge.allows("passenger")
    ]
    if not edges:
        raise ValueError(f"{road_name!r} has no drivable edges in the simulation network")

    if closure_scope == "block" and len(edges) > 1:
        # SUMO creates a separate edge per block. Select the block nearest the
        # centre of the visible named road. A full closure also captures a
        # nearby parallel carriageway of the same road (such as Adderley's
        # separately mapped northbound and southbound sides), while excluding
        # the preceding and following blocks along the same axis.
        index = _edge_index()
        candidates = [edge for edge in edges if edge.getID() in index]
        if candidates:
            block_candidates = (
                [edge for edge in candidates if len(edge.getLanes()) >= 2]
                if closure_mode == "lane"
                else candidates
            )
            block_candidates = block_candidates or candidates
            named_lines = [index[edge.getID()]["line"] for edge in candidates]
            centre = unary_union(named_lines).centroid
            selected = min(block_candidates, key=lambda edge: index[edge.getID()]["line"].distance(centre))
            selected_key = selected.getID().lstrip("-")
            scoped = [edge for edge in candidates if edge.getID().lstrip("-") == selected_key]
            if closure_mode == "full":
                selected_line = index[selected.getID()]["line"]
                start_x, start_z = selected_line.coords[0]
                end_x, end_z = selected_line.coords[-1]
                selected_length = max(selected_line.length, 1.0)
                direction_x = (end_x - start_x) / selected_length
                direction_z = (end_z - start_z) / selected_length
                normal_x, normal_z = -direction_z, direction_x
                selected_midpoint = selected_line.interpolate(0.5, normalized=True)
                for candidate in candidates:
                    candidate_line = index[candidate.getID()]["line"]
                    candidate_length = max(candidate_line.length, 1.0)
                    candidate_start = candidate_line.coords[0]
                    candidate_end = candidate_line.coords[-1]
                    candidate_dx = (candidate_end[0] - candidate_start[0]) / candidate_length
                    candidate_dz = (candidate_end[1] - candidate_start[1]) / candidate_length
                    parallel = abs(direction_x * candidate_dx + direction_z * candidate_dz) >= 0.82
                    candidate_midpoint = candidate_line.interpolate(0.5, normalized=True)
                    delta_x = candidate_midpoint.x - selected_midpoint.x
                    delta_z = candidate_midpoint.y - selected_midpoint.y
                    along = abs(delta_x * direction_x + delta_z * direction_z)
                    lateral = abs(delta_x * normal_x + delta_z * normal_z)
                    aligned_block = along <= max(16.0, (selected_length + candidate_length) * 0.35)
                    if parallel and aligned_block and lateral <= 28.0 and candidate not in scoped:
                        scoped.append(candidate)
            edges = scoped or [selected]

    lane_ids: list[str] = []
    edge_ids: list[str] = []
    narrowed = 0
    skipped_single_lane = 0
    for edge in edges:
        lanes = edge.getLanes()
        if closure_mode == "full":
            lane_ids.extend(lane.getID() for lane in lanes)
            edge_ids.append(edge.getID())
            continue
        if len(lanes) < 2:
            skipped_single_lane += 1
            continue
        lane_ids.append(lanes[0].getID())
        narrowed += 1

    if not lane_ids:
        raise ValueError(
            f"{road_name!r} has no multi-lane sections to narrow; "
            "choose another road or use a full closure"
        )
    return {
        "lane_ids": lane_ids,
        "edge_ids": edge_ids,
        "affected_edge_ids": [edge.getID() for edge in edges],
        "edges_total": len(edges),
        "edges_narrowed": narrowed,
        "edges_skipped_single_lane": skipped_single_lane,
        "scope": closure_scope,
    }


def resolve_drawn_closure(edge_ids: list[str], closure_mode: str) -> dict[str, Any]:
    """Resolve an exact snapped map selection into lanes/edges to close."""
    if closure_mode not in CLOSURE_MODES:
        raise ValueError(f"closure_mode must be one of {list(CLOSURE_MODES)}")
    requested_ids = list(dict.fromkeys(str(edge_id) for edge_id in edge_ids if edge_id))
    if not requested_ids:
        raise ValueError("draw at least one road section before running the closure preview")
    if len(requested_ids) > 120:
        raise ValueError("drawn closure is too large; select at most 120 road sections")

    net = _sumo_net()
    by_id = {edge.getID(): edge for edge in net.getEdges()}
    missing = [edge_id for edge_id in requested_ids if edge_id not in by_id]
    if missing:
        raise ValueError(f"drawn closure contains unknown road sections: {missing[:3]}")
    edges = [by_id[edge_id] for edge_id in requested_ids if by_id[edge_id].allows("passenger")]
    if not edges:
        raise ValueError("drawn closure does not contain a vehicle-carrying road")

    # A full closure across a divided street should include the parallel
    # carriageway over the same drawn span. Lane closures remain exactly on
    # the side the user painted.
    if closure_mode == "full":
        index = _edge_index()
        selected = list(edges)
        for edge in list(edges):
            record = index.get(edge.getID())
            if not record or not record.get("name"):
                continue
            line = record["line"]
            start_x, start_z = line.coords[0]
            end_x, end_z = line.coords[-1]
            length = max(line.length, 1.0)
            direction_x = (end_x - start_x) / length
            direction_z = (end_z - start_z) / length
            normal_x, normal_z = -direction_z, direction_x
            midpoint = line.interpolate(0.5, normalized=True)
            for candidate in by_id.values():
                candidate_record = index.get(candidate.getID())
                if not candidate_record or candidate_record.get("name") != record["name"]:
                    continue
                candidate_line = candidate_record["line"]
                candidate_length = max(candidate_line.length, 1.0)
                candidate_start = candidate_line.coords[0]
                candidate_end = candidate_line.coords[-1]
                candidate_dx = (candidate_end[0] - candidate_start[0]) / candidate_length
                candidate_dz = (candidate_end[1] - candidate_start[1]) / candidate_length
                if abs(direction_x * candidate_dx + direction_z * candidate_dz) < 0.82:
                    continue
                candidate_midpoint = candidate_line.interpolate(0.5, normalized=True)
                delta_x = candidate_midpoint.x - midpoint.x
                delta_z = candidate_midpoint.y - midpoint.y
                along = abs(delta_x * direction_x + delta_z * direction_z)
                lateral = abs(delta_x * normal_x + delta_z * normal_z)
                aligned = along <= max(16.0, (length + candidate_length) * 0.35)
                if aligned and lateral <= 28.0 and candidate not in selected:
                    selected.append(candidate)
        edges = selected

    lane_ids: list[str] = []
    closed_edge_ids: list[str] = []
    narrowed = 0
    skipped_single_lane = 0
    for edge in edges:
        lanes = edge.getLanes()
        if closure_mode == "full":
            lane_ids.extend(lane.getID() for lane in lanes)
            closed_edge_ids.append(edge.getID())
        elif len(lanes) >= 2:
            lane_ids.append(lanes[0].getID())
            narrowed += 1
        else:
            skipped_single_lane += 1
    if not lane_ids:
        raise ValueError("the drawn section has no multi-lane road to narrow; use a full closure")

    road_names = sorted({edge.getName() for edge in edges if edge.getName()})
    return {
        "lane_ids": lane_ids,
        "edge_ids": closed_edge_ids,
        "affected_edge_ids": [edge.getID() for edge in edges],
        "requested_edge_ids": requested_ids,
        "edges_total": len(edges),
        "edges_narrowed": narrowed,
        "edges_skipped_single_lane": skipped_single_lane,
        "scope": "drawn",
        "road_names": road_names,
        "label": ", ".join(road_names[:3]) + ("…" if len(road_names) > 3 else "") or "Drawn road section",
    }


def _trip_weights(corridor: list[dict[str, Any]], inbound_bias: float) -> tuple[list[float], list[float]]:
    """Origin/destination sampling weights for one corridor.

    Base weight favours long, multi-lane, fast edges -- a six-lane arterial
    should originate far more trips than a short service road. `inbound_bias`
    then tilts origins outward and destinations inward (morning commute) or
    the reverse (afternoon), using distance from the viewer origin, which sits
    on the CBD core.
    """
    centre = Point(0.0, 0.0)
    distances = [record["midpoint"].distance(centre) for record in corridor]
    furthest = max(distances) or 1.0
    origin_weights, destination_weights = [], []
    for record, distance in zip(corridor, distances):
        municipal = record.get("municipal") or {}
        capacity_lanes = municipal.get("lane_count") or record["lane_count"]
        priority_factor = {
            "1": 1.45, "2": 1.3, "3": 1.15, "4": 1.0, "5": 0.8,
        }.get(str(municipal.get("right_of_way_class") or ""), 1.0)
        base = capacity_lanes * priority_factor * math.sqrt(max(record["length_m"], 1.0))
        radial = distance / furthest  # 0 at the CBD core, 1 at the corridor rim
        outward = 0.5 + inbound_bias * (radial - 0.5)
        inward = 0.5 - inbound_bias * (radial - 0.5)
        origin_weights.append(base * max(0.05, outward))
        destination_weights.append(base * max(0.05, inward))
    return origin_weights, destination_weights


def _generate_trips(
    corridor: list[dict[str, Any]],
    duration_s: int,
    vehicle_count: int,
    inbound_bias: float,
    seed: int,
    workdir: Path,
) -> tuple[Path, int]:
    """Write a corridor-scoped trip file and return it with its vehicle count.

    Replaces SUMO's ``randomTrips.py``: that tool samples the whole network
    with no notion of which edges are on camera, which is what scattered
    vehicles across (and off) the map. Generating trips here also removes a
    subprocess and its timeout from the request path.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    origin_weights, destination_weights = _trip_weights(corridor, inbound_bias)
    departure_window_s = float(duration_s) * DEPARTURE_WINDOW_FRACTION
    trips: list[tuple[float, str, str, str]] = []
    fleet_types = list(FLEET_MIX)
    fleet_weights = list(FLEET_MIX.values())
    for _ in range(vehicle_count):
        origin = rng.choices(corridor, weights=origin_weights, k=1)[0]
        destination = rng.choices(corridor, weights=destination_weights, k=1)[0]
        # A trip that starts and ends on the same edge has nothing to route.
        if destination["id"] == origin["id"]:
            continue
        vehicle_type = rng.choices(fleet_types, weights=fleet_weights, k=1)[0]
        trips.append((rng.uniform(0.0, departure_window_s), origin["id"], destination["id"], vehicle_type))
    trips.sort(key=lambda trip: trip[0])  # SUMO expects departure-sorted input

    trips_path = workdir / "corridor.trips.xml"
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<routes>",
        '  <vType id="car" vClass="passenger" emissionClass="HBEFA3/PC_G_EU4" length="4.4" minGap="2.0" accel="2.6"'
        ' decel="4.5" sigma="0.5" speedFactor="normc(1.0,0.12,0.7,1.4)"/>',
        '  <vType id="minibus_taxi" vClass="passenger" emissionClass="HBEFA3/PC_D_EU4" length="5.6" minGap="1.4" accel="2.2"'
        ' decel="4.5" sigma="0.72" speedFactor="normc(0.96,0.15,0.65,1.35)"/>',
        '  <vType id="delivery_van" vClass="passenger" emissionClass="HBEFA3/LDV_D_EU4" length="6.4" minGap="2.2" accel="1.8"'
        ' decel="4.0" sigma="0.45" speedFactor="normc(0.90,0.08,0.65,1.15)"/>',
        '  <vType id="city_shuttle" vClass="passenger" emissionClass="HBEFA3/HDV_D_EU4" length="10.5" minGap="2.5" accel="1.3"'
        ' decel="3.5" sigma="0.35" speedFactor="normc(0.82,0.06,0.60,1.0)"/>',
    ]
    for index, (depart, origin_id, destination_id, vehicle_type) in enumerate(trips):
        parts.append(
            f'  <trip id="v{index}" type="{vehicle_type}" depart="{depart:.2f}"'
            f' from="{origin_id}" to="{destination_id}"/>'
        )
    parts.append("</routes>")
    trips_path.write_text("\n".join(parts) + "\n", encoding="utf-8")
    return trips_path, len(trips)


def _parse_tripinfo(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"trip_count": 0, "mean_duration_s": 0.0, "mean_time_loss_s": 0.0, "mean_speed_mps": 0.0, "total_distance_m": 0.0, "per_vehicle": {}}
    root = ElementTree.parse(path).getroot()
    durations, time_losses, distances, speeds = [], [], [], []
    per_vehicle: dict[str, dict[str, float]] = {}
    for trip in root.findall("tripinfo"):
        duration = float(trip.get("duration", 0.0))
        route_length = float(trip.get("routeLength", 0.0))
        time_loss = float(trip.get("timeLoss", 0.0))
        durations.append(duration)
        time_losses.append(time_loss)
        distances.append(route_length)
        if duration > 0:
            speeds.append(route_length / duration)
        vehicle_id = trip.get("id")
        if vehicle_id is not None:
            per_vehicle[vehicle_id] = {
                "duration_s": duration,
                "time_loss_s": time_loss,
                "route_length_m": route_length,
                "speed_mps": route_length / duration if duration > 0 else 0.0,
            }
    trip_count = len(durations)
    return {
        "trip_count": trip_count,
        "mean_duration_s": sum(durations) / trip_count if trip_count else 0.0,
        "mean_time_loss_s": sum(time_losses) / trip_count if trip_count else 0.0,
        "mean_speed_mps": sum(speeds) / len(speeds) if speeds else 0.0,
        "total_distance_m": sum(distances),
        "per_vehicle": per_vehicle,
    }


def _run_simulation(
    trip_file: Path,
    duration_s: int,
    closed_lanes: list[str],
    closed_edges: list[str],
    workdir: Path,
    monitored_edges: list[str] | None = None,
    traffic_control: str = DEFAULT_TRAFFIC_CONTROL,
    edge_speed_limits: dict[str, float] | None = None,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    import traci

    workdir.mkdir(parents=True, exist_ok=True)
    tripinfo_path = workdir / "tripinfo.xml"
    # Positions are only recorded for `duration_s` (that is what plays back),
    # but the simulation runs on past it so trips in flight can arrive and be
    # scored -- see DRAIN_FACTOR.
    end_s = int(duration_s * DRAIN_FACTOR)
    sumo_cmd = [
        "sumo",
        "--net-file", str(SUMO_NET_PATH),
        "--route-files", str(trip_file),
        "--begin", "0",
        "--end", str(end_s),
        "--step-length", str(SIM_STEP_LENGTH_S),
        "--tripinfo-output", str(tripinfo_path),
        "--no-warnings", "true",
        "--no-step-log", "true",
        "--time-to-teleport", "300",
        "--duration-log.disable", "true",
        # Trips (not pre-computed routes) are routed by SUMO's own internal
        # router at each vehicle's insertion time, using whatever edge and
        # lane permissions are active at that moment -- since the closures
        # below are applied before the simulation loop starts, every vehicle
        # that departs afterwards already accounts for them.
        "--ignore-route-errors", "true",
    ]
    traci.start(sumo_cmd, label=f"traffic-{workdir.name}-{id(workdir)}")
    open_tracks: dict[str, dict[str, Any]] = {}
    finished_tracks: list[dict[str, Any]] = []
    retired_ids: set[str] = set()
    started_at = time.monotonic()
    truncated = False
    edge_totals: dict[str, dict[str, float]] = {
        edge_id: {"samples": 0.0, "vehicle_count": 0.0, "speed_sum": 0.0, "halted": 0.0}
        for edge_id in (monitored_edges or [])
    }
    network_queue_samples: list[int] = []
    environment = {
        "co2_mg": 0.0, "nox_mg": 0.0, "pmx_mg": 0.0, "fuel_mg": 0.0,
        "noise_energy": 0.0, "noise_samples": 0,
    }
    try:
        if traffic_control == "priority":
            for tls_id in traci.trafficlight.getIDList():
                traci.trafficlight.setProgram(tls_id, "off")
        for edge_id, speed_mps in (edge_speed_limits or {}).items():
            traci.edge.setMaxSpeed(edge_id, speed_mps)
        for lane_id in closed_lanes:
            traci.lane.setDisallowed(lane_id, ["passenger"])
        for edge_id in closed_edges:
            traci.edge.setDisallowed(edge_id, ["passenger"])
        if edge_totals:
            for edge_id in edge_totals:
                traci.edge.subscribe(edge_id, (
                    traci.constants.LAST_STEP_VEHICLE_NUMBER,
                    traci.constants.LAST_STEP_MEAN_SPEED,
                    traci.constants.LAST_STEP_VEHICLE_HALTING_NUMBER,
                    traci.constants.VAR_CO2EMISSION,
                    traci.constants.VAR_NOXEMISSION,
                    traci.constants.VAR_PMXEMISSION,
                    traci.constants.VAR_FUELCONSUMPTION,
                    traci.constants.VAR_NOISEEMISSION,
                ))

        step = 0
        while traci.simulation.getMinExpectedNumber() > 0 and step < end_s:
            if time.monotonic() - started_at > SIMULATION_WALL_CLOCK_BUDGET_S:
                truncated = True
                break
            traci.simulationStep()
            if step < duration_s and step % TRAJECTORY_SAMPLE_INTERVAL_S == 0:
                queued_now = 0
                edge_results = traci.edge.getAllSubscriptionResults() or {}
                for edge_id, totals in edge_totals.items():
                    result = edge_results.get(edge_id) or {}
                    vehicle_count = result.get(traci.constants.LAST_STEP_VEHICLE_NUMBER, 0)
                    totals["samples"] += 1
                    totals["vehicle_count"] += vehicle_count
                    totals["speed_sum"] += max(0.0, result.get(traci.constants.LAST_STEP_MEAN_SPEED, 0.0))
                    halted = result.get(traci.constants.LAST_STEP_VEHICLE_HALTING_NUMBER, 0)
                    totals["halted"] += halted
                    queued_now += halted
                    # Edge emission variables are instantaneous mg/s. Sampling
                    # every three seconds and multiplying by that interval is
                    # a compact integral over the animated simulation window.
                    environment["co2_mg"] += max(0.0, result.get(traci.constants.VAR_CO2EMISSION, 0.0)) * TRAJECTORY_SAMPLE_INTERVAL_S
                    environment["nox_mg"] += max(0.0, result.get(traci.constants.VAR_NOXEMISSION, 0.0)) * TRAJECTORY_SAMPLE_INTERVAL_S
                    environment["pmx_mg"] += max(0.0, result.get(traci.constants.VAR_PMXEMISSION, 0.0)) * TRAJECTORY_SAMPLE_INTERVAL_S
                    environment["fuel_mg"] += max(0.0, result.get(traci.constants.VAR_FUELCONSUMPTION, 0.0)) * TRAJECTORY_SAMPLE_INTERVAL_S
                    noise_db = float(result.get(traci.constants.VAR_NOISEEMISSION, 0.0) or 0.0)
                    if noise_db > 0.0 and vehicle_count > 0:
                        environment["noise_energy"] += 10.0 ** (noise_db / 10.0)
                        environment["noise_samples"] += 1
                network_queue_samples.append(queued_now)
                present = set(traci.vehicle.getIDList())
                for vehicle_id in present:
                    track = open_tracks.get(vehicle_id)
                    if track is None:
                        if vehicle_id in retired_ids:
                            continue  # already sampled and closed out earlier
                        if len(open_tracks) >= MAX_CONCURRENT_TRACKED:
                            continue
                        if len(finished_tracks) >= MAX_TOTAL_TRACKS:
                            continue
                        track = {
                            "id": vehicle_id,
                            "type": traci.vehicle.getTypeID(vehicle_id),
                            "t0": step,
                            "x": [],
                            "y": [],
                        }
                        open_tracks[vehicle_id] = track
                    x, y = traci.vehicle.getPosition(vehicle_id)
                    track["x"].append(x)
                    track["y"].append(y)
                # Close out tracks whose vehicle has left, so each track stays
                # a contiguous run of samples and the viewer can reconstruct
                # sample times from t0 alone.
                for vehicle_id in [key for key in open_tracks if key not in present]:
                    finished_tracks.append(open_tracks.pop(vehicle_id))
                    retired_ids.add(vehicle_id)
            step += 1
    finally:
        traci.close()

    finished_tracks.extend(open_tracks.values())
    metrics = _parse_tripinfo(tripinfo_path)
    metrics["simulated_steps"] = step
    metrics["truncated_by_time_budget"] = truncated
    metrics["mean_queued_vehicles"] = (
        sum(network_queue_samples) / len(network_queue_samples) if network_queue_samples else 0.0
    )
    metrics["max_queued_vehicles"] = max(network_queue_samples, default=0)
    metrics["edge_stats"] = {
        edge_id: {
            "mean_vehicle_count": totals["vehicle_count"] / totals["samples"] if totals["samples"] else 0.0,
            "mean_speed_mps": totals["speed_sum"] / totals["samples"] if totals["samples"] else 0.0,
            "mean_halted": totals["halted"] / totals["samples"] if totals["samples"] else 0.0,
        }
        for edge_id, totals in edge_totals.items()
    }
    metrics["environment"] = {
        "co2_kg": environment["co2_mg"] / 1_000_000.0,
        "nox_g": environment["nox_mg"] / 1_000.0,
        "pmx_g": environment["pmx_mg"] / 1_000.0,
        "fuel_kg": environment["fuel_mg"] / 1_000_000.0,
        "mean_active_edge_noise_db": (
            10.0 * math.log10(environment["noise_energy"] / environment["noise_samples"])
            if environment["noise_samples"] else 0.0
        ),
        "scope": "simulated_corridor_during_animation_window",
        "model": "SUMO HBEFA3 fleet-class estimate",
    }
    return {"tracks": finished_tracks}, metrics


def _project_tracks(tracks: list[dict[str, Any]], net: Any, config: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert SUMO network XY tracks into compact viewer-local tracks.

    Only positions are sent: the viewer derives heading and speed from
    consecutive samples, which halves the payload and guarantees a car's
    nose always points along the path it is actually travelling.
    """
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = config["origin"]
    projected = []
    for track in tracks:
        if len(track["x"]) < 2:
            continue  # a single sample can't imply a heading
        xs, zs = [], []
        for x, y in zip(track["x"], track["y"]):
            longitude, latitude = net.convertXY2LonLat(x, y)
            local_x, local_y = transformer.transform(longitude, latitude)
            xs.append(round(local_x - origin_x, 1))
            zs.append(round(-(local_y - origin_y), 1))
        projected.append({"t0": track["t0"], "type": track.get("type", "car"), "x": xs, "z": zs})
    return projected


def _diff_metrics(baseline: dict[str, Any], closure: dict[str, Any], planned_count: int) -> dict[str, Any]:
    """Compare the two runs, pairing on vehicles that finished in both.

    Averaging over *all* completed trips in each run is misleading when a
    closure is severe: the trips it hurts most are exactly the ones that no
    longer finish inside the simulated window, so they drop out of the
    closure average and the closure can look *faster* than the baseline.
    Restricting both averages to the vehicles that completed in both runs
    compares like with like; the completion ratios below carry the rest of
    the story (how many trips the closure stopped from finishing at all).
    """

    def pct_change(before: float, after: float) -> float | None:
        if before == 0:
            return None
        return (after - before) / before * 100.0

    def mean(values: list[float]) -> float:
        return sum(values) / len(values) if values else 0.0

    baseline_trips = baseline.get("per_vehicle") or {}
    closure_trips = closure.get("per_vehicle") or {}
    shared = sorted(set(baseline_trips) & set(closure_trips))

    if shared:
        before_duration = mean([baseline_trips[key]["duration_s"] for key in shared])
        after_duration = mean([closure_trips[key]["duration_s"] for key in shared])
        before_loss = mean([baseline_trips[key]["time_loss_s"] for key in shared])
        after_loss = mean([closure_trips[key]["time_loss_s"] for key in shared])
        before_speed = mean([baseline_trips[key]["speed_mps"] for key in shared])
        after_speed = mean([closure_trips[key]["speed_mps"] for key in shared])
        before_distance = mean([baseline_trips[key]["route_length_m"] for key in shared])
        after_distance = mean([closure_trips[key]["route_length_m"] for key in shared])
        comparison = "paired_on_trips_completed_in_both_runs"
    else:
        before_duration, after_duration = baseline["mean_duration_s"], closure["mean_duration_s"]
        before_loss, after_loss = baseline["mean_time_loss_s"], closure["mean_time_loss_s"]
        before_speed, after_speed = baseline["mean_speed_mps"], closure["mean_speed_mps"]
        before_distance = baseline.get("total_distance_m", 0.0) / max(baseline.get("trip_count", 0), 1)
        after_distance = closure.get("total_distance_m", 0.0) / max(closure.get("trip_count", 0), 1)
        comparison = "all_completed_trips"

    before_environment = baseline.get("environment") or {}
    after_environment = closure.get("environment") or {}
    return {
        "comparison": comparison,
        "compared_trip_count": len(shared),
        "mean_duration_change_s": after_duration - before_duration,
        "mean_duration_change_pct": pct_change(before_duration, after_duration),
        "mean_time_loss_change_s": after_loss - before_loss,
        "mean_time_loss_change_pct": pct_change(before_loss, after_loss),
        "mean_speed_change_mps": after_speed - before_speed,
        "mean_speed_change_pct": pct_change(before_speed, after_speed),
        "mean_route_length_change_m": after_distance - before_distance,
        "mean_route_length_change_pct": pct_change(before_distance, after_distance),
        "mean_queued_vehicle_change": closure.get("mean_queued_vehicles", 0.0) - baseline.get("mean_queued_vehicles", 0.0),
        "max_queue_baseline": baseline.get("max_queued_vehicles", 0),
        "max_queue_closure": closure.get("max_queued_vehicles", 0),
        "completed_trip_ratio_baseline": baseline["trip_count"] / planned_count if planned_count else None,
        "completed_trip_ratio_closure": closure["trip_count"] / planned_count if planned_count else None,
        "environment": {
            key: {
                "baseline": before_environment.get(key, 0.0),
                "closure": after_environment.get(key, 0.0),
                "change": after_environment.get(key, 0.0) - before_environment.get(key, 0.0),
                "change_pct": pct_change(
                    before_environment.get(key, 0.0), after_environment.get(key, 0.0)
                ),
            }
            for key in ("co2_kg", "nox_g", "pmx_g", "fuel_kg", "mean_active_edge_noise_db")
        },
    }


def _flow_comparison(
    corridor: list[dict[str, Any]],
    baseline_stats: dict[str, dict[str, float]],
    closure_stats: dict[str, dict[str, float]],
) -> list[dict[str, Any]]:
    """Road-level flow changes used to paint diversions in the 3D viewer."""
    segments = []
    for record in corridor:
        edge_id = record["id"]
        before = baseline_stats.get(edge_id) or {}
        after = closure_stats.get(edge_id) or {}
        before_count = float(before.get("mean_vehicle_count", 0.0))
        after_count = float(after.get("mean_vehicle_count", 0.0))
        delta = after_count - before_count
        # Keep quiet roads out of the overlay; a minimum absolute change also
        # suppresses numerical flicker from one vehicle entering a sample.
        if abs(delta) < 0.12 and float(after.get("mean_halted", 0.0)) < 0.08:
            continue
        segments.append({
            "edge_id": edge_id,
            "name": record.get("name") or "Unnamed road",
            "points": [[round(x, 1), round(z, 1)] for x, z in record["line"].coords],
            "baseline_vehicles": round(before_count, 2),
            "closure_vehicles": round(after_count, 2),
            "vehicle_delta": round(delta, 2),
            "closure_speed_mps": round(float(after.get("mean_speed_mps", 0.0)), 2),
            "closure_halted": round(float(after.get("mean_halted", 0.0)), 2),
        })
    return sorted(segments, key=lambda item: abs(item["vehicle_delta"]), reverse=True)[:160]


def _aggregate_flow_by_street(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse edge-level flow changes into one length-weighted row per street."""
    grouped: dict[str, dict[str, Any]] = {}
    for segment in segments:
        name = str(segment.get("name") or "Unnamed road").strip() or "Unnamed road"
        key = _normalise_road_name(name) or name.upper()
        points = segment.get("points") or []
        length = sum(
            math.hypot(float(b[0]) - float(a[0]), float(b[1]) - float(a[1]))
            for a, b in zip(points, points[1:])
        ) or 1.0
        item = grouped.setdefault(key, {
            "name": name,
            "section_count": 0,
            "length_m": 0.0,
            "vehicle_delta_weighted": 0.0,
            "closure_speed_weighted": 0.0,
            "closure_halted_weighted": 0.0,
        })
        item["section_count"] += 1
        item["length_m"] += length
        item["vehicle_delta_weighted"] += float(segment.get("vehicle_delta") or 0.0) * length
        item["closure_speed_weighted"] += float(segment.get("closure_speed_mps") or 0.0) * length
        item["closure_halted_weighted"] += float(segment.get("closure_halted") or 0.0) * length

    summary = []
    for item in grouped.values():
        length = max(item["length_m"], 1.0)
        summary.append({
            "name": item["name"],
            "section_count": item["section_count"],
            "modelled_length_m": round(item["length_m"], 1),
            "vehicle_delta": round(item["vehicle_delta_weighted"] / length, 2),
            "closure_speed_mps": round(item["closure_speed_weighted"] / length, 2),
            "closure_halted": round(item["closure_halted_weighted"] / length, 2),
            "aggregation": "length_weighted_mean_across_changed_sections",
        })
    return sorted(summary, key=lambda item: abs(item["vehicle_delta"]), reverse=True)


def closure_preview(payload: dict[str, Any]) -> dict[str, Any]:
    requested_edge_ids = payload.get("edge_ids") or []
    if not isinstance(requested_edge_ids, list):
        raise ValueError("edge_ids must be a list")
    road_name = payload.get("road_name")
    if requested_edge_ids:
        road_name = str(road_name or "Drawn road section").strip()
    elif not isinstance(road_name, str) or not road_name.strip():
        raise ValueError("road_name or edge_ids is required; draw a road section before running the closure preview")
    else:
        road_name = road_name.strip()

    duration_min = float(payload.get("duration_min", DEFAULT_DURATION_MIN))
    if not (MIN_DURATION_MIN <= duration_min <= MAX_DURATION_MIN):
        raise ValueError(f"duration_min must be between {MIN_DURATION_MIN} and {MAX_DURATION_MIN} minutes")

    scenario_key = str(payload.get("scenario", DEFAULT_SCENARIO))
    closure_mode = str(payload.get("closure_mode", DEFAULT_CLOSURE_MODE))
    closure_scope = str(payload.get("closure_scope", DEFAULT_CLOSURE_SCOPE))
    traffic_control = str(payload.get("traffic_control", DEFAULT_TRAFFIC_CONTROL))
    demand_multiplier = float(payload.get("demand_multiplier", 1.0))
    if closure_mode not in CLOSURE_MODES:
        raise ValueError(f"closure_mode must be one of {list(CLOSURE_MODES)}")
    if closure_scope not in CLOSURE_SCOPES:
        raise ValueError(f"closure_scope must be one of {list(CLOSURE_SCOPES)}")
    if traffic_control not in TRAFFIC_CONTROLS:
        raise ValueError(f"traffic_control must be one of {list(TRAFFIC_CONTROLS)}")
    if not (MIN_DEMAND_MULTIPLIER <= demand_multiplier <= MAX_DEMAND_MULTIPLIER):
        raise ValueError(
            f"demand_multiplier must be between {MIN_DEMAND_MULTIPLIER} and {MAX_DEMAND_MULTIPLIER}"
        )

    live_ratio: float | None = None
    if scenario_key == "live":
        try:
            live_ratio = float(current_traffic().get("average_speed_ratio", 0.85))
        except Exception:
            live_ratio = None
    scenario = resolve_scenario(scenario_key, live_ratio)

    net = _sumo_net()
    if requested_edge_ids:
        closure = resolve_drawn_closure(requested_edge_ids, closure_mode)
        road_name = closure["label"]
        closure_scope = "drawn"
        corridor = corridor_edges_for_ids(closure["requested_edge_ids"], road_name)
    else:
        corridor = corridor_edges(road_name)
        closure = resolve_closure_lanes(road_name, closure_mode, closure_scope)
    monitored_edge_ids = [record["id"] for record in corridor]

    duration_s = int(duration_min * 60)
    vehicle_target = int(
        BASE_VEHICLES_PER_MIN * duration_min * scenario["demand_scale"] * demand_multiplier
    )
    # A stable hash (not the builtin `hash()`, which is salted per-process)
    # so the same request always gets the same synthetic demand -- otherwise
    # repeat previews would be silently non-reproducible and the "seed"
    # reported in demand_model would be meaningless.
    selection_seed = ",".join(requested_edge_ids) if requested_edge_ids else road_name
    seed = zlib.crc32(
        f"{selection_seed}|{duration_min}|{scenario_key}|{demand_multiplier}".encode("utf-8")
    )
    municipal_speed_limits, speed_limit_counts = _speed_limit_overrides(corridor)
    speed_limit_records = [
        record for record in corridor
        if record.get("municipal") and record["municipal"].get("speed_limit_kph")
    ]
    inferred_speed_limits = [
        record for record in speed_limit_records
        if str(record["municipal"].get("speed_limit_source") or "").lower() != "confirmed"
    ]
    municipal_edge_count = sum(1 for record in corridor if record.get("municipal"))

    with tempfile.TemporaryDirectory(prefix="traffic_sim_") as tmp:
        workdir = Path(tmp)
        trip_file, planned_count = _generate_trips(
            corridor=corridor,
            duration_s=duration_s,
            vehicle_count=vehicle_target,
            inbound_bias=scenario["inbound_bias"],
            seed=seed,
            workdir=workdir,
        )

        baseline_raw, baseline_metrics = _run_simulation(
            trip_file, duration_s, [], [], workdir / "baseline",
            monitored_edges=monitored_edge_ids,
            traffic_control=traffic_control,
            edge_speed_limits=municipal_speed_limits,
        )
        closure_raw, closure_metrics = _run_simulation(
            trip_file, duration_s, closure["lane_ids"], closure["edge_ids"], workdir / "closure",
            monitored_edges=monitored_edge_ids,
            traffic_control=traffic_control,
            edge_speed_limits=municipal_speed_limits,
        )

        config = load_viewer_config()
        baseline_tracks = _project_tracks(baseline_raw["tracks"], net, config)
        closure_tracks = _project_tracks(closure_raw["tracks"], net, config)

    impact = _diff_metrics(baseline_metrics, closure_metrics, planned_count)
    flow_comparison = _flow_comparison(
        corridor,
        baseline_metrics.get("edge_stats", {}),
        closure_metrics.get("edge_stats", {}),
    )
    street_flow_summary = _aggregate_flow_by_street(flow_comparison)
    index = _edge_index()
    affected_records = [
        index[edge_id] for edge_id in closure["affected_edge_ids"] if edge_id in index
    ]
    # Per-vehicle rows exist only to pair the two runs; sending thousands of
    # them to the viewer would dwarf the trajectories they came from.
    baseline_metrics.pop("per_vehicle", None)
    closure_metrics.pop("per_vehicle", None)
    baseline_metrics.pop("edge_stats", None)
    closure_metrics.pop("edge_stats", None)

    return {
        "road_name": road_name,
        "closure_mode": closure_mode,
        "closure_scope": closure_scope,
        "scenario": scenario,
        "duration_min": duration_min,
        "validation_status": "exploratory_not_engineering_grade",
        "closure": {
            "lanes_closed": len(closure["lane_ids"]),
            "edges_total": closure["edges_total"],
            "edges_narrowed": closure["edges_narrowed"],
            "edges_skipped_single_lane": closure["edges_skipped_single_lane"],
            "scope": closure_scope,
            "geometry_local": _lines_payload_with_junction_bridges(affected_records),
            "description": (
                f"kerbside lane closed on {closure['edges_narrowed']} of "
                f"{closure['edges_total']} "
                f"{'section' if closure['edges_total'] == 1 else 'sections'}"
                if closure_mode == "lane"
                else f"all lanes closed on {closure['edges_total']} "
                f"{'section' if closure['edges_total'] == 1 else 'sections'}"
            ),
        },
        "corridor": {
            "radius_m": CORRIDOR_RADIUS_M,
            "edge_count": len(corridor),
            # Viewer-local [minX, minZ, maxX, maxZ] of the closed road itself,
            # so the camera can frame the thing the user asked about instead
            # of leaving them to hunt for it across the whole CBD.
            "road_bounds_local": _records_bounds(affected_records) or _road_bounds_local(road_name),
            "note": "demand is generated only between visible edges inside this corridor",
        },
        "demand_model": {
            "generator": "corridor-scoped synthetic trips, lane/length weighted, time-of-day biased",
            "scenario": scenario["key"],
            "demand_scale": scenario["demand_scale"],
            "user_demand_multiplier": demand_multiplier,
            "inbound_bias": scenario["inbound_bias"],
            "live_average_speed_ratio": live_ratio,
            "planned_vehicle_count": planned_count,
            "fleet_mix": FLEET_MIX,
            "seed": seed,
        },
        "road_data": {
            "routing_topology": "OpenStreetMap via SUMO",
            "centreline_source": "City of Cape Town TCT Road Centerline",
            "municipal_edges_matched": municipal_edge_count,
            "corridor_edges": len(corridor),
            "municipal_match_ratio": municipal_edge_count / len(corridor) if corridor else 0.0,
            "confirmed_speed_limits_applied": speed_limit_counts["confirmed"],
            "inferred_speed_limits_applied": speed_limit_counts["inferred"],
            "speed_limits_applied": len(municipal_speed_limits),
            "speed_limit_records_matched": len(speed_limit_records),
            "inferred_speed_limits_not_applied": max(0, len(inferred_speed_limits) - speed_limit_counts["inferred"]),
            "note": "Municipal geometry and attributes enrich the routable SUMO network; confirmed and inferred speed limits are applied to both comparison runs and reported separately.",
        },
        "street_activity": _street_activity_summary(corridor),
        "traffic_control": traffic_control,
        "signals": (
            "network_signal_programs_enabled"
            if traffic_control == "signalized"
            else "all_traffic_lights_switched_off_priority_right_of_way"
        ),
        "baseline": baseline_metrics,
        "closure_metrics": closure_metrics,
        "impact": impact,
        "flow_comparison": flow_comparison,
        "street_flow_summary": street_flow_summary,
        "playback": {
            "sample_interval_s": TRAJECTORY_SAMPLE_INTERVAL_S,
            "duration_s": duration_s,
        },
        "trajectories": {
            "baseline": baseline_tracks,
            "closure": closure_tracks,
        },
    }
