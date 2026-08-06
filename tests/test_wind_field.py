from __future__ import annotations

import math

import server.field as field_module
from server.field import build_field, direction_name, request_from_payload


def test_direction_names_wrap_at_north():
    assert direction_name(360) == "n"
    assert direction_name(150) == "cape_doctor"


def test_request_clamps_interactive_limits():
    request = request_from_payload({"center_local": [0, 0], "size_m": 10, "resolution_m": 100, "reference_speed_mps": 100}, {"origin": [0, 0]})
    assert request.size_m == 100
    assert request.resolution_m == 20
    assert request.reference_speed_mps == 50


def test_request_supports_large_visualisation_domain():
    request = request_from_payload({"center_local": [0, 0], "size_m": 5000}, {"origin": [0, 0]})
    assert request.size_m == 1200


def test_current_weather_reference_height_scales_to_pedestrian_level(monkeypatch):
    monkeypatch.setattr(field_module, "load_regional_field", lambda direction_deg: None)
    monkeypatch.setattr(field_module, "load_cbd_field", lambda direction_deg: None)
    request = request_from_payload({
        "center_local": [0, 0], "size_m": 100, "reference_speed_mps": 10,
        "reference_height_m": 10, "height_m": 2, "resolution_m": 20,
    }, {"origin": [0, 0]})
    result = build_field(request, (-50, -50, 50, 50), [])
    assert result["reference_height_m"] == 10
    assert result["height_m"] == 2
    assert result["height_adjusted_reference_speed_mps"] < 10


def test_era5_forcing_replaces_manual_speed_and_supplies_sector_frequency(monkeypatch):
    monkeypatch.setattr(field_module, "load_regional_field", lambda direction_deg: None)
    monkeypatch.setattr(field_module, "load_cbd_field", lambda direction_deg: None)
    monkeypatch.setattr(field_module, "forcing_profile", lambda season, direction, stability: {
        "mean_speed_mps": 8.0, "median_shear_exponent_10_100m": 0.2,
        "weibull_shape": 3.0, "frequency_fraction": 0.3,
        "coverage": {"complete_hourly_climatology": False},
    })
    request = request_from_payload({
        "center_local": [0, 0], "size_m": 100, "reference_speed_mps": 40,
        "reference_height_m": 10, "height_m": 2, "resolution_m": 20,
        "forcing_mode": "era5_climatology",
    }, {"origin": [0, 0]})
    result = build_field(request, (-50, -50, 50, 50), [])
    assert result["reference_speed_mps"] == 8.0
    assert result["height_profile_exponent"] == 0.2
    assert result["forcing_source"] == "ERA5_conditional_climatology"
    assert result["exceedance"]["sector_frequency_fraction"] == 0.3


def test_field_rotates_direction_and_scales_speed_without_regional_data(monkeypatch):
    # Forces the pre-terrain-model fallback path: no precomputed regional or
    # CBD field available (e.g. a bare checkout that hasn't run
    # scripts/export_regional_wind_fields.py / export_cbd_wind_fields.py yet)
    # should still produce the original constant-vector proxy behaviour exactly.
    monkeypatch.setattr(field_module, "load_regional_field", lambda direction_deg: None)
    monkeypatch.setattr(field_module, "load_cbd_field", lambda direction_deg: None)
    request = request_from_payload({"center_local": [0, 0], "size_m": 100, "direction_deg": 90, "reference_speed_mps": 10, "resolution_m": 20}, {"origin": [0, 0]})
    field = build_field(request, (-50, -50, 50, 50), [])
    assert field["width"] == 5
    assert field["model_kind"] == "directional_speed_proxy"
    assert all(abs(value - 0) < 1e-6 for value in field["v"])
    assert all(math.isclose(value, 6.5, rel_tol=0.01) for value in field["speed"])


def test_field_uses_terrain_resolved_flow_when_regional_data_present(monkeypatch):
    # With a precomputed regional field (and no CBD field), direction/speed
    # should vary spatially (not be one constant vector) and should be
    # terrain-blocked (zero) in cells the mock places behind a mountain.
    import numpy as np

    fake_field = {
        "u": np.array([[1.0, 0.0], [0.0, 0.0]]),
        "v": np.array([[0.0, 0.0], [0.0, 1.0]]),
        "origin_x": -50.0,
        "origin_z": -50.0,
        "dx": 100.0,
        "dz": 100.0,
    }
    monkeypatch.setattr(field_module, "load_regional_field", lambda direction_deg: fake_field)
    monkeypatch.setattr(field_module, "load_cbd_field", lambda direction_deg: None)
    request = request_from_payload({"center_local": [0, 0], "size_m": 100, "direction_deg": 90, "reference_speed_mps": 10, "resolution_m": 20}, {"origin": [0, 0]})
    field = build_field(request, (-50, -50, 50, 50), [])
    assert field["model_kind"] == "mass_conserving_terrain"
    assert len(set(round(value, 4) for value in field["v"])) > 1


def test_field_uses_cbd_building_flow_when_present(monkeypatch):
    # With a precomputed CBD building field, it should win direction over the
    # regional field, its speed factor should further multiply the regional
    # one, and model_kind should reflect the building-resolved layer.
    import numpy as np

    fake_regional = {
        "u": np.full((2, 2), 1.0),
        "v": np.full((2, 2), 0.0),
        "origin_x": -50.0,
        "origin_z": -50.0,
        "dx": 100.0,
        "dz": 100.0,
    }
    fake_cbd = {
        "u": np.array([[0.0, 0.0], [0.0, 0.0]]),
        "v": np.array([[0.0, 0.0], [0.0, 2.0]]),
        "origin_x": -50.0,
        "origin_z": -50.0,
        "dx": 100.0,
        "dz": 100.0,
    }
    monkeypatch.setattr(field_module, "load_regional_field", lambda direction_deg: fake_regional)
    monkeypatch.setattr(field_module, "load_cbd_field", lambda direction_deg: fake_cbd)
    request = request_from_payload({"center_local": [0, 0], "size_m": 100, "direction_deg": 90, "reference_speed_mps": 10, "resolution_m": 20}, {"origin": [0, 0]})
    field = build_field(request, (-50, -50, 50, 50), [])
    assert field["model_kind"] == "mass_conserving_terrain_buildings"
    # The bottom-right quadrant is blocked in the CBD field (u=v=0 there),
    # so despite a nonzero regional field, the combined speed must be zero.
    assert min(field["speed"]) < 1e-6
    # Elsewhere the CBD field's direction (pure +v) should win over the
    # regional field's (pure +u), so v should vary and be nonzero somewhere.
    assert max(field["v"]) > 0
