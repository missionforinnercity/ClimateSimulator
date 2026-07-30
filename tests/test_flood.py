from __future__ import annotations

import numpy as np
import pytest

from server.flood import (
    boundary_closed_sides,
    dem_control_summary,
    flood_preview,
    simulate_local_inertial,
    triangular_hyetograph,
)


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


def test_array_manning_n_matches_an_equivalent_uniform_scalar():
    bed = np.zeros((10, 10), dtype=float)
    active = np.ones_like(bed, dtype=bool)
    active[[0, -1], :] = False
    active[:, [0, -1]] = False
    kwargs = dict(dx=4, dz=4, rainfall_mm_h=50, duration_s=400, infiltration_mm_h=0)
    scalar_result = simulate_local_inertial(bed, active, manning_n=0.035, **kwargs)
    array_result = simulate_local_inertial(bed, active, manning_n=np.full(bed.shape, 0.035), **kwargs)
    assert np.allclose(scalar_result["depth"], array_result["depth"])


def test_a_rougher_patch_retains_more_depth_on_a_downhill_slope():
    columns = np.arange(24, dtype=float)
    bed = np.repeat((-columns * 0.04)[None, :], 10, axis=0)
    active = np.ones_like(bed, dtype=bool)
    active[:, 0] = False
    active[:, -1] = False
    active[[0, -1], :] = False
    kwargs = dict(dx=4, dz=4, rainfall_mm_h=90, duration_s=300, infiltration_mm_h=0)
    smooth = simulate_local_inertial(bed, active, manning_n=np.full(bed.shape, 0.02), **kwargs)
    rough_field = np.full(bed.shape, 0.02)
    rough_field[:, 10:14] = 0.15
    rough = simulate_local_inertial(bed, active, manning_n=rough_field, **kwargs)
    patch = active & np.zeros_like(active)
    patch[:, 10:14] = active[:, 10:14]
    assert rough["max_depth"][patch].mean() > smooth["max_depth"][patch].mean()


def test_boundary_closed_sides_opens_only_the_downhill_edge():
    columns = np.arange(10, dtype=float)
    bed = np.repeat((-columns * 0.5)[None, :], 6, axis=0)
    active = np.ones_like(bed, dtype=bool)
    assert boundary_closed_sides(bed, active) == {
        "west": True, "east": False, "north": True, "south": True,
    }


def test_open_downhill_edge_drains_water_while_conserving_volume():
    columns = np.arange(20, dtype=float)
    bed = np.repeat((-columns * 0.15)[None, :], 14, axis=0)
    active = np.ones_like(bed, dtype=bool)
    closed_sides = boundary_closed_sides(bed, active)
    assert closed_sides["east"] is False
    result = simulate_local_inertial(
        bed, active, dx=4, dz=4, rainfall_mm_h=90, duration_s=900,
        infiltration_mm_h=0, manning_n=0.03, closed_boundary=closed_sides,
    )
    cell_area = 16.0
    source_volume = 90 / 3_600_000 * 900 * active.sum() * cell_area
    final_volume = result["depth"].sum() * cell_area
    assert result["boundary_outflow_m3"] > 0
    assert np.isclose(final_volume + result["boundary_outflow_m3"], source_volume, rtol=0.02)


def test_triangular_hyetograph_is_zero_at_edges_peaks_at_2x_and_conserves_mean():
    intensity_at = triangular_hyetograph(peak_fraction=0.4)
    assert intensity_at(0.0) == pytest.approx(0.0)
    assert intensity_at(1.0) == pytest.approx(0.0)
    assert intensity_at(0.4) == pytest.approx(2.0)
    samples = [intensity_at(fraction) for fraction in np.linspace(0, 1, 2001)]
    assert np.mean(samples) == pytest.approx(1.0, abs=0.01)


def test_time_varying_intensity_reshapes_filling_but_conserves_total_depth():
    bed = np.zeros((12, 12), dtype=float)
    active = np.ones_like(bed, dtype=bool)
    active[[0, -1], :] = False
    active[:, [0, -1]] = False
    result = simulate_local_inertial(
        bed, active, dx=4, dz=4, rainfall_mm_h=36, duration_s=600,
        infiltration_mm_h=0, manning_n=0.04,
        intensity_at=triangular_hyetograph(peak_fraction=0.4), snapshot_count=10,
    )
    expected_total = 0.006  # same total as the constant-rate case: 36 mm/h over 600 s
    assert np.allclose(result["depth"][active], expected_total, atol=2e-4)
    # 60s into a 600s storm (10% elapsed), a hyetograph peaking at 40% of the
    # duration has delivered far less than 10% of the total depth.
    assert result["snapshot_times_s"][1] == pytest.approx(60.0, abs=1.0)
    assert result["snapshots"][1][active].mean() < expected_total * 0.1 * 0.5


def test_flood_preview_reports_land_cover_and_boundary_metadata():
    result = flood_preview({
        "center_local": [0, 0],
        "size_m": 400,
        "resolution_m": 6,
        "rainfall_mm_h": 60,
        "duration_min": 20,
        "infiltration_mm_h": 5,
        "manning_n": 0.04,
    })
    model = result["model"]
    assert model["surface_roughness"].startswith("land_cover_varying")
    assert model["infiltration"].startswith("land_cover_varying")
    assert "boundary_open_sides" in model
    assert "drained_water_m3" in result["summary"]
    assert result["summary"]["mass_balance_error_pct"] < 2.0
