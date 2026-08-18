"""Planning-grade cumulative direct sunlight on 3D building surfaces."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import functools
import json
import math
from pathlib import Path
import threading
from typing import Any

from shapely import get_coordinates
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree

from .solar import sun_position


SCENE_PATH = Path(__file__).resolve().parents[1] / "public" / "assets" / "fallback.json"
CANOPY_PATH = Path(__file__).resolve().parents[1] / "public" / "assets" / "canopy.json"
MAX_ANALYSIS_CELLS = 60_000
_CANCELLED_ANALYSES: set[str] = set()
_CANCEL_LOCK = threading.Lock()


class SunlightAnalysisCancelled(RuntimeError):
    """Raised cooperatively when a moved/resized browser study is obsolete."""


def cancel_sunlight_analysis(analysis_id: str) -> None:
    if not analysis_id:
        return
    with _CANCEL_LOCK:
        _CANCELLED_ANALYSES.add(analysis_id)


def finish_sunlight_analysis(analysis_id: str | None) -> None:
    if not analysis_id:
        return
    with _CANCEL_LOCK:
        _CANCELLED_ANALYSES.discard(analysis_id)


def _analysis_cancelled(analysis_id: str | None) -> bool:
    if not analysis_id:
        return False
    with _CANCEL_LOCK:
        return analysis_id in _CANCELLED_ANALYSES


def _polygon_parts(geometry: Any) -> tuple[Any, ...]:
    if geometry.is_empty:
        return ()
    if geometry.geom_type == "Polygon":
        return (geometry,)
    if geometry.geom_type == "MultiPolygon":
        return tuple(geometry.geoms)
    return tuple(part for part in getattr(geometry, "geoms", ()) if part.geom_type == "Polygon")


@functools.lru_cache(maxsize=1)
def _scene_geometry() -> dict[str, Any]:
    scene = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
    buildings = []
    for index, record in enumerate(scene.get("buildings", [])):
        if len(record) < 3 or len(record[2]) < 3:
            continue
        ground, height, ring = float(record[0]), float(record[1]), record[2]
        wall_height = float(record[5]) if len(record) > 5 else height
        holes = record[13] if len(record) > 13 and isinstance(record[13], list) else []
        footprint = Polygon(ring, holes)
        if not footprint.is_valid or footprint.is_empty:
            continue
        buildings.append({
            "id": index, "footprint": footprint, "ring": ring, "rings": [ring, *holes],
            "ground": ground, "top": ground + max(height, wall_height),
        })

    canopies = []
    if CANOPY_PATH.exists():
        source = json.loads(CANOPY_PATH.read_text(encoding="utf-8"))
        for index, record in enumerate(source.get("canopies", [])):
            if len(record) < 6 or not record[5] or len(record[5][0]) < 3:
                continue
            _, ground, crown_base, crown_top, _, rings = record
            footprint = Polygon(rings[0], rings[1:])
            if footprint.is_valid and not footprint.is_empty:
                canopies.append({
                    "id": len(buildings) + index, "footprint": footprint,
                    "ground": float(crown_base), "top": float(crown_top),
                })

    blockers = buildings + canopies
    footprints = [item["footprint"] for item in blockers]
    bounds = unary_union([item["footprint"] for item in buildings]).bounds
    return {
        "buildings": buildings, "blockers": blockers,
        "tree": STRtree(footprints), "bounds": bounds,
        "max_top": max((item["top"] for item in blockers), default=0.0),
    }


def _visible_roofs(buildings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(buildings, key=lambda item: item["top"], reverse=True)
    tree = STRtree([item["footprint"] for item in ordered])
    roofs = []
    for index, building in enumerate(ordered):
        higher = [ordered[int(candidate)]["footprint"] for candidate in tree.query(building["footprint"]) if int(candidate) < index]
        visible = building["footprint"].difference(unary_union(higher)) if higher else building["footprint"]
        for part in _polygon_parts(visible):
            if part.area >= 0.25:
                roofs.append({**building, "footprint": part})
    return roofs


def _roof_cells(
    buildings: list[dict[str, Any]], resolution: float, domain: Any | None = None,
) -> list[dict[str, Any]]:
    cells = []
    for building in _visible_roofs(buildings):
        if domain is not None and not building["footprint"].intersects(domain):
            continue
        footprint = building["footprint"].intersection(domain) if domain is not None else building["footprint"]
        if footprint.is_empty:
            continue
        min_x, min_z, max_x, max_z = footprint.bounds
        first_x = math.floor(min_x / resolution) * resolution
        first_z = math.floor(min_z / resolution) * resolution
        x = first_x
        while x < max_x:
            z = first_z
            while z < max_z:
                clipped = footprint.intersection(box(x, z, x + resolution, z + resolution))
                for part in _polygon_parts(clipped):
                    if part.area < 0.25:
                        continue
                    point = part.representative_point()
                    cells.append({
                        "surface": "roof", "source_id": building["id"],
                        "sample": (point.x, building["top"] + 0.12, point.y),
                        "normal": (0.0, 1.0, 0.0), "area_m2": part.area,
                        "geometry": mapping(part), "surface_y": round(building["top"] + 0.1, 2),
                    })
                z += resolution
            x += resolution
    return cells


def _facade_cells(
    buildings: list[dict[str, Any]], resolution: float, domain: Any | None = None,
) -> list[dict[str, Any]]:
    cells = []
    for building in buildings:
        height = building["top"] - building["ground"]
        edge_offset = 0
        for ring in building.get("rings", [building["ring"]]):
            for ring_edge_index in range(len(ring)):
                edge_index = edge_offset + ring_edge_index
                raw_edge = LineString([ring[ring_edge_index], ring[(ring_edge_index + 1) % len(ring)]])
                if domain is None:
                    edge_parts = (raw_edge,)
                else:
                    clipped_edge = raw_edge.intersection(domain)
                    edge_parts = tuple(
                        part for part in getattr(clipped_edge, "geoms", (clipped_edge,))
                        if part.geom_type == "LineString" and part.length >= 0.1
                    )
                for edge_part in edge_parts:
                    coordinates = list(edge_part.coords)
                    x1, z1 = coordinates[0]
                    x2, z2 = coordinates[-1]
                    dx, dz = x2 - x1, z2 - z1
                    length = math.hypot(dx, dz)
                    if length < 0.1 or height < 0.5:
                        continue
                    nx, nz = -dz / length, dx / length
                    midpoint_x, midpoint_z = (x1 + x2) / 2, (z1 + z2) / 2
                    # The facade normal points out of the solid footprint. This
                    # also handles inner rings, where "out" points into the open
                    # courtyard rather than away from the building centroid.
                    if building["footprint"].covers(Point(midpoint_x + nx * 0.08, midpoint_z + nz * 0.08)):
                        nx, nz = -nx, -nz
                    # Generate cells for every wall carried by the rendered city
                    # model. Occlusion is handled by the 3D ray test.
                    visible_ground = building["ground"]
                    visible_height = height
                    horizontal_steps = max(1, math.ceil(length / resolution))
                    vertical_steps = max(1, math.ceil(visible_height / resolution))
                    for column in range(horizontal_steps):
                        a0, a1 = column / horizontal_steps, (column + 1) / horizontal_steps
                        ax, az = x1 + dx * a0, z1 + dz * a0
                        bx, bz = x1 + dx * a1, z1 + dz * a1
                        for row in range(vertical_steps):
                            y0 = visible_ground + visible_height * row / vertical_steps
                            y1 = visible_ground + visible_height * (row + 1) / vertical_steps
                            sample_x = (ax + bx) / 2 + nx * 0.12
                            sample_z = (az + bz) / 2 + nz * 0.12
                            cells.append({
                                "surface": "facade", "source_id": building["id"],
                                "edge_index": edge_index,
                                "sample": (sample_x, (y0 + y1) / 2, sample_z),
                                "normal": (nx, 0.0, nz),
                                "area_m2": math.hypot(bx - ax, bz - az) * (y1 - y0),
                                "vertices": [
                                    [ax + nx * 0.08, y0, az + nz * 0.08],
                                    [bx + nx * 0.08, y0, bz + nz * 0.08],
                                    [bx + nx * 0.08, y1, bz + nz * 0.08],
                                    [ax + nx * 0.08, y1, az + nz * 0.08],
                                ],
                            })
            edge_offset += len(ring)
    return cells


@functools.lru_cache(maxsize=24)
def _analysis_cells(
    resolution_m: float, surfaces: str, domain_bounds: tuple[float, float, float, float] | None = None,
) -> tuple[dict[str, Any], ...]:
    buildings = _scene_geometry()["buildings"]
    domain = box(*domain_bounds) if domain_bounds is not None else None
    cells = []
    if surfaces in {"all", "roofs"}:
        cells.extend(_roof_cells(buildings, resolution_m, domain))
    if surfaces in {"all", "facades"}:
        cells.extend(_facade_cells(buildings, resolution_m, domain))
    return tuple(cells)


def _intersection_distance(line: Any, geometry: Any, origin_x: float, origin_z: float, ux: float, uz: float) -> float | None:
    intersection = line.intersection(geometry)
    if intersection.is_empty:
        return None
    coordinates = get_coordinates(intersection)
    distances = [(float(x) - origin_x) * ux + (float(z) - origin_z) * uz for x, z in coordinates]
    positive = [distance for distance in distances if distance > 0.05]
    return min(positive) if positive else None


def _ray_box_interval(
    x: float, z: float, ux: float, uz: float,
    bounds: tuple[float, float, float, float], max_distance: float,
) -> tuple[float, float] | None:
    """Cheap exact ray/AABB filter before a costly polygon intersection."""
    minimum, maximum = 0.05, max_distance
    for origin, direction, lower, upper in (
        (x, ux, bounds[0], bounds[2]), (z, uz, bounds[1], bounds[3]),
    ):
        if abs(direction) < 1e-12:
            if origin < lower or origin > upper:
                return None
            continue
        first = (lower - origin) / direction
        second = (upper - origin) / direction
        minimum = max(minimum, min(first, second))
        maximum = min(maximum, max(first, second))
        if maximum < minimum:
            return None
    return minimum, maximum


def _sun_hours_for_cells(
    cells: list[dict[str, Any]], sun_states: list[tuple[float, float, float, float]],
    analysis_id: str | None = None,
) -> list[float]:
    scene = _scene_geometry()
    blockers = scene["blockers"]
    diagonal = math.hypot(scene["bounds"][2] - scene["bounds"][0], scene["bounds"][3] - scene["bounds"][1])
    minimum_ground = min((item["ground"] for item in blockers), default=0.0)
    if cells:
        sample_x = [cell["sample"][0] for cell in cells]
        sample_z = [cell["sample"][2] for cell in cells]
        analysis_bounds = (min(sample_x) - 1.0, min(sample_z) - 1.0, max(sample_x) + 1.0, max(sample_z) + 1.0)
    else:
        analysis_bounds = scene["bounds"]
    indexed_states = []
    for altitude, sun_x, sun_z, duration_hours in sun_states:
        horizontal = math.hypot(sun_x, sun_z)
        ux, uz = sun_x / horizontal, sun_z / horizontal
        shadows = []
        state_blockers = []
        for blocker in blockers:
            distance = min(diagonal, max(0.0, (blocker["top"] - minimum_ground) / max(math.tan(altitude), 0.01)))
            min_x, min_z, max_x, max_z = blocker["footprint"].bounds
            shift_x, shift_z = -ux * distance, -uz * distance
            swept_bounds = (
                min_x + min(0.0, shift_x), min_z + min(0.0, shift_z),
                max_x + max(0.0, shift_x), max_z + max(0.0, shift_z),
            )
            if (swept_bounds[2] < analysis_bounds[0] or swept_bounds[0] > analysis_bounds[2]
                    or swept_bounds[3] < analysis_bounds[1] or swept_bounds[1] > analysis_bounds[3]):
                continue
            # This geometry is only a conservative STRtree prefilter. The
            # actual occlusion decision below is an exact 3D ray intersection
            # against the concave, hole-aware footprint, so a swept bounding
            # box is both faster and guaranteed not to create false negatives.
            shadows.append(box(*swept_bounds))
            state_blockers.append(blocker)
        blocker_bounds = [blocker["footprint"].bounds for blocker in state_blockers]
        indexed_states.append((altitude, ux, uz, duration_hours, state_blockers, blocker_bounds, shadows, STRtree(shadows)))

    def analyse_chunk(chunk: list[dict[str, Any]]) -> list[float]:
        totals = []
        for cell_index, cell in enumerate(chunk):
            if cell_index % 16 == 0 and _analysis_cancelled(analysis_id):
                raise SunlightAnalysisCancelled("sunlight analysis cancelled")
            x, y, z = cell["sample"]
            nx, ny, nz = cell["normal"]
            total = 0.0
            sample_point = Point(x, z)
            for altitude, ux, uz, duration_hours, state_blockers, blocker_bounds, shadows, shadow_tree in indexed_states:
                horizontal_cosine = math.cos(altitude)
                if nx * ux * horizontal_cosine + ny * math.sin(altitude) + nz * uz * horizontal_cosine <= 1e-8:
                    continue
                candidates = shadow_tree.query(sample_point)
                if not len(candidates):
                    total += duration_hours
                    continue
                max_distance = min(diagonal, max(1.0, (scene["max_top"] - y + 1.0) / max(math.tan(altitude), 0.01)))
                line = LineString([(x + ux * 0.08, z + uz * 0.08), (x + ux * max_distance, z + uz * max_distance)])
                blocked = False
                tangent = math.tan(altitude)
                plausible = []
                for candidate in candidates:
                    blocker = state_blockers[int(candidate)]
                    if blocker["id"] == cell["source_id"]:
                        continue
                    if not shadows[int(candidate)].covers(sample_point):
                        continue
                    interval = _ray_box_interval(x, z, ux, uz, blocker_bounds[int(candidate)], max_distance)
                    if interval is None:
                        continue
                    # The solar ray only rises. If it is already above the
                    # blocker on entry, or still below it on exit, the exact
                    # footprint intersection cannot possibly cast shade.
                    if y + interval[0] * tangent > blocker["top"] + 0.05:
                        continue
                    if y + interval[1] * tangent < blocker["ground"] - 0.05:
                        continue
                    plausible.append((interval[0], int(candidate)))
                for _, candidate in sorted(plausible):
                    blocker = state_blockers[candidate]
                    distance = _intersection_distance(line, blocker["footprint"], x, z, ux, uz)
                    if distance is None:
                        continue
                    ray_y = y + distance * tangent
                    if blocker["ground"] - 0.05 <= ray_y <= blocker["top"] + 0.05:
                        blocked = True
                        break
                if not blocked:
                    total += duration_hours
            totals.append(round(total, 3))
        return totals

    workers = min(8, max(1, math.ceil(len(cells) / 1500)))
    chunk_size = max(1, math.ceil(len(cells) / workers))
    chunks = [cells[index:index + chunk_size] for index in range(0, len(cells), chunk_size)]
    with ThreadPoolExecutor(max_workers=workers) as executor:
        return [value for chunk in executor.map(analyse_chunk, chunks) for value in chunk]


def _display_values(cells: list[dict[str, Any]], values: list[float], resolution: float) -> list[float]:
    """Lightly blend neighbouring roof samples for display without altering statistics."""
    buckets: dict[tuple[int, int, int], list[int]] = {}
    for index, cell in enumerate(cells):
        if cell["surface"] != "roof":
            continue
        x, _, z = cell["sample"]
        key = (cell["source_id"], math.floor(x / resolution), math.floor(z / resolution))
        buckets.setdefault(key, []).append(index)
    displayed = list(values)
    for index, cell in enumerate(cells):
        if cell["surface"] != "roof":
            continue
        x, _, z = cell["sample"]
        column, row = math.floor(x / resolution), math.floor(z / resolution)
        nearby = []
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for candidate in buckets.get((cell["source_id"], column + dx, row + dz), ()):
                    cx, _, cz = cells[candidate]["sample"]
                    if math.hypot(cx - x, cz - z) <= resolution * 1.6:
                        nearby.append(values[candidate])
        if nearby:
            displayed[index] = round(values[index] * 0.55 + sum(nearby) / len(nearby) * 0.45, 3)
    return displayed


@functools.lru_cache(maxsize=24)
def building_surface_sunlight(
    date_text: str = "2026-01-15", start_minutes: int = 480, end_minutes: int = 1080,
    step_minutes: int = 60, resolution_m: float = 10.0, surfaces: str = "all",
    min_x: float | None = None, min_z: float | None = None,
    max_x: float | None = None, max_z: float | None = None,
    analysis_id: str | None = None,
) -> dict[str, Any]:
    if not 0 <= start_minutes < end_minutes <= 1440:
        raise ValueError("sunlight window must satisfy 0 <= start < end <= 1440")
    if not 10 <= step_minutes <= 120:
        raise ValueError("sunlight time step must be between 10 and 120 minutes")
    if resolution_m not in {5.0, 10.0, 20.0}:
        raise ValueError("building-surface resolution must be 5, 10, or 20 metres")
    if surfaces not in {"all", "roofs", "facades"}:
        raise ValueError("surfaces must be all, roofs, or facades")

    domain_values = (min_x, min_z, max_x, max_z)
    if any(value is not None for value in domain_values):
        if not all(value is not None and math.isfinite(value) for value in domain_values):
            raise ValueError("sunlight domain requires finite min_x, min_z, max_x, and max_z")
        if min_x >= max_x or min_z >= max_z:
            raise ValueError("sunlight domain bounds must have positive width and height")
        scene_bounds = box(*_scene_geometry()["bounds"])
        clipped_domain = box(min_x, min_z, max_x, max_z).intersection(scene_bounds)
        if clipped_domain.is_empty:
            raise ValueError("sunlight domain is outside the mapped scene")
        domain_bounds = tuple(round(value, 3) for value in clipped_domain.bounds)
    else:
        domain_bounds = None

    cells = list(_analysis_cells(resolution_m, surfaces, domain_bounds))
    if len(cells) > MAX_ANALYSIS_CELLS:
        raise ValueError(f"analysis creates {len(cells):,} cells; use a coarser building-surface resolution")

    sun_states = []
    for start in range(start_minutes, end_minutes, step_minutes):
        duration = min(step_minutes, end_minutes - start)
        altitude, sun_x, sun_z = sun_position(date_text, start + duration // 2)
        if altitude > 0.008:
            sun_states.append((altitude, sun_x, sun_z, duration / 60.0))
    if _analysis_cancelled(analysis_id):
        raise SunlightAnalysisCancelled("sunlight analysis cancelled")
    values = _sun_hours_for_cells(cells, sun_states, analysis_id)
    display_values = _display_values(cells, values, resolution_m)
    features = []
    for cell, value, display_value in zip(cells, values, display_values):
        feature = {key: cell[key] for key in ("surface", "area_m2", "source_id")}
        feature.update({"value": value, "display_value": display_value})
        if cell["surface"] == "roof":
            feature.update({"geometry": cell["geometry"], "surface_y": cell["surface_y"]})
        else:
            feature.update({"edge_index": cell["edge_index"], "vertices": cell["vertices"]})
        features.append(feature)
    total_area = sum(cell["area_m2"] for cell in cells)
    weighted = sum(value * cell["area_m2"] for cell, value in zip(cells, values))
    return {
        "version": "building-sun-hours-3d-2026-v2", "metric": "cumulative_sun_hours",
        "mode": "building_surfaces_3d", "features": features, "count": len(features),
        "range": {"min": min(values, default=0.0), "max": max(values, default=0.0)},
        "color_range": {"min": 0.0, "max": (end_minutes - start_minutes) / 60.0},
        "summary": {"area_weighted_mean": weighted / total_area if total_area else None, "total_area_m2": total_area},
        "scenario": {"date": date_text, "start_minutes": start_minutes, "end_minutes": end_minutes,
                     "step_minutes": step_minutes, "sample_count": len(sun_states), "resolution_m": resolution_m,
                     "surfaces": surfaces, "domain_bounds": domain_bounds},
        "methodology": {
            "method": "Binary clear-sky 3D rays from roof and facade cells toward each sampled sun position",
            "blockers": "Mapped building prisms and opaque tree-canopy volumes",
            "display": "Roof colours use a light nearest-cell blend; summaries retain unblended ray results",
            "limitations": "CPU planning approximation: detailed roof slopes and terrain are not ray-tested; no diffuse or reflected light",
        },
    }
