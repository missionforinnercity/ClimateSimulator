import json
import struct
from pathlib import Path

import numpy as np
from shapely.geometry import Polygon

from scripts.build_scene import parametric_roof_is_credible


ROOT = Path(__file__).resolve().parents[1]


def roof_fit_is_credible(polygon, **overrides):
    values = {
        "coverage": 0.84,
        "shape_name": "gable",
        "rise": 3.0,
        "half_short_m": 7.0,
        "shape_inlier_fraction": 0.81,
        "shape_rmse": 0.45,
        "flat_rmse": 0.9,
        "observed_range": 3.0,
    }
    values.update(overrides)
    return parametric_roof_is_credible(polygon, **values)


def test_parametric_roof_rules_keep_simple_roofs_and_reject_lidar_spikes():
    rectangle = Polygon([(0, 0), (22, 0), (22, 12), (0, 12)])

    assert roof_fit_is_credible(rectangle)
    assert not roof_fit_is_credible(rectangle, rise=5.0, half_short_m=5.0)
    assert not roof_fit_is_credible(rectangle, coverage=0.61)


def test_parametric_roof_rules_reject_irregular_and_oversized_hip_roofs():
    concave = Polygon([(0, 0), (22, 0), (22, 5), (7, 5), (7, 18), (0, 18)])
    city_block = Polygon([(0, 0), (50, 0), (50, 40), (0, 40)])

    assert not roof_fit_is_credible(concave)
    assert not roof_fit_is_credible(city_block, shape_name="hip")


def test_parametric_roof_rules_respect_osm_shape_and_limit_untagged_hips():
    small_roof = Polygon([(0, 0), (20, 0), (20, 12), (0, 12)])
    medium_roof = Polygon([(0, 0), (30, 0), (30, 15), (0, 15)])

    assert roof_fit_is_credible(small_roof, shape_name="hip")
    assert not roof_fit_is_credible(medium_roof, shape_name="hip")
    assert not roof_fit_is_credible(small_roof, roof_shape_hint="dome")
    assert roof_fit_is_credible(small_roof, roof_shape_hint="gabled")


def test_roof_surface_binary_matches_manifest_and_has_valid_geometry():
    manifest = json.loads((ROOT / "public/assets/manifest.json").read_text(encoding="utf-8"))
    assert "imagery" not in manifest["layers"]
    assert "aerial" not in manifest["assets"]
    metadata = manifest["layers"]["roof_surface"]
    payload = (ROOT / "public/assets/roof_surface.bin").read_bytes()
    vertex_count, index_count = struct.unpack_from("<II", payload, 0)
    position_bytes = vertex_count * 3 * 4
    height_bytes = vertex_count * 4
    expected_size = 8 + position_bytes + height_bytes + index_count * 4

    assert len(payload) == expected_size == metadata["bytes"]
    assert len(metadata["cache_key"]) == 16
    assert vertex_count == metadata["vertices"]
    assert index_count // 3 == metadata["triangles"]
    assert metadata["height_semantics"] == "height_above_dtm"
    assert metadata["sample_spacing_m"] == 2
    assert metadata["detailed_buildings"] > 0
    assert metadata["fallback_buildings"] > 0
    assert metadata["detailed_buildings"] + metadata["fallback_buildings"] == metadata["buildings"]
    assert "simplified_surface" not in metadata["roof_models"]
    assert metadata["roof_models"].get("regularized_flat", 0) > 0
    assert metadata["roof_models"].get("parametric_hip", 0) + metadata["roof_models"].get("parametric_gable", 0) > 0

    heights = np.frombuffer(payload, dtype="<f4", count=vertex_count, offset=8 + position_bytes)
    indices = np.frombuffer(payload, dtype="<u4", count=index_count, offset=8 + position_bytes + height_bytes)
    assert float(heights.min()) >= 2.0
    assert float(heights.max()) <= 140.0
    assert int(indices.max()) < vertex_count


def test_detailed_roofs_replace_caps_and_uncovered_buildings_keep_fallback_profiles():
    scene = json.loads((ROOT / "public/assets/fallback.json").read_text(encoding="utf-8"))
    detailed = [building for building in scene["buildings"] if building[6]]
    fallback = [building for building in scene["buildings"] if not building[6]]

    assert detailed and fallback
    assert all(len(building[9]) == len(building[2]) for building in detailed)
    assert all(building[8] != "height_fallback" for building in detailed)
    assert all(building[9] is None and building[8] == "height_fallback" for building in fallback)


def test_active_railways_are_in_the_scene_and_manifest():
    scene = json.loads((ROOT / "public/assets/fallback.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "public/assets/manifest.json").read_text(encoding="utf-8"))

    assert len(scene["railways"]) == manifest["layers"]["fallback"]["railways"]
    assert len(scene["railways"]) > 0
    assert {railway[0] for railway in scene["railways"]} <= {"rail", "tram", "light_rail"}
    assert all(len(railway[1]) >= 2 for railway in scene["railways"])
