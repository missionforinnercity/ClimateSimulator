"""Browser checks for Place Inspector search and invalid map picks.

Run an application/static server first, then:
  .venv/bin/python scripts/smoke_place_inspector.py --url http://127.0.0.1:8011/app
Requires Playwright and Chromium; set CHROME_BIN to use a system Chrome build.
"""
import argparse
import os
import shutil

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8011/app")
    args = parser.parse_args()
    with sync_playwright() as p:
        executable = os.environ.get("CHROME_BIN") or shutil.which("google-chrome") or shutil.which("chromium")
        browser = p.chromium.launch(headless=True, executable_path=executable, args=["--no-sandbox", "--use-angle=swiftshader"])
        context = browser.new_context(viewport={"width": 1024, "height": 768}, reduced_motion="reduce")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/api/**", lambda route: route.fulfill(status=503, content_type="application/json", body='{"detail":"Offline inspector check"}'))
        page.route("**/assets/cfd/**", lambda route: route.fulfill(status=503, body="Offline inspector check"))
        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_function("() => !document.body.hasAttribute('aria-busy')", timeout=45000)
        page.locator(".explorer-guide").get_by_role("button", name="Dismiss guide").click()
        page.locator("#menu-tools .place-inspector-disclosure > summary").click()

        page.locator("#place-inspector-pick").click()
        page.evaluate("dispatchEvent(new CustomEvent('climate-place-inspector-picked', {detail: {}}))")
        assert "outside the mapped terrain" in page.locator("#place-inspector-status").inner_text()
        assert page.locator("#place-inspector-pick").get_attribute("aria-pressed") == "false"

        search = page.locator("#place-search")
        search.fill("Adderley")
        page.locator("#place-search-results").wait_for(state="visible")
        results = page.locator("#place-search-results button")
        assert results.count() > 0
        search.press("ArrowDown")
        assert page.evaluate("document.activeElement === document.querySelector('#place-search-results button')")
        page.keyboard.press("End")
        assert page.evaluate("document.activeElement === document.querySelector('#place-search-results [role=listitem]:last-child button')")
        page.keyboard.press("Home")
        page.keyboard.press("Enter")
        assert page.locator("#place-inspector-card").is_visible()
        assert not errors, errors
        print("WebGL: search keyboard and empty map-pick checks passed")
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
