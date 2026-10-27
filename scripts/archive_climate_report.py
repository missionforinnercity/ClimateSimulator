#!/usr/bin/env python3
"""Archive an exported climate report and every currently retrievable result.

The ZIP keeps the editable report/settings and copies retained thermal frames,
OpenFOAM fields/mask, completed traffic job results, and matching local source
assets for design heat/shade screening. Every copied artifact is hash-checked.
Heat/shade zone values are embedded in report JSON; analyses without retained
result data (such as sunlight rasters and generic session results) remain
explicitly settings-only.

This preserves result evidence; it does not rerun models or establish accuracy.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen
import zipfile

try:
    from .verify_climate_report import MAX_JSON_BYTES, VerificationError, _origin, _read_url, _url_for
except ImportError:  # supports direct execution as ``python scripts/archive_climate_report.py``
    from verify_climate_report import MAX_JSON_BYTES, VerificationError, _origin, _read_url, _url_for


SCHEMA = "conditions-climate-report/1"
CHUNK = 1024 * 1024


class ArchiveError(ValueError):
    pass


def _json_asset(url: str, origin: str, override: str | None, timeout: float) -> tuple[str, bytes, dict[str, Any]]:
    resolved = _url_for(url, origin, override)
    _, body = _read_url(resolved, timeout=timeout, max_bytes=MAX_JSON_BYTES)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise ArchiveError(f"expected JSON at {resolved}") from error
    return resolved, body, payload


def _add_bytes(archive: zipfile.ZipFile, arcname: str, body: bytes, *, expected_sha256: str | None = None) -> dict[str, Any]:
    actual = hashlib.sha256(body).hexdigest()
    if expected_sha256 and actual != expected_sha256:
        raise ArchiveError(f"SHA-256 mismatch for {arcname}: expected {expected_sha256}, received {actual}")
    archive.writestr(arcname, body)
    return {"path": arcname, "sha256": actual, "bytes": len(body)}


def _add_url(
    archive: zipfile.ZipFile, arcname: str, url: str, *, origin: str,
    override: str | None, timeout: float, max_total_bytes: int, already_added: int,
    expected_sha256: str | None = None,
) -> dict[str, Any]:
    resolved = _url_for(url, origin, override)
    request = Request(resolved, headers={"User-Agent": "conditions-report-archiver/1", "Accept": "*/*"})
    digest = hashlib.sha256()
    size = 0
    info = zipfile.ZipInfo(arcname)
    info.compress_type = zipfile.ZIP_DEFLATED
    with tempfile.TemporaryFile() as staged:
        with urlopen(request, timeout=timeout) as response:
            if response.status < 200 or response.status >= 300:
                raise ArchiveError(f"artifact request failed with HTTP {response.status}: {resolved}")
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if already_added + size > max_total_bytes:
                    raise ArchiveError(f"archive would exceed the {max_total_bytes}-byte artifact limit")
                digest.update(chunk)
                staged.write(chunk)
        actual = digest.hexdigest()
        if expected_sha256 and actual != expected_sha256:
            raise ArchiveError(f"SHA-256 mismatch for {arcname}: expected {expected_sha256}, received {actual}")
        staged.seek(0)
        with archive.open(info, "w") as target:
            while True:
                chunk = staged.read(CHUNK)
                if not chunk:
                    break
                target.write(chunk)
    return {"path": arcname, "source_url": resolved, "sha256": actual, "bytes": size}


def archive_report(
    report: dict[str, Any], output: Path, *, override: str | None = None,
    html_path: Path | None = None, timeout: float = 30.0,
    max_total_bytes: int = 2 * 1024 * 1024 * 1024,
) -> dict[str, Any]:
    if report.get("schema") != SCHEMA:
        raise ArchiveError(f"expected report schema {SCHEMA}")
    origin = str(report.get("application", {}).get("origin", ""))
    _origin(origin)
    if override:
        _origin(override)

    archived_report = json.loads(json.dumps(report))
    artifact_manifest: dict[str, Any] = {
        "schema": "conditions-climate-report-archive/1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_report_generated_at": report.get("generatedAt"),
        "artifacts": [],
        "results": {},
        "limitations": "Archive files preserve available results; settings-only entries require rerunning against matching model/assets.",
    }
    total_bytes = 0
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(output.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary_output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for tool, item in (archived_report.get("results") or {}).items():
                reference = item.get("reference") or {}
                kind = reference.get("type")
                paths: list[dict[str, Any]] = []
                status = "settings_only"
                root = f"results/{tool}"
                try:
                    if kind == "thermal-frame":
                        manifest_url, body, manifest = _json_asset(str(reference["manifest_url"]), origin, override, timeout)
                        manifest_artifact = _add_bytes(archive, f"{root}/source-manifest.json", body,
                                                       expected_sha256=reference.get("manifest_sha256"))
                        total_bytes += manifest_artifact["bytes"]
                        paths.append(manifest_artifact)
                        frame = next((frame for frame in manifest.get("frames", []) if frame.get("id") == reference.get("frame_id")), None)
                        if not frame or frame.get("sha256") != reference.get("frame_sha256"):
                            raise ArchiveError("forecast frame/hash is not present in the source manifest")
                        frame_artifact = _add_url(
                            archive, f"{root}/{reference['frame_id']}.bin", str(reference["url"]),
                            origin=origin, override=override, timeout=timeout,
                            max_total_bytes=max_total_bytes, already_added=total_bytes,
                            expected_sha256=reference.get("frame_sha256"),
                        )
                        total_bytes += frame_artifact["bytes"]
                        paths.append(frame_artifact)
                        status = "archived"
                    elif kind == "thermal-climatology-composite":
                        _, body, manifest = _json_asset(str(reference["manifest_url"]), origin, override, timeout)
                        manifest_artifact = _add_bytes(archive, f"{root}/source-manifest.json", body,
                                                       expected_sha256=reference.get("manifest_sha256"))
                        total_bytes += manifest_artifact["bytes"]
                        paths.append(manifest_artifact)
                        frame_index = {frame.get("id"): frame for frame in manifest.get("frames", [])}
                        for frame_ref in reference.get("source_frames", []):
                            source = frame_index.get(frame_ref.get("id"))
                            if not source or source.get("sha256") != frame_ref.get("sha256"):
                                raise ArchiveError(f"composite frame {frame_ref.get('id')} differs from its manifest")
                            frame_artifact = _add_url(
                                archive, f"{root}/{frame_ref['id']}.bin", str(frame_ref["url"]),
                                origin=origin, override=override, timeout=timeout,
                                max_total_bytes=max_total_bytes, already_added=total_bytes,
                                expected_sha256=frame_ref.get("sha256"),
                            )
                            total_bytes += frame_artifact["bytes"]
                            paths.append(frame_artifact)
                        status = "archived" if reference.get("source_frames") else "settings_only"
                    elif kind == "openfoam-volume":
                        manifest_url, body, manifest = _json_asset(str(reference["manifest_url"]), origin, override, timeout)
                        if manifest.get("solver", {}).get("case_id") != reference.get("case_id"):
                            raise ArchiveError("OpenFOAM case ID does not match its volume manifest")
                        manifest_artifact = _add_bytes(archive, f"{root}/volume.json", body)
                        total_bytes += manifest_artifact["bytes"]
                        paths.append(manifest_artifact)
                        for key, asset_name in (("fields_sha256", manifest.get("fields")),
                                                ("valid_mask_sha256", manifest.get("valid_mask"))):
                            expected = (reference.get("asset_hashes") or {}).get(key)
                            manifest_hash = (manifest.get("asset_hashes") or {}).get(key)
                            if not asset_name or not expected or (manifest_hash and manifest_hash != expected):
                                raise ArchiveError(f"OpenFOAM {key} is missing or inconsistent")
                            asset_url = urljoin(manifest_url, str(asset_name))
                            artifact = _add_url(
                                archive, f"{root}/{Path(str(asset_name)).name}", asset_url,
                                origin=origin, override=override, timeout=timeout,
                                max_total_bytes=max_total_bytes, already_added=total_bytes,
                                expected_sha256=expected,
                            )
                            total_bytes += artifact["bytes"]
                            paths.append(artifact)
                        status = "archived"
                    elif kind == "thermal-observation-validation":
                        result_data = item.get("result_data") or {}
                        if not isinstance(result_data, dict) or result_data.get("schema") != "conditions-thermal-observation-validation/1":
                            raise ArchiveError("thermal validation result data is missing from the report")
                        source_input = result_data.get("source_input") or {}
                        if not isinstance(source_input, dict) or source_input.get("format") != "base64":
                            raise ArchiveError("thermal validation report is missing its original CSV bytes")
                        source_bytes = base64.b64decode(str(source_input.get("data", "")), validate=True)
                        source_hash = str(reference.get("observations_sha256") or "")
                        if not source_hash:
                            raise ArchiveError("thermal validation is missing its observation hash")
                        if total_bytes + len(source_bytes) > max_total_bytes:
                            raise ArchiveError(f"archive would exceed the {max_total_bytes}-byte artifact limit")
                        source_filename = Path(str(source_input.get("filename") or "observations.csv")).name
                        source_filename = source_filename.replace("\\", "/").split("/")[-1]
                        source_artifact = _add_bytes(
                            archive, f"inputs/thermal-validation/{source_filename}",
                            source_bytes, expected_sha256=source_hash,
                        )
                        total_bytes += source_artifact["bytes"]
                        paths.append(source_artifact)
                        manifest_url, manifest_bytes, source_manifest = _json_asset(
                            str(reference["manifest_url"]), origin, override, timeout,
                        )
                        manifest_artifact = _add_bytes(
                            archive, f"{root}/source-manifest.json", manifest_bytes,
                            expected_sha256=reference.get("manifest_sha256"),
                        )
                        total_bytes += manifest_artifact["bytes"]
                        paths.append(manifest_artifact)
                        if source_manifest.get("run_id") != reference.get("run_id"):
                            raise ArchiveError("thermal run ID differs from its source manifest")
                        frame_index = {frame.get("id"): frame for frame in source_manifest.get("frames", [])}
                        for frame_ref in reference.get("source_frames", []):
                            source_frame = frame_index.get(frame_ref.get("id"))
                            if not source_frame or source_frame.get("sha256") != frame_ref.get("sha256"):
                                raise ArchiveError(f"thermal frame {frame_ref.get('id')} differs from its source manifest")
                            artifact = _add_url(
                                archive, f"{root}/{frame_ref['id']}.bin", str(frame_ref["url"]),
                                origin=origin, override=override, timeout=timeout,
                                max_total_bytes=max_total_bytes, already_added=total_bytes,
                                expected_sha256=frame_ref.get("sha256"),
                            )
                            total_bytes += artifact["bytes"]
                            paths.append(artifact)
                        reference["archive_note"] = (
                            "The exact observation CSV, paired residuals, validation metrics, run manifest and every sampled thermal frame are included when their hashes match. The archive does not rerun SOLWEIG/SUEWS."
                        )
                        artifact_manifest["results"][tool] = {
                            "status": "report_embedded", "result_payload": "report.json",
                            "source_inputs_status": "archived" if paths else "unavailable",
                            "artifacts": paths,
                        }
                        artifact_manifest["artifacts"].extend(paths)
                        reference["archive_status"] = "report_embedded"
                        reference["archive_paths"] = [entry["path"] for entry in paths]
                        continue
                    elif kind == "traffic-job":
                        url = _url_for(str(reference["url"]), origin, override)
                        _, body = _read_url(url, timeout=timeout, max_bytes=max_total_bytes)
                        payload = json.loads(body)
                        if payload.get("status") != "complete" or not isinstance(payload.get("result"), dict):
                            raise ArchiveError("traffic result is no longer complete or retrievable")
                        artifact = _add_bytes(archive, f"{root}/job-result.json", body)
                        total_bytes += artifact["bytes"]
                        paths.append({**artifact, "source_url": url})
                        status = "archived"
                    elif kind == "openfoam-observation-validation":
                        case_id = str(reference.get("case_id") or "")
                        if not case_id or Path(case_id).name != case_id or not all(
                            character.isalnum() or character in "_-" for character in case_id
                        ):
                            raise ArchiveError("OpenFOAM validation reference has an invalid case ID")
                        result_data = item.get("result_data") or {}
                        if not isinstance(result_data, dict):
                            raise ArchiveError("OpenFOAM validation result data is malformed")
                        if result_data.get("schema") != "conditions-openfoam-observation-validation/1":
                            raise ArchiveError("OpenFOAM validation result data is missing from the report")
                        source_input = result_data.get("source_input") or {}
                        if not isinstance(source_input, dict):
                            source_input = {}
                        if isinstance(source_input.get("text"), str):
                            extension = "json" if source_input.get("format") == "json" else "csv"
                            filename = Path(str(source_input.get("filename") or f"observations.{extension}")).name
                            filename = filename.replace("\\", "/").split("/")[-1]
                            if Path(filename).suffix.lower() not in {".csv", ".json"}:
                                filename = f"observations.{extension}"
                            artifact = _add_bytes(
                                archive, f"inputs/wind-validation/{filename}",
                                source_input["text"].encode("utf-8"),
                            )
                            total_bytes += artifact["bytes"]
                            paths.append(artifact)
                        cfd_root = Path(__file__).resolve().parents[1] / "public" / "assets" / "cfd" / case_id
                        cfd_files = {
                            "volume_manifest_sha256": cfd_root / "volume.json",
                            "fields_sha256": cfd_root / "fields.f32",
                            "valid_mask_sha256": cfd_root / "valid.u8",
                        }
                        expected_cfd = reference.get("asset_hashes") or {}
                        for key, local_path in cfd_files.items():
                            expected = expected_cfd.get(key)
                            if not expected or not local_path.is_file():
                                continue
                            body = local_path.read_bytes()
                            if total_bytes + len(body) > max_total_bytes:
                                raise ArchiveError(f"archive would exceed the {max_total_bytes}-byte artifact limit")
                            artifact = _add_bytes(
                                archive, f"inputs/wind-validation/{case_id}/{local_path.name}",
                                body, expected_sha256=expected,
                            )
                            total_bytes += artifact["bytes"]
                            paths.append(artifact)
                        supporting_files = {
                            "terrain_dem_sha256": Path("data/derived/company_gardens_hybrid_dem_2m.tif"),
                            "scene_manifest_sha256": Path("public/assets/manifest.json"),
                        }
                        expected_support = reference.get("supporting_asset_hashes") or {}
                        for key, relative_path in supporting_files.items():
                            expected = expected_support.get(key)
                            local_path = Path(__file__).resolve().parents[1] / relative_path
                            if not expected or not local_path.is_file():
                                continue
                            body = local_path.read_bytes()
                            if total_bytes + len(body) > max_total_bytes:
                                raise ArchiveError(f"archive would exceed the {max_total_bytes}-byte artifact limit")
                            artifact = _add_bytes(
                                archive, f"inputs/wind-validation/{local_path.name}",
                                body, expected_sha256=expected,
                            )
                            total_bytes += artifact["bytes"]
                            paths.append(artifact)
                        required_count = 1 + len(cfd_files) + len(supporting_files)
                        source_status = "archived" if len(paths) == required_count else "partial" if paths else "unavailable"
                        reference["archive_note"] = (
                            "Scored rows and residuals are embedded in report.json; the imported observation source and matching local CFD/terrain/scene inputs are packaged when available."
                        )
                        artifact_manifest["results"][tool] = {
                            "status": "report_embedded", "result_payload": "report.json",
                            "source_inputs_status": source_status,
                            "artifacts": paths,
                        }
                        artifact_manifest["artifacts"].extend(paths)
                        reference["archive_status"] = "report_embedded"
                        reference["archive_paths"] = [entry["path"] for entry in paths]
                        continue
                    elif kind == "design-heat-shade-screen":
                        provenance = item.get("summary", {}).get("source_provenance") or {}
                        source_hashes = (reference.get("asset_hashes")
                                         or provenance.get("asset_hashes") or {})
                        heat_name = str(provenance.get("heat_zone_source") or "")
                        local_sources = {
                            "heat_zones_sha256": Path("data/raw") / Path(heat_name).name,
                            "scene_buildings_sha256": Path("public/assets/fallback.json"),
                            "canopy_sha256": Path("public/assets/canopy.json"),
                        }
                        expected_sources = {key: value for key, value in source_hashes.items() if value}
                        archived_sources = 0
                        for key, relative_path in local_sources.items():
                            expected = expected_sources.get(key)
                            if not expected:
                                continue
                            if key == "heat_zones_sha256" and (not heat_name or Path(heat_name).name != heat_name):
                                continue
                            local_path = Path(__file__).resolve().parents[1] / relative_path
                            if not local_path.is_file():
                                continue
                            body = local_path.read_bytes()
                            if total_bytes + len(body) > max_total_bytes:
                                raise ArchiveError(f"archive would exceed the {max_total_bytes}-byte artifact limit")
                            artifact = _add_bytes(
                                archive, f"inputs/design-heat/{local_path.name}", body,
                                expected_sha256=expected,
                            )
                            total_bytes += artifact["bytes"]
                            paths.append(artifact)
                            archived_sources += 1
                        complete_sources = (
                            all(source_hashes.get(key) for key in local_sources)
                            and archived_sources == len(local_sources)
                        )
                        source_status = "archived" if complete_sources else "partial" if archived_sources else "unavailable"
                        reference["archive_note"] = (
                            "Summary KPIs, per-zone before/after results, and proposal geometry/settings are embedded in report.json. Matching local source inputs are packaged separately."
                        )
                        artifact_manifest["results"][tool] = {
                            "status": "report_embedded", "result_payload": "report.json",
                            "source_inputs_status": source_status,
                            "artifacts": paths,
                        }
                        artifact_manifest["artifacts"].extend(paths)
                        reference["archive_status"] = "report_embedded"
                        reference["archive_paths"] = [entry["path"] for entry in paths]
                        continue
                    else:
                        reference["archive_status"] = "settings_only"
                        reference["archive_note"] = "No result artifact is retained for this analysis; settings and typed reference remain in the report."
                except (HTTPError, URLError, OSError, KeyError, TypeError, ValueError, VerificationError, ArchiveError) as error:
                    status = "unavailable"
                    reference["archive_error"] = str(error)
                reference["archive_status"] = status
                reference["archive_paths"] = [item["path"] for item in paths]
                artifact_manifest["results"][tool] = {"status": status, "artifacts": paths}
                artifact_manifest["artifacts"].extend(paths)

            archived_report["archive"] = {
                "schema": artifact_manifest["schema"],
                "manifest_path": "archive-manifest.json",
                "artifact_bytes": total_bytes,
            }
            archive.writestr("report.json", json.dumps(archived_report, indent=2, sort_keys=True))
            archive.writestr("archive-manifest.json", json.dumps(artifact_manifest, indent=2, sort_keys=True))
            archive.writestr(
                "README.txt",
                "This archive contains a climate report and the result artifacts that were retrievable when it was created.\n"
                "Use report.json for editable scenario settings and typed references. Use archive-manifest.json and\n"
                "the per-file SHA-256 values to check packaged artifacts. Settings-only analyses need rerunning\n"
                "against matching model and asset versions; matched heat/shade source inputs may be under inputs/design-heat.\n"
                "The archive does not prove scientific accuracy.\n",
            )
            if html_path:
                if not html_path.is_file():
                    raise ArchiveError(f"HTML report does not exist: {html_path}")
                archive.write(html_path, "report.html")
        os.replace(temporary_output, output)
    except Exception:
        temporary_output.unlink(missing_ok=True)
        raise
    return artifact_manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="conditions-climate-report/1 JSON file")
    parser.add_argument("--output", type=Path, help="ZIP path (defaults to <report>.archive.zip)")
    parser.add_argument("--html", type=Path, help="optional matching printable HTML report to include")
    parser.add_argument("--base-url", help="redirect report artifact paths to another deployment origin")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--max-artifact-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    args = parser.parse_args()
    if args.timeout <= 0 or args.max_artifact_bytes <= 0:
        parser.error("timeout and max-artifact-bytes must be positive")
    output = args.output or args.report.with_suffix(".archive.zip")
    try:
        report = json.loads(args.report.read_text(encoding="utf-8"))
        manifest = archive_report(
            report, output, override=args.base_url, html_path=args.html,
            timeout=args.timeout, max_total_bytes=args.max_artifact_bytes,
        )
    except (OSError, json.JSONDecodeError, VerificationError, ArchiveError, ValueError) as error:
        print(json.dumps({"status": "archive_failed", "detail": str(error)}, indent=2), file=sys.stderr)
        return 2
    print(json.dumps({"status": "archived", "output": str(output), "results": manifest["results"],
                      "artifact_bytes": sum(item["bytes"] for item in manifest["artifacts"])}, indent=2, sort_keys=True))
    return 0 if all(value["status"] != "unavailable" for value in manifest["results"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
