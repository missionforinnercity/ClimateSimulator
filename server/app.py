"""FastAPI service for the Cape Town wind explorer."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from .field import (
    FIELD_VERSION,
    VALID_DIRECTIONS,
    build_field,
    current_model_kind,
    direction_name,
    load_viewer_config,
    local_bounds,
    project_polygons,
    query_polygons,
    request_from_payload,
)
from .heat import HEAT_METRICS, heat_zones
from .flood import dem_control_summary, flood_preview
from .mitigation import mitigation_preview
from .location import streetview_location
from .weather import current_weather
from .traffic import SCENARIOS as TRAFFIC_SCENARIOS
from .traffic import closure_preview, current_traffic, drawable_road_edges, named_roads, permanent_road_statuses
from .wind_metrics import COMFORT_CATEGORIES, STABILITY_PROFILES, validate_against_observations
from .era5_wind import climatology_summary

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = FastAPI(title="Cape Town Wind Explorer API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
# The traffic and flood previews return long arrays of rounded numbers, which
# compress by roughly 5x. Worth it even on localhost for the multi-megabyte
# vehicle-trajectory responses.
app.add_middleware(GZipMiddleware, minimum_size=8192)


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


class MitigationPayload(BaseModel):
    interventions: list[dict[str, Any]]
    sun_date: str = "2026-01-15"
    sun_minutes: int = Field(default=720, ge=0, lt=1440)
    baseline_metric: str = "heat_model_lst_c"


class TrafficClosurePayload(BaseModel):
    road_name: str | None = None
    edge_ids: list[str] = Field(default_factory=list, max_length=120)
    duration_min: float = Field(default=10.0, ge=5.0, le=20.0)
    scenario: Literal["am_peak", "midday", "pm_peak", "evening", "live"] = "am_peak"
    closure_mode: Literal["lane", "full"] = "lane"
    closure_scope: Literal["block", "road"] = "block"
    traffic_control: Literal["signalized", "priority"] = "signalized"
    demand_multiplier: float = Field(default=1.0, ge=0.5, le=1.5)


class FloodPayload(BaseModel):
    center_local: list[float] = Field(default=[0.0, 0.0], min_length=2, max_length=2)
    bounds_local: list[float] | None = Field(default=None, min_length=4, max_length=4)
    size_m: float = Field(default=500.0, ge=150.0, le=1200.0)
    resolution_m: float = Field(default=4.0, ge=2.0, le=10.0)
    rainfall_mm_h: float = Field(default=50.0, ge=1.0, le=300.0)
    duration_min: float = Field(default=60.0, ge=5.0, le=360.0)
    infiltration_mm_h: float = Field(default=5.0, ge=0.0, le=100.0)
    manning_n: float = Field(default=0.04, ge=0.015, le=0.15)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "field_version": FIELD_VERSION}


@app.get("/api/heat/metrics")
def heat_metrics() -> dict[str, Any]:
    return {"metrics": [{"key": key, "label": label} for key, label in HEAT_METRICS.items()]}


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
def heat_preview(metric: str = "heat_model_lst_c") -> dict[str, Any]:
    try:
        return heat_zones(metric)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"heat data unavailable: {error}") from error


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


@app.post("/api/mitigations/preview")
def mitigations_preview(payload: MitigationPayload) -> dict[str, Any]:
    try:
        return mitigation_preview(payload.model_dump())
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"mitigation preview unavailable: {error}") from error


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


# Serving the existing static viewer from the same process keeps the browser
# same-origin with the API and avoids exposing DATABASE_URL to client code.
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[1] / "public", html=True), name="public")
