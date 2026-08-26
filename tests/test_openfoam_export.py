from __future__ import annotations

import math
from pathlib import Path

from scripts.export_openfoam_case import (
    cancel_duplicate_triangles,
    foam_to_viewer,
    full_scene_domain,
    viewer_to_foam,
    wind_axes,
    write_case_files,
)


def test_wind_axes_align_meteorological_direction_with_positive_foam_x():
    downwind, crosswind = wind_axes(135.0)
    assert math.isclose(downwind[0], -math.sqrt(0.5))
    assert math.isclose(downwind[1], -math.sqrt(0.5))
    assert math.isclose(sum(value * value for value in crosswind), 1.0)
    assert math.isclose(sum(a * b for a, b in zip(downwind, crosswind)), 0.0, abs_tol=1e-12)


def test_openfoam_viewer_transform_round_trip():
    center = (42.0, -17.0)
    downwind, crosswind = wind_axes(150.0)
    foam = viewer_to_foam(120.0, 33.0, center, downwind, crosswind)
    viewer = foam_to_viewer(*foam, center, downwind, crosswind)
    assert math.isclose(viewer[0], 120.0, abs_tol=1e-10)
    assert math.isclose(viewer[1], 33.0, abs_tol=1e-10)


def test_full_scene_domain_contains_vertices_with_asymmetric_wake_padding():
    buildings = [[0, 10, [[-10, -5], [20, -5], [20, 15], [-10, 15]]]]
    domain = full_scene_domain(buildings, (0, 0), (1, 0), (0, 1))
    assert domain == (-310, 620, -305, 315)


def test_opposite_coincident_faces_cancel_as_internal_surface():
    upward = ((0.0, 0.0, 1.0), (1.0, 0.0, 1.0), (0.0, 1.0, 1.0))
    downward = upward[0], upward[2], upward[1]
    assert cancel_duplicate_triangles([upward, downward]) == []
    assert cancel_duplicate_triangles([upward, upward]) == [upward]


def test_generated_allrun_supports_parallel_and_serial_modes(tmp_path: Path):
    write_case_files(tmp_path, (-20, 40, -20, 20), 40, 10, 10, (-12, 0, 12), 15)
    allrun = (tmp_path / "Allrun").read_text()
    assert "OPENFOAM_NPROCS:-4" in allrun
    assert "foamRun -parallel" in allrun
    assert "runApplication -o foamRun" in allrun
