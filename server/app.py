"""FastAPI service for the Cape Town wind explorer."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = FastAPI(title="Cape Town Wind Explorer API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class PreviewPayload(BaseModel):
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    center_local: list[float] | None = Field(default=None, min_length=2, max_length=2)
    size_m: float = Field(default=250.0, ge=100.0, le=1200.0)
    direction_deg: float = Field(default=135.0, ge=0.0, lt=360.0)
    season: str = "annual"
    reference_speed_mps: float = Field(default=10.0, ge=0.0, le=50.0)
    height_m: float = Field(default=2.0, ge=1.0, le=10.0)
    resolution_m: float = Field(default=5.0, ge=2.0, le=20.0)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "field_version": FIELD_VERSION}


@app.get("/api/wind/scenarios")
def scenarios() -> dict[str, Any]:
    config = load_viewer_config()
    return {
        "field_version": FIELD_VERSION,
        "model_kind": current_model_kind(),
        "validation_status": "exploratory_not_engineering_grade",
        "directions": [{"name": name, "azimuth_deg": azimuth} for name, azimuth in VALID_DIRECTIONS.items()],
        "seasons": ["annual", "summer", "autumn", "winter", "spring"],
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


@app.get("/api/wind/field/{direction}/{tile}")
def field_tile(direction: str, tile: str) -> dict[str, str]:
    """Reserved tile endpoint; preview is the supported first-release path."""
    if direction.upper() not in VALID_DIRECTIONS and not direction.startswith("az_"):
        raise HTTPException(status_code=404, detail="unknown direction")
    return {"status": "use_preview", "direction": direction, "tile": tile}


# Serving the existing static viewer from the same process keeps the browser
# same-origin with the API and avoids exposing DATABASE_URL to client code.
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[1] / "public", html=True), name="public")
