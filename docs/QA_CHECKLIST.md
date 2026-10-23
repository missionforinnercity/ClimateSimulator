# Conditions QA

## Automated commands

```bash
.venv/bin/python -m pytest -q
node --test tests/scenarioState.test.mjs tests/requestClient.test.mjs
.venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8011
# In another terminal; optional Playwright + Chromium required:
.venv/bin/python scripts/smoke_explorer.py --url http://127.0.0.1:8011/app
.venv/bin/python scripts/smoke_place_inspector.py --url http://127.0.0.1:8011/app
.venv/bin/python scripts/smoke_pollutant_dispersal.py --url http://127.0.0.1:8011/app
```

The browser smoke harness intercepts API requests and CFD downloads. It exercises failure handling without depending on live services, a database, SUMO simulations or a new CFD solve. It loads the real scene/transport assets. Screenshots go to `/tmp/conditions-smoke` by default. Its narrow viewport is an emulation, not a physical-phone performance measurement.

The pollutant smoke test uses real road geometry, building geometry and a real directional CFD volume while substituting a fixed traffic-emissions response. It checks road-source clipping at the CFD boundary, swept building collisions, and source-accounting metadata; it does not validate the emissions model or ambient concentration.

New Python HTTP tests use an in-process ASGI client without application lifespan startup, so provider polling is not started. Existing domain tests remain authoritative for numerical behaviour. Do not weaken numerical tests to make UI changes pass.

## Release checks

- Load `/`, `/docs`, and `/app`; no missing required assets or JavaScript exceptions. An optional service failure should be explicit.
- Open all six panels. Confirm visible tab names, one selected tab and keyboard Left/Right/Home/End behaviour. Check the nested wind controls too.
- Dismiss and reopen the four-step guide. Verify its preference with storage disabled/private browsing.
- Focus the map; orbit with arrows, zoom with +/− and fit with Home. Repeat on Canvas fallback.
- At the full-city WebGL overview and neighborhood-scale place focus, confirm the scene settles without a continuous traffic render loop; zoom to very close street scale and confirm ambient traffic resumes.
- Start on Tools in WebGL and Canvas: heat-zone data should not load until the Heat tab is selected; opening Heat should load the selected metric once.
- Start on Tools in WebGL: traffic roads, live traffic and calibration data should stay unloaded until Traffic is selected; leaving Traffic should stop failed road-network retries until the panel is reopened.
- Start on Tools in WebGL: the saved CFD proposal registry should stay unloaded until Wind is selected; opening Wind should initialize the proposal selector from the registry, with the empty-state label when no proposals are saved.
- Start on Tools in WebGL: confirm municipal light posts appear at street-scale after the scene's idle load, stay distance-culled at district scale, and do not cast shadows; confirm lamp glow and road washes are added in Sun after sunset, including the inferred-height caveat.
- Start on Tools in WebGL: the walking graph should not load with the ambient transport layer; select a venue in Transport and confirm its catchment graph loads once, then adjust catchment radius without rerunning shortest paths.
- With a published thermal surface, select Heat → Sky-view factor (SVF). Confirm the static map, summary and point inspector use the cached 2 m SVF grid without starting another weather/SOLWEIG run.
- Confirm the simplified scene reaches ready before `roof_surface.bin` is requested; wait for the detailed roof count in the status line after it loads.
- Tools → Map layers: toggle the mapped surface inventory in WebGL and Canvas. Confirm the paved, vegetated and water colors match the area summary, mapped coverage is explicit, and unmapped ground remains unknown.
- Tools → Map layers: toggle mapped cycleways in WebGL and Canvas. Confirm the highlight follows only dedicated cycleway links, unmatched-end markers align with the summary, and the OSM coverage/safety caveat remains visible.
- Tools → Map layers: toggle terrain-only runoff concentration in WebGL and Canvas. Confirm flow cells appear only after enabling the layer, the 25 mm gross volume is about 13,249 m³, the rainfall slider scales it linearly, and the terrain/drainage limitations remain visible.
- Start on Tools in WebGL and Canvas: public-realm points should stay unloaded until enabled; confirm the 107 mapped amenities, 381 pedestrian crossings and 3,328 parking spaces appear with counts. Crossing and parking details should reduce at broad views; retain the inferred bay-dimension caveat.
- In WebGL, zoom to Riebeek Square: confirm the mapped asphalt parking and paved islands replace the broad square fill cleanly, with no crosshatched ground; confirm parking-aisle ribbons sit above those surfaces and cars remain in their bays.
- Tools → Place inspector: search a street by name and a building by OSM ID in both renderers; confirm the map highlight, source/unknown tags, map-pick mode and Sun/Wind location handoff.
- Tools → Place inspector: use ArrowDown/ArrowUp/Home/End and Enter from search results, Escape to dismiss results, and verify duplicate names or missing IDs can be distinguished by ID and mapped centre.
- Run `scripts/smoke_place_inspector.py` to check keyboard search and empty/out-of-terrain picks in both WebGL and Canvas; run `node --test tests/placeInspector.test.mjs` for duplicate names, missing IDs and distant points.
- Start on Tools without opening Place inspector: confirm search-feature indexing is deferred; then focus search and pick mode to confirm the index builds once and both workflows remain responsive.
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
