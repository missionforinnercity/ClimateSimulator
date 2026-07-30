from __future__ import annotations

import json
from pathlib import Path

import rasterio
from shapely.geometry import Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]


def test_scene_uses_irregular_valid_hybrid_terrain_footprint_not_raster_rectangle():
    scene = json.loads((ROOT / "public" / "assets" / "fallback.json").read_text(encoding="utf-8"))
    terrain = scene["terrain"]
    assert 0 < sum(terrain["valid"]) < len(terrain["valid"])
    assert terrain["footprint"]

    footprint = unary_union([
        Polygon(rings[0], rings[1:])
        for rings in terrain["footprint"]
    ])
    with rasterio.open(ROOT / "data" / "derived" / "company_gardens_hybrid_dem_2m.tif") as source:
        valid_area = int((source.read_masks(1) > 0).sum()) * abs(source.transform.a * source.transform.e)
    assert abs(footprint.area - valid_area) / valid_area < 0.001


def test_exported_building_centres_are_inside_lidar_footprint():
    scene = json.loads((ROOT / "public" / "assets" / "fallback.json").read_text(encoding="utf-8"))
    footprint = unary_union([
        Polygon(rings[0], rings[1:])
        for rings in scene["terrain"]["footprint"]
    ])
    for building in scene["buildings"]:
        assert footprint.covers(Polygon(building[2]).representative_point())
