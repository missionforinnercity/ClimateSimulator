from __future__ import annotations

from server.heat import heat_zones


def test_heat_colour_scale_uses_bottom_and_top_deciles():
    payload = heat_zones("heat_model_lst_c")
    assert payload["color_scale"]["mode"] == "percentile_clipped_gradient"
    assert payload["color_scale"]["bottom_percentile"] == 10
    assert payload["color_scale"]["top_percentile"] == 90
    assert payload["color_range"]["min"] == payload["color_range"]["p10"]
    assert payload["color_range"]["max"] == payload["color_range"]["p90"]


def test_heat_summary_identifies_priority_hotspot_area():
    payload = heat_zones("heat_model_lst_c")
    summary = payload["summary"]

    assert summary["total_area_m2"] > 0
    assert summary["hotspot_area_m2"] > 0
    assert 0 < summary["hotspot_area_pct"] < 100
    assert payload["range"]["min"] <= summary["area_weighted_mean_c"] <= payload["range"]["max"]
    assert summary["maximum_c"] == payload["range"]["max"]


def test_pedestrian_priority_is_bounded_and_does_not_expose_poi_records():
    payload = heat_zones("pedestrian_priority_score")

    assert payload["metric_metadata"]["unit"] == "/100"
    assert 0 <= payload["range"]["min"] <= payload["range"]["max"] <= 100
    assert payload["methodology"]["priority_formula"].startswith("Pedestrian heat moderated")
    forbidden = {"google_address", "google_place_id", "google_latitude", "google_longitude", "google_primary_type"}
    assert all(not forbidden.intersection(feature) for feature in payload["features"])
    assert all(set(feature) == {"geometry", "value", "area_m2"} for feature in payload["features"])


def test_score_summary_uses_unit_neutral_fields():
    summary = heat_zones("shade_deficit_score")["summary"]

    assert summary["area_weighted_mean"] is not None
    assert summary["maximum"] is not None
    assert summary["area_weighted_mean_c"] is None
    assert summary["maximum_c"] is None


def test_rooftop_temperature_is_a_filtered_surface_temperature_view():
    rooftop = heat_zones("rooftop_temperature_c")
    surface = heat_zones("heat_model_lst_c")

    assert rooftop["metric_metadata"]["unit"] == "°C"
    assert 0 < rooftop["count"] < surface["count"]
    assert rooftop["methodology"]["rooftop_mask"].startswith("Only zones with at least 50%")
    assert surface["range"]["min"] <= rooftop["range"]["min"] <= surface["range"]["max"]
    assert surface["range"]["min"] <= rooftop["range"]["max"] <= surface["range"]["max"]


def test_shade_deficit_changes_with_time_and_includes_mapped_shade():
    morning = heat_zones("shade_deficit_score", "2026-01-15", 540)
    noon = heat_zones("shade_deficit_score", "2026-01-15", 720)

    morning_values = [feature["value"] for feature in morning["features"]]
    noon_values = [feature["value"] for feature in noon["features"]]
    assert morning_values != noon_values
    assert min(morning_values) < 100
    assert morning["scenario"]["shade_sources"] == ["mapped_buildings", "mapped_tree_canopies"]
