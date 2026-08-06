from __future__ import annotations

import numpy as np

from server.wind_metrics import add_screening_metrics, comfort_codes, validate_against_observations


def sample_field() -> dict:
    return {
        "model_kind": "mass_conserving_terrain_buildings",
        "validation_status": "exploratory_not_engineering_grade",
        "origin": [0.0, 0.0],
        "width": 2,
        "height": 2,
        "dx": 5.0,
        "dz": 5.0,
        "height_m": 2.0,
        "reference_height_m": 10.0,
        "speed": [2.0, 4.0, 6.0, 8.0],
    }


def test_screening_metrics_have_one_value_per_grid_cell():
    field = add_screening_metrics(sample_field(), stability="neutral", exceedance_threshold_mps=6.0)
    assert field["analysis_mode"] == "preview"
    assert len(field["comfort_category"]) == 4
    assert len(field["exceedance"]["probability"]) == 4
    assert len(field["uncertainty"]["speed_lower_mps"]) == 4
    assert all(0.0 <= value <= 1.0 for value in field["exceedance"]["probability"])


def test_comfort_category_worsens_as_five_percent_speed_rises():
    codes = comfort_codes(np.asarray([2.0, 3.0, 5.0, 7.0, 9.0, 12.0]))
    assert codes.tolist() == [0, 1, 2, 3, 4, 5]


def test_validation_returns_error_and_observation_distance_maps():
    field = add_screening_metrics(sample_field(), stability="neutral", exceedance_threshold_mps=6.0)
    observations = [
        {"id": "a", "x": 2.5, "z": 2.5, "speed_mps": 2.0, "height_m": 2.0, "observed_at": None},
        {"id": "b", "x": 7.5, "z": 2.5, "speed_mps": 5.0, "height_m": 2.0, "observed_at": None},
        {"id": "c", "x": 2.5, "z": 7.5, "speed_mps": 5.0, "height_m": 2.0, "observed_at": None},
    ]
    result = validate_against_observations(field, observations)
    assert result["status"] == "benchmark_only_not_validated"
    assert result["observation_count"] == 3
    assert result["metrics"]["rmse_mps"] > 0
    assert len(result["error_map_mps"]) == 4
    assert len(result["distance_to_observation_m"]) == 4
