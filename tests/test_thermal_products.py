from __future__ import annotations

import json

import numpy as np

import server.thermal_products as products
from server.thermal_worker import frame_id, sector_index


def _product(tmp_path):
    run_id = "thermal_20260920T100000Z"
    root = tmp_path / "products"
    run = root / run_id
    run.mkdir(parents=True)
    values = np.asarray([
        [[300, 280, 125, 7500], [310, 290, 150, 5000]],
        [[320, 300, 175, 2500], [-32768, -32768, -32768, -32768]],
    ], dtype="<i2")
    values.tofile(run / "20260920T1000Z.bin")
    manifest = {
        "schema": "conditions-thermal-forecast/1", "run_id": run_id,
        "generated_at": "2026-09-20T10:00:00Z", "stale_after_seconds": 7200,
        "validation_status": "experimental_unvalidated_modelled_estimate",
        "grid": {"width": 2, "height": 2, "resolution_m": 2, "bounds": [0, 0, 4, 4], "crs": "viewer-local-xz-metres"},
        "channels": [
            {"name": "tmrt_c", "scale": .1}, {"name": "utci_c", "scale": .1},
            {"name": "wind_1p5m_mps", "scale": .01}, {"name": "shadow_fraction", "scale": .0001},
        ],
        "nodata": -32768,
        "frames": [{"id": "20260920T1000Z", "valid_at": "2026-09-20T10:00:00Z", "file": "20260920T1000Z.bin"}],
        "energy_file": "energy.json", "wind_atlas": {"required_sectors": 16, "available_sectors": 16},
    }
    (run / "manifest.json").write_text(json.dumps(manifest))
    (run / "energy.json").write_text(json.dumps({"hours": []}))
    (root / "CURRENT").write_text(run_id)
    return root, run_id


def test_thermal_point_decodes_quantized_channels(tmp_path, monkeypatch):
    root, run_id = _product(tmp_path)
    monkeypatch.setattr(products, "PRODUCT_ROOT", root)
    monkeypatch.setattr(products, "CURRENT_FILE", root / "CURRENT")
    result = products.sample_point(1, 1, "20260920T1000Z")
    assert result["run_id"] == run_id
    assert result["values"] == {"tmrt_c": 30.0, "utci_c": 28.0, "wind_1p5m_mps": 1.25, "shadow_fraction": .75}
    assert result["utci_category"] == "moderate heat stress"


def test_sector_bins_and_frame_ids_are_deterministic():
    assert sector_index(0) == 0
    assert sector_index(11.24) == 0
    assert sector_index(11.25) == 1
    assert sector_index(359.9) == 0
    assert frame_id("2026-09-20T10:00:00Z") == "20260920T1000Z"


def test_forecast_status_reports_cold_start_without_raising(tmp_path, monkeypatch):
    root = tmp_path / "products"
    root.mkdir()
    monkeypatch.setattr(products, "PRODUCT_ROOT", root)
    monkeypatch.setattr(products, "CURRENT_FILE", root / "CURRENT")
    monkeypatch.setattr(products, "STATUS_FILE", root / "STATUS.json")

    result = products.forecast_status()

    assert result["available"] is False
    assert result["status"] == "not_started"
    assert "not published" in result["detail"]


def test_forecast_status_exposes_safe_worker_state(tmp_path, monkeypatch):
    root = tmp_path / "products"
    root.mkdir()
    (root / "STATUS.json").write_text(json.dumps({
        "state": "failed", "phase": "wind_atlas_validation",
        "updated_at": "2026-09-21T09:00:00Z", "error_code": "RuntimeError",
        "internal_error": "secret-bearing provider response",
    }))
    monkeypatch.setattr(products, "PRODUCT_ROOT", root)
    monkeypatch.setattr(products, "CURRENT_FILE", root / "CURRENT")
    monkeypatch.setattr(products, "STATUS_FILE", root / "STATUS.json")

    result = products.forecast_status()

    assert result["available"] is False
    assert result["status"] == "failed"
    assert result["worker"]["phase"] == "wind_atlas_validation"
    assert "internal_error" not in result["worker"]
