#!/usr/bin/env python3
"""Generate (and optionally run) ERA5-forced WindNinja reference cases."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.era5_wind import SECTORS, forcing_profile


CONFIG = """# ERA5-forced Cape Town WindNinja reference case
num_threads                 = {threads}
elevation_file              = {dem}
initialization_method       = domainAverageInitialization
input_speed                 = {speed:.4f}
input_speed_units           = mps
input_direction             = {direction:.2f}
input_wind_height           = 10.0
units_input_wind_height     = m
output_wind_height          = {height:.2f}
units_output_wind_height    = m
vegetation                  = brush
mesh_resolution             = {resolution:.2f}
units_mesh_resolution       = m
output_speed_units          = mps
output_path                 = {output_path}
write_ascii_output          = true
ascii_out_aaigrid           = true
ascii_out_uv                = true
ascii_out_proj              = true
ascii_out_resolution        = {resolution:.2f}
units_ascii_out_resolution  = m
write_goog_output           = false
write_shapefile_output      = false
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", type=Path, required=True, help="Projected regional Cape Town DEM")
    parser.add_argument("--season", choices=("annual", "summer", "autumn", "winter", "spring"), default="annual")
    parser.add_argument("--stability", choices=("unstable", "neutral", "stable"), default="neutral")
    parser.add_argument("--directions", nargs="+", default=["se", "sse", "s", "nw", "nnw"])
    parser.add_argument("--height-m", type=float, default=2.0)
    parser.add_argument("--resolution-m", type=float, default=25.0)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--output-dir", type=Path, default=Path("data/windninja_cases"))
    parser.add_argument("--binary", default="WindNinja_cli")
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()

    if not args.dem.exists():
        raise SystemExit(f"DEM not found: {args.dem}")
    binary = shutil.which(args.binary) if args.run else None
    if args.run and binary is None:
        raise SystemExit(f"WindNinja executable not found: {args.binary}")
    config_dir = args.output_dir / "configs"
    config_dir.mkdir(parents=True, exist_ok=True)
    for sector in args.directions:
        key = sector.lower()
        if key not in SECTORS:
            raise SystemExit(f"unknown sector: {sector}")
        profile = forcing_profile(args.season, SECTORS[key], args.stability)
        if profile is None:
            raise SystemExit(f"no ERA5 profile for {args.season}/{args.stability}/{key}")
        case_dir = (args.output_dir / f"{args.season}_{args.stability}_{key}").resolve()
        case_dir.mkdir(parents=True, exist_ok=True)
        config_path = config_dir / f"{args.season}_{args.stability}_{key}.cfg"
        config_path.write_text(CONFIG.format(
            threads=max(1, args.threads), dem=args.dem.resolve(), speed=profile["mean_speed_mps"],
            direction=profile["mean_direction_deg"], height=args.height_m,
            resolution=args.resolution_m, output_path=case_dir,
        ), encoding="utf-8")
        print(f"{key.upper()}: {profile['mean_speed_mps']:.2f} m/s @ {profile['mean_direction_deg']:.1f}° -> {config_path}")
        if binary:
            subprocess.run([binary, str(config_path.resolve())], check=True)


if __name__ == "__main__":
    main()
