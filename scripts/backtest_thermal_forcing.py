#!/usr/bin/env python3
"""Backtest Cape Town model weather inputs against METAR and satellite data.

METAR provides station observations for FACT airport, not CBD street truth.
ERA5 is reported separately as a reanalysis cross-check, never as an
observation. This script evaluates meteorological forcing, not street-level
Tmrt, CFD wind, or UTCI validity.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import json
import math
from pathlib import Path
import statistics
import sys
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from server.weather_forcing import (
    METAR_URL,
    SATELLITE_RADIATION_URL,
    _get_json,
    _scene_location,
)


FORECAST_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
REANALYSIS_URL = "https://archive-api.open-meteo.com/v1/archive"
HOURLY = (
    "temperature_2m,dew_point_2m,relative_humidity_2m,wind_speed_10m,"
    "wind_direction_10m,cloud_cover,shortwave_radiation,direct_radiation,diffuse_radiation"
)
RADIATION_HOURLY = "shortwave_radiation,direct_radiation,diffuse_radiation"


def _utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    result = []
    for index, value in enumerate(times):
        row = {"valid_at": _utc(str(value)).isoformat().replace("+00:00", "Z")}
        for name, values in hourly.items():
            if name == "time":
                continue
            row[name] = values[index] if index < len(values) else None
        result.append(row)
    return result


def _fetch_hourly(base: str, longitude: float, latitude: float, start: date, end: date,
                  variables: str, model: str | None = None) -> list[dict[str, Any]]:
    params: dict[str, str] = {
        "latitude": f"{latitude:.6f}", "longitude": f"{longitude:.6f}",
        "hourly": variables, "timezone": "UTC", "temperature_unit": "celsius",
        "wind_speed_unit": "ms", "precipitation_unit": "mm",
        "start_date": start.isoformat(), "end_date": end.isoformat(),
    }
    if model:
        params["models"] = model
    return _rows(_get_json(f"{base}?{urlencode(params)}", timeout=45))


def _fetch_metar(start: datetime, end: datetime) -> list[dict[str, Any]]:
    hours = min(720, max(1, math.ceil((end - start).total_seconds() / 3600)))
    params = urlencode({"ids": "FACT", "format": "json", "hours": str(hours)})
    request = Request(
        f"{METAR_URL}?{params}",
        headers={"User-Agent": "ClimateExplorer/0.1 (thermal forcing backtest)"},
    )
    with urlopen(request, timeout=30) as response:  # noqa: S310 - fixed trusted aviation weather endpoint
        payload = json.loads(response.read().decode("utf-8"))
    result = []
    for item in payload if isinstance(payload, list) else []:
        try:
            observed_at = datetime.fromtimestamp(float(item["obsTime"]), timezone.utc)
        except (KeyError, TypeError, ValueError, OSError):
            continue
        if not start <= observed_at <= end:
            continue
        def finite(name: str) -> float | None:
            try:
                value = float(item[name])
                return value if math.isfinite(value) else None
            except (KeyError, TypeError, ValueError):
                return None
        temperature, dewpoint = finite("temp"), finite("dewp")
        rh = None
        if temperature is not None and dewpoint is not None:
            saturation = lambda value: math.exp(17.625 * value / (243.04 + value))
            rh = 100 * saturation(dewpoint) / saturation(temperature)
        clouds = [str(layer.get("cover", "")).upper() for layer in (item.get("clouds") or [])]
        wind_knots = finite("wspd")
        result.append({
            "observed_at": observed_at,
            "temperature_2m_c": temperature,
            "dewpoint_2m_c": dewpoint,
            "relative_humidity_2m_pct": min(100.0, max(0.0, rh)) if rh is not None else None,
            "wind_speed_10m_mps": wind_knots * 0.514444 if wind_knots is not None else None,
            "wind_direction_10m_deg": finite("wdir"),
            "cloud_codes": clouds,
        })
    return result


def _stats(errors: list[float]) -> dict[str, float | int | None]:
    if not errors:
        return {"n": 0, "bias": None, "mae": None, "rmse": None}
    return {
        "n": len(errors), "bias": round(statistics.fmean(errors), 3),
        "mae": round(statistics.fmean(abs(value) for value in errors), 3),
        "rmse": round(math.sqrt(statistics.fmean(value * value for value in errors)), 3),
    }


def _cloud_proxy(codes: list[str]) -> float | None:
    values = {"CLR": 0, "SKC": 0, "NSC": 0, "CAVOK": 0,
              "FEW": 25, "SCT": 50, "BKN": 80, "OVC": 100, "VV": 100}
    observed = [values[code] for code in codes if code in values]
    return float(max(observed)) if observed else None


def _angular_error(model: float, observed: float) -> float:
    return abs((model - observed + 180.0) % 360.0 - 180.0)


def _model_vs_metar(model_rows: list[dict[str, Any]], metars: list[dict[str, Any]]) -> dict[str, Any]:
    by_time = {row["valid_at"]: row for row in model_rows}
    # Use one METAR per forecast hour, choosing the report closest to that hour.
    pairs: dict[str, tuple[float, dict[str, Any], dict[str, Any]]] = {}
    for observed in metars:
        hour = observed["observed_at"].replace(minute=0, second=0, microsecond=0)
        key = hour.isoformat().replace("+00:00", "Z")
        forecast = by_time.get(key)
        if not forecast:
            continue
        offset = abs((observed["observed_at"] - hour).total_seconds())
        if key not in pairs or offset < pairs[key][0]:
            pairs[key] = (offset, forecast, observed)

    errors: dict[str, list[float]] = {
        name: [] for name in ("temperature_2m_c", "relative_humidity_2m_pct", "wind_speed_10m_mps", "cloud_cover_proxy_pct")
    }
    direction_errors: list[float] = []
    details = []
    for key, (offset, model, obs) in sorted(pairs.items()):
        cloud = _cloud_proxy(obs["cloud_codes"])
        comparisons = {
            "temperature_2m_c": (model.get("temperature_2m"), obs.get("temperature_2m_c")),
            "relative_humidity_2m_pct": (model.get("relative_humidity_2m"), obs.get("relative_humidity_2m_pct")),
            "wind_speed_10m_mps": (model.get("wind_speed_10m"), obs.get("wind_speed_10m_mps")),
            "cloud_cover_proxy_pct": (model.get("cloud_cover"), cloud),
        }
        residuals = {}
        for name, (predicted, actual) in comparisons.items():
            if predicted is not None and actual is not None:
                error = float(predicted) - float(actual)
                errors[name].append(error)
                residuals[name] = round(error, 3)
            else:
                residuals[name] = None
        model_direction, observed_direction = model.get("wind_direction_10m"), obs.get("wind_direction_10m_deg")
        if model_direction is not None and observed_direction is not None and (obs.get("wind_speed_10m_mps") or 0) >= 1.0:
            direction_errors.append(_angular_error(float(model_direction), float(observed_direction)))
        details.append({
            "valid_at": key, "metar_at": obs["observed_at"].isoformat().replace("+00:00", "Z"),
            "minutes_from_hour": round(offset / 60, 1), "metar_cloud_codes": obs["cloud_codes"],
            "model": {name: model.get(source) for name, source in (
                ("temperature_2m_c", "temperature_2m"), ("relative_humidity_2m_pct", "relative_humidity_2m"),
                ("wind_speed_10m_mps", "wind_speed_10m"), ("wind_direction_10m_deg", "wind_direction_10m"),
                ("cloud_cover_pct", "cloud_cover"),
            )},
            "residuals_model_minus_metar": residuals,
        })
    return {
        "station": "FACT / Cape Town International",
        "interpretation": "airport point-observation comparison; not CBD street-level validation",
        "paired_hours": len(details),
        "metrics_model_minus_metar": {name: _stats(values) for name, values in errors.items()},
        "wind_direction_absolute_error_degrees": {
            "n": len(direction_errors),
            "mae": round(statistics.fmean(direction_errors), 3) if direction_errors else None,
        },
        "pairs": details,
    }


def _model_vs_radiation(model_rows: list[dict[str, Any]], satellite_rows: list[dict[str, Any]]) -> dict[str, Any]:
    observed = {row["valid_at"]: row for row in satellite_rows}
    vars_map = {
        "global_radiation_wm2": "shortwave_radiation",
        "direct_radiation_wm2": "direct_radiation",
        "diffuse_radiation_wm2": "diffuse_radiation",
    }
    errors = {name: [] for name in vars_map}
    pairs = []
    for model in model_rows:
        satellite = observed.get(model["valid_at"])
        if not satellite:
            continue
        residuals = {}
        for out_name, source_name in vars_map.items():
            predicted, actual = model.get(source_name), satellite.get(source_name)
            if predicted is None or actual is None:
                residuals[out_name] = None
            else:
                error = float(predicted) - float(actual)
                errors[out_name].append(error)
                residuals[out_name] = round(error, 3)
        pairs.append({"valid_at": model["valid_at"], "residuals_forecast_minus_satellite": residuals})
    return {
        "reference": "EUMETSAT-derived satellite radiation via Open-Meteo",
        "interpretation": "satellite/model radiation comparison; satellite retrieval is an estimate, not a CBD pyranometer",
        "paired_hours": len(pairs),
        "metrics_forecast_minus_satellite": {name: _stats(values) for name, values in errors.items()},
        "pairs": pairs,
    }


def _model_vs_era5(model_rows: list[dict[str, Any]], era5_rows: list[dict[str, Any]]) -> dict[str, Any]:
    references = {row["valid_at"]: row for row in era5_rows}
    names = {
        "temperature_2m_c": "temperature_2m", "relative_humidity_2m_pct": "relative_humidity_2m",
        "wind_speed_10m_mps": "wind_speed_10m", "cloud_cover_pct": "cloud_cover",
        "global_radiation_wm2": "shortwave_radiation",
    }
    errors = {name: [] for name in names}
    pairs = []
    for model in model_rows:
        ref = references.get(model["valid_at"])
        if not ref:
            continue
        residuals = {}
        for out_name, source_name in names.items():
            predicted, actual = model.get(source_name), ref.get(source_name)
            if predicted is None or actual is None:
                residuals[out_name] = None
            else:
                error = float(predicted) - float(actual)
                errors[out_name].append(error)
                residuals[out_name] = round(error, 3)
        pairs.append({"valid_at": model["valid_at"], "residuals_forecast_minus_era5": residuals})
    return {
        "reference": "ERA5 reanalysis",
        "interpretation": "model-to-reanalysis consistency only; ERA5 assimilates observations and is not independent ground truth",
        "paired_hours": len(pairs),
        "metrics_forecast_minus_era5": {name: _stats(values) for name, values in errors.items()},
        "pairs": pairs,
    }


def _radiation_closure(rows: list[dict[str, Any]]) -> dict[str, Any]:
    residuals = []
    negative = 0
    checked = 0
    for row in rows:
        components = [row.get(key) for key in ("shortwave_radiation", "direct_radiation", "diffuse_radiation")]
        if any(value is None for value in components):
            continue
        global_horizontal, direct, diffuse = map(float, components)
        checked += 1
        negative += sum(value < -1.0 for value in (global_horizontal, direct, diffuse))
        residuals.append(global_horizontal - direct - diffuse)
    return {
        "n": checked,
        "global_minus_direct_minus_diffuse_wm2": _stats(residuals),
        "negative_component_count": negative,
        "closure_over_5_wm2_count": sum(abs(value) > 5 for value in residuals),
    }


def build_report(days: int = 30) -> dict[str, Any]:
    if not 1 <= days <= 30:
        raise ValueError("days must be between 1 and 30")
    longitude, latitude, _ = _scene_location()
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    first_day, last_day = start.date(), now.date()
    forecast_rows = _fetch_hourly(FORECAST_URL, longitude, latitude, first_day, last_day, HOURLY)
    metars = _fetch_metar(start, now)
    satellite_rows = _fetch_hourly(
        SATELLITE_RADIATION_URL, longitude, latitude, first_day, last_day,
        RADIATION_HOURLY, model="satellite_radiation_seamless",
    )
    # ERA5 has several days of latency. Query the same window and allow missing
    # newest dates; report sample counts rather than filling or interpolating.
    era5_rows = _fetch_hourly(REANALYSIS_URL, longitude, latitude, first_day, last_day, HOURLY, model="era5")
    return {
        "schema": "conditions-thermal-forcing-backtest/1",
        "period_utc": {"start": start.isoformat(), "end": now.isoformat()},
        "location": {"name": "Cape Town CBD model grid point", "latitude": latitude, "longitude": longitude},
        "status": "forcing_diagnostics_not_street_level_utci_validation",
        "comparisons": {
            "metar": _model_vs_metar(forecast_rows, metars),
            "satellite_radiation": _model_vs_radiation(forecast_rows, satellite_rows),
            "era5_reanalysis": _model_vs_era5(forecast_rows, era5_rows),
        },
        "physics_checks": {
            "forecast_radiation_closure": _radiation_closure(forecast_rows),
            "satellite_radiation_closure": _radiation_closure(satellite_rows),
            "note": "shortwave horizontal radiation should approximately equal direct plus diffuse; closure does not validate accuracy",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30, help="lookback window (1–30 days)")
    parser.add_argument("--output", type=Path, help="write full JSON report to this path; summary prints to stdout")
    args = parser.parse_args()
    try:
        report = build_report(args.days)
    except Exception as error:
        print(f"thermal forcing backtest failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {
        "schema": report["schema"], "period_utc": report["period_utc"], "status": report["status"],
        "output": str(args.output) if args.output else None,
        "comparisons": {
            name: {key: value for key, value in comparison.items() if key in (
                "station", "reference", "interpretation", "paired_hours",
                "metrics_model_minus_metar", "wind_direction_absolute_error_degrees",
                "metrics_forecast_minus_satellite", "metrics_forecast_minus_era5",
            )}
            for name, comparison in report["comparisons"].items()
        },
        "physics_checks": report["physics_checks"],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
