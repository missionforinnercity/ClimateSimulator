# Design edits and climate-result coupling

## Current behaviour

Design massing edits are an editable proposal. They do not imply that every
analysis layer has been rerun. The table below states what currently changes
when proposal geometry changes.

| Layer | Behaviour after a design edit | Evidence shown | Missing work |
| --- | --- | --- | --- |
| Rendered buildings and concept blocks | Rebuilt immediately in the viewer. | Edited geometry and proposal ID. | Surveyed/proposed-design approval remains external. |
| Current sun shadows and Viewshed | Recomputed from the edited geometry. Viewshed recalculates at its selected point. | Visual shadow and visibility result. | Shadows are not irradiance or energy. |
| Heat shade overlay | Updated as a geometry-based visual preview for the active heat time. | Added shade / shade removed overlay. | It does not rerun SUEWS/SOLWEIG, UTCI, or Tmrt. Surface-temperature inputs remain the fixed source baseline. |
| Wind wake preview | Draws a simplified wake footprint from the saved baseline directional field and proposal footprints. | Qualitative overlay on the map. | Not a numeric wind-speed result, CFD solve, annual comfort result, or safety assessment. Proposed-geometry cases must be meshed and solved offline. |
| Sun hours | The **Compare design sunlight** action runs matched baseline/proposal direct-sun studies for the selected date and time window. It reports paired ground-cell means, local change, surface summaries and a ground difference map. | `POST /api/sunlight/design-comparison`; response carries geometry hashes, analysis settings and both result summaries/rasters. `proposal_geometry_hash` is shared with the heat/shade screen for the same edit. | Clear-sky direct sun only; diffuse/reflected radiation is excluded. The result is local to the edited geometry buffer and is not a citywide energy assessment. |
| Heat/shade screening | The **Compare heat/shade screening** action runs the same mapped heat-zone calculation for baseline and proposal at the selected Heat date/time. It reports area-weighted shade-deficit and heat-priority-screen changes and adds the summary, per-zone before/after values, settings, source asset hashes and shared proposal geometry hash to the client report event. | `POST /api/heat/design-comparison`; response identifies proposal geometry, analysis ID, source heat-zone/building/canopy hashes, zone count, area and fixed-baseline method. Its `proposal_geometry_hash` matches the Sun comparison for the same edit. The report verifier reconciles zone values to the area-weighted KPIs; the archiver includes matching local inputs. | This is a screening KPI pair only: selected-time shade is recalculated, but the summer surface-temperature field is held fixed. It is not proposal UTCI, Tmrt, air temperature, or an SUEWS/SOLWEIG rerun. |
| Annual wind comfort | Remains unavailable for edited geometry. The app prevents a baseline-sector comfort result from being presented as proposal CFD. | Message requests multiple proposed-geometry direction solves. | Offline mesh/solve for enough directions, then rerun the same wind-rose/KPI method. |
| Pollutant dispersal | Remains on the baseline CFD geometry; the design wake overlay is not a dispersion rerun. | Baseline status and explicit design limitation. | Recompute the flow field and dispersion for proposal geometry. |
| UTCI/Tmrt and heat comfort KPIs | Stay on published baseline weather, geometry and model frames. | Baseline product and experimental status; the matched heat/shade screen is separately labeled and does not stand in for these fields. | A proposal-aware thermal run requires new surface/geometry preparation and offline SUEWS/SOLWEIG calculation. |
| Runoff, traffic and walking routes | Remain tied to their checked-in baseline geometry/network. | No proposal result is claimed. | Proposal-specific terrain/drainage or network edits and recalculation. |

## Matched Sun comparison workflow

1. Make or import a building edit, demolition, replacement or concept block.
2. Choose a date, local-time window, time step and building-surface resolution
   in Sun controls.
3. Select **Compare design sunlight** in Design. The backend calculates the
   unchanged baseline and proposal with the same settings and a shared local
   domain. Each geometry edit invalidates the prior comparison.
4. Review the baseline-to-proposal mean direct-sun hours, paired ground-cell
   difference map, changed local mean and method caveat together. This is one
   matched KPI pair, not a recommendation about which amount of sun is better.

## Matched heat/shade screening workflow

1. Make or import a building edit, demolition, replacement or concept block.
2. Choose the selected date and time in Heat controls.
3. Select **Compare heat/shade screening**. The backend evaluates baseline and
   proposal shade over the same heat-zone geometry and returns paired
   area-weighted shade-deficit and heat-priority-screen summaries. Editing the
   proposal invalidates the prior comparison.
4. Read the score with its fixed summer surface-temperature input and
   selected-time shade method. Lower shade deficit means more shade; the
   priority score is a screening rank, not a measured heat-risk outcome.

The client report retains the settings, geometry/source hashes, summary KPIs,
method caveat and per-zone before/after values. Source geometry slivers smaller
than 0.05 m² are excluded because they round to zero at the exported area
precision; their count is disclosed separately. The report archive includes
the embedded zone results and matching local input files when their hashes
match. Replaying still requires the matching code and environment. This does
not add proposal-aware UTCI/Tmrt.

## Cross-layer comparison status

Matched direct-sun and heat/shade-screen KPI pairs are now available as
separate, method-specific comparisons using the same proposal geometry hash.
The report can hold both result records, but there is no cross-layer dashboard
that aligns them into one combined KPI table. Wind, UTCI/Tmrt, pollution,
runoff, traffic and route layers must not be shown as proposal results merely
because the geometry is visible. A future coupled comparison needs a shared
proposal ID and geometry hash, matched forcing/time windows, per-layer result
references, per-layer recompute status, and an explicit offline-solve gate.
Keep each physical KPI visible with units; do not combine them into a single
normalized design score.
