"""Cached, normalized current weather forcing for the Cape Town CBD viewer."""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from .field import load_viewer_config, local_to_web

PROVIDER = "Open-Meteo"
DEFAULT_BASE_URL = "https://api.open-meteo.com/v1/forecast"
CACHE_SECONDS = 600
CURRENT_VARIABLES = (
    "temperature_2m",
    "apparent_temperature",
    "relative_humidity_2m",
    "precipitation",
    "weather_code",
    "cloud_cover",
    "shortwave_radiation",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "is_day",
)

_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cache_monotonic = 0.0


def _scene_location() -> tuple[float, float]:
    config = load_viewer_config()
    return local_to_web(0.0, 0.0, config)


def _fetch_json(url: str, timeout: float = 8.0) -> dict[str, Any]:
    with urlopen(url, timeout=timeout) as response:  # noqa: S310 - configurable trusted provider
        if getattr(response, "status", 200) != 200:
            raise RuntimeError(f"weather provider returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def _number(current: dict[str, Any], key: str) -> float:
    value = current.get(key)
    if value is None:
        raise RuntimeError(f"weather provider omitted {key}")
    return float(value)


def _normalize(payload: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    current = payload.get("current")
    if not isinstance(current, dict):
        raise RuntimeError("weather provider omitted current conditions")
    valid_at = current.get("time")
    if not valid_at:
        raise RuntimeError("weather provider omitted the valid time")
    return {
        "provider": PROVIDER,
        "provider_url": "https://open-meteo.com/",
        "data_kind": "modelled_current_conditions",
        "attribution": "Weather data by Open-Meteo",
        "location": {
            "name": "Cape Town CBD",
            "latitude": float(payload["latitude"]),
            "longitude": float(payload["longitude"]),
            "timezone": payload.get("timezone") or "Africa/Johannesburg",
        },
        "valid_at": str(valid_at),
        "fetched_at": fetched_at,
        "stale": False,
        "temperature_2m_c": _number(current, "temperature_2m"),
        "apparent_temperature_c": _number(current, "apparent_temperature"),
        "relative_humidity_2m_pct": _number(current, "relative_humidity_2m"),
        "precipitation_mm": _number(current, "precipitation"),
        "weather_code": int(_number(current, "weather_code")),
        "cloud_cover_pct": _number(current, "cloud_cover"),
        "shortwave_radiation_wm2": _number(current, "shortwave_radiation"),
        "wind_speed_10m_mps": _number(current, "wind_speed_10m"),
        "wind_direction_10m_deg": _number(current, "wind_direction_10m") % 360.0,
        "wind_gusts_10m_mps": _number(current, "wind_gusts_10m"),
        "is_day": bool(int(_number(current, "is_day"))),
        "units": {
            "temperature": "°C",
            "relative_humidity": "%",
            "precipitation": "mm",
            "radiation": "W/m²",
            "wind_speed": "m/s",
            "wind_direction": "°",
        },
    }


def clear_weather_cache() -> None:
    """Test/helper hook; production callers normally rely on the TTL."""
    global _cache, _cache_monotonic
    with _lock:
        _cache = None
        _cache_monotonic = 0.0


def current_weather(force: bool = False) -> dict[str, Any]:
    """Return normalized current conditions, falling back to stale cached data."""
    global _cache, _cache_monotonic
    now = time.monotonic()
    with _lock:
        if _cache is not None and not force and now - _cache_monotonic < CACHE_SECONDS:
            return {**_cache, "stale": False}

        longitude, latitude = _scene_location()
        parameters = {
            "latitude": f"{latitude:.6f}",
            "longitude": f"{longitude:.6f}",
            "current": ",".join(CURRENT_VARIABLES),
            "timezone": "Africa/Johannesburg",
            "temperature_unit": "celsius",
            "wind_speed_unit": "ms",
            "precipitation_unit": "mm",
        }
        base_url = os.environ.get("WEATHER_API_BASE_URL", DEFAULT_BASE_URL)
        url = f"{base_url}?{urlencode(parameters)}"
        fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            normalized = _normalize(_fetch_json(url), fetched_at)
        except Exception as error:
            if _cache is None:
                raise RuntimeError(f"current weather unavailable: {error}") from error
            return {
                **_cache,
                "stale": True,
                "warning": f"Live refresh failed; showing the last successful response ({error}).",
            }

        _cache = normalized
        _cache_monotonic = now
        return dict(normalized)
