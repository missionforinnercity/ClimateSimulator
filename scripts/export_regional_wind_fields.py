#!/usr/bin/env python3
"""Precompute terrain-resolved regional wind fields for every compass direction.

Runs the mass-conserving diagnostic model (server/terrain_wind.py) over a
regional DEM (the same SRTM tiles used for the visual regional terrain mesh)
and writes one compact unit-reference-speed field per direction. These are
consumed by server/field.py at request time: cropped, bilinear-resampled to
the requested preview window, and scaled by the requested reference speed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.dem_utils import load_regional_heightfield
from server.field import VALID_DIRECTIONS
from server.terrain_wind import solve_terrain_field


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", nargs="+", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("data/wind_fields/regional"))
    parser.add_argument("--center-lon", type=float, default=18.4231)
    parser.add_argument("--center-lat", type=float, default=-33.9231)
    parser.add_argument("--extent-km", type=float, default=8.0)
    parser.add_argument("--resolution-m", type=float, default=25.0)
    parser.add_argument("--sample-height-m", type=float, default=50.0)
    parser.add_argument("--prominence-window-m", type=float, default=1000.0)
    parser.add_argument("--iterations", type=int, default=500)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    heights, origin_x, origin_z, dx, dz = load_regional_heightfield(
        args.dem, args.center_lon, args.center_lat, args.extent_km, args.resolution_m
    )
    print(f"terrain grid: {heights.shape[1]}x{heights.shape[0]} @ {dx:.1f}m x {dz:.1f}m")

    for name, direction_deg in VALID_DIRECTIONS.items():
        u, v = solve_terrain_field(
            heights,
            dx,
            dz,
            direction_deg,
            sample_height_m=args.sample_height_m,
            prominence_window_m=args.prominence_window_m,
        )
        speed = np.hypot(u, v)
        output = args.output_dir / f"{name.lower()}.npz"
        np.savez_compressed(
            output,
            u=u.astype(np.float32),
            v=v.astype(np.float32),
            speed=speed.astype(np.float32),
            origin_x=np.float64(origin_x),
            origin_z=np.float64(origin_z),
            dx=np.float64(dx),
            dz=np.float64(dz),
            direction_deg=np.float64(direction_deg),
        )
        print(f"{name}: {output}")


if __name__ == "__main__":
    main()
