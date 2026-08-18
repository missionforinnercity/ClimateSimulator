"""Rain-on-grid surface-water simulation for the Cape Town CBD.

This is a local-inertial 2D shallow-water model.  It resolves wetting,
drying, momentum, bed slope and Manning friction on the LiDAR DTM.  Buildings
are impermeable cells.  Unknown stormwater drains and unverified OSM curbs are
deliberately omitted rather than assigned invented capacities or elevations.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import rasterize, shapes
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from scipy.ndimage import distance_transform_edt
from shapely.geometry import box, shape
from shapely.ops import transform as transform_geometry, unary_union

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LIDAR_PATH = PROJECT_ROOT / "data" / "raw" / "LiDAR2025" / "LiDAR2025_2m_DTM.tif"
DTM_PATH = PROJECT_ROOT / "data" / "derived" / "company_gardens_hybrid_dem_2m.tif"
BUILDINGS_PATH = PROJECT_ROOT / "data" / "derived" / "BuildingFootprintsHybrid.geojson"
ROADS_PATH = PROJECT_ROOT / "data" / "osm_cbd_roads.geojson"
GREEN_PATH = PROJECT_ROOT / "data" / "osm_cbd_green_areas.geojson"
TSM_PATH = PROJECT_ROOT / "Town_Survey_Marks_(TSM).csv"
LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
GRAVITY = 9.80665
WET_DEPTH_M = 1e-4
OUTPUT_WET_DEPTH_M = 0.01
VELOCITY_DEPTH_M = 0.01

# Half-widths used only to turn OSM road centrelines into a footprint polygon
# for the friction/infiltration classification below; mirrors the mapped
# widths scripts/build_scene.py uses to draw the same roads in the viewer.
ROAD_WIDTHS_M = {
    "motorway": 15.0, "trunk": 13.0, "primary": 11.0, "secondary": 9.0,
    "tertiary": 7.0, "residential": 5.5, "unclassified": 5.5,
    "living_street": 5.0, "service": 4.0, "pedestrian": 4.0,
    "cycleway": 2.5, "footway": 2.0, "path": 1.5,
}

# Manning's n and infiltration are single scalars chosen by the user in the
# UI. Roads are consistently smoother than any hand-picked "mixed urban"
# average and green areas consistently rougher and more absorbent, so these
# bound the user's value rather than overriding it outright: road cells never
# get rougher than pavement, green cells never get smoother than turf.
ROAD_MANNING_N = 0.016
GREEN_MANNING_N = 0.05
GREEN_INFILTRATION_MULTIPLIER = 2.5
GREEN_INFILTRATION_CAP_MM_H = 40.0


@dataclass(frozen=True)
class FloodRequest:
    center_x: float
    center_z: float
    width_m: float
    height_m: float
    resolution_m: float
    rainfall_mm_h: float
    duration_min: float
    infiltration_mm_h: float
    manning_n: float


def _fill_active_nearest(values: np.ndarray, active: np.ndarray) -> np.ndarray:
    if active.all() or not active.any():
        return values
    indices = distance_transform_edt(~active, return_distances=False, return_indices=True)
    return values[tuple(indices)]


@lru_cache(maxsize=1)
def _lidar_footprint() -> Any:
    with rasterio.open(DTM_PATH) as source:
        valid = source.read_masks(1) > 0
        polygons = [
            shape(geometry)
            for geometry, value in shapes(
                valid.astype("uint8"),
                mask=valid,
                transform=source.transform,
            )
            if value == 1
        ]
    return unary_union(polygons)


@lru_cache(maxsize=1)
def _building_geometries() -> tuple[Any, ...]:
    collection = json.loads(BUILDINGS_PATH.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:3857", LOCAL_CRS, always_xy=True)
    geometries = []
    for feature in collection.get("features", []):
        geometry = transform_geometry(
            lambda x, y, z=None: transformer.transform(x, y),
            shape(feature["geometry"]),
        )
        if not geometry.is_empty:
            geometries.append(geometry)
    return tuple(geometries)


@lru_cache(maxsize=1)
def _road_geometries() -> tuple[Any, ...]:
    """Road footprints (buffered centrelines) for the friction/infiltration map."""
    if not ROADS_PATH.exists():
        return ()
    collection = json.loads(ROADS_PATH.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    geometries = []
    for feature in collection.get("features", []):
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        if len(coordinates) < 2:
            continue
        highway = (feature.get("properties") or {}).get("highway", "residential")
        line = transform_geometry(
            lambda x, y, z=None: transformer.transform(x, y),
            shape(feature["geometry"]),
        )
        width = ROAD_WIDTHS_M.get(highway, 4.0)
        footprint = line.buffer(width / 2.0)
        if not footprint.is_empty:
            geometries.append(footprint)
    return tuple(geometries)


@lru_cache(maxsize=1)
def _green_geometries() -> tuple[Any, ...]:
    """Park/lawn/vegetated polygons for the friction/infiltration map."""
    if not GREEN_PATH.exists():
        return ()
    collection = json.loads(GREEN_PATH.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    geometries = []
    for feature in collection.get("features", []):
        geometry = transform_geometry(
            lambda x, y, z=None: transformer.transform(x, y),
            shape(feature["geometry"]),
        )
        if not geometry.is_empty:
            geometries.append(geometry)
    return tuple(geometries)


def _terrain_for_request(request: FloodRequest, buffer_m: float = 0.0) -> dict[str, Any]:
    """Resample the rectangular, user-drawn analysis area."""
    with rasterio.open(DTM_PATH) as source:
        origin_x = (source.bounds.left + source.bounds.right) / 2.0
        origin_y = (source.bounds.bottom + source.bounds.top) / 2.0

        half_width = request.width_m / 2.0 + buffer_m
        half_height = request.height_m / 2.0 + buffer_m
        west = max(source.bounds.left, origin_x + request.center_x - half_width)
        east = min(source.bounds.right, origin_x + request.center_x + half_width)
        north = min(source.bounds.top, origin_y - request.center_z + half_height)
        south = max(source.bounds.bottom, origin_y - request.center_z - half_height)
        if east <= west or north <= south:
            raise ValueError("flood analysis domain is outside available terrain coverage")

        width = max(2, int(math.ceil((east - west) / request.resolution_m)))
        height = max(2, int(math.ceil((north - south) / request.resolution_m)))
        dx = (east - west) / width
        dz = (north - south) / height
        transform = from_bounds(west, south, east, north, width, height)

        bed = np.full((height, width), np.nan, dtype=np.float32)
        reproject(
            source=rasterio.band(source, 1),
            destination=bed,
            src_transform=source.transform,
            src_crs=source.crs,
            src_nodata=source.nodata,
            dst_transform=transform,
            dst_crs=source.crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        terrain_source = np.zeros((height, width), dtype=np.float32)
        if source.count >= 2:
            reproject(
                source=rasterio.band(source, 2),
                destination=terrain_source,
                src_transform=source.transform,
                src_crs=source.crs,
                src_nodata=source.nodata,
                dst_transform=transform,
                dst_crs=source.crs,
                dst_nodata=0,
                resampling=Resampling.nearest,
            )
        else:
            terrain_source[np.isfinite(bed)] = 1

    terrain_active = np.isfinite(bed)
    if terrain_active.mean() < 0.05:
        raise ValueError("flood analysis domain has insufficient valid terrain coverage")
    bed = _fill_active_nearest(np.where(terrain_active, bed, 0.0), terrain_active).astype(np.float64)

    building_shapes = [
        (geometry, 1)
        for geometry in _building_geometries()
        if geometry.bounds[2] >= west
        and geometry.bounds[0] <= east
        and geometry.bounds[3] >= south
        and geometry.bounds[1] <= north
    ]
    buildings = rasterize(
        building_shapes,
        out_shape=(height, width),
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=False,
    ).astype(bool)
    buildings &= terrain_active
    active = terrain_active & ~buildings

    road_shapes = [
        (geometry, 1)
        for geometry in _road_geometries()
        if geometry.bounds[2] >= west
        and geometry.bounds[0] <= east
        and geometry.bounds[3] >= south
        and geometry.bounds[1] <= north
    ]
    roads_mask = rasterize(
        road_shapes,
        out_shape=(height, width),
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=False,
    ).astype(bool)
    roads_mask &= active

    green_shapes = [
        (geometry, 1)
        for geometry in _green_geometries()
        if geometry.bounds[2] >= west
        and geometry.bounds[0] <= east
        and geometry.bounds[3] >= south
        and geometry.bounds[1] <= north
    ]
    green_mask = rasterize(
        green_shapes,
        out_shape=(height, width),
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=False,
    ).astype(bool)
    green_mask &= active & ~roads_mask

    core_west = origin_x + request.center_x - request.width_m / 2.0
    core_east = origin_x + request.center_x + request.width_m / 2.0
    core_north = origin_y - request.center_z + request.height_m / 2.0
    core_south = origin_y - request.center_z - request.height_m / 2.0
    xs = west + (np.arange(width) + 0.5) * dx
    ys = north - (np.arange(height) + 0.5) * dz
    core_columns = np.where((xs >= core_west) & (xs <= core_east))[0]
    core_rows = np.where((ys >= core_south) & (ys <= core_north))[0]
    if not core_columns.size or not core_rows.size:
        raise ValueError("flood output domain does not intersect valid terrain")

    return {
        "bed": bed,
        "active": active,
        "terrain_active": terrain_active,
        "terrain_source": terrain_source.astype(np.uint8),
        "buildings": buildings,
        "roads_mask": roads_mask,
        "green_mask": green_mask,
        "dx": dx,
        "dz": dz,
        "west": west,
        "north": north,
        "origin_x": origin_x,
        "origin_y": origin_y,
        "row_slice": slice(int(core_rows[0]), int(core_rows[-1]) + 1),
        "column_slice": slice(int(core_columns[0]), int(core_columns[-1]) + 1),
    }


def _limit_outflow(
    qx: np.ndarray,
    qz: np.ndarray,
    depth: np.ndarray,
    active: np.ndarray,
    dt: float,
    dx: float,
    dz: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Scale each face flux by its donor cell's available water volume."""
    outgoing = (
        np.maximum(qx[:, 1:], 0.0) * dz
        + np.maximum(-qx[:, :-1], 0.0) * dz
        + np.maximum(qz[1:, :], 0.0) * dx
        + np.maximum(-qz[:-1, :], 0.0) * dx
    )
    available = depth * dx * dz
    factor = np.ones_like(depth)
    wet_out = outgoing > 0
    factor[wet_out] = np.minimum(1.0, available[wet_out] / (dt * outgoing[wet_out] + 1e-12))
    factor[~active] = 0.0

    interior_x = qx[:, 1:-1]
    qx[:, 1:-1] = interior_x * np.where(interior_x >= 0, factor[:, :-1], factor[:, 1:])
    interior_z = qz[1:-1, :]
    qz[1:-1, :] = interior_z * np.where(interior_z >= 0, factor[:-1, :], factor[1:, :])
    qx[:, 0] *= factor[:, 0]
    qx[:, -1] *= factor[:, -1]
    qz[0, :] *= factor[0, :]
    qz[-1, :] *= factor[-1, :]
    return qx, qz


def simulate_local_inertial(
    bed: np.ndarray,
    active: np.ndarray,
    *,
    dx: float,
    dz: float,
    rainfall_mm_h: float,
    duration_s: float,
    infiltration_mm_h: float,
    manning_n: float | np.ndarray,
    source_rate_mps: np.ndarray | None = None,
    rainfall_rate_mps: np.ndarray | None = None,
    infiltration_rate_mps: np.ndarray | None = None,
    closed_boundary: bool | dict[str, bool] = True,
    intensity_at: Callable[[float], float] | None = None,
    snapshot_count: int = 0,
) -> dict[str, np.ndarray | float | int]:
    """Solve rainfall-driven 2D local-inertial shallow-water flow.

    `manning_n` may be a scalar or a per-cell array (e.g. smoother roads,
    rougher vegetation); face friction uses the mean of the two neighbouring
    cells. `closed_boundary` may be a bool applied to all four domain edges
    or a dict with `"west"/"east"/"north"/"south"` bools for per-side control.
    `intensity_at(fraction)` optionally rescales rainfall over the course of
    the storm (`fraction` runs 0..1); its time-average must be 1 so the total
    rainfall volume is unchanged. When rainfall and infiltration grids are
    supplied, infiltration remains a capacity applied *after* the varying
    rainfall intensity and is limited by water available during that step.
    `source_rate_mps` remains a backwards-compatible net source for callers
    that have already performed their own routing.
    """
    bed = np.asarray(bed, dtype=np.float64)
    active = np.asarray(active, dtype=bool)
    if bed.shape != active.shape or bed.ndim != 2:
        raise ValueError("bed and active arrays must be matching 2D grids")
    if not active.any():
        raise ValueError("simulation grid has no active terrain cells")

    manning_field = np.asarray(manning_n, dtype=np.float64)
    if manning_field.ndim == 0:
        manning_field = np.full(bed.shape, float(manning_field))
    elif manning_field.shape != bed.shape:
        raise ValueError("manning_n array must match the simulation grid")
    manning_face_x = 0.5 * (manning_field[:, :-1] + manning_field[:, 1:])
    manning_face_z = 0.5 * (manning_field[:-1, :] + manning_field[1:, :])

    if isinstance(closed_boundary, dict):
        close_west = bool(closed_boundary.get("west", True))
        close_east = bool(closed_boundary.get("east", True))
        close_north = bool(closed_boundary.get("north", True))
        close_south = bool(closed_boundary.get("south", True))
    else:
        close_west = close_east = close_north = close_south = bool(closed_boundary)

    rows, columns = bed.shape
    depth = np.zeros_like(bed)
    max_depth = np.zeros_like(bed)
    max_speed = np.zeros_like(bed)
    arrival_s = np.full_like(bed, -1.0)
    qx = np.zeros((rows, columns + 1), dtype=np.float64)
    qz = np.zeros((rows + 1, columns), dtype=np.float64)
    rain_rate = rainfall_mm_h / 3_600_000.0
    infiltration_rate = infiltration_mm_h / 3_600_000.0
    if source_rate_mps is not None and rainfall_rate_mps is not None:
        raise ValueError("source_rate_mps and rainfall_rate_mps are mutually exclusive")
    rainfall_field = None
    infiltration_field = None
    if rainfall_rate_mps is not None:
        rainfall_field = np.asarray(rainfall_rate_mps, dtype=np.float64)
        if rainfall_field.shape != bed.shape:
            raise ValueError("rainfall_rate_mps must match the simulation grid")
        rainfall_field = np.where(active, np.maximum(rainfall_field, 0.0), 0.0)
        if infiltration_rate_mps is None:
            infiltration_field = np.full(bed.shape, infiltration_rate)
        else:
            infiltration_field = np.asarray(infiltration_rate_mps, dtype=np.float64)
            if infiltration_field.shape != bed.shape:
                raise ValueError("infiltration_rate_mps must match the simulation grid")
        infiltration_field = np.where(active, np.maximum(infiltration_field, 0.0), 0.0)
        source_rate = None
    elif source_rate_mps is not None:
        source_rate = np.asarray(source_rate_mps, dtype=np.float64)
        if source_rate.shape != bed.shape:
            raise ValueError("source_rate_mps must match the simulation grid")
        source_rate = np.where(active, np.maximum(source_rate, 0.0), 0.0)
    else:
        rainfall_field = np.where(active, rain_rate, 0.0)
        infiltration_field = np.where(active, infiltration_rate, 0.0)
        source_rate = None
    elapsed = 0.0
    steps = 0
    boundary_outflow_m3 = 0.0
    snapshots = [depth.copy()] if snapshot_count > 0 else []
    snapshot_times = [0.0] if snapshot_count > 0 else []
    snapshot_interval = duration_s / max(snapshot_count, 1)
    next_snapshot_s = snapshot_interval
    source_volume_m3 = 0.0
    cell_area_m2 = dx * dz

    while elapsed < duration_s - 1e-9:
        wet_max = float(np.max(depth[active]))
        wave_speed = math.sqrt(GRAVITY * max(wet_max, 0.001))
        dt = min(2.0, 0.45 * min(dx, dz) / wave_speed, duration_s - elapsed)
        intensity_multiplier = 1.0 if intensity_at is None else intensity_at(min(elapsed / duration_s, 1.0))
        if rainfall_field is not None:
            step_source_rate = np.maximum(rainfall_field * intensity_multiplier - infiltration_field, 0.0)
        else:
            step_source_rate = source_rate * intensity_multiplier
        source_depth = depth.copy()
        source_depth += step_source_rate * dt
        source_volume_m3 += float(step_source_rate.sum()) * dt * cell_area_m2
        surface = bed + source_depth

        left_active = active[:, :-1]
        right_active = active[:, 1:]
        face_active_x = left_active & right_active
        eta_left = surface[:, :-1]
        eta_right = surface[:, 1:]
        bed_face_x = np.maximum(bed[:, :-1], bed[:, 1:])
        face_depth_x = np.maximum(eta_left, eta_right) - bed_face_x
        face_depth_x = np.maximum(face_depth_x, 0.0)
        old_qx = qx[:, 1:-1]
        friction_x = 1.0 + (
            GRAVITY
            * manning_face_x**2
            * dt
            * np.abs(old_qx)
            / np.maximum(face_depth_x, WET_DEPTH_M) ** (7.0 / 3.0)
        )
        qx[:, 1:-1] = np.where(
            face_active_x & (face_depth_x > WET_DEPTH_M),
            (old_qx - GRAVITY * face_depth_x * dt * (eta_right - eta_left) / dx) / friction_x,
            0.0,
        )

        top_active = active[:-1, :]
        bottom_active = active[1:, :]
        face_active_z = top_active & bottom_active
        eta_top = surface[:-1, :]
        eta_bottom = surface[1:, :]
        bed_face_z = np.maximum(bed[:-1, :], bed[1:, :])
        face_depth_z = np.maximum(eta_top, eta_bottom) - bed_face_z
        face_depth_z = np.maximum(face_depth_z, 0.0)
        old_qz = qz[1:-1, :]
        friction_z = 1.0 + (
            GRAVITY
            * manning_face_z**2
            * dt
            * np.abs(old_qz)
            / np.maximum(face_depth_z, WET_DEPTH_M) ** (7.0 / 3.0)
        )
        qz[1:-1, :] = np.where(
            face_active_z & (face_depth_z > WET_DEPTH_M),
            (old_qz - GRAVITY * face_depth_z * dt * (eta_bottom - eta_top) / dz) / friction_z,
            0.0,
        )

        edge_speed = np.sqrt(GRAVITY * source_depth)
        qx[:, 0] = 0.0 if close_west else np.where(active[:, 0], -source_depth[:, 0] * edge_speed[:, 0], 0.0)
        qx[:, -1] = 0.0 if close_east else np.where(active[:, -1], source_depth[:, -1] * edge_speed[:, -1], 0.0)
        qz[0, :] = 0.0 if close_north else np.where(active[0, :], -source_depth[0, :] * edge_speed[0, :], 0.0)
        qz[-1, :] = 0.0 if close_south else np.where(active[-1, :], source_depth[-1, :] * edge_speed[-1, :], 0.0)
        qx, qz = _limit_outflow(qx, qz, source_depth, active, dt, dx, dz)
        boundary_outflow_m3 += dt * (
            float(np.sum(-qx[:, 0])) * dz
            + float(np.sum(qx[:, -1])) * dz
            + float(np.sum(-qz[0, :])) * dx
            + float(np.sum(qz[-1, :])) * dx
        )

        divergence = (
            (qx[:, 1:] - qx[:, :-1]) / dx
            + (qz[1:, :] - qz[:-1, :]) / dz
        )
        depth = np.maximum(0.0, source_depth - dt * divergence)
        depth[~active] = 0.0

        safe_depth = np.maximum(depth, WET_DEPTH_M)
        u = 0.5 * (qx[:, :-1] + qx[:, 1:]) / safe_depth
        v = 0.5 * (qz[:-1, :] + qz[1:, :]) / safe_depth
        speed = np.hypot(u, v)
        speed[depth < VELOCITY_DEPTH_M] = 0.0
        max_depth = np.maximum(max_depth, depth)
        max_speed = np.maximum(max_speed, speed)
        newly_arrived = (arrival_s < 0) & (depth >= 0.05)
        arrival_s[newly_arrived] = elapsed + dt
        elapsed += dt
        steps += 1
        while snapshot_count > 0 and elapsed + 1e-9 >= next_snapshot_s:
            snapshots.append(depth.copy())
            snapshot_times.append(min(elapsed, duration_s))
            next_snapshot_s += snapshot_interval

    safe_depth = np.maximum(depth, WET_DEPTH_M)
    u = 0.5 * (qx[:, :-1] + qx[:, 1:]) / safe_depth
    v = 0.5 * (qz[:-1, :] + qz[1:, :]) / safe_depth
    u[depth < VELOCITY_DEPTH_M] = 0.0
    v[depth < VELOCITY_DEPTH_M] = 0.0
    return {
        "depth": depth,
        "max_depth": max_depth,
        "max_speed": max_speed,
        "u": u,
        "v": v,
        "arrival_s": arrival_s,
        "elapsed_s": elapsed,
        "steps": steps,
        "boundary_outflow_m3": boundary_outflow_m3,
        "source_volume_m3": source_volume_m3,
        "snapshots": snapshots,
        "snapshot_times_s": snapshot_times,
    }


def boundary_closed_sides(bed: np.ndarray, active: np.ndarray, threshold_m: float = 0.05) -> dict[str, bool]:
    """Decide which of the drawn box's four edges should stay sealed.

    A user-drawn box carries no information about the catchment beyond its
    edge. Treating every edge as a sealed wall turns a downhill edge into an
    artificial bathtub lip that retains water which would, in reality, keep
    flowing off the edge of the box; treating every edge as open would leak
    water across a ridge that a closed box should legitimately retain. This
    compares the mean bed height of the outermost active cells against the
    row/column immediately inside: an edge is left open for outflow only
    where it is measurably lower than the interior next to it.
    """

    def is_downhill(outer_bed: np.ndarray, outer_active: np.ndarray, inner_bed: np.ndarray, inner_active: np.ndarray) -> bool:
        mask = outer_active & inner_active
        if not mask.any():
            return False
        return float(np.mean(outer_bed[mask]) - np.mean(inner_bed[mask])) < -threshold_m

    return {
        "west": not is_downhill(bed[:, 0], active[:, 0], bed[:, 1], active[:, 1]),
        "east": not is_downhill(bed[:, -1], active[:, -1], bed[:, -2], active[:, -2]),
        "north": not is_downhill(bed[0, :], active[0, :], bed[1, :], active[1, :]),
        "south": not is_downhill(bed[-1, :], active[-1, :], bed[-2, :], active[-2, :]),
    }


def triangular_hyetograph(peak_fraction: float = 0.4) -> Callable[[float], float]:
    """A simple mass-conserving triangular design-storm intensity multiplier.

    No calibrated local IDF/hyetograph curve exists for this project, so
    rather than invent a distribution shape, this is the simplest standard
    proxy for "storms are front- or mid-loaded, not constant": intensity
    ramps linearly up to a peak at `peak_fraction` of the storm duration and
    back down to zero. A triangle of base 1 has area `peak_multiplier / 2`,
    so fixing `peak_multiplier = 2` keeps the average multiplier at exactly
    1 regardless of `peak_fraction`, which is what keeps total rainfall
    volume identical to the constant-intensity case.
    """
    peak_fraction = min(max(peak_fraction, 1e-3), 1 - 1e-3)
    peak_multiplier = 2.0

    def intensity_at(fraction: float) -> float:
        fraction = min(max(fraction, 0.0), 1.0)
        if fraction <= peak_fraction:
            return peak_multiplier * fraction / peak_fraction
        return peak_multiplier * (1.0 - fraction) / (1.0 - peak_fraction)

    return intensity_at


@lru_cache(maxsize=1)
def dem_control_summary() -> dict[str, Any]:
    """Compare valid local survey-mark elevations with the DTM without editing it."""
    if not TSM_PATH.exists():
        return {"available": False, "usable_marks": 0}
    residuals = []
    with rasterio.open(LIDAR_PATH) as source, TSM_PATH.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            try:
                x = float(row["Y_WGS_84"])
                y = float(row["X_WGS_84"])
                height = float(row["HGHT"])
            except (KeyError, TypeError, ValueError):
                continue
            if height == 0 or not (
                source.bounds.left <= x <= source.bounds.right
                and source.bounds.bottom <= y <= source.bounds.top
            ):
                continue
            sampled = next(source.sample([(x, y)], masked=True))[0]
            if np.ma.is_masked(sampled) or not math.isfinite(float(sampled)):
                continue
            residuals.append(float(sampled) - height)
    if not residuals:
        return {"available": True, "usable_marks": 0}
    values = np.asarray(residuals)
    return {
        "available": True,
        "usable_marks": len(residuals),
        "dtm_minus_mark_median_m": round(float(np.median(values)), 3),
        "dtm_minus_mark_mean_m": round(float(values.mean()), 3),
        "rmse_m": round(float(np.sqrt(np.mean(values**2))), 3),
        "correction_applied": False,
        "note": "Vertical reference compatibility is not confirmed; marks are QA evidence only.",
    }


def flood_preview(payload: dict[str, Any]) -> dict[str, Any]:
    bounds = payload.get("bounds_local")
    if bounds is not None:
        if len(bounds) != 4:
            raise ValueError("bounds_local must contain [min_x, min_z, max_x, max_z]")
        min_x, min_z, max_x, max_z = map(float, bounds)
        width_m = max_x - min_x
        height_m = max_z - min_z
        if width_m < 100 or height_m < 100:
            raise ValueError("drawn flood box must be at least 100 m wide and high")
        if width_m > 1200 or height_m > 1200:
            raise ValueError("drawn flood box cannot exceed 1200 m in either direction")
        center_x = (min_x + max_x) / 2.0
        center_z = (min_z + max_z) / 2.0
    else:
        size_m = float(payload.get("size_m", 400.0))
        center_x = float(payload.get("center_local", [0, 0])[0])
        center_z = float(payload.get("center_local", [0, 0])[1])
        width_m = size_m
        height_m = size_m
    request = FloodRequest(
        center_x=center_x,
        center_z=center_z,
        width_m=width_m,
        height_m=height_m,
        resolution_m=float(payload.get("resolution_m", 4.0)),
        rainfall_mm_h=float(payload.get("rainfall_mm_h", 50.0)),
        duration_min=float(payload.get("duration_min", 60.0)),
        infiltration_mm_h=float(payload.get("infiltration_mm_h", 5.0)),
        manning_n=float(payload.get("manning_n", 0.04)),
    )
    with rasterio.open(DTM_PATH) as source:
        origin_x = (source.bounds.left + source.bounds.right) / 2.0
        origin_y = (source.bounds.bottom + source.bounds.top) / 2.0
    domain = box(
        origin_x + request.center_x - request.width_m / 2.0,
        origin_y - request.center_z - request.height_m / 2.0,
        origin_x + request.center_x + request.width_m / 2.0,
        origin_y - request.center_z + request.height_m / 2.0,
    )
    if not _lidar_footprint().covers(domain):
        raise ValueError(
            "drawn flood box crosses outside the available terrain footprint; "
            "draw it entirely on visible terrain"
        )
    terrain = _terrain_for_request(request)
    rain_rate = request.rainfall_mm_h / 3_600_000.0

    # Roads are consistently impervious pavement; green areas are consistently
    # more absorbent than a hand-picked domain-wide average. Both only ever
    # push infiltration in their physically expected direction relative to
    # the user's own chosen value, never override it outright.
    infiltration_field_mm_h = np.full(terrain["bed"].shape, request.infiltration_mm_h, dtype=np.float64)
    infiltration_field_mm_h[terrain["roads_mask"]] = 0.0
    green_infiltration_mm_h = min(request.infiltration_mm_h * GREEN_INFILTRATION_MULTIPLIER, GREEN_INFILTRATION_CAP_MM_H)
    infiltration_field_mm_h[terrain["green_mask"]] = max(request.infiltration_mm_h, green_infiltration_mm_h)
    infiltration_field_rate = infiltration_field_mm_h / 3_600_000.0
    rainfall_field_rate = np.where(terrain["active"], rain_rate, 0.0)
    roof_cells = terrain["buildings"] & terrain["terrain_active"]
    if roof_cells.any():
        nearest_active = distance_transform_edt(
            ~terrain["active"],
            return_distances=False,
            return_indices=True,
        )
        destination_rows = nearest_active[0][roof_cells]
        destination_columns = nearest_active[1][roof_cells]
        np.add.at(rainfall_field_rate, (destination_rows, destination_columns), rain_rate)

    manning_field = np.full(terrain["bed"].shape, request.manning_n, dtype=np.float64)
    manning_field[terrain["roads_mask"]] = min(request.manning_n, ROAD_MANNING_N)
    manning_field[terrain["green_mask"]] = max(request.manning_n, GREEN_MANNING_N)

    closed_sides = boundary_closed_sides(terrain["bed"], terrain["active"])
    intensity_at = triangular_hyetograph()

    result = simulate_local_inertial(
        terrain["bed"],
        terrain["active"],
        dx=terrain["dx"],
        dz=terrain["dz"],
        rainfall_mm_h=request.rainfall_mm_h,
        duration_s=request.duration_min * 60.0,
        infiltration_mm_h=request.infiltration_mm_h,
        manning_n=manning_field,
        rainfall_rate_mps=rainfall_field_rate,
        infiltration_rate_mps=infiltration_field_rate,
        closed_boundary=closed_sides,
        intensity_at=intensity_at,
        snapshot_count=20,
    )

    rows = terrain["row_slice"]
    columns = terrain["column_slice"]
    active = terrain["active"][rows, columns]
    buildings = terrain["buildings"][rows, columns]
    roads_mask = terrain["roads_mask"][rows, columns]
    green_mask = terrain["green_mask"][rows, columns]
    terrain_source = terrain["terrain_source"][rows, columns]
    bed = terrain["bed"][rows, columns]
    depth = result["depth"][rows, columns]
    max_depth = result["max_depth"][rows, columns]
    max_speed = result["max_speed"][rows, columns]
    u = result["u"][rows, columns]
    v = result["v"][rows, columns]
    arrival = result["arrival_s"][rows, columns]
    snapshots = [snapshot[rows, columns] for snapshot in result["snapshots"]]

    valid_depths = max_depth[active]
    wet = active & (max_depth >= OUTPUT_WET_DEPTH_M)
    wet_area = float(wet.sum() * terrain["dx"] * terrain["dz"])
    cell_area = terrain["dx"] * terrain["dz"]
    source_volume = float(result["source_volume_m3"])
    final_volume = float(result["depth"].sum() * cell_area)
    outflow_volume = float(result.get("boundary_outflow_m3", 0.0))
    accounted_volume = final_volume + outflow_volume
    mass_balance_error_pct = (
        abs(accounted_volume - source_volume) / source_volume * 100.0
        if source_volume > 0 else 0.0
    )
    open_sides = sorted(side for side, closed in closed_sides.items() if not closed)
    output_west = terrain["west"] + columns.start * terrain["dx"]
    output_north = terrain["north"] - rows.start * terrain["dz"]
    origin_local_x = output_west - terrain["origin_x"]
    origin_local_z = terrain["origin_y"] - output_north

    def compact(values: np.ndarray, digits: int) -> list[float]:
        rounded = np.round(values, digits)
        rounded[~active] = 0
        return rounded.astype(float).ravel().tolist()

    return {
        "model": {
            "kind": "local_inertial_2d_shallow_water",
            "scope": "rainfall_accumulation_within_the_drawn_box_not_general_flood_depth_for_the_place_no_upstream_inflow_from_outside_the_box_is_represented",
            "validation_status": "uncalibrated_surface_water_scenario",
            "drainage": "not_modelled_unknown",
            "curbs": "not_modelled_unverified",
            "buildings": "impermeable_cells_roof_rain_routed_to_nearest_open_cell",
            "surface_roughness": "land_cover_varying_manning_n_osm_roads_and_green_areas_else_user_value",
            "infiltration": "land_cover_varying_roads_impervious_green_areas_enhanced_else_user_value",
            "rainfall_pattern": "triangular_design_hyetograph_peak_at_40pct_duration_mass_conserving",
            "boundary": (
                f"closed_except_downhill_edges_open_for_unidirectional_outflow ({', '.join(open_sides)})"
                if open_sides else "closed_user_drawn_box_no_surface_outflow"
            ),
            "boundary_open_sides": open_sides,
            "terrain": "2025_2m_lidar_plus_calibrated_30m_srtm_company_gardens",
            "dem_control": dem_control_summary(),
        },
        "forcing": {
            "rainfall_mm_h": request.rainfall_mm_h,
            "duration_min": request.duration_min,
            "infiltration_mm_h": request.infiltration_mm_h,
            "manning_n": request.manning_n,
        },
        "origin": [round(origin_local_x, 3), round(origin_local_z, 3)],
        "width": int(active.shape[1]),
        "height": int(active.shape[0]),
        "dx": round(float(terrain["dx"]), 4),
        "dz": round(float(terrain["dz"]), 4),
        "bed": compact(bed, 3),
        "active": active.astype(np.uint8).ravel().tolist(),
        "buildings": buildings.astype(np.uint8).ravel().tolist(),
        "terrain_source": terrain_source.ravel().tolist(),
        "depth": compact(depth, 4),
        "max_depth": compact(max_depth, 4),
        "max_speed": compact(max_speed, 3),
        "u": compact(u, 3),
        "v": compact(v, 3),
        "arrival_min": compact(np.where(arrival >= 0, arrival / 60.0, -1.0), 2),
        "frames": [compact(snapshot, 4) for snapshot in snapshots],
        "frame_times_min": [round(value / 60.0, 2) for value in result["snapshot_times_s"]],
        "summary": {
            "wet_area_m2": round(wet_area, 1),
            "max_depth_m": round(float(valid_depths.max(initial=0.0)), 3),
            "p95_depth_m": round(float(np.percentile(valid_depths, 95)) if valid_depths.size else 0.0, 3),
            "max_speed_mps": round(float(max_speed[active].max(initial=0.0)), 3),
            "valid_terrain_pct": round(float(active.mean() * 100.0), 1),
            "building_cells": int(buildings.sum()),
            "surface_cells": {
                "roads": int(roads_mask.sum()),
                "green_areas": int(green_mask.sum()),
                "other": int((active & ~roads_mask & ~green_mask).sum()),
            },
            "coarse_terrain_pct": round(
                float(((terrain_source == 2) & terrain["terrain_active"][rows, columns]).sum())
                / max(float(terrain["terrain_active"][rows, columns].sum()), 1.0)
                * 100.0,
                1,
            ),
            "roof_runoff": "conserved_to_nearest_open_cell",
            "solver_steps": int(result["steps"]),
            "retained_water_m3": round(final_volume, 2),
            "drained_water_m3": round(outflow_volume, 2),
            "mass_balance_error_pct": round(mass_balance_error_pct, 4),
        },
    }
