import json
import struct
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]


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
