"""Database-backed heat-zone extraction for the Canvas scene."""

from __future__ import annotations

import csv
import functools
import json
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import Point, Polygon, box, mapping, shape
from shapely.ops import transform as transform_geometry, unary_union
from shapely.strtree import STRtree

from .field import LOCAL_CRS, WEB_CRS, get_connection, load_viewer_config
from .solar import cast_shadow, sun_position

HEAT_TABLE = "heat_zones"
HEAT_SOURCE_PATH = Path(__file__).resolve().parents[1] / "data" / "raw" / "scene_footprint_heat_2026_academic_v3_zones.geojson"
POI_SOURCE_PATH = Path(__file__).resolve().parents[1] / "data" / "raw" / "POI_innercity.csv"
SCENE_PATH = Path(__file__).resolve().parents[1] / "public" / "assets" / "fallback.json"
CANOPY_ASSET_PATH = Path(__file__).resolve().parents[1] / "public" / "assets" / "canopy.json"
# The source polygons are more detailed than the Canvas scene can display.
# Simplifying in the projected metre-based CRS keeps the visual result while
# preventing multi-million-vertex browser payloads and draw calls.
HEAT_SIMPLIFY_METRES = 2.0
# Adjacent source zones are simplified independently, which leaves sub-metre
# seams between boundaries that were originally contiguous. Expand each zone
# just enough to overlap those seams; this keeps every rendered pixel assigned
# to a real zone value instead of relying on a background colour layer.
HEAT_STITCH_METRES = 1.0
HEAT_METRICS = {
    "heat_model_lst_c": "Surface temperature",
    "rooftop_temperature_c": "Rooftop temperature",
    "pedestrian_heat_exposure_c": "Pedestrian thermal exposure",
    "shade_deficit_score": "Time-specific shade deficit",
    "pedestrian_priority_score": "Pedestrian intervention priority",
}
HEAT_METRIC_METADATA = {
    "heat_model_lst_c": {"unit": "°C", "decimals": 1, "kind": "temperature"},
    "rooftop_temperature_c": {"unit": "°C", "decimals": 1, "kind": "temperature"},
    "pedestrian_heat_exposure_c": {"unit": "°C", "decimals": 1, "kind": "temperature_delta"},
    "shade_deficit_score": {"unit": "/100", "decimals": 0, "kind": "score"},
    "pedestrian_priority_score": {"unit": "/100", "decimals": 0, "kind": "score"},
}
HEAT_COLOR_PERCENTILES = {metric: (0.10, 0.90) for metric in HEAT_METRICS}
HEAT_COLOR_SCALE = {
    "mode": "percentile_clipped_gradient",
    "bottom_percentile": 10,
    "top_percentile": 90,
    "bottom_band_label": "Bottom 10%",
    "top_band_label": "Top 10%",
}


def _lidar_scene_clip(fallback_bounds: tuple[float, float, float, float]) -> Any:
    if not SCENE_PATH.exists():
        return box(*fallback_bounds)
    scene = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
    polygons = []
    for rings in scene.get("terrain", {}).get("footprint", []):
        if rings and len(rings[0]) >= 3:
            polygons.append(Polygon(rings[0], rings[1:]))
    return unary_union(polygons) if polygons else box(*fallback_bounds)


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


def _poi_activity_scores(zone_geometries: list[Any]) -> list[float]:
    """Return anonymous activity-density scores; never expose source POI records."""
    if not POI_SOURCE_PATH.exists() or not zone_geometries:
        return [0.0] * len(zone_geometries)
    config = load_viewer_config()
    origin_x, origin_y = config["origin"]
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    points = []
    with POI_SOURCE_PATH.open(newline="", encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            try:
                lon = float(row.get("nearest_x") or row.get("google_longitude") or "")
                lat = float(row.get("nearest_y") or row.get("google_latitude") or "")
            except (TypeError, ValueError):
                continue
            x, y = transformer.transform(lon, lat)
            points.append(Point(x - origin_x, -(y - origin_y)))
    if not points:
        return [0.0] * len(zone_geometries)
    tree = STRtree(points)
    # A 60 m catchment represents nearby destinations without revealing any
    # individual business location or category in the response.
    counts = [len(tree.query(geometry.buffer(60.0))) for geometry in zone_geometries]
    upper = _percentile([float(count) for count in counts], 0.95) or 1.0
    return [min(100.0, count / upper * 100.0) for count in counts]


@functools.lru_cache(maxsize=16)
def _shadow_surface(date_text: str, minutes: int) -> Any:
    """Build mapped building and tree-canopy shade for one local solar time."""
    altitude, sun_x, sun_z = sun_position(date_text, minutes)
    if altitude <= 0.008:
        return ()
    shadows = []
    if SCENE_PATH.exists():
        scene = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
        for record in scene.get("buildings", []):
            if len(record) < 3 or len(record[2]) < 3:
                continue
            ground, height, ring = record[0], record[1], record[2]
            footprint = Polygon(ring)
            if footprint.is_valid and not footprint.is_empty:
                shadows.append(cast_shadow(footprint, float(height), altitude, sun_x, sun_z, swept=True))
    if CANOPY_ASSET_PATH.exists():
        canopy = json.loads(CANOPY_ASSET_PATH.read_text(encoding="utf-8"))
        for record in canopy.get("canopies", []):
            if len(record) < 6 or not record[5] or len(record[5][0]) < 3:
                continue
            _, ground, crown_base, crown_top, _, rings = record
            footprint = Polygon(rings[0], rings[1:])
            if footprint.is_valid and not footprint.is_empty:
                crown_height = max(1.0, (float(crown_base) + float(crown_top)) / 2.0 - float(ground))
                shadows.append(cast_shadow(footprint, crown_height, altitude, sun_x, sun_z, swept=False))
    return tuple(shadow for shadow in shadows if not shadow.is_empty)


@functools.lru_cache(maxsize=16)
def _dynamic_shade_deficits(date_text: str, minutes: int) -> tuple[float, ...]:
    features = _load_heat_zones()["features"]
    shadows = _shadow_surface(date_text, minutes)
    if not shadows:
        return tuple(0.0 for _ in features)
    tree = STRtree(shadows)
    deficits = []
    for feature in features:
        geometry = shape(feature["geometry"])
        min_x, min_y, max_x, max_y = geometry.bounds
        samples = [geometry.representative_point()]
        for x_fraction in (0.2, 0.5, 0.8):
            for y_fraction in (0.2, 0.5, 0.8):
                point = Point(min_x + (max_x - min_x) * x_fraction, min_y + (max_y - min_y) * y_fraction)
                if geometry.covers(point):
                    samples.append(point)
        shaded_samples = 0
        for point in samples:
            if any(shadows[int(index)].covers(point) for index in tree.query(point)):
                shaded_samples += 1
        shaded_fraction = shaded_samples / len(samples)
        deficits.append(round((1.0 - shaded_fraction) * 100.0, 2))
    return tuple(deficits)


@functools.lru_cache(maxsize=1)
def _activity_scores() -> tuple[float, ...]:
    features = _load_heat_zones()["features"]
    return tuple(_poi_activity_scores([shape(feature["geometry"]) for feature in features]))


@functools.lru_cache(maxsize=1)
def _load_heat_zones() -> dict[str, Any]:
    config = load_viewer_config()
    scene_bounds = tuple(config["bounds"])
    query_bounds = _scene_to_web_box(scene_bounds)
    transformer = Transformer.from_crs(WEB_CRS, LOCAL_CRS, always_xy=True)
    origin_x, origin_y = config["origin"]
    left, bottom, right, top = scene_bounds
    scene_clip = _lidar_scene_clip(scene_bounds)
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
                    SELECT heat_model_lst_c, building_cover_pct,
                           pedestrian_heat_exposure_c, shade_deficit_score,
                           pedestrian_heat_score,
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
                            metric: value for metric, value in zip(
                                ("heat_model_lst_c", "building_cover_pct",
                                 "pedestrian_heat_exposure_c", "shade_deficit_score",
                                 "pedestrian_heat_score"), row[:-1]
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
        local = local.buffer(HEAT_STITCH_METRES, join_style=2).intersection(scene_clip)
        if local.is_empty:
            continue
        normalized_properties = {
            metric: (float(properties.get(metric)) if properties.get(metric) is not None else None)
            for metric in ("heat_model_lst_c", "pedestrian_heat_exposure_c", "shade_deficit_score")
        }
        building_cover_pct = float(properties.get("building_cover_pct") or 0.0)
        pedestrian_candidate = (
            str(properties.get("land_type") or "").lower() != "water"
            and building_cover_pct < 50.0
        )
        normalized_properties["rooftop_temperature_c"] = (
            normalized_properties["heat_model_lst_c"] if building_cover_pct >= 50.0 else None
        )
        normalized_properties["_pedestrian_candidate"] = pedestrian_candidate
        if not pedestrian_candidate:
            normalized_properties["pedestrian_heat_exposure_c"] = None
            normalized_properties["shade_deficit_score"] = None
        normalized_properties["pedestrian_heat_score"] = (
            float(properties["pedestrian_heat_score"])
            if properties.get("pedestrian_heat_score") is not None else None
        )
        features.append({"geometry": mapping(local), "properties": normalized_properties})

    # Close any remaining enclosed seams with the value of the nearest real
    # zone. These are geometry patches, not a blanket colour underlay, so the
    # resulting surface stays data-coloured and continuous.
    zone_geometries = [shape(feature["geometry"]) for feature in features]
    if zone_geometries:
        coverage = unary_union(zone_geometries)
        parts = coverage.geoms if coverage.geom_type == "MultiPolygon" else (coverage,)
        gaps = [
            Polygon(interior)
            for part in parts if part.geom_type == "Polygon"
            for interior in part.interiors
            if Polygon(interior).area <= 100.0
        ]
        zone_tree = STRtree(zone_geometries)
        for gap in gaps:
            nearest_index = int(zone_tree.nearest(gap.representative_point()))
            features.append({
                "geometry": mapping(gap),
                "properties": features[nearest_index]["properties"].copy(),
            })

    zone_geometries = [shape(feature["geometry"]) for feature in features]
    values = {
        metric: [feature["properties"].get(metric) for feature in features if feature["properties"].get(metric) is not None]
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


def heat_zones(metric: str, date_text: str = "2026-01-15", minutes: int = 720) -> dict[str, Any]:
    if metric not in HEAT_METRICS:
        raise ValueError(f"unsupported heat metric: {metric}")
    data = _load_heat_zones()
    if minutes < 0 or minutes >= 1440:
        raise ValueError("minutes must be between 0 and 1439")
    source_features = data["features"]
    dynamic_metric = metric in {"shade_deficit_score", "pedestrian_priority_score"}
    shade_deficits = _dynamic_shade_deficits(date_text, minutes) if dynamic_metric else ()
    activity_scores = _activity_scores() if metric == "pedestrian_priority_score" else ()

    def metric_value(feature: dict[str, Any], index: int) -> float | None:
        properties = feature["properties"]
        pedestrian_candidate = properties.get("_pedestrian_candidate", True)
        if metric == "shade_deficit_score":
            return shade_deficits[index] if pedestrian_candidate else None
        if metric == "pedestrian_priority_score":
            if not pedestrian_candidate:
                return None
            thermal = float(properties.get("pedestrian_heat_score") or 0.0)
            # Shade and nearby activity moderate the measured/modelled thermal
            # signal rather than independently creating a high priority.
            modifier = 0.60 + 0.25 * shade_deficits[index] / 100.0 + 0.15 * activity_scores[index] / 100.0
            return round(min(100.0, thermal * modifier), 2)
        return properties.get(metric)

    features = [
        {
            "geometry": feature["geometry"],
            "value": metric_value(feature, index),
            "area_m2": shape(feature["geometry"]).area,
        }
        for index, feature in enumerate(source_features)
        if metric_value(feature, index) is not None
    ]
    metric_values = [feature["value"] for feature in features]
    raw_range = {"min": min(metric_values), "max": max(metric_values)} if metric_values else None
    color_range = {
        "min": _percentile(metric_values, 0.10), "max": _percentile(metric_values, 0.90),
        "p10": _percentile(metric_values, 0.10), "p90": _percentile(metric_values, 0.90),
    } if metric_values else None
    total_area_m2 = sum(feature["area_m2"] for feature in features)
    weighted_total = sum(feature["value"] * feature["area_m2"] for feature in features)
    hotspot_threshold = (color_range or {}).get("p90")
    hotspot_area_m2 = sum(
        feature["area_m2"] for feature in features
        if hotspot_threshold is not None and feature["value"] >= hotspot_threshold
    )
    weighted_mean = weighted_total / total_area_m2 if total_area_m2 else None
    maximum = max((feature["value"] for feature in features), default=None)
    metadata = HEAT_METRIC_METADATA[metric]
    summary = {
        "area_weighted_mean": weighted_mean,
        "maximum": maximum,
        "hotspot_threshold": hotspot_threshold,
        # Retain the established temperature keys for existing API clients.
        "area_weighted_mean_c": weighted_mean if metadata["unit"] == "°C" else None,
        "maximum_c": maximum if metadata["unit"] == "°C" else None,
        "hotspot_threshold_c": hotspot_threshold if metadata["unit"] == "°C" else None,
        "hotspot_area_m2": hotspot_area_m2,
        "hotspot_area_pct": hotspot_area_m2 / total_area_m2 * 100 if total_area_m2 else None,
        "total_area_m2": total_area_m2,
    }
    return {
        "version": "heat-zones-2026",
        "metric": metric,
        "metric_label": HEAT_METRICS[metric],
        "metric_metadata": metadata,
        "mode": "zones",
        "features": features,
        "range": raw_range,
        "color_range": color_range,
        "color_scale": HEAT_COLOR_SCALE,
        "count": len(features),
        "summary": summary,
        "source": data["source"],
        "window": data["window"],
        "scenario": {"date": date_text, "minutes": minutes, "shade_sources": ["mapped_buildings", "mapped_tree_canopies"]},
        "methodology": {
            "priority_formula": "Pedestrian heat moderated by 25% time-specific shade deficit and 15% anonymous nearby-destination density",
            "activity_input": "Aggregated from POI_innercity within 60 m; source records and locations are not returned",
            "priority_use": "Screening rank for site investigation, not a measured health-risk score",
            "pedestrian_mask": "Water and zones with at least 50% building cover are excluded",
            "shade_method": "Up to ten samples per zone against mapped building and tree-canopy shadows",
        } if metric == "pedestrian_priority_score" else ({
            "rooftop_mask": "Only zones with at least 50% mapped building cover are included",
            "rooftop_use": "Screening view for roof interventions; values are modelled land-surface temperature",
        } if metric == "rooftop_temperature_c" else None),
    }
