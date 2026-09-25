#!/usr/bin/env python3
"""Check the generated data artifacts required by a full thermal deployment."""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CASE_NAMES = (
    "cbd_n_full", "cbd_ne_full", "cbd_e_full", "cbd_se_full",
    "cbd_s_full", "cbd_sw_full", "cbd_w_full", "cbd_nw_full",
    "cbd_22p5_full", "cbd_67p5_full", "cbd_112p5_full", "cbd_157p5_full",
    "cbd_202p5_full", "cbd_247p5_full", "cbd_292p5_full", "cbd_337p5_full",
)


def require_file(path: Path, problems: list[str]) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        problems.append(f"missing or empty: {path.relative_to(ROOT)}")


def read_json(path: Path, problems: list[str]) -> dict:
    require_file(path, problems)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        problems.append(f"invalid JSON: {path.relative_to(ROOT)}")
        return {}


def main() -> int:
    problems: list[str] = []
    for name in CASE_NAMES:
        folder = ROOT / "public/assets/cfd" / name
        record = read_json(folder / "volume.json", problems)
        for filename in ("fields.f32", "valid.u8"):
            require_file(folder / filename, problems)
        if record and record.get("schema") != "conditions-cfd-volume/1":
            problems.append(f"incompatible CFD manifest: {folder.relative_to(ROOT)}")

    atlas_root = ROOT / "data/openfoam/atlas"
    atlas = read_json(atlas_root / "manifest.json", problems)
    sectors = atlas.get("sectors", [])
    if {int(item.get("sector_index", -1)) for item in sectors} != set(range(16)):
        problems.append("wind atlas must list all sector indices 0 through 15")
    for item in sectors:
        filename = item.get("file")
        if not isinstance(filename, str) or Path(filename).name != filename:
            problems.append("wind atlas contains an invalid sector filename")
        else:
            require_file(atlas_root / filename, problems)

    climate_root = ROOT / "data/thermal/climatology"
    climate = read_json(climate_root / "manifest.json", problems)
    climate_frames = climate.get("frames", [])
    if len(climate_frames) != 288:
        problems.append(f"climate profile should contain 288 month/hour frames; found {len(climate_frames)}")
    for frame in climate_frames:
        filename = frame.get("file")
        if not isinstance(filename, str) or Path(filename).name != filename:
            problems.append("climate manifest contains an invalid frame filename")
        else:
            require_file(climate_root / filename, problems)

    if problems:
        print("Thermal deployment artifact check failed:")
        print("\n".join(f"- {item}" for item in problems))
        return 1
    print(f"Thermal deployment artifacts ready: {len(CASE_NAMES)} browser CFD volumes, 16 wind-atlas sectors, {len(climate_frames)} climate frames.")
    print("SOLWEIG surfaces and SUEWS configuration are generated in the thermal-worker image build.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
