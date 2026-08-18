"""Database-backed heat-zone extraction for the Canvas scene."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import functools
import json
import math
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import Polygon, box, mapping, shape
from shapely.ops import transform as transform_geometry, unary_union
from shapely.strtree import STRtree

from .field import LOCAL_CRS, WEB_CRS, get_connection, load_viewer_config
from .solar import cast_shadow, sun_position

HEAT_TABLE = "heat_zones"
HEAT_SOURCE_PATH = Path(__file__).resolve().parents[1] / "data" / "raw" / "scene_footprint_heat_2026_academic_v3_zones.geojson"
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
    "pedestrian_heat_exposure_c": "Pedestrian thermal exposure delta (proxy, not UTCI/PET)",
    "shade_deficit_score": "Time-specific shade deficit",
    "pedestrian_priority_score": "Summer thermal baseline + selected-date shade scenario",
    "cumulative_sun_hours": "Cumulative direct sunlight",
}
HEAT_METRIC_METADATA = {
    "heat_model_lst_c": {"unit": "°C", "decimals": 1, "kind": "temperature"},
    "rooftop_temperature_c": {"unit": "°C", "decimals": 1, "kind": "temperature"},
    "pedestrian_heat_exposure_c": {"unit": "°C", "decimals": 1, "kind": "temperature_delta"},
    "shade_deficit_score": {"unit": "/100", "decimals": 0, "kind": "score"},
    "pedestrian_priority_score": {"unit": "/100", "decimals": 0, "kind": "score"},
    "cumulative_sun_hours": {"unit": " h", "decimals": 1, "kind": "duration"},
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


@functools.lru_cache(maxsize=1)
def _shadow_blockers() -> tuple[tuple[Any, float, bool], ...]:
    """Load reusable shadow-caster geometry once per server process."""
    blockers: list[tuple[Any, float, bool]] = []
    if SCENE_PATH.exists():
        scene = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
        for record in scene.get("buildings", []):
            if len(record) < 3 or len(record[2]) < 3:
                continue
            _, height, ring = record[0], record[1], record[2]
            holes = record[13] if len(record) > 13 and isinstance(record[13], list) else []
            footprint = Polygon(ring, holes)
            if footprint.is_valid and not footprint.is_empty:
                blockers.append((footprint, float(height), True))
    if CANOPY_ASSET_PATH.exists():
        canopy = json.loads(CANOPY_ASSET_PATH.read_text(encoding="utf-8"))
        for record in canopy.get("canopies", []):
            if len(record) < 6 or not record[5] or len(record[5][0]) < 3:
                continue
            _, ground, crown_base, crown_top, _, rings = record
            footprint = Polygon(rings[0], rings[1:])
            if footprint.is_valid and not footprint.is_empty:
                crown_height = max(1.0, (float(crown_base) + float(crown_top)) / 2.0 - float(ground))
                blockers.append((footprint, crown_height, False))
    return tuple(blockers)


@functools.lru_cache(maxsize=48)
def _shadow_surface(
    date_text: str, minutes: int,
    domain_bounds: tuple[float, float, float, float] | None = None,
) -> Any:
    """Build mapped shade for one time, prefiltered to the requested domain."""
    altitude, sun_x, sun_z = sun_position(date_text, minutes)
    if altitude <= 0.008:
        return ()
    shadows = []
    domain = box(*domain_bounds) if domain_bounds is not None else None
    horizontal = math.hypot(sun_x, sun_z) or 1.0
    for footprint, height, swept in _shadow_blockers():
        distance = min(500.0, height / max(math.tan(altitude), 0.03))
        dx, dz = -sun_x / horizontal * distance, -sun_z / horizontal * distance
        min_x, min_z, max_x, max_z = footprint.bounds
        candidate_bounds = (
            min_x + (min(0.0, dx) if swept else dx),
            min_z + (min(0.0, dz) if swept else dz),
            max_x + (max(0.0, dx) if swept else dx),
            max_z + (max(0.0, dz) if swept else dz),
        )
        if domain is not None and not box(*candidate_bounds).intersects(domain):
            continue
        shadow = cast_shadow(footprint, height, altitude, sun_x, sun_z, swept=swept)
        if domain is not None and not shadow.is_empty:
            shadow = shadow.intersection(domain)
        shadows.append(shadow)
    return tuple(shadow for shadow in shadows if not shadow.is_empty)


@functools.lru_cache(maxsize=16)
def _dynamic_shade_deficits(date_text: str, minutes: int) -> tuple[float, ...]:
    geometries = tuple(shape(feature["geometry"]) for feature in _load_heat_zones()["features"])
    return _shade_deficits_for_geometries(date_text, minutes, geometries)


def _shade_deficits_for_geometries(
    date_text: str, minutes: int, geometries: tuple[Any, ...],
) -> tuple[float, ...]:
    domain_bounds = (
        min(geometry.bounds[0] for geometry in geometries),
        min(geometry.bounds[1] for geometry in geometries),
        max(geometry.bounds[2] for geometry in geometries),
        max(geometry.bounds[3] for geometry in geometries),
    ) if geometries else None
    shadows = _shadow_surface(date_text, minutes, domain_bounds)
    if not shadows:
        return tuple(100.0 for _ in geometries)
    tree = STRtree(shadows)
    deficits: list[float] = []
    for geometry in geometries:
        candidate_shadows = [shadows[int(index)] for index in tree.query(geometry)]
        if not candidate_shadows or geometry.area <= 0:
            deficits.append(100.0)
            continue
        # Use covered area instead of a handful of point samples. This removes
        # speckled false gaps along shadow boundaries and gives small zones the
        # same spatial fidelity as large ones.
        shaded_area = geometry.intersection(unary_union(candidate_shadows)).area
        shaded_fraction = min(1.0, max(0.0, shaded_area / geometry.area))
        deficits.append(round((1.0 - shaded_fraction) * 100.0, 2))
    return tuple(deficits)


@functools.lru_cache(maxsize=8)
def _cumulative_sun_hours(date_text: str, start_minutes: int, end_minutes: int, step_minutes: int) -> tuple[float, ...]:
    """Accumulate direct-sun duration on every heat-zone analysis surface."""
    geometries = tuple(shape(feature["geometry"]) for feature in _load_heat_zones()["features"])
    return _cumulative_sun_hours_for_geometries(date_text, start_minutes, end_minutes, step_minutes, geometries)


def _cumulative_sun_hours_for_geometries(
    date_text: str, start_minutes: int, end_minutes: int, step_minutes: int,
    geometries: tuple[Any, ...],
) -> tuple[float, ...]:
    """Accumulate direct sun only for the requested ground geometries."""
    totals = [0.0] * len(geometries)
    intervals = []
    for start in range(start_minutes, end_minutes, step_minutes):
        duration = min(step_minutes, end_minutes - start)
        sample_minutes = start + duration // 2
        altitude, _, _ = sun_position(date_text, sample_minutes)
        if altitude <= 0.008:
            continue
        intervals.append((duration, sample_minutes))
    # GEOS releases the GIL while intersecting geometry, so evaluating time
    # samples concurrently keeps an interactive daily study practical without
    # changing its spatial or temporal result.
    with ThreadPoolExecutor(max_workers=min(4, len(intervals) or 1)) as executor:
        results = executor.map(
            lambda item: _shade_deficits_for_geometries(date_text, item[1], geometries),
            intervals,
        )
        for (duration, _), deficits in zip(intervals, results):
            duration_hours = duration / 60.0
            for index, deficit in enumerate(deficits):
                totals[index] += deficit / 100.0 * duration_hours
    return tuple(round(value, 3) for value in totals)


@functools.lru_cache(maxsize=1)
def _roof_surfaces() -> tuple[tuple[Any, float], ...]:
    """Return the mapped building footprints and their modelled roof planes."""
    if not SCENE_PATH.exists():
        return ()
    scene = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
    candidates = []
    for record in scene.get("buildings", []):
        if len(record) < 3 or len(record[2]) < 3:
            continue
        ground, height, ring = record[0], record[1], record[2]
        wall_height = record[5] if len(record) > 5 else height
        holes = record[13] if len(record) > 13 and isinstance(record[13], list) else []
        footprint = Polygon(ring, holes)
        if footprint.is_valid and not footprint.is_empty:
            candidates.append((footprint, float(ground) + max(float(height), float(wall_height))))
    # Building parts and parent footprints often overlap. Keep the highest
    # mapped roof at each x/z location so roof area is not double-counted and
    # stacked thermal polygons cannot fight in the depth buffer.
    roofs = []
    ordered = sorted(candidates, key=lambda item: item[1], reverse=True)
    footprint_tree = STRtree([item[0] for item in ordered])
    for index, (footprint, surface_y) in enumerate(ordered):
        higher = [ordered[int(candidate)][0] for candidate in footprint_tree.query(footprint) if int(candidate) < index]
        visible = footprint.difference(unary_union(higher)) if higher else footprint
        if not visible.is_empty and visible.area >= 0.25:
            roofs.append((visible, surface_y))
    return tuple(roofs)


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
        normalized_properties["air_temp_c"] = float(properties.get("air_temp_c") or 20.71)
        normalized_properties["rooftop_temperature_c"] = None
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


@functools.lru_cache(maxsize=64)
def heat_zones(
    metric: str,
    date_text: str = "2026-01-15",
    minutes: int = 720,
    start_minutes: int = 480,
    end_minutes: int = 1080,
    step_minutes: int = 60,
    domain_bounds: tuple[float, float, float, float] | None = None,
) -> dict[str, Any]:
    if metric not in HEAT_METRICS:
        raise ValueError(f"unsupported heat metric: {metric}")
    data = _load_heat_zones()
    if minutes < 0 or minutes >= 1440:
        raise ValueError("minutes must be between 0 and 1439")
    if not 0 <= start_minutes < end_minutes <= 1440:
        raise ValueError("sunlight window must satisfy 0 <= start < end <= 1440")
    if not 10 <= step_minutes <= 120:
        raise ValueError("sunlight time step must be between 10 and 120 minutes")
    source_features = data["features"]
    if domain_bounds is not None:
        domain = box(*domain_bounds)
        source_features = [
            {**feature, "geometry": mapping(clipped)}
            for feature in source_features
            if not (clipped := shape(feature["geometry"]).intersection(domain)).is_empty
            and clipped.area >= 0.01
        ]
    dynamic_metric = metric in {"shade_deficit_score", "pedestrian_priority_score"}
    shade_deficits = _dynamic_shade_deficits(date_text, minutes) if dynamic_metric else ()
    if metric == "cumulative_sun_hours":
        sun_hours = (
            _cumulative_sun_hours_for_geometries(
                date_text, start_minutes, end_minutes, step_minutes,
                tuple(shape(feature["geometry"]) for feature in source_features),
            )
            if domain_bounds is not None
            else _cumulative_sun_hours(date_text, start_minutes, end_minutes, step_minutes)
        )
    else:
        sun_hours = ()
    temperatures = [
        float(feature["properties"]["heat_model_lst_c"])
        for feature in source_features if feature["properties"].get("heat_model_lst_c") is not None
    ]
    cool_temperature = _percentile(temperatures, 0.10) or 0.0
    hot_temperature = _percentile(temperatures, 0.90) or cool_temperature + 1.0

    def metric_value(feature: dict[str, Any], index: int) -> float | None:
        properties = feature["properties"]
        if metric == "shade_deficit_score":
            return shade_deficits[index]
        if metric == "pedestrian_priority_score":
            temperature = properties.get("heat_model_lst_c")
            if temperature is None:
                return None
            thermal_score = min(1.0, max(0.0, (float(temperature) - cool_temperature) / max(hot_temperature - cool_temperature, 0.01)))
            return round(70.0 * thermal_score + 30.0 * shade_deficits[index] / 100.0, 2)
        if metric == "cumulative_sun_hours":
            return sun_hours[index]
        return properties.get(metric)

    features = []
    if metric == "rooftop_temperature_c":
        zone_geometries = [shape(feature["geometry"]) for feature in source_features]
        zone_tree = STRtree(zone_geometries)
        for roof, surface_y in _roof_surfaces():
            for index in zone_tree.query(roof):
                source = source_features[int(index)]
                value = source["properties"].get("heat_model_lst_c")
                clipped = roof.intersection(zone_geometries[int(index)])
                if value is None or clipped.is_empty or clipped.area < 0.25:
                    continue
                features.append({
                    "geometry": mapping(clipped), "value": value,
                    "area_m2": clipped.area, "surface_y": round(surface_y, 2),
                })
    else:
        for index, feature in enumerate(source_features):
            value = metric_value(feature, index)
            if value is None:
                continue
            features.append({
                "geometry": feature["geometry"],
                "value": value,
                "area_m2": shape(feature["geometry"]).area,
            })
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
        "scenario": {
            "date": date_text, "minutes": minutes,
            "start_minutes": start_minutes, "end_minutes": end_minutes, "step_minutes": step_minutes,
            "sample_count": len(range(start_minutes, end_minutes, step_minutes)),
            "shade_sources": ["mapped_buildings", "mapped_tree_canopies"],
        },
        "methodology": {
            "priority_formula": "70% percentile-normalized surface temperature from the fixed summer thermal-baseline product plus 30% shade deficit for the selected date/time",
            "priority_use": "Screening rank for site investigation, not a measured health-risk score. The surface-temperature term is not re-measured for the selected date; only the shade term varies, so a winter date mixes winter shade geometry with the summer baseline temperature",
            "surface_coverage": "All source-temperature zones are retained so the screening surface remains continuous",
            "shade_method": "Exact zone-area overlap against mapped building and tree-canopy shadows",
        } if metric == "pedestrian_priority_score" else ({
            "rooftop_mask": "Surface-temperature zones are clipped to mapped building roof footprints",
            "rooftop_use": "Screening view for roof interventions; values are modelled land-surface temperature",
        } if metric == "rooftop_temperature_c" else ({
            "sun_hours_method": "Direct-sun fraction is accumulated from exact shadow-area overlap at each time step",
            "analysis_surface": "The same continuous surface-temperature zone geometry used by the heat screening layers",
        } if metric == "cumulative_sun_hours" else None)),
    }
