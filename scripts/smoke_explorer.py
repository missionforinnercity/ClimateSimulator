"""Repeatable browser checks with offline API fixtures.

Run an application/static server first, then:
  .venv/bin/python scripts/smoke_explorer.py --url http://127.0.0.1:8011/app
Requires the optional Playwright package and its Chromium installation.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8011/app")
    parser.add_argument("--output", default="/tmp/conditions-smoke")
    parser.add_argument("--axe", help="Optional local axe.min.js for automated accessibility checks")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--use-angle=swiftshader"])
        for label, viewport, fallback in [
            ("desktop", {"width": 1440, "height": 900}, False),
            ("mobile", {"width": 390, "height": 844}, False),
            ("canvas", {"width": 1024, "height": 768}, True),
        ]:
            context = browser.new_context(viewport=viewport, reduced_motion="reduce", accept_downloads=True)
            if fallback:
                context.add_init_script("Object.defineProperty(window, 'WebGL2RenderingContext', {value: undefined});")
            page = context.new_page()
            # Software WebGL can briefly monopolise a constrained CI runner
            # while drawing the fallback city; interaction assertions should
            # not fail merely because the event loop needed another frame.
            page.set_default_timeout(30000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))

            def api_fixture(route):
                url = route.request.url
                if "/heat/zones" in url:
                    payload = {
                        "features": [], "count": 0, "metric": "pedestrian_priority_score",
                        "metric_label": "Intervention priority", "metric_metadata": {"unit": "/100", "decimals": 0, "kind": "score"},
                        "range": {"min": 0, "max": 100}, "color_range": {"min": 0, "max": 100},
                        "summary": {"area_weighted_mean": 0, "maximum": 0, "total_area_m2": 0},
                        "window": {"label": "Offline test fixture"}, "source": "offline smoke fixture", "scenario": {"minutes": 720},
                    }
                    route.fulfill(status=200, content_type="application/json", headers={"X-Request-ID": "smoke-heat"}, body=json.dumps(payload))
                else:
                    route.fulfill(status=503, content_type="application/json", body='{"detail":"Offline fixture: optional service unavailable"}')
            page.route("**/api/**", api_fixture)
            page.route("**/assets/cfd/**", lambda route: route.fulfill(status=503, body="Offline smoke: CFD unavailable"))
            print(f"Checking {label}: loading", flush=True)
            page.goto(args.url, wait_until="domcontentloaded")
            page.wait_for_function("() => !document.body.hasAttribute('aria-busy')", timeout=45000)
            page.locator(".explorer-guide").get_by_role("button", name="Dismiss guide").click()
            if args.axe:
                page.add_script_tag(path=args.axe)
            for tool in ["heat", "sun", "wind", "traffic", "transport", "tools"]:
                print(f"Checking {label}: {tool}", flush=True)
                page.locator(f'[data-menu-target="{tool}"]').click()
                assert page.locator(f"#menu-{tool}").is_visible()
                if tool != "tools":
                    assert page.locator(f"#menu-{tool} .evidence-limit").is_visible()
                if args.axe:
                    violations = page.evaluate("async () => (await axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v => ({id:v.id, impact:v.impact, nodes:v.nodes.map(n=>n.target)}))")
                    assert not [v for v in violations if v["impact"] in ["serious", "critical"]], (label, tool, violations)

            def camera_state():
                return page.evaluate("""() => new Promise(resolve => {
                  addEventListener('climate-scene-state', event => resolve(event.detail.camera), {once: true});
                  dispatchEvent(new CustomEvent('climate-capture-view'));
                })""")

            if label in ["desktop", "mobile"]:
                before_drag = camera_state()
                box = page.locator("#scene").bounding_box()
                start_x, start_y = box["x"] + 90, box["y"] + 90
                if label == "desktop":
                    page.mouse.move(start_x, start_y)
                    page.mouse.down()
                    page.mouse.move(start_x + 30, start_y + 20)
                    page.mouse.up()
                else:
                    for event_type, x, y in [
                        ("pointerdown", start_x, start_y),
                        ("pointermove", start_x + 30, start_y + 20),
                        ("pointerup", start_x + 30, start_y + 20),
                    ]:
                        page.locator("#scene").dispatch_event(event_type, {
                            "pointerType": "touch", "pointerId": 41, "isPrimary": True,
                            "button": 0, "buttons": 1 if event_type != "pointerup" else 0,
                            "clientX": x, "clientY": y,
                        })
                after_drag = camera_state()
                assert after_drag["azimuth"] > before_drag["azimuth"], (label, before_drag, after_drag)
                assert after_drag["elevation"] > before_drag["elevation"], (label, before_drag, after_drag)
            page.locator('[data-menu-target="tools"]').focus()
            page.keyboard.press("End")
            assert page.locator('[data-menu-target="transport"]').get_attribute("aria-selected") == "true"
            page.keyboard.press("Home")
            assert page.locator('[data-menu-target="tools"]').get_attribute("aria-selected") == "true"
            page.locator("#scene").focus()
            page.keyboard.press("ArrowLeft")
            page.keyboard.press("+")
            page.keyboard.press("Home")
            page.locator('[data-menu-target="sun"]').click()
            page.locator("#sun-generate").click()
            page.wait_for_timeout(300)
            page.locator(".scenario-workspace > summary").click()
            page.get_by_role("button", name="Save Before", exact=True).click()
            page.locator("#sun-date").fill("2026-09-01")
            page.locator("#sun-date").dispatch_event("change")
            page.get_by_role("button", name="Save After", exact=True).click()
            assert "sun-date" in page.locator(".scenario-comparison table").inner_text()
            with page.expect_download() as download:
                page.get_by_role("button", name="Export scenario JSON").click()
            exported = json.loads(Path(download.value.path()).read_text())
            assert exported["schema"] == "conditions-scenario/1"
            assert exported["manifest"]["version"] == 3
            assert exported["before"] and exported["after"]
            assert "transport-event-name" not in exported["settings"]["controls"]
            page.get_by_role("button", name="Restore Before", exact=True).click()
            assert page.locator("#sun-date").input_value() == exported["before"]["settings"]["controls"]["sun-date"]
            if label == "desktop":
                state = exported["after"]["settings"]
                shared = page.evaluate("async s => (await import('/scenarioState.js')).scenarioURL(location.href, s)", state)
                # The encoded scenario intentionally exercises a fresh document
                # navigation. Give slower CI/static-file servers enough time to
                # serve the full viewer shell before checking restored state.
                page.goto(shared, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_function("() => !document.body.hasAttribute('aria-busy')", timeout=45000)
                assert page.locator("#sun-date").input_value() == state["controls"]["sun-date"]
                assert page.locator('[data-menu-target="sun"]').get_attribute("aria-selected") == "true"
            metrics = page.evaluate("""() => ({
              viewerReadyMs: performance.getEntriesByName('climate-viewer-ready')[0]?.startTime,
              navigationMs: performance.getEntriesByType('navigation')[0].duration,
              encodedBytes: performance.getEntriesByType('resource').reduce((n, r) => n + r.encodedBodySize, 0),
              overflow: document.documentElement.scrollWidth > innerWidth,
              renderer: document.querySelector('#status').textContent
            })""")
            page.locator('[data-menu-target="heat"]').click()
            page.screenshot(path=str(output / f"{label}.png"), timeout=60000)
            assert not errors, errors
            assert not metrics["overflow"], metrics
            results.append({"profile": label, **metrics, "pageErrors": errors})
            context.close()

        # Reproduce a stale cached shell that predates #explorer-panel-body.
        # The enhanced controls must attach to the legacy .panel-body without
        # throwing and preventing the renderer from starting.
        context = browser.new_context(viewport={"width": 1024, "height": 768}, reduced_motion="reduce")
        page = context.new_page()
        legacy_errors = []
        page.on("pageerror", lambda error: legacy_errors.append(str(error)))

        def legacy_shell(route):
            response = route.fetch()
            body = response.body().decode("utf-8").replace('id="explorer-panel-body" ', "")
            route.fulfill(response=response, body=body)

        page.route("**/app/", legacy_shell)
        page.goto(f"{args.url.rstrip('/')}/", wait_until="domcontentloaded", timeout=60000)
        page.locator(".scenario-workspace").wait_for(timeout=15000)
        assert not legacy_errors, legacy_errors
        results.append({"profile": "legacy-shell", "pageErrors": legacy_errors})
        context.close()
        browser.close()
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
