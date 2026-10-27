"""Compare measured pedestrian wind with a converted OpenFOAM CFD volume.

Measurements must be split before calibration (``calibration``) or untouched
evaluation (``holdout``). This scorer samples the published CFD volume directly;
it never substitutes the legacy screening field.
"""

from __future__ import annotations

from datetime import datetime
import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path
import statistics
from typing import Any

import numpy as np


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CFD_ROOT = PROJECT_ROOT / "public" / "assets" / "cfd"
DEM_PATH = PROJECT_ROOT / "data" / "derived" / "company_gardens_hybrid_dem_2m.tif"
SCENE_MANIFEST_PATH = PROJECT_ROOT / "public" / "assets" / "manifest.json"
CHANNELS = ("u_viewer_x", "w_up", "v_viewer_z", "speed", "p", "k", "epsilon")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _angular_error(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _read_case(case_id: str) -> tuple[dict[str, Any], np.ndarray, np.ndarray, dict[str, str]]:
    if not case_id or len(case_id) > 80 or not all(ch.isalnum() or ch in "_-" for ch in case_id):
        raise ValueError("case_id contains unsupported characters")
    case_dir = (CFD_ROOT / case_id).resolve()
    if case_dir.parent != CFD_ROOT.resolve():
        raise ValueError("case_id is outside the CFD asset directory")
    manifest_path, fields_path, mask_path = (
        case_dir / "volume.json", case_dir / "fields.f32", case_dir / "valid.u8"
    )
    if not all(path.is_file() for path in (manifest_path, fields_path, mask_path)):
        raise ValueError(f"OpenFOAM volume is unavailable for case {case_id}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "conditions-cfd-volume/1":
        raise ValueError("unsupported OpenFOAM volume schema")
    dimensions = tuple(int(value) for value in manifest.get("dimensions", []))
    channels = manifest.get("channels", [])
    if len(dimensions) != 3 or tuple(channels) != CHANNELS:
        raise ValueError("OpenFOAM volume dimensions or channels are incompatible")
    expected = math.prod(dimensions)
    mask = np.fromfile(mask_path, dtype=np.uint8)
    fields = np.fromfile(fields_path, dtype="<f4")
    if mask.size != expected or fields.size != expected * len(CHANNELS):
        raise ValueError("OpenFOAM volume data size does not match its manifest")
    # Converter storage order matches the browser index: x fastest, then y, z.
    nx, ny, nz = dimensions
    fields = fields.reshape((nz, ny, nx, len(CHANNELS)))
    mask = mask.reshape((nz, ny, nx)).astype(bool)
    hashes = {
        "volume_manifest_sha256": _sha256(manifest_path),
        "fields_sha256": _sha256(fields_path),
        "valid_mask_sha256": _sha256(mask_path),
    }
    return manifest, fields, mask, hashes


@lru_cache(maxsize=1)
def _terrain_grid() -> tuple[np.ndarray, Any, float | None, float, float]:
    try:
        import rasterio
    except ImportError as error:  # pragma: no cover - deployment dependency
        raise RuntimeError("rasterio is required to sample pedestrian height above terrain") from error
    scene = json.loads(SCENE_MANIFEST_PATH.read_text(encoding="utf-8"))
    origin_x, origin_y = scene["origin"]
    with rasterio.open(DEM_PATH) as dem:
        return dem.read(1), dem.transform, dem.nodata, float(origin_x), float(origin_y)


def _ground_elevation(x: float, z: float) -> float:
    terrain, transform, nodata, origin_x, origin_y = _terrain_grid()
    projected = (origin_x + x, origin_y - z)
    column, row = (~transform) * projected
    row, column = int(math.floor(row)), int(math.floor(column))
    if row < 0 or column < 0 or row >= terrain.shape[0] or column >= terrain.shape[1]:
        raise ValueError("observation is outside the terrain raster")
    value = float(terrain[row, column])
    if not math.isfinite(value) or (nodata is not None and value == nodata):
        raise ValueError("terrain elevation is missing at observation")
    return value


def _sample_volume(
    manifest: dict[str, Any], fields: np.ndarray, valid: np.ndarray,
    x: float, y: float, z: float,
) -> dict[str, float] | None:
    coordinates = manifest["coordinates"]
    center = coordinates["viewer_center_xz"]
    downwind = coordinates["x_downwind_in_viewer_xz"]
    crosswind = coordinates["y_crosswind_in_viewer_xz"]
    rx, rz = x - center[0], z - center[1]
    foam = np.asarray([
        rx * downwind[0] + rz * downwind[1],
        rx * crosswind[0] + rz * crosswind[1],
        y - coordinates["vertical_datum_m"],
    ], dtype=float)
    origin = np.asarray(manifest["origin_foam_m"], dtype=float)
    spacing = np.asarray(manifest["spacing_foam_m"], dtype=float)
    dimensions = np.asarray(manifest["dimensions"], dtype=int)
    coordinate = (foam - origin) / spacing
    if np.any(coordinate < 0) or np.any(coordinate > dimensions - 1):
        return None
    lower = np.minimum(np.floor(coordinate).astype(int), dimensions - 2)
    fraction = np.clip(coordinate - lower, 0.0, 1.0)
    total = np.zeros(len(CHANNELS), dtype=float)
    weight_total = 0.0
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                ix, iy, iz = lower + (dx, dy, dz)
                if not valid[iz, iy, ix]:
                    continue
                weight = ((fraction[0] if dx else 1 - fraction[0])
                          * (fraction[1] if dy else 1 - fraction[1])
                          * (fraction[2] if dz else 1 - fraction[2]))
                total += fields[iz, iy, ix] * weight
                weight_total += weight
    if weight_total < 0.05:
        return None
    values = total / weight_total
    return {name: float(values[index]) for index, name in enumerate(CHANNELS)}


def _metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    errors = [row["speed_error_mps"] for row in rows]
    if not errors:
        return {"n": 0, "bias_mps": None, "mae_mps": None, "rmse_mps": None,
                "speedup_bias": None, "speedup_mae": None, "speedup_rmse": None,
                "index_of_agreement": None, "direction_mae_deg": None}
    observed = np.asarray([row["observed_speed_mps"] for row in rows], dtype=float)
    predicted = np.asarray([row["predicted_speed_mps"] for row in rows], dtype=float)
    error = predicted - observed
    denominator = float(np.sum((np.abs(predicted - np.mean(observed)) + np.abs(observed - np.mean(observed))) ** 2))
    ia = 1.0 - float(np.sum(error ** 2)) / denominator if denominator > 0 else (1.0 if np.allclose(error, 0) else None)
    direction_errors = [row["direction_error_deg"] for row in rows if row.get("direction_error_deg") is not None]
    speedup_errors = [row["speedup_ratio_error"] for row in rows]
    return {
        "n": len(rows),
        "bias_mps": round(float(np.mean(error)), 4),
        "mae_mps": round(float(np.mean(np.abs(error))), 4),
        "rmse_mps": round(float(np.sqrt(np.mean(error ** 2))), 4),
        "speedup_bias": round(float(np.mean(speedup_errors)), 5),
        "speedup_mae": round(float(np.mean(np.abs(speedup_errors))), 5),
        "speedup_rmse": round(float(np.sqrt(np.mean(np.square(speedup_errors)))), 5),
        "index_of_agreement": round(ia, 5) if ia is not None else None,
        "direction_sample_count": len(direction_errors),
        "direction_mae_deg": round(statistics.fmean(direction_errors), 3) if direction_errors else None,
    }


def validate_openfoam_observations(
    case_id: str, observations: list[dict[str, Any]], *, direction_tolerance_deg: float = 11.25,
) -> dict[str, Any]:
    """Score a single OpenFOAM case using explicitly split local observations.

    Each observation needs measured pedestrian speed, its measurement height,
    a concurrent upstream reference speed/direction, and a predeclared split.
    The steady incompressible CFD velocity is scaled by the measured upstream
    speed / case inlet speed; this does not correct stability or turbulence.
    """
    manifest, fields, valid, hashes = _read_case(case_id)
    observation_payload_sha256 = hashlib.sha256(json.dumps(
        observations, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    case_direction = float(manifest["direction_deg_from"])
    case_speed = float(manifest["reference_speed_mps"])
    group_splits: dict[str, set[str]] = {}
    for row in observations:
        group = str(row.get("split_group", "")).strip()
        split = str(row.get("split", "")).strip().lower()
        if group and split in {"calibration", "holdout"}:
            group_splits.setdefault(group, set()).add(split)
    conflicted_groups = {group for group, splits in group_splits.items() if len(splits) > 1}
    rows: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []
    for index, row in enumerate(observations):
        label = str(row.get("id") or f"row-{index + 1}")
        try:
            split = str(row.get("split", "")).strip().lower()
            if split not in {"calibration", "holdout"}:
                raise ValueError("split must be calibration or holdout")
            split_group = str(row.get("split_group", "")).strip()
            if not split_group:
                raise ValueError("split_group must identify the complete site or period evaluation unit")
            if split_group in conflicted_groups:
                raise ValueError("split_group appears in both calibration and holdout")
            observed_at = str(row["observed_at"]).strip()
            try:
                parsed_time = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError("observed_at must be ISO 8601 with a timezone") from error
            if parsed_time.tzinfo is None:
                raise ValueError("observed_at must include a timezone offset")
            x, z = float(row["x"]), float(row["z"])
            speed = float(row["speed_mps"])
            height = float(row["height_m"])
            reference_speed = float(row["reference_speed_mps"])
            reference_direction = float(row["reference_direction_deg"])
            reference_height = float(row["reference_height_m"])
            averaging_period = float(row["averaging_period_s"])
            if not all(math.isfinite(value) for value in (x, z, speed, height, reference_speed,
                                                           reference_direction, reference_height,
                                                           averaging_period)):
                raise ValueError("coordinates, speeds, heights, averaging period and direction must be finite")
            if speed < 0 or height <= 0 or reference_speed <= 0 or reference_height <= 0 or averaging_period <= 0:
                raise ValueError("speed, height and averaging-period values are outside their valid range")
            direction_error = _angular_error(reference_direction % 360, case_direction)
            if direction_error > direction_tolerance_deg:
                raise ValueError(f"reference direction is {direction_error:.1f}° from this case (limit {direction_tolerance_deg:g}°)")
            ground = _ground_elevation(x, z)
            sample = _sample_volume(manifest, fields, valid, x, ground + height, z)
            if sample is None:
                raise ValueError("pedestrian sample is outside valid fluid cells in the CFD volume")
            scale = reference_speed / case_speed
            predicted = sample["speed"] * scale
            observed_speedup = speed / reference_speed
            predicted_speedup = predicted / reference_speed
            # Viewer z is south-positive. Convert the local velocity back to
            # meteorological direction-from degrees clockwise from north.
            predicted_direction = math.degrees(math.atan2(-sample["u_viewer_x"], sample["v_viewer_z"])) % 360
            measured_direction = row.get("wind_direction_deg")
            direction_residual = None
            if measured_direction not in (None, ""):
                direction_residual = _angular_error(predicted_direction, float(measured_direction) % 360)
            rows.append({
                "id": label, "split": split, "split_group": split_group,
                "site_name": row.get("site_name"), "observed_at": observed_at,
                "sensor_id": row.get("sensor_id"), "sensor_model": row.get("sensor_model"),
                "calibration_date": row.get("calibration_date"),
                "x": x, "z": z, "ground_elevation_m": round(ground, 3),
                "height_m": height, "case_direction_deg": case_direction,
                "reference_direction_deg": reference_direction,
                "reference_speed_mps": reference_speed, "reference_height_m": reference_height,
                "averaging_period_s": averaging_period,
                "direction_offset_deg": round(direction_error, 3),
                "observed_speed_mps": speed,
                "predicted_speed_mps": round(predicted, 4),
                "speed_error_mps": round(predicted - speed, 4),
                "observed_speedup_ratio": round(observed_speedup, 5),
                "predicted_speedup_ratio": round(predicted_speedup, 5),
                "speedup_ratio_error": round(predicted_speedup - observed_speedup, 5),
                "observed_direction_deg": float(measured_direction) % 360 if measured_direction not in (None, "") else None,
                "predicted_direction_deg": round(predicted_direction, 3),
                "direction_error_deg": round(direction_residual, 3) if direction_residual is not None else None,
                "source": {"u_viewer_x": sample["u_viewer_x"], "v_viewer_z": sample["v_viewer_z"], "speed_mps_at_case_inlet": sample["speed"]},
                "calibration": row.get("sensor_calibration"),
                "measurement_notes": row.get("measurement_notes"),
            })
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            excluded.append({"id": label, "reason": str(error)})
    calibration = [row for row in rows if row["split"] == "calibration"]
    holdout = [row for row in rows if row["split"] == "holdout"]
    metrics_by_split_group = {}
    for group in sorted({row["split_group"] for row in rows}):
        grouped = [row for row in rows if row["split_group"] == group]
        metrics_by_split_group[group] = {"split": grouped[0]["split"], **_metrics(grouped)}
    return {
        "schema": "conditions-openfoam-observation-validation/1",
        "status": "holdout_scored_not_validated" if holdout else "no_holdout_observations",
        "case": {
            "case_id": manifest["solver"]["case_id"], "solver": manifest["solver"],
            "direction_deg_from": case_direction, "reference_speed_mps": case_speed,
            "dimensions": manifest["dimensions"], "spacing_foam_m": manifest["spacing_foam_m"],
            "asset_hashes": hashes,
            "supporting_asset_hashes": {
                "terrain_dem_sha256": _sha256(DEM_PATH),
                "scene_manifest_sha256": _sha256(SCENE_MANIFEST_PATH),
            },
        },
        "provenance": {
            "observation_payload_sha256": observation_payload_sha256,
            "observation_rows_received": len(observations),
        },
        "method": {
            "field": "converted OpenFOAM CFD pedestrian volume",
            "sampling": "mask-normalized trilinear interpolation at surveyed height above 2 m terrain DEM",
            "reference_scaling": "steady incompressible velocity scaled linearly by concurrent upstream speed / case inlet speed",
            "direction_tolerance_deg": direction_tolerance_deg,
            "limitations": [
                "steady neutral RANS case; measured atmospheric stability is not simulated",
                "linear inlet-speed scaling does not account for stability-dependent flow changes",
                "the measured upstream reference height is recorded but not transformed; the uniform inlet has no atmospheric vertical profile",
                "case mesh and domain sensitivity remain separate validation gates",
                "holdout metrics apply only to sampled sites, heights, sectors and conditions",
            ],
        },
        "counts": {"paired": len(rows), "excluded": len(excluded), "calibration": len(calibration), "holdout": len(holdout)},
        "metrics": {"all": _metrics(rows), "calibration": _metrics(calibration), "holdout": _metrics(holdout)},
        "metrics_by_split_group": metrics_by_split_group,
        "pairs": rows, "excluded": excluded,
    }
