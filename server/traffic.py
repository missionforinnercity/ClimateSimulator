"""Live traffic conditions (TomTom) and SUMO-based lane-closure impact simulation.

Mirrors the caching shape of ``server/weather.py`` for the live-conditions
half, and an ``lru_cache``-memoized parse for the
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

Without an enabled route-sampler profile this is an estimate, not a calibrated
traffic model: demand is synthetic and scaled by road class, time-of-day
profile and live TomTom congestion. Observed edge and turning counts can be
configured per scenario to replace that population with routeSampler output.
"""

from __future__ import annotations

import html
import json
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
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
TRAFFIC_CALIBRATION_PATH = PROJECT_ROOT / "data" / "traffic_calibration.json"
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
MIN_SIMULATION_WALL_CLOCK_BUDGET_S = 45.0
MAX_SIMULATION_WALL_CLOCK_BUDGET_S = 135.0
MAX_SUMO_SEED = 2_147_483_647


def _sumo_seed(value: int) -> int:
    """Map deterministic hashes into SUMO's accepted signed-int range."""
    return int(value) % (MAX_SUMO_SEED + 1)


def _simulation_runtime_settings(duration_s: int) -> tuple[int, float]:
    """Scale payload sampling and CPU allowance with the requested window."""
    sample_interval_s = max(TRAJECTORY_SAMPLE_INTERVAL_S, min(6, math.ceil(duration_s / 180)))
    wall_clock_budget_s = min(
        MAX_SIMULATION_WALL_CLOCK_BUDGET_S,
        MIN_SIMULATION_WALL_CLOCK_BUDGET_S + max(0, duration_s - 300) * 0.1,
    )
    return sample_interval_s, wall_clock_budget_s


def _ensemble_seeds(configuration: Any, base_seed: int) -> list[int]:
    """Resolve an optional runSeeds-style seed ensemble, bounded for the API."""
    if not isinstance(configuration, dict) or not configuration.get("enabled", False):
        return [_sumo_seed(base_seed)]
    raw_seeds = configuration.get("seeds")
    if raw_seeds is None:
        raw_seeds = [base_seed + offset for offset in range(3)]
    if not isinstance(raw_seeds, list):
        raise ValueError("run_seeds.seeds must be a list of integer seeds")
    seeds = []
    for value in raw_seeds:
        try:
            seed = int(value)
        except (TypeError, ValueError) as error:
            raise ValueError("run_seeds.seeds must contain integer seeds") from error
        if seed < 0:
            raise ValueError("run_seeds.seeds must be non-negative")
        seed = _sumo_seed(seed)
        if seed not in seeds:
            seeds.append(seed)
    if len(seeds) < 2:
        raise ValueError("run_seeds requires at least two distinct seeds")
    if len(seeds) > MAX_ENSEMBLE_SEEDS:
        raise ValueError(f"run_seeds supports at most {MAX_ENSEMBLE_SEEDS} seeds per request")
    return seeds


def _ensemble_summary(impacts: list[dict[str, Any]], seeds: list[int]) -> dict[str, Any]:
    """Return robust central estimates and ranges from paired seed runs."""
    if len(impacts) != len(seeds):
        raise ValueError("each ensemble seed must have exactly one impact result")

    ready_impacts = [impact for impact in impacts if impact.get("assessment_ready")]
    journey_impacts = [impact for impact in ready_impacts if impact.get("journey_time_ready", True)]

    def numeric_summary(
        key: str, source: list[dict[str, Any]] | None = None,
    ) -> dict[str, float] | None:
        values = [
            float(impact[key])
            for impact in (ready_impacts if source is None else source)
            if impact.get(key) is not None
        ]
        if not values:
            return None
        return {
            "mean": statistics.fmean(values),
            "median": statistics.median(values),
            "minimum": min(values),
            "maximum": max(values),
        }

    def environment_summary(metric: str, key: str) -> dict[str, float] | None:
        values = [
            float(value)
            for impact in ready_impacts
            if (value := ((impact.get("environment") or {}).get(metric) or {}).get(key)) is not None
        ]
        if not values:
            return None
        return {
            "mean": statistics.fmean(values),
            "median": statistics.median(values),
            "minimum": min(values),
            "maximum": max(values),
        }

    ready = sum(bool(impact.get("assessment_ready")) for impact in impacts)
    required_ready = 1 if len(seeds) == 1 else len(seeds) // 2 + 1
    return {
        "applied": len(seeds) > 1,
        "seeds": seeds,
        "run_count": len(seeds),
        "assessment_ready_runs": ready,
        "required_assessment_ready_runs": required_ready,
        "assessment_ready": ready >= required_ready,
        "all_runs_assessment_ready": ready == len(seeds),
        "journey_time_ready_runs": len(journey_impacts),
        "capacity_failure_runs": sum(
            bool(impact.get("closure_capacity_failure")) for impact in ready_impacts
        ),
        "failed_runs": [
            {"seed": seed, "reasons": list(impact.get("validity_reasons") or ["unknown"])}
            for seed, impact in zip(seeds, impacts)
            if not impact.get("assessment_ready")
        ],
        "journey_time_change_s": numeric_summary("mean_journey_time_change_s", journey_impacts),
        "journey_time_change_pct": numeric_summary("mean_journey_time_change_pct", journey_impacts),
        "speed_change_mps": numeric_summary("mean_speed_change_mps", journey_impacts),
        "speed_change_pct": numeric_summary("mean_speed_change_pct", journey_impacts),
        "max_queue_baseline": numeric_summary("max_queue_baseline"),
        "max_queue_closure": numeric_summary("max_queue_closure"),
        "completion_change_percentage_points": numeric_summary("completion_change_percentage_points"),
        "completed_trip_ratio_baseline": numeric_summary("completed_trip_ratio_baseline"),
        "completed_trip_ratio_closure": numeric_summary("completed_trip_ratio_closure"),
        "co2_change_kg": environment_summary("co2_kg", "change"),
        "co2_change_pct": environment_summary("co2_kg", "change_pct"),
    }

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
# After the animated window ends, keep stepping (without recording positions)
# until the vehicles still en route arrive. Scoring at the end of the window
# instead would count "hasn't arrived yet" as "couldn't arrive", which is the
# difference between a closure looking mildly disruptive and looking
# impossible -- and, worse, makes a severe closure appear to *speed traffic
# up*, because the trips it delays are the ones that get truncated away.
# Let the network reach a representative state before any reported sample is
# taken.  Demand continues for the complete reporting window; the additional
# drain is solely for scoring vehicles that departed near its end.
DEFAULT_WARMUP_S = 180
DRAIN_FACTOR = 2.0

# Never let SUMO move a vehicle through gridlock. A teleport can make an
# impossible closure appear to work. Persistent queues are tracked explicitly
# and unfinished trips carry the consequence into the comparison instead.
TELEPORT_AFTER_S = -1
PERSISTENT_GRIDLOCK_S = 300

# Periodic travel-time rerouting represents drivers reacting to queues. Keep a
# share on their initial route so the model does not assume perfect knowledge.
DEFAULT_REROUTING_PROBABILITY = 0.7
DEFAULT_REROUTING_PERIOD_S = 60
DEFAULT_REROUTING_THRESHOLD_FACTOR = 1.1

# Conservative fallback rates for mapped street activity. These create
# repeatable yielding/loading events in both paired runs and may be overridden
# with observed values in data/traffic_calibration.json.
DEFAULT_ACTIVITY_MODEL = {
    "crossing_vehicle_probability": 0.025,
    "crossing_stop_duration_s": 6.0,
    "kerbside_vehicle_probability": 0.06,
    "kerbside_stop_duration_s": 18.0,
}

# A paired estimate is not decision-worthy when the unmodified network is
# already gridlocked or when the paired survivor sample is too small.  Keep
# the raw diagnostics, but make reports withhold impact claims in those cases.
MIN_BASELINE_COMPLETION_RATIO = 0.85
MIN_PAIRED_TRIP_RATIO = 0.20
MAX_BASELINE_INSERTION_FAILURE_RATIO = 0.02
MAX_BASELINE_PERSISTENT_GRIDLOCK_RATIO = 0.05
# A current/free-flow speed ratio is evidence of congestion, not a measured
# traffic count.  Letting that proxy increase demand beyond the highest rate
# in the stability sweep made the "live" baseline fail before a closure was
# applied.  Observed departures in traffic_calibration.json may still set a
# higher rate explicitly; an uncalibrated speed snapshot may not.
MAX_UNCALIBRATED_LIVE_DEMAND_SCALE = 1.0
MAX_ENSEMBLE_SEEDS = 5
MAX_AUTOMATIC_STABILITY_ATTEMPTS = 3
AUTOMATIC_STABILITY_BACKOFF = 0.8

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
MIN_TOMTOM_CONFIDENCE = 0.5
PEAK_BIN_MINUTES = 30
# Local hour-of-day each fixed scenario represents, and whether weekends
# should be excluded -- mirrors the plain-language windows in each
# SCENARIOS label above.
SCENARIO_HISTORICAL_WINDOWS: dict[str, dict[str, Any]] = {
    "am_peak": {"hours": range(7, 9), "weekdays_only": True},
    "midday": {"hours": range(11, 14), "weekdays_only": False},
    "pm_peak": {"hours": range(16, 18), "weekdays_only": True},
    "evening": {"hours": range(19, 21), "weekdays_only": False},
}
# Broad weekday search bands used to discover the observed two-hour peak,
# instead of assuming the hand-labelled 07:00-09:00 and 16:00-18:00 windows
# are correct forever. Bounds are local Cape Town clock minutes.
PEAK_SEARCH_WINDOWS: dict[str, dict[str, int]] = {
    "am_peak": {"start_minute": 5 * 60, "end_minute": 11 * 60, "duration_minutes": 120},
    "pm_peak": {"start_minute": 14 * 60, "end_minute": 20 * 60, "duration_minutes": 120},
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
        if bool(segment.get("roadClosure", False)):
            continue
        current_speed = float(segment.get("currentSpeed") or 0.0)
        free_flow_speed = float(segment.get("freeFlowSpeed") or 0.0)
        if free_flow_speed <= 0:
            continue
        ratio = max(0.05, min(1.2, current_speed / free_flow_speed))
        confidence = segment.get("confidence")
        if isinstance(confidence, (int, float)) and confidence < MIN_TOMTOM_CONFIDENCE:
            continue
        minute_bin = (local_now.minute // PEAK_BIN_MINUTES) * PEAK_BIN_MINUTES
        rows.append({
            "ts": now_utc.isoformat().replace("+00:00", "Z"),
            "date": local_now.date().isoformat(),
            "weekday": local_now.weekday(),
            "hour": local_now.hour,
            "minute": local_now.minute,
            "minute_bin": minute_bin,
            "road": road["name"],
            "ratio": round(ratio, 3),
            "current_speed_kmh": round(current_speed, 2),
            "free_flow_speed_kmh": round(free_flow_speed, 2),
            "confidence": confidence,
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


def _row_local_minute(row: dict[str, Any]) -> int | None:
    """Return a historical row's local time as a half-hour clock bin."""
    hour = row.get("hour")
    if not isinstance(hour, int) or not 0 <= hour <= 23:
        return None
    minute_bin = row.get("minute_bin")
    if not isinstance(minute_bin, int):
        minute = row.get("minute")
        if not isinstance(minute, int):
            # Old rows predate the explicit minute fields. Recover the minute
            # from their ISO timestamp; UTC/local conversion does not alter it.
            try:
                minute = datetime.fromisoformat(str(row.get("ts", "")).replace("Z", "+00:00")).minute
            except ValueError:
                minute = 0
        minute_bin = (minute // PEAK_BIN_MINUTES) * PEAK_BIN_MINUTES
    return hour * 60 + minute_bin


def _historical_peak_profile(scenario_key: str) -> dict[str, Any] | None:
    """Discover the most congested weekday two-hour window from TomTom.

    Ratios are first collapsed to one median per date and half-hour bin, so a
    road sampled more often cannot dominate the peak. Every bin in the chosen
    window must be represented on at least MIN_HISTORICAL_DISTINCT_DAYS.
    """
    search = PEAK_SEARCH_WINDOWS.get(scenario_key)
    if search is None or not TRAFFIC_OBSERVATIONS_PATH.exists():
        return None

    values: dict[tuple[str, int], list[float]] = {}
    roads_by_bin: dict[int, set[str]] = {}
    for line in TRAFFIC_OBSERVATIONS_PATH.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        weekday = row.get("weekday")
        if not isinstance(weekday, int) or weekday >= 5:
            continue
        confidence = row.get("confidence")
        if isinstance(confidence, (int, float)) and confidence < MIN_TOMTOM_CONFIDENCE:
            continue
        ratio = row.get("ratio")
        date = row.get("date")
        minute = _row_local_minute(row)
        if not isinstance(ratio, (int, float)) or not date or minute is None:
            continue
        if not search["start_minute"] <= minute < search["end_minute"]:
            continue
        values.setdefault((str(date), minute), []).append(float(ratio))
        if row.get("road"):
            roads_by_bin.setdefault(minute, set()).add(str(row["road"]))

    daily_bin_ratio = {
        key: statistics.median(ratios) for key, ratios in values.items() if ratios
    }
    duration_bins = search["duration_minutes"] // PEAK_BIN_MINUTES
    candidates: list[dict[str, Any]] = []
    latest_start = search["end_minute"] - search["duration_minutes"]
    for start in range(search["start_minute"], latest_start + 1, PEAK_BIN_MINUTES):
        bins = [start + offset * PEAK_BIN_MINUTES for offset in range(duration_bins)]
        dates_per_bin = [
            {date for date, minute in daily_bin_ratio if minute == bin_minute}
            for bin_minute in bins
        ]
        common_dates = set.intersection(*dates_per_bin) if dates_per_bin else set()
        if len(common_dates) < MIN_HISTORICAL_DISTINCT_DAYS:
            continue
        sample_count = sum(
            len(values.get((date, bin_minute), []))
            for date in common_dates
            for bin_minute in bins
        )
        if sample_count < MIN_HISTORICAL_SAMPLES:
            continue
        per_day = [
            sum(daily_bin_ratio[(date, bin_minute)] for bin_minute in bins) / len(bins)
            for date in common_dates
        ]
        candidates.append({
            "start_minute": start,
            "end_minute": start + search["duration_minutes"],
            "average_ratio": statistics.median(per_day),
            "distinct_days": len(common_dates),
            "sample_count": sample_count,
            "roads_sampled": len(set().union(*(roads_by_bin.get(bin_minute, set()) for bin_minute in bins))),
        })
    if not candidates:
        return None
    peak = min(candidates, key=lambda candidate: candidate["average_ratio"])
    peak["candidate_windows"] = len(candidates)
    return peak


def _clock_label(clock_minute: int) -> str:
    return f"{(clock_minute // 60) % 24:02d}:{clock_minute % 60:02d}"


def traffic_calibration_status() -> dict[str, Any]:
    """Public, secret-free summary of accumulated TomTom peak evidence."""
    rows = []
    if TRAFFIC_OBSERVATIONS_PATH.exists():
        for line in TRAFFIC_OBSERVATIONS_PATH.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    dates = sorted({str(row["date"]) for row in rows if row.get("date")})
    profiles = {}
    for scenario_key in PEAK_SEARCH_WINDOWS:
        profile = _historical_peak_profile(scenario_key)
        profiles[scenario_key] = ({
            **profile,
            "window": f"{_clock_label(profile['start_minute'])}-{_clock_label(profile['end_minute'])}",
            "ready": True,
        } if profile else {
            "ready": False,
            "minimum_distinct_weekdays": MIN_HISTORICAL_DISTINCT_DAYS,
        })
    configured_scenarios = _traffic_calibration().get("scenarios") or {}
    route_sampler_profiles = {}
    if isinstance(configured_scenarios, dict):
        for scenario_key, scenario_config in configured_scenarios.items():
            route_config = (
                scenario_config.get("route_sampler")
                if isinstance(scenario_config, dict) else None
            ) or {}
            if not isinstance(route_config, dict):
                continue
            route_sampler_profiles[str(scenario_key)] = {
                "enabled": bool(route_config.get("enabled", False)),
                "edge_count_locations": len(route_config.get("edge_counts") or []),
                "turn_count_locations": len(route_config.get("turn_counts") or []),
                "observation_period_min": route_config.get("observation_period_min", 60),
                "minimum_match_ratio": route_config.get("minimum_match_ratio", 0.85),
            }
    try:
        route_sampler_available = _route_sampler_script().exists()
    except RuntimeError:
        route_sampler_available = False
    return {
        "provider": TOMTOM_PROVIDER,
        "calibration_kind": "speed_pattern_not_vehicle_count",
        "observation_rows": len(rows),
        "distinct_days": len(dates),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "collector_interval_s": max(
            300,
            int(os.getenv(
                "TRAFFIC_OBSERVATION_INTERVAL_S",
                str(DEFAULT_TRAFFIC_OBSERVATION_INTERVAL_S),
            )),
        ),
        "profiles": profiles,
        "route_sampler": {
            "available": route_sampler_available,
            "scenarios": route_sampler_profiles,
        },
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
    """Count mapped street activity near simulated roads."""
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
        "simulation_effect": "deterministic_yielding_and_kerbside_stop_events",
        "note": "Mapped locations use conservative fallback rates unless observed rates are supplied in traffic_calibration.json.",
    }


@lru_cache(maxsize=1)
def _traffic_calibration() -> dict[str, Any]:
    """Load optional observed demand, activity and signal calibration.

    The file is deliberately optional so deployments without survey data keep
    working. Invalid top-level shapes fail closed to the documented fallback
    model rather than breaking every closure request.
    """
    if not TRAFFIC_CALIBRATION_PATH.exists():
        return {}
    try:
        calibration = json.loads(TRAFFIC_CALIBRATION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return calibration if isinstance(calibration, dict) else {}


def _scenario_calibration(scenario_key: str) -> dict[str, Any]:
    scenarios = _traffic_calibration().get("scenarios") or {}
    value = scenarios.get(scenario_key) or {}
    return value if isinstance(value, dict) else {}


def _activity_events(corridor: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Snap mapped crossings and parking locations to nearby SUMO edges."""
    if not corridor:
        return []
    settings = dict(DEFAULT_ACTIVITY_MODEL)
    configured = _traffic_calibration().get("street_activity") or {}
    if isinstance(configured, dict):
        for key in settings:
            try:
                settings[key] = max(0.0, float(configured.get(key, settings[key])))
            except (TypeError, ValueError):
                pass
    events_by_edge_kind: dict[tuple[str, str], dict[str, Any]] = {}
    for activity in _street_activity_records():
        nearest = min(corridor, key=lambda record: record["line"].distance(activity["point"]))
        distance = nearest["line"].distance(activity["point"])
        if distance > 18.0 or nearest["length_m"] < 12.0:
            continue
        position = nearest["line"].project(activity["point"], normalized=True) * nearest["length_m"]
        position = max(5.0, min(nearest["length_m"] - 5.0, position))
        is_crossing = activity["type"] == "pedestrianCrossing"
        kind = "crossing" if is_crossing else "kerbside"
        event = {
            "id": str(activity.get("id") or f"{nearest['id']}:{position:.1f}"),
            "edge_id": nearest["id"],
            "lane_index": 0,
            "lane_id": next(iter(nearest.get("lane_lines") or {}), f"{nearest['id']}_0"),
            "position_m": position,
            "kind": kind,
            "probability": settings[
                "crossing_vehicle_probability" if is_crossing else "kerbside_vehicle_probability"
            ],
            "duration_s": settings[
                "crossing_stop_duration_s" if is_crossing else "kerbside_stop_duration_s"
            ],
            "source": "mapped_inventory_observed_rate" if configured else "mapped_inventory_fallback_rate",
        }
        # Parking inventories commonly contain one point per bay. Treating
        # every bay as an independent stopping probability would overwhelm
        # the road. One representative event per edge and activity type keeps
        # the configured rate interpretable.
        events_by_edge_kind.setdefault((nearest["id"], kind), event)
    return list(events_by_edge_kind.values())


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


def _travel_direction_summary(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Compass label for the direction encoded by an open SUMO edge."""
    candidates = [record["line"] for record in records if len(record["line"].coords) >= 2]
    if not candidates:
        return None
    line = max(candidates, key=lambda candidate: candidate.length)
    start_x, start_z = line.coords[0]
    end_x, end_z = line.coords[-1]
    # Viewer-local x points east and z points south.
    bearing = math.degrees(math.atan2(end_x - start_x, -(end_z - start_z))) % 360.0
    cardinals = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
    cardinal = cardinals[int((bearing + 22.5) // 45.0) % len(cardinals)]
    return {
        "bearing_deg": round(bearing, 1),
        "cardinal": cardinal,
        "label": f"{cardinal}-bound ({bearing:.0f}°)",
    }


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
    scenario_label = profile["label"]
    historical_calibration: dict[str, Any] | None = None
    if demand_scale is None:
        ratio = 0.85 if live_average_ratio is None else live_average_ratio
        demand_scale = min(MAX_UNCALIBRATED_LIVE_DEMAND_SCALE, _demand_scale(ratio))
    else:
        peak_profile = _historical_peak_profile(scenario)
        historical = peak_profile or _historical_scenario_ratio(scenario)
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
                "provider": TOMTOM_PROVIDER,
                "calibration_kind": "speed_pattern_not_vehicle_count",
                "sample_count": historical["sample_count"],
                "distinct_days": historical["distinct_days"],
                "observed_average_speed_ratio": round(historical["average_ratio"], 3),
                "roads_sampled": historical.get("roads_sampled"),
                "peak_window_detected": peak_profile is not None,
            }
            if peak_profile is not None:
                window = (
                    f"{_clock_label(peak_profile['start_minute'])}–"
                    f"{_clock_label(peak_profile['end_minute'])}"
                )
                historical_calibration["observed_peak_window"] = window
                historical_calibration["candidate_windows"] = peak_profile["candidate_windows"]
                period_name = "Morning peak" if scenario == "am_peak" else "Afternoon peak"
                scenario_label = f"{period_name} · TomTom-observed {window}"
    return {
        "key": scenario,
        "label": scenario_label,
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


def _physical_selection_edge_ids(edge_ids: list[str], net: Any) -> list[str]:
    """Return a direction-neutral identifier set for a drawn road section.

    Drawing the opposite carriageway of the same physical street used to
    change both the demand corridor and the random seed. Include each selected
    edge's reverse sibling so either direction resolves to the same physical
    section and therefore the same synthetic traffic population.
    """
    by_id = {edge.getID(): edge for edge in net.getEdges()}
    physical_ids: set[str] = set()
    for edge_id in edge_ids:
        edge = by_id.get(edge_id)
        if edge is None:
            continue
        physical_ids.add(edge.getID())
        physical_ids.update(sibling.getID() for sibling in _reverse_siblings(edge))
    return sorted(physical_ids)


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
    calibrated_edge_weights: dict[str, Any] | None = None,
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
        observed = (calibrated_edge_weights or {}).get(record["id"]) or {}
        try:
            observed_origin = max(0.0, float(observed.get("origin", 1.0)))
            observed_destination = max(0.0, float(observed.get("destination", 1.0)))
        except (AttributeError, TypeError, ValueError):
            observed_origin = observed_destination = 1.0
        origin_weights.append(base * max(0.05, outward) * observed_origin)
        destination_weights.append(base * max(0.05, inward) * observed_destination)
    return origin_weights, destination_weights


def _generate_trips(
    corridor: list[dict[str, Any]],
    duration_s: int,
    vehicle_count: int,
    inbound_bias: float,
    seed: int,
    workdir: Path,
    road_congestion: dict[str, float] | None = None,
    endpoint_exclusion_ids: set[str] | None = None,
    warmup_s: int = 0,
    scenario_key: str | None = None,
) -> tuple[Path, int]:
    """Write a corridor-scoped trip file and return it with its vehicle count.

    Replaces SUMO's ``randomTrips.py``: that tool samples the whole network
    with no notion of which edges are on camera, which is what scattered
    vehicles across (and off) the map. Generating trips here also removes a
    subprocess and its timeout from the request path.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    # Keep trip endpoints off both directional edges of a drawn physical
    # section. Otherwise a trip whose origin or destination is closed can
    # disappear at insertion time instead of diverting. The resulting model
    # is explicitly a through-traffic comparison; local access is reported as
    # a limitation until observed driveway/loading demand can be supplied.
    excluded = endpoint_exclusion_ids or set()
    endpoint_corridor = [record for record in corridor if record["id"] not in excluded]
    if len(endpoint_corridor) < 2:
        raise ValueError(
            "the selected corridor has too few open boundary roads to generate comparable demand"
        )
    rng = random.Random(seed)
    scenario_calibration = _scenario_calibration(scenario_key) if scenario_key else {}
    calibrated_edge_weights = scenario_calibration.get("edge_weights") or {}
    origin_weights, destination_weights = _trip_weights(
        endpoint_corridor, inbound_bias, road_congestion, calibrated_edge_weights
    )
    # Use boundary endpoints for most journeys so the model represents traffic
    # passing through the study area rather than a collection of random short
    # intra-corridor hops. A small local share retains access traffic.
    distances = [record["midpoint"].distance(Point(0.0, 0.0)) for record in endpoint_corridor]
    boundary_cutoff = sorted(distances)[max(0, int(len(distances) * 0.65) - 1)]
    boundary_indices = [index for index, distance in enumerate(distances) if distance >= boundary_cutoff]
    try:
        through_share = max(0.0, min(1.0, float(scenario_calibration.get("through_trip_share", 0.85))))
    except (TypeError, ValueError):
        through_share = 0.85
    # Keep the arrival stream stable when the sampling window changes. With a
    # fixed demand rate, a 20-minute run now extends the 10-minute trip stream
    # instead of reshuffling every departure and route. This makes duration
    # sensitivity meaningful and greatly reduces contradictory short/long
    # comparisons caused by different random populations.
    departure_interval_s = float(duration_s) / max(vehicle_count, 1)
    warmup_count = int(round(warmup_s / departure_interval_s)) if warmup_s > 0 else 0
    trips: list[tuple[float, str, str, str, str]] = []
    fleet_types = list(FLEET_MIX)
    fleet_weights = list(FLEET_MIX.values())
    for stream_index in range(warmup_count + vehicle_count):
        measurement_index = stream_index - warmup_count
        use_boundary = bool(boundary_indices) and rng.random() < through_share
        origin_candidates = endpoint_corridor
        destination_candidates = endpoint_corridor
        origin_choice_weights = origin_weights
        destination_choice_weights = destination_weights
        if use_boundary and inbound_bias >= 0.2:
            origin_candidates = [endpoint_corridor[index] for index in boundary_indices]
            origin_choice_weights = [origin_weights[index] for index in boundary_indices]
        elif use_boundary and inbound_bias <= -0.2:
            destination_candidates = [endpoint_corridor[index] for index in boundary_indices]
            destination_choice_weights = [destination_weights[index] for index in boundary_indices]
        elif use_boundary:
            origin_candidates = [endpoint_corridor[index] for index in boundary_indices]
            destination_candidates = origin_candidates
            origin_choice_weights = [origin_weights[index] for index in boundary_indices]
            destination_choice_weights = [destination_weights[index] for index in boundary_indices]
        origin = rng.choices(origin_candidates, weights=origin_choice_weights, k=1)[0]
        destination = rng.choices(destination_candidates, weights=destination_choice_weights, k=1)[0]
        # A trip that starts and ends on the same edge has nothing to route.
        if destination["id"] == origin["id"]:
            continue
        vehicle_type = rng.choices(fleet_types, weights=fleet_weights, k=1)[0]
        depart = (stream_index + rng.random()) * departure_interval_s
        vehicle_id = f"v{measurement_index}" if measurement_index >= 0 else f"warmup{stream_index}"
        trips.append((depart, origin["id"], destination["id"], vehicle_type, vehicle_id))
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
    for depart, origin_id, destination_id, vehicle_type, vehicle_id in trips:
        parts.append(
            f'  <trip id="{vehicle_id}" type="{vehicle_type}" depart="{depart:.2f}" departLane="free"'
            f' from="{origin_id}" to="{destination_id}"/>'
        )
    parts.append("</routes>")
    trips_path.write_text("\n".join(parts) + "\n", encoding="utf-8")
    return trips_path, sum(1 for trip in trips if trip[4].startswith("v"))


def _sumo_executable(name: str) -> str:
    """Locate a SUMO binary installed globally or by ``eclipse-sumo``."""
    executable = shutil.which(name)
    if executable:
        return executable
    try:
        import sumo
    except ImportError as error:
        raise RuntimeError(f"SUMO executable {name!r} is not installed") from error
    packaged = Path(sumo.__file__).resolve().parent / "bin" / name
    if not packaged.exists():
        raise RuntimeError(f"SUMO executable {name!r} is not installed")
    return str(packaged)


def _route_sampler_script() -> Path:
    """Locate routeSampler.py from SUMO_HOME or the pinned Python package."""
    sumo_home = os.getenv("SUMO_HOME")
    candidates = []
    if sumo_home:
        candidates.append(Path(sumo_home) / "tools" / "routeSampler.py")
    try:
        import sumo
        candidates.append(Path(sumo.__file__).resolve().parent / "tools" / "routeSampler.py")
    except ImportError:
        pass
    for candidate in candidates:
        if candidate.exists():
            return candidate
    executable = shutil.which("routeSampler.py")
    if executable:
        return Path(executable)
    raise RuntimeError("SUMO routeSampler.py is not installed")


def _dua_iterate_script() -> Path:
    """Locate SUMO's dynamic-user-assignment helper."""
    sumo_home = os.getenv("SUMO_HOME")
    candidates = []
    if sumo_home:
        candidates.append(Path(sumo_home) / "tools" / "assign" / "duaIterate.py")
    try:
        import sumo
        candidates.append(Path(sumo.__file__).resolve().parent / "tools" / "assign" / "duaIterate.py")
    except ImportError:
        pass
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError("SUMO duaIterate.py is not installed")


def _apply_dynamic_assignment(
    demand_file: Path,
    workdir: Path,
    configuration: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    """Run a bounded DUA pass and return its final assigned route file."""
    try:
        iterations = max(1, min(5, int(configuration.get("iterations", 3))))
        aggregation_s = max(30, min(900, int(configuration.get("aggregation_s", 60))))
    except (TypeError, ValueError) as error:
        raise ValueError("dynamic_assignment iterations and aggregation_s must be integers") from error
    dua_script = _dua_iterate_script()
    sumo_binary = Path(_sumo_executable("sumo"))
    demand_root = ElementTree.parse(demand_file).getroot()
    input_flag = "--trips" if demand_root.findall("trip") else "--routes"
    command = [
        sys.executable, str(dua_script),
        "--net-file", str(SUMO_NET_PATH),
        input_flag, str(demand_file),
        "--last-step", str(iterations),
        "--aggregation", str(aggregation_s),
        "--path", str(sumo_binary.parent),
        "--no-gzip", "--output-lastRoute",
        "--disable-summary", "--disable-tripinfos",
        "--time-to-teleport=-1",
        "--dualog", str(workdir / "dua.log"),
        "--log", str(workdir / "dua.stdout.log"),
    ]
    if bool(configuration.get("weight_memory", True)):
        command.append("--weight-memory")
    if bool(configuration.get("method_of_successive_average", True)):
        command.append("--method-of-successive-average")
    workdir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        command,
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=iterations * 75,
        check=False,
        env={**os.environ, "SUMO_HOME": str(dua_script.parents[2])},
    )
    final_step = iterations - 1
    candidates = sorted((workdir / f"{final_step:03d}").glob(f"*_{final_step:03d}.rou.xml"))
    if result.returncode or not candidates:
        detail = (result.stderr or result.stdout).strip()[-1000:]
        raise RuntimeError(f"duaIterate.py did not produce assigned routes: {detail}")
    assigned = candidates[0]
    assigned_vehicles = ElementTree.parse(assigned).getroot().findall("vehicle")
    vehicle_count = len(assigned_vehicles)
    if vehicle_count <= 0:
        raise RuntimeError("duaIterate.py produced an empty assigned-route file")
    return assigned, {
        "applied": True,
        "tool": "Eclipse SUMO duaIterate.py",
        "iterations": iterations,
        "aggregation_s": aggregation_s,
        "method_of_successive_average": bool(configuration.get("method_of_successive_average", True)),
        "weight_memory": bool(configuration.get("weight_memory", True)),
        "assigned_vehicle_count": vehicle_count,
        "assigned_measured_vehicle_count": sum(
            str(vehicle.get("id") or "").startswith("v") for vehicle in assigned_vehicles
        ),
    }


def _write_route_sampler_counts(
    path: Path,
    records: list[dict[str, Any]],
    kind: str,
    end_s: int,
    observation_period_min: float,
    demand_multiplier: float,
) -> dict[str, float]:
    """Write one SUMO count interval, scaling surveyed counts to this run."""
    root = ElementTree.Element("data")
    interval = ElementTree.SubElement(root, "interval", {
        "id": "observed",
        "begin": "0",
        "end": str(end_s),
    })
    scale = end_s / (observation_period_min * 60.0) * demand_multiplier
    total_measured = 0.0
    accepted = 0
    for record in records:
        if not isinstance(record, dict):
            continue
        try:
            count = max(0.0, float(record["count"])) * scale
        except (KeyError, TypeError, ValueError):
            continue
        if count <= 0:
            continue
        if kind == "edge":
            edge_id = str(record.get("edge_id") or "").strip()
            if not edge_id:
                continue
            attributes = {"id": edge_id, "count": f"{count:.6f}"}
            ElementTree.SubElement(interval, "edge", attributes)
        else:
            from_id = str(record.get("from_edge_id") or "").strip()
            to_id = str(record.get("to_edge_id") or "").strip()
            if not from_id or not to_id or from_id == to_id:
                continue
            attributes = {"from": from_id, "to": to_id, "count": f"{count:.6f}"}
            via = str(record.get("via") or "").strip()
            if via:
                attributes["via"] = via
            ElementTree.SubElement(interval, "edgeRelation", attributes)
        accepted += 1
        total_measured += count
    if not accepted:
        raise ValueError(f"route_sampler has no valid positive {kind} counts")
    ElementTree.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return {"locations": accepted, "scaled_total": total_measured}


def _route_sampler_mismatch(path: Path) -> dict[str, Any]:
    """Summarize routeSampler mismatch output without exposing bulky XML."""
    measured = deficit = 0.0
    max_geh = 0.0
    locations = 0
    if path.exists():
        for element in ElementTree.parse(path).getroot().iter():
            if element.tag not in {"edge", "edgeRelation"}:
                continue
            try:
                location_measured = float(element.get("measuredCount", 0) or 0)
                location_deficit = abs(float(element.get("deficit", 0) or 0))
                location_geh = float(element.get("GEH", 0) or 0)
            except (TypeError, ValueError):
                continue
            measured += location_measured
            deficit += location_deficit
            max_geh = max(max_geh, location_geh)
            locations += 1
    match_ratio = max(0.0, 1.0 - deficit / measured) if measured > 0 else 0.0
    return {
        "locations": locations,
        "measured_total": measured,
        "absolute_deficit": deficit,
        "match_ratio": match_ratio,
        "maximum_geh": max_geh,
    }


def _normalise_sampled_routes(path: Path, warmup_s: int) -> int:
    """Give sampled vehicles stable scored/warm-up IDs and departure order."""
    tree = ElementTree.parse(path)
    root = tree.getroot()
    vehicles = list(root.findall("vehicle"))
    vehicles.sort(key=lambda vehicle: float(vehicle.get("depart", 0) or 0))
    for vehicle in vehicles:
        root.remove(vehicle)
    warmup_index = measured_index = 0
    for vehicle in vehicles:
        depart = float(vehicle.get("depart", 0) or 0)
        if depart < warmup_s:
            vehicle.set("id", f"warmup{warmup_index}")
            warmup_index += 1
        else:
            vehicle.set("id", f"v{measured_index}")
            measured_index += 1
        vehicle.set("departLane", "free")
        root.append(vehicle)
    tree.write(path, encoding="utf-8", xml_declaration=True)
    return measured_index


def _generate_route_sampled_trips(
    corridor: list[dict[str, Any]],
    duration_s: int,
    vehicle_count: int,
    inbound_bias: float,
    seed: int,
    workdir: Path,
    route_sampler: dict[str, Any],
    demand_multiplier: float,
    road_congestion: dict[str, float] | None = None,
    endpoint_exclusion_ids: set[str] | None = None,
    warmup_s: int = 0,
    scenario_key: str | None = None,
) -> tuple[Path, int, dict[str, Any]]:
    """Build candidate routes and select a count-matching demand population."""
    edge_counts = route_sampler.get("edge_counts") or []
    turn_counts = route_sampler.get("turn_counts") or []
    if not isinstance(edge_counts, list) or not isinstance(turn_counts, list):
        raise ValueError("route_sampler edge_counts and turn_counts must be lists")
    if not edge_counts and not turn_counts:
        raise ValueError("route_sampler requires edge_counts or turn_counts")
    network_edge_ids = {edge.getID() for edge in _sumo_net().getEdges()}
    configured_edge_ids = {
        str(record.get(key) or "").strip()
        for records, keys in (
            (edge_counts, ("edge_id",)),
            (turn_counts, ("from_edge_id", "to_edge_id")),
        )
        for record in records if isinstance(record, dict)
        for key in keys
        if str(record.get(key) or "").strip()
    }
    unknown_edge_ids = sorted(configured_edge_ids - network_edge_ids)
    if unknown_edge_ids:
        raise ValueError(
            "route_sampler references SUMO edge IDs that are not in cbd.net.xml: "
            + ", ".join(unknown_edge_ids[:5])
        )
    try:
        observation_period_min = max(1.0, float(route_sampler.get("observation_period_min", 60)))
        candidate_multiplier = max(2.0, min(12.0, float(route_sampler.get("candidate_multiplier", 4))))
        minimum_match_ratio = max(0.0, min(1.0, float(route_sampler.get("minimum_match_ratio", 0.85))))
        turn_max_gap = max(0, int(route_sampler.get("turn_max_gap", 0)))
        geh_ok = max(0.0, float(route_sampler.get("geh_ok", 5)))
    except (TypeError, ValueError) as error:
        raise ValueError("route_sampler settings contain a non-numeric value") from error

    total_s = warmup_s + duration_s
    candidate_count = max(200, int(math.ceil(vehicle_count * candidate_multiplier)))
    candidate_trips, _ = _generate_trips(
        corridor=corridor,
        duration_s=total_s,
        vehicle_count=candidate_count,
        inbound_bias=inbound_bias,
        seed=seed,
        workdir=workdir / "route_sampler_candidates",
        road_congestion=road_congestion,
        endpoint_exclusion_ids=endpoint_exclusion_ids,
        warmup_s=0,
        scenario_key=scenario_key,
    )
    candidate_routes = workdir / "route_sampler_candidates.rou.xml"
    duarouter = subprocess.run([
        _sumo_executable("duarouter"),
        "--net-file", str(SUMO_NET_PATH),
        "--route-files", str(candidate_trips),
        "--output-file", str(candidate_routes),
        "--seed", str(_sumo_seed(seed)),
        "--ignore-errors", "true",
        "--no-warnings", "true",
    ], capture_output=True, text=True, timeout=45, check=False)
    if duarouter.returncode or not candidate_routes.exists():
        detail = (duarouter.stderr or duarouter.stdout).strip()[-500:]
        raise RuntimeError(f"duarouter could not build routeSampler candidates: {detail}")

    command = [
        sys.executable, str(_route_sampler_script()),
        "--route-files", str(candidate_routes),
        "--output-file", str(workdir / "route_sampled.rou.xml"),
        "--mismatch-output", str(workdir / "route_sampler_mismatch.xml"),
        "--begin", "0", "--end", str(total_s),
        "--seed", str(_sumo_seed(seed)),
        "--keep-attributes",
        "--geh-ok", str(geh_ok),
    ]
    count_summary: dict[str, Any] = {}
    if edge_counts:
        edge_path = workdir / "route_sampler_edge_counts.xml"
        count_summary["edge"] = _write_route_sampler_counts(
            edge_path, edge_counts, "edge", total_s, observation_period_min, demand_multiplier
        )
        command.extend(["--edgedata-files", str(edge_path), "--edgedata-attribute", "count"])
    if turn_counts:
        turn_path = workdir / "route_sampler_turn_counts.xml"
        count_summary["turn"] = _write_route_sampler_counts(
            turn_path, turn_counts, "turn", total_s, observation_period_min, demand_multiplier
        )
        command.extend(["--turn-files", str(turn_path), "--turn-attribute", "count"])
        if turn_max_gap:
            command.extend(["--turn-max-gap", str(turn_max_gap)])
    sampled = subprocess.run(
        command, capture_output=True, text=True, timeout=60, check=False,
        env={**os.environ, "SUMO_HOME": str(_route_sampler_script().parents[1])},
    )
    output_path = workdir / "route_sampled.rou.xml"
    if sampled.returncode or not output_path.exists():
        detail = (sampled.stderr or sampled.stdout).strip()[-800:]
        raise RuntimeError(f"routeSampler.py could not match the observed counts: {detail}")
    planned_count = _normalise_sampled_routes(output_path, warmup_s)
    if planned_count <= 0:
        raise RuntimeError("routeSampler.py produced no measured-window vehicles")
    mismatch = _route_sampler_mismatch(workdir / "route_sampler_mismatch.xml")
    if mismatch["match_ratio"] < minimum_match_ratio:
        raise RuntimeError(
            "routeSampler.py matched only "
            f"{mismatch['match_ratio'] * 100:.1f}% of configured counts; "
            f"{minimum_match_ratio * 100:.1f}% is required"
        )
    return output_path, planned_count, {
        "applied": True,
        "tool": "Eclipse SUMO routeSampler.py",
        "candidate_route_count": len(ElementTree.parse(candidate_routes).getroot().findall("vehicle")),
        "observation_period_min": observation_period_min,
        "counts": count_summary,
        "fit": mismatch,
    }


def _parse_tripinfo(path: Path, vehicle_id_prefix: str | None = None) -> dict[str, Any]:
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
        vehicle_id = trip.get("id")
        if vehicle_id_prefix is not None and not str(vehicle_id or "").startswith(vehicle_id_prefix):
            continue
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


def _apply_signal_calibration(traci: Any, scenario_key: str | None) -> dict[str, Any]:
    """Install surveyed signal programs when present in the calibration file."""
    programs = _traffic_calibration().get("signals") or {}
    if not isinstance(programs, dict):
        return {"configured": 0, "applied": 0, "errors": []}
    applied = 0
    errors = []
    known = set(traci.trafficlight.getIDList())
    for signal_id, config in programs.items():
        if signal_id not in known or not isinstance(config, dict):
            continue
        scenario_program = (config.get("scenarios") or {}).get(scenario_key) or config
        phases = scenario_program.get("phases") or []
        try:
            phase_objects = [
                traci.trafficlight.Phase(float(phase["duration_s"]), str(phase["state"]))
                for phase in phases
            ]
            if not phase_objects:
                continue
            program_id = str(scenario_program.get("program_id") or "observed")
            logic = traci.trafficlight.Logic(program_id, 0, 0, phase_objects)
            traci.trafficlight.setCompleteRedYellowGreenDefinition(signal_id, logic)
            traci.trafficlight.setProgram(signal_id, program_id)
            offset_s = float(scenario_program.get("offset_s", 0.0) or 0.0)
            cycle_s = sum(phase.duration for phase in phase_objects)
            if offset_s and cycle_s > 0:
                position_s = offset_s % cycle_s
                elapsed_s = 0.0
                for phase_index, phase in enumerate(phase_objects):
                    if position_s < elapsed_s + phase.duration:
                        traci.trafficlight.setPhase(signal_id, phase_index)
                        traci.trafficlight.setPhaseDuration(
                            signal_id, elapsed_s + phase.duration - position_s
                        )
                        break
                    elapsed_s += phase.duration
            applied += 1
        except Exception as error:  # TraCI errors include malformed phase-state lengths.
            errors.append({"signal_id": signal_id, "error": str(error)})
    return {"configured": len(programs), "applied": applied, "errors": errors[:10]}


def _run_simulation(
    trip_file: Path,
    duration_s: int,
    closed_lanes: list[str],
    closed_edges: list[str],
    workdir: Path,
    monitored_edges: list[str] | None = None,
    traffic_control: str = DEFAULT_TRAFFIC_CONTROL,
    edge_speed_limits: dict[str, float] | None = None,
    warmup_s: int = 0,
    scenario_key: str | None = None,
    activity_events: list[dict[str, Any]] | None = None,
    sample_interval_s: int = TRAJECTORY_SAMPLE_INTERVAL_S,
    wall_clock_budget_s: float = MIN_SIMULATION_WALL_CLOCK_BUDGET_S,
    sumo_seed: int | None = None,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    import traci

    workdir.mkdir(parents=True, exist_ok=True)
    tripinfo_path = workdir / "tripinfo.xml"
    # Positions are only recorded for `duration_s` (that is what plays back),
    # but the simulation runs on past it so trips in flight can arrive and be
    # scored -- see DRAIN_FACTOR.
    measurement_start_s = max(0, int(warmup_s))
    measurement_end_s = measurement_start_s + duration_s
    end_s = measurement_start_s + int(duration_s * DRAIN_FACTOR)
    demand_root = ElementTree.parse(trip_file).getroot()
    trip_definitions = [
        item for tag in ("trip", "vehicle") for item in demand_root.findall(tag)
        if str(item.get("id") or "").startswith("v")
    ]
    expected_vehicle_ids = {item.get("id") for item in trip_definitions}
    trip_endpoints = {}
    for item in trip_definitions:
        origin_id, destination_id = item.get("from"), item.get("to")
        embedded_route = item.find("route")
        if embedded_route is not None:
            route_edges = str(embedded_route.get("edges") or "").split()
            if route_edges:
                origin_id, destination_id = route_edges[0], route_edges[-1]
        trip_endpoints[str(item.get("id"))] = {
            "origin_edge_id": origin_id,
            "destination_edge_id": destination_id,
        }
    sumo_binary = _sumo_executable("sumo")
    routing_config = _traffic_calibration().get("routing") or {}
    if not isinstance(routing_config, dict):
        routing_config = {}
    try:
        rerouting_probability = max(0.0, min(
            1.0, float(routing_config.get("probability", DEFAULT_REROUTING_PROBABILITY))
        ))
        rerouting_period_s = max(
            15, int(routing_config.get("period_s", DEFAULT_REROUTING_PERIOD_S))
        )
        rerouting_threshold = max(1.0, float(routing_config.get(
            "threshold_factor", DEFAULT_REROUTING_THRESHOLD_FACTOR
        )))
    except (TypeError, ValueError):
        rerouting_probability = DEFAULT_REROUTING_PROBABILITY
        rerouting_period_s = DEFAULT_REROUTING_PERIOD_S
        rerouting_threshold = DEFAULT_REROUTING_THRESHOLD_FACTOR
    sumo_cmd = [
        sumo_binary,
        "--net-file", str(SUMO_NET_PATH),
        "--route-files", str(trip_file),
        "--begin", "0",
        "--end", str(end_s),
        "--step-length", str(SIM_STEP_LENGTH_S),
        "--tripinfo-output", str(tripinfo_path),
        "--no-warnings", "true",
        "--no-step-log", "true",
        "--time-to-teleport", str(TELEPORT_AFTER_S),
        "--device.rerouting.probability", str(rerouting_probability),
        "--device.rerouting.deterministic",
        "--device.rerouting.period", str(rerouting_period_s),
        "--device.rerouting.adaptation-steps", "60",
        "--device.rerouting.adaptation-interval", "1",
        "--device.rerouting.threshold.factor", str(rerouting_threshold),
        "--duration-log.disable", "true",
        # Trips (not pre-computed routes) are routed by SUMO's own internal
        # router at each vehicle's insertion time, using whatever edge and
        # lane permissions are active at that moment -- since the closures
        # below are applied before the simulation loop starts, every vehicle
        # that departs afterwards already accounts for them.
        "--ignore-route-errors", "true",
    ]
    if sumo_seed is not None:
        sumo_cmd.extend(["--seed", str(_sumo_seed(sumo_seed))])
    traci.start(sumo_cmd, label=f"traffic-{workdir.name}-{id(workdir)}")
    open_tracks: dict[str, dict[str, Any]] = {}
    finished_tracks: list[dict[str, Any]] = []
    retired_ids: set[str] = set()
    started_at = time.monotonic()
    truncated = False
    edge_totals: dict[str, dict[str, Any]] = {
        edge_id: {
            "samples": 0.0,
            "vehicle_count": 0.0,
            "speed_vehicle_sum": 0.0,
            "halted": 0.0,
            "throughput_vehicle_ids": set(),
        }
        for edge_id in (monitored_edges or [])
    }
    network_queue_samples: list[int] = []
    environment = {
        "co2_mg": 0.0, "nox_mg": 0.0, "pmx_mg": 0.0, "fuel_mg": 0.0,
        "noise_energy": 0.0, "noise_samples": 0,
    }
    departed_measurement_ids: set[str] = set()
    teleported_ids: set[str] = set()
    vehicle_routes: dict[str, list[str]] = {}
    closed_edge_set = set(closed_edges)
    closed_lane_set = set(closed_lanes)
    applied_activity_ids: set[str] = set()
    activity_errors = 0
    standstill_s: dict[str, int] = {}
    max_standstill_s: dict[str, int] = {}
    signal_calibration = {"configured": 0, "applied": 0, "errors": []}
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
        if traffic_control == "signalized":
            signal_calibration = _apply_signal_calibration(traci, scenario_key)
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
                    traci.constants.LAST_STEP_VEHICLE_ID_LIST,
                ))

        step = 0
        while traci.simulation.getMinExpectedNumber() > 0 and step < end_s:
            if time.monotonic() - started_at > wall_clock_budget_s:
                truncated = True
                break
            traci.simulationStep()
            departed_now = list(traci.simulation.getDepartedIDList())
            for vehicle_id in departed_now:
                measured_vehicle = str(vehicle_id).startswith("v")
                if measured_vehicle:
                    departed_measurement_ids.add(vehicle_id)
                try:
                    route = list(traci.vehicle.getRoute(vehicle_id))
                    # A route sampled from observed counts may cross a fully
                    # closed edge. Recompute only those invalid routes. A lane
                    # reduction leaves the route legal and must not imply that
                    # every driver has perfect advance knowledge.
                    if set(route) & closed_edge_set:
                        traci.vehicle.rerouteTraveltime(vehicle_id)
                        route = list(traci.vehicle.getRoute(vehicle_id))
                    if measured_vehicle:
                        vehicle_routes[vehicle_id] = route
                    vehicle_type = traci.vehicle.getTypeID(vehicle_id)
                    for event in (activity_events or []):
                        # Origin-edge stops can be too close for a vehicle to
                        # brake, while destination-edge stops can fall beyond
                        # the valid stopping range. Keep activity on interior
                        # route edges where SUMO can model it physically.
                        if event["edge_id"] not in route[1:-1]:
                            continue
                        if event["kind"] == "kerbside" and vehicle_type not in {
                            "minibus_taxi", "delivery_van", "city_shuttle"
                        }:
                            continue
                        if event.get("lane_id") in closed_lane_set:
                            continue
                        sample = zlib.crc32(f"{vehicle_id}|{event['id']}".encode("utf-8")) / 0xFFFFFFFF
                        if sample >= float(event["probability"]):
                            continue
                        traci.vehicle.setStop(
                            vehicle_id, event["edge_id"], pos=float(event["position_m"]),
                            laneIndex=int(event["lane_index"]), duration=float(event["duration_s"]),
                        )
                        applied_activity_ids.add(f"{vehicle_id}|{event['id']}")
                        break
                except Exception:
                    activity_errors += 1
            for vehicle_id in traci.simulation.getStartingTeleportIDList():
                if str(vehicle_id).startswith("v"):
                    teleported_ids.add(vehicle_id)

            in_measurement = measurement_start_s <= step < measurement_end_s
            sample_now = in_measurement and step % sample_interval_s == 0
            edge_results = (
                traci.edge.getAllSubscriptionResults() or {}
                if edge_totals and sample_now else {}
            )
            if sample_now:
                for edge_id, totals in edge_totals.items():
                    result = edge_results.get(edge_id) or {}
                    totals["throughput_vehicle_ids"].update(
                        vehicle_id for vehicle_id in result.get(
                            traci.constants.LAST_STEP_VEHICLE_ID_LIST, ()
                        ) if str(vehicle_id).startswith("v")
                    )
            if sample_now:
                queued_now = 0
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
                    environment["co2_mg"] += max(0.0, result.get(traci.constants.VAR_CO2EMISSION, 0.0)) * sample_interval_s
                    environment["nox_mg"] += max(0.0, result.get(traci.constants.VAR_NOXEMISSION, 0.0)) * sample_interval_s
                    environment["pmx_mg"] += max(0.0, result.get(traci.constants.VAR_PMXEMISSION, 0.0)) * sample_interval_s
                    environment["fuel_mg"] += max(0.0, result.get(traci.constants.VAR_FUELCONSUMPTION, 0.0)) * sample_interval_s
                    noise_db = float(result.get(traci.constants.VAR_NOISEEMISSION, 0.0) or 0.0)
                    if noise_db > 0.0 and vehicle_count > 0:
                        environment["noise_energy"] += 10.0 ** (noise_db / 10.0)
                        environment["noise_samples"] += 1
                network_queue_samples.append(queued_now)
                present = set(traci.vehicle.getIDList())
                for vehicle_id in present:
                    if not str(vehicle_id).startswith("v"):
                        continue
                    vehicle_routes[vehicle_id] = list(traci.vehicle.getRoute(vehicle_id))
                    if traci.vehicle.getSpeed(vehicle_id) < 0.1:
                        standstill_s[vehicle_id] = (
                            standstill_s.get(vehicle_id, 0) + sample_interval_s
                        )
                        max_standstill_s[vehicle_id] = max(
                            max_standstill_s.get(vehicle_id, 0), standstill_s[vehicle_id]
                        )
                    else:
                        standstill_s[vehicle_id] = 0
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
                            "t0": step - measurement_start_s,
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
    metrics = _parse_tripinfo(tripinfo_path, vehicle_id_prefix="v")
    metrics["simulated_steps"] = step
    metrics["truncated_by_time_budget"] = truncated
    metrics["mean_queued_vehicles"] = (
        sum(network_queue_samples) / len(network_queue_samples) if network_queue_samples else 0.0
    )
    metrics["max_queued_vehicles"] = max(network_queue_samples, default=0)
    metrics["edge_stats"] = _summarize_edge_totals(edge_totals)
    metrics["expected_vehicle_count"] = len(expected_vehicle_ids)
    metrics["departed_vehicle_count"] = len(departed_measurement_ids)
    metrics["insertion_failure_count"] = len(expected_vehicle_ids - departed_measurement_ids)
    metrics["unfinished_vehicle_count"] = max(0, len(expected_vehicle_ids) - metrics["trip_count"])
    metrics["teleport_count"] = len(teleported_ids)
    metrics["teleported_vehicle_ids"] = sorted(teleported_ids)[:100]
    persistently_gridlocked = [
        vehicle_id for vehicle_id, stopped_s in max_standstill_s.items()
        if stopped_s >= PERSISTENT_GRIDLOCK_S
    ]
    metrics["persistent_gridlock_vehicle_count"] = len(persistently_gridlocked)
    metrics["persistent_gridlock_vehicle_ids"] = sorted(persistently_gridlocked)[:100]
    metrics["maximum_vehicle_standstill_s"] = max(max_standstill_s.values(), default=0)
    metrics["rerouting"] = {
        "probability": rerouting_probability,
        "period_s": rerouting_period_s,
        "threshold_factor": rerouting_threshold,
    }
    metrics["vehicle_routes"] = vehicle_routes
    metrics["trip_endpoints"] = trip_endpoints
    metrics["street_activity"] = {
        "available_event_locations": len(activity_events or []),
        "stops_applied": len(applied_activity_ids),
        "errors": activity_errors,
    }
    metrics["signal_calibration"] = signal_calibration
    metrics["warmup_s"] = measurement_start_s
    metrics["sample_interval_s"] = sample_interval_s
    metrics["wall_clock_budget_s"] = wall_clock_budget_s
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
    edge_totals: dict[str, dict[str, Any]],
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
            "throughput_vehicles": float(len(totals.get("throughput_vehicle_ids") or ())),
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


def _baseline_load_stable(metrics: dict[str, Any], planned_count: int) -> bool:
    """Whether an open-road run is sound enough to anchor a comparison."""
    if planned_count <= 0 or metrics.get("truncated_by_time_budget", False):
        return False
    completion_ratio = int(metrics.get("trip_count", 0) or 0) / planned_count
    insertion_ratio = int(metrics.get("insertion_failure_count", 0) or 0) / planned_count
    gridlock_ratio = int(metrics.get("persistent_gridlock_vehicle_count", 0) or 0) / planned_count
    return bool(
        completion_ratio >= MIN_BASELINE_COMPLETION_RATIO
        and insertion_ratio <= MAX_BASELINE_INSERTION_FAILURE_RATIO
        and gridlock_ratio <= MAX_BASELINE_PERSISTENT_GRIDLOCK_RATIO
        and int(metrics.get("teleport_count", 0) or 0) == 0
    )


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
    baseline_only = sorted(set(baseline_trips) - set(closure_trips))
    closure_only = sorted(set(closure_trips) - set(baseline_trips))
    representative_journey: dict[str, Any] | None = None
    paired_journey_changes: list[float] = []

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
        journey_rows = []
        for vehicle_id in shared:
            baseline_journey = baseline_trips[vehicle_id].get(
                "journey_time_s",
                baseline_trips[vehicle_id]["duration_s"]
                + baseline_trips[vehicle_id].get("depart_delay_s", 0.0),
            )
            closure_journey = closure_trips[vehicle_id].get(
                "journey_time_s",
                closure_trips[vehicle_id]["duration_s"]
                + closure_trips[vehicle_id].get("depart_delay_s", 0.0),
            )
            journey_rows.append((
                vehicle_id, baseline_journey, closure_journey,
                closure_journey - baseline_journey,
            ))
        paired_journey_changes = [row[3] for row in journey_rows]
        affected_rows = [row for row in journey_rows if abs(row[3]) >= 1.0]
        representative_pool = affected_rows or journey_rows
        median_change = statistics.median(row[3] for row in representative_pool)
        vehicle_id, example_before, example_after, example_change = min(
            representative_pool, key=lambda row: abs(row[3] - median_change)
        )
        representative_journey = {
            "vehicle_id": vehicle_id,
            **((baseline.get("trip_endpoints") or {}).get(vehicle_id) or {}),
            "baseline_journey_time_s": example_before,
            "closure_journey_time_s": example_after,
            "extra_time_s": example_change,
            "affected_trip": bool(affected_rows),
            "selection": (
                "affected_completed_paired_trip_nearest_median_affected_time_change"
                if affected_rows else "completed_paired_trip_nearest_median_time_change"
            ),
        }
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
    closure_completion_ratio = closure["trip_count"] / planned_count if planned_count else None
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
    baseline_insertion_failures = int(baseline.get("insertion_failure_count", 0) or 0)
    closure_insertion_failures = int(closure.get("insertion_failure_count", 0) or 0)
    insertion_failure_ratio = baseline_insertion_failures / planned_count if planned_count else 0.0
    insertion_stable = insertion_failure_ratio <= MAX_BASELINE_INSERTION_FAILURE_RATIO
    teleport_count = int(baseline.get("teleport_count", 0) or 0) + int(closure.get("teleport_count", 0) or 0)
    physically_solved = teleport_count == 0
    baseline_gridlock_count = int(baseline.get("persistent_gridlock_vehicle_count", 0) or 0)
    closure_gridlock_count = int(closure.get("persistent_gridlock_vehicle_count", 0) or 0)
    baseline_gridlock_free = baseline_gridlock_count == 0
    baseline_gridlock_ratio = baseline_gridlock_count / planned_count if planned_count else 0.0
    baseline_gridlock_stable = baseline_gridlock_ratio <= MAX_BASELINE_PERSISTENT_GRIDLOCK_RATIO
    baseline_routes = baseline.get("vehicle_routes") or {}
    closure_routes = closure.get("vehicle_routes") or {}
    comparable_routes = set(baseline_routes) & set(closure_routes)
    changed_routes = sum(baseline_routes[key] != closure_routes[key] for key in comparable_routes)
    baseline_quality_ready = bool(
        baseline_stable
        and insertion_stable
        and baseline_gridlock_stable
        and physically_solved
        and simulation_complete
    )
    journey_time_ready = bool(shared) and paired_sample_sufficient and baseline_quality_ready
    # If the open-road run is sound but fewer than 20% of trips finish with
    # the closure, the missing paired sample is itself the result: corridor
    # capacity collapsed. Withhold journey-time magnitude, but keep the
    # completion-loss assessment usable instead of calling the run broken.
    closure_capacity_failure = bool(
        baseline_quality_ready
        and not paired_sample_sufficient
        and closure_completion_ratio is not None
        and closure_completion_ratio < MIN_PAIRED_TRIP_RATIO
    )
    validity_reasons = []
    if not simulation_complete:
        validity_reasons.append("simulation_time_limit")
    if not baseline_stable:
        validity_reasons.append("open_road_baseline_overloaded")
    if not paired_sample_sufficient and not closure_capacity_failure:
        validity_reasons.append("paired_sample_too_small")
    if not insertion_stable:
        validity_reasons.append("open_road_insertion_failures")
    if not physically_solved:
        validity_reasons.append("vehicle_teleport_detected")
    if not baseline_gridlock_stable:
        validity_reasons.append("open_road_persistent_gridlock")
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
        "journey_time_ready": journey_time_ready,
        "closure_capacity_failure": closure_capacity_failure,
        "minimum_baseline_completion_ratio": MIN_BASELINE_COMPLETION_RATIO,
        "baseline_stable": baseline_stable,
        "validity_reasons": validity_reasons,
        "simulation_complete": simulation_complete,
        "assessment_ready": journey_time_ready or closure_capacity_failure,
        "assessment_mode": (
            "paired_journey_comparison" if journey_time_ready
            else "closure_capacity_failure" if closure_capacity_failure
            else "incomplete"
        ),
        "physically_solved": physically_solved,
        "teleport_count_baseline": int(baseline.get("teleport_count", 0) or 0),
        "teleport_count_closure": int(closure.get("teleport_count", 0) or 0),
        "persistent_gridlock_count_baseline": baseline_gridlock_count,
        "persistent_gridlock_count_closure": closure_gridlock_count,
        "baseline_gridlock_free": baseline_gridlock_free,
        "baseline_gridlock_ratio": baseline_gridlock_ratio,
        "maximum_baseline_gridlock_ratio": MAX_BASELINE_PERSISTENT_GRIDLOCK_RATIO,
        "baseline_gridlock_stable": baseline_gridlock_stable,
        "insertion_failure_count_baseline": baseline_insertion_failures,
        "insertion_failure_count_closure": closure_insertion_failures,
        "baseline_insertion_stable": insertion_stable,
        "route_comparison_count": len(comparable_routes),
        "rerouted_vehicle_count": changed_routes,
        "rerouted_vehicle_ratio": changed_routes / len(comparable_routes) if comparable_routes else None,
        # These expose the survivor population behind the paired mean. A
        # closure can barely delay trips that still finish while preventing
        # many other baseline completions from finishing at all.
        "baseline_completed_closure_unfinished_count": len(baseline_only),
        "closure_completed_baseline_unfinished_count": len(closure_only),
        "net_additional_unfinished_trip_count": max(0, baseline["trip_count"] - closure["trip_count"]),
        "paired_journey_change_median_s": (
            statistics.median(paired_journey_changes) if paired_journey_changes else None
        ),
        "paired_journey_worsened_count": sum(value > 0 for value in paired_journey_changes),
        "paired_journey_improved_count": sum(value < 0 for value in paired_journey_changes),
        "representative_journey": representative_journey,
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
        "completed_trip_ratio_closure": closure_completion_ratio,
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
        occupancy_delta = after_count - before_count
        before_throughput = float(before.get("throughput_vehicles", before_count))
        after_throughput = float(after.get("throughput_vehicles", after_count))
        delta = after_throughput - before_throughput
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
            "occupancy_delta": round(occupancy_delta, 2),
            "baseline_throughput": round(before_throughput, 2),
            "closure_throughput": round(after_throughput, 2),
            "vehicle_delta": round(delta, 2),
            "throughput_delta": round(delta, 2),
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
            "aggregation": "sum_of_unique_vehicle_throughput_changes_speed_weighted_by_vehicle_occupancy",
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
    network_config = _traffic_calibration().get("network_overrides") or {}
    if not isinstance(network_config, dict):
        network_config = {}
    network_edges = {edge.getID(): edge for edge in net.getEdges()}
    network_lanes = {
        lane.getID() for edge in network_edges.values() for lane in edge.getLanes()
    }
    disabled_lane_ids = [
        str(lane_id) for lane_id in network_config.get("disabled_lane_ids", [])
        if str(lane_id) in network_lanes
    ]
    disabled_edge_ids = [
        str(edge_id) for edge_id in network_config.get("disabled_edge_ids", [])
        if str(edge_id) in network_edges
    ]
    if requested_edge_ids:
        closure = resolve_drawn_closure(requested_edge_ids, closure_mode, one_way=one_way)
        road_name = closure["label"]
        closure_scope = "drawn"
        # Use both directions of the selected physical section as the demand
        # anchor. Flipping the one-way arrow then changes only the direction
        # left open, not the corridor or synthetic trip population.
        comparison_edge_ids = _physical_selection_edge_ids(
            closure["requested_edge_ids"], net
        ) or sorted(closure["requested_edge_ids"])
        corridor = corridor_edges_for_ids(comparison_edge_ids, road_name)
        monitoring_corridor = corridor_edges_for_ids(
            comparison_edge_ids, road_name, radius_m=MONITORING_RADIUS_M
        )
    else:
        comparison_edge_ids = []
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
    sample_interval_s, wall_clock_budget_s = _simulation_runtime_settings(duration_s)
    corridor_lane_km = _corridor_lane_km(corridor)
    corridor_demand_scale = _corridor_demand_scale(corridor)
    scenario_observations = _scenario_calibration(scenario_key)
    observed_departure_rate = scenario_observations.get("departures_per_min")
    try:
        demand_rate_per_min = (
            max(1.0, float(observed_departure_rate))
            if observed_departure_rate is not None
            else BASE_VEHICLES_PER_MIN * corridor_demand_scale
        )
    except (TypeError, ValueError):
        demand_rate_per_min = BASE_VEHICLES_PER_MIN * corridor_demand_scale
    applied_scenario_scale = 1.0 if observed_departure_rate is not None else scenario["demand_scale"]
    vehicle_target = int(
        demand_rate_per_min * duration_min * applied_scenario_scale * demand_multiplier
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
    selection_seed = ",".join(comparison_edge_ids) if comparison_edge_ids else road_name
    # Duration deliberately does not affect the seed: changing 10 to 20
    # minutes should extend the same demand stream, not invent a new scenario.
    seed = zlib.crc32(
        f"{selection_seed}|{scenario_key}|{demand_multiplier}".encode("utf-8")
    )
    ensemble_config = scenario_observations.get("run_seeds") or {}
    requested_seed_count = int(payload.get("seed_count", 1) or 1)
    if requested_seed_count not in {1, 3, 5}:
        raise ValueError("seed_count must be 1, 3, or 5")
    # An explicit UI/API ensemble choice takes precedence over the optional
    # calibration-file default. Seeds are derived from the stable comparison
    # hash, so repeating the same scenario remains exactly reproducible.
    if requested_seed_count > 1:
        ensemble_config = {
            "enabled": True,
            "seeds": [seed + offset for offset in range(requested_seed_count)],
        }
    ensemble_seeds = _ensemble_seeds(ensemble_config, seed)
    # Applied to the simulation from monitoring_corridor, not the 250 m
    # demand corridor: SUMO applies these network-wide via traci regardless
    # of which edges are "in" the corridor, so a vehicle rerouting just past
    # 250 m used to fall back to the network's generic default speed there
    # even when a real municipal limit was available for that block.
    municipal_speed_limits, _monitoring_speed_limit_counts = _speed_limit_overrides(monitoring_corridor)
    calibrated_speed_limits = network_config.get("edge_speed_limits_kph") or {}
    if isinstance(calibrated_speed_limits, dict):
        for edge_id, speed_kph in calibrated_speed_limits.items():
            try:
                if edge_id in network_edges and float(speed_kph) > 0:
                    municipal_speed_limits[edge_id] = float(speed_kph) / 3.6
            except (TypeError, ValueError):
                continue
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
    activity_events = _activity_events(corridor)
    warmup_s = min(DEFAULT_WARMUP_S, duration_s)
    route_sampler_config = scenario_observations.get("route_sampler") or {}
    route_sampler_enabled = bool(
        isinstance(route_sampler_config, dict) and route_sampler_config.get("enabled", False)
    )
    route_sampler_metadata: dict[str, Any] = {"applied": False}
    dynamic_assignment_config = scenario_observations.get("dynamic_assignment") or {}
    dynamic_assignment_enabled = bool(
        isinstance(dynamic_assignment_config, dict)
        and dynamic_assignment_config.get("enabled", False)
    )
    if route_sampler_enabled and dynamic_assignment_enabled:
        raise ValueError(
            "route_sampler and dynamic_assignment cannot both be enabled: "
            "routeSampler's count-matched route selection must remain intact"
        )
    dynamic_assignment_metadata: dict[str, Any] = {"applied": False}

    with tempfile.TemporaryDirectory(prefix="traffic_sim_") as tmp:
        workdir = Path(tmp)
        def run_ensemble(target: int, attempt: int) -> list[dict[str, Any]]:
            runs = []
            for ensemble_seed in ensemble_seeds:
                demand_seed = _sumo_seed(
                    seed if len(ensemble_seeds) == 1 else zlib.crc32(
                        f"{seed}|{ensemble_seed}".encode("utf-8")
                    )
                )
                seed_workdir = workdir / f"attempt_{attempt}" / f"seed_{ensemble_seed}"
                demand_arguments = {
                    "corridor": corridor,
                    "duration_s": duration_s,
                    "vehicle_count": target,
                    "inbound_bias": scenario["inbound_bias"],
                    "seed": demand_seed,
                    "workdir": seed_workdir,
                    "road_congestion": road_congestion,
                    "endpoint_exclusion_ids": set(comparison_edge_ids),
                    "warmup_s": warmup_s,
                    "scenario_key": scenario_key,
                }
                run_route_sampler: dict[str, Any] = {"applied": False}
                if route_sampler_enabled:
                    trip_file, planned_count, run_route_sampler = _generate_route_sampled_trips(
                        **demand_arguments,
                        route_sampler=route_sampler_config,
                        demand_multiplier=demand_multiplier,
                    )
                else:
                    trip_file, planned_count = _generate_trips(**demand_arguments)
                run_dynamic_assignment: dict[str, Any] = {"applied": False}
                if dynamic_assignment_enabled:
                    trip_file, run_dynamic_assignment = _apply_dynamic_assignment(
                        trip_file, seed_workdir / "dua", dynamic_assignment_config
                    )
                baseline_raw, baseline_metrics = _run_simulation(
                    trip_file, duration_s, disabled_lane_ids, disabled_edge_ids,
                    seed_workdir / "baseline", monitored_edges=monitored_edge_ids,
                    traffic_control=traffic_control, edge_speed_limits=municipal_speed_limits,
                    warmup_s=warmup_s, scenario_key=scenario_key,
                    activity_events=activity_events, sample_interval_s=sample_interval_s,
                    wall_clock_budget_s=wall_clock_budget_s, sumo_seed=ensemble_seed,
                )
                closure_raw, closure_metrics = _run_simulation(
                    trip_file, duration_s,
                    sorted(set(disabled_lane_ids) | set(closure["lane_ids"])),
                    sorted(set(disabled_edge_ids) | set(closure["edge_ids"])),
                    seed_workdir / "closure", monitored_edges=monitored_edge_ids,
                    traffic_control=traffic_control, edge_speed_limits=municipal_speed_limits,
                    warmup_s=warmup_s, scenario_key=scenario_key,
                    activity_events=activity_events, sample_interval_s=sample_interval_s,
                    wall_clock_budget_s=wall_clock_budget_s, sumo_seed=ensemble_seed,
                )
                runs.append({
                    "seed": ensemble_seed,
                    "demand_seed": demand_seed,
                    "planned_count": planned_count,
                    "baseline_raw": baseline_raw,
                    "baseline_metrics": baseline_metrics,
                    "closure_raw": closure_raw,
                    "closure_metrics": closure_metrics,
                    "impact": _diff_metrics(baseline_metrics, closure_metrics, planned_count),
                    "route_sampler": run_route_sampler,
                    "dynamic_assignment": run_dynamic_assignment,
                })
            return runs

        requested_vehicle_target = vehicle_target
        effective_vehicle_target = vehicle_target
        stability_attempts: list[dict[str, Any]] = []
        automatic_backoff_allowed = not (
            route_sampler_enabled or observed_departure_rate is not None
        )
        for stability_attempt in range(MAX_AUTOMATIC_STABILITY_ATTEMPTS):
            ensemble_runs = run_ensemble(effective_vehicle_target, stability_attempt)
            stable_baselines = sum(
                _baseline_load_stable(run["baseline_metrics"], run["planned_count"])
                for run in ensemble_runs
            )
            required_stable_baselines = (
                1 if len(ensemble_seeds) == 1 else len(ensemble_seeds) // 2 + 1
            )
            stability_attempts.append({
                "attempt": stability_attempt + 1,
                "vehicle_target": effective_vehicle_target,
                "stable_baselines": stable_baselines,
            })
            if stable_baselines >= required_stable_baselines or not automatic_backoff_allowed:
                break
            if stability_attempt + 1 >= MAX_AUTOMATIC_STABILITY_ATTEMPTS:
                break
            minimum_target = max(1, math.ceil(requested_vehicle_target * 0.5))
            next_target = max(
                minimum_target,
                math.floor(effective_vehicle_target * AUTOMATIC_STABILITY_BACKOFF),
            )
            if next_target >= effective_vehicle_target:
                break
            effective_vehicle_target = next_target

        ensemble_summary = _ensemble_summary(
            [run["impact"] for run in ensemble_runs], ensemble_seeds
        )
        ensemble_summary["automatic_stability"] = {
            "applied": effective_vehicle_target < requested_vehicle_target,
            "requested_vehicle_target": requested_vehicle_target,
            "effective_vehicle_target": effective_vehicle_target,
            "applied_scale": (
                effective_vehicle_target / requested_vehicle_target
                if requested_vehicle_target else 1.0
            ),
            "attempts": stability_attempts,
        }
        # Keep an actual paired run for the map and playback. Select the run
        # nearest the ensemble median journey-time effect, not merely the
        # first seed, so the displayed animation best represents the summary.
        median_journey = (ensemble_summary["journey_time_change_s"] or {}).get("median")
        ready_runs = [
            run for run in ensemble_runs if run["impact"].get("assessment_ready")
        ]
        journey_ready_runs = [
            run for run in ready_runs if run["impact"].get("journey_time_ready")
        ]
        representative_candidates = (
            journey_ready_runs if median_journey is not None else ready_runs
        ) or ensemble_runs
        representative_run = min(
            representative_candidates,
            key=lambda run: abs(
                (run["impact"].get("mean_journey_time_change_s") or 0.0)
                - (median_journey or 0.0)
            ),
        )
        planned_count = representative_run["planned_count"]
        baseline_metrics = representative_run["baseline_metrics"]
        closure_metrics = representative_run["closure_metrics"]
        impact = representative_run["impact"]
        impact["ensemble"] = ensemble_summary
        if not ensemble_summary["assessment_ready"]:
            impact["assessment_ready"] = False
            impact.setdefault("validity_reasons", []).append("ensemble_contains_invalid_run")
        route_sampler_metadata = representative_run["route_sampler"]
        dynamic_assignment_metadata = representative_run["dynamic_assignment"]
        config = load_viewer_config()
        baseline_tracks = _project_tracks(representative_run["baseline_raw"]["tracks"], net, config)
        closure_tracks = _project_tracks(representative_run["closure_raw"]["tracks"], net, config)
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
    representative_journey = impact.get("representative_journey")
    if representative_journey:
        origin = index.get(representative_journey.get("origin_edge_id")) or {}
        destination = index.get(representative_journey.get("destination_edge_id")) or {}
        representative_journey["origin_name"] = origin.get("name") or "corridor entry"
        representative_journey["destination_name"] = destination.get("name") or "corridor exit"
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
    open_direction = _travel_direction_summary(remaining_open_geometry_records)
    # Per-vehicle rows exist only to pair the two runs; sending thousands of
    # them to the viewer would dwarf the trajectories they came from.
    baseline_metrics.pop("per_vehicle", None)
    closure_metrics.pop("per_vehicle", None)
    baseline_metrics.pop("vehicle_routes", None)
    closure_metrics.pop("vehicle_routes", None)
    baseline_metrics.pop("trip_endpoints", None)
    closure_metrics.pop("trip_endpoints", None)
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
            "open_direction": open_direction,
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
            "generator": (
                "Eclipse SUMO routeSampler.py matched to configured observed counts"
                if route_sampler_enabled
                else "steady-state corridor trips, boundary weighted with local access share"
            ),
            "base_departures_per_min": BASE_VEHICLES_PER_MIN,
            "reference_corridor_lane_km": REFERENCE_CORRIDOR_LANE_KM,
            "corridor_demand_scale": round(corridor_demand_scale, 3),
            "demand_departures_per_min": round(demand_rate_per_min, 1),
            "calibration_basis": (
                "configured observed edge and/or turning counts fitted by routeSampler.py"
                if route_sampler_enabled
                else "network-stability sweep on the supplied Cape Town CBD SUMO network, "
                "scaled to this corridor's lane-km relative to the reference corridor"
            ),
            "observed_count_calibration": route_sampler_enabled or observed_departure_rate is not None,
            "observed_departures_per_min": observed_departure_rate,
            "route_sampler": route_sampler_metadata,
            "run_seeds": ensemble_summary,
            "dynamic_assignment": dynamic_assignment_metadata,
            "through_trip_share": scenario_observations.get("through_trip_share", 0.85),
            "scenario": scenario["key"],
            "demand_scale": applied_scenario_scale,
            "user_demand_multiplier": demand_multiplier,
            "automatic_stability_scale": round(
                effective_vehicle_target / requested_vehicle_target, 3
            ) if requested_vehicle_target else 1.0,
            "automatic_stability_attempts": stability_attempts,
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
            "representative_seed": representative_run["seed"],
            "representative_demand_seed": representative_run["demand_seed"],
            "comparison_key": selection_seed,
            "comparison_edge_ids": comparison_edge_ids,
            "endpoint_policy": "boundary_weighted_through_trips_with_local_access_share",
            "selected_section_excluded_from_endpoints": bool(comparison_edge_ids),
            "local_access_modelled": True,
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
            "calibrated_disabled_lanes": len(disabled_lane_ids),
            "calibrated_disabled_edges": len(disabled_edge_ids),
            "calibrated_speed_overrides": len(calibrated_speed_limits) if isinstance(calibrated_speed_limits, dict) else 0,
            "note": "Municipal geometry and attributes enrich the routable SUMO network; confirmed and inferred speed limits are applied to both comparison runs and reported separately.",
        },
        "street_activity": _street_activity_summary(corridor),
        "traffic_control": traffic_control,
        "signals": (
            "surveyed_signal_programs_applied"
            if traffic_control == "signalized" and baseline_metrics.get("signal_calibration", {}).get("applied")
            else "network_signal_programs_enabled"
            if traffic_control == "signalized"
            else "all_traffic_lights_switched_off_priority_right_of_way"
        ),
        "signal_data_source": (
            "surveyed programs from traffic_calibration.json; SUMO-generated programs at unmatched signals"
            if baseline_metrics.get("signal_calibration", {}).get("applied")
            else "SUMO-generated fixed signal programs; no matched surveyed program supplied"
            if traffic_control == "signalized"
            else "priority right-of-way with traffic lights disabled"
        ),
        "baseline": baseline_metrics,
        "closure_metrics": closure_metrics,
        "impact": impact,
        "flow_comparison": flow_comparison,
        "street_flow_summary": street_flow_summary,
        "playback": {
            "sample_interval_s": sample_interval_s,
            "duration_s": duration_s,
            "scoring_horizon_s": int(duration_s * DRAIN_FACTOR),
            "warmup_s": warmup_s,
            "demand_window_s": duration_s,
            "wall_clock_budget_s_per_run": wall_clock_budget_s,
        },
        "trajectories": {
            "baseline": baseline_tracks,
            "closure": closure_tracks,
        },
    }
