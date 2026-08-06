from __future__ import annotations

from server.era5_wind import climatology_summary, forcing_profile, nearest_sector


def test_nearest_sector_wraps_and_maps_cape_doctor():
    assert nearest_sector(359.0) == "n"
    assert nearest_sector(150.0) == "sse"


def test_generated_climatology_is_available_and_explicitly_incomplete():
    summary = climatology_summary()
    assert summary is not None
    assert summary["coverage"]["records"] == 4901
    assert summary["coverage"]["complete_hourly_climatology"] is False


def test_summer_cape_doctor_profile_has_observed_distribution():
    profile = forcing_profile("summer", 150.0, "neutral")
    assert profile is not None
    assert profile["sector"] == "sse"
    assert profile["sample_count"] >= 8
    assert profile["mean_speed_mps"] > 0
    assert profile["p95_gust_mps"] > profile["mean_speed_mps"]
