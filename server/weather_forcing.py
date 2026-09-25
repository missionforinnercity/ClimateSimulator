"""Hourly weather forcing assembled from forecasts and delayed observations.

Open-Meteo is the forecast and radiation source.  Meteostat is deliberately
used only as a delayed, station-informed observation source.  Provider payloads
are normalized before they reach the thermal models so no API-specific names or
credentials can leak into generated products.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import logging
import math
import os
from pathlib import Path
import statistics
import threading
import time
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from pyproj import Transformer

LOGGER = logging.getLogger("conditions.weather")
LOCAL_ZONE = ZoneInfo("Africa/Johannesburg")
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_HISTORY_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
METEOSTAT_URL = "https://meteostat.p.rapidapi.com/point/hourly"
METAR_URL = "https://aviationweather.gov/api/data/metar"
SATELLITE_RADIATION_URL = "https://satellite-api.open-meteo.com/v1/archive"
HOURLY_VARIABLES = (
    "temperature_2m", "dew_point_2m", "relative_humidity_2m", "surface_pressure",
    "precipitation", "wind_speed_10m", "wind_direction_10m", "shortwave_radiation",
    "direct_radiation", "diffuse_radiation", "cloud_cover",
)
# Use three independent global/regional deterministic models for the live
# forcing.  A median is less sensitive to one model run than Open-Meteo's
# single "best match" series; the range remains available as an uncertainty
# diagnostic.  This is a model consensus, not a probabilistic ensemble.
FORECAST_MODELS = ("ecmwf_ifs025", "icon_seamless", "gfs_seamless")
_observation_lock = threading.Lock()
_observation_cache: dict[str, Any] | None = None
_observation_cache_day = ""
_metar_lock = threading.Lock()
_metar_cache: list[dict[str, Any]] = []
_metar_cache_at = 0.0


def _scene_location() -> tuple[float, float, float]:
    manifest = json.loads((Path(__file__).resolve().parents[1] / "public/assets/manifest.json").read_text(encoding="utf-8"))
    origin_x, origin_y = manifest["origin"]
    longitude, latitude = Transformer.from_crs(
        "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs",
        "EPSG:4326", always_xy=True,
    ).transform(origin_x, origin_y)
    # Scene terrain elevations are close to sea level.  An explicit value is
    # still preferable to allowing Meteostat to infer altitude from stations.
    return longitude, latitude, 25.0


def _get_json(url: str, headers: dict[str, str] | None = None, timeout: float = 20.0) -> dict[str, Any]:
    request = Request(url, headers=headers or {})
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed trusted endpoints
        if getattr(response, "status", 200) != 200:
            raise RuntimeError(f"weather provider returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def _iso_hour(value: str, zone: ZoneInfo = LOCAL_ZONE) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    return parsed.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _surface_pressure_from_sea_level(sea_level_hpa: float | None, elevation_m: float, temperature_c: float | None) -> float | None:
    """Hypsometric approximation, returned in hPa."""
    if sea_level_hpa is None:
        return None
    temperature_k = (temperature_c if temperature_c is not None else 15.0) + 273.15
    return sea_level_hpa * math.exp(-9.80665 * elevation_m / (287.05 * temperature_k))


def normalize_open_meteo(payload: dict[str, Any], kind: str = "forecast") -> list[dict[str, Any]]:
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    rows: list[dict[str, Any]] = []
    for index, raw_time in enumerate(times):
        def at(name: str) -> Any:
            series = hourly.get(name)
            return series[index] if isinstance(series, list) and index < len(series) else None

        values = {
            name: _finite(at(name))
            for name in HOURLY_VARIABLES
        }
        missing = [name for name, value in values.items() if value is None]
        rows.append({
            "valid_at": _iso_hour(str(raw_time)),
            "temperature_2m_c": values["temperature_2m"],
            "dewpoint_2m_c": values["dew_point_2m"],
            "relative_humidity_2m_pct": values["relative_humidity_2m"],
            "surface_pressure_hpa": values["surface_pressure"],
            "precipitation_mm": values["precipitation"],
            "wind_speed_10m_mps": values["wind_speed_10m"],
            "wind_direction_10m_deg": values["wind_direction_10m"],
            "global_radiation_wm2": values["shortwave_radiation"],
            "direct_radiation_wm2": values["direct_radiation"],
            "diffuse_radiation_wm2": values["diffuse_radiation"],
            "cloud_cover_pct": values["cloud_cover"],
            "provenance": {name: f"open_meteo_{kind}" for name in values},
            "source": "Open-Meteo",
            "data_kind": f"modelled_{kind}",
            "missing": missing,
        })
    return rows


def normalize_meteostat(payload: dict[str, Any], elevation_m: float) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in payload.get("data") or []:
        temperature = _finite(item.get("temp"))
        pressure = _surface_pressure_from_sea_level(_finite(item.get("pres")), elevation_m, temperature)
        values = {
            "temperature_2m_c": temperature,
            "dewpoint_2m_c": _finite(item.get("dwpt")),
            "relative_humidity_2m_pct": _finite(item.get("rhum")),
            "surface_pressure_hpa": pressure,
            "precipitation_mm": _finite(item.get("prcp")),
            "wind_speed_10m_mps": (_finite(item.get("wspd")) / 3.6 if _finite(item.get("wspd")) is not None else None),
            "wind_direction_10m_deg": _finite(item.get("wdir")),
        }
        rows.append({
            "valid_at": _iso_hour(str(item["time"])),
            **values,
            "global_radiation_wm2": None,
            "direct_radiation_wm2": None,
            "diffuse_radiation_wm2": None,
            "provenance": {name: "meteostat_point_observation" for name in values},
            "source": "Meteostat",
            "data_kind": "station_informed_point_observation",
            "missing": [name for name, value in values.items() if value is None],
        })
    return rows


def normalize_metar(payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Extract only wind/cloud proxy checks from recent FACT METARs.

    FACT is an airport station outside the CBD. Its air temperature, dew point,
    humidity, and raw report are intentionally excluded from the thermal
    runtime; this adapter retains only wind/cloud context and never replaces
    CBD forecast forcing.
    """
    cloud_amount = {"FEW": 25.0, "SCT": 50.0, "BKN": 80.0, "OVC": 100.0, "VV": 100.0}
    by_hour: dict[str, dict[str, Any]] = {}
    for item in payload:
        try:
            observed = datetime.fromtimestamp(float(item["obsTime"]), timezone.utc)
        except (KeyError, TypeError, ValueError, OSError):
            continue
        valid_at = observed.replace(minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
        wind_knots = _finite(item.get("wspd"))
        direction = _finite(item.get("wdir"))
        covers = [cloud_amount.get(str(layer.get("cover", "")).upper()) for layer in (item.get("clouds") or [])]
        clouds = [value for value in covers if value is not None]
        row = {
            "valid_at": valid_at,
            "wind_speed_10m_mps": wind_knots * 0.514444 if wind_knots is not None else None,
            "wind_direction_10m_deg": direction % 360.0 if direction is not None else None,
            "cloud_cover_pct": max(clouds) if clouds else (0.0 if str(item.get("cover", "")).upper() in {"CLR", "SKC", "NSC", "CAVOK"} else None),
            "global_radiation_wm2": None,
            "direct_radiation_wm2": None,
            "diffuse_radiation_wm2": None,
            "provenance": {}, "source": "AviationWeather.gov METAR FACT wind proxy",
            "data_kind": "airport_station_observation",
            "station": {"id": "FACT", "name": item.get("name", "Cape Town International"), "latitude": item.get("lat"), "longitude": item.get("lon")},
            "observed_at": observed.isoformat().replace("+00:00", "Z"),
        }
        for field in ("wind_speed_10m_mps", "wind_direction_10m_deg", "cloud_cover_pct"):
            if row[field] is not None:
                row["provenance"][field] = "aviationweather_metar_FACT"
        # Prefer a SPECI/METAR with more available fields within the same hour.
        score = sum(row[field] is not None for field in ("wind_speed_10m_mps", "cloud_cover_pct"))
        previous = by_hour.get(valid_at)
        if previous is None or score > previous["_score"]:
            row["_score"] = score
            by_hour[valid_at] = row
    return [{key: value for key, value in row.items() if key != "_score"} for _, row in sorted(by_hour.items())]


def fetch_metar(start: datetime, end: datetime, force: bool = False) -> list[dict[str, Any]]:
    """Fetch recent METAR observations for Cape Town International (FACT)."""
    global _metar_cache, _metar_cache_at
    with _metar_lock:
        if _metar_cache and not force and time.monotonic() - _metar_cache_at < 600:
            return [row for row in _metar_cache if start <= datetime.fromisoformat(row["valid_at"].replace("Z", "+00:00")) <= end]
        params = urlencode({"ids": "FACT", "format": "json", "hours": "36"})
        request = Request(f"{METAR_URL}?{params}", headers={"User-Agent": "ClimateExplorer/0.1 (Cape Town CBD thermal research)"})
        try:
            with urlopen(request, timeout=12) as response:  # noqa: S310 - fixed trusted aviation weather endpoint
                payload = json.loads(response.read().decode("utf-8"))
            rows = normalize_metar(payload if isinstance(payload, list) else [])
            _metar_cache, _metar_cache_at = rows, time.monotonic()
        except Exception as error:
            LOGGER.warning("Cape Town METAR unavailable: %s", type(error).__name__)
            if not _metar_cache:
                return []
        return [row for row in _metar_cache if start <= datetime.fromisoformat(row["valid_at"].replace("Z", "+00:00")) <= end]


def normalize_satellite_radiation(payload: dict[str, Any], native: bool = False) -> list[dict[str, Any]]:
    hourly = payload.get("hourly") or {}
    timestamps = []
    for raw in hourly.get("time") or []:
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        timestamps.append(parsed.replace(tzinfo=timezone(timedelta(seconds=payload.get("utc_offset_seconds", 7200)))) if parsed.tzinfo is None else parsed)
    interval = 60
    if native:
        differences = {(b - a).total_seconds() / 60 for a, b in zip(timestamps, timestamps[1:])}
        if len(differences) != 1 or next(iter(differences)) not in {10, 15, 30, 60}:
            raise ValueError("satellite averaging interval is unavailable or irregular")
        interval = int(next(iter(differences)))
    rows = []
    for index, timestamp in enumerate(timestamps):
        values = {name: _finite(hourly.get(name, [])[index]) if index < len(hourly.get(name) or []) else None
                  for name in ("shortwave_radiation", "direct_radiation", "diffuse_radiation")}
        if any(value is None or value < 0 for value in values.values()):
            continue
        if abs(values["shortwave_radiation"] - values["direct_radiation"] - values["diffuse_radiation"]) > 2:
            continue
        valid_at = timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        rows.append({
            "valid_at": valid_at,
            "global_radiation_wm2": values["shortwave_radiation"],
            "direct_radiation_wm2": values["direct_radiation"],
            "diffuse_radiation_wm2": values["diffuse_radiation"],
            "radiation": {"interval_end": valid_at, "averaging_minutes": interval,
                          "source": "EUMETSAT satellite estimate", "temporal_resolution": "native" if native else "hourly"},
            "provenance": {name: "open_meteo_eumetsat_satellite" for name in
                           ("global_radiation_wm2", "direct_radiation_wm2", "diffuse_radiation_wm2")},
            "source": "Open-Meteo satellite radiation (EUMETSAT)",
        })
    return rows


def fetch_satellite_radiation(start: datetime, end: datetime, native: bool = False) -> list[dict[str, Any]]:
    """Fetch observed shortwave radiation from EUMETSAT satellite products."""
    longitude, latitude, _ = _scene_location()
    first_day = max(start, end - timedelta(days=2)).astimezone(LOCAL_ZONE).date()
    parameters = {
        "latitude": f"{latitude:.6f}", "longitude": f"{longitude:.6f}",
        "hourly": "shortwave_radiation,direct_radiation,diffuse_radiation",
        "timezone": "Africa/Johannesburg", "start_date": first_day.isoformat(),
        "end_date": end.astimezone(LOCAL_ZONE).date().isoformat(),
        "models": "satellite_radiation_seamless",
    }
    if native:
        parameters["temporal_resolution"] = "native"
    try:
        request = Request(f"{SATELLITE_RADIATION_URL}?{urlencode(parameters)}", headers={"User-Agent": "ClimateExplorer/0.1 (Cape Town CBD thermal research)"})
        with urlopen(request, timeout=15) as response:  # noqa: S310 - fixed trusted Open-Meteo satellite endpoint
            payload = json.loads(response.read().decode("utf-8"))
        return normalize_satellite_radiation(payload, native)
    except Exception as error:
        LOGGER.warning("Satellite radiation unavailable; retaining model radiation (%s)", type(error).__name__)
        return []


def _open_meteo_url(base: str, start: datetime, end: datetime) -> str:
    longitude, latitude, _ = _scene_location()
    parameters = {
        "latitude": f"{latitude:.6f}", "longitude": f"{longitude:.6f}",
        "hourly": ",".join(HOURLY_VARIABLES), "timezone": "Africa/Johannesburg",
        "wind_speed_unit": "ms", "precipitation_unit": "mm",
        "start_date": start.astimezone(LOCAL_ZONE).date().isoformat(),
        "end_date": end.astimezone(LOCAL_ZONE).date().isoformat(),
    }
    return f"{base}?{urlencode(parameters)}"


def fetch_open_meteo(start: datetime, end: datetime, historical: bool = False) -> list[dict[str, Any]]:
    base = os.getenv(
        "OPEN_METEO_HISTORY_URL" if historical else "OPEN_METEO_FORECAST_URL",
        OPEN_METEO_HISTORY_URL if historical else OPEN_METEO_FORECAST_URL,
    )
    if historical:
        return normalize_open_meteo(_get_json(_open_meteo_url(base, start, end)), "historical_forecast")
    try:
        consensus = fetch_open_meteo_consensus(start, end, base_url=base)
    except Exception as error:
        # Preserve availability when an individual model is temporarily
        # missing at this location; provenance makes the fallback visible.
        LOGGER.warning("Multi-model forecast unavailable; falling back to Open-Meteo best match (%s)", type(error).__name__)
        rows = normalize_open_meteo(_get_json(_open_meteo_url(base, start, end)), "forecast")
        for row in rows:
            row["sources"] = ["Open-Meteo best-match fallback"]
            row["weather_warnings"] = ["multi-model forecast unavailable; single-provider fallback in use"]
        return rows
    # Model-specific series can be missing for one variable/hour even while
    # the consensus response itself succeeds. Backfill only those gaps from
    # Open-Meteo's continuously updated best-match series so one delayed model
    # does not prevent the thermal worker from publishing a current forecast.
    required = (
        "temperature_2m_c", "relative_humidity_2m_pct", "surface_pressure_hpa",
        "precipitation_mm", "wind_speed_10m_mps", "wind_direction_10m_deg",
        "global_radiation_wm2",
    )
    by_time = {row["valid_at"]: row for row in consensus}
    check_start = start.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    check_end = end.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    expected = [
        (check_start + timedelta(hours=step)).isoformat().replace("+00:00", "Z")
        for step in range(int((check_end - check_start).total_seconds() // 3600) + 1)
    ]
    if any(valid_at not in by_time or any(by_time[valid_at].get(name) is None for name in required)
           for valid_at in expected):
        fallback = normalize_open_meteo(_get_json(_open_meteo_url(base, start, end)), "forecast_best_match")
        fallback_by_time = {row["valid_at"]: row for row in fallback}
        patched = []
        for valid_at in expected:
            target = by_time.get(valid_at)
            source = fallback_by_time.get(valid_at)
            if target is None and source is not None:
                target = source
                target["sources"] = ["Open-Meteo best-match fallback for unavailable model hour"]
                target["weather_warnings"] = ["multi-model data unavailable for this hour; best-match fallback in use"]
            elif target is not None and source is not None:
                missing = [name for name in required if target.get(name) is None and source.get(name) is not None]
                for name in missing:
                    target[name] = source[name]
                    target.setdefault("provenance", {})[name] = "open_meteo_best_match_gap_fill"
                if missing:
                    target.setdefault("sources", []).append("Open-Meteo best-match gap fill")
                    target.setdefault("weather_warnings", []).append(
                        "some multi-model inputs were missing; best-match values filled the gaps"
                    )
            if target is not None:
                patched.append(target)
        return patched
    return consensus


def fetch_open_meteo_consensus(
    start: datetime, end: datetime, base_url: str = OPEN_METEO_FORECAST_URL,
) -> list[dict[str, Any]]:
    """Return per-hour medians and spread for available forecast models."""
    longitude, latitude, _ = _scene_location()
    params = {
        "latitude": f"{latitude:.6f}", "longitude": f"{longitude:.6f}",
        "hourly": ",".join(HOURLY_VARIABLES), "timezone": "Africa/Johannesburg",
        "wind_speed_unit": "ms", "precipitation_unit": "mm",
        "start_date": start.astimezone(LOCAL_ZONE).date().isoformat(),
        "end_date": end.astimezone(LOCAL_ZONE).date().isoformat(),
        "models": ",".join(FORECAST_MODELS),
    }
    payload = _get_json(f"{base_url}?{urlencode(params)}", timeout=35)
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise RuntimeError("multi-model forecast returned no hourly rows")

    model_values: dict[str, list[list[float]]] = {}
    for variable in HOURLY_VARIABLES:
        by_model = []
        for model in FORECAST_MODELS:
            values = hourly.get(f"{variable}_{model}")
            if isinstance(values, list):
                by_model.append([_finite(value) if _finite(value) is not None else math.nan for value in values])
        model_values[variable] = by_model

    output = []
    for index, raw_time in enumerate(times):
        median_values: dict[str, float | None] = {}
        spread: dict[str, dict[str, Any]] = {}
        for variable, members in model_values.items():
            values = [member[index] for member in members if index < len(member) and math.isfinite(member[index])]
            if not values:
                median_values[variable] = None
                continue
            if variable == "wind_direction_10m":
                # Average direction on the unit circle to avoid treating 359°
                # and 1° as opposite winds.
                radians = [math.radians(value) for value in values]
                median_values[variable] = math.degrees(math.atan2(
                    statistics.fmean(math.sin(value) for value in radians),
                    statistics.fmean(math.cos(value) for value in radians),
                )) % 360.0
            else:
                median_values[variable] = float(statistics.median(values))
            spread[variable] = {
                "low": round(min(values), 2), "high": round(max(values), 2),
                "range": round(max(values) - min(values), 2), "model_count": len(values),
            }

        # The model medians of GHI and direct beam need not close exactly.
        # Preserve median GHI and constrain the direct/diffuse partition to
        # physical bounds so SOLWEIG receives a closing radiation budget.
        ghi = median_values.get("shortwave_radiation")
        direct = median_values.get("direct_radiation")
        if ghi is not None and direct is not None:
            median_values["direct_radiation"] = min(max(0.0, direct), max(0.0, ghi))
            median_values["diffuse_radiation"] = max(0.0, ghi - median_values["direct_radiation"])

        base_hourly = {"time": [raw_time]}
        for variable, value in median_values.items():
            base_hourly[variable] = [value]
        row = normalize_open_meteo({"hourly": base_hourly}, "multi_model_median")[0]
        row["model_spread"] = spread
        row["model_members"] = [model for model in FORECAST_MODELS if any(
            isinstance(hourly.get(f"{variable}_{model}"), list)
            and index < len(hourly[f"{variable}_{model}"])
            and _finite(hourly[f"{variable}_{model}"][index]) is not None
            for variable in ("temperature_2m", "wind_speed_10m")
        )]
        row["sources"] = ["Open-Meteo multi-model median (" + ", ".join(row["model_members"]) + ")"]
        row["data_kind"] = "modelled_multi_model_consensus"
        row["source"] = "Open-Meteo multi-model forecast"
        for variable in HOURLY_VARIABLES:
            if median_values.get(variable) is not None:
                row["provenance"][variable] = "open_meteo_multi_model_median"
        output.append(row)
    if not output:
        raise RuntimeError("multi-model forecast returned no usable rows")
    return output


def meteostat_api_key() -> tuple[str | None, str | None]:
    key = os.getenv("METEOSTAT_RAPIDAPI_KEY")
    if key:
        return key, "METEOSTAT_RAPIDAPI_KEY"
    legacy = os.getenv("METEOBLUEAPI")
    if legacy:
        LOGGER.warning("METEOBLUEAPI is deprecated; rename it to METEOSTAT_RAPIDAPI_KEY")
        return legacy, "METEOBLUEAPI"
    return None, None


def fetch_meteostat(start: datetime, end: datetime, force: bool = False) -> list[dict[str, Any]]:
    global _observation_cache, _observation_cache_day
    key, _ = meteostat_api_key()
    if not key:
        return []
    today = datetime.now(timezone.utc).date().isoformat()
    with _observation_lock:
        if _observation_cache is not None and not force and _observation_cache_day == today:
            return list(_observation_cache["rows"])
        longitude, latitude, elevation = _scene_location()
        params = {
            "lat": f"{latitude:.6f}", "lon": f"{longitude:.6f}", "alt": str(round(elevation)),
            "start": start.date().isoformat(), "end": end.date().isoformat(),
            "tz": "Africa/Johannesburg", "model": "false", "units": "scientific",
        }
        payload = _get_json(
            f"{METEOSTAT_URL}?{urlencode(params)}",
            {"X-RapidAPI-Key": key, "X-RapidAPI-Host": "meteostat.p.rapidapi.com"},
        )
        rows = normalize_meteostat(payload, elevation)
        _observation_cache = {"rows": rows, "fetched_monotonic": time.monotonic()}
        _observation_cache_day = today
        return list(rows)


def merge_forcing(
    modelled: list[dict[str, Any]], observations: list[dict[str, Any]], now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Overlay available observed variables while retaining modelled radiation."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    by_time = {row["valid_at"]: dict(row) for row in modelled}
    for observed in observations:
        parsed = datetime.fromisoformat(observed["valid_at"].replace("Z", "+00:00"))
        if parsed > now or observed["valid_at"] not in by_time:
            continue
        target = by_time[observed["valid_at"]]
        for field, source in observed.get("provenance", {}).items():
            if observed.get(field) is not None:
                target[field] = observed[field]
                target.setdefault("provenance", {})[field] = source
        for field in ("station", "observed_at", "report"):
            if observed.get(field) is not None:
                target[field] = observed[field]
        target["sources"] = sorted(set(target.get("sources", [target.get("source", "Open-Meteo")])) | {observed.get("source", "observation")})
        target["data_kind"] = "station_observation_with_modelled_radiation"
        target["missing"] = [
            field for field in (
                "temperature_2m_c", "dewpoint_2m_c", "relative_humidity_2m_pct", "surface_pressure_hpa",
                "precipitation_mm", "wind_speed_10m_mps", "wind_direction_10m_deg",
                "global_radiation_wm2", "direct_radiation_wm2", "diffuse_radiation_wm2", "cloud_cover_pct",
            ) if target.get(field) is None
        ]
    return [by_time[key] for key in sorted(by_time)]


def forcing_window(history_days: int = 0, forecast_hours: int = 24) -> dict[str, Any]:
    """Build a live window without making current availability depend on an archive.

    ``history_days`` is retained for call compatibility. Historical values are
    not needed by the near-live product and are intentionally not requested.
    """
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start, end = now, now + timedelta(hours=forecast_hours)
    forecast = fetch_open_meteo(now, end, historical=False)
    modelled = {row["valid_at"]: row for row in forecast}
    # The remote station feeds are context checks only; they do not drive this
    # city-scale product. METAR uses a short timeout/cache and must not block
    # publication; the separate weather endpoint handles Meteostat checks.
    metar_rows = fetch_metar(now - timedelta(hours=36), now)
    observations = metar_rows
    # Keep the CBD grid-point multi-model forecast as the thermal forcing.
    # FACT is roughly 17 km away and its temperature is intentionally discarded;
    # its wind is retained only as a remote quality check, never as map input.
    rows = [dict(modelled[key]) for key in sorted(modelled)]
    metar_by_hour = {row["valid_at"]: row for row in metar_rows}
    for row in rows:
        station = metar_by_hour.get(row["valid_at"])
        if station:
            differences = {}
            # FACT air temperature is deliberately excluded from the thermal
            # estimate and its operational checks: a coastal airport 17 km
            # away is not a defensible CBD temperature observation. Wind is
            # retained only as a clearly labeled proxy check, not as forcing.
            for field in ("wind_speed_10m_mps",):
                forecast_value, observed_value = row.get(field), station.get(field)
                if forecast_value is not None and observed_value is not None:
                    differences[field] = round(float(forecast_value) - float(observed_value), 2)
            row["station_check"] = {
                "station": "FACT", "distance_km": 17.0,
                "observed_at": station.get("observed_at"),
                "model_minus_station": differences,
                "note": "airport proxy only; not used as CBD forcing",
            }
        warnings = list(row.get("weather_warnings", []))
        spread = row.get("model_spread") or {}
        temperature_spread = spread.get("temperature_2m", {}).get("range")
        wind_spread = spread.get("wind_speed_10m", {}).get("range")
        if temperature_spread is not None and temperature_spread >= 2.5:
            warnings.append(f"forecast models differ by {temperature_spread:.1f}°C")
        if wind_spread is not None and wind_spread >= 1.5:
            warnings.append(f"forecast models differ by {wind_spread:.1f} m/s wind")
        radiation_spread = spread.get("shortwave_radiation", {}).get("range")
        if radiation_spread is not None and radiation_spread >= 200.0:
            warnings.append(f"forecast models differ by {radiation_spread:.0f} W/m² shortwave radiation")
        if row.get("model_members") and len(row["model_members"]) < len(FORECAST_MODELS):
            warnings.append(f"only {len(row['model_members'])} of {len(FORECAST_MODELS)} forecast models available")
        check = row.get("station_check") or {}
        differences = check.get("model_minus_station", {})
        wind_delta = differences.get("wind_speed_10m_mps")
        if wind_delta is not None and abs(wind_delta) >= 2.0:
            warnings.append(f"CBD estimate differs from FACT airport wind by {abs(wind_delta):.1f} m/s")
        row["weather_warnings"] = warnings
    satellite_rows = fetch_satellite_radiation(now - timedelta(days=2), now)
    rows_by_time = {row["valid_at"]: row for row in rows}
    for satellite in satellite_rows:
        if datetime.fromisoformat(satellite["valid_at"].replace("Z", "+00:00")) > now:
            continue
        target = rows_by_time.get(satellite["valid_at"])
        if target:
            for field, source in satellite["provenance"].items():
                target[field] = satellite[field]
                target.setdefault("provenance", {})[field] = source
            target["sources"] = sorted(set(target.get("sources", [target.get("source", "Open-Meteo")])) | {satellite["source"]})
            target["data_kind"] = "modelled_multi_model_consensus_with_satellite_radiation"
            target["radiation"] = satellite.get("radiation", {"interval_end": satellite["valid_at"], "averaging_minutes": 60, "source": "EUMETSAT satellite estimate"})
    for row in rows:
        # Provenance must describe this hour, not the availability of satellite
        # data elsewhere in the history window.
        provenance = row.setdefault("provenance", {})
        provenance.setdefault("global_radiation_wm2", provenance.get("shortwave_radiation", "open_meteo_forecast"))
        row.setdefault("radiation", {"interval_end": row["valid_at"], "averaging_minutes": 60, "source": "forecast"})
        if row["valid_at"] == now.isoformat().replace("+00:00", "Z"):
            if "satellite" not in provenance["global_radiation_wm2"]:
                row.setdefault("weather_warnings", []).append(
                    "current-hour satellite radiation unavailable; sunlight is forecast, not observed"
                )
    fetched_at = datetime.now(timezone.utc)
    native_rows = fetch_satellite_radiation(now, fetched_at, True)
    native_rows = [row for row in native_rows if now <= datetime.fromisoformat(row["valid_at"].replace("Z", "+00:00")) <= fetched_at]
    latest_native = max(native_rows, key=lambda row: row["valid_at"], default=None)
    latest_observation = max((row["valid_at"] for row in observations), default=None)
    latest_satellite = max((row["valid_at"] for row in satellite_rows), default=None)
    return {
        "schema": "conditions-hourly-forcing/1", "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "timezone": "Africa/Johannesburg", "rows": rows,
        "providers": {"forecast": "Open-Meteo CBD grid point multi-model median (ECMWF, ICON, GFS)", "observations_for_validation_only": sorted({row["source"] for row in observations}) or ["not_configured_or_unavailable"],
                      "radiation": "Open-Meteo satellite radiation (EUMETSAT)" if satellite_rows else "Open-Meteo forecast"},
        "latest_observation_at": latest_observation,
        "latest_satellite_radiation_at": latest_satellite,
        "latest_native_radiation": latest_native,
    }


def latest_observation() -> dict[str, Any] | None:
    now = datetime.now(timezone.utc)
    rows = [*fetch_meteostat(now - timedelta(days=2), now), *fetch_metar(now - timedelta(hours=36), now)]
    return max(rows, key=lambda item: item.get("observed_at") or item["valid_at"]) if rows else None
