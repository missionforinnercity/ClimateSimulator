from __future__ import annotations

from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree
import pytest

import server.sunlight as sunlight


def simple_scene():
    footprint = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    building = {
        "id": 0, "footprint": footprint,
        "ring": [(0, 0), (10, 0), (10, 10), (0, 10)],
        "ground": 0.0, "top": 10.0,
    }
    return {
        "buildings": [building], "blockers": [building],
        "tree": STRtree([footprint]), "bounds": footprint.bounds, "max_top": 10.0,
    }


def test_building_sun_hours_cover_roofs_and_facades(monkeypatch):
    monkeypatch.setattr(sunlight, "_scene_geometry", simple_scene)
    sunlight.building_surface_sunlight.cache_clear()
    sunlight._analysis_cells.cache_clear()

    result = sunlight.building_surface_sunlight(
        "2026-01-15", 600, 720, 60, 10.0, "all",
    )

    surfaces = {feature["surface"] for feature in result["features"]}
    assert surfaces == {"roof", "facade"}
    assert result["mode"] == "building_surfaces_3d"
    assert result["scenario"]["sample_count"] == 2
    assert result["range"]["max"] <= 2
    assert any(feature["value"] == 0 for feature in result["features"] if feature["surface"] == "facade")
    assert all("surface_y" in feature for feature in result["features"] if feature["surface"] == "roof")
    assert all(len(feature["vertices"]) == 4 for feature in result["features"] if feature["surface"] == "facade")
    assert all("source_id" in feature and "edge_index" in feature for feature in result["features"] if feature["surface"] == "facade")


def test_building_surface_resolution_is_bounded(monkeypatch):
    monkeypatch.setattr(sunlight, "_scene_geometry", simple_scene)
    sunlight.building_surface_sunlight.cache_clear()
    sunlight._analysis_cells.cache_clear()

    try:
        sunlight.building_surface_sunlight(resolution_m=1.0)
    except ValueError as error:
        assert "5, 10, or 20" in str(error)
    else:
        raise AssertionError("unsupported full-CBD resolution should be rejected")


def test_cancelled_building_sunlight_stops_before_ray_cast(monkeypatch):
    monkeypatch.setattr(sunlight, "_scene_geometry", simple_scene)
    analysis_id = "moved-domain"
    sunlight.cancel_sunlight_analysis(analysis_id)
    try:
        with pytest.raises(sunlight.SunlightAnalysisCancelled):
            sunlight.building_surface_sunlight.__wrapped__(
                "2026-01-15", 600, 720, 60, 10.0, "all",
                None, None, None, None, analysis_id,
            )
    finally:
        sunlight.finish_sunlight_analysis(analysis_id)


def test_building_surface_domain_clips_analysis_but_keeps_scene_blockers(monkeypatch):
    monkeypatch.setattr(sunlight, "_scene_geometry", simple_scene)
    sunlight.building_surface_sunlight.cache_clear()
    sunlight._analysis_cells.cache_clear()

    result = sunlight.building_surface_sunlight(
        "2026-01-15", 600, 660, 60, 5.0, "all", 0.0, 0.0, 5.0, 10.0,
    )

    assert result["scenario"]["domain_bounds"] == (0.0, 0.0, 5.0, 10.0)
    assert result["summary"]["total_area_m2"] < 500
    assert all(
        feature["geometry"]["coordinates"][0][0][0] <= 5.0
        for feature in result["features"] if feature["surface"] == "roof"
    )


def test_overlapping_building_parts_do_not_remove_modelled_facades():
    tall = {
        "id": 0, "footprint": Polygon([(0, 0), (10, 0), (10, 10), (0, 10)]),
        "ring": [(0, 0), (10, 0), (10, 10), (0, 10)], "ground": 0.0, "top": 10.0,
    }
    lower = {
        "id": 1, "footprint": Polygon([(0, -5), (10, -5), (10, 1), (0, 1)]),
        "ring": [(0, -5), (10, -5), (10, 1), (0, 1)], "ground": 0.0, "top": 4.0,
    }

    cells = sunlight._facade_cells([tall, lower], 10.0)
    exposed = [cell for cell in cells if cell["source_id"] == 0 and cell["sample"][2] < 0]

    assert exposed
    assert min(vertex[1] for cell in exposed for vertex in cell["vertices"]) == 0.0
    assert max(vertex[1] for cell in exposed for vertex in cell["vertices"]) == 10.0


def test_courtyard_inner_walls_generate_outward_facing_facade_cells():
    outer = [(0, 0), (10, 0), (10, 10), (0, 10)]
    hole = [(3, 3), (7, 3), (7, 7), (3, 7)]
    building = {
        "id": 0, "footprint": Polygon(outer, [hole]),
        "ring": outer, "rings": [outer, hole], "ground": 0.0, "top": 10.0,
    }

    cells = sunlight._facade_cells([building], 10.0)
    courtyard_cells = [cell for cell in cells if cell["edge_index"] >= len(outer)]

    assert len(courtyard_cells) == 4
    assert all(not building["footprint"].covers(Point(cell["sample"][0], cell["sample"][2])) for cell in courtyard_cells)
