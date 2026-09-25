#!/usr/bin/env python3
"""Compare measured CBD thermal conditions with one published model run.

The script pairs observations to the nearest published hourly frame without
interpolating model values. It reports observed-input UTCI and model residuals;
it does not promote the experimental product to validated status.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import statistics
import sys
from typing import Any

from server.thermal_products import load_manifest, sample_point


REQUIRED_COLUMNS = (
    "id", "observed_at", "x", "z", "air_temp_2m_c",
    "relative_humidity_pct", "tmrt_c", "wind_10m_mps",
)


def _timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("observed_at must include a timezone offset (for example +02:00 or Z)")
    return parsed.astimezone(timezone.utc)


def _number(row: dict[str, str], name: str) -> float:
    try:
        value = float(row[name])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a number") from error
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


def _metrics(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"bias": None, "mae": None, "rmse": None}
    return {
        "bias": round(statistics.fmean(values), 3),
        "mae": round(statistics.fmean(abs(value) for value in values), 3),
        "rmse": round(math.sqrt(statistics.fmean(value * value for value in values)), 3),
    }


def compare(csv_path: Path, run_id: str | None, tolerance_minutes: float) -> dict[str, Any]:
    try:
        from pythermalcomfort.models import utci
    except ImportError as error:
        raise RuntimeError("install requirements-models.txt to calculate reference UTCI") from error

    manifest = load_manifest(run_id)
    frames = manifest.get("frames", [])
    if not frames:
        raise RuntimeError("selected thermal run contains no hourly frames")
    frame_times = [(_timestamp(frame["valid_at"]), frame) for frame in frames]
    rows_out: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []
    with csv_path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        missing = sorted(set(REQUIRED_COLUMNS) - set(reader.fieldnames or []))
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(missing)}")
        for line, row in enumerate(reader, start=2):
            label = (row.get("id") or f"line-{line}").strip()
            try:
                observed_at = _timestamp(row["observed_at"])
                observed = {
                    name: _number(row, name)
                    for name in ("x", "z", "air_temp_2m_c", "relative_humidity_pct", "tmrt_c", "wind_10m_mps")
                }
                nearest_time, frame = min(frame_times, key=lambda item: abs((item[0] - observed_at).total_seconds()))
                offset_minutes = (nearest_time - observed_at).total_seconds() / 60.0
                if abs(offset_minutes) > tolerance_minutes:
                    raise ValueError(f"nearest frame is {abs(offset_minutes):.1f} min away (tolerance {tolerance_minutes:g})")
                ta, rh, tr, wind = (
                    observed["air_temp_2m_c"], observed["relative_humidity_pct"],
                    observed["tmrt_c"], observed["wind_10m_mps"],
                )
                if not 0 <= rh <= 100:
                    raise ValueError("relative_humidity_pct must be between 0 and 100")
                # The standard UTCI polynomial is documented for 0.5–17 m/s;
                # reject rather than silently clipping out-of-range observations.
                if not 0.5 <= wind <= 17:
                    raise ValueError("wind_10m_mps is outside the standard UTCI range (0.5–17 m/s)")
                if not -50 < ta < 50 or not ta - 30 < tr < ta + 70:
                    raise ValueError("air temperature or Tmrt is outside the standard UTCI input range")

                reference_result = utci(tdb=ta, tr=tr, v=wind, rh=rh, limit_inputs=False, round_output=False)
                observed_utci = float(getattr(reference_result, "utci", reference_result))
                model = sample_point(observed["x"], observed["z"], frame["id"], manifest["run_id"])
                values = model["values"]
                forcing = frame.get("forcing", {}).get("inputs", {})
                if values.get("utci_c") is None or values.get("tmrt_c") is None or values.get("wind_10m_mps") is None:
                    raise ValueError("model point is missing UTCI, Tmrt, or 10 m wind (use a newly generated run)")
                rows_out.append({
                    "id": label,
                    "observed_at": row["observed_at"].strip(),
                    "frame_at": frame["valid_at"],
                    "time_offset_minutes": round(offset_minutes, 1),
                    "site_name": (row.get("site_name") or "").strip() or None,
                    "sensor_ids": (row.get("sensor_ids") or "").strip() or None,
                    "averaging_period_s": (row.get("averaging_period_s") or "").strip() or None,
                    "measurement_notes": (row.get("measurement_notes") or "").strip() or None,
                    "x": observed["x"], "z": observed["z"],
                    "observed": {
                        "air_temp_2m_c": ta, "relative_humidity_pct": rh,
                        "tmrt_c": tr, "wind_10m_mps": wind, "utci_c": round(observed_utci, 3),
                    },
                    "model": {
                        "air_temp_2m_c": forcing.get("temperature_2m_c"),
                        "relative_humidity_pct": forcing.get("relative_humidity_2m_pct"),
                        "tmrt_c": values["tmrt_c"], "wind_10m_mps": values["wind_10m_mps"],
                        "utci_c": values["utci_c"],
                    },
                    "model_minus_observed": {
                        "air_temp_2m_c": round(float(forcing["temperature_2m_c"]) - ta, 3) if forcing.get("temperature_2m_c") is not None else None,
                        "relative_humidity_pct": round(float(forcing["relative_humidity_2m_pct"]) - rh, 3) if forcing.get("relative_humidity_2m_pct") is not None else None,
                        "tmrt_c": round(values["tmrt_c"] - tr, 3),
                        "wind_10m_mps": round(values["wind_10m_mps"] - wind, 3),
                        "utci_c": round(values["utci_c"] - observed_utci, 3),
                    },
                })
            except (KeyError, ValueError, TypeError) as error:
                excluded.append({"id": label, "reason": str(error)})

    residuals = {
        key: [float(item["model_minus_observed"][key]) for item in rows_out if item["model_minus_observed"][key] is not None]
        for key in ("air_temp_2m_c", "relative_humidity_pct", "tmrt_c", "wind_10m_mps", "utci_c")
    }
    return {
        "schema": "conditions-thermal-observation-validation/1",
        "run_id": manifest["run_id"],
        "validation_status": "diagnostic_paired_samples_not_validation",
        "pairing": {"method": "nearest published hourly frame; no temporal interpolation", "maximum_offset_minutes": tolerance_minutes},
        "paired_count": len(rows_out), "excluded_count": len(excluded),
        "metrics_model_minus_observed": {key: _metrics(values) for key, values in residuals.items()},
        "pairs": rows_out, "excluded": excluded,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("observations_csv", type=Path, help="CSV with measured CBD conditions; see docs/thermal_observations_template.csv")
    parser.add_argument("--run-id", help="published thermal run (defaults to CURRENT)")
    parser.add_argument("--max-time-offset-minutes", type=float, default=15.0)
    args = parser.parse_args()
    if not math.isfinite(args.max_time_offset_minutes) or args.max_time_offset_minutes < 0:
        parser.error("--max-time-offset-minutes must be finite and non-negative")
    try:
        result = compare(args.observations_csv, args.run_id, args.max_time_offset_minutes)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"thermal validation: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["paired_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
