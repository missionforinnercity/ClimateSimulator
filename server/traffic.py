"""Live traffic conditions (TomTom) and SUMO-based lane-closure impact simulation.

Mirrors the caching shape of ``server/weather.py`` for the live-conditions
half, and the ``lru_cache``-memoized-parse shape of ``server/flood.py`` for the
road-network half. The closure simulation itself
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

import html
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
from zoneinfo import ZoneInfo

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
# Growing, gitignored log of TomTom speed-ratio snapshots -- see
# `record_traffic_observation`/`_historical_scenario_ratio`. Not the
# checked-in `data/` GIS assets above; this is runtime-accumulated.
TRAFFIC_OBSERVATIONS_PATH = PROJECT_ROOT / "data" / "observations" / "traffic_speed_log.jsonl"

TOMTOM_PROVIDER = "TomTom Traffic Flow"
TOMTOM_BASE_URL = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"
CACHE_SECONDS = 300
SAMPLE_ROAD_LIMIT = 16
CAPE_TOWN_TZ = ZoneInfo("Africa/Johannesburg")

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
# budget so thin that the street looks deserted. This also sets how far
# synthetic demand is generated -- BASE_VEHICLES_PER_MIN and the whole
# demand-stability sweep behind it (see project memory) were validated at
# this radius, so it stays fixed here rather than growing with the radius
# below.
CORRIDOR_RADIUS_M = 250.0
MIN_CORRIDOR_EDGES = 12
# SUMO's own router is never confined to the 250 m corridor -- it runs on
# the full network, so a closure can and does reroute traffic further away
# than that in the simulation itself. What *was* confined to 250 m is what
# gets reported: `_flow_comparison` only ever looked at corridor edges, so
# any diversion landing just past the buffer was invisible in the report --
# making the nearest corridor street look like it absorbed all the
# diverted traffic, when the simulation may have actually spread some of it
# further out. This wider radius is used only for monitoring/reporting
# (see `monitoring_corridor` in `closure_preview`), never for demand
# generation, so it does not touch the tuned demand model above.
MONITORING_RADIUS_M = 500.0
# Synthetic vehicle departures per simulated minute at demand scale 1.0, for a
# corridor with REFERENCE_CORRIDOR_LANE_KM of capacity. This is a *model
# loading rate*, not an observed Adderley Street count: trips both start and
# end on edges in the 250 m corridor. A 2026 stability sweep on the supplied
# CBD network found that 50/min retained a 92% open-road completion rate on
# the Adderley corridor (10 minute sample, 15 minute scoring horizon). The
# previous presentation-driven value of 160/min completed only 47% and
# therefore started from artificial gridlock.
#
# That sweep fixed the *corridor*, so 50/min is only stable for a corridor
# that size. CORRIDOR_RADIUS_M is a fixed buffer, but corridors it produces
# vary enormously in capacity: a single drawn block can pull in a sparser
# ~4 lane-km of surrounding street, a two-street staged closure ~19 lane-km,
# a long road like Bree ~30. Loading every one of them with the same flat
# demand starved the big corridors and gridlocked the small ones -- the same
# closure looked severe or negligible depending on how much unrelated road
# happened to be nearby, not on the closure itself. Demand is instead scaled
# to each request's own corridor capacity, holding vehicles-per-lane-km (and
# so the saturation level the sweep validated) constant instead of vehicles.
BASE_VEHICLES_PER_MIN = 50.0
# Adderley corridor capacity (sum of lane_count * length_m over corridor_edges
# ("Adderley Street"), in lane-km) at the time of the sweep above -- the
# denominator that turns BASE_VEHICLES_PER_MIN into a per-lane-km rate.
REFERENCE_CORRIDOR_LANE_KM = 19.3
# Keep the scaled rate within the band the sweep actually measured as stable.
# 50/min (scale 1.0) was already the *top* of that band -- 60/min dropped
# completion to 84% on the reference corridor -- so scaling up for a bigger
# corridor is not safe to extrapolate: measured directly on Bree's ~30
# lane-km corridor, a scale of 1.3-1.6 reproduced the exact saturation
# inversion this whole scheme exists to avoid (closure completion *higher*
# than baseline, negative journey-time change). Capping at 1.0 means large
# corridors never get pushed past the validated rate; they just dilute a
# closure's average effect across more alternative routes, which is a real
# property of a big corridor, not a bug. Small corridors still scale down,
# which is the case that was actually gridlocking.
MIN_CORRIDOR_DEMAND_SCALE = 0.3
MAX_CORRIDOR_DEMAND_SCALE = 1.0
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

# A paired estimate is not decision-worthy when the unmodified network is
# already gridlocked or when the paired survivor sample is too small.  Keep
# the raw diagnostics, but make reports withhold impact claims in those cases.
MIN_BASELINE_COMPLETION_RATIO = 0.85
MIN_PAIRED_TRIP_RATIO = 0.20

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
# Historical speed observations -- a step toward ground-truth calibration
# --------------------------------------------------------------------------
#
# There is no real vehicle-count (OD/AADT) dataset bundled with this project,
# and TomTom exposes speed, not volume, so this cannot become true ground
# truth for absolute demand. What it *can* do: build up, over real operating
# time, an empirical record of when this specific network is actually
# congested, and use that to gently correct the fixed time-of-day
# SCENARIOS constants (which started as hand-picked shapes) toward observed
# reality. `record_traffic_observation` is meant to be called on a
# schedule (see server/app.py's startup task); `_historical_scenario_ratio`
# reads back whatever has accumulated so far and stays a no-op, deferring to
# the hand-tuned constant, until there is enough of it to trust.

# Default interval for server/app.py's background collector task (seconds).
# Each tick costs one TomTom request per sampled road (SAMPLE_ROAD_LIMIT, up
# to 16) -- 30 minutes keeps a day's worth of unattended collection well
# under a typical free/trial TomTom quota, leaving headroom for actual
# user-triggered live-scenario and corridor-specific requests. Override with
# the TRAFFIC_OBSERVATION_INTERVAL_S env var for a plan with more headroom.
DEFAULT_TRAFFIC_OBSERVATION_INTERVAL_S = 1800
MIN_HISTORICAL_SAMPLES = 40
MIN_HISTORICAL_DISTINCT_DAYS = 5
# Local hour-of-day each fixed scenario represents, and whether weekends
# should be excluded -- mirrors the plain-language windows in each
# SCENARIOS label above.
SCENARIO_HISTORICAL_WINDOWS: dict[str, dict[str, Any]] = {
    "am_peak": {"hours": range(7, 9), "weekdays_only": True},
    "midday": {"hours": range(11, 14), "weekdays_only": False},
    "pm_peak": {"hours": range(16, 18), "weekdays_only": True},
    "evening": {"hours": range(19, 21), "weekdays_only": False},
}
# Rewritten (rarely -- only once meaningfully over the cap) rather than
# growing forever. ~200k lines is several months of 15-minute samples
# across the ~16-road citywide sample.
MAX_OBSERVATION_LINES = 200_000


def record_traffic_observation() -> int:
    """Append one TomTom speed-ratio sample per citywide sample road.

    Safe to call on an unattended schedule: any failure (no API key, TomTom
    error, no usable roads) is swallowed and simply records nothing for this
    tick, rather than raising into whatever scheduled it.
    """
    try:
        api_key = _tomtom_api_key()
    except RuntimeError:
        return 0
    now_utc = datetime.now(timezone.utc)
    local_now = now_utc.astimezone(CAPE_TOWN_TZ)
    rows = []
    for road in _sample_road_points():
        point = road["sample_point"]
        try:
            segment = _fetch_flow_segment(point["lat"], point["lon"], api_key)
        except Exception:
            continue
        if not segment:
            continue
        current_speed = float(segment.get("currentSpeed") or 0.0)
        free_flow_speed = float(segment.get("freeFlowSpeed") or 0.0)
        if free_flow_speed <= 0:
            continue
        ratio = max(0.05, min(1.2, current_speed / free_flow_speed))
        rows.append({
            "ts": now_utc.isoformat().replace("+00:00", "Z"),
            "date": local_now.date().isoformat(),
            "weekday": local_now.weekday(),
            "hour": local_now.hour,
            "road": road["name"],
            "ratio": round(ratio, 3),
        })
    if not rows:
        return 0
    TRAFFIC_OBSERVATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with TRAFFIC_OBSERVATIONS_PATH.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(json.dumps(row) for row in rows) + "\n")
    _trim_observation_log()
    return len(rows)


def _trim_observation_log(max_lines: int = MAX_OBSERVATION_LINES) -> None:
    if not TRAFFIC_OBSERVATIONS_PATH.exists():
        return
    lines = TRAFFIC_OBSERVATIONS_PATH.read_text(encoding="utf-8").splitlines()
    if len(lines) <= max_lines * 1.2:
        return
    TRAFFIC_OBSERVATIONS_PATH.write_text("\n".join(lines[-max_lines:]) + "\n", encoding="utf-8")


def _historical_scenario_ratio(scenario_key: str) -> dict[str, Any] | None:
    """Mean observed speed ratio for a fixed scenario's representative hours.

    Returns ``None`` until both a minimum sample count and a minimum spread
    of distinct calendar days are met, so a single unusually quiet or busy
    day right after deployment can't masquerade as "this scenario's typical
    congestion" -- callers must fall back to the hand-tuned SCENARIOS
    constant in that case.
    """
    window = SCENARIO_HISTORICAL_WINDOWS.get(scenario_key)
    if window is None or not TRAFFIC_OBSERVATIONS_PATH.exists():
        return None
    ratios: list[float] = []
    days_seen: set[str] = set()
    for line in TRAFFIC_OBSERVATIONS_PATH.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("hour") not in window["hours"]:
            continue
        if window["weekdays_only"] and row.get("weekday", 0) >= 5:
            continue
        ratio = row.get("ratio")
        if not isinstance(ratio, (int, float)):
            continue
        ratios.append(float(ratio))
        if row.get("date"):
            days_seen.add(row["date"])
    if len(ratios) < MIN_HISTORICAL_SAMPLES or len(days_seen) < MIN_HISTORICAL_DISTINCT_DAYS:
        return None
    return {
        "average_ratio": sum(ratios) / len(ratios),
        "sample_count": len(ratios),
        "distinct_days": len(days_seen),
    }


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
    matches = [edge.getID() for edge in net.getEdges() if _edge_name(edge) == road_name]
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


# How many of a corridor's own named roads to query TomTom for, for the
# ``live`` scenario. Kept small: each entry is a synchronous HTTP round trip
# inside the same request that also runs two SUMO simulations, and TomTom
# quota is shared with the citywide live-conditions snapshot.
CORRIDOR_LIVE_SAMPLE_LIMIT = 8


@lru_cache(maxsize=1)
def _local_to_lonlat_transformer() -> Transformer:
    return Transformer.from_crs(LOCAL_CRS, WEB_CRS, always_xy=True)


def _corridor_sample_points(
    corridor: list[dict[str, Any]], limit: int = CORRIDOR_LIVE_SAMPLE_LIMIT
) -> list[dict[str, Any]]:
    """The corridor's own biggest named roads, one sample point each.

    `current_traffic()`'s citywide sample ranks the top ``SAMPLE_ROAD_LIMIT``
    roads network-wide by highway class, so a closure on a smaller street
    could be "live"-scaled entirely from conditions on roads nowhere near it.
    This instead ranks by capacity (lane-km) within the corridor itself, so
    the live scenario reflects the streets actually being simulated.
    """
    config = load_viewer_config()
    origin_x, origin_y = config["origin"]
    transformer = _local_to_lonlat_transformer()
    by_name: dict[str, dict[str, Any]] = {}
    for record in corridor:
        name = record.get("name")
        if not name:
            continue
        capacity = record["lane_count"] * record["length_m"]
        existing = by_name.get(name)
        if existing is None or capacity > existing["capacity"]:
            by_name[name] = {"name": name, "capacity": capacity, "midpoint": record["midpoint"]}
    ranked = sorted(by_name.values(), key=lambda item: item["capacity"], reverse=True)[:limit]
    points = []
    for item in ranked:
        # Local viewer coordinates are origin-shifted and z-flipped relative
        # to the LOCAL_CRS metres `named_roads()` projects from -- invert
        # both before handing the point to the lon/lat transformer.
        projected_x = item["midpoint"].x + origin_x
        projected_y = origin_y - item["midpoint"].y
        longitude, latitude = transformer.transform(projected_x, projected_y)
        points.append({"name": item["name"], "sample_point": {"lon": longitude, "lat": latitude}})
    return points


def _corridor_live_ratios(corridor: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Per-road live speed ratios for the roads actually in this corridor.

    Returns ``None`` (callers fall back to the citywide snapshot) if TomTom
    is unavailable or returns nothing usable -- the ``live`` scenario must
    still work without this, just less spatially targeted.
    """
    try:
        api_key = _tomtom_api_key()
    except RuntimeError:
        return None
    sample_roads = _corridor_sample_points(corridor)
    if not sample_roads:
        return None
    per_road: dict[str, float] = {}
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
        if free_flow_speed <= 0:
            continue
        # Clamped the same way `_demand_scale` clamps its input: a momentary
        # zero-speed reading (e.g. a stopped queue at the sample instant)
        # should not be read as "this street has no capacity at all".
        per_road[road["name"]] = max(0.15, min(1.2, current_speed / free_flow_speed))
    if not per_road:
        return None
    return {
        "per_road_ratio": per_road,
        "average_ratio": sum(per_road.values()) / len(per_road),
        "roads_sampled": len(per_road),
        "roads_requested": len(sample_roads),
    }


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


def _edge_name(edge: Any) -> str:
    """The edge's street name, undoing a `netconvert` double-escaping quirk.

    The raw OSM data has plain text like ``Saint George's Mall``, but
    `netconvert` writes the `cbd.net.xml` edge `name` attribute as
    ``Saint George&amp;apos;s Mall`` -- it XML-escapes the apostrophe to
    `&apos;` and then escapes the resulting `&` a second time, so after
    sumolib's own (correct, single-pass) XML parsing, `edge.getName()`
    still returns a string that literally contains the six characters
    `&apos;` rather than an apostrophe. `html.unescape` undoes exactly that
    residual escaping; it is a no-op for a name that has none.
    """
    return html.unescape(edge.getName())


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

    def local_line(sumo_shape: Any) -> LineString | None:
        """Project and clip a SUMO edge/lane shape into viewer coordinates."""
        points = []
        for x, y in sumo_shape:
            longitude, latitude = net.convertXY2LonLat(x, y)
            projected_x, projected_y = transformer.transform(longitude, latitude)
            points.append((projected_x - origin_x, -(projected_y - origin_y)))
        if len(points) < 2:
            return None
        clipped = LineString(points).intersection(footprint)
        if clipped.is_empty:
            return None
        if clipped.geom_type == "MultiLineString":
            return max(clipped.geoms, key=lambda part: part.length)
        return clipped if clipped.geom_type == "LineString" else None

    records: dict[str, dict[str, Any]] = {}
    for edge in net.getEdges():
        if not edge.allows("passenger"):
            continue
        line = local_line(edge.getShape())
        if line is None:
            continue
        lane_lines = {
            lane.getID(): projected
            for lane in edge.getLanes()
            if (projected := local_line(lane.getShape())) is not None
        }
        lanes = edge.getLanes()
        midpoint = line.interpolate(0.5, normalized=True)
        municipal = _municipal_match(line, _edge_name(edge))
        snap_line = line
        if municipal:
            official_near_edge = _longest_line(municipal["line"].intersection(line.buffer(18.0)))
            if official_near_edge is not None and official_near_edge.length >= 3.0:
                snap_line = official_near_edge
        reverse_siblings = _reverse_siblings(edge)
        records[edge.getID()] = {
            "id": edge.getID(),
            "name": _edge_name(edge),
            "line": line,
            "midpoint": midpoint,
            "lane_count": edge.getLaneNumber(),
            "length_m": edge.getLength(),
            "speed_mps": edge.getSpeed(),
            "visible": footprint.covers(midpoint),
            "snap_line": snap_line,
            # The opposite-direction edge between the same node pair, if any.
            # Lets the UI offer an explicit "which direction stays open"
            # choice for an ordinary two-way street (one lane each way),
            # instead of leaving that up to which side a freehand stroke
            # happens to land nearest.
            "reverse_edge_id": reverse_siblings[0].getID() if reverse_siblings else None,
            # Lane index in this network runs left-to-right across every
            # multi-lane edge checked (verified against the actual lane
            # geometry, not just SUMO's general convention) -- so index 0 is
            # the kerbside lane for Cape Town's left-hand traffic. Keeping its
            # real offset geometry lets the UI show and select the lane that
            # will actually be disallowed, rather than painting the full road
            # centreline and implying a whole-street closure.
            "lane_lines": lane_lines,
            "closure_lane_id": lanes[0].getID() if len(lanes) >= 2 else None,
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
            "reverse_edge_id": record.get("reverse_edge_id"),
            "points": [[round(x, 1), round(z, 1)] for x, z in record["line"].coords],
            "snap_points": [[round(x, 1), round(z, 1)] for x, z in record["snap_line"].coords],
            "lane_points": (
                [[round(x, 1), round(z, 1)] for x, z in record["lane_lines"][record["closure_lane_id"]].coords]
                if record["closure_lane_id"] in record["lane_lines"] else None
            ),
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


def _records_bounds(records: list[dict[str, Any]]) -> list[float] | None:
    if not records:
        return None
    min_x, min_z, max_x, max_z = unary_union([record["line"] for record in records]).bounds
    return [round(min_x, 1), round(min_z, 1), round(max_x, 1), round(max_z, 1)]


def _corridor_lane_km(corridor: list[dict[str, Any]]) -> float:
    """Total lane-km of capacity in a corridor (sum of lane_count * length)."""
    return sum(record["lane_count"] * record["length_m"] for record in corridor) / 1000.0


def _corridor_demand_scale(corridor: list[dict[str, Any]]) -> float:
    """How this corridor's demand rate should scale relative to the reference.

    Held to [MIN_CORRIDOR_DEMAND_SCALE, MAX_CORRIDOR_DEMAND_SCALE] because the
    stability sweep behind BASE_VEHICLES_PER_MIN only measured saturation
    around the reference corridor's size; clamping keeps a pathologically
    small or large corridor from extrapolating that result past what was
    actually tested.
    """
    lane_km = _corridor_lane_km(corridor)
    if lane_km <= 0:
        return MIN_CORRIDOR_DEMAND_SCALE
    raw_scale = lane_km / REFERENCE_CORRIDOR_LANE_KM
    return max(MIN_CORRIDOR_DEMAND_SCALE, min(MAX_CORRIDOR_DEMAND_SCALE, raw_scale))


def resolve_scenario(scenario: str, live_average_ratio: float | None = None) -> dict[str, Any]:
    """Resolve a named time-of-day profile into concrete demand parameters."""
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario: {scenario!r} (expected one of {sorted(SCENARIOS)})")
    profile = SCENARIOS[scenario]
    demand_scale = profile["demand_scale"]
    historical_calibration: dict[str, Any] | None = None
    if demand_scale is None:
        ratio = 0.85 if live_average_ratio is None else live_average_ratio
        demand_scale = _demand_scale(ratio)
    else:
        historical = _historical_scenario_ratio(scenario)
        if historical is not None:
            implied_scale = _demand_scale(historical["average_ratio"])
            blended = 0.5 * demand_scale + 0.5 * implied_scale
            # Real observations can only *nudge* the stability-swept constant,
            # not override it -- keeps the result inside the narrow band that
            # was actually validated against gridlock (see project memory on
            # BASE_VEHICLES_PER_MIN), even once months of history accumulate.
            demand_scale = max(demand_scale * 0.7, min(demand_scale * 1.3, blended))
            historical_calibration = {
                "applied": True,
                "sample_count": historical["sample_count"],
                "distinct_days": historical["distinct_days"],
                "observed_average_speed_ratio": round(historical["average_ratio"], 3),
            }
    return {
        "key": scenario,
        "label": profile["label"],
        "demand_scale": float(demand_scale),
        "inbound_bias": float(profile["inbound_bias"]),
        "historical_calibration": historical_calibration,
    }


def _reverse_siblings(edge: Any) -> list[Any]:
    """The opposite-direction edge(s) running between the same node pair.

    SUMO/netconvert bakes direction into the network at build time -- there is
    no live "reverse this lane" call in TraCI. A two-way street is modelled as
    two directional edges between the same node pair, so converting a street
    to one-way is done by fully closing the sibling edge running the other
    way (the same `setDisallowed` mechanism a ``full`` closure already uses),
    not by mutating direction.
    """
    from_id = edge.getFromNode().getID()
    return [
        candidate for candidate in edge.getToNode().getOutgoing()
        if candidate.getToNode().getID() == from_id
        and candidate.getID() != edge.getID()
        and candidate.allows("passenger")
    ]


def _remaining_open_direction(closed_edge_ids: set[str], net: Any) -> list[str]:
    """Which direction(s) stay open purely because their sibling is closed.

    Computed from the actual closed-edge set rather than a request flag, so
    it recognises a one-way outcome regardless of how the closure was
    produced -- a plain ``full`` closure of one direction of an ordinary
    two-way street (what the dedicated "one-way" drawing tool submits, with
    no flag at all) counts exactly the same as the flag-driven lane+reverse
    combination.
    """
    by_id = {edge.getID(): edge for edge in net.getEdges()}
    return sorted({
        sibling.getID()
        for edge_id in closed_edge_ids
        if (edge := by_id.get(edge_id)) is not None
        for sibling in _reverse_siblings(edge)
        if sibling.getID() not in closed_edge_ids
    })


def _reverse_edge_ids(edges: list[Any]) -> dict[str, list[str]]:
    """Find each edge's opposite-direction sibling(s), across a whole selection.

    Edges with no such sibling are already one-way in the source data and are
    reported separately rather than silently treated as closed.
    """
    reverse_ids: list[str] = []
    already_one_way: list[str] = []
    for edge in edges:
        siblings = _reverse_siblings(edge)
        if siblings:
            reverse_ids.extend(sibling.getID() for sibling in siblings)
        else:
            already_one_way.append(edge.getID())
    return {
        "reverse_edge_ids": sorted(set(reverse_ids)),
        "already_one_way_edge_ids": sorted(set(already_one_way)),
    }


def resolve_closure_lanes(
    road_name: str,
    closure_mode: str,
    closure_scope: str = "road",
    one_way: bool = False,
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
        if _edge_name(edge) == road_name and edge.allows("passenger")
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
    reverse = _reverse_edge_ids(edges) if one_way else {"reverse_edge_ids": [], "already_one_way_edge_ids": []}
    return {
        "lane_ids": lane_ids,
        "edge_ids": sorted(set(edge_ids) | set(reverse["reverse_edge_ids"])),
        "affected_edge_ids": (
            edge_ids if closure_mode == "full"
            else [edge.getID() for edge in edges if len(edge.getLanes()) >= 2]
        ),
        "one_way": one_way,
        "reverse_edge_ids": reverse["reverse_edge_ids"],
        "already_one_way_edge_ids": reverse["already_one_way_edge_ids"],
        "edges_total": len(edges),
        "edges_narrowed": narrowed,
        "edges_skipped_single_lane": skipped_single_lane,
        "scope": closure_scope,
    }


def resolve_drawn_closure(
    edge_ids: list[str],
    closure_mode: str,
    one_way: bool = False,
) -> dict[str, Any]:
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
    narrowed_edge_ids: list[str] = []
    narrowed = 0
    skipped_single_lane = 0
    for edge in edges:
        lanes = edge.getLanes()
        if closure_mode == "full":
            lane_ids.extend(lane.getID() for lane in lanes)
            closed_edge_ids.append(edge.getID())
        elif len(lanes) >= 2:
            lane_ids.append(lanes[0].getID())
            narrowed_edge_ids.append(edge.getID())
            narrowed += 1
        else:
            skipped_single_lane += 1
    if not lane_ids:
        raise ValueError("the drawn section has no multi-lane road to narrow; use a full closure")

    road_names = sorted({_edge_name(edge) for edge in edges if _edge_name(edge)})
    reverse = _reverse_edge_ids(edges) if one_way else {"reverse_edge_ids": [], "already_one_way_edge_ids": []}
    return {
        "lane_ids": lane_ids,
        "edge_ids": sorted(set(closed_edge_ids) | set(reverse["reverse_edge_ids"])),
        # Selected single-lane sections are explicitly skipped above, so do
        # not colour or report them as closed in the response.
        "affected_edge_ids": closed_edge_ids if closure_mode == "full" else narrowed_edge_ids,
        "requested_edge_ids": requested_ids,
        "one_way": one_way,
        "reverse_edge_ids": reverse["reverse_edge_ids"],
        "already_one_way_edge_ids": reverse["already_one_way_edge_ids"],
        "edges_total": len(edges),
        "edges_narrowed": narrowed,
        "edges_skipped_single_lane": skipped_single_lane,
        "scope": "drawn",
        "road_names": road_names,
        "label": ", ".join(road_names[:3]) + ("…" if len(road_names) > 3 else "") or "Drawn road section",
    }


def _trip_weights(
    corridor: list[dict[str, Any]],
    inbound_bias: float,
    road_congestion: dict[str, float] | None = None,
) -> tuple[list[float], list[float]]:
    """Origin/destination sampling weights for one corridor.

    Base weight favours long, multi-lane, fast edges -- a six-lane arterial
    should originate far more trips than a short service road. `inbound_bias`
    then tilts origins outward and destinations inward (morning commute) or
    the reverse (afternoon), using distance from the viewer origin, which sits
    on the CBD core. `road_congestion` (the ``live`` scenario's per-road
    TomTom speed ratio, see `_corridor_live_ratios`) then nudges weight
    toward streets that are *currently* congested -- a proxy for real
    concentrated demand, since a road can only be jammed if more trips want
    it right now than it can carry.
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
        # Kept in the same ~0.6-1.6x band as `priority_factor` above so a
        # single congested sample can't dominate the capacity-driven base
        # weight -- this is a nudge toward realistic hotspots, not a
        # replacement for the lane/length/priority model.
        ratio = (road_congestion or {}).get(record.get("name") or "")
        congestion_factor = max(0.6, min(1.6, 1.55 - ratio * 1.1)) if ratio is not None else 1.0
        base *= congestion_factor
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
    road_congestion: dict[str, float] | None = None,
) -> tuple[Path, int]:
    """Write a corridor-scoped trip file and return it with its vehicle count.

    Replaces SUMO's ``randomTrips.py``: that tool samples the whole network
    with no notion of which edges are on camera, which is what scattered
    vehicles across (and off) the map. Generating trips here also removes a
    subprocess and its timeout from the request path.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    origin_weights, destination_weights = _trip_weights(corridor, inbound_bias, road_congestion)
    departure_window_s = float(duration_s) * DEPARTURE_WINDOW_FRACTION
    # Keep the arrival stream stable when the sampling window changes. With a
    # fixed demand rate, a 20-minute run now extends the 10-minute trip stream
    # instead of reshuffling every departure and route. This makes duration
    # sensitivity meaningful and greatly reduces contradictory short/long
    # comparisons caused by different random populations.
    departure_interval_s = departure_window_s / max(vehicle_count, 1)
    trips: list[tuple[float, str, str, str]] = []
    fleet_types = list(FLEET_MIX)
    fleet_weights = list(FLEET_MIX.values())
    for candidate_index in range(vehicle_count):
        origin = rng.choices(corridor, weights=origin_weights, k=1)[0]
        destination = rng.choices(corridor, weights=destination_weights, k=1)[0]
        # A trip that starts and ends on the same edge has nothing to route.
        if destination["id"] == origin["id"]:
            continue
        vehicle_type = rng.choices(fleet_types, weights=fleet_weights, k=1)[0]
        depart = (candidate_index + rng.random()) * departure_interval_s
        trips.append((depart, origin["id"], destination["id"], vehicle_type))
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
        return {
            "trip_count": 0,
            "mean_duration_s": 0.0,
            "mean_depart_delay_s": 0.0,
            "mean_journey_time_s": 0.0,
            "mean_time_loss_s": 0.0,
            "mean_speed_mps": 0.0,
            "total_distance_m": 0.0,
            "per_vehicle": {},
        }
    root = ElementTree.parse(path).getroot()
    durations, depart_delays, journey_times, time_losses, distances, speeds = [], [], [], [], [], []
    per_vehicle: dict[str, dict[str, float]] = {}
    for trip in root.findall("tripinfo"):
        duration = float(trip.get("duration", 0.0))
        depart_delay = float(trip.get("departDelay", 0.0))
        journey_time = duration + depart_delay
        route_length = float(trip.get("routeLength", 0.0))
        time_loss = float(trip.get("timeLoss", 0.0))
        durations.append(duration)
        depart_delays.append(depart_delay)
        journey_times.append(journey_time)
        time_losses.append(time_loss)
        distances.append(route_length)
        if duration > 0:
            speeds.append(route_length / duration)
        vehicle_id = trip.get("id")
        if vehicle_id is not None:
            per_vehicle[vehicle_id] = {
                "duration_s": duration,
                "depart_delay_s": depart_delay,
                "journey_time_s": journey_time,
                "time_loss_s": time_loss,
                "route_length_m": route_length,
                "speed_mps": route_length / duration if duration > 0 else 0.0,
            }
    trip_count = len(durations)
    return {
        "trip_count": trip_count,
        "mean_duration_s": sum(durations) / trip_count if trip_count else 0.0,
        "mean_depart_delay_s": sum(depart_delays) / trip_count if trip_count else 0.0,
        "mean_journey_time_s": sum(journey_times) / trip_count if trip_count else 0.0,
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
        edge_id: {
            "samples": 0.0,
            "vehicle_count": 0.0,
            "speed_vehicle_sum": 0.0,
            "halted": 0.0,
        }
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
                    # LAST_STEP_MEAN_SPEED is an average over vehicles on the
                    # edge. Weight it by the number present so empty edge-time
                    # samples do not incorrectly drag a road's reported speed
                    # toward zero.
                    totals["speed_vehicle_sum"] += (
                        max(0.0, result.get(traci.constants.LAST_STEP_MEAN_SPEED, 0.0))
                        * vehicle_count
                    )
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
    metrics["edge_stats"] = _summarize_edge_totals(edge_totals)
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
        "exclusions": (
            "tailpipe model only; excludes vehicles waiting to enter the network, "
            "non-exhaust particles, cold-start adjustment and lifecycle emissions"
        ),
    }
    return {"tracks": finished_tracks}, metrics


def _summarize_edge_totals(
    edge_totals: dict[str, dict[str, float]],
) -> dict[str, dict[str, float]]:
    """Convert sampled edge totals into occupancy and vehicle-weighted speed."""
    return {
        edge_id: {
            "mean_vehicle_count": (
                totals["vehicle_count"] / totals["samples"] if totals["samples"] else 0.0
            ),
            "mean_speed_mps": (
                totals["speed_vehicle_sum"] / totals["vehicle_count"]
                if totals["vehicle_count"] else 0.0
            ),
            "mean_halted": totals["halted"] / totals["samples"] if totals["samples"] else 0.0,
        }
        for edge_id, totals in edge_totals.items()
    }


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

    def pct_change(before: float | None, after: float | None) -> float | None:
        if before is None or after is None or before == 0:
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
        before_depart_delay = mean([baseline_trips[key].get("depart_delay_s", 0.0) for key in shared])
        after_depart_delay = mean([closure_trips[key].get("depart_delay_s", 0.0) for key in shared])
        before_journey = mean([
            baseline_trips[key].get(
                "journey_time_s",
                baseline_trips[key]["duration_s"] + baseline_trips[key].get("depart_delay_s", 0.0),
            )
            for key in shared
        ])
        after_journey = mean([
            closure_trips[key].get(
                "journey_time_s",
                closure_trips[key]["duration_s"] + closure_trips[key].get("depart_delay_s", 0.0),
            )
            for key in shared
        ])
        before_loss = mean([baseline_trips[key]["time_loss_s"] for key in shared])
        after_loss = mean([closure_trips[key]["time_loss_s"] for key in shared])
        before_speed = mean([baseline_trips[key]["speed_mps"] for key in shared])
        after_speed = mean([closure_trips[key]["speed_mps"] for key in shared])
        before_distance = mean([baseline_trips[key]["route_length_m"] for key in shared])
        after_distance = mean([closure_trips[key]["route_length_m"] for key in shared])
        comparison = "paired_on_trips_completed_in_both_runs"
    else:
        # An unpaired before/after average can reverse the apparent result when
        # the closure prevents the slowest trips from finishing. There is no
        # defensible trip-level change when no vehicle completed both runs.
        before_duration = after_duration = None
        before_depart_delay = after_depart_delay = None
        before_journey = after_journey = None
        before_loss = after_loss = None
        before_speed = after_speed = None
        before_distance = after_distance = None
        comparison = "unavailable_no_shared_completed_trips"

    def difference(before: float | None, after: float | None) -> float | None:
        return after - before if before is not None and after is not None else None

    simulation_complete = not (
        baseline.get("truncated_by_time_budget", False)
        or closure.get("truncated_by_time_budget", False)
    )
    minimum_paired_trips = (
        1 if planned_count < 20
        else max(10, math.ceil(planned_count * 0.10))
    )
    baseline_completion_ratio = baseline["trip_count"] / planned_count if planned_count else None
    paired_trip_ratio = len(shared) / planned_count if planned_count else None
    baseline_stable = bool(
        baseline_completion_ratio is not None
        and baseline_completion_ratio >= MIN_BASELINE_COMPLETION_RATIO
    )
    paired_sample_sufficient = bool(
        len(shared) >= minimum_paired_trips
        and paired_trip_ratio is not None
        and paired_trip_ratio >= MIN_PAIRED_TRIP_RATIO
    )
    validity_reasons = []
    if not simulation_complete:
        validity_reasons.append("simulation_time_limit")
    if not baseline_stable:
        validity_reasons.append("open_road_baseline_overloaded")
    if not paired_sample_sufficient:
        validity_reasons.append("paired_sample_too_small")
    comparison_metrics = {
        "baseline": {
            "mean_duration_s": before_duration,
            "mean_depart_delay_s": before_depart_delay,
            "mean_journey_time_s": before_journey,
            "mean_time_loss_s": before_loss,
            "mean_speed_mps": before_speed,
            "mean_route_length_m": before_distance,
        },
        "closure": {
            "mean_duration_s": after_duration,
            "mean_depart_delay_s": after_depart_delay,
            "mean_journey_time_s": after_journey,
            "mean_time_loss_s": after_loss,
            "mean_speed_mps": after_speed,
            "mean_route_length_m": after_distance,
        },
    }

    before_environment = baseline.get("environment") or {}
    after_environment = closure.get("environment") or {}
    return {
        "comparison": comparison,
        "compared_trip_count": len(shared),
        "paired_trip_ratio": paired_trip_ratio,
        "minimum_paired_trips": minimum_paired_trips,
        "minimum_paired_trip_ratio": MIN_PAIRED_TRIP_RATIO,
        "paired_sample_sufficient": paired_sample_sufficient,
        "minimum_baseline_completion_ratio": MIN_BASELINE_COMPLETION_RATIO,
        "baseline_stable": baseline_stable,
        "validity_reasons": validity_reasons,
        "simulation_complete": simulation_complete,
        "assessment_ready": bool(shared) and paired_sample_sufficient and baseline_stable and simulation_complete,
        "comparison_metrics": comparison_metrics,
        "mean_journey_time_change_s": difference(before_journey, after_journey),
        "mean_journey_time_change_pct": pct_change(before_journey, after_journey),
        "mean_duration_change_s": difference(before_duration, after_duration),
        "mean_duration_change_pct": pct_change(before_duration, after_duration),
        "mean_depart_delay_change_s": difference(before_depart_delay, after_depart_delay),
        "mean_time_loss_change_s": difference(before_loss, after_loss),
        "mean_time_loss_change_pct": pct_change(before_loss, after_loss),
        "mean_speed_change_mps": difference(before_speed, after_speed),
        "mean_speed_change_pct": pct_change(before_speed, after_speed),
        "mean_route_length_change_m": difference(before_distance, after_distance),
        "mean_route_length_change_pct": pct_change(before_distance, after_distance),
        "mean_queued_vehicle_change": closure.get("mean_queued_vehicles", 0.0) - baseline.get("mean_queued_vehicles", 0.0),
        "max_queue_baseline": baseline.get("max_queued_vehicles", 0),
        "max_queue_closure": closure.get("max_queued_vehicles", 0),
        "completed_trip_ratio_baseline": baseline_completion_ratio,
        "completed_trip_ratio_closure": closure["trip_count"] / planned_count if planned_count else None,
        "completed_trip_change": closure["trip_count"] - baseline["trip_count"],
        "completion_change_percentage_points": (
            (closure["trip_count"] - baseline["trip_count"]) / planned_count * 100.0
            if planned_count else None
        ),
        "environment": {
            key: {
                "baseline": before_environment.get(key, 0.0),
                "closure": after_environment.get(key, 0.0),
                "change": after_environment.get(key, 0.0) - before_environment.get(key, 0.0),
                # A percentage change is not meaningful for logarithmic dB.
                "change_pct": (
                    None if key == "mean_active_edge_noise_db"
                    else pct_change(
                        before_environment.get(key, 0.0), after_environment.get(key, 0.0)
                    )
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
    """Collapse changed edges into meaningful concurrent street totals.

    Edge vehicle counts are already concurrent occupancies and naturally grow
    with edge length, so length-weighting them again would double-count long
    sections. Counts and halted vehicles are summed across changed sections;
    speed is weighted by the closure-run vehicle occupancy on each edge.
    """
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
            "vehicle_delta_total": 0.0,
            "closure_speed_weighted": 0.0,
            "closure_speed_weight": 0.0,
            "closure_halted_total": 0.0,
        })
        item["section_count"] += 1
        item["length_m"] += length
        item["vehicle_delta_total"] += float(segment.get("vehicle_delta") or 0.0)
        occupancy = max(0.0, float(segment.get("closure_vehicles") or 0.0))
        item["closure_speed_weighted"] += float(segment.get("closure_speed_mps") or 0.0) * occupancy
        item["closure_speed_weight"] += occupancy
        item["closure_halted_total"] += float(segment.get("closure_halted") or 0.0)

    summary = []
    for item in grouped.values():
        speed_weight = item["closure_speed_weight"]
        summary.append({
            "name": item["name"],
            "section_count": item["section_count"],
            "modelled_length_m": round(item["length_m"], 1),
            "vehicle_delta": round(item["vehicle_delta_total"], 2),
            "closure_speed_mps": round(
                item["closure_speed_weighted"] / speed_weight if speed_weight else 0.0, 2
            ),
            "closure_halted": round(item["closure_halted_total"], 2),
            "aggregation": "sum_of_concurrent_changes_speed_weighted_by_vehicle_occupancy",
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
    # `one_way` fully closes the reverse-direction sibling of whatever is
    # selected, on top of whatever this closure_mode already closes. For
    # ``full`` mode that sibling closure is redundant -- the selected
    # direction is already closed entirely -- and would silently turn a
    # one-direction closure into a two-direction one while still reporting
    # it as "converted to one-way". It only means something for ``lane``
    # mode, where narrowing one direction does not by itself touch the other.
    one_way = bool(payload.get("one_way", False)) and closure_mode == "lane"
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

    net = _sumo_net()
    if requested_edge_ids:
        closure = resolve_drawn_closure(requested_edge_ids, closure_mode, one_way=one_way)
        road_name = closure["label"]
        closure_scope = "drawn"
        corridor = corridor_edges_for_ids(closure["requested_edge_ids"], road_name)
        monitoring_corridor = corridor_edges_for_ids(
            closure["requested_edge_ids"], road_name, radius_m=MONITORING_RADIUS_M
        )
    else:
        corridor = corridor_edges(road_name)
        monitoring_corridor = corridor_edges(road_name, radius_m=MONITORING_RADIUS_M)
        closure = resolve_closure_lanes(road_name, closure_mode, closure_scope, one_way=one_way)

    # Corridor is now known, so the `live` scenario can be grounded in
    # TomTom conditions on the streets actually being simulated rather than
    # a citywide sample that may have nothing to do with this corridor. Falls
    # back to the citywide snapshot, then to a neutral ratio, if the
    # corridor-specific fetch comes back empty (e.g. TomTom has no segment
    # data for these particular streets).
    live_ratio: float | None = None
    live_calibration: dict[str, Any] | None = None
    road_congestion: dict[str, float] | None = None
    if scenario_key == "live":
        corridor_live = _corridor_live_ratios(corridor)
        if corridor_live:
            live_ratio = corridor_live["average_ratio"]
            road_congestion = corridor_live["per_road_ratio"]
            live_calibration = {
                "corridor_specific": True,
                "roads_sampled": corridor_live["roads_sampled"],
                "roads_requested": corridor_live["roads_requested"],
            }
        else:
            try:
                live_ratio = float(current_traffic().get("average_speed_ratio", 0.85))
            except Exception:
                live_ratio = None
            live_calibration = {"corridor_specific": False, "roads_sampled": 0, "roads_requested": 0}
    scenario = resolve_scenario(scenario_key, live_ratio)
    monitored_edge_ids = [record["id"] for record in monitoring_corridor]

    duration_s = int(duration_min * 60)
    corridor_lane_km = _corridor_lane_km(corridor)
    corridor_demand_scale = _corridor_demand_scale(corridor)
    demand_rate_per_min = BASE_VEHICLES_PER_MIN * corridor_demand_scale
    vehicle_target = int(
        demand_rate_per_min * duration_min * scenario["demand_scale"] * demand_multiplier
    )
    # A stable hash (not the builtin `hash()`, which is salted per-process)
    # so the same request always gets the same synthetic demand -- otherwise
    # repeat previews would be silently non-reproducible and the "seed"
    # reported in demand_model would be meaningless. Sorted rather than
    # request order: the browser's freehand draw tool appends edges in
    # whatever order the cursor happens to cross them, so retracing the
    # same street a second time (even in the same direction) rarely
    # reproduces the exact same order -- without sorting, two draws that
    # close the *same set* of road sections got different seeds, and so a
    # visually identical closure could land in a different severity band
    # between runs for no reason a user could see on the map.
    selection_seed = ",".join(sorted(requested_edge_ids)) if requested_edge_ids else road_name
    # Duration deliberately does not affect the seed: changing 10 to 20
    # minutes should extend the same demand stream, not invent a new scenario.
    seed = zlib.crc32(
        f"{selection_seed}|{scenario_key}|{demand_multiplier}".encode("utf-8")
    )
    # Applied to the simulation from monitoring_corridor, not the 250 m
    # demand corridor: SUMO applies these network-wide via traci regardless
    # of which edges are "in" the corridor, so a vehicle rerouting just past
    # 250 m used to fall back to the network's generic default speed there
    # even when a real municipal limit was available for that block.
    municipal_speed_limits, _monitoring_speed_limit_counts = _speed_limit_overrides(monitoring_corridor)
    # road_data's coverage reporting below stays scoped to `corridor` and
    # uses its own separate tally -- kept distinct from the wider
    # `municipal_speed_limits` above so "confirmed/inferred applied" and
    # "records matched" describe the same area instead of one being a
    # superset of the other.
    _, speed_limit_counts = _speed_limit_overrides(corridor)
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
            road_congestion=road_congestion,
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
    # Uses the wider monitoring_corridor, not the 250 m demand corridor --
    # SUMO's router isn't confined to 250 m, so without this a diversion
    # landing just past the demand buffer would be silently dropped from the
    # report rather than shown.
    flow_comparison = _flow_comparison(
        monitoring_corridor,
        baseline_metrics.get("edge_stats", {}),
        closure_metrics.get("edge_stats", {}),
    )
    street_flow_summary = _aggregate_flow_by_street(flow_comparison)
    index = _edge_index()
    affected_records = [
        index[edge_id] for edge_id in closure["affected_edge_ids"] if edge_id in index
    ]
    if closure_mode == "lane":
        closed_lane_ids = set(closure["lane_ids"])
        closure_geometry_records = [
            {"id": lane_id, "name": record.get("name"), "line": lane_line}
            for record in affected_records
            for lane_id, lane_line in record.get("lane_lines", {}).items()
            if lane_id in closed_lane_ids
        ]
    else:
        closure_geometry_records = affected_records
    reverse_edge_ids = closure.get("reverse_edge_ids") or []
    already_one_way_edge_ids = closure.get("already_one_way_edge_ids") or []
    one_way_geometry_records = [index[edge_id] for edge_id in reverse_edge_ids if edge_id in index]
    remaining_open_edge_ids = _remaining_open_direction(set(closure["edge_ids"]), net)
    remaining_open_geometry_records = [index[edge_id] for edge_id in remaining_open_edge_ids if edge_id in index]
    # Per-vehicle rows exist only to pair the two runs; sending thousands of
    # them to the viewer would dwarf the trajectories they came from.
    baseline_metrics.pop("per_vehicle", None)
    closure_metrics.pop("per_vehicle", None)
    baseline_metrics.pop("edge_stats", None)
    closure_metrics.pop("edge_stats", None)

    base_description = (
        f"kerbside lane closed on {closure['edges_narrowed']} of "
        f"{closure['edges_total']} "
        f"{'section' if closure['edges_total'] == 1 else 'sections'}"
        if closure_mode == "lane"
        else f"all lanes closed on {closure['edges_total']} "
        f"{'section' if closure['edges_total'] == 1 else 'sections'}"
    )
    # Driven by the actual closed-edge topology rather than the `one_way`
    # request flag, so a plain full closure of one direction of a two-way
    # street (submitted by the dedicated "one-way" drawing tool, with no
    # flag at all) is reported and drawn the same way as the flag-driven
    # lane+reverse-closure case -- both leave the same kind of remainder.
    one_way_description = None
    if remaining_open_edge_ids:
        one_way_description = (
            f"other direction remains open, one-way, on "
            f"{len(remaining_open_edge_ids)} "
            f"{'section' if len(remaining_open_edge_ids) == 1 else 'sections'}"
        )
    elif one_way and already_one_way_edge_ids:
        one_way_description = "already one-way in the source data; no reverse-direction edge to close"

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
            "one_way": one_way,
            "reverse_edges_closed": len(reverse_edge_ids),
            "already_one_way_edges": len(already_one_way_edge_ids),
            # Whether this closure leaves a two-way street operating
            # one-way -- true whenever a closed edge's opposite-direction
            # sibling remains open, regardless of which drawing tool or
            # request flag produced the closure.
            "functions_as_one_way": bool(remaining_open_edge_ids),
            "remaining_open_edges": len(remaining_open_edge_ids),
            # Lane closures use the actual offset kerbside-lane shapes. Full closures
            # use the road edge centreline. The old response always returned
            # the centreline, which made a one-lane intervention look like the
            # whole carriageway was closed and could paint skipped sections.
            "geometry_local": _lines_payload(closure_geometry_records),
            # Reverse-direction edges closed by the `one_way` request flag,
            # kept separate from `geometry_local` so the report can draw the
            # "narrowed lane" and "made one-way" interventions distinctly.
            "one_way_geometry_local": _lines_payload(one_way_geometry_records),
            # The direction that stays open precisely because its sibling is
            # closed -- see `functions_as_one_way` above. This is what the
            # report/map should draw as "stays open, one-way".
            "remaining_open_geometry_local": _lines_payload(remaining_open_geometry_records),
            "description": (
                f"{base_description}; {one_way_description}" if one_way_description else base_description
            ),
        },
        "corridor": {
            "radius_m": CORRIDOR_RADIUS_M,
            "edge_count": len(corridor),
            "lane_km": round(corridor_lane_km, 2),
            # Viewer-local [minX, minZ, maxX, maxZ] of the closed road itself,
            # so the camera can frame the thing the user asked about instead
            # of leaving them to hunt for it across the whole CBD.
            "road_bounds_local": _records_bounds(closure_geometry_records) or _road_bounds_local(road_name),
            "note": "demand is generated only between visible edges inside this corridor",
            # SUMO's router runs on the full network regardless of this
            # radius; only the *reporting* radius is wider, so diversion
            # landing just past the demand corridor still shows up in
            # flow_comparison/street_flow_summary instead of being dropped.
            "monitoring_radius_m": MONITORING_RADIUS_M,
            "monitoring_edge_count": len(monitoring_corridor),
        },
        "demand_model": {
            "generator": "corridor-scoped synthetic trips, lane/length weighted, time-of-day biased",
            "base_departures_per_min": BASE_VEHICLES_PER_MIN,
            "reference_corridor_lane_km": REFERENCE_CORRIDOR_LANE_KM,
            "corridor_demand_scale": round(corridor_demand_scale, 3),
            "demand_departures_per_min": round(demand_rate_per_min, 1),
            "calibration_basis": (
                "network-stability sweep on the supplied Cape Town CBD SUMO network, "
                "scaled to this corridor's lane-km relative to the reference corridor"
            ),
            # Genuinely false, always: TomTom (below) gives speed, never
            # vehicle counts, so this project has no real trip-volume ground
            # truth to calibrate against -- see `historical_speed_calibration`
            # for what real data *is* folded in.
            "observed_count_calibration": False,
            "scenario": scenario["key"],
            "demand_scale": scenario["demand_scale"],
            "user_demand_multiplier": demand_multiplier,
            "inbound_bias": scenario["inbound_bias"],
            # Only set for the fixed am_peak/midday/pm_peak/evening profiles,
            # and only once the background collector (see server/app.py) has
            # built up enough real TomTom history -- nudges (not replaces)
            # the hand-tuned demand_scale toward this network's own observed
            # congestion pattern for that time window. `None` means either
            # this is the `live` scenario (see `live_calibration` instead)
            # or there isn't enough history yet.
            "historical_speed_calibration": scenario.get("historical_calibration"),
            "live_average_speed_ratio": live_ratio,
            # Only set for scenario == "live" -- whether the demand level and
            # spatial weighting came from TomTom conditions on this
            # corridor's own roads, or fell back to the citywide snapshot
            # because no corridor-specific segment data was available.
            "live_calibration": live_calibration,
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
            "scoring_horizon_s": int(duration_s * DRAIN_FACTOR),
        },
        "trajectories": {
            "baseline": baseline_tracks,
            "closure": closure_tracks,
        },
    }
