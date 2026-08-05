from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_generated_canopy_asset_preserves_scene_components_and_holes():
    asset = json.loads((ROOT / "public/assets/canopy.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "public/assets/manifest.json").read_text(encoding="utf-8"))
    records = asset["canopies"]
    assert len(records) == manifest["layers"]["canopy"]["components"]
    assert len(records) > 2000
    assert sum(max(0, len(record[5]) - 1) for record in records) > 0
    assert asset["area_drift_pct"] <= 2.0


def test_generated_canopy_heights_are_plausible_and_manifested():
    asset = json.loads((ROOT / "public/assets/canopy.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "public/assets/manifest.json").read_text(encoding="utf-8"))
    heights = [record[3] - record[1] for record in asset["canopies"]]
    assert min(heights) >= 3.9
    assert max(heights) <= 18.1
    assert manifest["version"] == 3
    assert manifest["assets"]["city_model"] == "city_model.json"
    assert manifest["assets"]["canopy"] == "canopy.json"
