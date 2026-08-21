"""FastAPI service for the Cape Town wind explorer."""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
import json
import logging
import math
import os
from pathlib import Path
import secrets
import shutil
import time
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from dotenv import load_dotenv
from shapely.geometry import box, mapping, shape

from .field import (
    FIELD_VERSION,
    VALID_DIRECTIONS,
    build_field, build_comfort_field,
    current_model_kind,
    database_url,
    direction_name,
    load_viewer_config,
    get_connection,
    local_bounds,
    project_polygons,
    query_polygons,
    request_from_payload,
)
from .heat import HEAT_METRICS, HEAT_METRIC_METADATA, heat_zones
from .flood import dem_control_summary, flood_preview
from .sunlight import (
    SunlightAnalysisCancelled,
    building_surface_sunlight,
    cancel_sunlight_analysis,
    finish_sunlight_analysis,
)
from .location import streetview_location
from .weather import current_weather
from .traffic import SCENARIOS as TRAFFIC_SCENARIOS
from .traffic import (
    DEFAULT_TRAFFIC_OBSERVATION_INTERVAL_S,
    closure_preview,
    current_traffic,
    drawable_road_edges,
    named_roads,
    permanent_road_statuses,
    record_traffic_observation,
)
from .wind_metrics import COMFORT_CATEGORIES, STABILITY_PROFILES, validate_against_observations
from .era5_wind import climatology_summary

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = FastAPI(title="Cape Town Wind Explorer API", version="0.1.0")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
PUBLIC_ROOT = PROJECT_ROOT / "public"
ASSET_ROOT = PUBLIC_ROOT / "assets"
ALLOWED_ORIGINS = [
    item.strip()
    for item in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:8000,http://127.0.0.1:8000",
    ).split(",")
    if item.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
# The traffic and flood previews return long arrays of rounded numbers, which
# compress by roughly 5x. Worth it even on localhost for the multi-megabyte
# vehicle-trajectory responses.
app.add_middleware(GZipMiddleware, minimum_size=8192)

LOGGER = logging.getLogger("climate_explorer.requests")
HEAVY_PATH_LIMITS = {
    "/api/heat/zones": int(os.getenv("HEAT_CONCURRENCY", "2")),
    "/api/sunlight/building-surfaces": int(os.getenv("SUNLIGHT_CONCURRENCY", "2")),
    "/api/wind/preview": int(os.getenv("WIND_CONCURRENCY", "2")),
    "/api/wind/comfort": int(os.getenv("WIND_COMFORT_CONCURRENCY", "1")),
    "/api/wind/validate": int(os.getenv("WIND_CONCURRENCY", "2")),
    "/api/flood/preview": int(os.getenv("FLOOD_CONCURRENCY", "1")),
    "/api/traffic/closure-preview": int(os.getenv("TRAFFIC_CONCURRENCY", "1")),
}
HEAVY_SEMAPHORES = {path: asyncio.Semaphore(max(1, limit)) for path, limit in HEAVY_PATH_LIMITS.items()}
RATE_LIMIT_REQUESTS = max(1, int(os.getenv("SIMULATION_RATE_LIMIT", "12")))

TRAFFIC_OBSERVATION_INTERVAL_S = max(
    300, int(os.getenv("TRAFFIC_OBSERVATION_INTERVAL_S", str(DEFAULT_TRAFFIC_OBSERVATION_INTERVAL_S)))
)
_traffic_observation_task: asyncio.Task | None = None


async def _traffic_observation_loop() -> None:
    """Periodically snapshot TomTom speed ratios so the fixed time-of-day
    demand profiles can eventually be nudged toward observed reality
    instead of only hand-tuned constants -- see
    `server/traffic.py::record_traffic_observation`. Runs for the life of
    the process; a single failed tick (TomTom down, no API key) must not
    kill collection for every tick after it.
    """
    while True:
        try:
            await asyncio.to_thread(record_traffic_observation)
        except Exception as error:
            LOGGER.warning("traffic observation tick failed: %s", error)
        await asyncio.sleep(TRAFFIC_OBSERVATION_INTERVAL_S)


@app.on_event("startup")
async def _start_traffic_observation_loop() -> None:
    global _traffic_observation_task
    _traffic_observation_task = asyncio.create_task(_traffic_observation_loop())


@app.on_event("shutdown")
async def _stop_traffic_observation_loop() -> None:
    if _traffic_observation_task is not None:
        _traffic_observation_task.cancel()
RATE_LIMIT_WINDOW_S = max(1, int(os.getenv("SIMULATION_RATE_WINDOW_S", "60")))
RATE_HISTORY: dict[str, deque[float]] = defaultdict(deque)
RATE_LOCK = asyncio.Lock()


@app.middleware("http")
async def protect_and_observe_requests(request: Request, call_next):
    """Apply deployment-safe API controls without changing simulation code."""
    started = time.monotonic()
    request_id = request.headers.get("x-request-id") or secrets.token_hex(8)
    path = request.url.path
    api_key = os.getenv("CLIMATE_EXPLORER_API_KEY")
    if api_key and path.startswith("/api/") and path != "/api/health":
        supplied = request.headers.get("x-api-key", "")
        if not secrets.compare_digest(supplied, api_key):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "missing or invalid API key"}, status_code=401)

    semaphore = HEAVY_SEMAPHORES.get(path) if request.method in {"GET", "POST"} else None
    if semaphore is not None:
        client = request.client.host if request.client else "unknown"
        now = time.monotonic()
        async with RATE_LOCK:
            history = RATE_HISTORY[client]
            while history and history[0] <= now - RATE_LIMIT_WINDOW_S:
                history.popleft()
            if len(history) >= RATE_LIMIT_REQUESTS:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    {"detail": "simulation rate limit exceeded"}, status_code=429,
                    headers={"Retry-After": str(RATE_LIMIT_WINDOW_S)},
                )
            history.append(now)
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=0.01)
        except TimeoutError:
            from fastapi.responses import JSONResponse
            return JSONResponse(
                {"detail": "simulation queue is full; retry shortly"}, status_code=503,
                headers={"Retry-After": "2"},
            )
    try:
        response = await call_next(request)
    finally:
        if semaphore is not None:
            semaphore.release()
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if request.query_params.get("v")
            else "public, max-age=0, must-revalidate"
        )
    LOGGER.info(json.dumps({
        "event": "http_request", "request_id": request_id, "method": request.method,
        "path": path, "status": response.status_code,
        "duration_ms": round((time.monotonic() - started) * 1000, 1),
    }, separators=(",", ":")))
    return response


@app.middleware("http")
async def prevent_stale_viewer_shell(request: Request, call_next):
    """Always revalidate the viewer shell while local development is active.

    Generated scene assets retain their byte/hash query cache keys, but stale
    HTML or JavaScript can otherwise keep an old renderer paired with a newly
    generated city model after a normal browser refresh.
    """
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css", "/manifest.json")):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


class PreviewPayload(BaseModel):
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    center_local: list[float] | None = Field(default=None, min_length=2, max_length=2)
    size_m: float = Field(default=250.0, ge=100.0, le=1200.0)
    direction_deg: float = Field(default=135.0, ge=0.0, lt=360.0)
    season: str = "annual"
    reference_speed_mps: float = Field(default=10.0, ge=0.0, le=50.0)
    reference_height_m: float | None = Field(default=None, ge=1.0, le=100.0)
    height_m: float = Field(default=2.0, ge=1.0, le=10.0)
    resolution_m: float = Field(default=5.0, ge=2.0, le=20.0)
    stability: Literal["unstable", "neutral", "stable"] = "neutral"
    exceedance_threshold_mps: float = Field(default=6.0, ge=1.0, le=30.0)
    forcing_mode: Literal["manual", "era5_climatology"] = "manual"


class WindObservation(BaseModel):
    id: str | None = None
    x: float
    z: float
    speed_mps: float = Field(ge=0.0, le=80.0)
    height_m: float = Field(default=2.0, ge=0.5, le=20.0)
    observed_at: str | None = None


class WindValidationPayload(BaseModel):
    scenario: PreviewPayload
    observations: list[WindObservation] = Field(min_length=3, max_length=500)


class TrafficClosurePayload(BaseModel):
    road_name: str | None = None
    edge_ids: list[str] = Field(default_factory=list, max_length=120)
    duration_min: float = Field(default=10.0, ge=5.0, le=20.0)
    scenario: Literal["am_peak", "midday", "pm_peak", "evening", "live"] = "am_peak"
    closure_mode: Literal["lane", "full"] = "lane"
    closure_scope: Literal["block", "road"] = "block"
    traffic_control: Literal["signalized", "priority"] = "signalized"
    demand_multiplier: float = Field(default=1.0, ge=0.5, le=1.5)
    one_way: bool = False


class FloodPayload(BaseModel):
    center_local: list[float] = Field(default=[0.0, 0.0], min_length=2, max_length=2)
    bounds_local: list[float] | None = Field(default=None, min_length=4, max_length=4)
    size_m: float = Field(default=500.0, ge=150.0, le=1200.0)
    resolution_m: float = Field(default=4.0, ge=2.0, le=10.0)
    rainfall_mm_h: float = Field(default=50.0, ge=1.0, le=300.0)
    duration_min: float = Field(default=60.0, ge=5.0, le=360.0)
    infiltration_mm_h: float = Field(default=5.0, ge=0.0, le=100.0)
    manning_n: float = Field(default=0.04, ge=0.015, le=0.15)

    @model_validator(mode="after")
    def enforce_work_budget(self):
        if self.bounds_local is not None:
            width = abs(self.bounds_local[2] - self.bounds_local[0])
            height = abs(self.bounds_local[3] - self.bounds_local[1])
        else:
            width = height = self.size_m
        cells = math.ceil(width / self.resolution_m) * math.ceil(height / self.resolution_m)
        cell_minutes = cells * self.duration_min
        if cells > 90_000 or cell_minutes > 3_000_000:
            raise ValueError(
                "flood workload exceeds the service budget; reduce the box, duration, or use a coarser grid"
            )
        return self


@app.get("/api/health")
def health() -> dict[str, Any]:
    checks: dict[str, Any] = {}
    try:
        manifest = json.loads((ASSET_ROOT / "manifest.json").read_text(encoding="utf-8"))
        missing = []
        mismatched = []
        for asset_name in manifest.get("assets", {}).values():
            asset_path = ASSET_ROOT / asset_name
            if not asset_path.is_file():
                missing.append(asset_name)
                continue
            layer_name = next((key for key, value in manifest["assets"].items() if value == asset_name), None)
            expected = (manifest.get("layers", {}).get(layer_name) or {}).get("bytes")
            if expected is not None and asset_path.stat().st_size != expected:
                mismatched.append(asset_name)
        compatible = manifest.get("version") == 3
        checks["assets"] = {
            "status": "ok" if not missing and not mismatched and compatible else "error",
            "manifest_version": manifest.get("version"), "missing": missing,
            "compatible": compatible, "size_mismatches": mismatched,
        }
    except Exception as error:
        checks["assets"] = {"status": "error", "detail": str(error)}
    checks["sumo"] = {
        "status": "ok" if shutil.which("sumo") and (PROJECT_ROOT / "data/sumo/cbd.net.xml").is_file() else "unavailable",
        "binary": shutil.which("sumo"),
        "network": (PROJECT_ROOT / "data/sumo/cbd.net.xml").is_file(),
    }
    if database_url():
        try:
            connection = get_connection()
            with connection, connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
            connection.close()
            checks["database"] = {"status": "ok"}
        except Exception as error:
            checks["database"] = {"status": "error", "detail": type(error).__name__}
    else:
        checks["database"] = {"status": "optional_not_configured"}
    required_ok = checks["assets"]["status"] == "ok"
    return {
        "status": "ok" if required_ok else "degraded",
        "field_version": FIELD_VERSION,
        "checks": checks,
        "limits": {"heavy_concurrency": HEAVY_PATH_LIMITS, "rate_requests": RATE_LIMIT_REQUESTS, "rate_window_s": RATE_LIMIT_WINDOW_S},
    }


@app.get("/api/heat/metrics")
def heat_metrics() -> dict[str, Any]:
    return {
        "metrics": [
            {"key": key, "label": label, **HEAT_METRIC_METADATA[key]}
            for key, label in HEAT_METRICS.items()
        ]
    }


@app.get("/api/weather/current")
def weather_current(refresh: bool = False) -> dict[str, Any]:
    try:
        return current_weather(force=refresh)
    except Exception as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/location/streetview")
def location_streetview(x: float, z: float) -> dict[str, Any]:
    try:
        return streetview_location(x, z)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/heat/zones")
def heat_preview(
    metric: str = "heat_model_lst_c", date: str = "2026-01-15", minutes: int = 720,
    start_minutes: int = 480, end_minutes: int = 1080, step_minutes: int = 60,
    min_x: float | None = None, min_z: float | None = None,
    max_x: float | None = None, max_z: float | None = None,
) -> dict[str, Any]:
    try:
        bounds = (min_x, min_z, max_x, max_z)
        if any(value is not None for value in bounds):
            if not all(value is not None and math.isfinite(value) for value in bounds):
                raise ValueError("analysis domain requires finite min_x, min_z, max_x, and max_z")
            if min_x >= max_x or min_z >= max_z:
                raise ValueError("analysis domain bounds must have positive width and height")
        # Cumulative ground sunlight is expensive. Calculate only the selected
        # domain instead of ray-testing the whole CBD and clipping afterwards.
        if metric == "cumulative_sun_hours" and all(value is not None for value in bounds):
            payload = heat_zones(
                metric, date, minutes, start_minutes, end_minutes, step_minutes,
                tuple(float(value) for value in bounds),
            )
            return {**payload, "domain_bounds": bounds}
        payload = heat_zones(metric, date, minutes, start_minutes, end_minutes, step_minutes)
        if not any(value is not None for value in bounds):
            return payload
        domain = box(min_x, min_z, max_x, max_z)
        features = []
        for source in payload.get("features", []):
            clipped = shape(source["geometry"]).intersection(domain)
            if clipped.is_empty or clipped.area < 0.01:
                continue
            feature = {**source, "geometry": mapping(clipped), "area_m2": clipped.area}
            features.append(feature)
        result = {**payload, "features": features, "count": len(features), "domain_bounds": bounds}
        total_area = sum(feature["area_m2"] for feature in features)
        weighted = sum(float(feature.get("value", 0)) * feature["area_m2"] for feature in features)
        summary = {**payload.get("summary", {})}
        summary["total_area_m2"] = total_area
        summary["area_weighted_mean"] = weighted / total_area if total_area else None
        summary["maximum"] = max((float(feature.get("value", 0)) for feature in features), default=None)
        threshold = summary.get("hotspot_threshold")
        if threshold is not None and total_area:
            hotspot_area = sum(feature["area_m2"] for feature in features if float(feature.get("value", 0)) >= threshold)
            summary["hotspot_area_m2"] = hotspot_area
            summary["hotspot_area_pct"] = hotspot_area / total_area * 100
        result["summary"] = summary
        return result
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"heat data unavailable: {error}") from error


@app.get("/api/sunlight/building-surfaces")
def sunlight_building_surfaces(
    date: str = "2026-01-15", start_minutes: int = 480, end_minutes: int = 1080,
    step_minutes: int = 60, resolution_m: float = 10.0, surfaces: str = "all",
    min_x: float | None = None, min_z: float | None = None,
    max_x: float | None = None, max_z: float | None = None,
    analysis_id: str | None = None,
) -> dict[str, Any]:
    try:
        if analysis_id is not None and (not analysis_id or len(analysis_id) > 100):
            raise ValueError("analysis_id must contain 1 to 100 characters")
        calculate = building_surface_sunlight.__wrapped__ if analysis_id else building_surface_sunlight
        return calculate(
            date, start_minutes, end_minutes, step_minutes, resolution_m, surfaces,
            min_x, min_z, max_x, max_z, analysis_id,
        )
    except SunlightAnalysisCancelled as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"building sunlight unavailable: {error}") from error
    finally:
        finish_sunlight_analysis(analysis_id)


@app.post("/api/sunlight/cancel")
def sunlight_cancel(analysis_id: str) -> dict[str, bool]:
    if not analysis_id or len(analysis_id) > 100:
        raise HTTPException(status_code=422, detail="analysis_id must contain 1 to 100 characters")
    cancel_sunlight_analysis(analysis_id)
    return {"cancelled": True}


@app.get("/api/wind/scenarios")
def scenarios() -> dict[str, Any]:
    config = load_viewer_config()
    era5 = climatology_summary()
    return {
        "field_version": FIELD_VERSION,
        "model_kind": current_model_kind(),
        "validation_status": "exploratory_not_engineering_grade",
        "directions": [{"name": name, "azimuth_deg": azimuth} for name, azimuth in VALID_DIRECTIONS.items()],
        "seasons": ["annual", "summer", "autumn", "winter", "spring"],
        "stability_profiles": STABILITY_PROFILES,
        "comfort_categories": COMFORT_CATEGORIES,
        "available_modes": ["preview"],
        "validated_mode_reason": "No versioned CFD/measurement validation dataset is installed",
        "frequency_status": "provisional_incomplete_era5_archive" if era5 else "conditional_only_no_climatology",
        "era5_climatology": era5,
        "viewer": config,
    }


@app.post("/api/wind/preview")
def preview(payload: PreviewPayload) -> dict[str, Any]:
    config = load_viewer_config()
    try:
        request = request_from_payload(payload.model_dump(), config)
        bounds = local_bounds(request, config)
        viewer_bounds = config["bounds"]
        if bounds[2] < viewer_bounds[0] or bounds[0] > viewer_bounds[2] or bounds[3] < viewer_bounds[1] or bounds[1] > viewer_bounds[3]:
            raise ValueError("analysis box is outside the CBD scene")
        polygons = query_polygons(request, bounds, config)
        projected = project_polygons(polygons, config)
        field = build_field(request, bounds, projected)
        field["direction_name"] = direction_name(request.direction_deg)
        field["polygon_count"] = len(polygons)
        return field
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"wind data unavailable: {error}") from error


@app.post("/api/wind/comfort")
def wind_comfort(payload: PreviewPayload) -> dict[str, Any]:
    """Return a 16-direction, wind-rose-weighted comfort screening field."""
    config = load_viewer_config()
    try:
        request = request_from_payload({**payload.model_dump(), "forcing_mode": "era5_climatology"}, config)
        bounds = local_bounds(request, config)
        viewer_bounds = config["bounds"]
        if bounds[2] < viewer_bounds[0] or bounds[0] > viewer_bounds[2] or bounds[3] < viewer_bounds[1] or bounds[1] > viewer_bounds[3]:
            raise ValueError("analysis box is outside the CBD scene")
        field = build_comfort_field(request, bounds, config)
        field["polygon_count"] = len(field.get("polygons") or [])
        return field
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"wind comfort unavailable: {error}") from error


@app.post("/api/wind/validate")
def validate_wind(payload: WindValidationPayload) -> dict[str, Any]:
    """Benchmark one scenario against co-located pedestrian observations.

    This intentionally returns benchmark_only status. Promotion to validated
    mode requires versioned independent datasets and project-specific gates.
    """
    config = load_viewer_config()
    try:
        request = request_from_payload(payload.scenario.model_dump(), config)
        bounds = local_bounds(request, config)
        observations = [item.model_dump() for item in payload.observations]
        for item in observations:
            if not (bounds[0] <= item["x"] <= bounds[2] and bounds[1] <= item["z"] <= bounds[3]):
                raise ValueError(f"observation {item.get('id') or ''} is outside the analysis domain")
        projected = project_polygons(query_polygons(request, bounds, config), config)
        field = build_field(request, bounds, projected)
        return {"field_version": FIELD_VERSION, "field": field, "validation": validate_against_observations(field, observations)}
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"wind validation unavailable: {error}") from error


@app.get("/api/traffic/live")
def traffic_live(refresh: bool = False) -> dict[str, Any]:
    try:
        return current_traffic(force=refresh)
    except Exception as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/traffic/roads")
def traffic_roads() -> dict[str, Any]:
    network_edges = list(drawable_road_edges())
    return {
        "roads": list(named_roads()),
        "network_edges": network_edges,
        "road_statuses": list(permanent_road_statuses()),
        "road_data": {
            "routing_topology": "OpenStreetMap via SUMO",
            "centreline_source": "City of Cape Town TCT Road Centerline",
            "municipal_matched_edges": sum(1 for edge in network_edges if edge.get("official")),
            "total_edges": len(network_edges),
        },
        "scenarios": [
            {"key": key, "label": profile["label"]}
            for key, profile in TRAFFIC_SCENARIOS.items()
        ],
    }


@app.post("/api/traffic/closure-preview")
def traffic_closure_preview(payload: TrafficClosurePayload) -> dict[str, Any]:
    try:
        return closure_preview(payload.model_dump())
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"traffic closure preview unavailable: {error}") from error


@app.get("/api/flood/dem-quality")
def flood_dem_quality() -> dict[str, Any]:
    return dem_control_summary()


@app.post("/api/flood/preview")
def flood_surface_preview(payload: FloodPayload) -> dict[str, Any]:
    try:
        return flood_preview(payload.model_dump())
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"flood simulation unavailable: {error}") from error


@app.get("/api/wind/field/{direction}/{tile}")
def field_tile(direction: str, tile: str) -> dict[str, str]:
    """Reserved tile endpoint; preview is the supported first-release path."""
    if direction.upper() not in VALID_DIRECTIONS and not direction.startswith("az_"):
        raise HTTPException(status_code=404, detail="unknown direction")
    return {"status": "use_preview", "direction": direction, "tile": tile}


# Brand assets live with the source data rather than the generated viewer
# bundle. Expose them explicitly before the catch-all public mount so reports
# and print previews can use the approved Mission identity.
app.mount(
    "/branding",
    StaticFiles(directory=Path(__file__).resolve().parents[1] / "data" / "branding"),
    name="branding",
)

# Serving the existing static viewer from the same process keeps the browser
# same-origin with the API and avoids exposing DATABASE_URL to client code.
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[1] / "public", html=True), name="public")
