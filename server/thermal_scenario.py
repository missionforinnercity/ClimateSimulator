"""Shade intervention screening against a published thermal forecast frame."""

from __future__ import annotations

import json
import math
from typing import Any, Literal

import numpy as np

from .thermal_products import (
    ThermalProductUnavailable, _decode_frame, _frame_record, frame_path, load_manifest,
    utci_category,
)

STEFAN_BOLTZMANN = 5.670374419e-8


def shade_scenario(
    run_id: str, frame_id: str, x: float, z: float, radius_m: float,
    shade_percent: float, intervention: Literal["tree", "shade"],
) -> tuple[bytes, dict[str, Any]]:
    """Return a signed UTCI-difference raster and impact summary.

    This is a screening estimate: extra direct-solar attenuation is translated
    to mean radiant temperature with a fixed pedestrian projection/absorption
    factor. It does not rerun SOLWEIG or model canopy evapotranspiration.
    """
    manifest = load_manifest(run_id)
    record = _frame_record(manifest, frame_id)
    grid = manifest["grid"]
    min_x, min_z, max_x, max_z = map(float, grid["bounds"])
    resolution = float(grid["resolution_m"])
    if not all(math.isfinite(value) for value in (x, z, radius_m, shade_percent)):
        raise ValueError("scenario coordinates and settings must be finite")
    if not (min_x <= x < max_x and min_z <= z < max_z):
        raise ValueError("intervention centre is outside the thermal grid")
    if not 2 <= radius_m <= 80 or not 1 <= shade_percent <= 100:
        raise ValueError("scenario radius or shade percentage is outside supported bounds")

    channels = {item["name"]: index for index, item in enumerate(manifest["channels"])}
    required = ("tmrt_c", "utci_c", "shadow_fraction", "wind_10m_mps")
    if any(name not in channels for name in required):
        raise ThermalProductUnavailable("forecast frame does not contain scenario inputs")
    forcing = record.get("forcing", {}).get("inputs", {})
    air = forcing.get("temperature_2m_c")
    humidity = forcing.get("relative_humidity_2m_pct")
    direct = forcing.get("direct_radiation_wm2")
    if any(value is None for value in (air, humidity, direct)):
        raise ThermalProductUnavailable("forecast frame is missing air or radiation inputs")

    frame = _decode_frame(manifest, frame_path(run_id, frame_id))
    nodata = int(manifest.get("nodata", -32768))
    valid = np.all(frame != nodata, axis=2)
    height, width = frame.shape[:2]
    columns = np.arange(width, dtype=np.float32)[None, :]
    rows = np.arange(height, dtype=np.float32)[:, None]
    cell_x = min_x + (columns + 0.5) * resolution
    cell_z = min_z + (rows + 0.5) * resolution
    distance = np.hypot(cell_x - x, cell_z - z)
    inside = distance <= radius_m
    # A tapered crown profile avoids a hard circular edge. Shade structures
    # use a more uniform footprint with a narrow edge transition.
    radial = np.clip(1.0 - distance / radius_m, 0.0, 1.0)
    shape = np.sqrt(radial) if intervention == "tree" else np.clip((radius_m - distance) / max(resolution * 1.5, 1), 0, 1)
    tmrt = frame[:, :, channels["tmrt_c"]].astype(np.float32) * 0.1
    original_utci = frame[:, :, channels["utci_c"]].astype(np.float32) * 0.1
    current_shadow = frame[:, :, channels["shadow_fraction"]].astype(np.float32) * 0.0001
    added_shade = np.where(inside, (shade_percent / 100.0) * shape * (1.0 - current_shadow), 0.0)
    # SOLWEIG Tmrt includes shortwave. This first-order screening conversion
    # reduces equivalent radiant load using a fixed projected-body factor.
    removed_radiant_wm2 = max(0.0, float(direct)) * added_shade * 0.175
    kelvin = tmrt + 273.15
    adjusted_tmrt = np.power(np.maximum(kelvin ** 4 - removed_radiant_wm2 / (0.95 * STEFAN_BOLTZMANN), 1.0), 0.25) - 273.15
    affected = valid & inside
    delta = np.zeros((height, width), dtype=np.float32)
    if np.any(affected):
        from .thermal_worker import calculate_utci

        wind = frame[:, :, channels["wind_10m_mps"]].astype(np.float32) * 0.01
        after = calculate_utci(
            float(air), adjusted_tmrt[affected], wind[affected], float(humidity),
        )
        delta[affected] = after - original_utci[affected]

    encoded = np.full((height, width), nodata, dtype="<i2")
    encoded[valid] = np.clip(np.rint(delta[valid] * 10), -32767, 32767).astype("<i2")
    before = original_utci[affected]
    after = before + delta[affected]
    pixel_area = resolution * resolution
    summary = {
        "intervention": intervention,
        "radius_m": radius_m,
        "shade_percent": shade_percent,
        "center": {"x": x, "z": z},
        "scenario_method": "screening_direct_solar_attenuation_fixed_body_projection",
        "affected_cells": int(affected.sum()),
        "area_m2": round(float(affected.sum()) * pixel_area, 1),
        "mean_utci_before_c": round(float(np.mean(before)), 2) if before.size else None,
        "mean_utci_after_c": round(float(np.mean(after)), 2) if after.size else None,
        "mean_utci_delta_c": round(float(np.mean(delta[affected])), 2) if before.size else None,
        "max_utci_reduction_c": round(float(max(0.0, -np.min(delta[affected]))), 2) if before.size else None,
        "hot_area_before_m2": round(float(np.count_nonzero(before >= 32)) * pixel_area, 1),
        "hot_area_after_m2": round(float(np.count_nonzero(after >= 32)) * pixel_area, 1),
        "hot_area_change_m2": round(float(np.count_nonzero(after >= 32) - np.count_nonzero(before >= 32)) * pixel_area, 1),
        "note": "Experimental modelled estimate; added shade only. No vegetation evapotranspiration or SOLWEIG geometry rerun.",
        "utci_category_after": utci_category(float(np.mean(after))) if after.size else None,
    }
    return encoded.tobytes(order="C"), summary
