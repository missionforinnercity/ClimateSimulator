"""Validated access to atomically published thermal forecast products."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
from typing import Any

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PRODUCT_ROOT = Path(os.getenv("THERMAL_PRODUCT_ROOT", PROJECT_ROOT / "data/thermal/products"))
CURRENT_FILE = PRODUCT_ROOT / "CURRENT"
STATUS_FILE = PRODUCT_ROOT / "STATUS.json"
RUN_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,80}")
FRAME_ID_PATTERN = re.compile(r"\d{8}T\d{4}Z")


class ThermalProductUnavailable(RuntimeError):
    pass


def _safe_run_id(value: str) -> str:
    if not RUN_ID_PATTERN.fullmatch(value):
        raise ValueError("invalid thermal run id")
    return value


def _safe_frame_id(value: str) -> str:
    if not FRAME_ID_PATTERN.fullmatch(value):
        raise ValueError("invalid thermal frame id")
    return value


def current_run_id() -> str:
    try:
        return _safe_run_id(CURRENT_FILE.read_text(encoding="utf-8").strip())
    except FileNotFoundError as error:
        raise ThermalProductUnavailable("no thermal forecast has been published") from error


def load_manifest(run_id: str | None = None) -> dict[str, Any]:
    run_id = _safe_run_id(run_id) if run_id else current_run_id()
    path = PRODUCT_ROOT / run_id / "manifest.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ThermalProductUnavailable("thermal forecast manifest is unavailable") from error
    if payload.get("schema") != "conditions-thermal-forecast/1" or payload.get("run_id") != run_id:
        raise ThermalProductUnavailable("thermal forecast manifest is incompatible")
    return payload


def public_manifest() -> dict[str, Any]:
    payload = load_manifest()
    # The viewer builds its forecast slider from this list. Exclude missing or
    # truncated binaries so every advertised timestamp can be loaded.
    grid = payload.get("grid", {})
    expected_bytes = (
        int(grid.get("width", 0)) * int(grid.get("height", 0))
        * len(payload.get("channels", [])) * 2
    )
    run_dir = PRODUCT_ROOT / payload["run_id"]
    complete_frames = []
    for frame in payload.get("frames", []):
        if expected_bytes <= 0 or not isinstance(frame, dict):
            continue
        frame_id = frame.get("id")
        filename = frame.get("file")
        if (not isinstance(frame_id, str) or not FRAME_ID_PATTERN.fullmatch(frame_id)
                or not isinstance(filename, str) or filename != f"{frame_id}.bin"):
            continue
        path = run_dir / filename
        try:
            if path.is_file() and path.stat().st_size == expected_bytes:
                complete_frames.append(frame)
        except OSError:
            continue
    payload["frames"] = complete_frames
    # Keep the published manifest compact, but attach the meteorological
    # forcing values needed to explain the selected map frame. Older runs
    # already retain their normalized forcing.json alongside the frames.
    forcing_fields = (
        "temperature_2m_c", "relative_humidity_2m_pct", "cloud_cover_pct",
        "wind_speed_10m_mps", "global_radiation_wm2", "direct_radiation_wm2",
        "diffuse_radiation_wm2", "precipitation_mm",
    )
    try:
        forcing_payload = json.loads((PRODUCT_ROOT / payload["run_id"] / "forcing.json").read_text(encoding="utf-8"))
        forcing_by_time = {row.get("valid_at"): row for row in forcing_payload.get("rows", [])}
        for frame in payload.get("frames", []):
            row = forcing_by_time.get(frame.get("valid_at"))
            if row:
                forcing = frame.setdefault("forcing", {})
                forcing["provenance"] = row.get("provenance", {})
                forcing["inputs"] = {name: row.get(name) for name in forcing_fields}
                forcing["sources"] = row.get("sources", [row.get("source", "Open-Meteo")])
                forcing["station"] = row.get("station")
                forcing["observed_at"] = row.get("observed_at")
                forcing["model_members"] = row.get("model_members")
                forcing["model_spread"] = row.get("model_spread")
                forcing["station_check"] = row.get("station_check")
                forcing["weather_warnings"] = row.get("weather_warnings", [])
    except (OSError, KeyError, json.JSONDecodeError, TypeError):
        pass
    generated = datetime.fromisoformat(str(payload["generated_at"]).replace("Z", "+00:00"))
    age_seconds = max(0.0, (datetime.now(timezone.utc) - generated).total_seconds())
    stale_after = float(payload.get("stale_after_seconds", 7200))
    # A previously published run can still be served while the worker is
    # retrying. Include the small, sanitized worker status so clients can tell
    # that a stale forecast is the fallback after a failed refresh.
    refresh: dict[str, Any] = {}
    try:
        candidate = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        if isinstance(candidate, dict):
            refresh = {
                key: candidate[key]
                for key in ("state", "phase", "updated_at", "last_success_at", "error_code")
                if key in candidate
            }
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    # Do not expose worker filesystem paths or internal error tracebacks.
    return {
        key: value for key, value in payload.items()
        if key not in {"working_directory", "internal_error"}
    } | {
        "age_seconds": round(age_seconds), "stale": age_seconds > stale_after,
        "refresh": refresh,
    }


def forecast_status() -> dict[str, Any]:
    """Return a stable, non-error response while the first run is being built."""
    try:
        return public_manifest() | {"available": True, "status": "ready"}
    except (ThermalProductUnavailable, ValueError, KeyError, json.JSONDecodeError):
        pass

    worker: dict[str, Any] = {}
    try:
        candidate = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        if isinstance(candidate, dict):
            worker = {
                key: candidate[key]
                for key in ("state", "phase", "updated_at", "last_success_at", "error_code")
                if key in candidate
            }
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass

    state = worker.get("state", "not_started")
    phase_labels = {
        "weather_forcing": "weather ingestion",
        "wind_atlas_validation": "16-sector CFD atlas validation",
        "suews_configuration": "SUEWS site configuration validation",
        "suews": "SUEWS modelling",
        "solweig": "SOLWEIG modelling",
    }
    failed_phase = phase_labels.get(str(worker.get("phase")), "model execution")
    details = {
        "not_started": "The thermal worker has not published its first forecast yet.",
        "starting": "The thermal worker is preparing its first forecast.",
        "running": "The thermal worker is calculating the next forecast.",
        "failed": f"The latest thermal refresh stopped during {failed_phase}; check the thermal-worker logs.",
    }
    return {
        "schema": "conditions-thermal-availability/1",
        "available": False,
        "status": state,
        "detail": details.get(str(state), "The thermal forecast is not available yet."),
        "retry_after_seconds": 300,
        "worker": worker,
    }


def _frame_record(manifest: dict[str, Any], frame_id: str) -> dict[str, Any]:
    frame_id = _safe_frame_id(frame_id)
    record = next((item for item in manifest.get("frames", []) if item.get("id") == frame_id), None)
    if record is None:
        raise ValueError("thermal frame is not part of this run")
    return record


def frame_path(run_id: str, frame_id: str) -> Path:
    manifest = load_manifest(run_id)
    record = _frame_record(manifest, frame_id)
    filename = record.get("file")
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise ThermalProductUnavailable("thermal frame path is invalid")
    path = PRODUCT_ROOT / _safe_run_id(run_id) / filename
    if not path.is_file():
        raise ThermalProductUnavailable("thermal frame file is unavailable")
    return path


def energy_payload(run_id: str | None = None) -> dict[str, Any]:
    manifest = load_manifest(run_id)
    filename = manifest.get("energy_file", "energy.json")
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise ThermalProductUnavailable("thermal energy path is invalid")
    try:
        return json.loads((PRODUCT_ROOT / manifest["run_id"] / filename).read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ThermalProductUnavailable("thermal energy product is unavailable") from error


def _decode_frame(manifest: dict[str, Any], path: Path) -> np.ndarray:
    grid = manifest["grid"]
    height, width = int(grid["height"]), int(grid["width"])
    channels = manifest["channels"]
    values = np.fromfile(path, dtype="<i2")
    expected = height * width * len(channels)
    if values.size != expected:
        raise ThermalProductUnavailable("thermal frame has an invalid byte length")
    return values.reshape(height, width, len(channels))


def sample_point(x: float, z: float, frame_id: str, run_id: str | None = None) -> dict[str, Any]:
    if not math.isfinite(x) or not math.isfinite(z):
        raise ValueError("point coordinates must be finite")
    manifest = load_manifest(run_id)
    record = _frame_record(manifest, frame_id)
    grid = manifest["grid"]
    min_x, min_z, max_x, max_z = map(float, grid["bounds"])
    resolution = float(grid["resolution_m"])
    if not (min_x <= x < max_x and min_z <= z < max_z):
        raise ValueError("point is outside the thermal forecast grid")
    column = int((x - min_x) // resolution)
    row = int((z - min_z) // resolution)
    frame = _decode_frame(manifest, frame_path(manifest["run_id"], frame_id))
    raw = frame[row, column]
    values: dict[str, float | None] = {}
    nodata = int(manifest.get("nodata", -32768))
    for index, channel in enumerate(manifest["channels"]):
        values[channel["name"]] = None if int(raw[index]) == nodata else round(
            float(raw[index]) * float(channel["scale"]) + float(channel.get("offset", 0)), 3,
        )
    utci = values.get("utci_c")
    return {
        "run_id": manifest["run_id"], "frame_id": frame_id, "valid_at": record["valid_at"],
        "x": x, "z": z, "grid_cell": {"row": row, "column": column}, "values": values,
        "utci_category": utci_category(utci), "forcing": record.get("forcing"),
        "wind_sector": record.get("wind_sector"), "validation_status": manifest.get("validation_status"),
    }


def sample_points_at(
    samples: list[tuple[float, float, datetime]], *, max_offset_seconds: int = 1800,
) -> dict[str, Any]:
    """Batch-sample route points from their nearest complete forecast frames.

    Each required frame is decoded once for the whole batch. Input times must
    be timezone-aware, and each result includes the selected frame and offset
    so the route caller can report temporal coverage.
    """
    if not samples:
        return {"status": "unavailable", "reason": "no route samples", "samples": []}
    if any(when.tzinfo is None or when.utcoffset() is None for _, _, when in samples):
        raise ValueError("thermal sample times must include a timezone")
    try:
        manifest = public_manifest()
    except (ThermalProductUnavailable, ValueError, KeyError, json.JSONDecodeError) as error:
        return {"status": "unavailable", "reason": str(error), "samples": [None] * len(samples)}
    if manifest.get("stale"):
        return {
            "status": "stale", "reason": "the latest thermal forecast is stale",
            "run_id": manifest.get("run_id"), "samples": [None] * len(samples),
        }
    frames = manifest.get("frames") or []
    if not frames:
        return {"status": "unavailable", "reason": "no complete thermal frames", "samples": [None] * len(samples)}

    def parse_time(value: str) -> datetime:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)

    timed_frames = [(parse_time(frame["valid_at"]), frame) for frame in frames if frame.get("valid_at")]
    channels = {item.get("name"): index for index, item in enumerate(manifest.get("channels", []))}
    utci_channel = channels.get("utci_c")
    wind_channel = channels.get("wind_1p5m_mps")
    if utci_channel is None and wind_channel is None:
        return {"status": "unavailable", "reason": "forecast has no pedestrian heat or wind channels", "samples": [None] * len(samples)}

    chosen: list[tuple[dict[str, Any] | None, int | None]] = []
    grouped: set[str] = set()
    for _, _, when in samples:
        valid_at, record = min(timed_frames, key=lambda item: abs((item[0] - when.astimezone(timezone.utc)).total_seconds()))
        offset = int(round((valid_at - when.astimezone(timezone.utc)).total_seconds()))
        if abs(offset) > max_offset_seconds:
            chosen.append((None, None))
            continue
        chosen.append((record, offset))
        grouped.add(str(record["id"]))

    decoded = {
        frame_id: _decode_frame(manifest, frame_path(manifest["run_id"], frame_id))
        for frame_id in grouped
    }
    grid = manifest["grid"]
    min_x, min_z, max_x, max_z = map(float, grid["bounds"])
    resolution = float(grid["resolution_m"])
    nodata = int(manifest.get("nodata", -32768))
    outputs: list[dict[str, Any] | None] = []
    for (x, z, _), (record, offset) in zip(samples, chosen):
        if record is None or not (min_x <= x < max_x and min_z <= z < max_z):
            outputs.append(None)
            continue
        column = int((x - min_x) // resolution)
        row = int((z - min_z) // resolution)
        raw = decoded[str(record["id"])][row, column]

        def value(channel_index: int | None) -> float | None:
            if channel_index is None or int(raw[channel_index]) == nodata:
                return None
            channel = manifest["channels"][channel_index]
            return round(float(raw[channel_index]) * float(channel["scale"]) + float(channel.get("offset", 0)), 3)

        outputs.append({
            "utci_c": value(utci_channel),
            "wind_1p5m_mps": value(wind_channel),
            "frame_id": record["id"],
            "valid_at": record["valid_at"],
            "offset_seconds": offset,
        })
    valid_count = sum(
        item is not None and (item["utci_c"] is not None or item["wind_1p5m_mps"] is not None)
        for item in outputs
    )
    channel_coverage = {}
    for channel_name in ("utci_c", "wind_1p5m_mps"):
        sampled = sum(item is not None and item[channel_name] is not None for item in outputs)
        channel_coverage[channel_name] = {
            "sampled_points": sampled,
            "total_points": len(samples),
            "coverage_percent": round(100 * sampled / len(samples), 1) if samples else 0.0,
        }
    return {
        "status": "available" if valid_count == len(outputs) else "partial" if valid_count else "unavailable",
        "reason": None if valid_count else "route times are outside complete forecast coverage",
        "run_id": manifest.get("run_id"),
        "validation_status": manifest.get("validation_status"),
        "channel_coverage": channel_coverage,
        "samples": outputs,
    }


def utci_category(value: float | None) -> str | None:
    if value is None:
        return None
    thresholds = [(-40, "extreme cold stress"), (-27, "very strong cold stress"),
                  (-13, "strong cold stress"), (0, "moderate cold stress"),
                  (9, "slight cold stress"), (26, "no thermal stress"),
                  (32, "moderate heat stress"), (38, "strong heat stress"),
                  (46, "very strong heat stress"), (float("inf"), "extreme heat stress")]
    return next(label for ceiling, label in thresholds if value < ceiling)


def product_health() -> dict[str, Any]:
    try:
        manifest = public_manifest()
    except (ThermalProductUnavailable, ValueError, KeyError) as error:
        return {"status": "unavailable", "required": False, "detail": str(error), "affects": ["thermal_forecast"]}
    atlas = manifest.get("wind_atlas", {})
    complete = int(atlas.get("available_sectors", 0)) == int(atlas.get("required_sectors", 16))
    return {
        "status": "stale" if manifest["stale"] else ("ok" if complete else "degraded"),
        "required": False, "run_id": manifest["run_id"], "age_seconds": manifest["age_seconds"],
        "frame_count": len(manifest.get("frames", [])), "wind_atlas_complete": complete,
        "worker": manifest.get("worker"), "affects": ["thermal_forecast"],
    }
