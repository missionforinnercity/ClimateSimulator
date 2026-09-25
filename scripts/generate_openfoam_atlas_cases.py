#!/usr/bin/env python3
"""Generate (but do not solve) all sixteen tree-aware OpenFOAM cases."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=PROJECT_ROOT / "data/openfoam/cases")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    exporter = PROJECT_ROOT / "scripts/export_openfoam_case.py"
    for index in range(16):
        direction = index * 22.5
        case = args.output_root / f"cbd_atlas_{index:02d}_{direction:g}deg"
        if case.exists() and not args.overwrite:
            print(f"skip existing {case}")
            continue
        command = [
            sys.executable, str(exporter), "--full-scene", "--include-trees", "--output", str(case),
            "--direction-deg", str(direction), "--analysis-size-m", "2600", "--base-cell-m", "24",
            "--terrain-spacing-m", "12", "--top-m", "220",
        ]
        subprocess.run(command, cwd=PROJECT_ROOT, check=True)
    print("Cases generated. Run each Allmesh, Allrun and Allpost before building the atlas.")


if __name__ == "__main__":
    main()
