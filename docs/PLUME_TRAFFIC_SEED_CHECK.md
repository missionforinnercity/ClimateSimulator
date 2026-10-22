# Traffic source seed check, 21 October 2026

The road-source plume UI now keeps each parcel's SUMO edge ID, totals its
unblurred near-ground residence in a selected receiving area, and shares one
numeric colour scale across traffic runs of the same pollutant. The test in
`tests/plumeAttribution.test.mjs` checks that source totals reconcile with
receiving-area grid totals in a controlled example. A live receiving-area plume
comparison across seeds remains to be checked in the browser.

To check the traffic input independently, I ran the local
`traffic_emissions_preview` model for three seeds with the same synthetic
morning-peak profile, 10-minute sample, and demand multiplier 1.0. The network
was `data/sumo/cbd.net.xml` (SHA-256
`e8f6edd753629ed0795216e177de0b213dfa1b7ee7b523476d98c33a58af213e`),
`server/traffic.py` was SHA-256
`1838b1df26aa2fea4ab7645ef7673232e9dcdc043108e3b2b23f9ecd5df2ef8e`,
and local Eclipse SUMO was 1.27.1. No `data/traffic_calibration.json` was
present. These are **road-emission source totals**, not plume residence or
measured air quality.

| Seed | Inserted vehicles | SUMO HBEFA3 NOx | Top five emitting SUMO edge IDs, descending |
| --- | ---: | ---: | --- |
| 240917 | 500 | 960.720 g | `424327328#1`, `740418303#1`, `424060456#1`, `424327328#0`, `134294075#0` |
| 240918 | 497 | 914.265 g | `13856291#0`, `738348348#1`, `740418303#1`, `134294075#0`, `740406402#0` |
| 240919 | 497 | 712.489 g | `148126292#1`, `424060456#1`, `134294075#0`, `423711289#2`, `738037798#0` |

Only `134294075#0` appears in all three top-five **emission** lists. A live
browser check then used those three real SUMO results in one session and traced
each through the same SE 135° OpenFOAM case to a click-selected 100 m receiving
area near Riebeek Street. The traffic profile remained the synthetic AM peak,
10-minute sample and demand multiplier 1.0. The legend cutoffs stayed at
0.746, 2.94 and 7.48 g·s per grid cell across all three runs.

| Seed | Area residence | Source total | Accounting difference | Top-three edge IDs and road names (unordered) |
| --- | ---: | ---: | ---: | --- |
| 240917 | 420.8 g·s | 420.8 g·s | +0.0000021 g·s | `696714145#0` Buitengracht Street; `5216618#0` Somerset Road; `740406394#0` Buitengracht Street |
| 240918 | 909.8 g·s | 909.8 g·s | −0.000013 g·s | `696714145#0` Buitengracht Street; `5216618#0` Somerset Road; `740406394#0` Buitengracht Street |
| 240919 | 461.4 g·s | 461.4 g·s | +0.0000037 g·s | `696714145#0` Buitengracht Street; `696714144#1` Buitengracht Street; `742269234` Buitengracht Street |

`696714145#0` appeared in the top three for all three seeds; `5216618#0` and
`740406394#0` appeared in two of three. Total residence changed substantially
with seed, so the interface reports each seed and treats the repeated top-road
appearance as a stability check, not statistical confidence. The clicked area
was preserved across the runs in the same browser session. Its exact viewer-
local centre is now shown beside the result for future reproduction.

These results complete the roadmap's exploratory source-attribution slice.
They remain relative tracer residence, not ambient concentration or personal
dose. Rerun SUMO when a proposed change alters traffic routing.
