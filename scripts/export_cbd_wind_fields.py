#!/usr/bin/env python3
"""Precompute a building-resolved CBD wind field for every compass direction.

Runs the same mass-conserving diagnostic model used for the regional/mountain
field (server/terrain_wind.py), but over a local heightfield built from the
project's own LiDAR DTM and building footprints/heights instead of a regional
DEM -- so individual buildings and street canyons become the blocking-wall
geometry, at building scale, instead of ridgelines at mountain scale. This
replaces the externally-imported wind.ventilation_* polygon table as the
CBD-scale micro-factor with one derived from this project's own data.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.dem_utils import load_cbd_building_heightfield
from server.field import VALID_DIRECTIONS, load_regional_field
from server.terrain_wind import resample_bilinear_grid, solve_terrain_field


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dtm", type=Path, default=Path("data/raw/LiDAR2025/LiDAR2025_2m_DTM.tif"))
    parser.add_argument("--height", type=Path, default=Path("data/raw/LiDAR2025/Lidar2025_Height_Map_1m.tif"))
    parser.add_argument("--footprints", type=Path, default=Path("data/raw/BuildingFootprints2D.geojson"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/wind_fields/cbd"))
    parser.add_argument("--resolution-m", type=float, default=3.0)
    # A building must rise this many metres above its surrounding
    # neighbourhood (within --prominence-window-m) to count as a blocking
    # wall -- tuned for building/street scale, much smaller than the
    # regional model's mountain-scale 50m/1000m defaults.
    parser.add_argument("--sample-height-m", type=float, default=4.0)
    parser.add_argument("--prominence-window-m", type=float, default=50.0)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    heights, origin_x, origin_z, dx, dz = load_cbd_building_heightfield(
        args.dtm, args.footprints, args.height, args.resolution_m
    )
    print(f"CBD building grid: {heights.shape[1]}x{heights.shape[0]} @ {dx:.1f}m x {dz:.1f}m")

    rows, columns = heights.shape
    column_idx, row_idx = np.meshgrid(np.arange(columns), np.arange(rows))
    target_x = origin_x + (column_idx + 0.5) * dx
    target_z = origin_z + (row_idx + 0.5) * dz

    for name, direction_deg in VALID_DIRECTIONS.items():
        # Seed the CBD solve from the regional field's own already
        # mountain-shaped direction where available, instead of a flat
        # compass bearing -- the regional field has already bent/blocked
        # this wind by the time it reaches the CBD.
        regional_field = load_regional_field(direction_deg)
        if regional_field is not None:
            background_u = resample_bilinear_grid(
                regional_field["u"], regional_field["origin_x"], regional_field["origin_z"],
                regional_field["dx"], regional_field["dz"], target_x, target_z,
            )
            background_v = resample_bilinear_grid(
                regional_field["v"], regional_field["origin_x"], regional_field["origin_z"],
                regional_field["dx"], regional_field["dz"], target_x, target_z,
            )
            u, v = solve_terrain_field(
                heights,
                dx,
                dz,
                sample_height_m=args.sample_height_m,
                prominence_window_m=args.prominence_window_m,
                background_u=background_u,
                background_v=background_v,
            )
        else:
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
