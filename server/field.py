"""Wind-field extraction and deterministic proxy-field generation.

The current database contains directional scalar speed-factor polygons.  This
module turns those factors into a small regular grid with ``u`` and ``v``
components for the browser.  It is deliberately labelled a proxy: the current
source data does not contain locally deflected vector directions.
"""

from __future__ import annotations

import functools
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import psycopg2
from pyproj import Transformer
from shapely.geometry import Point, box, shape
from shapely.ops import transform as transform_geometry
from shapely.strtree import STRtree

from server.terrain_wind import sample_bilinear

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
WEB_CRS = "EPSG:4326"
FIELD_VERSION = "terrain-buildings-2026-07-23"
REGIONAL_FIELD_DIR = Path(__file__).resolve().parents[1] / "data" / "wind_fields" / "regional"
CBD_FIELD_DIR = Path(__file__).resolve().parents[1] / "data" / "wind_fields" / "cbd"
VALID_DIRECTIONS = {
    "N": 0.0,
    "NNE": 22.5,
    "NE": 45.0,
    "ENE": 67.5,
    "E": 90.0,
    "ESE": 112.5,
    "SE": 135.0,
    "SSE": 157.5,
    "S": 180.0,
    "SSW": 202.5,
    "SW": 225.0,
    "WSW": 247.5,
    "W": 270.0,
    "WNW": 292.5,
    "NW": 315.0,
    "NNW": 337.5,
    "CAPE_DOCTOR": 150.0,
}
AVAILABLE_DIRECTION_LAYERS = {
    "n": 0.0,
    "ne": 45.0,
    "e": 90.0,
    "se": 135.0,
    "s": 180.0,
    "sw": 225.0,
    "w": 270.0,
    "nw": 315.0,
}


@dataclass(frozen=True)
class PreviewRequest:
    bbox: tuple[float, float, float, float] | None
    center_local: tuple[float, float] | None
    size_m: float
    direction_deg: float
    season: str
    reference_speed_mps: float
    reference_height_m: float
    height_m: float
    resolution_m: float


def database_url() -> str | None:
    return os.environ.get("DATABASE_URL")


def get_connection():
    url = database_url()
    if not url:
        return None
    return psycopg2.connect(url, connect_timeout=5)


def load_viewer_config() -> dict[str, Any]:
    manifest_path = Path(__file__).resolve().parents[1] / "public" / "assets" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {
        "origin": manifest["origin"],
        "bounds": manifest["bounds"],
        "crs": manifest["crs"],
    }


def direction_name(direction_deg: float) -> str:
    normalized = direction_deg % 360.0
    nearest_name, nearest_value = min(
        VALID_DIRECTIONS.items(), key=lambda item: abs(((item[1] - normalized + 180) % 360) - 180)
    )
    if abs(((nearest_value - normalized + 180) % 360) - 180) <= 11.26:
        return nearest_name.lower()
    return f"az_{round(normalized):03d}"


def polygon_table(direction_deg: float) -> str:
    normalized = direction_deg % 360.0
    nearest = min(
        AVAILABLE_DIRECTION_LAYERS.items(),
        key=lambda item: abs(((item[1] - normalized + 180) % 360) - 180),
    )[0]
    # The database currently contains eight directional layers. Intermediate
    # compass directions and Cape Doctor use their nearest imported layer and
    # remain explicitly marked as proxies in the API response.
    return f"ventilation_{nearest}"


def regional_direction_name(direction_deg: float) -> str:
    normalized = direction_deg % 360.0
    nearest_name, _ = min(
        VALID_DIRECTIONS.items(), key=lambda item: abs(((item[1] - normalized + 180) % 360) - 180)
    )
    return nearest_name.lower()


@functools.lru_cache(maxsize=None)
def load_regional_field(direction_deg: float) -> dict[str, Any] | None:
    """Load the precomputed mass-conserving regional field nearest to direction_deg.

    Returns None if no precomputed field is available (e.g. it hasn't been
    generated yet, such as in a bare checkout or CI without running
    scripts/export_regional_wind_fields.py) -- callers fall back to the
    constant-vector proxy behaviour in that case.
    """
    path = REGIONAL_FIELD_DIR / f"{regional_direction_name(direction_deg)}.npz"
    if not path.exists():
        return None
    with np.load(path) as data:
        return {
            "u": data["u"],
            "v": data["v"],
            "origin_x": float(data["origin_x"]),
            "origin_z": float(data["origin_z"]),
            "dx": float(data["dx"]),
            "dz": float(data["dz"]),
        }


@functools.lru_cache(maxsize=None)
def load_cbd_field(direction_deg: float) -> dict[str, Any] | None:
    """Load the precomputed building-resolved CBD field nearest to direction_deg.

    Returns None if it hasn't been generated yet (run
    scripts/export_cbd_wind_fields.py) -- callers fall back to the regional
    field or the constant-vector proxy in that case.
    """
    path = CBD_FIELD_DIR / f"{regional_direction_name(direction_deg)}.npz"
    if not path.exists():
        return None
    with np.load(path) as data:
        return {
            "u": data["u"],
            "v": data["v"],
            "origin_x": float(data["origin_x"]),
            "origin_z": float(data["origin_z"]),
            "dx": float(data["dx"]),
            "dz": float(data["dz"]),
        }


def sample_terrain_flow(field: dict[str, Any], x: float, z: float) -> tuple[float, float, float]:
    """Return (unit_x, unit_z, terrain_speed_factor) at a world point.

    terrain_speed_factor is the raw (non-normalised) magnitude of the
    precomputed unit-reference-speed field: >1 where terrain (or, for the CBD
    field, a building) channels/accelerates flow, <1 where it's sheltered, and
    0 where the point sits behind an obstacle that fully blocks the sampling
    layer -- so both the direction *and* the speed the caller multiplies in
    reflect real geometry, not just a compass bearing. Shared by the regional
    (mountain) and CBD (building) fields, which use the same grid layout.
    """
    u = sample_bilinear(field["u"], field["origin_x"], field["origin_z"], field["dx"], field["dz"], x, z)
    v = sample_bilinear(field["v"], field["origin_x"], field["origin_z"], field["dx"], field["dz"], x, z)
    magnitude = math.hypot(u, v)
    if magnitude < 1e-6:
        return 0.0, 0.0, 0.0
    return u / magnitude, v / magnitude, magnitude


def local_to_web(x: float, z: float, config: dict[str, Any]) -> tuple[float, float]:
    transformer = Transformer.from_crs(LOCAL_CRS, WEB_CRS, always_xy=True)
    origin_x, origin_y = config["origin"]
    return transformer.transform(origin_x + x, origin_y - z)


def web_to_local(lon: float, lat: float, config: dict[str, Any]) -> tuple[float, float]:
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    x, y = transformer.transform(lon, lat)
    origin_x, origin_y = config["origin"]
    return x - origin_x, -(y - origin_y)


def request_from_payload(payload: dict[str, Any], config: dict[str, Any]) -> PreviewRequest:
    bbox_value = payload.get("bbox")
    bbox = None
    if bbox_value is not None:
        if not isinstance(bbox_value, list) or len(bbox_value) != 4:
            raise ValueError("bbox must contain [minLon, minLat, maxLon, maxLat]")
        bbox = tuple(float(value) for value in bbox_value)
        if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
            raise ValueError("bbox must have increasing longitude and latitude")

    center_value = payload.get("center_local")
    center_local = None
    if center_value is not None:
        if not isinstance(center_value, list) or len(center_value) != 2:
            raise ValueError("center_local must contain [x, z]")
        center_local = (float(center_value[0]), float(center_value[1]))

    direction_deg = float(payload.get("direction_deg", 135.0)) % 360.0
    season = str(payload.get("season", "annual")).lower()
    if season not in {"annual", "summer", "autumn", "winter", "spring"}:
        raise ValueError("season must be annual, summer, autumn, winter, or spring")
    size_m = min(1200.0, max(100.0, float(payload.get("size_m", 250.0))))
    resolution_m = min(20.0, max(2.0, float(payload.get("resolution_m", 5.0))))
    reference_speed_mps = min(50.0, max(0.0, float(payload.get("reference_speed_mps", 10.0))))
    height_m = min(10.0, max(1.0, float(payload.get("height_m", 2.0))))
    reference_height_value = payload.get("reference_height_m")
    reference_height_m = min(100.0, max(1.0, float(reference_height_value if reference_height_value is not None else height_m)))
    if bbox is None and center_local is None:
        center_local = (0.0, 0.0)
    return PreviewRequest(
        bbox=bbox,
        center_local=center_local,
        size_m=size_m,
        direction_deg=direction_deg,
        season=season,
        reference_speed_mps=reference_speed_mps,
        reference_height_m=reference_height_m,
        height_m=height_m,
        resolution_m=resolution_m,
    )


def local_bounds(request: PreviewRequest, config: dict[str, Any]) -> tuple[float, float, float, float]:
    if request.bbox is not None:
        corners = [
            web_to_local(request.bbox[0], request.bbox[1], config),
            web_to_local(request.bbox[0], request.bbox[3], config),
            web_to_local(request.bbox[2], request.bbox[1], config),
            web_to_local(request.bbox[2], request.bbox[3], config),
        ]
        xs = [point[0] for point in corners]
        zs = [point[1] for point in corners]
        return min(xs), min(zs), max(xs), max(zs)
    center_x, center_z = request.center_local or (0.0, 0.0)
    half = request.size_m / 2.0
    return center_x - half, center_z - half, center_x + half, center_z + half


def query_polygons(request: PreviewRequest, bounds: tuple[float, float, float, float], config: dict[str, Any]) -> list[dict[str, Any]]:
    table = polygon_table(request.direction_deg)
    min_x, min_z, max_x, max_z = bounds
    web_corners = [local_to_web(x, z, config) for x, z in [(min_x, min_z), (min_x, max_z), (max_x, min_z), (max_x, max_z)]]
    lons = [corner[0] for corner in web_corners]
    lats = [corner[1] for corner in web_corners]
    west, east = min(lons), max(lons)
    south, north = min(lats), max(lats)
    sql = f"""
        SELECT class_value, ventilation_class, wind_speed_factor,
               estimated_speed_kmh, direction, azimuth_deg,
               reference_speed_kmh, frequency_weight,
               ST_AsGeoJSON(wkb_geometry)
        FROM wind.{table}
        WHERE wkb_geometry && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
        ORDER BY ogc_fid
    """
    connection = get_connection()
    if connection is None:
        return []
    try:
        with connection, connection.cursor() as cursor:
            cursor.execute(sql, (west, south, east, north))
            rows = cursor.fetchall()
        return [
            {
                "class_value": row[0],
                "ventilation_class": row[1],
                "wind_speed_factor": float(row[2]),
                "estimated_speed_kmh": float(row[3]),
                "direction": row[4],
                "azimuth_deg": float(row[5]),
                "reference_speed_kmh": float(row[6]),
                "frequency_weight": None if row[7] is None else float(row[7]),
                "geometry": json.loads(row[8]),
            }
            for row in rows
        ]
    finally:
        connection.close()


def factor_at(point_x: float, point_z: float, polygons: list[dict[str, Any]]) -> float:
    point = Point(point_x, point_z)
    for feature in polygons:
        geometry = shape(feature["geometry"])
        local_geometry = transform_geometry(lambda x, y, z=None: (x, y), geometry)
        # The query geometry is geographic, so callers replace this function
        # with projected polygons before sampling. This branch is retained for
        # deterministic no-data fallback behavior.
        if local_geometry.covers(point):
            return feature["wind_speed_factor"]
    return 0.65


def project_polygons(polygons: list[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = config["origin"]
    projected = []
    for feature in polygons:
        geometry = shape(feature["geometry"])
        local_geometry = transform_geometry(
            lambda x, y, z=None: (transformer.transform(x, y)[0] - origin_x, -(transformer.transform(x, y)[1] - origin_y)),
            geometry,
        )
        projected.append({**feature, "local_geometry": local_geometry})
    return projected


def sample_factor(x: float, z: float, polygons: list[dict[str, Any]], tree: STRtree | None = None) -> float:
    point = Point(x, z)
    candidates = tree.query(point) if tree is not None else range(len(polygons))
    for candidate in candidates:
        feature = polygons[int(candidate)] if tree is not None else polygons[candidate]
        if feature["local_geometry"].covers(point):
            return feature["wind_speed_factor"]
    return 0.65


def current_model_kind() -> str:
    """Best model_kind available right now, for endpoints that describe the
    API without running a full field build (e.g. /api/wind/scenarios)."""
    if load_cbd_field(0.0) is not None:
        return "mass_conserving_terrain_buildings"
    if load_regional_field(0.0) is not None:
        return "mass_conserving_terrain"
    return "directional_speed_proxy"


def build_field(request: PreviewRequest, bounds: tuple[float, float, float, float], polygons: list[dict[str, Any]]) -> dict[str, Any]:
    min_x, min_z, max_x, max_z = bounds
    width = max(2, min(256, int(math.ceil((max_x - min_x) / request.resolution_m))))
    height = max(2, min(256, int(math.ceil((max_z - min_z) / request.resolution_m))))
    dx = (max_x - min_x) / width
    dz = (max_z - min_z) / height
    angle = math.radians(request.direction_deg)
    # direction_deg is the meteorological bearing the wind blows FROM (e.g. the
    # Cape Doctor is "SE" because it originates over the mountain to the
    # south-east and sweeps north-west across the CBD toward the sea), so the
    # flow vector points the opposite way, toward direction_deg + 180.
    flow_x, flow_z = -math.sin(angle), math.cos(angle)
    regional_field = load_regional_field(request.direction_deg)
    cbd_field = load_cbd_field(request.direction_deg)
    tree = STRtree([feature["local_geometry"] for feature in polygons]) if polygons else None
    # A neutral urban power-law profile converts a 10 m weather forcing to the
    # requested pedestrian level. Manual requests remain unchanged because
    # reference_height_m defaults to height_m.
    height_factor = (request.height_m / request.reference_height_m) ** 0.33
    output_reference_speed = request.reference_speed_mps * height_factor
    u, v, speed = [], [], []
    for row in range(height):
        z = min_z + (row + 0.5) * dz
        for column in range(width):
            x = min_x + (column + 0.5) * dx
            factor = sample_factor(x, z, polygons, tree)
            point_flow_x, point_flow_z, terrain_speed_factor = flow_x, flow_z, 1.0
            if regional_field is not None:
                point_flow_x, point_flow_z, regional_factor = sample_terrain_flow(regional_field, x, z)
                terrain_speed_factor *= min(regional_factor, 2.5)
            if cbd_field is not None:
                # The CBD field is the finer, closer-to-ground layer, so it
                # wins on direction (buildings channel flow down streets);
                # its speed effect multiplies with the mountain's rather than
                # replacing it, since both shape the same arriving wind.
                point_flow_x, point_flow_z, cbd_factor = sample_terrain_flow(cbd_field, x, z)
                terrain_speed_factor *= min(cbd_factor, 2.5)
            local_speed = output_reference_speed * factor * terrain_speed_factor
            u.append(point_flow_x * local_speed)
            v.append(point_flow_z * local_speed)
            speed.append(local_speed)
    if cbd_field is not None:
        model_kind = "mass_conserving_terrain_buildings"
    elif regional_field is not None:
        model_kind = "mass_conserving_terrain"
    else:
        model_kind = "directional_speed_proxy"
    return {
        "version": FIELD_VERSION,
        "model_kind": model_kind,
        "validation_status": "exploratory_not_engineering_grade",
        "crs": "viewer-local Lo19 metres; x=east, z=south-positive",
        "origin": [min_x, min_z],
        "width": width,
        "height": height,
        "dx": dx,
        "dz": dz,
        "direction_deg": request.direction_deg,
        "season": request.season,
        "height_m": request.height_m,
        "reference_height_m": request.reference_height_m,
        "reference_speed_mps": request.reference_speed_mps,
        "height_adjusted_reference_speed_mps": output_reference_speed,
        "u": u,
        "v": v,
        "speed": speed,
        "polygons": [
            {key: value for key, value in feature.items() if key != "local_geometry"}
            for feature in polygons
        ],
        "source_layer": polygon_table(request.direction_deg),
    }
