from __future__ import annotations

from server.heat import heat_zones


def test_heat_colour_scale_uses_bottom_and_top_deciles():
    payload = heat_zones("heat_model_lst_c")
    assert payload["color_scale"]["mode"] == "percentile_clipped_gradient"
    assert payload["color_scale"]["bottom_percentile"] == 10
    assert payload["color_scale"]["top_percentile"] == 90
    assert payload["color_range"]["min"] == payload["color_range"]["p10"]
    assert payload["color_range"]["max"] == payload["color_range"]["p90"]
