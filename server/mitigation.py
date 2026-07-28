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
ASSUMPTION_VERSION = "planning-estimates-2026-07-v1"
ASSUMPTIONS = {
    "added_canopy": {"label": "Added mature canopy", "relief_c": {"low": 2.0, "central": 5.0, "high": 10.0}},
    "constructed_shade": {"label": "Constructed shade", "relief_c": {"low": 3.0, "central": 6.0, "high": 10.0}},
    "cool_pavement": {"label": "Cool pavement", "relief_c": {"low": 5.0, "central": 7.0, "high": 15.0}},
    "green_roof": {"label": "Green roof", "relief_c": {"low": 1.0, "central": 2.0, "high": 3.0}},
    "canopy_protection": {"label": "Existing-canopy protection", "relief_c": {"low": 2.0, "central": 5.0, "high": 10.0}},
}
SHADE_METHODS = {"added_canopy", "constructed_shade", "canopy_protection"}
PEDESTRIAN_FACTOR = {"added_canopy": 0.35, "constructed_shade": 0.35, "cool_pavement": 0.10, "green_roof": 0.0, "canopy_protection": 0.35}


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
    return {"heat": heat, "buildings": unary_union(buildings), "canopies": unary_union(canopies)}


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
    normalized = []
    warnings: list[str] = []
    for index, item in enumerate(interventions):
        method = str(item.get("method") or "")
        if method not in ASSUMPTIONS:
            raise ValueError(f"unsupported intervention method: {method}")
        geometry = _polygon(item.get("geometry") or {})
        height = float(item.get("height_m") or (8.0 if method == "added_canopy" else 3.0))
        treatment = geometry
        if method == "green_roof":
            treatment = geometry.intersection(layers["buildings"])
            if treatment.is_empty:
                warnings.append(f"Intervention {index + 1} does not intersect an eligible building roof.")
        elif method == "canopy_protection":
            treatment = geometry.intersection(layers["canopies"])
            if treatment.is_empty:
                warnings.append(f"Intervention {index + 1} does not intersect existing canopy.")
        shadow = unary_union([treatment, _translate_shadow(treatment, height, altitude, sun_x, sun_z)]) if method in SHADE_METHODS else treatment
        normalized.append({
            "id": str(item.get("id") or f"intervention-{index + 1}"),
            "method": method,
            "height_m": height,
            "treatment": treatment,
            "impact": shadow,
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
                relief = ASSUMPTIONS[item["method"]]["relief_c"][case]
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
    for item in normalized:
        assumption = ASSUMPTIONS[item["method"]]
        per_intervention.append({
            "id": item["id"],
            "method": item["method"],
            "label": assumption["label"],
            "treated_area_m2": round(item["treatment"].area, 2),
            "affected_or_shaded_area_m2": round(item["impact"].area, 2),
            "treatment_geometry": mapping(item["treatment"]),
            "impact_geometry": mapping(item["impact"]),
            "relief_c": assumption["relief_c"],
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
        },
        "interventions": per_intervention,
        "zones": zones,
        "warnings": warnings,
        "assumptions": ASSUMPTIONS,
        "notes": [
            "Temperature effects are literature-bounded planning estimates, not local measurements.",
            "Shade effects scale with solar altitude and are zero when the sun is below the horizon.",
            "Green-roof results describe roof surfaces and do not claim a pedestrian-level air-temperature benefit.",
        ],
    }
