"""Metadata access for the terrain-only runoff concentration screen."""

from __future__ import annotations

import json
from pathlib import Path
import struct
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SUMMARY_PATH = ROOT / "public/assets/runoff_screening.json"
ASSET_ROOT = ROOT / "public/assets"
HEADER = struct.Struct("<8sIIffffI")
MAGIC = b"CTFLOW01"


def runoff_screening_manifest() -> dict[str, Any]:
    try:
        summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FileNotFoundError("runoff screening asset has not been built") from error
    filename = summary.get("asset")
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise ValueError("runoff screening asset path is invalid")
    asset_path = ASSET_ROOT / filename
    expected_bytes = int(summary.get("asset_bytes", 0))
    if not asset_path.is_file() or expected_bytes <= HEADER.size or asset_path.stat().st_size != expected_bytes:
        raise FileNotFoundError("runoff screening asset is missing or truncated")
    with asset_path.open("rb") as stream:
        header = stream.read(HEADER.size)
    if len(header) != HEADER.size or HEADER.unpack(header)[0] != MAGIC:
        raise ValueError("runoff screening asset header is invalid")
    _magic, width, height, _resolution, _min_x, _min_z, _threshold, count = HEADER.unpack(header)
    if HEADER.size + count * 8 != expected_bytes:
        raise ValueError("runoff screening asset record count is invalid")
    grid = summary.get("grid") or {}
    if int(grid.get("width", 0)) != width or int(grid.get("height", 0)) != height:
        raise ValueError("runoff screening asset and summary grids differ")
    return {
        **summary,
        "asset_url": f"/assets/{filename}",
        "asset_cache_key": summary.get("asset_sha256", ""),
    }
