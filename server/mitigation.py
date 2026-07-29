"""Spatial planning estimates for heat-mitigation interventions."""

from __future__ import annotations

import functools
import json
import math
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import Polygon, box, mapping, shape
from shapely.ops import transform as transform_geometry, unary_union

from .field import LOCAL_CRS, WEB_CRS, load_viewer_config

HEAT_PATH = Path(__file__).resolve().parents[1] / "data" / "raw" / "scene_footprint_heat_2026_academic_v3_zones.geojson"
BUILDING_PATH = Path(__file__).resolve().parents[1] / "data" / "raw" / "BuildingFootprints2D.geojson"
CANOPY_PATH = Path(__file__).resolve().parents[1] / "data" / "raw" / "tree_canopy.geojson"
SCENE_PATH = Path(__file__).resolve().parents[1] / "public" / "assets" / "fallback.json"
CANOPY_ASSET_PATH = Path(__file__).resolve().parents[1] / "public" / "assets" / "canopy.json"
ASSUMPTION_VERSION = "planning-estimates-2026-07-v2"
ASSUMPTIONS = {
    "added_canopy": {
        "label": "Added mature canopy", "impact_mode": "cast_shade",
        "relief_c": {"low": 2.0, "central": 5.0, "high": 10.0},
        "parameter": {"key": "maturity_pct", "label": "maturity", "unit": "%", "default": 100.0, "min": 20.0, "max": 100.0},
    },
    "constructed_shade": {
        "label": "Constructed shade", "impact_mode": "cast_shade",
        "relief_c": {"low": 3.0, "central": 6.0, "high": 10.0},
        "parameter": {"key": "height_m", "label": "height", "unit": "m", "default": 3.0, "min": 1.5, "max": 12.0},
    },
    "cool_pavement": {
        "label": "Cool pavement", "impact_mode": "treatment",
        "relief_c": {"low": 5.0, "central": 7.0, "high": 15.0},
        "parameter": {"key": "target_albedo", "label": "albedo", "unit": "", "default": 0.35, "min": 0.25, "max": 0.65},
    },
    "green_roof": {
        "label": "Green roof", "impact_mode": "roof_only",
        "relief_c": {"low": 1.0, "central": 2.0, "high": 3.0},
        "parameter": {"key": "substrate_depth_cm", "label": "soil depth", "unit": "cm", "default": 15.0, "min": 6.0, "max": 60.0},
    },
    "canopy_protection": {
        "label": "Existing-canopy protection", "impact_mode": "existing_canopy",
        "relief_c": {"low": 2.0, "central": 5.0, "high": 10.0},
        "parameter": {"key": "maturity_pct", "label": "retained", "unit": "%", "default": 100.0, "min": 20.0, "max": 100.0},
    },
    "permeable_pavement": {
        "label": "Permeable pavement", "impact_mode": "treatment",
        "relief_c": {"low": 0.5, "central": 1.5, "high": 3.0},
        "parameter": {"key": "runoff_capture_mm", "label": "storm capture", "unit": "mm", "default": 25.0, "min": 5.0, "max": 100.0},
    },
    "rain_garden": {
        "label": "Rain garden / bioswale", "impact_mode": "cooling_buffer",
        "relief_c": {"low": 1.0, "central": 2.5, "high": 5.0},
        "parameter": {"key": "influence_m", "label": "cooling reach", "unit": "m", "default": 6.0, "min": 2.0, "max": 20.0},
    },
    "depave_plant": {
        "label": "De-pave and plant", "impact_mode": "cooling_buffer",
        "relief_c": {"low": 1.5, "central": 3.5, "high": 6.0},
        "parameter": {"key": "influence_m", "label": "cooling reach", "unit": "m", "default": 4.0, "min": 1.0, "max": 15.0},
    },
    "water_feature": {
        "label": "Water feature", "impact_mode": "cooling_buffer",
        "relief_c": {"low": 0.5, "central": 2.0, "high": 4.0},
        "parameter": {"key": "influence_m", "label": "cooling reach", "unit": "m", "default": 8.0, "min": 2.0, "max": 25.0},
    },
}
SHADE_METHODS = {"added_canopy", "constructed_shade", "canopy_protection"}
PEDESTRIAN_FACTOR = {
    "added_canopy": 0.35, "constructed_shade": 0.35, "cool_pavement": 0.10,
    "green_roof": 0.0, "canopy_protection": 0.35, "permeable_pavement": 0.08,
    "rain_garden": 0.20, "depave_plant": 0.25, "water_feature": 0.18,
}


@functools.lru_cache(maxsize=4)
def _transformer(source_crs: str) -> Transformer:
    return Transformer.from_crs(source_crs, LOCAL_CRS, always_xy=True)


def _localize(raw_geometry: dict[str, Any], source_crs: str) -> Any:
    config = load_viewer_config()
    transformer = _transformer(source_crs)
    origin_x, origin_y = config["origin"]
    projected = transform_geometry(transformer.transform, shape(raw_geometry))
    return transform_geometry(lambda x, y, z=None: (x - origin_x, -(y - origin_y)), projected)


@functools.lru_cache(maxsize=1)
def _reference_layers() -> dict[str, Any]:
    bounds = tuple(load_viewer_config()["bounds"])
    scene_clip = box(bounds[0], bounds[1], bounds[2], bounds[3])
    heat_source = json.loads(HEAT_PATH.read_text(encoding="utf-8"))
    heat = []
    for feature in heat_source.get("features", []):
        geometry = _localize(feature["geometry"], WEB_CRS).intersection(scene_clip).simplify(1.0, preserve_topology=True)
        if geometry.is_empty:
            continue
        properties = feature.get("properties") or {}
        heat.append({
            "geometry": geometry,
            "surface_c": float(properties.get("heat_model_lst_c") or 0.0),
            "air_c": float(properties.get("air_temp_c") or 20.71),
            "pedestrian_c": float(properties.get("pedestrian_heat_exposure_c") or 0.0),
            "land_type": properties.get("land_type"),
        })

    scene_source = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
    buildings = [Polygon(record[2]) for record in scene_source.get("buildings", []) if len(record[2]) >= 3]

    canopy_source = json.loads(CANOPY_ASSET_PATH.read_text(encoding="utf-8"))
    canopies = []
    for record in canopy_source.get("canopies", []):
        rings = record[5]
        if rings and len(rings[0]) >= 3:
            geometry = Polygon(rings[0], rings[1:])
            if geometry.is_valid and not geometry.is_empty:
                canopies.append(geometry)
    return {
        "heat": heat,
        "buildings": unary_union(buildings),
        "canopies": unary_union(canopies),
        "scene": scene_clip,
    }


def _polygon(payload: dict[str, Any]) -> Any:
    geometry = shape(payload)
    if geometry.geom_type not in {"Polygon", "MultiPolygon"} or geometry.is_empty:
        raise ValueError("intervention geometry must be a non-empty Polygon or MultiPolygon")
    if not geometry.is_valid:
        geometry = geometry.buffer(0)
    if geometry.is_empty or not geometry.is_valid or geometry.area < 1.0:
        raise ValueError("intervention geometry must be valid and at least 1 m²")
    return geometry


def _sun(date_text: str, minutes: int) -> tuple[float, float, float]:
    """Return altitude and local east/south horizontal unit components."""
    from datetime import date

    selected = date.fromisoformat(date_text)
    day_of_year = selected.timetuple().tm_yday
    hour = minutes / 60.0
    gamma = 2 * math.pi / 365 * (day_of_year - 1 + (hour - 12) / 24)
    equation = 229.18 * (
        0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma)
    )
    declination = (
        0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma)
    )
    latitude = math.radians(-33.9249)
    solar_minutes = minutes + equation + 4 * 18.4241 - 120
    hour_angle = math.radians(solar_minutes / 4 - 180)
    altitude = math.asin(max(-1.0, min(1.0, math.sin(latitude) * math.sin(declination) + math.cos(latitude) * math.cos(declination) * math.cos(hour_angle))))
    azimuth = (math.atan2(math.sin(hour_angle), math.cos(hour_angle) * math.sin(latitude) - math.tan(declination) * math.cos(latitude)) + math.pi) % (2 * math.pi)
    return altitude, math.sin(azimuth) * math.cos(altitude), -math.cos(azimuth) * math.cos(altitude)


def _translate_shadow(geometry: Any, height: float, altitude: float, sun_x: float, sun_z: float) -> Any:
    if altitude <= 0.008:
        return Polygon()
    distance = height / max(math.tan(altitude), 0.03)
    length = math.hypot(sun_x, sun_z) or 1.0
    dx, dz = -sun_x / length * distance, -sun_z / length * distance
    return transform_geometry(lambda x, y, z=None: (x + dx, y + dz), geometry)


def _parameter_value(item: dict[str, Any], method: str) -> float:
    parameter = ASSUMPTIONS[method]["parameter"]
    value = float(item.get(parameter["key"], parameter["default"]))
    return max(float(parameter["min"]), min(float(parameter["max"]), value))


def _effect_scale(item: dict[str, Any], method: str) -> float:
    value = _parameter_value(item, method)
    if method in {"added_canopy", "canopy_protection"}:
        return value / 100.0
    if method == "cool_pavement":
        return max(0.25, min(1.75, (value - 0.15) / 0.20))
    if method == "green_roof":
        return max(0.5, min(1.4, value / 15.0))
    if method == "permeable_pavement":
        return max(0.5, min(1.5, value / 25.0))
    return 1.0


def mitigation_preview(payload: dict[str, Any]) -> dict[str, Any]:
    interventions = payload.get("interventions")
    if not isinstance(interventions, list) or not interventions:
        raise ValueError("at least one intervention is required")
    date_text = str(payload.get("sun_date") or "2026-01-15")
    minutes = int(payload.get("sun_minutes", 720))
    if minutes < 0 or minutes >= 1440:
        raise ValueError("sun_minutes must be between 0 and 1439")
    altitude, sun_x, sun_z = _sun(date_text, minutes)
    layers = _reference_layers()
    scene_geometry = layers.get("scene")
    if scene_geometry is None:
        scene_geometry = unary_union([zone["geometry"] for zone in layers["heat"]])
    normalized = []
    warnings: list[str] = []
    for index, item in enumerate(interventions):
        method = str(item.get("method") or "")
        if method not in ASSUMPTIONS:
            raise ValueError(f"unsupported intervention method: {method}")
        geometry = _polygon(item.get("geometry") or {})
        assumption = ASSUMPTIONS[method]
        height = float(item.get("height_m") or (8.0 if method == "added_canopy" else 3.0))
        treatment = geometry.intersection(scene_geometry)
        if method == "green_roof":
            treatment = geometry.intersection(layers["buildings"])
            if treatment.is_empty:
                warnings.append(f"Intervention {index + 1} does not intersect an eligible building roof.")
        elif method == "canopy_protection":
            treatment = geometry.intersection(layers["canopies"])
            if treatment.is_empty:
                warnings.append(f"Intervention {index + 1} does not intersect existing canopy.")
        elif method not in {"constructed_shade", "cool_pavement"}:
            treatment = treatment.difference(layers["buildings"])
            if treatment.is_empty:
                warnings.append(f"Intervention {index + 1} falls entirely on building footprints.")
        impact = treatment
        if method in SHADE_METHODS:
            impact = unary_union([treatment, _translate_shadow(treatment, height, altitude, sun_x, sun_z)])
        elif assumption["impact_mode"] == "cooling_buffer":
            impact = treatment.buffer(_parameter_value(item, method), cap_style=1, join_style=1).intersection(scene_geometry)
        normalized.append({
            "id": str(item.get("id") or f"intervention-{index + 1}"),
            "method": method,
            "height_m": height,
            "treatment": treatment,
            "impact": impact,
            "parameter_value": _parameter_value(item, method),
            "effect_scale": _effect_scale(item, method),
        })

    zones = []
    aggregate = {case: {"weighted_surface": 0.0, "weighted_pedestrian": 0.0} for case in ("low", "central", "high")}
    affected_area = 0.0
    affected_zone_count = 0
    baseline_weighted = 0.0
    peak_reduction = {case: 0.0 for case in ("low", "central", "high")}
    for zone_index, zone in enumerate(layers["heat"]):
        zone_area = zone["geometry"].area
        if zone_area <= 0:
            continue
        overlaps = []
        for item in normalized:
            overlap = zone["geometry"].intersection(item["impact"]).area
            if overlap > 0:
                overlaps.append((item, min(1.0, overlap / zone_area)))
        if not overlaps:
            unchanged = {
                case: {
                    "surface_temperature_c": round(zone["surface_c"], 3),
                    "surface_reduction_c": 0.0,
                    "pedestrian_heat_exposure_c": round(zone["pedestrian_c"], 3),
                    "pedestrian_reduction_c": 0.0,
                }
                for case in ("low", "central", "high")
            }
            zones.append({
                "id": zone_index,
                "geometry": mapping(zone["geometry"]),
                "baseline_surface_temperature_c": zone["surface_c"],
                "affected_area_m2": 0.0,
                "estimates": unchanged,
            })
            continue
        affected = unary_union([zone["geometry"].intersection(item["impact"]) for item, _ in overlaps]).area
        affected_zone_count += 1
        affected_area += affected
        baseline_weighted += zone["surface_c"] * affected
        estimates = {}
        for case in ("low", "central", "high"):
            remaining = 1.0
            reduction = 0.0
            pedestrian_reduction = 0.0
            local_peak = 0.0
            for item, fraction in sorted(overlaps, key=lambda entry: ASSUMPTIONS[entry[0]["method"]]["relief_c"][case], reverse=True):
                effective_fraction = min(remaining, fraction)
                relief = ASSUMPTIONS[item["method"]]["relief_c"][case] * item["effect_scale"]
                if item["method"] in SHADE_METHODS:
                    relief *= max(0.0, math.sin(altitude))
                local_peak = max(local_peak, relief)
                reduction += relief * effective_fraction
                pedestrian_reduction += relief * PEDESTRIAN_FACTOR[item["method"]] * effective_fraction
                remaining = max(0.0, remaining - effective_fraction)
            maximum = max(0.0, zone["surface_c"] - zone["air_c"])
            reduction = min(reduction, maximum)
            after = zone["surface_c"] - reduction
            estimates[case] = {
                "surface_temperature_c": round(after, 3),
                "surface_reduction_c": round(reduction, 3),
                "pedestrian_heat_exposure_c": round(max(0.0, zone["pedestrian_c"] - pedestrian_reduction), 3),
                "pedestrian_reduction_c": round(pedestrian_reduction, 3),
            }
            # ``reduction`` is the zone-average delta (already multiplied by
            # overlap fraction), so weight it by the whole zone to recover the
            # actual degree-square-metres over the affected geometry.
            aggregate[case]["weighted_surface"] += reduction * zone_area
            aggregate[case]["weighted_pedestrian"] += pedestrian_reduction * zone_area
            peak_reduction[case] = max(peak_reduction[case], min(local_peak, maximum))
        zones.append({
            "id": zone_index,
            "geometry": mapping(zone["geometry"]),
            "baseline_surface_temperature_c": zone["surface_c"],
            "affected_area_m2": round(affected, 2),
            "estimates": estimates,
        })

    per_intervention = []
    total_runoff_capture_m3 = 0.0
    total_added_canopy_m2 = 0.0
    for item in normalized:
        assumption = ASSUMPTIONS[item["method"]]
        method = item["method"]
        runoff_depth_mm = 0.0
        if method == "permeable_pavement":
            runoff_depth_mm = item["parameter_value"]
        elif method == "rain_garden":
            runoff_depth_mm = 35.0
        elif method == "depave_plant":
            runoff_depth_mm = 20.0
        elif method == "green_roof":
            runoff_depth_mm = min(40.0, item["parameter_value"] * 2.0)
        runoff_capture_m3 = item["treatment"].area * runoff_depth_mm / 1000.0
        added_canopy_m2 = item["treatment"].area * item["effect_scale"] if method == "added_canopy" else 0.0
        total_runoff_capture_m3 += runoff_capture_m3
        total_added_canopy_m2 += added_canopy_m2
        per_intervention.append({
            "id": item["id"],
            "method": item["method"],
            "label": assumption["label"],
            "treated_area_m2": round(item["treatment"].area, 2),
            "affected_or_shaded_area_m2": round(item["impact"].area, 2),
            "treatment_geometry": mapping(item["treatment"]),
            "impact_geometry": mapping(item["impact"]),
            "relief_c": assumption["relief_c"],
            "parameter": {
                **assumption["parameter"],
                "value": item["parameter_value"],
            },
            "co_benefits": {
                "conceptual_runoff_capture_m3": round(runoff_capture_m3, 2),
                "added_canopy_m2": round(added_canopy_m2, 2),
            },
        })
    summary_cases = {}
    for case in ("low", "central", "high"):
        divisor = affected_area or 1.0
        summary_cases[case] = {
            "mean_surface_reduction_c": round(aggregate[case]["weighted_surface"] / divisor, 3),
            "peak_surface_reduction_c": round(peak_reduction[case], 3),
            "mean_pedestrian_reduction_c": round(aggregate[case]["weighted_pedestrian"] / divisor, 3),
            "mean_after_surface_temperature_c": round((baseline_weighted - aggregate[case]["weighted_surface"]) / divisor, 3) if affected_area else None,
        }
    return {
        "version": ASSUMPTION_VERSION,
        "status": "planning_estimate_not_measured_or_engineering_grade",
        "metric": payload.get("baseline_metric") or "heat_model_lst_c",
        "sun": {"date": date_text, "minutes": minutes, "altitude_deg": round(math.degrees(altitude), 2), "daylight": altitude > 0.008},
        "summary": {
            "treated_area_m2": round(unary_union([item["treatment"] for item in normalized]).area, 2),
            "affected_area_m2": round(affected_area, 2),
            "affected_zone_count": affected_zone_count,
            "baseline_mean_surface_temperature_c": round(baseline_weighted / (affected_area or 1.0), 3) if affected_area else None,
            "estimates": summary_cases,
            "co_benefits": {
                "conceptual_runoff_capture_m3": round(total_runoff_capture_m3, 2),
                "added_canopy_m2": round(total_added_canopy_m2, 2),
            },
        },
        "interventions": per_intervention,
        "zones": zones,
        "warnings": warnings,
        "assumptions": ASSUMPTIONS,
        "notes": [
            "Temperature effects are literature-bounded planning estimates, not local measurements.",
            "Shade effects scale with solar altitude and are zero when the sun is below the horizon.",
            "Green-roof results describe roof surfaces and do not claim a pedestrian-level air-temperature benefit.",
            "Stormwater capture is a geometric concept estimate; it does not model soils, drainage capacity, or overflow routing.",
            "Water-feature cooling does not include potable-water demand or drought restrictions.",
        ],
    }
