"""Read-only access to the offline monthly UTCI climatology product."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_ROOT = Path(os.getenv("THERMAL_CLIMATOLOGY_ROOT", ROOT / "data/thermal/climatology"))
FRAME_ID = re.compile(r"m(?:0[1-9]|1[0-2])_h(?:[01]\d|2[0-3])")


class ThermalClimatologyUnavailable(RuntimeError):
    pass


def manifest() -> dict[str, Any]:
    try:
        payload = json.loads((PRODUCT_ROOT / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ThermalClimatologyUnavailable("historical UTCI climatology has not been built") from error
    if payload.get("schema") != "conditions-thermal-climatology/1":
        raise ThermalClimatologyUnavailable("historical UTCI climatology is incompatible")
    return payload


def frame_path(frame_id: str) -> Path:
    if not FRAME_ID.fullmatch(frame_id):
        raise ValueError("invalid climatology frame id")
    payload = manifest()
    record = next((item for item in payload.get("frames", []) if item.get("id") == frame_id), None)
    if record is None:
        raise ValueError("climatology frame is unavailable")
    filename = record.get("file")
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise ThermalClimatologyUnavailable("climatology frame path is invalid")
    path = PRODUCT_ROOT / filename
    if not path.is_file():
        raise ThermalClimatologyUnavailable("climatology frame file is missing")
    return path
