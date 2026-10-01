"""CBD pedestrian route alternatives and matched synthetic walker cohorts."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from functools import lru_cache
import gzip
import json
import math
from pathlib import Path
import random
from typing import Any
from zoneinfo import ZoneInfo

import networkx as nx
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from .heat import ground_shade_samples
from .thermal_products import sample_points_at

PROJECT_ROOT = Path(__file__).resolve().parents[1]
NETWORK_PATH = PROJECT_ROOT / "data/derived/walking_network.json.gz"
LOCAL_TIMEZONE = ZoneInfo("Africa/Johannesburg")
WALK_SPEED_KMH = 4.8
MIN_SNAP_DISTANCE_M = 50.0
AGENT_COUNT = 100
AGENT_SEED = 462731
AGENT_SPEEDS_KMH = (4.0, 5.6)
SAMPLE_SPACING_M = 15.0
SHADE_TIME_STEP_MIN = 5
UTCI_HEAT_THRESHOLD_C = 26.0
OBJECTIVE_LABELS = {
    "fastest": "Fastest",
    "least_sun": "Least direct sun",
    "lowest_heat": "Lowest modelled heat load",
}


@lru_cache(maxsize=1)
def _network() -> tuple[nx.MultiDiGraph, dict[str, Any], STRtree, list[tuple[str, str, str]]]:
    if not NETWORK_PATH.is_file():
        raise FileNotFoundError("walking graph is not built; run scripts/build_walking_network.py")
    with gzip.open(NETWORK_PATH, "rt", encoding="utf-8") as stream:
        payload = json.load(stream)
    if payload.get("schema") != "conditions-walking-network/1":
        raise ValueError("walking graph asset has an unsupported schema")
    graph = nx.MultiDiGraph()
    for node_id, x, z in payload["nodes"]:
        graph.add_node(str(node_id), x=float(x), z=float(z))
    for edge in payload["edges"]:
        tags = edge.get("tags") or {}
        length = float(edge["length_m"])
        graph.add_edge(
            str(edge["u"]), str(edge["v"]), key=str(edge["id"]),
            id=str(edge["id"]), length_m=length,
            walk_seconds=length / (WALK_SPEED_KMH * 1000 / 3600),
            tags=tags, name=tags.get("name"),
            midpoint=(
                (float(graph.nodes[str(edge["u"])]["x"]) + float(graph.nodes[str(edge["v"])]["x"])) / 2,
                (float(graph.nodes[str(edge["u"])]["z"]) + float(graph.nodes[str(edge["v"])]["z"])) / 2,
            ),
        )
    edge_ids = list(graph.edges(keys=True))
    edge_lines = [LineString([
        (graph.nodes[u]["x"], graph.nodes[u]["z"]),
        (graph.nodes[v]["x"], graph.nodes[v]["z"]),
    ]) for u, v, _ in edge_ids]
    return graph, payload, STRtree(edge_lines), edge_ids


def clear_walking_network_cache() -> None:
    _network.cache_clear()


def _local_datetime(value: str) -> datetime:
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise ValueError("departure_at must be an ISO date and time") from error
    if result.tzinfo is None or result.utcoffset() is None:
        return result.replace(tzinfo=LOCAL_TIMEZONE)
    return result.astimezone(LOCAL_TIMEZONE)


def _check_endpoint(point: dict[str, float], label: str, bounds: tuple[float, ...]) -> tuple[float, float]:
    x, z = float(point["x"]), float(point["z"])
    if not (math.isfinite(x) and math.isfinite(z)):
        raise ValueError(f"{label} coordinates must be finite")
    left, min_z, right, max_z = bounds
    if not (left <= x <= right and min_z <= z <= max_z):
        raise ValueError(f"{label} is outside the mapped CBD walking area")
    return x, z


def _nearest_edge(
    point: tuple[float, float], graph: nx.MultiDiGraph, tree: STRtree,
    edge_ids: list[tuple[str, str, str]], label: str,
) -> tuple[tuple[str, str], float, float, tuple[float, float]]:
    query = Point(point)
    edge_index = int(tree.nearest(query))
    u, v, _ = edge_ids[edge_index]
    start = Point(graph.nodes[u]["x"], graph.nodes[u]["z"])
    end = Point(graph.nodes[v]["x"], graph.nodes[v]["z"])
    line = LineString([start, end])
    distance = float(query.distance(line))
    if distance > MIN_SNAP_DISTANCE_M:
        raise ValueError(f"{label} is {distance:.1f} m from the nearest walkable path; maximum snap distance is 50 m")
    along = float(line.project(query))
    fraction = min(1.0, max(0.0, along / max(float(line.length), 1e-9)))
    snapped = line.interpolate(along)
    return (u, v), fraction, distance, (float(snapped.x), float(snapped.y))


def _add_endpoint_snap_edges(
    graph: nx.MultiDiGraph, origin: tuple[str, str], destination: tuple[str, str],
    origin_fraction: float, destination_fraction: float,
    origin_point: tuple[float, float], destination_point: tuple[float, float],
) -> tuple[str, str]:
    """Attach virtual endpoints to directed segments while preserving foot direction tags."""
    source, target = "__walking_origin__", "__walking_destination__"
    graph.add_node(source, x=origin_point[0], z=origin_point[1])
    graph.add_node(target, x=destination_point[0], z=destination_point[1])

    def add_fractional_edge(u: str, v: str, edge: dict[str, Any], start_fraction: float, end_fraction: float, key: str) -> None:
        fraction = max(0.0, end_fraction - start_fraction)
        if fraction <= 1e-8:
            return
        data = dict(edge)
        data["length_m"] = float(edge["length_m"]) * fraction
        for name in ("walk_seconds", "sun_cost", "heat_cost"):
            if name in edge:
                data[name] = float(edge[name]) * fraction
        graph.add_edge(u, v, key=key, **data)

    endpoint_pairs = {frozenset(origin), frozenset(destination)}
    for u, v, key, data in list(graph.edges(keys=True, data=True)):
        if u.startswith("__walking_") or v.startswith("__walking_"):
            continue
        pair = frozenset((u, v))
        if pair not in endpoint_pairs:
            continue
        if (u, v) == origin:
            origin_t = origin_fraction
        elif (v, u) == origin:
            origin_t = 1.0 - origin_fraction
        else:
            origin_t = None
        if (u, v) == destination:
            destination_t = destination_fraction
        elif (v, u) == destination:
            destination_t = 1.0 - destination_fraction
        else:
            destination_t = None
        if origin_t is not None:
            add_fractional_edge(source, v, data, origin_t, 1.0, f"snap-origin-out:{key}")
            add_fractional_edge(u, source, data, 0.0, origin_t, f"snap-origin-in:{key}")
        if destination_t is not None:
            add_fractional_edge(u, target, data, 0.0, destination_t, f"snap-destination-in:{key}")
            add_fractional_edge(target, v, data, destination_t, 1.0, f"snap-destination-out:{key}")
        if origin_t is not None and destination_t is not None and destination_t >= origin_t:
            add_fractional_edge(source, target, data, origin_t, destination_t, f"snap-direct:{key}")
    return source, target


def _rounded_minute(when: datetime) -> tuple[str, int]:
    local = when.astimezone(LOCAL_TIMEZONE)
    minute = local.hour * 60 + local.minute
    if local.second >= 30:
        minute += 1
    if minute >= 1440:
        return (local + timedelta(days=1)).date().isoformat(), 0
    return local.date().isoformat(), minute


def _shade_for_samples(samples: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, int], dict[tuple[float, float], list[int]]] = defaultdict(lambda: defaultdict(list))
    for index, sample in enumerate(samples):
        date_text, minutes = _rounded_minute(sample["when"])
        minutes = ((minutes + SHADE_TIME_STEP_MIN // 2) // SHADE_TIME_STEP_MIN) * SHADE_TIME_STEP_MIN
        if minutes >= 1440:
            date_text = (datetime.fromisoformat(date_text) + timedelta(days=1)).date().isoformat()
            minutes = 0
        key = (round(sample["x"], 2), round(sample["z"], 2))
        groups[(date_text, minutes)][key].append(index)
    for (date_text, minutes), positions in groups.items():
        coordinates = list(positions)
        # The requested ground samples are the only shade targets. Clipping
        # shadow construction to this small corridor avoids building a full
        # citywide shadow surface for every walker minute while retaining all
        # blockers whose projected shadows can touch those samples.
        domain_bounds = (
            min(point[0] for point in coordinates) - 0.5,
            min(point[1] for point in coordinates) - 0.5,
            max(point[0] for point in coordinates) + 0.5,
            max(point[1] for point in coordinates) + 0.5,
        )
        values = ground_shade_samples(date_text, minutes, coordinates, domain_bounds)
        for coordinate, shade in zip(coordinates, values):
            for index in positions[coordinate]:
                samples[index]["shade"] = shade


def _new_route_samples(
    route_id: str, agent_id: int | None, speed_kmh: float,
    line: LineString, departure: datetime,
) -> list[dict[str, Any]]:
    length = float(line.length)
    if length <= 0.01:
        return []
    count = max(1, math.ceil(length / SAMPLE_SPACING_M))
    speed_mps = speed_kmh * 1000 / 3600
    samples = []
    elapsed = 0.0
    for index in range(count):
        start = length * index / count
        end = length * (index + 1) / count
        duration = (end - start) / speed_mps
        point = line.interpolate((start + end) / 2)
        samples.append({
            "route_id": route_id, "agent_id": agent_id, "index": index,
            "x": float(point.x), "z": float(point.y),
            "duration_s": duration,
            "when": departure + timedelta(seconds=elapsed + duration / 2),
            "shade": None,
        })
        elapsed += duration
    return samples


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * fraction
    low = int(index)
    high = min(low + 1, len(values) - 1)
    return values[low] * (high - index) + values[high] * (index - low) if high != low else values[low]


def _summarize_samples(samples: list[dict[str, Any]], thermal_rows: list[dict[str, Any] | None], total_length_m: float) -> dict[str, Any]:
    total_seconds = sum(float(item["duration_s"]) for item in samples)
    daylight_seconds = 0.0
    shade_seconds = 0.0
    sun_seconds = 0.0
    thermal_seconds = 0.0
    utci_seconds = 0.0
    heat_degree_minutes = 0.0
    wind_seconds = 0.0
    wind_sum = 0.0
    for item, weather in zip(samples, thermal_rows):
        duration = float(item["duration_s"])
        shaded = item.get("shade")
        if shaded is not None:
            daylight_seconds += duration
            if shaded:
                shade_seconds += duration
            else:
                sun_seconds += duration
        if weather:
            utci = weather.get("utci_c")
            wind = weather.get("wind_1p5m_mps")
            if utci is not None:
                thermal_seconds += duration
                utci_seconds += float(utci) * duration
                heat_degree_minutes += max(0.0, float(utci) - UTCI_HEAT_THRESHOLD_C) * duration / 60.0
            if wind is not None:
                wind_seconds += duration
                wind_sum += float(wind) * duration
    return {
        "distance_m": round(total_length_m, 1),
        "estimated_walking_minutes": round(total_seconds / 60.0, 1),
        "direct_sun_minutes": round(sun_seconds / 60.0, 1),
        "shade_minutes": round(shade_seconds / 60.0, 1),
        "daylight_minutes": round(daylight_seconds / 60.0, 1),
        "shade_fraction_during_daylight": round(shade_seconds / daylight_seconds, 3) if daylight_seconds else None,
        "mean_utci_c": round(utci_seconds / thermal_seconds, 2) if thermal_seconds else None,
        "heat_load_degree_minutes": round(heat_degree_minutes, 1) if thermal_seconds else None,
        "thermal_coverage_percent": round(100 * thermal_seconds / total_seconds, 1) if total_seconds else 0.0,
        "mean_pedestrian_wind_mps": round(wind_sum / wind_seconds, 2) if wind_seconds else None,
        "wind_coverage_percent": round(100 * wind_seconds / total_seconds, 1) if total_seconds else 0.0,
        "access_tag_unknown_percent": None,
    }


def _evaluate_paths(
    path_records: list[dict[str, Any]], departure: datetime, *, include_agents: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    rng = random.Random(AGENT_SEED)
    speeds = [round(rng.uniform(*AGENT_SPEEDS_KMH), 3) for _ in range(AGENT_COUNT)]
    sample_sets: list[dict[str, Any]] = []
    sample_indices: dict[tuple[str, int | None], list[int]] = {}
    for route in path_records:
        route_id = route["id"]
        line: LineString = route["line"]
        cohorts = [(None, WALK_SPEED_KMH)]
        if include_agents:
            cohorts.extend((index, speed) for index, speed in enumerate(speeds))
        for agent_id, speed in cohorts:
            samples = _new_route_samples(route_id, agent_id, speed, line, departure)
            sample_indices[(route_id, agent_id)] = list(range(len(sample_sets), len(sample_sets) + len(samples)))
            sample_sets.extend(samples)

    _shade_for_samples(sample_sets)
    thermal_result = sample_points_at([
        (item["x"], item["z"], item["when"]) for item in sample_sets
    ]) if sample_sets else {"status": "unavailable", "samples": []}
    thermal_rows = thermal_result.get("samples") or [None] * len(sample_sets)

    route_outputs = []
    for route in path_records:
        route_id = route["id"]
        line = route["line"]
        base_indices = sample_indices.get((route_id, None), [])
        base_samples = [sample_sets[index] for index in base_indices]
        base_weather = [thermal_rows[index] for index in base_indices]
        metrics = _summarize_samples(base_samples, base_weather, line.length)
        access_unknown_length = sum(
            edge["length_m"] for edge in route["edges"] if edge["tags"].get("access_unknown")
        )
        route_access_unknown = round(100 * access_unknown_length / line.length, 1) if line.length else 0.0
        metrics["access_tag_unknown_percent"] = route_access_unknown
        metrics["steps_distance_m"] = round(sum(
            edge["length_m"] for edge in route["edges"] if edge["tags"].get("highway") == "steps"
        ), 1)

        agents = []
        for agent_id, speed in enumerate(speeds if include_agents else []):
            indices = sample_indices[(route_id, agent_id)]
            agent_samples = [sample_sets[index] for index in indices]
            agent_weather = [thermal_rows[index] for index in indices]
            values = _summarize_samples(agent_samples, agent_weather, line.length)
            agents.append({
                "agent_id": agent_id,
                "speed_kmh": speed,
                "walking_minutes": values["estimated_walking_minutes"],
                "direct_sun_minutes": values["direct_sun_minutes"],
                "shade_minutes": values["shade_minutes"],
                "heat_load_degree_minutes": values["heat_load_degree_minutes"],
                "mean_utci_c": values["mean_utci_c"],
                "mean_pedestrian_wind_mps": values["mean_pedestrian_wind_mps"],
                "thermal_coverage_percent": values["thermal_coverage_percent"],
                "wind_coverage_percent": values["wind_coverage_percent"],
            })

        heat_values = [agent["heat_load_degree_minutes"] for agent in agents if agent["heat_load_degree_minutes"] is not None]
        sun_values = [agent["direct_sun_minutes"] for agent in agents]
        wind_values = [agent["mean_pedestrian_wind_mps"] for agent in agents if agent["mean_pedestrian_wind_mps"] is not None]
        if not agents:
            representative = None
        elif heat_values:
            covered_agents = [agent for agent in agents if agent["heat_load_degree_minutes"] is not None]
            representative = sorted(covered_agents, key=lambda agent: agent["heat_load_degree_minutes"])[len(covered_agents) // 2]
        else:
            representative = sorted(agents, key=lambda agent: agent["direct_sun_minutes"])[len(agents) // 2]
        trace = []
        elapsed = cumulative_sun = cumulative_heat = 0.0
        selected_id = representative["agent_id"] if representative else None
        selected_indices = sample_indices.get((route_id, selected_id), []) if representative else []
        for index in selected_indices:
            item = sample_sets[index]
            weather = thermal_rows[index]
            duration = float(item["duration_s"])
            shaded = item.get("shade")
            if shaded is False:
                cumulative_sun += duration / 60.0
            if weather and weather.get("utci_c") is not None:
                cumulative_heat += max(0.0, float(weather["utci_c"]) - UTCI_HEAT_THRESHOLD_C) * duration / 60.0
            elapsed += duration
            trace.append({
                "progress_percent": round(100 * elapsed / (float(representative["walking_minutes"]) * 60), 1) if representative["walking_minutes"] else 100.0,
                "elapsed_minutes": round(elapsed / 60.0, 2),
                "x": round(float(item["x"]), 2),
                "z": round(float(item["z"]), 2),
                "cumulative_direct_sun_minutes": round(cumulative_sun, 2),
                "cumulative_heat_load_degree_minutes": (
                    round(cumulative_heat, 1) if heat_values and weather and weather.get("utci_c") is not None else None
                ),
                "utci_c": weather.get("utci_c") if weather else None,
                "wind_1p5m_mps": weather.get("wind_1p5m_mps") if weather else None,
            })
        evaluated_route = {
            "id": route_id,
            "label": route["label"],
            "objectives": route["objectives"],
            "geometry": [[round(float(x), 2), round(float(z), 2)] for x, z in line.coords],
            "snapped_origin": list(route["snapped_origin"]),
            "snapped_destination": list(route["snapped_destination"]),
            "metrics": metrics,
            "street_names": route["street_names"],
            "agents": agents,
            "agent_summary": {
                "count": len(agents), "seed": AGENT_SEED,
                "speed_range_kmh": list(AGENT_SPEEDS_KMH),
                "representative_agent_id": selected_id,
                "direct_sun_minutes_p50": round(_percentile(sun_values, .5), 1) if sun_values else None,
                "direct_sun_minutes_p90": round(_percentile(sun_values, .9), 1) if sun_values else None,
                "heat_load_degree_minutes_p50": round(_percentile(heat_values, .5), 1) if heat_values else None,
                "heat_load_degree_minutes_p90": round(_percentile(heat_values, .9), 1) if heat_values else None,
                "mean_pedestrian_wind_mps_p50": round(_percentile(wind_values, .5), 2) if wind_values else None,
                "representative_trace": trace,
            },
        }
        for objective in route["objectives"]:
            route_variant = dict(evaluated_route)
            route_variant["id"] = objective
            route_variant["label"] = OBJECTIVE_LABELS.get(objective, route["label"])
            route_variant["objectives"] = [objective]
            route_variant["same_path_as"] = [other for other in route["objectives"] if other != objective]
            route_outputs.append(route_variant)
    return {"routes": route_outputs, "thermal": thermal_result}, {"sample_count": len(sample_sets)}


def walking_routes(
    payload: dict[str, Any], *, include_agents: bool = True, return_plan: bool = False,
) -> dict[str, Any] | tuple[dict[str, Any], list[dict[str, Any]], datetime]:
    graph, manifest, edge_tree, edge_ids = _network()
    route_graph = graph.copy()
    bounds = tuple(float(value) for value in manifest["scene_bounds"])
    origin = _check_endpoint(payload["origin"], "Origin", bounds)
    destination = _check_endpoint(payload["destination"], "Destination", bounds)
    departure = _local_datetime(payload["departure_at"])
    origin_edge, origin_fraction, source_snap, source_point = _nearest_edge(origin, route_graph, edge_tree, edge_ids, "Origin")
    destination_edge, destination_fraction, target_snap, target_point = _nearest_edge(destination, route_graph, edge_tree, edge_ids, "Destination")
    if math.dist(source_point, target_point) < 0.5:
        raise ValueError("Origin and destination snap to the same walkable point; move them farther apart")

    source, target = _add_endpoint_snap_edges(
        route_graph, origin_edge, destination_edge, origin_fraction, destination_fraction,
        source_point, target_point,
    )

    try:
        fastest_nodes = nx.shortest_path(route_graph, source, target, weight="walk_seconds", method="dijkstra")
    except (nx.NetworkXNoPath, nx.NodeNotFound) as error:
        raise ValueError("No connected pedestrian route joins these locations in the mapped CBD network") from error

    # Earliest walking arrival gives each edge a predicted traversal time.
    # Environmental costs use that time instead of applying departure-time
    # conditions to every street in the CBD. Route summaries below use the
    # actual traversal times along each chosen path.
    earliest_arrival = nx.single_source_dijkstra_path_length(route_graph, source, weight="walk_seconds")
    edges = list(route_graph.edges(keys=True, data=True))
    edge_samples: list[dict[str, Any]] = []
    sampled_edges: list[dict[str, Any]] = []
    for u, v, _key, data in edges:
        duration = float(data["walk_seconds"])
        elapsed = earliest_arrival.get(u)
        if elapsed is None:
            data["sun_cost"] = data["heat_cost"] = math.inf
            continue
        ux, uz = float(route_graph.nodes[u]["x"]), float(route_graph.nodes[u]["z"])
        vx, vz = float(route_graph.nodes[v]["x"]), float(route_graph.nodes[v]["z"])
        edge_samples.append({
            "x": (ux + vx) / 2, "z": (uz + vz) / 2,
            "when": departure + timedelta(seconds=elapsed + duration / 2),
            "duration_s": duration, "shade": None,
        })
        sampled_edges.append(data)
    _shade_for_samples(edge_samples)
    thermal_at_arrival = sample_points_at([
        (item["x"], item["z"], item["when"]) for item in edge_samples
    ])
    thermal_edges = thermal_at_arrival.get("samples") or [None] * len(edge_samples)
    for item, data, weather in zip(edge_samples, sampled_edges, thermal_edges):
        duration = float(item["duration_s"])
        data["sun_cost"] = (duration if item["shade"] is False else 0.0) + duration * 1e-7
        utci = weather.get("utci_c") if weather else None
        data["heat_cost"] = (
            max(0.0, float(utci) - UTCI_HEAT_THRESHOLD_C) * duration / 60.0 + duration * 1e-7
            if utci is not None else math.inf
        )
    sun_nodes = nx.shortest_path(route_graph, source, target, weight="sun_cost", method="dijkstra")

    candidates: list[tuple[str, str, list[str]]] = [
        ("fastest", "Fastest", fastest_nodes),
        ("least_sun", "Least direct sun", sun_nodes),
    ]
    has_thermal_route = False
    if thermal_at_arrival.get("status") not in {"unavailable", "stale"}:
        try:
            heat_nodes = nx.shortest_path(route_graph, source, target, weight="heat_cost", method="dijkstra")
            if all(
                math.isfinite(min(float(data["heat_cost"]) for data in route_graph[u][v].values()))
                for u, v in zip(heat_nodes, heat_nodes[1:])
            ):
                candidates.append(("lowest_heat", "Lowest modelled heat load", heat_nodes))
                has_thermal_route = True
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            pass

    grouped: dict[tuple[str, ...], dict[str, Any]] = {}
    for route_id, label, nodes in candidates:
        key = tuple(nodes)
        if key not in grouped:
            path_edges = []
            coordinates = [
                (float(route_graph.nodes[node]["x"]), float(route_graph.nodes[node]["z"]))
                for node in nodes
            ]
            for u, v in zip(nodes, nodes[1:]):
                available = list(route_graph[u][v].values())
                weight = {"fastest": "walk_seconds", "least_sun": "sun_cost", "lowest_heat": "heat_cost"}[route_id]
                edge = min(available, key=lambda item: float(item[weight]))
                path_edges.append(edge)
            line = LineString(coordinates)
            grouped[key] = {
                "id": route_id, "label": label, "objectives": [], "edges": path_edges,
                "line": line, "street_names": sorted({
                    str(edge["name"]) for edge in path_edges if edge.get("name")
                }),
                "snapped_origin": source_point, "snapped_destination": target_point,
            }
        grouped[key]["objectives"].append(route_id)
        if route_id == "fastest":
            grouped[key]["id"] = "fastest"
            grouped[key]["label"] = "Fastest"

    path_records = list(grouped.values())
    evaluated, sample_info = _evaluate_paths(path_records, departure, include_agents=include_agents)
    thermal_result = evaluated["thermal"]
    thermal_status = thermal_result.get("status", "unavailable")
    traffic_status = {
        "status": "available_on_request",
        "source": "SUMO/HBEFA citywide road emissions preview",
        "note": "Run the separate NOx context analysis to list emissions for streets used by each route; this is not pedestrian concentration or dose.",
    }
    response = {
        "schema": "conditions-walking-routes/1",
        "departure_at": departure.isoformat(),
        "timezone": "Africa/Johannesburg",
        "walking_speed_kmh": WALK_SPEED_KMH,
        "origin": {"requested": {"x": origin[0], "z": origin[1]}, "snapped": {"x": source_point[0], "z": source_point[1]}, "snap_distance_m": round(source_snap, 1)},
        "destination": {"requested": {"x": destination[0], "z": destination[1]}, "snapped": {"x": target_point[0], "z": target_point[1]}, "snap_distance_m": round(target_snap, 1)},
        "network": {key: manifest.get(key) for key in (
            "source", "source_sha256", "built_at", "node_count", "edge_count", "attribution", "crs",
        )},
        "conditions": {
            "sun": {"status": "available", "source": "building and mapped tree-canopy shadow geometry", "resolution": f"5-minute expected-traversal-time bins; route exposure sampled every {SAMPLE_SPACING_M:g} m"},
            "thermal": {
                "status": thermal_status, "reason": thermal_result.get("reason"),
                "run_id": thermal_result.get("run_id"),
                "validation_status": thermal_result.get("validation_status"),
                "channel_coverage": thermal_result.get("channel_coverage"),
                "source": "hourly thermal forecast and 1.5 m pedestrian wind atlas; nearest complete frame within 30 minutes",
            },
            "traffic": traffic_status,
        },
        "route_generation": {
            "method": "Dijkstra over OSMnx-derived pedestrian graph; environmental edge costs use earliest walking arrival from the selected departure, with route exposure resampled at actual path traversal times",
            "environmental_summary_sampling_m": SAMPLE_SPACING_M,
            "thermal_route_available": has_thermal_route,
            "agent_count_per_route": AGENT_COUNT if include_agents else 0,
            "agent_status": "complete" if include_agents else "pending",
            "agent_speed_range_kmh": list(AGENT_SPEEDS_KMH),
            "agent_seed": AGENT_SEED,
            "sampled_agent_points": sample_info["sample_count"],
        },
        "routes": evaluated["routes"],
    }
    return (response, path_records, departure) if return_plan else response


def walking_agent_comparison(path_records: list[dict[str, Any]], departure: datetime) -> dict[str, Any]:
    """Evaluate matched walkers after the route geometry has been returned."""
    evaluated, sample_info = _evaluate_paths(path_records, departure, include_agents=True)
    return {
        "schema": "conditions-walking-agents/1",
        "sampled_agent_points": sample_info["sample_count"],
        "routes": [{
            "id": route["id"], "agents": route["agents"], "agent_summary": route["agent_summary"],
        } for route in evaluated["routes"]],
    }
