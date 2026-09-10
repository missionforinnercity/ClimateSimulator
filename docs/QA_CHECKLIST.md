# Climate Explorer QA

## Automated commands

```bash
.venv/bin/python -m pytest -q
node --test tests/scenarioState.test.mjs tests/requestClient.test.mjs
.venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8011
# In another terminal; optional Playwright + Chromium required:
.venv/bin/python scripts/smoke_explorer.py --url http://127.0.0.1:8011/app
```

The browser smoke harness intercepts API requests and CFD downloads. It exercises failure handling without depending on live services, a database, SUMO simulations or a new CFD solve. It loads the real scene/transport assets. Screenshots go to `/tmp/climate-explorer-smoke` by default. Its narrow viewport is an emulation, not a physical-phone performance measurement.

New Python HTTP tests use an in-process ASGI client without application lifespan startup, so provider polling is not started. Existing domain tests remain authoritative for numerical behaviour. Do not weaken numerical tests to make UI changes pass.

## Release checks

- Load `/`, `/docs`, and `/app`; no missing required assets or JavaScript exceptions. An optional service failure should be explicit.
- Open all six panels. Confirm visible tab names, one selected tab and keyboard Left/Right/Home/End behaviour. Check the nested wind controls too.
- Dismiss and reopen the four-step guide. Verify its preference with storage disabled/private browsing.
- Focus the map; orbit with arrows, zoom with +/− and fit with Home. Repeat on Canvas fallback.
- Inspect all five evidence cards: method, dates/unknown dates, units, limits and use supported by the result. The lower-bound wind caveat stays visible.
- Heat: change date/time/metric rapidly under network throttling. Only the newest settings should appear. Check the empty fixture and failed-source states.
- Sun: generate shadows; then run ground/building sun hours, cancel, resize and retry. Verify result settings and units; never label this a certified daylight assessment.
- Wind: inspect solved directions, switch direction while loading, change to comfort, cancel, and inspect a missing volume. No old case should overwrite a newer choice. Comfort must retain solved-sector coverage.
- Traffic: draw a closure, run a paired comparison, edit it during a slow request, open/print its report, and verify original reliability gates. The new settings export must not imply it restores closure geometry.
- Transport: select a hub, run event access, close the result tray with Escape and return focus. Keep schedule/capacity assumptions visible. Do not call the vehicles live.
- Pick a location and pass it to sun/wind; verify the selected area and clipping. At a boundary, inspect actual model-domain placement rather than assuming the point is the entire result extent.
- Save Before, change a setting, save After; inspect changed and held-constant fields. Restore each. Export JSON and inspect manifest identifiers, timestamps and absence of event names/secrets.
- Open a shared link in a fresh tab. Try malformed/oversized JSON, unknown fields, invalid dates and out-of-range values. No automatic POST simulation should run.
- Force 401, 429, 503, an offline connection, and slow body delivery. Look for an actionable message; cancel must remain available while requests are pending.
- Remove a required asset / change manifest version in a disposable fixture. Verify a recoverable viewer error and health degradation. Do not damage the real generated assets.
- Test 390×844, desktop, 200% zoom, reduced motion and WebGL loss. Compare canvas/DOM summary; information must not depend on colour alone.
- Inspect focus in report dialogs and non-modal trays with a screen reader. Native dialog behaviour is retained; do not claim WCAG conformance from automated smoke checks alone.

## Performance recording

Record hardware, browser/version, renderer, viewport, device pixel ratio, server/proxy, network throttling, cold/warm cache and source release. Track `performance.getEntriesByName('climate-viewer-ready')`, resource encoded/decoded bytes, slow interactions, renderer draw calls and memory where supported. Compare like-for-like runs; navigation load time is not the same as scene readiness.

The original local desktop baseline loaded the shell in about 160 ms and had about 934 KB of encoded resource data at the observation point, with the model ready within the 12-second observation window. That single unthrottled software-browser sample is not a mobile/FPS benchmark. See implementation status for final measured checks and unresolved hardware validation.
