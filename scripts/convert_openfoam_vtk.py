#!/usr/bin/env python3
"""Sample an OpenFOAM legacy VTK result into a browser-friendly CFD volume.

The output keeps the regular grid in OpenFOAM's wind-aligned coordinates.  The
manifest carries the rotation back to Climate Explorer viewer coordinates, so
the browser can trilinearly sample a small interleaved float32 asset instead of
downloading the complete unstructured mesh.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


CHANNELS = ("u_viewer_x", "w_up", "v_viewer_z", "speed", "p", "k", "epsilon")
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def foam_velocity_to_viewer(velocity: np.ndarray, downwind: np.ndarray, crosswind: np.ndarray) -> np.ndarray:
    """Return viewer x/up/z velocity from OpenFOAM x/y/z velocity."""
    converted = np.empty_like(velocity, dtype=np.float32)
    converted[:, 0] = velocity[:, 0] * downwind[0] + velocity[:, 1] * crosswind[0]
    converted[:, 1] = velocity[:, 2]
    converted[:, 2] = velocity[:, 0] * downwind[1] + velocity[:, 1] * crosswind[1]
    return converted


def robust_range(values: np.ndarray, mask: np.ndarray, low: float = 1.0, high: float = 99.0) -> list[float]:
    selected = values[mask]
    selected = selected[np.isfinite(selected)]
    if not selected.size:
        return [0.0, 1.0]
    return [float(value) for value in np.percentile(selected, (low, high))]


def convert(vtk_path: Path, case_path: Path, output_dir: Path, spacing: tuple[float, float, float]) -> dict:
    try:
        import vtk
        from vtk.util.numpy_support import vtk_to_numpy
    except ImportError as error:  # pragma: no cover - environment guidance
        raise SystemExit("VTK's Python bindings are required (python3-vtk9 on Ubuntu).") from error

    case = json.loads(case_path.read_text(encoding="utf-8"))
    bounds = case["domain_foam_m"]
    origin = np.array([bounds["x"][0], bounds["y"][0], bounds["z"][0]], dtype=float)
    maximum = np.array([bounds["x"][1], bounds["y"][1], bounds["z"][1]], dtype=float)
    spacing_array = np.asarray(spacing, dtype=float)
    dimensions = np.floor((maximum - origin) / spacing_array).astype(int) + 1
    # Include the far boundary exactly even when a requested spacing does not divide it.
    spacing_array = (maximum - origin) / np.maximum(dimensions - 1, 1)

    reader = vtk.vtkUnstructuredGridReader()
    reader.SetFileName(str(vtk_path))
    reader.ReadAllScalarsOn()
    reader.ReadAllVectorsOn()
    reader.Update()
    source = reader.GetOutput()
    if not source.GetPointData().GetArray("U"):
        raise ValueError(f"{vtk_path} does not contain point velocity field U")

    image = vtk.vtkImageData()
    image.SetOrigin(*origin)
    image.SetSpacing(*spacing_array)
    image.SetDimensions(*[int(value) for value in dimensions])
    probe = vtk.vtkProbeFilter()
    probe.SetInputData(image)
    probe.SetSourceData(source)
    probe.Update()
    sampled = probe.GetOutput().GetPointData()

    mask_array = sampled.GetArray("vtkValidPointMask")
    mask = vtk_to_numpy(mask_array).astype(bool) if mask_array else np.ones(int(np.prod(dimensions)), dtype=bool)
    velocity = vtk_to_numpy(sampled.GetArray("U")).astype(np.float32, copy=False)
    axes = case["foam_axes_in_viewer_xz"]
    viewer_velocity = foam_velocity_to_viewer(
        velocity,
        np.asarray(axes["x_downwind"], dtype=np.float32),
        np.asarray(axes["y_crosswind"], dtype=np.float32),
    )
    speed = np.linalg.norm(viewer_velocity, axis=1).astype(np.float32)
    fields = [viewer_velocity[:, 0], viewer_velocity[:, 1], viewer_velocity[:, 2], speed]
    for name in ("p", "k", "epsilon"):
        array = sampled.GetArray(name)
        if array is None:
            raise ValueError(f"{vtk_path} does not contain point field {name}")
        fields.append(vtk_to_numpy(array).astype(np.float32, copy=False))
    interleaved = np.column_stack(fields).astype("<f4", copy=False)
    interleaved[~mask] = 0

    output_dir.mkdir(parents=True, exist_ok=True)
    field_name = "fields.f32"
    mask_name = "valid.u8"
    interleaved.tofile(output_dir / field_name)
    mask.astype(np.uint8).tofile(output_dir / mask_name)

    ranges = {name: robust_range(interleaved[:, index], mask) for index, name in enumerate(CHANNELS)}
    scene_path = PROJECT_ROOT / "public/assets/fallback.json"
    coverage = None
    if scene_path.exists():
        buildings = json.loads(scene_path.read_text(encoding="utf-8")).get("buildings", [])
        x_bounds, y_bounds = case["domain_foam_m"]["x"], case["domain_foam_m"]["y"]
        center = case["viewer_center"]
        downwind = np.asarray(axes["x_downwind"])
        crosswind = np.asarray(axes["y_crosswind"])
        covered = 0
        for record in buildings:
            ring = record[2]
            x = sum(point[0] for point in ring) / len(ring) - center[0]
            z = sum(point[1] for point in ring) / len(ring) - center[1]
            foam_x = x * downwind[0] + z * downwind[1]
            foam_y = x * crosswind[0] + z * crosswind[1]
            covered += x_bounds[0] <= foam_x <= x_bounds[1] and y_bounds[0] <= foam_y <= y_bounds[1]
        coverage = {
            "scene_buildings": len(buildings),
            "centroids_in_domain": int(covered),
            "fraction": float(covered / len(buildings)) if buildings else 0.0,
        }
    manifest = {
        "schema": "climate-explorer-cfd-volume/1",
        "solver": {
            "name": "OpenFOAM",
            "version": str(case["openfoam_version"]),
            "case_id": case["case_id"],
            "model": case["model"],
        },
        "validation_status": case["validation_status"],
        "result_time": vtk_path.stem.rsplit("_", 1)[-1],
        "direction_deg_from": case["direction_deg_from"],
        "reference_speed_mps": case["reference_speed_mps"],
        "coordinates": {
            "grid": "OpenFOAM wind-aligned x/y/z metres",
            "viewer_center_xz": case["viewer_center"],
            "x_downwind_in_viewer_xz": axes["x_downwind"],
            "y_crosswind_in_viewer_xz": axes["y_crosswind"],
            "vertical_datum_m": case["vertical_datum_m"],
        },
        "origin_foam_m": origin.tolist(),
        "dimensions": dimensions.tolist(),
        "spacing_foam_m": spacing_array.tolist(),
        "channels": list(CHANNELS),
        "fields": field_name,
        "valid_mask": mask_name,
        "ranges": ranges,
        "valid_fraction": float(mask.mean()),
        "building_coverage": coverage,
        "limitations": case.get("limitations", []),
    }
    (output_dir / "volume.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vtk", type=Path, help="Latest internal-volume VTK produced by Allpost")
    parser.add_argument("--case", type=Path, help="case.json (defaults beside the VTK directory)")
    parser.add_argument("--output", type=Path, default=Path("public/assets/cfd/cbd_se_pilot"))
    parser.add_argument("--spacing", type=float, nargs=3, metavar=("DX", "DY", "DZ"), default=(10.0, 10.0, 6.0),
                        help="Sampling spacing along OpenFOAM x/y/z (default: 10 10 6 m)")
    args = parser.parse_args()
    case_path = args.case or args.vtk.parent.parent / "case.json"
    manifest = convert(args.vtk, case_path, args.output, tuple(args.spacing))
    count = int(np.prod(manifest["dimensions"]))
    print(f"Wrote {count:,} samples to {args.output} ({manifest['valid_fraction']:.1%} valid)")


if __name__ == "__main__":
    main()
