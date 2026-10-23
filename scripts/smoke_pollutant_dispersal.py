"""Exercise traffic-source pollutant tracing against a real CFD volume.

Run the application server first, then:
  .venv/bin/python scripts/smoke_pollutant_dispersal.py --url http://127.0.0.1:8011/app

Requires Playwright and Chromium. SUMO emissions are replaced with a fixed
fixture; road geometry and CFD fields are loaded from the real application.
"""
import argparse
import json
import os
import shutil
from playwright.sync_api import sync_playwright


TRAFFIC_FIXTURE = {
    "job_id": "pollutant-smoke-fixture",
    "status": "complete",
    "result": {
        "scenario": {"key": "am_peak", "label": "Pollutant smoke fixture"},
        "duration_min": 10,
        "seed": 240917,
        "departed_vehicle_count": 2,
        "traffic_demand": {"observed_count_calibration": False},
        "emissions": {"nox_g": 2.0, "pmx_g": 0.2},
        "road_emissions": [
            {"edge_id": "62324161#1", "road_name": "Adderley Street", "nox_g": 1.0, "pmx_g": 0.1},
            {"edge_id": "pollutant-smoke-boundary", "road_name": "CFD boundary test", "nox_g": 1.0, "pmx_g": 0.1},
        ],
    },
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8011/app")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        executable = os.environ.get("CHROME_BIN") or shutil.which("google-chrome") or shutil.which("chromium")
        browser = playwright.chromium.launch(
            headless=True, executable_path=executable, args=["--no-sandbox", "--use-angle=swiftshader"]
        )
        page = browser.new_page(viewport={"width": 1280, "height": 800}, reduced_motion="reduce")
        page.set_default_timeout(90_000)
        errors = []
        intercepted = {"roads": False, "emissions": False}
        page.on("pageerror", lambda error: errors.append(str(error)))

        def add_boundary_crossing_road(route):
            response = route.fetch()
            payload = response.json()
            payload["network_edges"].append({
                "id": "pollutant-smoke-boundary",
                "name": "CFD boundary test",
                "lane_count": 1,
                "points": [[1800, 0], [0, 0]],
                "snap_points": [[1800, 0], [0, 0]],
                "lane_points": None,
            })
            intercepted["roads"] = True
            route.fulfill(response=response, body=json.dumps(payload))

        def provide_traffic_fixture(route):
            intercepted["emissions"] = True
            route.fulfill(status=200, content_type="application/json", body=json.dumps(TRAFFIC_FIXTURE))

        page.route("**/api/traffic/roads", add_boundary_crossing_road)
        page.route("**/api/traffic/emissions-preview/jobs", provide_traffic_fixture)
        page.goto(args.url, wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_function("() => !document.body.hasAttribute('aria-busy')", timeout=90_000)
        page.evaluate("""() => {
          window.__pollutantSmokeResult = null;
          addEventListener('climate-analysis-result', event => {
            if (event.detail?.tool === 'wind') window.__pollutantSmokeResult = event.detail.metadata;
          });
        }""")
        page.locator('[data-menu-target="wind"]').click()
        page.locator('[data-wind-lens="pollution"]').click()
        page.locator("#pollution-direction").select_option("90")
        page.locator("#wind-simulate").click()
        page.wait_for_function("""() =>
          !document.querySelector('#pollution-results')?.hidden ||
          /unavailable/i.test(document.querySelector('#wind-status')?.textContent || '')
        """, timeout=300_000)

        status = page.locator("#wind-status").inner_text()
        results_text = page.locator("#pollution-results").inner_text()
        metadata = page.evaluate("window.__pollutantSmokeResult")
        accounting = metadata.get("traffic_source_accounting") if metadata else None
        assert "inside this CFD footprint" in status, status
        assert intercepted == {"roads": True, "emissions": True}, intercepted
        assert not errors, errors
        assert metadata and metadata["tracer_parcels"] == 420, metadata
        assert metadata["building_collision_steps"] > 0, metadata
        assert accounting, metadata
        assert abs(accounting["overall_nox_pmx_mass_g"] - 2.2) < 1e-9, accounting
        assert abs(accounting["mapped_road_mass_g"] - 2.2) < 1e-9, accounting
        assert 0 < accounting["valid_cfd_source_mass_g"] < accounting["mapped_road_mass_g"], accounting
        assert 0 < accounting["valid_cfd_source_fraction"] < 1, accounting
        assert abs(accounting["emission_window_s"] - 600) < 1e-9, accounting
        assert "Adderley Street" in results_text and "CFD boundary test" in results_text, results_text
        print(json.dumps({
            "status": status,
            "traffic_source_accounting": accounting,
            "escaped_parcels": metadata["escaped_parcels"],
            "building_collision_steps": metadata["building_collision_steps"],
            "page_errors": errors,
        }, indent=2))
        browser.close()


if __name__ == "__main__":
    main()
