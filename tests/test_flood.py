from __future__ import annotations

import numpy as np
import pytest

from server.flood import dem_control_summary, flood_preview, simulate_local_inertial


def test_flat_grid_conserves_uniform_rainfall_without_open_edge_loss():
    bed = np.zeros((12, 12), dtype=float)
    active = np.ones_like(bed, dtype=bool)
    # Keep a closed inactive rim so the analytical rainfall depth is isolated
    # from the solver's intentionally open outer boundary.
    active[[0, -1], :] = False
    active[:, [0, -1]] = False
    result = simulate_local_inertial(
        bed,
        active,
        dx=4,
        dz=4,
        rainfall_mm_h=36,
        duration_s=600,
        infiltration_mm_h=0,
        manning_n=0.04,
    )
    expected = 0.006
    assert np.allclose(result["depth"][active], expected, atol=1e-6)


def test_closed_box_retains_water_at_active_outer_edges_and_records_frames():
    bed = np.zeros((10, 14), dtype=float)
    active = np.ones_like(bed, dtype=bool)
    result = simulate_local_inertial(
        bed,
        active,
        dx=4,
        dz=4,
        rainfall_mm_h=60,
        duration_s=600,
        infiltration_mm_h=0,
        manning_n=0.04,
        closed_boundary=True,
        snapshot_count=5,
    )
    assert np.allclose(result["depth"], 0.01, atol=1e-6)
    assert len(result["snapshots"]) == 6
    assert np.all(result["snapshots"][0] == 0)
    assert np.allclose(result["snapshots"][-1], result["depth"])


def test_water_routes_downhill_and_building_cells_remain_dry():
    columns = np.arange(24, dtype=float)
    bed = np.repeat((-columns * 0.04)[None, :], 16, axis=0)
    active = np.ones_like(bed, dtype=bool)
    active[:, 0] = False
    active[:, -1] = False
    active[[0, -1], :] = False
    building = np.zeros_like(active)
    building[6:10, 11:14] = True
    active &= ~building
    result = simulate_local_inertial(
        bed,
        active,
        dx=4,
        dz=4,
        rainfall_mm_h=90,
        duration_s=300,
        infiltration_mm_h=0,
        manning_n=0.04,
    )
    assert np.all(result["depth"][building] == 0)
    assert np.nanmean(result["u"][active]) > 0
    assert result["max_depth"][active].max() > 0


def test_infiltration_can_absorb_rainfall():
    bed = np.zeros((8, 8), dtype=float)
    active = np.ones_like(bed, dtype=bool)
    active[[0, -1], :] = False
    active[:, [0, -1]] = False
    result = simulate_local_inertial(
        bed,
        active,
        dx=4,
        dz=4,
        rainfall_mm_h=5,
        duration_s=600,
        infiltration_mm_h=10,
        manning_n=0.04,
    )
    assert np.all(result["depth"] == 0)


def test_explicit_source_grid_can_conserve_routed_roof_rain():
    bed = np.zeros((7, 7), dtype=float)
    active = np.zeros_like(bed, dtype=bool)
    active[2:5, 2:5] = True
    source = np.zeros_like(bed)
    # Nine open cells receive their own 10 mm plus nine equivalent roof-cell
    # contributions over one hour: an average depth of 20 mm.
    source[active] = 0.02 / 3600
    result = simulate_local_inertial(
        bed,
        active,
        dx=4,
        dz=4,
        rainfall_mm_h=10,
        duration_s=3600,
        infiltration_mm_h=0,
        manning_n=0.04,
        source_rate_mps=source,
    )
    assert np.isclose(result["depth"][active].mean(), 0.02, atol=1e-5)


def test_town_survey_marks_are_used_as_qa_not_an_automatic_correction():
    summary = dem_control_summary()
    assert summary["available"] is True
    assert summary["usable_marks"] >= 50
    assert summary["correction_applied"] is False
    assert 0 < summary["rmse_m"] < 1


def test_flood_box_outside_lidar_footprint_is_rejected_before_simulation():
    with pytest.raises(ValueError, match="available terrain footprint"):
        flood_preview({
            "bounds_local": [-1030, -890, -900, -760],
            "resolution_m": 6,
            "rainfall_mm_h": 30,
            "duration_min": 5,
            "infiltration_mm_h": 0,
            "manning_n": 0.04,
        })
