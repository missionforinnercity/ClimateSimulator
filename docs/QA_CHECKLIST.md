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

The browser smoke harness intercepts API requests and CFD downloads. It exercises failure handling without depending on live services, a database, SUMO simulations or a new CFD solve. It loads the real scene assets, including the ambient timetable vehicle data. Screenshots go to `/tmp/conditions-smoke` by default. Its narrow viewport is an emulation, not a physical-phone performance measurement.

The pollutant smoke test uses real road geometry, building geometry and a real directional CFD volume while substituting a fixed traffic-emissions response. It checks road-source clipping at the CFD boundary, swept building collisions, and source-accounting metadata; it does not validate the emissions model or ambient concentration.

New Python HTTP tests use an in-process ASGI client without application lifespan startup, so provider polling is not started. Existing domain tests remain authoritative for numerical behaviour. Do not weaken numerical tests to make UI changes pass.

## Release checks

- Load `/`, `/docs`, and `/app`; no missing required assets or JavaScript exceptions. An optional service failure should be explicit.
- Open all seven panels. Confirm visible tab names, one selected tab and keyboard Left/Right/Home/End behaviour. Check the nested wind controls too.
- Dismiss and reopen the four-step guide. Verify its preference with storage disabled/private browsing.
- Focus the map; orbit with arrows, zoom with +/− and fit with Home. Confirm a browser without WebGL 2 receives the capability warning.
- At the full-city WebGL overview and neighborhood-scale place focus, confirm the scene settles without a continuous traffic render loop; zoom to very close street scale and confirm ambient traffic resumes.
- Start on Tools: heat-zone data should not load until the Heat tab is selected; opening Heat should load the selected metric once.
- Start on Tools in WebGL: traffic roads, live traffic and calibration data should stay unloaded until Traffic is selected; leaving Traffic should stop failed road-network retries until the panel is reopened.
- Start on Tools in WebGL: the saved CFD proposal registry should stay unloaded until Wind is selected; opening Wind should initialize the proposal selector from the registry, with the empty-state label when no proposals are saved.
- Start on Tools in WebGL: confirm municipal light posts appear at street-scale after the scene's idle load, stay distance-culled at district scale, and do not cast shadows; confirm lamp glow and road washes are added in Sun after sunset, including the inferred-height caveat.
- Start on Tools in WebGL: ambient timetable-derived buses and trains should be visible without a transport tab, and the walking graph should load only when Walking is selected.
- With a published thermal surface, select Heat → Sky-view factor (SVF). Confirm the static map, summary and point inspector use the cached 2 m SVF grid without starting another weather/SOLWEIG run.
- Heat → Seasonal UTCI: compare month, season and annual KPI scopes. The cold/no-thermal-stress/heat area-time shares should sum to about 100% (allowing display rounding), all expected monthly-hour frames must be present, and equivalent hours must be labelled as composite estimates. The UTCI map remains available. Near-live UTCI should show selected-hour area shares and must not invent period-hours from one frame.
- Confirm the simplified scene reaches ready before `roof_surface.bin` is requested; wait for the detailed roof count in the status line after it loads.
- Tools → Map layers: toggle mapped cycleways in WebGL. Confirm the highlight follows only dedicated cycleway links, unmatched-end markers align with the summary, and the OSM coverage/safety caveat remains visible.
- Start on Tools: public-realm points should stay unloaded until enabled; confirm the 107 mapped amenities, 381 pedestrian crossings and 3,328 parking spaces appear with counts. Crossing and parking details should reduce at broad views; retain the inferred bay-dimension caveat.
- In WebGL, zoom to Riebeek Square: confirm the mapped asphalt parking and paved islands replace the broad square fill cleanly, with no crosshatched ground; confirm parking-aisle ribbons sit above those surfaces and cars remain in their bays.
- Tools → Place inspector: search a street by name and a building by OSM ID; confirm the map highlight, source/unknown tags, map-pick mode and Sun/Wind location handoff.
- Tools → Place inspector: use ArrowDown/ArrowUp/Home/End and Enter from search results, Escape to dismiss results, and verify duplicate names or missing IDs can be distinguished by ID and mapped centre.
- Run `scripts/smoke_place_inspector.py` to check keyboard search and empty/out-of-terrain picks; run `node --test tests/placeInspector.test.mjs` for duplicate names, missing IDs and distant points.
- Start on Tools without opening Place inspector: confirm search-feature indexing is deferred; then focus search and pick mode to confirm the index builds once and both workflows remain responsive.
- Inspect each evidence card: method, dates/unknown dates, units, limits and use supported by the result. Wind limits remain in its Method & limitations disclosure.
- Heat: change date/time/metric rapidly under network throttling. Only the newest settings should appear. Check the empty fixture and failed-source states.
- Sun: generate shadows; then run ground/building sun hours, cancel, resize and retry. Verify result settings and units; never label this a certified daylight assessment.
- Wind: inspect solved directions, switch direction while loading, change to comfort, cancel, and inspect a missing volume. No old case should overwrite a newer choice. Comfort must retain solved-sector coverage.
- Wind → Comfort: switch between Lawson-LDDC-style screening and Davenport 1972 mean-speed criteria. Confirm the category thresholds change, incomplete Lawson GEM is disabled, provenance states averaging and gust treatment, and a saved scenario/print report retains the selected criterion ID and version.
- Wind/thermal scorer fixtures: run `pytest tests/test_validation_scorers.py`; confirm normalized wind-observation, CFD, terrain and scene hashes; thermal CSV/frame/manifest hashes; supplied sensor metadata; component comparison basis; and the permanent `not_validated` scoring labels. These synthetic fixtures test plumbing only.
- Heat → Attach thermal validation to report: import a scorer JSON and matching CSV, confirm a changed CSV hash is rejected, and confirm the exact CSV bytes, paired frames, manifest and validation JSON appear in the report archive with matching hashes.
- Design: add, move, modify and remove proposal geometry. Confirm the coupling disclosure distinguishes live geometry/shadows/Viewshed, qualitative baseline-wind wake, matched direct-sun comparison, matched heat/shade screening, and baseline-only layers. Run **Compare design sunlight** and **Compare heat/shade screening**; verify both baseline/proposal pairs use identical settings and return the same `proposal_geometry_hash` for the same edit, geometry edits invalidate the prior status, the heat report retains typed reference/hash/proposal geometry/KPIs/source hashes and per-zone values, sub-0.05 m² fragments are counted as exclusions, and the verifier reconciles zone-area-weighted KPIs. Neither result may be represented as proposal UTCI/Tmrt or CFD.
- Traffic: draw a closure, run a paired comparison, edit it during a slow request, open/print its report, and verify original reliability gates. The new settings export must not imply it restores closure geometry.
- Transit simulation: confirm buses and trains move through the scene from their checked-in schedules. Do not call the positions live or confirmed arrivals.
- Climate report: choose **Draw square area** and drag on mapped ground. Confirm a square outline appears and the camera zooms and centres on it. Generate the HTML report and confirm the captured map shows the selected square, then draw a second square and confirm its bounds replace the first.
- Generate an area report and confirm it automatically runs heat, sunlight, viewshed and wind within the selected square. Heat and sunlight charts use clipped surface zones; the viewshed chart counts ground samples inside the square; the wind chart uses valid solved cells inside it. Each category has a plain-language finding, readable values, method and evidence limits. Confirm unavailable analyses are described without substituting earlier results, and no results from another area appear. Confirm map capture failures are explained, the report prints, no raw code blocks or unexplained identifiers appear, and no token or raw CFD/traffic arrays are shown.
- Run `scripts/verify_climate_report.py` on the generated HTML report. Confirm available thermal and OpenFOAM artifacts verify by hash, expired traffic results and settings-only sunlight references are reported distinctly, and unavailable or changed sources make verification non-passing.
- Run `scripts/archive_climate_report.py` on the generated HTML report while its artifacts remain available. Confirm the ZIP contains the readable report, embedded report data, archive manifest, retrievable result files and matching local heat/shade and CFD/terrain/scene inputs; recompute packaged SHA-256 values; confirm sunlight remains settings-only and unavailable traffic is disclosed without including partial or mismatched files.
- Open a shared link in a fresh tab. Try malformed/oversized JSON, unknown fields, invalid dates and out-of-range values. No automatic POST simulation should run.
- Force 401, 429, 503, an offline connection, and slow body delivery. Look for an actionable message; cancel must remain available while requests are pending.
- Remove a required asset / change manifest version in a disposable fixture. Verify a recoverable viewer error and health degradation. Do not damage the real generated assets.
- Test 390×844, desktop, 200% zoom, reduced motion and WebGL loss. Compare canvas/DOM summary; information must not depend on colour alone.
- Inspect focus in report dialogs and non-modal trays with a screen reader. Native dialog behaviour is retained; do not claim WCAG conformance from automated smoke checks alone.

## Performance recording

Record hardware, browser/version, renderer, viewport, device pixel ratio, server/proxy, network throttling, cold/warm cache and source release. Track `performance.getEntriesByName('climate-viewer-ready')`, resource encoded/decoded bytes, slow interactions, renderer draw calls and memory where supported. Compare like-for-like runs; navigation load time is not the same as scene readiness.

The original local desktop baseline loaded the shell in about 160 ms and had about 934 KB of encoded resource data at the observation point, with the model ready within the 12-second observation window. That single unthrottled software-browser sample is not a mobile/FPS benchmark; collect current measurements using the recording fields above before making performance claims.
