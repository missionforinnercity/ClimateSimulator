#!/usr/bin/env python3
"""Exercise the thermal-validation import and report export with a synthetic fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil

from playwright.sync_api import sync_playwright


def run(url: str) -> dict[str, object]:
    csv_bytes = b"id,site_name,observed_at\nfixture-1,fixture,2026-10-27T10:00:00Z\n"
    csv_hash = hashlib.sha256(csv_bytes).hexdigest()
    metrics = {key: {"bias": 0.0, "mae": 0.0, "rmse": 0.0} for key in (
        "air_temp_2m_c", "relative_humidity_pct", "tmrt_c", "wind_10m_mps", "utci_c",
    )}
    residuals = {key: 0.0 for key in metrics}
    report = {
        "schema": "conditions-thermal-observation-validation/1", "run_id": "thermal_fixture",
        "validation_status": "holdout_scored_not_validated", "paired_count": 1,
        "excluded_count": 0, "counts_by_split": {"calibration": 0, "holdout": 1},
        "metrics_model_minus_observed": metrics,
        "metrics_by_split": {"calibration": {}, "holdout": {}},
        "provenance": {
            "observations_sha256": csv_hash, "manifest_sha256": "manifest-fixture-hash",
            "model_versions": {"solweig": {"version": "fixture"}},
            "utci_implementation": {"package": "pythermalcomfort", "version": "fixture"},
            "frame_sha256_by_id": {"frame-1": "frame-fixture-hash"},
        },
        "pairs": [{
            "id": "fixture-1", "split": "holdout", "split_group": "site:fixture",
            "frame_id": "frame-1", "frame_at": "2026-10-27T10:00:00Z",
            "frame_sha256": "frame-fixture-hash", "model_minus_observed": residuals,
        }],
        "excluded": [],
    }
    console_errors: list[str] = []
    with sync_playwright() as playwright:
        executable = os.environ.get("CHROME_BIN") or shutil.which("google-chrome") or shutil.which("chromium")
        browser = playwright.chromium.launch(
            headless=True, executable_path=executable,
            args=["--no-sandbox", "--use-angle=swiftshader"],
        )
        page = browser.new_page(accept_downloads=True, viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: console_errors.append(str(error)))
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("() => !document.body.hasAttribute('aria-busy')", timeout=60000)
        page.locator('[data-menu-target="heat"]').click()
        page.locator(".thermal-validation-import > summary").click()
        page.locator("#thermal-validation-result-file").set_input_files({
            "name": "thermal-validation.json", "mimeType": "application/json",
            "buffer": json.dumps(report).encode(),
        })
        page.locator("#thermal-validation-source-file").set_input_files({
            "name": "thermal-observations.csv", "mimeType": "text/csv", "buffer": csv_bytes,
        })
        page.locator("#thermal-validation-attach").click()
        page.get_by_text("Attached 1 paired rows", exact=False).wait_for(timeout=10000)
        page.get_by_text("Scenario · save, compare & share", exact=True).click()
        with page.expect_download(timeout=15000) as download_info:
            page.get_by_role("button", name="Export climate report", exact=True).click()
        report_file = Path(download_info.value.path())
        exported = json.loads(report_file.read_text(encoding="utf-8"))
        item = exported["results"]["thermal_validation"]
        assert item["reference"]["type"] == "thermal-observation-validation"
        assert item["reference"]["observations_sha256"] == csv_hash
        assert item["result_data"]["pairs"][0]["id"] == "fixture-1"
        assert item["result_data"]["source_input"]["sha256"] == csv_hash
        assert not console_errors, console_errors
        result = {"status": "passed", "paired_rows": 1, "page_errors": console_errors,
                  "report_bytes": report_file.stat().st_size}
        browser.close()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8011/app")
    args = parser.parse_args()
    print(json.dumps(run(args.url), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
