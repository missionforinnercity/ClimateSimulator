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
