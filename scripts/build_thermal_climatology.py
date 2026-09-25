#!/usr/bin/env python3
"""Build a monthly-hourly UTCI climatology for the Cape Town CBD.

This is an offline release task. It downloads hourly ERA5 weather normals,
runs SOLWEIG for one representative day per month, and publishes 288
month/hour map slices at a coarser 8 m resolution than the live forecast.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
LOCAL_ZONE = ZoneInfo("Africa/Johannesburg")
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
HOURLY_FIELDS = (
    "temperature_2m", "relative_humidity_2m", "surface_pressure",
    "precipitation", "wind_speed_10m", "wind_direction_10m",
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
)
CHANNELS = (
    {"name": "tmrt_c", "unit": "°C", "scale": 0.1, "offset": 0.0},
    {"name": "utci_c", "unit": "°C", "scale": 0.1, "offset": 0.0},
)
NODATA = -32768
MONTH_NAMES = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
SEASON_BY_MONTH = {
    12: "summer", 1: "summer", 2: "summer",
    3: "autumn", 4: "autumn", 5: "autumn",
    6: "winter", 7: "winter", 8: "winter",
    9: "spring", 10: "spring", 11: "spring",
}


def fetch_archive(start_year: int, end_year: int) -> dict:
    params = urlencode({
        "latitude": -33.925, "longitude": 18.424,
        "start_date": f"{start_year}-01-01", "end_date": f"{end_year}-12-31",
        "hourly": ",".join(HOURLY_FIELDS), "models": "era5",
        "timezone": "Africa/Johannesburg", "wind_speed_unit": "ms",
    })
    request = Request(ARCHIVE_URL + "?" + params, headers={"User-Agent": "ClimateExplorer/0.1"})
    with urlopen(request, timeout=90) as response:  # noqa: S310 - fixed trusted weather API endpoint
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("error"):
        raise RuntimeError(f"historical weather request failed: {payload.get('reason', 'unknown error')}")
    hourly = payload.get("hourly") or {}
    if not hourly.get("time") or any(len(hourly.get(name, [])) != len(hourly["time"]) for name in HOURLY_FIELDS):
        raise RuntimeError("historical weather response is incomplete")
    return payload


def composite_monthly_hourly(payload: dict, start_year: int, end_year: int) -> tuple[list[dict], dict]:
    """Average weather by local month/hour; average winds as vector components."""
    hourly = payload["hourly"]
    groups: dict[tuple[int, int], dict[str, list[float]]] = {
        (month, hour): {name: [] for name in HOURLY_FIELDS if name not in {"wind_speed_10m", "wind_direction_10m"}}
        | {"wind_u": [], "wind_v": []}
        for month in range(1, 13) for hour in range(24)
    }
    for index, label in enumerate(hourly["time"]):
        local = datetime.fromisoformat(label).replace(tzinfo=LOCAL_ZONE)
        group = groups[(local.month, local.hour)]
        for name in group:
            value = hourly[name][index] if name in hourly else None
            if name in {"wind_u", "wind_v"}:
                speed = hourly["wind_speed_10m"][index]
                direction = hourly["wind_direction_10m"][index]
                if speed is None or direction is None:
                    continue
                radians = math.radians(float(direction))
                component = -float(speed) * (math.sin(radians) if name == "wind_u" else math.cos(radians))
                group[name].append(component)
            elif value is not None:
                group[name].append(float(value))

    rows = []
    sample_counts = {}
    for month in range(1, 13):
        for hour in range(24):
            group = groups[(month, hour)]
            averages = {name: float(np.mean(values)) if values else None for name, values in group.items()}
            if any(averages[name] is None for name in ("temperature_2m", "relative_humidity_2m", "surface_pressure", "shortwave_radiation", "direct_radiation", "diffuse_radiation")):
                raise RuntimeError(f"historical weather has missing values for month {month}, hour {hour}")
            wind_u, wind_v = averages.pop("wind_u"), averages.pop("wind_v")
            if wind_u is None or wind_v is None:
                raise RuntimeError(f"historical weather has no wind for month {month}, hour {hour}")
            speed = math.hypot(wind_u, wind_v)
            direction = math.degrees(math.atan2(-wind_u, -wind_v)) % 360 if speed > 0.05 else 0.0
            local_valid = datetime(end_year, month, 15, hour, tzinfo=LOCAL_ZONE)
            valid_at = local_valid.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            row = {
                "valid_at": valid_at,
                "temperature_2m_c": averages["temperature_2m"],
                "relative_humidity_2m_pct": averages["relative_humidity_2m"],
                "surface_pressure_hpa": averages["surface_pressure"],
                "precipitation_mm": averages["precipitation"] or 0.0,
                "wind_speed_10m_mps": max(0.01, speed), "wind_direction_10m_deg": direction,
                "global_radiation_wm2": averages["shortwave_radiation"],
                "direct_radiation_wm2": averages["direct_radiation"],
                "diffuse_radiation_wm2": averages["diffuse_radiation"],
                "data_kind": "historical_era5_month_hour_composite",
                "source": "Open-Meteo ERA5 historical reanalysis",
                "sources": ["Open-Meteo ERA5 historical reanalysis"],
                "provenance": {name: "era5_historical_month_hour_mean" for name in HOURLY_FIELDS},
                "weather_warnings": [], "radiation": {"averaging_minutes": 60},
            }
            rows.append(row)
            sample_counts[f"{month:02d}-{hour:02d}"] = len(group["temperature_2m"])
    return rows, {
        "start_year": start_year, "end_year": end_year,
        "dataset": "ERA5 hourly reanalysis, 0.25 degree",
        "modelled_hours": 288,
        "samples_per_month_hour": {"minimum": min(sample_counts.values()), "maximum": max(sample_counts.values())},
    }


def block_mean(values: np.ndarray, valid: np.ndarray, factor: int) -> tuple[np.ndarray, np.ndarray]:
    height, width = values.shape
    out_height, out_width = math.ceil(height / factor), math.ceil(width / factor)
    pad_height, pad_width = out_height * factor - height, out_width * factor - width
    padded_values = np.pad(values, ((0, pad_height), (0, pad_width)), constant_values=0)
    padded_valid = np.pad(valid & np.isfinite(values), ((0, pad_height), (0, pad_width)), constant_values=False)
    block_values = padded_values.reshape(out_height, factor, out_width, factor)
    block_valid = padded_valid.reshape(out_height, factor, out_width, factor)
    counts = block_valid.sum(axis=(1, 3))
    sums = np.where(block_valid, block_values, 0).sum(axis=(1, 3), dtype=np.float64)
    output = np.full((out_height, out_width), np.nan, dtype=np.float32)
    mask = counts >= max(1, factor * factor // 2)
    output[mask] = (sums[mask] / counts[mask]).astype(np.float32)
    return output, mask


def summarize(values: np.ndarray, valid: np.ndarray) -> dict:
    samples = values[valid & np.isfinite(values)]
    if not samples.size:
        raise RuntimeError("climatology frame has no valid pedestrian cells")
    return {
        "mean_utci_c": round(float(np.mean(samples)), 2),
        "p10_utci_c": round(float(np.percentile(samples, 10)), 2),
        "p90_utci_c": round(float(np.percentile(samples, 90)), 2),
        "min_utci_c": round(float(np.min(samples)), 2),
        "max_utci_c": round(float(np.max(samples)), 2),
        "max_utci_c": round(float(np.max(samples)), 2),
        "area_above_26_pct": round(float(np.mean(samples >= 26.0) * 100), 2),
        "area_above_32_pct": round(float(np.mean(samples >= 32.0) * 100), 2),
        "valid_cells": int(samples.size),
    }


def build(start_year: int, end_year: int, output: Path, resolution_m: float = 8.0) -> dict:
    if end_year < start_year or end_year - start_year > 30:
        raise ValueError("choose an ordered climate baseline no longer than 31 years")
    output = output.resolve()
    payload = fetch_archive(start_year, end_year)
    rows, baseline = composite_monthly_hourly(payload, start_year, end_year)
    os.environ.setdefault("THERMAL_SURFACE_ROOT", str(ROOT / "data/thermal/surfaces"))
    os.environ.setdefault("THERMAL_WIND_ATLAS_ROOT", str(ROOT / "data/openfoam/atlas"))
    sys.path.insert(0, str(ROOT))
    from server.thermal_worker import calculate_utci, load_wind_atlas, run_solweig
    import rasterio

    atlas_manifest, atlas_paths = load_wind_atlas()
    surface_root = Path(os.environ["THERMAL_SURFACE_ROOT"])
    with rasterio.open(surface_root / "landcover.tif") as source:
        original_cover = source.read(1)
        original_valid = (original_cover != 2) & (original_cover != source.nodata)
        original_resolution = abs(float(source.transform.a))
    factor = max(1, round(resolution_m / original_resolution))
    if abs(factor * original_resolution - resolution_m) > 1e-6:
        raise ValueError("overview resolution must be an integer multiple of the thermal surface resolution")
    grid = json.loads((surface_root / "grid.json").read_text(encoding="utf-8"))
    width, height = math.ceil(int(grid["width"]) / factor), math.ceil(int(grid["height"]) / factor)
    temp_parent = output.parent
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="thermal-climatology-", dir=temp_parent) as temp_name:
        staging = Path(temp_name)
        metadata = []
        shared_cache = staging / "solweig_cache"
        for month in range(1, 13):
            month_rows = rows[(month - 1) * 24:month * 24]
            month_work = staging / f"month-{month:02d}"
            month_work.mkdir(parents=True)
            solweig_rows, model = run_solweig(month_rows, month_rows, month_work, cache_dir=shared_cache)
            for hour, (forcing, radiation) in enumerate(zip(month_rows, solweig_rows)):
                sector = int(((forcing["wind_direction_10m_deg"] + 11.25) // 22.5) % 16)
                with np.load(atlas_paths[sector]) as atlas_data:
                    wind_10m = np.asarray(atlas_data["speed_ratio_10"], dtype=np.float32) * forcing["wind_speed_10m_mps"]
                    wind_valid = np.asarray(atlas_data["valid"], dtype=bool)
                valid = wind_valid & radiation["ground_mask"] & np.isfinite(radiation["tmrt"])
                tmrt_small, tmrt_valid = block_mean(radiation["tmrt"], valid, factor)
                wind_small, wind_small_valid = block_mean(wind_10m, valid, factor)
                small_valid = tmrt_valid & wind_small_valid
                utci_small = calculate_utci(
                    forcing["temperature_2m_c"], tmrt_small, np.maximum(wind_small, 0.5),
                    forcing["relative_humidity_2m_pct"],
                )
                encoded = np.full((height, width, 2), NODATA, dtype="<i2")
                encoded[..., 0][small_valid] = np.clip(np.rint(tmrt_small[small_valid] / 0.1), -32767, 32767).astype(np.int16)
                encoded[..., 1][small_valid] = np.clip(np.rint(utci_small[small_valid] / 0.1), -32767, 32767).astype(np.int16)
                filename = f"m{month:02d}_h{hour:02d}.bin"
                frame_path = staging / filename
                encoded.tofile(frame_path)
                frame_summary = summarize(utci_small, small_valid)
                tmrt_summary = summarize(tmrt_small, small_valid)
                frame_summary.update({
                    "mean_tmrt_c": tmrt_summary["mean_utci_c"],
                    "p90_tmrt_c": tmrt_summary["p90_utci_c"],
                    "max_tmrt_c": tmrt_summary["max_utci_c"],
                    "min_tmrt_c": tmrt_summary["min_utci_c"],
                })
                metadata.append({
                    "id": f"m{month:02d}_h{hour:02d}", "file": filename,
                    "month": month, "month_name": MONTH_NAMES[month - 1],
                    "season": SEASON_BY_MONTH[month], "hour_local": hour,
                    "valid_at": forcing["valid_at"], "bytes": frame_path.stat().st_size,
                    "sha256": hashlib.sha256(frame_path.read_bytes()).hexdigest(),
                    "summary": frame_summary,
                    "forcing": {name: forcing.get(name) for name in (
                        "temperature_2m_c", "relative_humidity_2m_pct", "wind_speed_10m_mps",
                        "wind_direction_10m_deg", "global_radiation_wm2", "direct_radiation_wm2",
                        "diffuse_radiation_wm2",
                    )},
                })
            shutil.rmtree(month_work, ignore_errors=True)
        shutil.rmtree(shared_cache, ignore_errors=True)
        manifest = {
            "schema": "conditions-thermal-climatology/1",
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "validation_status": "experimental_unvalidated_historical_composite",
            "baseline": baseline,
            "method": "Monthly and local-hour mean ERA5 weather composites; SOLWEIG and UTCI evaluated for the 15th of each month. This is a representative climate comparison, not a reconstruction of observed UTCI or a typical individual day.",
            "source": {"name": "Open-Meteo Historical Weather API", "dataset": "ERA5", "latitude": -33.925, "longitude": 18.424, "timezone": "Africa/Johannesburg"},
            "grid": {
                "width": width, "height": height, "resolution_m": factor * original_resolution,
                "bounds": list(grid["viewer_bounds"]),
                "crs": "viewer-local-xz-metres", "source_resolution_m": original_resolution,
            },
            "color_range": {
                "min": min(item["summary"]["min_utci_c"] for item in metadata),
                "max": max(item["summary"]["max_utci_c"] for item in metadata),
            },
            "color_ranges": {
                "utci_c": {
                    "min": min(item["summary"]["min_utci_c"] for item in metadata),
                    "max": max(item["summary"]["max_utci_c"] for item in metadata),
                },
                "tmrt_c": {
                    "min": min(item["summary"]["min_tmrt_c"] for item in metadata),
                    "max": max(item["summary"]["max_tmrt_c"] for item in metadata),
                },
            },
            "channels": list(CHANNELS), "nodata": NODATA,
            "wind_atlas": {"schema": atlas_manifest["schema"], "required_sectors": 16, "available_sectors": 16},
            "models": {"solweig": model, "utci": "pythermalcomfort UTCI"},
            "frames": metadata,
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
        if output.exists():
            shutil.rmtree(output)
        os.replace(staging, output)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-year", type=int, default=2016)
    parser.add_argument("--end-year", type=int, default=2025)
    parser.add_argument("--output", type=Path, default=ROOT / "data/thermal/climatology")
    parser.add_argument("--resolution-m", type=float, default=8.0)
    args = parser.parse_args()
    manifest = build(args.start_year, args.end_year, args.output, args.resolution_m)
    print(json.dumps({"output": str(args.output), "frames": len(manifest["frames"]), "baseline": manifest["baseline"]}, indent=2))


if __name__ == "__main__":
    main()
