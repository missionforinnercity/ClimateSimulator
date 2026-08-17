from __future__ import annotations

from scripts.build_hybrid_buildings import numeric_metres, osm_min_height, polygon_parts
from scripts.build_scene import building_min_height
from shapely.geometry import MultiPolygon, Polygon


def test_numeric_metres_accepts_sane_osm_height_values():
    assert numeric_metres("84") == 84
    assert numeric_metres("12 m") == 12
    assert numeric_metres("unknown") is None
    assert numeric_metres("500") is None


def test_building_min_height_preserves_only_real_vertical_clearance():
    assert building_min_height("5", 12) == 5
    assert building_min_height(None, 12) == 0
    assert building_min_height("30", 26) == 0
    assert building_min_height(None, 10.8, "1", "2") == 5.4


def test_osm_min_height_only_accepts_explicit_metric_clearance():
    assert osm_min_height({"min_height": "4.5", "building:min_level": "1"}) == 4.5
    assert osm_min_height({"building:min_level": "1"}) is None
    assert osm_min_height({}) is None


def test_polygon_parts_flattens_multipolygons():
    geometry = MultiPolygon([
        Polygon([(0, 0), (2, 0), (2, 2), (0, 2)]),
        Polygon([(3, 0), (4, 0), (4, 1), (3, 1)]),
    ])
    assert len(polygon_parts(geometry)) == 2
