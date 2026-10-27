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

    quick = sunlight.building_surface_sunlight(resolution_m=40.0)
    assert quick["scenario"]["resolution_m"] == 40.0

    try:
        sunlight.building_surface_sunlight(resolution_m=1.0)
    except ValueError as error:
        assert "5, 10, 20, or 40" in str(error)
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


def test_proposed_building_geometry_changes_sunlight_rays(monkeypatch):
    empty_scene = {
        "buildings": [], "blockers": [], "tree": None,
        "bounds": (-100.0, -100.0, 100.0, 100.0), "max_top": 0.0,
    }
    monkeypatch.setattr(sunlight, "_scene_geometry", lambda: empty_scene)
    proposal = {
        "remove_building_indexes": [],
        "add_buildings": [[0.0, 10.0, [[0, 0], [10, 0], [10, 10], [0, 10]]]],
    }
    edited_scene = sunlight._scene_geometry_with_design(proposal)
    ground_cell = [{"surface": "ground", "source_id": -1, "sample": (-10.0, 0.0, 5.0), "normal": (0.0, 1.0, 0.0)}]
    sun_state = [(0.5, 1.0, 0.0, 1.0)]

    baseline_hours = sunlight._sun_hours_for_cells(ground_cell, sun_state, scene_override=empty_scene)
    edited_hours = sunlight._sun_hours_for_cells(ground_cell, sun_state, scene_override=edited_scene)

    assert len(edited_scene["buildings"]) == 1
    assert edited_scene["buildings"][0]["top"] == 10.0
    assert baseline_hours == [1.0]
    assert edited_hours == [0.0]


def test_mapped_ground_cells_follow_terrain_and_skip_building_footprints(monkeypatch):
    terrain = {
        "columns": 2, "rows": 2, "heights": [1.0, 1.0, 3.0, 3.0],
        "valid": [1, 1, 1, 1], "bounds": (0.0, 0.0, 40.0, 40.0),
    }
    building = {
        "id": 0, "footprint": Polygon([(20, 20), (40, 20), (40, 40), (20, 40)]),
        "ring": [(20, 20), (40, 20), (40, 40), (20, 40)],
        "ground": 0.0, "top": 10.0,
    }
    monkeypatch.setattr(sunlight, "_terrain_grid", lambda: terrain)
    cells = sunlight._ground_cells({"buildings": [building]}, resolution_m=20.0)

    assert [cell["grid_key"] for cell in cells] == [(0, 0), (0, 1), (1, 0)]
    assert [cell["sample"][1] for cell in cells] == pytest.approx([1.58, 1.58, 2.58])
    assert all(cell["area_m2"] == 400.0 for cell in cells)


def test_modified_building_keeps_mapped_polygon_holes(monkeypatch):
    monkeypatch.setattr(sunlight, "_scene_geometry", simple_scene)
    proposal = {
        "remove_building_indexes": [0],
        "add_buildings": [[0.0, 12.0,
            [[0, 0], [20, 0], [20, 20], [0, 20]],
            [[[5, 5], [5, 15], [15, 15], [15, 5]]],
        ]],
    }

    scene = sunlight._scene_geometry_with_design(proposal)
    footprint = scene["buildings"][0]["footprint"]

    assert len(scene["buildings"][0]["rings"]) == 2
    assert footprint.covers(Point(2, 2))
    assert not footprint.covers(Point(10, 10))


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
