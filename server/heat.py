"""Database-backed heat-zone extraction for the Canvas scene."""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import box, mapping, shape
from shapely.ops import transform as transform_geometry

from .field import LOCAL_CRS, WEB_CRS, get_connection, load_viewer_config

HEAT_TABLE = "heat_zones"
HEAT_SOURCE_PATH = Path(__file__).resolve().parents[1] / "data" / "raw" / "scene_footprint_heat_2026_academic_v3_zones.geojson"
# The source polygons are more detailed than the Canvas scene can display.
# Simplifying in the projected metre-based CRS keeps the visual result while
# preventing multi-million-vertex browser payloads and draw calls.
HEAT_SIMPLIFY_METRES = 2.0
HEAT_METRICS = {
    "heat_model_lst_c": "Surface temperature",
}
HEAT_COLOR_PERCENTILES = {"heat_model_lst_c": (0.10, 0.90)}
HEAT_COLOR_SCALE = {
    "mode": "percentile_clipped_gradient",
    "bottom_percentile": 10,
    "top_percentile": 90,
    "bottom_band_label": "Bottom 10%",
    "top_band_label": "Top 10%",
}


def _scene_to_web_box(bounds: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Convert scene [x, z] bounds to a conservative WGS84 query envelope."""
    config = load_viewer_config()
    origin_x, origin_y = config["origin"]
    left, bottom, right, top = bounds
    transformer = Transformer.from_crs(LOCAL_CRS, WEB_CRS, always_xy=True)
    corners = [
        transformer.transform(origin_x + left, origin_y - bottom),
        transformer.transform(origin_x + left, origin_y - top),
        transformer.transform(origin_x + right, origin_y - bottom),
        transformer.transform(origin_x + right, origin_y - top),
    ]
    return (
        min(point[0] for point in corners), min(point[1] for point in corners),
        max(point[0] for point in corners), max(point[1] for point in corners),
    )


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    amount = position - lower
    return ordered[lower] * (1 - amount) + ordered[upper] * amount


@functools.lru_cache(maxsize=1)
def _load_heat_zones() -> dict[str, Any]:
    config = load_viewer_config()
    scene_bounds = tuple(config["bounds"])
    query_bounds = _scene_to_web_box(scene_bounds)
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = config["origin"]
    left, bottom, right, top = scene_bounds
    scene_clip = box(left, bottom, right, top)
    source_name = "climate.heat_zones"
    if HEAT_SOURCE_PATH.exists():
        source = json.loads(HEAT_SOURCE_PATH.read_text(encoding="utf-8"))
        rows = [
            (feature.get("properties") or {}, feature.get("geometry"))
            for feature in source.get("features", [])
            if feature.get("geometry")
        ]
        source_name = HEAT_SOURCE_PATH.name
    else:
        connection = get_connection()
        if connection is None:
            raise RuntimeError("heat product is missing and DATABASE_URL is not configured")
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT heat_model_lst_c, urban_heat_score, surface_air_delta_c,
                           pedestrian_heat_score, retained_heat_score,
                           ST_AsGeoJSON(wkb_geometry)
                    FROM climate.heat_zones
                    WHERE wkb_geometry && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                      AND wkb_geometry IS NOT NULL
                    """,
                    query_bounds,
                )
                rows = [
                    (
                        {
                            metric: value
                            for metric, value in zip(
                                HEAT_METRICS,
                                row[:-1],
                            )
                        },
                        json.loads(row[-1]),
                    )
                    for row in cursor.fetchall()
                ]
        finally:
            connection.close()

    features: list[dict[str, Any]] = []
    source_properties = rows[0][0] if rows else {}
    source_window = {
        "start": source_properties.get("analysis_window_start"),
        "end": source_properties.get("analysis_window_end"),
        "label": source_properties.get("analysis_window_label"),
    }
    for properties, raw_geometry in rows:
        geometry = shape(raw_geometry)
        local = transform_geometry(transformer.transform, geometry)
        # Scene z is the inverse of the projected northing axis.
        local = transform_geometry(lambda x, y, z=None: (x - origin_x, -(y - origin_y)), local)
        local = local.intersection(scene_clip).simplify(HEAT_SIMPLIFY_METRES, preserve_topology=True)
        if local.is_empty:
            continue
        normalized_properties = {
            metric: (float(properties.get(metric)) if properties.get(metric) is not None else None)
            for metric in HEAT_METRICS
        }
        features.append({"geometry": mapping(local), "properties": normalized_properties})

    values = {
        metric: [feature["properties"][metric] for feature in features if feature["properties"][metric] is not None]
        for metric in HEAT_METRICS
    }
    ranges = {
        metric: {"min": min(items), "max": max(items)}
        for metric, items in values.items() if items
    }
    color_ranges = {
        metric: {
            "min": _percentile(items, HEAT_COLOR_PERCENTILES.get(metric, (0.10, 0.90))[0]),
            "max": _percentile(items, HEAT_COLOR_PERCENTILES.get(metric, (0.10, 0.90))[1]),
            "p10": _percentile(items, HEAT_COLOR_PERCENTILES.get(metric, (0.10, 0.90))[0]),
            "p90": _percentile(items, HEAT_COLOR_PERCENTILES.get(metric, (0.10, 0.90))[1]),
        }
        for metric, items in values.items() if items
    }
    return {
        "features": features,
        "ranges": ranges,
        "color_ranges": color_ranges,
        "count": len(features),
        "source": source_name,
        "window": source_window,
    }


def heat_zones(metric: str) -> dict[str, Any]:
    if metric not in HEAT_METRICS:
        raise ValueError(f"unsupported heat metric: {metric}")
    data = _load_heat_zones()
    features = [
        {"geometry": feature["geometry"], "value": feature["properties"][metric]}
        for feature in data["features"]
        if feature["properties"][metric] is not None
    ]
    return {
        "version": "heat-zones-2026",
        "metric": metric,
        "metric_label": HEAT_METRICS[metric],
        "mode": "zones",
        "features": features,
        "range": data["ranges"].get(metric),
        "color_range": data["color_ranges"].get(metric),
        "color_scale": HEAT_COLOR_SCALE,
        "count": len(features),
        "source": data["source"],
        "window": data["window"],
    }
