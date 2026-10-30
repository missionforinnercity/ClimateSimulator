#!/usr/bin/env python3
"""Check whether a saved climate report's result references are still usable.

This verifies retrievable artifact identity; it does not rerun a simulation or
validate scientific accuracy. It only requests URLs on the report's own origin
unless --base-url explicitly redirects them to another deployment.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen


SCHEMA = "conditions-climate-report/1"
MAX_JSON_BYTES = 50 * 1024 * 1024


class VerificationError(ValueError):
    pass


class _EmbeddedReportParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.capturing = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "script" and dict(attrs).get("id") == "report-data":
            self.capturing = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self.capturing:
            self.capturing = False

    def handle_data(self, data: str) -> None:
        if self.capturing:
            self.parts.append(data)


def load_report_file(path: Path) -> dict[str, Any]:
    """Load either a JSON report or the data embedded in its HTML export."""
    contents = path.read_text(encoding="utf-8")
    try:
        report = json.loads(contents)
    except json.JSONDecodeError:
        parser = _EmbeddedReportParser()
        parser.feed(contents)
        if not parser.parts:
            raise VerificationError("file is neither a climate report JSON file nor an HTML report with embedded report data")
        try:
            report = json.loads("".join(parser.parts))
        except json.JSONDecodeError as error:
            raise VerificationError("embedded HTML report data is not valid JSON") from error
    if not isinstance(report, dict):
        raise VerificationError("climate report must contain a JSON object")
    return report


def _origin(value: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise VerificationError("origin must be an http(s) URL without embedded credentials")
    return parsed.scheme, parsed.hostname.lower(), parsed.port


def _url_for(value: str, report_origin: str, override_origin: str | None) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise VerificationError("artifact URL is not a valid credential-free http(s) URL")
    if _origin(value) != _origin(report_origin) and override_origin is None:
        raise VerificationError("artifact URL host does not match the report application origin")
    if override_origin:
        base = override_origin.rstrip("/") + "/"
        return urljoin(base, parsed.path.lstrip("/"))
    return value


def _read_url(url: str, *, timeout: float, max_bytes: int | None = None) -> tuple[int, bytes]:
    request = Request(url, headers={"User-Agent": "conditions-report-verifier/1", "Accept": "*/*"})
    with urlopen(request, timeout=timeout) as response:
        status = int(response.status)
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if max_bytes is not None and size > max_bytes:
                raise VerificationError(f"response exceeded the {max_bytes}-byte limit")
            chunks.append(chunk)
        return status, b"".join(chunks)


def _sha256_url(url: str, *, timeout: float) -> tuple[int, str, int]:
    request = Request(url, headers={"User-Agent": "conditions-report-verifier/1", "Accept": "application/octet-stream"})
    digest = hashlib.sha256()
    size = 0
    with urlopen(request, timeout=timeout) as response:
        status = int(response.status)
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return status, digest.hexdigest(), size


def _check_hash(label: str, url: str, expected: str | None, timeout: float) -> dict[str, Any]:
    if not expected:
        return {"artifact": label, "status": "missing_expected_hash", "url": url}
    status, actual, size = _sha256_url(url, timeout=timeout)
    return {
        "artifact": label, "status": "verified" if actual == expected else "hash_mismatch",
        "url": url, "http_status": status, "expected_sha256": expected,
        "actual_sha256": actual, "bytes": size,
    }


def _check_thermal_frame(reference: dict[str, Any], report_origin: str, override: str | None, timeout: float) -> dict[str, Any]:
    manifest_url = _url_for(str(reference.get("manifest_url", "")), report_origin, override)
    frame_url = _url_for(str(reference.get("url", "")), report_origin, override)
    _, manifest_bytes = _read_url(manifest_url, timeout=timeout, max_bytes=MAX_JSON_BYTES)
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    expected_manifest_hash = reference.get("manifest_sha256")
    manifest = json.loads(manifest_bytes)
    if manifest.get("run_id") != reference.get("run_id"):
        raise VerificationError("forecast run ID does not match the source manifest")
    frame_id = reference.get("frame_id")
    frame = next((item for item in manifest.get("frames", []) if item.get("id") == frame_id), None)
    if not frame:
        raise VerificationError("referenced forecast frame is not in the source manifest")
    if frame.get("sha256") != reference.get("frame_sha256"):
        raise VerificationError("report frame hash does not match the source manifest")
    frame_result = _check_hash("forecast-frame", frame_url, reference.get("frame_sha256"), timeout)
    return {
        "type": reference.get("type"),
        "status": "verified" if manifest_hash == expected_manifest_hash and frame_result["status"] == "verified" else "changed_or_unavailable",
        "manifest": {"url": manifest_url, "expected_sha256": expected_manifest_hash, "actual_sha256": manifest_hash},
        "artifacts": [frame_result],
    }


def _check_climatology(reference: dict[str, Any], report_origin: str, override: str | None, timeout: float) -> dict[str, Any]:
    manifest_url = _url_for(str(reference.get("manifest_url", "")), report_origin, override)
    _, manifest_bytes = _read_url(manifest_url, timeout=timeout, max_bytes=MAX_JSON_BYTES)
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    manifest = json.loads(manifest_bytes)
    frame_index = {item.get("id"): item for item in manifest.get("frames", [])}
    expected_manifest_hash = reference.get("manifest_sha256")
    checks = []
    for item in reference.get("source_frames", []):
        frame_id = item.get("id")
        source = frame_index.get(frame_id)
        if not source or source.get("sha256") != item.get("sha256"):
            checks.append({"artifact": frame_id, "status": "manifest_mismatch"})
            continue
        url = _url_for(str(item.get("url", "")), report_origin, override)
        checks.append(_check_hash(f"composite-frame:{frame_id}", url, item.get("sha256"), timeout))
    verified = manifest_hash == expected_manifest_hash and bool(checks) and all(x["status"] == "verified" for x in checks)
    return {
        "type": reference.get("type"), "status": "verified" if verified else "changed_or_unavailable",
        "manifest": {"url": manifest_url, "expected_sha256": expected_manifest_hash, "actual_sha256": manifest_hash},
        "artifacts": checks,
    }


def _check_openfoam(reference: dict[str, Any], report_origin: str, override: str | None, timeout: float) -> dict[str, Any]:
    manifest_url = _url_for(str(reference.get("manifest_url", "")), report_origin, override)
    _, manifest_bytes = _read_url(manifest_url, timeout=timeout, max_bytes=MAX_JSON_BYTES)
    manifest = json.loads(manifest_bytes)
    if manifest.get("solver", {}).get("case_id") != reference.get("case_id"):
        raise VerificationError("OpenFOAM case ID does not match the referenced volume manifest")
    expected_hashes = reference.get("asset_hashes") or {}
    manifest_hashes = manifest.get("asset_hashes") or {}
    checks = []
    for key, manifest_key in (("fields_sha256", "fields"), ("valid_mask_sha256", "valid_mask")):
        expected = expected_hashes.get(key)
        if not expected:
            checks.append({"artifact": key, "status": "missing_expected_hash"})
            continue
        if manifest_hashes.get(key) and manifest_hashes[key] != expected:
            checks.append({"artifact": key, "status": "manifest_hash_mismatch"})
            continue
        relative = manifest.get(manifest_key)
        if not relative:
            checks.append({"artifact": key, "status": "missing_manifest_path"})
            continue
        url = urljoin(manifest_url, str(relative))
        url = _url_for(url, report_origin, override)
        checks.append(_check_hash(key, url, expected, timeout))
    verified = bool(checks) and all(x["status"] == "verified" for x in checks)
    return {"type": reference.get("type"), "status": "verified" if verified else "changed_or_unavailable", "artifacts": checks}


def _check_design_geometry_reference(item: dict[str, Any], reference: dict[str, Any]) -> dict[str, Any]:
    """Check report-internal consistency for a design comparison (no retained raster)."""
    summary = item.get("summary") or {}
    scenario = summary.get("scenario") or {}
    geometry = scenario.get("proposal_geometry") or {}
    if scenario.get("design_geometry_hash") != reference.get("geometry_hash"):
        raise VerificationError("design reference hash differs from its report scenario")
    if reference.get("analysis_id") != summary.get("analysis_id"):
        raise VerificationError("design analysis ID differs between reference and summary")
    if not isinstance(geometry.get("remove_building_indexes"), list) or not isinstance(geometry.get("add_buildings"), list):
        raise VerificationError("design report is missing editable proposal geometry")
    additions = []
    for block in geometry["add_buildings"]:
        additions.append({
            "ground_m": float(block["ground_m"]),
            "base_offset_m": float(block.get("base_offset_m", 0)),
            "height_m": float(block["height_m"]),
            "ring": [[float(point[0]), float(point[1])] for point in block["ring"]],
            "holes": [[[float(point[0]), float(point[1])] for point in hole] for hole in block.get("holes", [])],
        })
    canonical = json.dumps({
        "remove_building_indexes": sorted(int(index) for index in geometry["remove_building_indexes"]),
        "add_buildings": additions,
    }, separators=(",", ":"), sort_keys=True)
    actual_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if actual_hash != reference.get("geometry_hash"):
        raise VerificationError("embedded proposal geometry does not match its design geometry hash")
    if scenario.get("date") is None or scenario.get("minutes") is None:
        raise VerificationError("design report is missing date/time settings")
    expected_assets = reference.get("asset_hashes")
    if expected_assets is not None and expected_assets != (summary.get("source_provenance") or {}).get("asset_hashes"):
        raise VerificationError("design source asset hashes differ between reference and report summary")
    result_data = item.get("result_data") or {}
    result_status = "settings_only"
    if reference.get("result_embedded_in_report"):
        points = result_data.get("zone_points")
        kpis = summary.get("kpis") or {}
        if not isinstance(points, list) or len(points) != int(kpis.get("zone_count", -1)):
            raise VerificationError("embedded design zone results do not match the reported zone count")
        area_sum = 0.0
        weighted: dict[str, tuple[float, float]] = {
            "shade_before": (0.0, 0.0), "shade_after": (0.0, 0.0),
            "priority_before": (0.0, 0.0), "priority_after": (0.0, 0.0),
        }
        for point in points:
            area = float(point["area_m2"])
            if not math.isfinite(area) or area <= 0:
                raise VerificationError("embedded design zone area must be finite and positive")
            area_sum += area
            for field, key in (("before", "shade_before"), ("after", "shade_after"),
                               ("priority_before", "priority_before"), ("priority_after", "priority_after")):
                value = point.get(field)
                if value is None:
                    continue
                numeric = float(value)
                if not math.isfinite(numeric) or not 0 <= numeric <= 100:
                    raise VerificationError(f"embedded design zone {field} must be between 0 and 100")
                total, weight = weighted[key]
                weighted[key] = (total + numeric * area, weight + area)
        if abs(area_sum - float(kpis.get("analysis_area_m2", -1))) > 3.0:
            raise VerificationError("embedded zone area does not match the design report KPI")
        expected_fields = {
            "shade_before": "mean_shade_deficit_before_pct",
            "shade_after": "mean_shade_deficit_after_pct",
            "priority_before": "mean_heat_priority_score_before_0_100",
            "priority_after": "mean_heat_priority_score_after_0_100",
        }
        for key, field in expected_fields.items():
            total, weight = weighted[key]
            if not weight or abs(total / weight - float(kpis[field])) > 0.03:
                raise VerificationError(f"embedded zone data does not reproduce {field}")
        for before_key, after_key, change_key in (
            ("mean_shade_deficit_before_pct", "mean_shade_deficit_after_pct", "change_mean_shade_deficit_percentage_points"),
            ("mean_heat_priority_score_before_0_100", "mean_heat_priority_score_after_0_100", "change_mean_heat_priority_score"),
        ):
            if abs((float(kpis[after_key]) - float(kpis[before_key])) - float(kpis[change_key])) > 0.011:
                raise VerificationError(f"design KPI change does not reconcile for {change_key}")
        result_status = "embedded_result_consistent"
    return {
        "type": reference.get("type"), "status": result_status,
        "consistency": "verified", "geometry_hash": actual_hash,
        "asset_hashes": expected_assets,
        "result_data": "embedded and summary-consistent" if result_status == "embedded_result_consistent" else "not retained",
        "detail": "Report geometry, source identities and embedded zone results are internally consistent. This does not rerun the calculation or establish scientific accuracy.",
    }


def _check_thermal_observation_validation(
    item: dict[str, Any], reference: dict[str, Any], report_origin: str,
    override: str | None, timeout: float,
) -> dict[str, Any]:
    validation = item.get("result_data") or {}
    if not isinstance(validation, dict):
        raise VerificationError("embedded thermal observation result is malformed")
    if validation.get("schema") != "conditions-thermal-observation-validation/1":
        raise VerificationError("embedded thermal observation result is missing or incompatible")
    if validation.get("run_id") != reference.get("run_id"):
        raise VerificationError("thermal validation run ID does not match its result reference")
    provenance = validation.get("provenance") or {}
    if not isinstance(provenance, dict):
        raise VerificationError("thermal validation provenance is malformed")
    source_input = validation.get("source_input") or {}
    if not isinstance(source_input, dict):
        raise VerificationError("embedded thermal validation CSV source is malformed")
    if source_input.get("format") != "base64":
        raise VerificationError("embedded thermal validation lacks its original CSV bytes")
    try:
        source_bytes = base64.b64decode(str(source_input.get("data", "")), validate=True)
    except (ValueError, TypeError) as error:
        raise VerificationError("embedded thermal observation CSV is not valid base64") from error
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    expected_source_hash = reference.get("observations_sha256")
    if not expected_source_hash or source_hash != expected_source_hash:
        raise VerificationError("embedded thermal observation CSV hash does not match the scored input")
    if provenance.get("observations_sha256") != expected_source_hash:
        raise VerificationError("thermal validation provenance differs from its typed reference")
    manifest_url = _url_for(str(reference.get("manifest_url", "")), report_origin, override)
    _, manifest_bytes = _read_url(manifest_url, timeout=timeout, max_bytes=MAX_JSON_BYTES)
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    if manifest_hash != reference.get("manifest_sha256") or manifest_hash != provenance.get("manifest_sha256"):
        raise VerificationError("thermal source manifest hash does not match the scored run")
    manifest = json.loads(manifest_bytes)
    if manifest.get("run_id") != reference.get("run_id"):
        raise VerificationError("thermal run ID differs from the source manifest")
    source_frame_rows = reference.get("source_frames", [])
    pairs = validation.get("pairs", [])
    if not isinstance(source_frame_rows, list) or not isinstance(pairs, list):
        raise VerificationError("thermal validation frame or pair data is malformed")
    source_frames = {str(row.get("id")): row for row in source_frame_rows if isinstance(row, dict)}
    frame_index = {str(row.get("id")): row for row in manifest.get("frames", [])}
    used_frame_ids = {str(pair.get("frame_id")) for pair in pairs if isinstance(pair, dict)}
    if not used_frame_ids or used_frame_ids != set(source_frames):
        raise VerificationError("thermal validation frame references do not match the paired observations")
    frame_checks = []
    for frame_id, frame_ref in source_frames.items():
        source_frame = frame_index.get(frame_id)
        if not source_frame or source_frame.get("sha256") != frame_ref.get("sha256"):
            raise VerificationError(f"thermal frame {frame_id} differs from its source manifest")
        if provenance.get("frame_sha256_by_id", {}).get(frame_id) != frame_ref.get("sha256"):
            raise VerificationError(f"thermal frame {frame_id} differs from the validation provenance")
        frame_url = _url_for(str(frame_ref.get("url", "")), report_origin, override)
        frame_checks.append(_check_hash(f"thermal-validation-frame:{frame_id}", frame_url, frame_ref.get("sha256"), timeout))

    metric_names = ("air_temp_2m_c", "relative_humidity_pct", "tmrt_c", "wind_10m_mps", "utci_c")
    recomputed: dict[str, dict[str, float | None]] = {}
    for metric in metric_names:
        values = [
            float(pair["model_minus_observed"][metric])
            for pair in pairs
            if isinstance(pair, dict)
            if pair.get("model_minus_observed", {}).get(metric) is not None
        ]
        if values:
            recomputed[metric] = {
                "bias": round(sum(values) / len(values), 3),
                "mae": round(sum(abs(value) for value in values) / len(values), 3),
                "rmse": round(math.sqrt(sum(value * value for value in values) / len(values)), 3),
            }
        else:
            recomputed[metric] = {"bias": None, "mae": None, "rmse": None}
    if recomputed != validation.get("metrics_model_minus_observed"):
        raise VerificationError("embedded thermal residuals do not reconcile with their summary metrics")
    return {
        "type": reference.get("type"), "status": "verified" if all(row["status"] == "verified" for row in frame_checks) else "changed_or_unavailable",
        "observation_csv": {"expected_sha256": expected_source_hash, "actual_sha256": source_hash, "status": "verified"},
        "manifest": {"url": manifest_url, "expected_sha256": reference.get("manifest_sha256"), "actual_sha256": manifest_hash},
        "artifacts": frame_checks,
        "result_data": "paired rows, residuals and summary metrics reconcile; scientific accuracy is not established",
    }


def verify(report: dict[str, Any], *, override: str | None = None, timeout: float = 20.0) -> dict[str, Any]:
    if report.get("schema") != SCHEMA:
        raise VerificationError(f"expected report schema {SCHEMA}")
    origin = str(report.get("application", {}).get("origin", ""))
    _origin(origin)
    if override:
        _origin(override)
    results = {}
    for name, item in (report.get("results") or {}).items():
        reference = item.get("reference") or {}
        kind = reference.get("type")
        try:
            if kind == "thermal-frame":
                result = _check_thermal_frame(reference, origin, override, timeout)
            elif kind == "thermal-climatology-composite":
                result = _check_climatology(reference, origin, override, timeout)
            elif kind == "thermal-observation-validation":
                result = _check_thermal_observation_validation(item, reference, origin, override, timeout)
            elif kind == "openfoam-volume":
                result = _check_openfoam(reference, origin, override, timeout)
            elif kind == "traffic-job":
                url = _url_for(str(reference.get("url", "")), origin, override)
                status, body = _read_url(url, timeout=timeout, max_bytes=MAX_JSON_BYTES)
                payload = json.loads(body)
                result = {"type": kind, "status": "retrievable" if status == 200 else "unavailable", "http_status": status,
                          "job_status": payload.get("status")}
            elif kind in {"design-heat-shade-screen", "design-sunlight-comparison"}:
                result = _check_design_geometry_reference(item, reference)
            elif kind in {"sunlight-analysis", "session-result"}:
                result = {"type": kind, "status": "settings_only", "detail": "No retained result artifact is available to hash."}
            else:
                result = {"type": kind, "status": "unknown_reference"}
        except (HTTPError, URLError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, VerificationError) as error:
            result = {"type": kind, "status": "unavailable_or_invalid", "detail": str(error)}
        results[name] = result
    statuses = [item.get("status") for item in results.values()]
    return {
        "schema": "conditions-report-reference-verification/1",
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "report_generated_at": report.get("generatedAt"),
        "results": results,
        "status": "verified" if statuses and all(status == "verified" for status in statuses) else "incomplete_or_changed",
        "limitations": "Reference verification checks availability and hashes; it does not rerun simulations or establish scientific accuracy.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="conditions-climate-report/1 JSON file or generated HTML report")
    parser.add_argument("--base-url", help="redirect report artifact paths to another deployment origin")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        report = load_report_file(args.report)
        output = verify(report, override=args.base_url, timeout=args.timeout)
    except (OSError, json.JSONDecodeError, VerificationError, ValueError) as error:
        print(json.dumps({"status": "invalid_report", "detail": str(error)}, indent=2), file=sys.stderr)
        return 2
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0 if output["status"] == "verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
