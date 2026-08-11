from __future__ import annotations

from scripts.build_hybrid_buildings import numeric_metres, polygon_parts
from shapely.geometry import MultiPolygon, Polygon


def test_numeric_metres_accepts_sane_osm_height_values():
    assert numeric_metres("84") == 84
    assert numeric_metres("12 m") == 12
    assert numeric_metres("unknown") is None
    assert numeric_metres("500") is None


def test_polygon_parts_flattens_multipolygons():
    geometry = MultiPolygon([
        Polygon([(0, 0), (2, 0), (2, 2), (0, 2)]),
        Polygon([(3, 0), (4, 0), (4, 1), (3, 1)]),
    ])
    assert len(polygon_parts(geometry)) == 2
