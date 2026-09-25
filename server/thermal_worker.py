"""Scheduled thermal forecast worker.

The worker is intentionally fail-closed: it never substitutes synthetic wind,
comfort or energy fields when a scientific model/input is unavailable.  Run
once with ``python -m server.thermal_worker --once`` or leave it running for an
hourly refresh loop.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import tempfile
import time
from typing import Any
from zoneinfo import ZoneInfo

# The supplied rasters identify their geographic component as EPSG:4148 but
# carry a conflicting GeoTIFF spheroid key. Use the EPSG registry's official
# definition for GDAL reprojections in this worker, avoiding repeated warnings
# while keeping the CRS identified by the surface metadata.
os.environ.setdefault("GTIFF_SRS_SOURCE", "EPSG")

import numpy as np

from .thermal_products import PRODUCT_ROOT, STATUS_FILE
from .weather_forcing import forcing_window

LOGGER = logging.getLogger("conditions.thermal_worker")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOCAL_ZONE = ZoneInfo("Africa/Johannesburg")
SURFACE_ROOT = Path(os.getenv("THERMAL_SURFACE_ROOT", PROJECT_ROOT / "data/thermal/surfaces"))
ATLAS_ROOT = Path(os.getenv("THERMAL_WIND_ATLAS_ROOT", PROJECT_ROOT / "data/openfoam/atlas"))
SUEWS_CONFIG = Path(os.getenv("SUEWS_CONFIG", PROJECT_ROOT / "data/thermal/suews/config.yml"))
CHANNELS = (
    {"name": "tmrt_c", "unit": "°C", "scale": 0.1, "offset": 0.0},
    {"name": "utci_c", "unit": "°C", "scale": 0.1, "offset": 0.0},
    {"name": "wind_1p5m_mps", "unit": "m/s", "scale": 0.01, "offset": 0.0},
    {"name": "shadow_fraction", "unit": "fraction", "scale": 0.0001, "offset": 0.0},
    {"name": "wind_10m_mps", "unit": "m/s", "scale": 0.01, "offset": 0.0},
)
NODATA = -32768
MIN_ATLAS_VALID_FRACTION = float(os.getenv("THERMAL_MIN_ATLAS_VALID_FRACTION", "0.95"))


def frame_id(valid_at: str) -> str:
    parsed = datetime.fromisoformat(valid_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    return parsed.strftime("%Y%m%dT%H%MZ")


def sector_index(direction_deg: float) -> int:
    return int(((float(direction_deg) % 360.0) + 11.25) // 22.5) % 16


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_wind_atlas() -> tuple[dict[str, Any], dict[int, Path]]:
    path = ATLAS_ROOT / "manifest.json"
    if not path.is_file():
        raise RuntimeError("the sixteen-sector OpenFOAM pedestrian atlas has not been built")
    manifest = _load_json(path)
    if manifest.get("schema") != "conditions-cfd-pedestrian-atlas/1":
        raise RuntimeError("the OpenFOAM pedestrian atlas schema is incompatible")
    records = {int(item["sector_index"]): ATLAS_ROOT / item["file"] for item in manifest.get("sectors", [])}
    if set(records) != set(range(16)) or not all(path.is_file() for path in records.values()):
        raise RuntimeError("all sixteen OpenFOAM pedestrian sectors are required")
    insufficient = [
        int(item["sector_index"])
        for item in manifest.get("sectors", [])
        if float(item.get("valid_fraction", 0.0)) < MIN_ATLAS_VALID_FRACTION
    ]
    if insufficient:
        raise RuntimeError(
            "OpenFOAM pedestrian atlas does not provide full footprint coverage "
            f"for sectors {insufficient}; rebuild the atlas with scene-covering volumes"
        )
    return manifest, records


def _hourly_rows(forcing: dict[str, Any]) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    future = []
    for row in forcing["rows"]:
        valid = datetime.fromisoformat(row["valid_at"].replace("Z", "+00:00"))
        if now <= valid <= now + timedelta(hours=24):
            future.append(row)
    if len(future) != 25:
        raise RuntimeError(f"weather forcing must contain exactly 25 current/forecast hours; found {len(future)}")
    required = (
        "temperature_2m_c", "relative_humidity_2m_pct", "surface_pressure_hpa",
        "precipitation_mm", "wind_speed_10m_mps", "wind_direction_10m_deg", "global_radiation_wm2",
    )
    for row in future:
        missing = [name for name in required if row.get(name) is None]
        if missing:
            raise RuntimeError(f"forcing {row['valid_at']} is missing {', '.join(missing)}")
    return future


def run_suews(forcing: dict[str, Any], work_dir: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run the pinned SuPy adapter and return one city aggregate per hour."""
    if not SUEWS_CONFIG.is_file():
        raise RuntimeError(f"SUEWS configuration is missing: {SUEWS_CONFIG}")
    try:
        from supy import SUEWSSimulation
        import supy
    except ImportError as error:
        raise RuntimeError("supy is not installed in the thermal worker") from error
    forcing_path = work_dir / "forcing.json"
    forcing_path.write_text(json.dumps(forcing, indent=2) + "\n", encoding="utf-8")
    # The project adapter contract deliberately uses JSON.  A site-specific
    # SUEWS config may reference it via a preprocessor; recent SuPy accepts an
    # in-memory forcing DataFrame through update_forcing.
    import pandas as pd
    rows = forcing["rows"]
    index = pd.DatetimeIndex([item["valid_at"] for item in rows], freq="h")
    def _celsius(item: dict[str, Any]) -> float | None:
        value = item.get("temperature_2m_c")
        if value is None:
            return None
        value = float(value)
        # A few legacy/provider payloads expose temperature in kelvin despite
        # the normalized field name.  Convert that outlier explicitly.
        return value - 273.15 if value > 100.0 else value
    data = pd.DataFrame({
        "Tair": [_celsius(item) for item in rows],
        "RH": [item.get("relative_humidity_2m_pct") for item in rows],
        "pres": [item.get("surface_pressure_hpa") for item in rows],
        "rain": [item.get("precipitation_mm") for item in rows],
        "U": [max(0.01, item.get("wind_speed_10m_mps") or 0.01) for item in rows],
        "kdown": [item.get("global_radiation_wm2") for item in rows],
        "kdir": [item.get("direct_radiation_wm2", -999) for item in rows],
        "kdiff": [item.get("diffuse_radiation_wm2", -999) for item in rows],
        "wdir": [item.get("wind_direction_10m_deg") for item in rows],
        # SuPy validates the complete SUEWS forcing frame.  These fields are
        # state/metadata inputs not supplied by the weather providers; use
        # documented neutral/missing sentinels and let SUEWS evolve them.
        "Wuh": [0.0 for _ in rows],
        "fcld": [-999.0 for _ in rows],
        "id": [1 for _ in rows],
        "imin": [item_dt.minute for item_dt in index],
        "it": [item_dt.hour for item_dt in index],
        "iy": [item_dt.year for item_dt in index],
        "lai": [-999.0 for _ in rows],
        "ldown": [-999.0 for _ in rows],
        "qe": [-999.0 for _ in rows],
        "qf": [-999.0 for _ in rows],
        "qh": [-999.0 for _ in rows],
        "qn": [-999.0 for _ in rows],
        "qs": [-999.0 for _ in rows],
        "snow": [0.0 for _ in rows],
        "xsmd": [-999.0 for _ in rows],
    }, index=index)
    LOGGER.info("SUEWS forcing window: %s..%s Tair=%s..%s rows=%d",
                index[0], index[-1], data["Tair"].min(), data["Tair"].max(), len(data))
    simulation = SUEWSSimulation(str(SUEWS_CONFIG))
    # The generated site template carries broad historical dates, but the
    # live worker advances a 25-hour window.  Bound the simulation explicitly
    # so SuPy does not discard current rows as outside the configured period.
    simulation.update_config({"model": {"control": {
        "start_time": index[0].strftime("%Y-%m-%d %H:%M"),
        "end_time": index[-1].strftime("%Y-%m-%d %H:%M"),
    }}}, auto_load_forcing=False)
    try:
        simulation.update_forcing(data)
    except (TypeError, ValueError):
        dataframe_path = work_dir / "forcing.csv"
        data.to_csv(dataframe_path)
        simulation.update_forcing(str(dataframe_path))
    output = simulation.run()

    def series(name: str):
        result = output.get_variable(name, group="SUEWS")
        return result.iloc[:, 0] if getattr(result, "ndim", 1) > 1 else result

    variables = {name: series(name) for name in ("T2", "RH2", "QN", "QF", "QH", "QE", "QS", "Tsurf", "Evap", "RO", "SMD")}
    forecast_times = {item["valid_at"] for item in _hourly_rows(forcing)}
    records = []
    for row_index in variables["T2"].index:
        timestamp = row_index[-1] if isinstance(row_index, tuple) else row_index
        key = timestamp.to_pydatetime().astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
        if key not in forecast_times:
            continue
        records.append({"valid_at": key, **{name: float(values.loc[row_index]) for name, values in variables.items()}})
    if len(records) != 25:
        raise RuntimeError(f"SUEWS returned {len(records)} forecast hours instead of 25")
    version = getattr(supy, "__version__", "unknown")
    return records, {"name": "SUEWS/SuPy", "version": version, "config": SUEWS_CONFIG.name}


def solweig_weather(item: dict[str, Any], location: Any) -> Any:
    """Convert hourly horizontal irradiance to SOLWEIG's beam-normal input."""
    import solweig

    local_time = datetime.fromisoformat(item["valid_at"].replace("Z", "+00:00"))
    weather = solweig.Weather(
        datetime=local_time.astimezone(LOCAL_ZONE).replace(tzinfo=None),
        ta=item["temperature_2m_c"], rh=item["relative_humidity_2m_pct"],
        global_rad=item["global_radiation_wm2"],
        ws=item["wind_speed_10m_mps"], pressure=item["surface_pressure_hpa"],
        timestep_minutes=item.get("radiation", {}).get("averaging_minutes", 60),
    )
    direct = item.get("direct_radiation_wm2")
    diffuse = item.get("diffuse_radiation_wm2")
    if direct is not None and diffuse is not None:
        # compute_derived uses the middle of the preceding hour, matching
        # Open-Meteo's averaging interval. Use that same angle for conversion.
        weather.compute_derived(location)
        sine_altitude = float(np.sin(np.deg2rad(weather.sun_altitude)))
        weather.measured_direct_rad = max(0.0, direct) / sine_altitude if sine_altitude > 0 else 0.0
        weather.measured_diffuse_rad = max(0.0, diffuse)
        weather.compute_derived(location)
    return weather


def radiation_summary(values: np.ndarray, valid: np.ndarray) -> dict[str, float]:
    samples = values[valid & np.isfinite(values)]
    if not samples.size:
        raise RuntimeError("radiation diagnostic has no valid ground cells")
    return {"mean": round(float(samples.mean()), 3), "p10": round(float(np.percentile(samples, 10)), 3),
            "p90": round(float(np.percentile(samples, 90)), 3), "max": round(float(samples.max()), 3)}


def thermal_forecast_rows(forcing: dict[str, Any], hourly: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Use a timestamped subhourly radiation snapshot, without relabelling it now."""
    native = forcing.get("latest_native_radiation")
    if not native or len(hourly) < 2 or not hourly[0]["valid_at"] <= native["valid_at"] < hourly[1]["valid_at"]:
        return hourly
    if native.get("radiation", {}).get("averaging_minutes", 60) >= 60:
        return hourly
    row = {**hourly[0], "valid_at": native["valid_at"],
           "weather_valid_at": hourly[0]["valid_at"], "radiation": native["radiation"],
           "data_kind": "modelled_air_with_satellite_radiation_snapshot"}
    row["provenance"] = {**hourly[0].get("provenance", {}), **native["provenance"]}
    for field in native["provenance"]:
        row[field] = native[field]
    row["sources"] = sorted(set(hourly[0].get("sources", [])) | {native.get("source", "EUMETSAT native satellite radiation")})
    row["weather_warnings"] = [warning for warning in hourly[0].get("weather_warnings", [])
                               if "current-hour satellite radiation unavailable" not in warning]
    return [row, *hourly[1:]]


def run_solweig(
    rows: list[dict[str, Any]], forcing_rows: list[dict[str, Any]], work_dir: Path,
    cache_dir: Path | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        import rasterio
        import solweig
    except ImportError as error:
        raise RuntimeError("solweig and rasterio are required in the thermal worker") from error
    dsm, dem, cdsm, land_cover = (
        SURFACE_ROOT / name for name in ("dsm.tif", "dem.tif", "cdsm.tif", "landcover.tif")
    )
    if not all(path.is_file() for path in (dsm, dem, cdsm, land_cover)):
        raise RuntimeError("prepared SOLWEIG DSM, DEM, CDSM and land-cover rasters are required")
    surface = solweig.SurfaceData.prepare(
        dsm=str(dsm), dem=str(dem), cdsm=str(cdsm), land_cover=str(land_cover),
        cdsm_relative=False, working_dir=str(cache_dir or (work_dir / "solweig_cache")),
    )
    location = solweig.Location(latitude=-33.925, longitude=18.424, utc_offset=2)
    with rasterio.open(land_cover) as source:
        cover = source.read(1)
        ground = (cover != 2) & (cover != source.nodata)
    weather = []
    by_time = {item["valid_at"]: item for item in forcing_rows}
    for suews in rows:
        item = by_time[suews["valid_at"]]
        weather.append(solweig_weather(item, location))
    output_dir = work_dir / "solweig"
    output_dir.mkdir(exist_ok=True)
    fluxes = ("kdown", "kup", "ldown", "lup")
    solweig.calculate(surface=surface, weather=weather, location=location, output_dir=str(output_dir), outputs=["tmrt", "shadow", *fluxes])
    products = []
    for suews in rows:
        local_datetime = datetime.fromisoformat(suews["valid_at"].replace("Z", "+00:00")).astimezone(LOCAL_ZONE)
        stamp = local_datetime.strftime("%Y%m%d_%H%M")
        tmrt_path = output_dir / "tmrt" / f"tmrt_{stamp}.tif"
        shadow_path = output_dir / "shadow" / f"shadow_{stamp}.tif"
        if not tmrt_path.is_file() or not shadow_path.is_file():
            raise RuntimeError(f"SOLWEIG did not emit Tmrt and shadow rasters for {suews['valid_at']}")
        with rasterio.open(tmrt_path) as source:
            tmrt = source.read(1).astype(np.float32)
            transform, crs = source.transform, str(source.crs)
        with rasterio.open(shadow_path) as source:
            shadow = source.read(1).astype(np.float32)
        diagnostics = {"tmrt_c": radiation_summary(tmrt, ground)}
        for name in fluxes:
            flux_path = output_dir / name / f"{name}_{stamp}.tif"
            with rasterio.open(flux_path) as source:
                diagnostics[f"{name}_wm2"] = radiation_summary(source.read(1), ground)
            flux_path.unlink()  # Retain compact diagnostics, not four extra grids per hour.
        products.append({"tmrt": tmrt, "shadow": shadow, "transform": transform, "crs": crs,
                         "ground_mask": ground, "diagnostics": diagnostics})
    return products, {"name": "SOLWEIG", "version": getattr(solweig, "__version__", "unknown")}


def calculate_utci(ta: float, tr: np.ndarray, wind_10m: np.ndarray, rh: float) -> np.ndarray:
    try:
        from pythermalcomfort.models import utci
    except ImportError as error:
        raise RuntimeError("pythermalcomfort is required in the thermal worker") from error
    result = utci(tdb=np.full(tr.shape, ta), tr=tr, v=wind_10m, rh=np.full(tr.shape, rh), limit_inputs=False)
    values = getattr(result, "utci", result)
    return np.asarray(values, dtype=np.float32)


def _encode(values: list[np.ndarray], valid: np.ndarray) -> bytes:
    shape = values[0].shape
    encoded = np.full((*shape, len(CHANNELS)), NODATA, dtype="<i2")
    for index, (array, channel) in enumerate(zip(values, CHANNELS)):
        mask = valid & np.isfinite(array)
        scaled = np.rint((array[mask] - channel["offset"]) / channel["scale"])
        encoded[..., index][mask] = np.clip(scaled, -32767, 32767).astype(np.int16)
    return encoded.tobytes(order="C")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_status(state: str, phase: str, **extra: Any) -> None:
    """Atomically expose worker readiness without leaking credentials."""
    PRODUCT_ROOT.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "conditions-thermal-worker-status/1", "state": state, "phase": phase,
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), **extra,
    }
    temporary = STATUS_FILE.with_name(f"STATUS.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, STATUS_FILE)


def _status_phase() -> str:
    try:
        payload = _load_json(STATUS_FILE)
        return str(payload.get("phase") or "initializing")
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return "initializing"


def publish_once() -> dict[str, Any]:
    started = time.monotonic()
    _write_status("running", "wind_atlas_validation")
    atlas_manifest, atlas_paths = load_wind_atlas()
    _write_status("running", "suews_configuration")
    if not SUEWS_CONFIG.is_file():
        raise RuntimeError("the Cape Town SUEWS site configuration has not been prepared")
    if _load_json(SURFACE_ROOT / "grid.json").get("land_cover_convention") != "SOLWEIG_UMEP_ground_v1":
        raise RuntimeError("rebuild thermal surfaces: SOLWEIG ground material codes are required")
    _write_status("running", "weather_forcing")
    forcing = forcing_window(forecast_hours=24)
    forecast = _hourly_rows(forcing)
    run_id = datetime.now(timezone.utc).strftime("thermal_%Y%m%dT%H%M%SZ")
    PRODUCT_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{run_id}-", dir=PRODUCT_ROOT) as temporary:
        staging = Path(temporary)
        _write_status("running", "suews")
        suews_rows, suews_meta = run_suews(forcing, staging)
        _write_status("running", "solweig")
        forecast = thermal_forecast_rows(forcing, forecast)
        solweig_rows, solweig_meta = run_solweig(forecast, forecast, staging)
        energy = {"schema": "conditions-suews-energy/1", "run_id": run_id, "cells": "scene_aggregate", "hours": suews_rows}
        (staging / "energy.json").write_text(json.dumps(energy, separators=(",", ":")) + "\n", encoding="utf-8")
        frames = []
        grid = None
        for forcing_row, suews, radiation in zip(forecast, suews_rows, solweig_rows):
            sector = sector_index(forcing_row["wind_direction_10m_deg"])
            atlas = np.load(atlas_paths[sector])
            speed_1p5 = np.asarray(atlas["speed_ratio_1p5"], dtype=np.float32) * forcing_row["wind_speed_10m_mps"]
            speed_10 = np.asarray(atlas["speed_ratio_10"], dtype=np.float32) * forcing_row["wind_speed_10m_mps"]
            valid = np.asarray(atlas["valid"], dtype=bool) & np.isfinite(radiation["tmrt"]) & radiation["ground_mask"]
            if speed_1p5.shape != radiation["tmrt"].shape:
                raise RuntimeError("OpenFOAM atlas and SOLWEIG grid shapes differ")
            # UTCI's air state must match the meteorological inputs shown in
            # the panel. SUEWS still supplies the separate energy-balance
            # product; its modeled T2/RH2 are not independently validated.
            utci = calculate_utci(
                forcing_row["temperature_2m_c"], radiation["tmrt"],
                np.maximum(speed_10, 0.5), forcing_row["relative_humidity_2m_pct"],
            )
            fid = frame_id(forcing_row["valid_at"])
            filename = f"{fid}.bin"
            (staging / filename).write_bytes(_encode(
                [radiation["tmrt"], utci, speed_1p5, radiation["shadow"], speed_10], valid,
            ))
            frames.append({
                "id": fid, "valid_at": forcing_row["valid_at"], "file": filename,
                "bytes": (staging / filename).stat().st_size, "sha256": _sha256(staging / filename),
                "wind_sector": {"index": sector, "direction_deg": sector * 22.5},
                "radiation_diagnostics": radiation["diagnostics"] | {
                    "utci_c": radiation_summary(utci, valid),
                    "utci_without_radiant_excess_c": radiation_summary(calculate_utci(
                        forcing_row["temperature_2m_c"], np.full_like(radiation["tmrt"], forcing_row["temperature_2m_c"]),
                        np.maximum(speed_10, 0.5), forcing_row["relative_humidity_2m_pct"]), valid),
                },
                "forcing": {
                    "radiation": forcing_row.get("radiation"), "weather_valid_at": forcing_row.get("weather_valid_at", forcing_row["valid_at"]),
                    "data_kind": forcing_row["data_kind"], "provenance": forcing_row["provenance"],
                    "sources": forcing_row.get("sources", [forcing_row.get("source", "Open-Meteo")]),
                    "station": forcing_row.get("station"), "observed_at": forcing_row.get("observed_at"),
                    "model_members": forcing_row.get("model_members"),
                    "model_spread": forcing_row.get("model_spread"),
                    "station_check": forcing_row.get("station_check"),
                    "weather_warnings": forcing_row.get("weather_warnings", []),
                    "inputs": {name: forcing_row.get(name) for name in (
                        "temperature_2m_c", "relative_humidity_2m_pct", "cloud_cover_pct",
                        "wind_speed_10m_mps", "global_radiation_wm2", "direct_radiation_wm2",
                        "diffuse_radiation_wm2", "precipitation_mm",
                    )},
                },
            })
            if grid is None:
                transform = radiation["transform"]
                height, width = radiation["tmrt"].shape
                min_x, max_z = transform * (0, 0)
                max_x, min_z = transform * (width, height)
                grid = {"width": width, "height": height, "resolution_m": abs(transform.a), "bounds": [min_x, min_z, max_x, max_z], "crs": radiation["crs"]}
        surface_grid = _load_json(SURFACE_ROOT / "grid.json")
        grid = {
            "width": int(surface_grid["width"]), "height": int(surface_grid["height"]),
            "resolution_m": float(surface_grid["resolution_m"]),
            "bounds": list(surface_grid["viewer_bounds"]), "crs": "viewer-local-xz-metres",
            "source_crs": surface_grid["crs"],
        }
        manifest = {
            "schema": "conditions-thermal-forecast/1", "run_id": run_id,
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "stale_after_seconds": 7200, "validation_status": "experimental_unvalidated_modelled_estimate",
            "grid": grid, "channels": list(CHANNELS), "nodata": NODATA, "frames": frames,
            "energy_file": "energy.json", "models": {"suews": suews_meta, "solweig": solweig_meta},
            "providers": forcing["providers"], "latest_observation_at": forcing["latest_observation_at"],
            "wind_atlas": {"schema": atlas_manifest["schema"], "required_sectors": 16, "available_sectors": 16},
            "worker": {"duration_seconds": round(time.monotonic() - started, 1), "status": "complete"},
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        final = PRODUCT_ROOT / run_id
        os.replace(staging, final)
        current_tmp = PRODUCT_ROOT / ".CURRENT.tmp"
        current_tmp.write_text(run_id + "\n", encoding="utf-8")
        os.replace(current_tmp, PRODUCT_ROOT / "CURRENT")
    _write_status(
        "ready", "idle", last_success_at=manifest["generated_at"],
        run_id=manifest["run_id"], duration_seconds=manifest["worker"]["duration_seconds"],
    )
    _prune_runs(keep=3)
    return manifest


def _prune_runs(keep: int) -> None:
    current = (PRODUCT_ROOT / "CURRENT").read_text(encoding="utf-8").strip()
    runs = sorted((path for path in PRODUCT_ROOT.glob("thermal_*") if path.is_dir()), reverse=True)
    for path in runs[keep:]:
        if path.name != current:
            shutil.rmtree(path)


def next_refresh_at(now: float, interval: int, radiation_delay: int) -> float:
    """Refresh periodically while leaving a full interval for each model run."""
    step = min(radiation_delay, interval)
    next_tick = (now // step + 1) * step
    return max(next_tick, now + step)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Run one refresh and exit")
    parser.add_argument("--interval-seconds", type=int, default=3600)
    parser.add_argument(
        "--radiation-refresh-minutes", type=int, default=10,
        help="refresh this often within every forecast interval to pick up native satellite scans",
    )
    args = parser.parse_args()
    if args.interval_seconds < 300 or args.radiation_refresh_minutes < 1:
        parser.error("interval must be at least 300 seconds and radiation refresh delay at least one minute")
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    interval = args.interval_seconds
    followup_delay = min(interval, args.radiation_refresh_minutes * 60)
    next_run = time.time()
    while True:
        time.sleep(max(0.0, next_run - time.time()))
        try:
            _write_status("starting", "initializing")
            manifest = publish_once()
            LOGGER.info("published thermal run %s", manifest["run_id"])
        except Exception as error:
            # Keep the actionable exception in the worker-only status file.
            # The API deliberately exposes just the error class and phase.
            _write_status(
                "failed", _status_phase(), error_code=type(error).__name__,
                error_message=str(error)[:500],
            )
            LOGGER.exception("thermal forecast refresh failed")
            if args.once:
                raise
        if args.once:
            return
        # Refresh native satellite radiation throughout every forecast
        # interval; align retries to the UTC wall clock.
        next_run = next_refresh_at(time.time(), interval, followup_delay)


if __name__ == "__main__":
    main()
