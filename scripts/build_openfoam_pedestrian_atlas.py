#!/usr/bin/env python3
"""Sample sixteen converted CFD volumes onto the 2 m thermal grid."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import rasterio
from scipy.ndimage import distance_transform_edt, map_coordinates

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _sha(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest


def sample_volume(volume_dir: Path, grid_path: Path, dem_path: Path, output: Path) -> dict:
    manifest = json.loads((volume_dir / "volume.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "conditions-cfd-volume/1":
        raise ValueError(f"incompatible volume {volume_dir}")
    dimensions = np.asarray(manifest["dimensions"], dtype=int)
    channels = len(manifest["channels"])
    fields = np.fromfile(volume_dir / manifest["fields"], dtype="<f4")
    valid_volume = np.fromfile(volume_dir / manifest["valid_mask"], dtype=np.uint8)
    expected = int(np.prod(dimensions))
    if fields.size != expected * channels or valid_volume.size != expected:
        raise ValueError(f"truncated volume {volume_dir}")
    fields = fields.reshape(dimensions[2], dimensions[1], dimensions[0], channels)
    valid_volume = valid_volume.reshape(dimensions[2], dimensions[1], dimensions[0])
    grid = json.loads(grid_path.read_text(encoding="utf-8"))
    with rasterio.open(dem_path) as source:
        dem = source.read(1).astype(np.float32)
        dem[dem == source.nodata] = np.nan
    height, width = dem.shape
    min_x, min_z, max_x, max_z = map(float, grid["viewer_bounds"])
    resolution = float(grid["resolution_m"])
    viewer_x = min_x + (np.arange(width) + 0.5) * resolution
    viewer_z = min_z + (np.arange(height) + 0.5) * resolution
    xx, zz = np.meshgrid(viewer_x, viewer_z)
    coords = manifest["coordinates"]
    center = np.asarray(coords["viewer_center_xz"], dtype=float)
    downwind = np.asarray(coords["x_downwind_in_viewer_xz"], dtype=float)
    crosswind = np.asarray(coords["y_crosswind_in_viewer_xz"], dtype=float)
    relative_x, relative_z = xx - center[0], zz - center[1]
    foam_x = relative_x * downwind[0] + relative_z * downwind[1]
    foam_y = relative_x * crosswind[0] + relative_z * crosswind[1]
    origin = np.asarray(manifest["origin_foam_m"], dtype=float)
    spacing = np.asarray(manifest["spacing_foam_m"], dtype=float)
    ix, iy = (foam_x - origin[0]) / spacing[0], (foam_y - origin[1]) / spacing[1]
    reference = float(manifest["reference_speed_mps"])
    if reference <= 0:
        raise ValueError("CFD reference speed must be positive")

    scene_mask = np.isfinite(dem)

    def at_height(relative_height: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        foam_z = dem - float(coords["vertical_datum_m"]) + relative_height
        iz = (foam_z - origin[2]) / spacing[2]
        positions = np.asarray([iz, iy, ix])
        speed = map_coordinates(fields[..., 3], positions, order=1, mode="constant", cval=np.nan)
        mask = map_coordinates(valid_volume.astype(np.float32), positions, order=0, mode="constant", cval=0) >= 0.5
        ratio = (speed / reference).astype(np.float32)
        sampled = mask & np.isfinite(ratio) & scene_mask
        # VTK correctly marks cells inside solids as invalid.  The thermal
        # product nevertheless needs a complete scene grid (including roof
        # and building pixels).  Fill those pixels with the nearest valid
        # CFD sample and retain an explicit extrapolation mask so consumers
        # can distinguish measured/probed values from the fallback.
        missing = scene_mask & ~sampled
        extrapolated = missing.copy()
        if np.any(missing):
            if not np.any(sampled):
                raise ValueError(f"{volume_dir}: no valid CFD samples at {relative_height:g} m")
            _, nearest = distance_transform_edt(~sampled, return_distances=True, return_indices=True)
            ratio[missing] = ratio[tuple(nearest[:, missing])]
        ratio[~scene_mask] = np.nan
        return ratio, sampled, extrapolated

    ratio_1p5, sampled_1p5, extrapolated_1p5 = at_height(1.5)
    ratio_10, sampled_10, extrapolated_10 = at_height(10.0)
    valid = scene_mask & np.isfinite(ratio_1p5) & np.isfinite(ratio_10)
    ratio_1p5[~valid] = np.nan
    ratio_10[~valid] = np.nan
    extrapolated = (extrapolated_1p5 | extrapolated_10) & valid
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, speed_ratio_1p5=ratio_1p5, speed_ratio_10=ratio_10,
                        valid=valid.astype(np.uint8), extrapolated=extrapolated.astype(np.uint8))
    return {
        "sector_index": int(round(float(manifest["direction_deg_from"]) / 22.5)) % 16,
        "direction_deg": float(manifest["direction_deg_from"]), "file": output.name,
        "sha256": _sha(output),
        "valid_fraction": float(valid[scene_mask].mean()) if np.any(scene_mask) else 0.0,
        "scene_fraction": float(scene_mask.mean()),
        "raw_sample_fraction_1p5": float(sampled_1p5[scene_mask].mean()) if np.any(scene_mask) else 0.0,
        "raw_sample_fraction_10m": float(sampled_10[scene_mask].mean()) if np.any(scene_mask) else 0.0,
        "extrapolated_fraction": float(extrapolated[scene_mask].mean()) if np.any(scene_mask) else 0.0,
        "source_case": manifest["solver"]["case_id"], "validation_status": manifest["validation_status"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("volumes", nargs="+", type=Path, help="Sixteen directories containing volume.json and fields")
    parser.add_argument("--surfaces", type=Path, default=PROJECT_ROOT / "data/thermal/surfaces")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "data/openfoam/atlas")
    args = parser.parse_args()
    if len(args.volumes) != 16:
        parser.error("exactly sixteen converted volumes are required")
    args.output.mkdir(parents=True, exist_ok=True)
    sectors = []
    for directory in args.volumes:
        source_manifest = json.loads((directory / "volume.json").read_text(encoding="utf-8"))
        index = int(round(float(source_manifest["direction_deg_from"]) / 22.5)) % 16
        sectors.append(sample_volume(directory, args.surfaces / "grid.json", args.surfaces / "dem.tif", args.output / f"sector_{index:02d}.npz"))
    if {item["sector_index"] for item in sectors} != set(range(16)):
        raise SystemExit("volumes do not provide each of the sixteen sectors exactly once")
    grid = json.loads((args.surfaces / "grid.json").read_text(encoding="utf-8"))
    manifest = {
        "schema": "conditions-cfd-pedestrian-atlas/1", "version": 1,
        "grid": {key: grid[key] for key in ("viewer_bounds", "resolution_m", "width", "height")},
        "heights_m": [1.5, 10.0], "sector_width_deg": 22.5,
        "validation_status": "experimental_unvalidated_modelled_estimate", "sectors": sorted(sectors, key=lambda item: item["sector_index"]),
        "limitations": ["neutral RANS scaling", "no directional interpolation", "not validated against local observations"],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output / 'manifest.json'}")


if __name__ == "__main__":
    main()
