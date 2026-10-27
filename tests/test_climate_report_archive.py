from __future__ import annotations

import hashlib
import json
from pathlib import Path
import zipfile

from scripts.archive_climate_report import archive_report


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def test_archive_embeds_openfoam_validation_and_matching_source_inputs(tmp_path):
    case_id = "cbd_n_full"
    cfd_dir = PROJECT_ROOT / "public" / "assets" / "cfd" / case_id
    source_files = {
        "volume_manifest_sha256": cfd_dir / "volume.json",
        "fields_sha256": cfd_dir / "fields.f32",
        "valid_mask_sha256": cfd_dir / "valid.u8",
    }
    supporting_files = {
        "terrain_dem_sha256": PROJECT_ROOT / "data/derived/company_gardens_hybrid_dem_2m.tif",
        "scene_manifest_sha256": PROJECT_ROOT / "public/assets/manifest.json",
    }
    reference = {
        "type": "openfoam-observation-validation", "case_id": case_id,
        "asset_hashes": {key: _sha256(path) for key, path in source_files.items()},
        "supporting_asset_hashes": {key: _sha256(path) for key, path in supporting_files.items()},
        "observation_payload_sha256": "normalized-input-hash",
    }
    report = {
        "schema": "conditions-climate-report/1", "generatedAt": "2026-10-27T12:00:00Z",
        "project": {"name": "fixture"}, "application": {"origin": "https://example.test"},
        "results": {"wind_validation": {
            "reference": reference, "summary": {"validation_status": "holdout_scored_not_validated"},
            "result_data": {
                "schema": "conditions-openfoam-observation-validation/1", "pairs": [],
                "source_input": {"filename": "campaign.csv", "format": "csv", "text": "id,speed_mps\nfixture,1\n"},
            },
        }},
    }
    output = tmp_path / "climate-report.zip"

    archive_report(report, output)

    with zipfile.ZipFile(output) as archive:
        archived_report = json.loads(archive.read("report.json"))
        artifact_manifest = json.loads(archive.read("archive-manifest.json"))
        assert archived_report["results"]["wind_validation"]["reference"]["archive_status"] == "report_embedded"
        assert archived_report["results"]["wind_validation"]["result_data"]["source_input"]["text"].startswith("id,speed_mps")
        result = artifact_manifest["results"]["wind_validation"]
        assert result["status"] == "report_embedded"
        assert result["source_inputs_status"] == "archived"
        for artifact in result["artifacts"]:
            assert hashlib.sha256(archive.read(artifact["path"])).hexdigest() == artifact["sha256"]

