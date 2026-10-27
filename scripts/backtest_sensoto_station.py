#!/usr/bin/env python3
"""Compare Cape Town's NOAA ISD station with collocated ERA5 reanalysis.

This is a regional forcing check. It cannot validate pedestrian CFD, Tmrt, or
street-level UTCI, and ERA5 is a reanalysis rather than an independent forecast.
The SENSOTO token is read from SENSOTO_API_TOKEN and is never written to output.
"""

from __future__ import annotations

import argparse
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import sys
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError
from urllib.parse import urlsplit

import pyproj
from shapely.geometry import Point, shape
from shapely.ops import transform as transform_geometry

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dotenv is a project dependency
    load_dotenv = None


ROOT = Path(__file__).resolve().parents[1]
API_ROOT = "https://api.sensoto.io/v1/organizations/open/networks/noaa-isd"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
DEVICE_ID = "688190-99999"
SENSORS = {
    "air_temperature": ("temperature_2m", "°C"),
    "wind_speed_rate": ("wind_speed_10m", "m/s"),
    "wind_direction": ("wind_direction_10m", "°"),
}
ARCHIVE_FIELDS = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m"


def _json(url: str, token: str | None = None, timeout: int = 45) -> Any:
    headers = {"Accept": "application/json", "User-Agent": "ClimateExplorer/0.1 (station validation)"}
    if token:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{token}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed trusted source endpoints
            return json.loads(response.read().decode("utf-8"))
    except URLError as error:
        # Include the safe endpoint path and error class, but never the query
        # string because SENSOTO authentication is carried there.
        parts = urlsplit(url)
        reason = getattr(error, "reason", None)
        raise RuntimeError(
            f"request to {parts.netloc}{parts.path} failed ({type(reason).__name__})"
        ) from None


def _month_ranges(start: date, end: date):
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        last = date(cursor.year, cursor.month, monthrange(cursor.year, cursor.month)[1])
        left, right = max(start, cursor), min(end, last)
        yield left, right
        cursor = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)


def _fetch_sensor(sensor: str, start: date, end: date, token: str) -> dict[str, dict[str, Any]]:
    def fetch_month(left: date, right: date) -> list[dict[str, Any]]:
        base = f"{API_ROOT}/devices/{DEVICE_ID}/sensors/{sensor}/measurements"
        count = (right - left).days * 24 + 24
        interval = f"R{count}/{left.isoformat()}T00:00:00Z/PT1H"
        payload = _json(f"{base}?{urlencode({'interval': interval})}", token)
        if not isinstance(payload, list):
            raise RuntimeError(f"SENSOTO {sensor} returned an unexpected response type")
        return payload

    ranges = [(max(start, date(year, 1, 1)), min(end, date(year, 12, 31)))
              for year in range(start.year, end.year + 1)]
    month_payloads = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(fetch_month, left, right): (left, right) for left, right in ranges}
        for future in as_completed(futures):
            month_payloads[futures[future][0]] = future.result()

    rows: dict[str, dict[str, Any]] = {}
    for left, _ in ranges:
        for item in month_payloads[left]:
            begin = item.get("begin")
            if not isinstance(begin, str):
                continue
            stamp = datetime.fromisoformat(begin.replace("Z", "+00:00"))
            stamp = stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp.astimezone(timezone.utc)
            if not (datetime.combine(start, datetime.min.time(), timezone.utc)
                    <= stamp < datetime.combine(end + timedelta(days=1), datetime.min.time(), timezone.utc)):
                continue
            try:
                value = float(item["v"]) if item.get("v") is not None else None
                coverage = float(item.get("c", 0.0))
            except (TypeError, ValueError):
                value, coverage = None, 0.0
            key = stamp.isoformat().replace("+00:00", "Z")
            rows[key] = {"value": value if value is not None and math.isfinite(value) else None,
                         "coverage": coverage if math.isfinite(coverage) else 0.0,
                         "min": item.get("lo"), "max": item.get("hi")}
    return rows


def _fetch_era5(start: date, end: date, latitude: float, longitude: float) -> tuple[dict[str, dict[str, Any]], dict[str, float | None]]:
    rows: dict[str, dict[str, Any]] = {}
    snapped_grid = {"latitude": None, "longitude": None}
    for year in range(start.year, end.year + 1):
        left, right = max(start, date(year, 1, 1)), min(end, date(year, 12, 31))
        params = urlencode({
            "latitude": f"{latitude:.5f}", "longitude": f"{longitude:.5f}",
            "start_date": left.isoformat(), "end_date": right.isoformat(),
            "hourly": ARCHIVE_FIELDS, "models": "era5", "timezone": "UTC",
            "temperature_unit": "celsius", "wind_speed_unit": "ms",
        })
        payload = _json(f"{ARCHIVE_URL}?{params}", timeout=90)
        if snapped_grid["latitude"] is None:
            snapped_grid = {"latitude": _finite(payload.get("latitude")),
                            "longitude": _finite(payload.get("longitude"))}
        hourly = payload.get("hourly") or {}
        times = hourly.get("time") or []
        if not times or any(len(hourly.get(name, [])) != len(times)
                            for name in ARCHIVE_FIELDS.split(",")):
            raise RuntimeError(f"ERA5 response for {year} is incomplete")
        for index, raw_time in enumerate(times):
            stamp = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00"))
            stamp = stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp.astimezone(timezone.utc)
            key = stamp.isoformat().replace("+00:00", "Z")
            rows[key] = {name: hourly[name][index] for name in ARCHIVE_FIELDS.split(",")}
    return rows, snapped_grid


def _spatial_provenance(station_lon: float, station_lat: float,
                        grid: dict[str, float | None]) -> dict[str, Any]:
    footprint_path = ROOT / "data/scene_footprint.geojson"
    footprint_payload = json.loads(footprint_path.read_text(encoding="utf-8"))
    geometry = shape(footprint_payload["features"][0]["geometry"])
    station = Point(station_lon, station_lat)
    project = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32734", always_xy=True).transform
    projected_footprint = transform_geometry(project, geometry)
    projected_station = transform_geometry(project, station)
    result = {
        "inside_scene_footprint": bool(geometry.covers(station)),
        "distance_to_scene_footprint_m": round(projected_footprint.distance(projected_station), 1),
        "scene_footprint_sha256": hashlib.sha256(footprint_path.read_bytes()).hexdigest(),
        "era5_grid_point_distance_from_station_km": None,
    }
    if grid.get("latitude") is not None and grid.get("longitude") is not None:
        _, _, distance = pyproj.Geod(ellps="WGS84").inv(
            station_lon, station_lat, float(grid["longitude"]), float(grid["latitude"]),
        )
        result["era5_grid_point_distance_from_station_km"] = round(distance / 1000, 2)
    return result


def _finite(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _stats(errors: list[float]) -> dict[str, Any]:
    if not errors:
        return {"n": 0, "bias": None, "mae": None, "rmse": None}
    return {
        "n": len(errors), "bias": round(statistics.fmean(errors), 3),
        "mae": round(statistics.fmean(abs(value) for value in errors), 3),
        "rmse": round(math.sqrt(statistics.fmean(value * value for value in errors)), 3),
    }


def _angle_error(model: float, observed: float) -> float:
    return abs((model - observed + 180) % 360 - 180)


def build_report(start: date, end: date, token: str) -> dict[str, Any]:
    if start > end:
        raise ValueError("start date must not be after end date")
    network, device = _json(API_ROOT, token), _json(f"{API_ROOT}/devices/{DEVICE_ID}", token)
    sensors = {}
    sensor_url = device.get("sensors_url")
    sensor_listing = _json(sensor_url, token) if sensor_url else {"items": []}
    sensor_items = {item.get("name"): item for item in sensor_listing.get("items", [])}
    for sensor in SENSORS:
        item = sensor_items.get(sensor)
        if not item or not item.get("href"):
            raise RuntimeError(f"SENSOTO device does not expose required sensor {sensor}")
        sensors[sensor] = _json(item["href"], token)

    station_lat, station_lon = device["geometry"]["coordinates"][1], device["geometry"]["coordinates"][0]
    observation_rows: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(_fetch_sensor, name, start, end, token): name for name in SENSORS}
        for future in as_completed(futures):
            sensor = futures[future]
            for stamp, value in future.result().items():
                observation_rows.setdefault(stamp, {})[sensor] = value
    era5_rows, era5_grid = _fetch_era5(start, end, station_lat, station_lon)
    spatial = _spatial_provenance(station_lon, station_lat, era5_grid)

    variable_map = {
        "air_temperature": ("temperature_2m", "°C"),
        "wind_speed_rate": ("wind_speed_10m", "m/s"),
        "wind_direction": ("wind_direction_10m", "°"),
    }
    errors: dict[str, list[float]] = {name: [] for name in variable_map if name != "wind_direction"}
    direction_errors: list[float] = []
    pairs, valid_hour_counts = [], {name: 0 for name in SENSORS}
    for stamp in sorted(set(observation_rows) | set(era5_rows)):
        observed = observation_rows.get(stamp, {})
        era5 = era5_rows.get(stamp)
        row = {"valid_at": stamp}
        for sensor, (era5_name, unit) in variable_map.items():
            record = observed.get(sensor) or {}
            actual, coverage = _finite(record.get("value")), _finite(record.get("coverage")) or 0.0
            predicted = _finite(era5.get(era5_name)) if era5 else None
            accepted = actual is not None and coverage > 0
            if accepted:
                valid_hour_counts[sensor] += 1
            row[sensor] = {"observed": actual, "coverage_fraction": coverage,
                           "era5": predicted, "unit": unit,
                           "residual_era5_minus_observed": None}
            if accepted and predicted is not None:
                residual = _angle_error(predicted, actual) if sensor == "wind_direction" else predicted - actual
                row[sensor]["residual_era5_minus_observed"] = round(residual, 3)
                if sensor != "wind_direction":
                    errors[sensor].append(residual)
                elif (_finite(observed.get("wind_speed_rate", {}).get("value")) or 0) >= 1.0:
                    direction_errors.append(residual)
        if any(row[sensor]["observed"] is not None for sensor in variable_map):
            pairs.append(row)

    expected_hours = ((end - start).days + 1) * 24
    sensor_meta = {}
    for name, (era_name, unit) in variable_map.items():
        meta = sensors[name]
        stats = meta.get("sensor_stats", {})
        sensor_meta[name] = {
            "code": meta.get("code"), "phenomenon": meta.get("phenomenon"),
            "sampling_interval": meta.get("sampl_interval"), "sensing_interval": meta.get("sens_interval"),
            "elevation_m": meta.get("elevation"), "unit": unit,
            "declared_time_range_utc": {"start": stats.get("min_time"), "end": stats.get("max_time")},
            "declared_value_count": stats.get("value_count"),
            "period_valid_hour_count": valid_hour_counts[name],
            "period_hour_coverage_fraction": round(valid_hour_counts[name] / max(expected_hours, 1), 4),
        }
    coordinate_geometry = {"type": "Point", "coordinates": [station_lon, station_lat]}
    coordinate_hash = hashlib.sha256(json.dumps(coordinate_geometry, sort_keys=True).encode()).hexdigest()
    return {
        "schema": "conditions-sensoto-station-backtest/1",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "station_reanalysis_comparison_not_cbd_microclimate_validation",
        "period_utc": {"start": start.isoformat(), "end_inclusive": end.isoformat(), "expected_hourly_records": expected_hours},
        "station": {
            "organization": "open", "network": network.get("name"), "device_id": DEVICE_ID,
            "device_name": device.get("name"), "timezone": device.get("timezone"),
            "geometry": coordinate_geometry, "geometry_sha256": coordinate_hash,
            **spatial,
            "elevation_m": device.get("elevation"),
            "source": "NOAA Integrated Surface Database (ISD), distributed by SENSOTO",
            "source_citation": network.get("citation"),
        },
        "reference": {
            "name": "ERA5 hourly reanalysis via Open-Meteo Archive API",
            "requested_coordinates": {"latitude": station_lat, "longitude": station_lon},
            "resolved_era5_grid_point": era5_grid,
            "interpretation": "ERA5 assimilates observations and is not an independent forecast or ground truth.",
        },
        "sensor_metadata": sensor_meta,
        "coverage": {"station_hour_rows_with_any_value": len(pairs), "era5_hourly_rows": len(era5_rows)},
        "metrics_era5_minus_observed": {
            **{name: _stats(values) for name, values in errors.items()},
            "wind_direction_10m_deg": {
                "n": len(direction_errors),
                "mae": round(statistics.fmean(direction_errors), 3) if direction_errors else None,
                "note": "Circular absolute error; only hours with observed wind speed at least 1 m/s.",
            },
        },
        "pairing": {
            "method": "Exact UTC hour labels only; no temporal interpolation.",
            "quality_rule": "A station hourly value is accepted only when SENSOTO coverage c is greater than zero and v is finite.",
            "wind_direction_rule": "Circular angular residual; omit from directional MAE when observed wind speed is below 1 m/s.",
            "pairs": pairs,
        },
        "limitations": [
            "The station point lies about 330 m outside the mapped analysis footprint; verify current geometry before operational use.",
            "SENSOTO/ISD metadata does not state instrument height or a station-specific exposure assessment for these sensors.",
            "This station has no humidity, radiation, or mean radiant temperature sensor in the exposed device inventory.",
            "A weather-station comparison cannot validate pedestrian-height OpenFOAM flow, street-canyon wind, Tmrt, or UTCI.",
            "The SENSOTO station history is delayed; do not treat its last available hour as live weather.",
        ],
    }


def main() -> int:
    if load_dotenv:
        load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=date.fromisoformat, default=date(2021, 1, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=date(2025, 8, 24))
    parser.add_argument("--output", type=Path, required=True, help="write the full paired report JSON here")
    args = parser.parse_args()
    token = os.environ.get("SENSOTO_API_TOKEN")
    if not token:
        parser.error("SENSOTO_API_TOKEN must be set in the environment or .env")
    try:
        report = build_report(args.start, args.end, token)
    except Exception as error:
        print(f"SENSOTO station backtest failed: {error}", file=sys.stderr)
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {
        "schema": report["schema"], "status": report["status"],
        "station": {k: v for k, v in report["station"].items() if k not in {"source_citation"}},
        "period_utc": report["period_utc"], "coverage": report["coverage"],
        "metrics_era5_minus_observed": report["metrics_era5_minus_observed"],
        "output": str(args.output),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
