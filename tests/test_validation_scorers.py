from __future__ import annotations

import csv
import hashlib
import sys
from types import ModuleType, SimpleNamespace

import numpy as np

from scripts import validate_thermal_observations as thermal_validation
from server import cfd_validation


def test_openfoam_scorer_uses_split_observations_and_hashes_supporting_assets(monkeypatch):
    manifest = {
        "solver": {"case_id": "test-case", "version": "test"},
        "direction_deg_from": 270.0,
        "reference_speed_mps": 10.0,
        "dimensions": [2, 2, 2],
        "spacing_foam_m": [1.0, 1.0, 1.0],
        "coordinates": {
            "viewer_center_xz": [0.0, 0.0],
            "x_downwind_in_viewer_xz": [1.0, 0.0],
            "y_crosswind_in_viewer_xz": [0.0, 1.0],
            "vertical_datum_m": 0.0,
        },
        "origin_foam_m": [0.0, 0.0, 0.0],
    }
    fields = np.zeros((2, 2, 2, len(cfd_validation.CHANNELS)), dtype=float)
    fields[..., 0] = 4.0
    fields[..., 3] = 4.0
    valid = np.ones((2, 2, 2), dtype=bool)
    monkeypatch.setattr(cfd_validation, "_read_case", lambda _case: (manifest, fields, valid, {
        "volume_manifest_sha256": "manifest", "fields_sha256": "fields", "valid_mask_sha256": "mask",
    }))
    monkeypatch.setattr(cfd_validation, "_ground_elevation", lambda _x, _z: 0.0)
    monkeypatch.setattr(cfd_validation, "_sha256", lambda path: f"hash:{path.name}")
    rows = [{
        "id": "holdout-1", "site_name": "open-square", "sensor_id": "anemometer-1",
        "sensor_model": "model-x", "calibration_date": "2026-01-01",
        "observed_at": "2026-10-27T10:00:00Z", "x": 0.5, "z": 0.5,
        "speed_mps": 2.0, "height_m": 0.5, "reference_speed_mps": 5.0,
        "reference_direction_deg": 270.0, "reference_height_m": 10.0,
        "wind_direction_deg": 270.0, "averaging_period_s": 600,
        "split": "holdout", "split_group": "site:open-square",
        "sensor_calibration": "certificate-1",
    }]

    result = cfd_validation.validate_openfoam_observations("test-case", rows)

    assert result["status"] == "holdout_scored_not_validated"
    assert result["counts"] == {"paired": 1, "excluded": 0, "calibration": 0, "holdout": 1}
    assert result["metrics"]["holdout"]["mae_mps"] == 0.0
    assert result["pairs"][0]["sensor_model"] == "model-x"
    assert result["provenance"]["observation_payload_sha256"]
    assert result["case"]["supporting_asset_hashes"]["terrain_dem_sha256"].startswith("hash:")


def test_thermal_scorer_reports_measurement_basis_and_file_provenance(tmp_path, monkeypatch):
    rows = [{
        "id": "sample-1", "site_name": "sun", "observed_at": "2026-10-27T10:00:00Z",
        "x": "1", "z": "2", "air_temp_2m_c": "20", "relative_humidity_pct": "50",
        "tmrt_c": "35", "wind_10m_mps": "2", "sensor_ids": "ta-1;rh-1;tmrt-1;wind-1",
        "sensor_calibration": "certificates archived", "averaging_period_s": "600",
        "split": "holdout", "split_group": "site:sun",
    }]
    observations_path = tmp_path / "observations.csv"
    with observations_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    fake_models = ModuleType("pythermalcomfort.models")
    fake_models.utci = lambda **_kwargs: SimpleNamespace(utci=25.0)
    fake_package = ModuleType("pythermalcomfort")
    fake_package.models = fake_models
    monkeypatch.setitem(sys.modules, "pythermalcomfort", fake_package)
    monkeypatch.setitem(sys.modules, "pythermalcomfort.models", fake_models)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text("{\"immutable\":true}", encoding="utf-8")
    frame = {
        "id": "20261027T1000Z", "valid_at": "2026-10-27T10:00:00Z",
        "sha256": "frame-hash", "forcing": {"inputs": {
            "temperature_2m_c": 21.0, "relative_humidity_2m_pct": 55.0,
        }},
    }
    manifest = {"run_id": "thermal-test", "frames": [frame], "models": {"solweig": {"version": "test"}}}
    monkeypatch.setattr(thermal_validation, "load_manifest", lambda _run: manifest)
    monkeypatch.setattr(thermal_validation, "source_manifest_path", lambda _run: manifest_path)
    monkeypatch.setattr(thermal_validation, "sample_point", lambda *_args: {"values": {
        "utci_c": 26.0, "tmrt_c": 40.0, "wind_10m_mps": 2.5,
    }})

    result = thermal_validation.compare(observations_path, "thermal-test", 15)

    assert result["validation_status"] == "holdout_scored_not_validated"
    assert result["pairs"][0]["sensor_calibration"] == "certificates archived"
    assert "not a spatial SUEWS" in result["comparison_basis"]["air_temp_2m_c"]
    assert result["provenance"]["observations_sha256"] == hashlib.sha256(observations_path.read_bytes()).hexdigest()
    assert result["provenance"]["frame_sha256_by_id"][frame["id"]] == "frame-hash"
