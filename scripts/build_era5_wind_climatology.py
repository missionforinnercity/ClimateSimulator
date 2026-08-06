#!/usr/bin/env python3
"""Build a compact Cape Town wind climatology from an ERA5 GRIB archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from scipy.stats import weibull_min

SECTORS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")
SEASONS = {12: "summer", 1: "summer", 2: "summer", 3: "autumn", 4: "autumn", 5: "autumn", 6: "winter", 7: "winter", 8: "winter", 9: "spring", 10: "spring", 11: "spring"}


def bilinear_cell(array: np.ndarray, transform, longitude: float, latitude: float) -> float:
    column = (longitude - transform.c) / transform.a - 0.5
    row = (latitude - transform.f) / transform.e - 0.5
    column = float(np.clip(column, 0.0, array.shape[1] - 1.001))
    row = float(np.clip(row, 0.0, array.shape[0] - 1.001))
    c0, r0 = int(column), int(row)
    c1, r1 = min(c0 + 1, array.shape[1] - 1), min(r0 + 1, array.shape[0] - 1)
    fc, fr = column - c0, row - r0
    return float(
        (array[r0, c0] * (1 - fc) + array[r0, c1] * fc) * (1 - fr)
        + (array[r1, c0] * (1 - fc) + array[r1, c1] * fc) * fr
    )


def meteorological_direction(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    return np.mod(np.degrees(np.arctan2(-u, -v)), 360.0)


def stability_class(actual_speed: np.ndarray, neutral_speed: np.ndarray) -> np.ndarray:
    # ECMWF defines neutral wind as slower than actual wind in stable air and
    # faster in unstable air. A dead-band avoids classifying tiny differences.
    ratio = neutral_speed / np.maximum(actual_speed, 0.25)
    return np.where(ratio > 1.03, "unstable", np.where(ratio < 0.97, "stable", "neutral"))


def sector_index(direction_deg: np.ndarray) -> np.ndarray:
    return np.mod(np.floor((direction_deg + 11.25) / 22.5).astype(int), 16)


def profile(speed: np.ndarray, gust: np.ndarray, shear: np.ndarray, count_total: int) -> dict | None:
    if len(speed) < 8:
        return None
    positive = speed[speed > 0.05]
    if len(positive) >= 8:
        shape, _, scale = weibull_min.fit(positive, floc=0.0)
    else:
        shape, scale = 2.0, float(np.mean(speed))
    gust_factor = gust / np.maximum(speed, 0.5)
    return {
        "sample_count": int(len(speed)),
        "frequency_fraction": round(float(len(speed) / max(1, count_total)), 6),
        "mean_speed_mps": round(float(np.mean(speed)), 4),
        "p50_speed_mps": round(float(np.quantile(speed, 0.5)), 4),
        "p95_speed_mps": round(float(np.quantile(speed, 0.95)), 4),
        "p95_gust_mps": round(float(np.quantile(gust, 0.95)), 4),
        "p95_gust_factor": round(float(np.quantile(gust_factor, 0.95)), 4),
        "median_shear_exponent_10_100m": round(float(np.median(shear)), 4),
        "weibull_shape": round(float(np.clip(shape, 0.5, 10.0)), 4),
        "weibull_scale_mps": round(float(max(scale, 0.0)), 4),
    }


def build(input_paths: list[Path], longitude: float, latitude: float) -> dict:
    time_parts, value_parts = [], []
    bounds = grid_shape = transform = None
    expected_elements = ["10U", "10V", "var246", "var247", "var131", "var132", "var49", "I10FG"]
    digest = hashlib.sha256()
    for input_path in input_paths:
        digest.update(input_path.read_bytes())
        with rasterio.open(input_path) as source:
            if source.count % 8:
                raise ValueError(f"expected 8 GRIB messages per timestamp in {input_path}, found {source.count} total")
            actual = [source.tags(index).get("GRIB_ELEMENT", "") for index in range(1, 9)]
            for expected, value in zip(expected_elements, actual):
                if expected not in value:
                    raise ValueError(f"unexpected GRIB message order in {input_path}: expected {expected}, found {value}")
            time_parts.append(np.asarray([int(source.tags(i)["GRIB_VALID_TIME"]) for i in range(1, source.count + 1, 8)]))
            transform, bounds, grid_shape = source.transform, source.bounds, source.shape
            # Reading all messages in one GDAL call can cause excessive
            # decoder memory use. Read one parameter sequence at a time.
            columns = []
            for offset in range(1, 9):
                parameter_cube = source.read(list(range(offset, source.count + 1, 8)))
                columns.append(np.asarray([
                    bilinear_cell(array, transform, longitude, latitude) for array in parameter_cube
                ]))
            value_parts.append(np.column_stack(columns))

    times = np.concatenate(time_parts)
    values = np.concatenate(value_parts)
    order = np.argsort(times)
    times, values = times[order], values[order]
    unique = np.concatenate(([True], np.diff(times) != 0))
    times, values = times[unique], values[unique]
    u10, v10, u100, v100, u10n, v10n, gust_max, gust_instant = values.T
    speed10 = np.hypot(u10, v10)
    speed100 = np.hypot(u100, v100)
    neutral_speed = np.hypot(u10n, v10n)
    gust = np.maximum(gust_max, gust_instant)
    directions = meteorological_direction(u10, v10)
    sectors = sector_index(directions)
    stability = stability_class(speed10, neutral_speed)
    shear = np.clip(np.log(np.maximum(speed100, 0.2) / np.maximum(speed10, 0.2)) / math.log(10.0), 0.05, 0.60)
    datetimes = [datetime.fromtimestamp(int(value), timezone.utc) for value in times]
    seasons = np.asarray([SEASONS[item.month] for item in datetimes])

    result_profiles = {}
    for season in ("annual", "summer", "autumn", "winter", "spring"):
        season_mask = np.ones(len(times), dtype=bool) if season == "annual" else seasons == season
        result_profiles[season] = {}
        for stability_name in ("all", "unstable", "neutral", "stable"):
            group_mask = season_mask if stability_name == "all" else season_mask & (stability == stability_name)
            total = int(np.count_nonzero(group_mask))
            sector_profiles = {}
            for index, name in enumerate(SECTORS):
                mask = group_mask & (sectors == index)
                item = profile(speed10[mask], gust[mask], shear[mask], total)
                if item is not None:
                    item["mean_direction_deg"] = round(float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians(directions[mask]))))) % 360), 2)
                    sector_profiles[name.lower()] = item
            result_profiles[season][stability_name] = {"sample_count": total, "sectors": sector_profiles}

    first, last = datetimes[0], datetimes[-1]
    expected_hours = int((last - first).total_seconds() // 3600) + 1
    return {
        "version": "era5-cape-town-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "kind": "ERA5_GRIB",
            "paths": [str(path) for path in input_paths],
            "sha256": digest.hexdigest(),
            "variables": ["10u", "10v", "100u", "100v", "u10n", "v10n", "10fg", "i10fg"],
        },
        "location": {"longitude": longitude, "latitude": latitude, "sampling": "bilinear_clamped_to_grid_centres"},
        "grid": {"bounds": list(bounds), "shape": list(grid_shape), "resolution_deg": [abs(transform.a), abs(transform.e)]},
        "coverage": {
            "start_utc": first.isoformat(), "end_utc": last.isoformat(), "records": len(times),
            "expected_hourly_records": expected_hours,
            "hourly_coverage_fraction": round(len(times) / expected_hours, 6),
            "sampled_utc_hours": sorted({item.hour for item in datetimes}),
            "complete_hourly_climatology": len(times) == expected_hours,
        },
        "stability_method": "ERA5 neutral/actual 10 m speed ratio with 3% dead-band",
        "profiles": result_profiles,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", nargs="+", type=Path, default=[Path("data/Era5data.grib")])
    parser.add_argument("--output", type=Path, default=Path("data/wind_climatology/cape_town_era5.json"))
    parser.add_argument("--longitude", type=float, default=18.4241)
    parser.add_argument("--latitude", type=float, default=-33.9249)
    args = parser.parse_args()
    inputs = []
    for path in args.input:
        if path.is_dir():
            inputs.extend(sorted(path.glob("*.grib")))
        else:
            inputs.append(path)
    if not inputs:
        raise SystemExit("no GRIB input files found")
    result = build(inputs, args.longitude, args.latitude)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output} ({result['coverage']['records']} records; {result['coverage']['hourly_coverage_fraction']:.1%} hourly coverage)")


if __name__ == "__main__":
    main()
