from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import zipfile

from scripts import archive_climate_report as archive
from scripts import verify_climate_report as verifier


def test_thermal_validation_report_verifies_and_archives_csv_manifest_and_frames(tmp_path, monkeypatch):
    csv_bytes = b"id,observed_at\nsite-1,2026-10-27T10:00:00Z\n"
    frame_bytes = b"thermal frame fixture"
    frame_hash = hashlib.sha256(frame_bytes).hexdigest()
    run_id = "thermal-test"
    frame_id = "20261027T1000Z"
    manifest_bytes = json.dumps({
        "schema": "conditions-thermal-forecast/1", "run_id": run_id,
        "frames": [{"id": frame_id, "valid_at": "2026-10-27T10:00:00Z", "sha256": frame_hash}],
    }, separators=(",", ":")).encode()
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    csv_hash = hashlib.sha256(csv_bytes).hexdigest()
    pair = {
        "id": "site-1", "split": "holdout", "split_group": "site:one",
        "frame_id": frame_id, "frame_at": "2026-10-27T10:00:00Z", "frame_sha256": frame_hash,
        "model_minus_observed": {
            "air_temp_2m_c": 1.0, "relative_humidity_pct": -2.0,
            "tmrt_c": 3.0, "wind_10m_mps": 0.5, "utci_c": -1.0,
        },
    }
    metric_names = tuple(pair["model_minus_observed"])
    metrics = {
        name: {"bias": value, "mae": abs(value), "rmse": abs(value)}
        for name, value in pair["model_minus_observed"].items()
    }
    result_data = {
        "schema": "conditions-thermal-observation-validation/1", "run_id": run_id,
        "validation_status": "holdout_scored_not_validated", "pairs": [pair],
        "metrics_model_minus_observed": metrics,
        "provenance": {
            "observations_sha256": csv_hash, "manifest_sha256": manifest_hash,
            "frame_sha256_by_id": {frame_id: frame_hash},
        },
        "source_input": {
            "format": "base64", "filename": "thermal.csv",
            "data": base64.b64encode(csv_bytes).decode(),
        },
    }
    reference = {
        "type": "thermal-observation-validation", "run_id": run_id,
        "manifest_url": "https://example.test/api/thermal/source-manifest",
        "manifest_sha256": manifest_hash, "observations_sha256": csv_hash,
        "source_frames": [{
            "id": frame_id, "valid_at": pair["frame_at"], "sha256": frame_hash,
            "url": "https://example.test/api/thermal/frame.bin",
        }],
        "result_embedded_in_report": True,
    }
    report = {
        "schema": "conditions-climate-report/1", "generatedAt": "2026-10-27T12:00:00Z",
        "application": {"origin": "https://example.test"},
        "results": {"thermal_validation": {
            "reference": reference, "summary": {"validation_status": result_data["validation_status"]},
            "result_data": result_data,
        }},
    }

    monkeypatch.setattr(archive, "_json_asset", lambda url, *_args: (url, manifest_bytes, json.loads(manifest_bytes)))
    monkeypatch.setattr(archive, "_add_url", lambda zf, arcname, *_args, expected_sha256=None, **_kwargs:
                        archive._add_bytes(zf, arcname, frame_bytes, expected_sha256=expected_sha256))
    output = tmp_path / "thermal-report.zip"
    archive.archive_report(report, output)
    with zipfile.ZipFile(output) as package:
        archived = json.loads(package.read("report.json"))
        archive_manifest = json.loads(package.read("archive-manifest.json"))
        entry = archive_manifest["results"]["thermal_validation"]
        assert archived["results"]["thermal_validation"]["reference"]["archive_status"] == "report_embedded"
        assert entry["status"] == "report_embedded"
        assert package.read("inputs/thermal-validation/thermal.csv") == csv_bytes
        assert package.read("results/thermal_validation/source-manifest.json") == manifest_bytes
        assert package.read(f"results/thermal_validation/{frame_id}.bin") == frame_bytes

    monkeypatch.setattr(verifier, "_read_url", lambda *_args, **_kwargs: (200, manifest_bytes))
    monkeypatch.setattr(verifier, "_check_hash", lambda label, url, expected, _timeout: {
        "artifact": label, "url": url, "status": "verified" if expected == frame_hash else "hash_mismatch",
    })
    check = verifier.verify(report)
    assert check["status"] == "verified"
    assert check["results"]["thermal_validation"]["observation_csv"]["status"] == "verified"

