"""Thermal category area-time summaries for the historical composite product.

The historical rasters are monthly/local-hour *mean-condition composites*.
The returned equivalent hours therefore describe classified composite cells,
not observed hourly exceedance frequencies or a typical person's exposure.
"""

from __future__ import annotations

from functools import lru_cache
import math
from typing import Any

import numpy as np

from .thermal_climatology import PRODUCT_ROOT, frame_path, manifest


BANDS = (
    ("cold_stress", "Cold stress", -math.inf, 9.0),
    ("no_thermal_stress", "No thermal stress", 9.0, 26.0),
    ("heat_stress", "Heat stress", 26.0, math.inf),
)


@lru_cache(maxsize=4)
def _all_frame_stats(generated_at: str) -> dict[str, dict[str, float]]:
    """Read the published raster frames once and cache valid-cell band shares."""
    payload = manifest()
    grid = payload["grid"]
    channels = payload["channels"]
    channel_index = next((i for i, row in enumerate(channels) if row.get("name") == "utci_c"), None)
    if channel_index is None:
        raise ValueError("historical thermal product has no UTCI channel")
    width, height = int(grid["width"]), int(grid["height"])
    channel_count = len(channels)
    expected = width * height * channel_count
    scale = float(channels[channel_index].get("scale", 1.0))
    offset = float(channels[channel_index].get("offset", 0.0))
    nodata = int(payload.get("nodata", -32768))
    output: dict[str, dict[str, float]] = {}
    for row in payload.get("frames", []):
        identifier = str(row.get("id", ""))
        raw = np.fromfile(frame_path(identifier), dtype="<i2")
        if raw.size != expected:
            raise ValueError(f"historical thermal frame {identifier} has an invalid size")
        values = raw.reshape((height * width, channel_count))[:, channel_index]
        valid = values != nodata
        count = int(valid.sum())
        if count == 0:
            continue
        utci = values[valid].astype(np.float32) * scale + offset
        stats: dict[str, float] = {"valid_cells": float(count)}
        for key, _, lower, upper in BANDS:
            stats[key] = float(np.count_nonzero((utci >= lower) & (utci < upper)) / count)
        output[identifier] = stats
    return output


def category_area_time(
    aggregate: str = "annual", month: int = 1, season: str = "summer",
) -> dict[str, Any]:
    """Summarize representative-year category area-hours for a selected period."""
    payload = manifest()
    baseline = payload.get("baseline", {})
    start_year, end_year = int(baseline.get("start_year", 2016)), int(baseline.get("end_year", 2025))
    if aggregate not in {"month", "season", "annual"}:
        raise ValueError("aggregate must be month, season, or annual")
    if not 1 <= int(month) <= 12:
        raise ValueError("month must be between 1 and 12")
    season_months = {
        "summer": (12, 1, 2), "autumn": (3, 4, 5),
        "winter": (6, 7, 8), "spring": (9, 10, 11),
    }
    if season not in season_months:
        raise ValueError("season must be summer, autumn, winter, or spring")
    months = (int(month),) if aggregate == "month" else season_months[season] if aggregate == "season" else tuple(range(1, 13))
    years = tuple(range(start_year, end_year + 1))
    days_by_month = {
        m: sum(29 if m == 2 and _is_leap(y) else (28 if m == 2 else (30 if m in {4, 6, 9, 11} else 31)) for y in years) / len(years)
        for m in months
    }
    stats_by_frame = _all_frame_stats(str(payload.get("generated_at", "")))
    cell_area_ha = float(payload["grid"]["resolution_m"]) ** 2 / 10000.0
    totals = {key: 0.0 for key, *_ in BANDS}
    valid_area_hours = 0.0
    elapsed_hours = 0.0
    observed_composite_hours = 0
    for row in payload.get("frames", []):
        frame_month = int(row.get("month", 0))
        if frame_month not in months:
            continue
        stats = stats_by_frame.get(str(row.get("id", "")))
        if not stats:
            continue
        weight_hours = days_by_month[frame_month]
        valid_cells = stats["valid_cells"]
        valid_area_hours += valid_cells * cell_area_ha * weight_hours
        for key, *_ in BANDS:
            totals[key] += stats[key] * valid_cells * cell_area_ha * weight_hours
        elapsed_hours += weight_hours
        observed_composite_hours += 1
    expected_frames = len(months) * 24
    if observed_composite_hours != expected_frames:
        raise ValueError(
            f"selected period has {observed_composite_hours} of {expected_frames} required monthly-hour UTCI frames"
        )
    if elapsed_hours <= 0 or valid_area_hours <= 0:
        raise ValueError("no valid UTCI frames are available for that period")
    band_results = []
    total_hours = sum(days_by_month.values()) * 24.0
    for key, label, lower, upper in BANDS:
        area_hours = totals[key]
        band_results.append({
            "id": key, "label": label,
            "utci_min_c": None if math.isinf(lower) else lower,
            "utci_max_c_exclusive": None if math.isinf(upper) else upper,
            "area_time_share_pct": round(area_hours / valid_area_hours * 100.0, 2),
            "equivalent_hours_per_mapped_cell": round(area_hours / (valid_area_hours / total_hours), 1),
            "area_hours_ha": round(area_hours, 1),
        })
    return {
        "status": "composite_area_time_estimate",
        "validation_status": payload.get("validation_status"),
        "aggregate": aggregate, "season": season if aggregate == "season" else None,
        "month": int(month) if aggregate == "month" else None,
        "months": list(months), "baseline_years": [start_year, end_year],
        "representative_period_hours": round(total_hours, 1),
        "composite_frames_used": observed_composite_hours,
        "expected_composite_frames": expected_frames,
        "analysis_area_ha": round(valid_area_hours / total_hours, 2),
        "bands": band_results,
        "method": "Each monthly/local-hour mean-condition UTCI composite is classified by standard UTCI stress bands and weighted by average calendar days in that month over the baseline. These are area-time estimates from composites, not observed hourly category frequencies.",
    }


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
