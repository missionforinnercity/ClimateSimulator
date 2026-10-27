"""FastAPI service for Conditions."""

from __future__ import annotations

import asyncio
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import hashlib
import json
import logging
import math
import os
import re
from pathlib import Path
import secrets
import shutil
import threading
import time
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from shapely.geometry import Point, Polygon, box, mapping, shape

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
from .heat import HEAT_METRICS, HEAT_METRIC_METADATA, design_shade_comparison, heat_zones
from .groundcover import mapped_groundcover
from .runoff import runoff_screening_manifest
from .sunlight import (
    SunlightAnalysisCancelled,
    _analysis_cancelled,
    _ground_cells,
    _scene_geometry,
    _scene_geometry_with_design,
    _sun_hours_for_cells,
    _terrain_grid,
    building_surface_sunlight,
    cancel_sunlight_analysis,
    finish_sunlight_analysis,
)
from .solar import sun_position
from .location import streetview_location
from .weather import current_weather
from .thermal_products import (
    ThermalProductUnavailable,
    energy_payload,
    frame_path,
    product_health,
    forecast_status as thermal_forecast_status,
    sample_point as sample_thermal_point,
    sky_view_factor_manifest,
    sky_view_factor_path,
)
from .thermal_climatology import (
    ThermalClimatologyUnavailable,
    frame_path as thermal_climatology_frame_path,
    manifest as thermal_climatology_manifest,
)
from .thermal_scenario import shade_scenario
from .walking_routes import NETWORK_PATH as WALKING_NETWORK_PATH
from .walking_routes import walking_agent_comparison, walking_routes
from .traffic import SCENARIOS as TRAFFIC_SCENARIOS
from .traffic import (
    DEFAULT_TRAFFIC_OBSERVATION_INTERVAL_S,
    closure_preview,
    current_traffic,
    drawable_road_edges,
    named_roads,
    permanent_road_statuses,
    record_traffic_observation,
    traffic_emissions_preview,
    traffic_calibration_status,
)
from .wind_metrics import COMFORT_CATEGORIES, STABILITY_PROFILES, validate_against_observations
from .era5_wind import SECTORS, climatology_summary, forcing_profile

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = FastAPI(
    title="Conditions API",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)
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
    expose_headers=["X-Request-ID", "Retry-After", "X-Thermal-Scenario"],
)
# Large renderer and simulation responses benefit from gzip. Level 1 keeps
# nearly the same size for the large float32 CFD fields while avoiding the
# much higher CPU cost of the default level 9; JSON remains compressed without
# delaying scene and result delivery for maximum byte savings.
app.add_middleware(GZipMiddleware, minimum_size=8192, compresslevel=1)

LOGGER = logging.getLogger("conditions.requests")
HEAVY_PATH_LIMITS = {
    "/api/heat/zones": int(os.getenv("HEAT_CONCURRENCY", "2")),
    "/api/heat/design-comparison": int(os.getenv("HEAT_DESIGN_CONCURRENCY", "1")),
    "/api/sunlight/building-surfaces": int(os.getenv("SUNLIGHT_CONCURRENCY", "2")),
    "/api/sunlight/design-comparison": int(os.getenv("SUNLIGHT_CONCURRENCY", "1")),
    "/api/wind/preview": int(os.getenv("WIND_CONCURRENCY", "2")),
    "/api/wind/comfort": int(os.getenv("WIND_COMFORT_CONCURRENCY", "1")),
    "/api/wind/validate": int(os.getenv("WIND_CONCURRENCY", "2")),
    "/api/traffic/closure-preview": int(os.getenv("TRAFFIC_CONCURRENCY", "1")),
    "/api/traffic/closure-preview/jobs": int(os.getenv("TRAFFIC_CONCURRENCY", "1")),
    "/api/traffic/emissions-preview/jobs": int(os.getenv("TRAFFIC_CONCURRENCY", "1")),
    "/api/walking/routes": int(os.getenv("WALKING_ROUTE_CONCURRENCY", "1")),
}
HEAVY_SEMAPHORES = {path: asyncio.Semaphore(max(1, limit)) for path, limit in HEAVY_PATH_LIMITS.items()}
RATE_LIMIT_REQUESTS = max(1, int(os.getenv("SIMULATION_RATE_LIMIT", "12")))

TRAFFIC_OBSERVATION_INTERVAL_S = max(
    300, int(os.getenv("TRAFFIC_OBSERVATION_INTERVAL_S", str(DEFAULT_TRAFFIC_OBSERVATION_INTERVAL_S)))
)
_traffic_observation_task: asyncio.Task | None = None

# A paired 20-minute SUMO comparison can legitimately run for several minutes.
# Keep it outside the HTTP request lifetime so browser and reverse-proxy timeouts
# cannot discard a healthy simulation. A single worker also protects TraCI,
# whose global connection registry is unsafe for overlapping runs.
TRAFFIC_JOB_MAX_PENDING = max(1, int(os.getenv("TRAFFIC_JOB_MAX_PENDING", "2")))
TRAFFIC_JOB_TTL_S = max(60, int(os.getenv("TRAFFIC_JOB_TTL_S", "900")))
TRAFFIC_JOB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="traffic-preview")
TRAFFIC_JOBS: OrderedDict[str, dict[str, Any]] = OrderedDict()
TRAFFIC_JOBS_LOCK = threading.Lock()
WALKING_AGENT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="walking-agents")
WALKING_AGENT_JOBS: OrderedDict[str, dict[str, Any]] = OrderedDict()
WALKING_AGENT_JOBS_LOCK = threading.Lock()
WALKING_AGENT_JOB_TTL_S = 900
WALKING_AGENT_MAX_PENDING = 3


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
    TRAFFIC_JOB_EXECUTOR.shutdown(wait=False, cancel_futures=True)
RATE_LIMIT_WINDOW_S = max(1, int(os.getenv("SIMULATION_RATE_WINDOW_S", "60")))
RATE_LIMIT_MAX_CLIENTS = max(1, int(os.getenv("SIMULATION_RATE_MAX_CLIENTS", "10000")))
# Ordered by last admitted request, allowing expired clients to be removed
# without scanning every active client. Never evict an active client's budget.
RATE_HISTORY: OrderedDict[str, deque[float]] = OrderedDict()
RATE_LOCK = asyncio.Lock()


async def _dispatch_protected_request(request: Request, call_next):
    path = request.url.path
    api_key = os.getenv("CONDITIONS_API_KEY")
    preflight = (
        request.method == "OPTIONS" and "origin" in request.headers
        and "access-control-request-method" in request.headers
    )
    if api_key and path.startswith("/api/") and path != "/api/health" and not preflight:
        supplied = request.headers.get("x-api-key", "")
        if not secrets.compare_digest(supplied.encode("utf-8"), api_key.encode("utf-8")):
            return JSONResponse({"detail": "missing or invalid API key"}, status_code=401)

    semaphore = HEAVY_SEMAPHORES.get(path) if request.method in {"GET", "POST"} else None
    if semaphore is not None:
        client = request.client.host if request.client else "unknown"
        now = time.monotonic()
        async with RATE_LOCK:
            while RATE_HISTORY:
                oldest = next(iter(RATE_HISTORY.values()))
                if oldest and oldest[-1] > now - RATE_LIMIT_WINDOW_S:
                    break
                RATE_HISTORY.popitem(last=False)
            if client not in RATE_HISTORY:
                if len(RATE_HISTORY) >= RATE_LIMIT_MAX_CLIENTS:
                    return JSONResponse(
                        {"detail": "simulation rate tracker is full; retry shortly"},
                        status_code=503, headers={"Retry-After": str(RATE_LIMIT_WINDOW_S)},
                    )
                RATE_HISTORY[client] = deque()
            history = RATE_HISTORY[client]
            while history and history[0] <= now - RATE_LIMIT_WINDOW_S:
                history.popleft()
            if len(history) >= RATE_LIMIT_REQUESTS:
                return JSONResponse(
                    {"detail": "simulation rate limit exceeded"}, status_code=429,
                    headers={"Retry-After": str(max(1, math.ceil(history[0] + RATE_LIMIT_WINDOW_S - now)))},
                )
            history.append(now)
            RATE_HISTORY.move_to_end(client)
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=0.01)
        except TimeoutError:
            return JSONResponse(
                {"detail": "simulation queue is full; retry shortly"}, status_code=503,
                headers={"Retry-After": "2"},
            )
    try:
        return await call_next(request)
    finally:
        if semaphore is not None:
            semaphore.release()


@app.middleware("http")
async def protect_and_observe_requests(request: Request, call_next):
    """Finalize successful responses and early errors through the same path."""
    started = time.monotonic()
    supplied_id = request.headers.get("x-request-id", "")
    request_id = supplied_id if re.fullmatch(r"[A-Za-z0-9._-]{1,100}", supplied_id) else secrets.token_hex(8)
    request.state.request_id = request_id
    path = request.url.path
    try:
        response = await _dispatch_protected_request(request, call_next)
    except Exception:
        LOGGER.exception("Unhandled request failure request_id=%s", request_id)
        response = JSONResponse({"detail": "internal server error"}, status_code=500)
    response.headers["X-Request-ID"] = request_id
    # Early auth/rate errors bypass the inner CORS middleware. Preserve the
    # same explicit allow-list so approved clients can read those errors too.
    origin = request.headers.get("origin")
    if origin in ALLOWED_ORIGINS and "Access-Control-Allow-Origin" not in response.headers:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Expose-Headers"] = "X-Request-ID, Retry-After, X-Thermal-Scenario"
        response.headers["Vary"] = ", ".join(filter(None, [response.headers.get("Vary"), "Origin"]))
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    if path.startswith("/assets/") and response.status_code < 400:
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
    seed_count: Literal[1, 3, 5] = 1
    one_way: bool = False


class TrafficEmissionsPayload(BaseModel):
    duration_min: float = Field(default=10.0, ge=5.0, le=15.0)
    scenario: Literal["am_peak", "midday", "pm_peak", "evening"] = "am_peak"
    demand_multiplier: float = Field(default=1.0, ge=0.5, le=1.5)
    seed: int = Field(default=240917, ge=0, le=2_147_483_647)


class ThermalScenarioPayload(BaseModel):
    run_id: str
    frame_id: str
    x: float = Field(ge=-5000, le=5000)
    z: float = Field(ge=-5000, le=5000)
    radius_m: float = Field(default=12.0, ge=2.0, le=80.0)
    shade_percent: float = Field(default=75.0, ge=1.0, le=100.0)
    intervention: Literal["tree", "shade"] = "tree"


class DesignBlockGeometry(BaseModel):
    ground_m: float = Field(ge=-500, le=1000)
    base_offset_m: float = Field(default=0, ge=0, le=900)
    height_m: float = Field(ge=2, le=300)
    ring: list[tuple[float, float]] = Field(min_length=3, max_length=256)
    holes: list[list[tuple[float, float]]] = Field(default_factory=list, max_length=32)


class DesignSunlightPayload(BaseModel):
    remove_building_indexes: list[int] = Field(default_factory=list, max_length=1000)
    add_buildings: list[DesignBlockGeometry] = Field(default_factory=list, max_length=100)
    date: str = Field(default="2026-01-15", pattern=r"^\d{4}-\d{2}-\d{2}$")
    start_minutes: int = Field(default=480, ge=0, le=1439)
    end_minutes: int = Field(default=1080, ge=1, le=1440)
    step_minutes: int = Field(default=60, ge=10, le=120)
    resolution_m: Literal[5, 10, 20, 40] = 10
    surfaces: Literal["all", "roofs", "facades"] = "all"
    analysis_id: str = Field(min_length=1, max_length=100)


class DesignHeatPayload(BaseModel):
    remove_building_indexes: list[int] = Field(default_factory=list, max_length=1000)
    add_buildings: list[DesignBlockGeometry] = Field(default_factory=list, max_length=100)
    date: str = Field(default="2026-01-15", pattern=r"^\d{4}-\d{2}-\d{2}$")
    minutes: int = Field(default=720, ge=0, le=1439)


class WalkingPoint(BaseModel):
    x: float = Field(ge=-5000, le=5000)
    z: float = Field(ge=-5000, le=5000)


class WalkingRoutesPayload(BaseModel):
    origin: WalkingPoint
    destination: WalkingPoint
    departure_at: str = Field(min_length=10, max_length=40)


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
    checks["assets"]["required"] = True
    checks["sumo"].update(required=False, affects=["traffic_closure_preview", "traffic_emissions_preview"])
    checks["database"].update(required=False, affects=["database_backed_layers"])
    checks["thermal"] = product_health()
    checks["walking_routes"] = {
        "status": "ok" if WALKING_NETWORK_PATH.is_file() else "unavailable",
        "required": False,
        "affects": ["walking_route_analysis"],
        "network_asset": WALKING_NETWORK_PATH.name,
    }
    return {
        "status": "ok" if required_ok else "degraded",
        "optional_degraded": [name for name, check in checks.items()
                              if not check["required"] and check["status"] not in {"ok", "optional_not_configured"}],
        "field_version": FIELD_VERSION,
        "checks": checks,
        "limits": {"heavy_concurrency": HEAVY_PATH_LIMITS, "rate_requests": RATE_LIMIT_REQUESTS, "rate_window_s": RATE_LIMIT_WINDOW_S,
                   "rate_max_clients": RATE_LIMIT_MAX_CLIENTS},
    }


@app.get("/api/heat/metrics")
def heat_metrics() -> dict[str, Any]:
    return {
        "metrics": [
            {"key": key, "label": label, **HEAT_METRIC_METADATA[key]}
            for key, label in HEAT_METRICS.items()
        ]
    }


@lru_cache(maxsize=1)
def _lighting_fixtures() -> tuple[dict[str, Any], ...]:
    path = ASSET_ROOT / "lighting.json"
    if not path.is_file():
        return ()
    payload = json.loads(path.read_text(encoding="utf-8"))
    return tuple(payload.get("cityFurniture") or ())


@app.get("/api/lighting/fixtures")
def lighting_fixtures(min_x: float, min_z: float, max_x: float, max_z: float) -> dict[str, Any]:
    """Return only the mapped lights near the requested local scene bounds."""
    bounds = (min_x, min_z, max_x, max_z)
    if not all(math.isfinite(value) for value in bounds) or max_x <= min_x or max_z <= min_z:
        raise HTTPException(status_code=422, detail="lighting bounds must be finite and have positive area")
    if max_x - min_x > 2200 or max_z - min_z > 2200:
        raise HTTPException(status_code=422, detail="lighting area is too large; zoom in to request local fixtures")
    fixtures = []
    for item in _lighting_fixtures():
        coordinates = item.get("coordinates")
        if coordinates and len(coordinates) >= 2:
            points = [coordinates]
        else:
            points = item.get("centerline") or []
        valid = [(float(point[0]), float(point[1])) for point in points if len(point) >= 2]
        if not valid:
            continue
        item_min_x = min(point[0] for point in valid)
        item_max_x = max(point[0] for point in valid)
        item_min_z = min(point[1] for point in valid)
        item_max_z = max(point[1] for point in valid)
        if item_max_x >= min_x and item_min_x <= max_x and item_max_z >= min_z and item_min_z <= max_z:
            fixtures.append(item)
    return {"cityFurniture": fixtures, "count": len(fixtures)}


@app.get("/api/weather/current")
def weather_current(refresh: bool = False) -> dict[str, Any]:
    try:
        return current_weather(force=refresh)
    except Exception as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/thermal/forecast")
def thermal_forecast() -> dict[str, Any]:
    # An empty product volume is an expected cold-start state, not an HTTP
    # service failure.  Clients can render a useful readiness message without
    # generating a noisy failed-resource entry in the browser console.
    return thermal_forecast_status()


@app.get("/api/thermal/climatology")
def thermal_climatology() -> dict[str, Any]:
    try:
        return thermal_climatology_manifest()
    except ThermalClimatologyUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/thermal/climatology/frames/{frame_id}")
def thermal_climatology_frame(frame_id: str):
    try:
        path = thermal_climatology_frame_path(frame_id)
        return FileResponse(path, media_type="application/octet-stream", filename=path.name)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ThermalClimatologyUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/thermal/frames/{run_id}/{frame_id}")
def thermal_frame(run_id: str, frame_id: str):
    try:
        path = frame_path(run_id, frame_id)
        return FileResponse(path, media_type="application/octet-stream", filename=path.name)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ThermalProductUnavailable as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/thermal/sky-view-factor")
def thermal_sky_view_factor():
    try:
        path = sky_view_factor_path()
        return FileResponse(path, media_type="application/octet-stream", filename=path.name)
    except ThermalProductUnavailable as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/thermal/sky-view-factor/manifest")
def thermal_sky_view_factor_manifest():
    try:
        return sky_view_factor_manifest()
    except ThermalProductUnavailable as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/thermal/point")
def thermal_point(x: float, z: float, frame_id: str, run_id: str | None = None) -> dict[str, Any]:
    try:
        return sample_thermal_point(x, z, frame_id, run_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ThermalProductUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/api/thermal/scenario")
def thermal_scenario(payload: ThermalScenarioPayload):
    try:
        raster, summary = shade_scenario(**payload.model_dump())
        return Response(
            content=raster, media_type="application/octet-stream",
            headers={"X-Thermal-Scenario": json.dumps(summary, separators=(",", ":"))},
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ThermalProductUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/thermal/energy")
def thermal_energy(run_id: str | None = None) -> dict[str, Any]:
    try:
        return energy_payload(run_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ThermalProductUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/location/streetview")
def location_streetview(x: float, z: float) -> dict[str, Any]:
    try:
        return streetview_location(x, z)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/walking/routes")
def walking_route_analysis(payload: WalkingRoutesPayload) -> dict[str, Any]:
    try:
        response, path_records, departure = walking_routes(
            payload.model_dump(), include_agents=False, return_plan=True,
        )
        now = time.monotonic()
        with WALKING_AGENT_JOBS_LOCK:
            for old_id, old in list(WALKING_AGENT_JOBS.items()):
                if old["status"] in {"complete", "error"} and now - old.get("finished_at", now) > WALKING_AGENT_JOB_TTL_S:
                    del WALKING_AGENT_JOBS[old_id]
            while len(WALKING_AGENT_JOBS) >= 48:
                old_id = next((key for key, job in WALKING_AGENT_JOBS.items() if job["status"] in {"complete", "error"}), None)
                if old_id is None:
                    break
                del WALKING_AGENT_JOBS[old_id]
            pending = sum(job["status"] in {"queued", "running"} for job in WALKING_AGENT_JOBS.values())
            if pending >= WALKING_AGENT_MAX_PENDING:
                response["route_generation"]["agent_status"] = "busy"
                return response
            job_id = secrets.token_urlsafe(12)
            WALKING_AGENT_JOBS[job_id] = {"status": "queued", "created_at": now}

        def run_agents() -> None:
            with WALKING_AGENT_JOBS_LOCK:
                WALKING_AGENT_JOBS[job_id]["status"] = "running"
            try:
                result = walking_agent_comparison(path_records, departure)
            except Exception as error:
                LOGGER.exception("Walking agent comparison failed")
                with WALKING_AGENT_JOBS_LOCK:
                    WALKING_AGENT_JOBS[job_id].update(status="error", error=str(error), finished_at=time.monotonic())
            else:
                with WALKING_AGENT_JOBS_LOCK:
                    WALKING_AGENT_JOBS[job_id].update(status="complete", result=result, finished_at=time.monotonic())

        WALKING_AGENT_EXECUTOR.submit(run_agents)
        response["agent_job_id"] = job_id
        return response
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        LOGGER.exception("Walking route analysis failed")
        raise HTTPException(status_code=503, detail=f"walking route analysis unavailable: {error}") from error


@app.get("/api/walking/agents/jobs/{job_id}")
def walking_agent_job(job_id: str) -> dict[str, Any]:
    with WALKING_AGENT_JOBS_LOCK:
        job = WALKING_AGENT_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="walking agent comparison expired or was not found")
        return {key: job[key] for key in ("status", "result", "error") if key in job}


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


@app.post("/api/heat/design-comparison")
def heat_design_comparison(payload: DesignHeatPayload) -> dict[str, Any]:
    try:
        additions = []
        for block in payload.add_buildings:
            ring = [[float(x), float(z)] for x, z in block.ring]
            holes = [[[float(x), float(z)] for x, z in hole] for hole in block.holes]
            if any(not math.isfinite(value) or abs(value) > 5000 for outline in [ring, *holes] for point in outline for value in point):
                raise ValueError("design block coordinates must be finite viewer-local metres within ±5000")
            footprint = Polygon(ring, holes)
            if not footprint.is_valid or footprint.is_empty or footprint.area < 1:
                raise ValueError("design block footprints and holes must form a valid polygon of at least 1 m²")
            additions.append({"ring": ring, "holes": holes,
                              "height_m": block.height_m + block.base_offset_m})
        return design_shade_comparison(payload.date, payload.minutes, payload.remove_building_indexes, additions)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        LOGGER.exception("design heat comparison failed")
        raise HTTPException(status_code=503, detail=f"design heat comparison unavailable: {error}") from error


@app.get("/api/groundcover")
def groundcover_inventory() -> dict[str, Any]:
    try:
        return mapped_groundcover()
    except (OSError, ValueError, KeyError) as error:
        raise HTTPException(status_code=503, detail="Mapped ground-cover inventory is unavailable") from error


@app.get("/api/runoff/screening")
def runoff_screening() -> dict[str, Any]:
    try:
        return runoff_screening_manifest()
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="Runoff screening asset is unavailable") from error
    except (OSError, ValueError, KeyError, TypeError) as error:
        LOGGER.exception("Runoff screening metadata is invalid")
        raise HTTPException(status_code=503, detail="Runoff screening asset is unavailable") from error
    except Exception as error:
        LOGGER.exception("Mapped ground-cover inventory failed")
        raise HTTPException(status_code=503, detail="Mapped ground-cover inventory is unavailable") from error


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


@app.post("/api/sunlight/design-comparison")
def sunlight_design_comparison(payload: DesignSunlightPayload) -> dict[str, Any]:
    """Run matched mapped-city and edited-city direct-sun studies."""
    try:
        records = json.loads((ASSET_ROOT / "fallback.json").read_text(encoding="utf-8")).get("buildings", [])
        if len(set(payload.remove_building_indexes)) != len(payload.remove_building_indexes):
            raise ValueError("removed building indexes must be unique")
        if any(index < 0 or index >= len(records) for index in payload.remove_building_indexes):
            raise ValueError(f"removed building indexes must be between 0 and {len(records) - 1}")
        if payload.start_minutes >= payload.end_minutes:
            raise ValueError("sunlight window must satisfy start < end")
        if len(payload.analysis_id) > 100:
            raise ValueError("analysis_id must contain 1 to 100 characters")
        if not payload.remove_building_indexes and not payload.add_buildings:
            raise ValueError("make at least one geometry edit before comparing sunlight")
        additions = []
        for block in payload.add_buildings:
            ring = [[float(x), float(z)] for x, z in block.ring]
            holes = [[[float(x), float(z)] for x, z in hole] for hole in block.holes]
            if any(not math.isfinite(value) or abs(value) > 5000 for outline in [ring, *holes] for point in outline for value in point):
                raise ValueError("design block coordinates must be finite viewer-local metres within ±5000")
            if len(set((round(x, 5), round(z, 5)) for x, z in ring)) < 3:
                raise ValueError("design block footprint needs at least three distinct points")
            if any(len(set((round(x, 5), round(z, 5)) for x, z in hole)) < 3 for hole in holes):
                raise ValueError("each design footprint hole needs at least three distinct points")
            if not Polygon(ring, holes).is_valid:
                raise ValueError("design block footprints and holes must form a valid polygon")
            additions.append([block.ground_m, block.height_m, ring, holes])
        changed_rings = [records[index][2] for index in payload.remove_building_indexes if len(records[index]) > 2]
        changed_rings.extend(item[2] for item in additions)
        changed_coordinates = [coordinate for ring in changed_rings for coordinate in ring]
        changed_heights = [float(block.height_m + block.base_offset_m) for block in payload.add_buildings]
        changed_heights.extend(float(records[index][1]) for index in payload.remove_building_indexes if len(records[index]) > 1)
        if not changed_coordinates:
            raise ValueError("the edited buildings have no usable footprints")
        changed_bounds = (
            min(point[0] for point in changed_coordinates), min(point[1] for point in changed_coordinates),
            max(point[0] for point in changed_coordinates), max(point[1] for point in changed_coordinates),
        )
        maximum_solar_shadow = 0.0
        for start in range(payload.start_minutes, payload.end_minutes, payload.step_minutes):
            duration = min(payload.step_minutes, payload.end_minutes - start)
            altitude, _, _ = sun_position(payload.date, start + duration / 2)
            if altitude > 0.008:
                maximum_solar_shadow = max(
                    maximum_solar_shadow,
                    max(changed_heights, default=0.0) / max(math.tan(altitude), 0.03),
                )
        impact_radius = min(800.0, max(250.0, maximum_solar_shadow + 60.0))
        terrain_bounds = _terrain_grid()["bounds"]
        local_domain = box(*changed_bounds).buffer(impact_radius).intersection(box(*terrain_bounds))
        if local_domain.is_empty:
            raise ValueError("edited buildings are outside the mapped sunlight study area")
        left, bottom, right, top = local_domain.bounds
        analysis_bounds = (
            max(terrain_bounds[0], math.floor(left / 100.0) * 100.0),
            max(terrain_bounds[1], math.floor(bottom / 100.0) * 100.0),
            min(terrain_bounds[2], math.ceil(right / 100.0) * 100.0),
            min(terrain_bounds[3], math.ceil(top / 100.0) * 100.0),
        )
        design_geometry = json.dumps({
            "remove_building_indexes": payload.remove_building_indexes,
            "add_buildings": additions,
        }, separators=(",", ":"), sort_keys=True)
        common = (
            payload.date, payload.start_minutes, payload.end_minutes, payload.step_minutes,
            float(payload.resolution_m), payload.surfaces,
            *analysis_bounds,
        )
        # The unchanged city study is identical across proposal revisions at
        # the same site and time, so let the shared LRU cache reuse it. Keep the
        # edited candidate cancellable as users continue adjusting massing.
        baseline = building_surface_sunlight(*common)
        if _analysis_cancelled(payload.analysis_id):
            raise SunlightAnalysisCancelled("sunlight analysis cancelled")
        candidate = building_surface_sunlight.__wrapped__(
            *common, payload.analysis_id, design_geometry_json=design_geometry,
        )

        sun_states = []
        for start in range(payload.start_minutes, payload.end_minutes, payload.step_minutes):
            duration = min(payload.step_minutes, payload.end_minutes - start)
            altitude, sun_x, sun_z = sun_position(payload.date, start + duration / 2)
            if altitude > 0.008:
                sun_states.append((altitude, sun_x, sun_z, duration / 60.0))
        baseline_scene = _scene_geometry()
        candidate_scene = _scene_geometry_with_design(json.loads(design_geometry))
        ground_before_cells = _ground_cells(baseline_scene, domain_bounds=analysis_bounds)
        ground_after_cells = _ground_cells(candidate_scene, domain_bounds=analysis_bounds)
        ground_before_values = _sun_hours_for_cells(ground_before_cells, sun_states, payload.analysis_id, baseline_scene)
        ground_after_values = _sun_hours_for_cells(ground_after_cells, sun_states, payload.analysis_id, candidate_scene)

        def ground_summary(cells: list[dict[str, Any]], values: list[float]) -> dict[str, Any]:
            area = sum(cell["area_m2"] for cell in cells)
            exposure = sum(cell["area_m2"] * value for cell, value in zip(cells, values))
            return {
                "mean_sun_hours": exposure / area if area else 0.0,
                "surface_area_m2": area,
                "sunlit_area_hours_m2": exposure,
                "cell_count": len(cells),
                "by_grid_cell": {cell["grid_key"]: value for cell, value in zip(cells, values)},
            }

        ground_before = ground_summary(ground_before_cells, ground_before_values)
        ground_after = ground_summary(ground_after_cells, ground_after_values)
        before_ground_cells, after_ground_cells = ground_before["by_grid_cell"], ground_after["by_grid_cell"]
        common_ground_keys = before_ground_cells.keys() & after_ground_cells.keys()
        paired_ground_before = sum(before_ground_cells[key] for key in common_ground_keys) / max(len(common_ground_keys), 1)
        paired_ground_after = sum(after_ground_cells[key] for key in common_ground_keys) / max(len(common_ground_keys), 1)
        affected_area = box(*changed_bounds).buffer(impact_radius)
        local_ground_keys = {
            key for key in common_ground_keys
            if affected_area.covers(Point(
                terrain_bounds[0] + 10 + key[1] * 20,
                terrain_bounds[1] + 10 + key[0] * 20,
            ))
        }
        local_ground_before = sum(before_ground_cells[key] for key in local_ground_keys) / max(len(local_ground_keys), 1)
        local_ground_after = sum(after_ground_cells[key] for key in local_ground_keys) / max(len(local_ground_keys), 1)

        terrain_columns = math.floor((terrain_bounds[2] - terrain_bounds[0]) / 20)
        terrain_rows = math.floor((terrain_bounds[3] - terrain_bounds[1]) / 20)
        ground_column_start = max(0, math.floor((analysis_bounds[0] - terrain_bounds[0]) / 20))
        ground_column_end = min(terrain_columns, math.ceil((analysis_bounds[2] - terrain_bounds[0]) / 20))
        ground_row_start = max(0, math.floor((analysis_bounds[1] - terrain_bounds[1]) / 20))
        ground_row_end = min(terrain_rows, math.ceil((analysis_bounds[3] - terrain_bounds[1]) / 20))
        ground_columns = max(1, ground_column_end - ground_column_start)
        ground_rows = max(1, ground_row_end - ground_row_start)

        def ground_raster(cells: list[dict[str, Any]], values: list[float]) -> list[float | None]:
            raster: list[float | None] = [None] * (ground_rows * ground_columns)
            for cell, value in zip(cells, values):
                row, column = cell["grid_key"]
                row, column = row - ground_row_start, column - ground_column_start
                if 0 <= row < ground_rows and 0 <= column < ground_columns:
                    raster[row * ground_columns + column] = round(value, 2)
            return raster

        ground_before_raster = ground_raster(ground_before_cells, ground_before_values)
        ground_after_raster = ground_raster(ground_after_cells, ground_after_values)
        ground_before.pop("by_grid_cell", None)
        ground_after.pop("by_grid_cell", None)

        def summarize(result: dict[str, Any]) -> dict[str, Any]:
            surfaces: dict[str, dict[str, float]] = {}
            by_building: dict[str, dict[int, dict[str, float]]] = {}
            for feature in result["features"]:
                entry = surfaces.setdefault(feature["surface"], {"area_m2": 0.0, "sunlit_area_hours_m2": 0.0, "cells": 0})
                area = float(feature["area_m2"])
                exposure = area * float(feature["value"])
                entry["area_m2"] += area
                entry["sunlit_area_hours_m2"] += exposure
                entry["cells"] += 1
                building = by_building.setdefault(feature["surface"], {}).setdefault(int(feature["source_id"]), {"area_m2": 0.0, "sunlit_area_hours_m2": 0.0})
                building["area_m2"] += area
                building["sunlit_area_hours_m2"] += exposure
            for entry in surfaces.values():
                entry["mean_sun_hours"] = entry["sunlit_area_hours_m2"] / entry["area_m2"] if entry["area_m2"] else 0.0
            total_area = sum(entry["area_m2"] for entry in surfaces.values())
            total_exposure = sum(entry["sunlit_area_hours_m2"] for entry in surfaces.values())
            return {
                "mean_sun_hours": total_exposure / total_area if total_area else 0.0,
                "surface_area_m2": total_area,
                "sunlit_area_hours_m2": total_exposure,
                "cell_count": result["count"],
                "by_surface": surfaces,
                "by_building": by_building,
            }

        before, after = summarize(baseline), summarize(candidate)
        paired_area_before = paired_area_after = 0.0
        paired_exposure_before = paired_exposure_after = 0.0
        matched_building_ids: set[int] = set()
        for surface in set(before["by_building"]) & set(after["by_building"]):
            first_ids, second_ids = before["by_building"][surface], after["by_building"][surface]
            for source_id in set(first_ids) & set(second_ids):
                if source_id >= 1_000_000:
                    continue
                matched_building_ids.add(source_id)
                paired_area_before += first_ids[source_id]["area_m2"]
                paired_area_after += second_ids[source_id]["area_m2"]
                paired_exposure_before += first_ids[source_id]["sunlit_area_hours_m2"]
                paired_exposure_after += second_ids[source_id]["sunlit_area_hours_m2"]
        paired_before_mean = paired_exposure_before / paired_area_before if paired_area_before else 0.0
        paired_after_mean = paired_exposure_after / paired_area_after if paired_area_after else 0.0
        for summary in (before, after):
            summary.pop("by_building", None)
        return {
            "analysis_id": payload.analysis_id,
            "geometry_hash": hashlib.sha256(design_geometry.encode("utf-8")).hexdigest(),
            "scenario": {
                "date": payload.date, "start_minutes": payload.start_minutes,
                "end_minutes": payload.end_minutes, "step_minutes": payload.step_minutes,
                "resolution_m": payload.resolution_m, "surfaces": payload.surfaces,
                "impact_radius_m": impact_radius, "domain_bounds": analysis_bounds,
                "geometry_status": "proposal_geometry_unreviewed",
            },
            "before": before,
            "after": after,
            "ground": {
                "before": ground_before,
                "after": ground_after,
                "paired_cell_count": len(common_ground_keys),
                "paired_before_mean_sun_hours": paired_ground_before,
                "paired_after_mean_sun_hours": paired_ground_after,
                "paired_change_mean_sun_hours": paired_ground_after - paired_ground_before,
                "local_impact": {
                    "radius_m": impact_radius,
                    "paired_cell_count": len(local_ground_keys),
                    "before_mean_sun_hours": local_ground_before,
                    "after_mean_sun_hours": local_ground_after,
                    "change_mean_sun_hours": local_ground_after - local_ground_before,
                },
                "resolution_m": 20,
                "grid": {
                    "columns": ground_columns, "rows": ground_rows,
                    "origin_x": terrain_bounds[0] + 10 + ground_column_start * 20,
                    "origin_z": terrain_bounds[1] + 10 + ground_row_start * 20,
                    "before": ground_before_raster, "after": ground_after_raster,
                },
            },
            "paired_existing_buildings": {
                "count": len(matched_building_ids),
                "before_mean_sun_hours": paired_before_mean,
                "after_mean_sun_hours": paired_after_mean,
                "change_mean_sun_hours": paired_after_mean - paired_before_mean,
            },
            "change": {
                "mean_sun_hours": after["mean_sun_hours"] - before["mean_sun_hours"],
                "surface_area_m2": after["surface_area_m2"] - before["surface_area_m2"],
                "sunlit_area_hours_m2": after["sunlit_area_hours_m2"] - before["sunlit_area_hours_m2"],
            },
            "methodology": "Matched clear-sky direct-sun ray study on baseline and proposed mapped building surfaces plus mapped terrain-grid ground cells. Ground sun uses 20 m cells excluding building footprints; building surfaces use the selected resolution. Uses block-prism geometry; excludes diffuse/reflected light and detailed roof slopes.",
        }
    except SunlightAnalysisCancelled as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        LOGGER.exception("design sunlight comparison failed")
        raise HTTPException(status_code=503, detail=f"design sunlight comparison unavailable: {error}") from error
    finally:
        finish_sunlight_analysis(payload.analysis_id)


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


@app.get("/api/wind/climatology/sectors")
def wind_climatology_sectors(season: str = "annual", stability: str = "neutral") -> dict[str, Any]:
    """Sixteen-sector ERA5 wind rose: frequency and Weibull shape only.

    Lighter than /api/wind/preview or /api/wind/comfort — it skips the
    polygon query and screening field entirely, so a client that already has
    its own directional speed source (e.g. a solved OpenFOAM case) can weight
    that source by observed sector frequency without running the screening
    proxy at all.
    """
    sectors = []
    for name, azimuth in SECTORS.items():
        profile = forcing_profile(season, azimuth, stability)
        if profile is None:
            continue
        sectors.append({
            "sector": name,
            "direction_deg": azimuth,
            "frequency_fraction": profile["frequency_fraction"],
            "mean_speed_mps": profile["mean_speed_mps"],
            "weibull_shape": profile["weibull_shape"],
            "weibull_scale_mps": profile["weibull_scale_mps"],
        })
    if not sectors:
        raise HTTPException(status_code=503, detail="ERA5 climatology unavailable")
    summary = climatology_summary() or {}
    return {
        "season": season, "stability": stability, "sectors": sectors,
        "dataset_version": summary.get("version"),
        "coverage": summary.get("coverage"),
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


@app.get("/api/traffic/calibration-status")
def traffic_peak_calibration_status() -> dict[str, Any]:
    return traffic_calibration_status()


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


def _expire_traffic_jobs_locked(now: float) -> None:
    expired = [
        job_id for job_id, job in TRAFFIC_JOBS.items()
        if job["status"] in {"complete", "error"}
        and now - float(job.get("finished_at", now)) > TRAFFIC_JOB_TTL_S
    ]
    for job_id in expired:
        TRAFFIC_JOBS.pop(job_id, None)


def _run_traffic_preview_job(job_id: str, payload: dict[str, Any]) -> None:
    with TRAFFIC_JOBS_LOCK:
        job = TRAFFIC_JOBS.get(job_id)
        if job is None:
            return
        job.update(status="running", started_at=time.monotonic())
    try:
        result = closure_preview(payload)
    except ValueError as error:
        outcome = {"status": "error", "detail": str(error), "error_status": 422}
    except Exception as error:
        LOGGER.exception("Traffic preview job failed job_id=%s", job_id)
        outcome = {
            "status": "error",
            "detail": f"traffic closure preview unavailable: {error}",
            "error_status": 503,
        }
    else:
        outcome = {"status": "complete", "result": result}
    with TRAFFIC_JOBS_LOCK:
        job = TRAFFIC_JOBS.get(job_id)
        if job is not None:
            job.update(outcome, finished_at=time.monotonic())


def _run_traffic_emissions_job(job_id: str, payload: dict[str, Any]) -> None:
    with TRAFFIC_JOBS_LOCK:
        job = TRAFFIC_JOBS.get(job_id)
        if job is None:
            return
        job.update(status="running", started_at=time.monotonic())
    try:
        result = traffic_emissions_preview(payload)
    except ValueError as error:
        outcome = {"status": "error", "detail": str(error), "error_status": 422}
    except Exception as error:
        LOGGER.exception("Citywide traffic emissions job failed job_id=%s", job_id)
        outcome = {
            "status": "error",
            "detail": f"citywide traffic emissions unavailable: {error}",
            "error_status": 503,
        }
    else:
        outcome = {"status": "complete", "result": result}
    with TRAFFIC_JOBS_LOCK:
        job = TRAFFIC_JOBS.get(job_id)
        if job is not None:
            job.update(outcome, finished_at=time.monotonic())


@app.post("/api/traffic/closure-preview/jobs", status_code=202)
def start_traffic_closure_preview(payload: TrafficClosurePayload) -> dict[str, Any]:
    now = time.monotonic()
    with TRAFFIC_JOBS_LOCK:
        _expire_traffic_jobs_locked(now)
        pending = sum(job["status"] in {"queued", "running"} for job in TRAFFIC_JOBS.values())
        if pending >= TRAFFIC_JOB_MAX_PENDING:
            raise HTTPException(
                status_code=503,
                detail="traffic simulation queue is full; retry shortly",
                headers={"Retry-After": "5"},
            )
        job_id = secrets.token_urlsafe(18)
        TRAFFIC_JOBS[job_id] = {"status": "queued", "created_at": now}
        TRAFFIC_JOB_EXECUTOR.submit(_run_traffic_preview_job, job_id, payload.model_dump())
    return {"job_id": job_id, "status": "queued", "poll_after_ms": 1000}


@app.get("/api/traffic/closure-preview/jobs/{job_id}")
def traffic_closure_preview_job(job_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,40}", job_id):
        raise HTTPException(status_code=404, detail="traffic simulation job not found")
    now = time.monotonic()
    with TRAFFIC_JOBS_LOCK:
        _expire_traffic_jobs_locked(now)
        job = TRAFFIC_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="traffic simulation job not found")
        status = job["status"]
        elapsed_s = round(now - float(job.get("started_at", job["created_at"])), 1)
        if status == "complete":
            return {"status": status, "elapsed_s": elapsed_s, "result": job["result"]}
        if status == "error":
            raise HTTPException(status_code=int(job["error_status"]), detail=str(job["detail"]))
        return {"status": status, "elapsed_s": elapsed_s, "poll_after_ms": 1000}


@app.post("/api/traffic/emissions-preview/jobs", status_code=202)
def start_traffic_emissions_preview(payload: TrafficEmissionsPayload) -> dict[str, Any]:
    now = time.monotonic()
    with TRAFFIC_JOBS_LOCK:
        _expire_traffic_jobs_locked(now)
        pending = sum(job["status"] in {"queued", "running"} for job in TRAFFIC_JOBS.values())
        if pending >= TRAFFIC_JOB_MAX_PENDING:
            raise HTTPException(
                status_code=503,
                detail="traffic simulation queue is full; retry shortly",
                headers={"Retry-After": "5"},
            )
        job_id = secrets.token_urlsafe(18)
        TRAFFIC_JOBS[job_id] = {"status": "queued", "created_at": now, "kind": "emissions"}
        TRAFFIC_JOB_EXECUTOR.submit(_run_traffic_emissions_job, job_id, payload.model_dump())
    return {"job_id": job_id, "status": "queued", "poll_after_ms": 1000}


@app.get("/api/traffic/emissions-preview/jobs/{job_id}")
def traffic_emissions_preview_job(job_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,40}", job_id):
        raise HTTPException(status_code=404, detail="traffic emissions job not found")
    now = time.monotonic()
    with TRAFFIC_JOBS_LOCK:
        _expire_traffic_jobs_locked(now)
        job = TRAFFIC_JOBS.get(job_id)
        if job is None or job.get("kind") != "emissions":
            raise HTTPException(status_code=404, detail="traffic emissions job not found")
        status = job["status"]
        elapsed_s = round(now - float(job.get("started_at", job["created_at"])), 1)
        if status == "complete":
            return {"status": status, "elapsed_s": elapsed_s, "result": job["result"]}
        if status == "error":
            raise HTTPException(status_code=int(job["error_status"]), detail=str(job["detail"]))
        return {"status": status, "elapsed_s": elapsed_s, "poll_after_ms": 1000}


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
