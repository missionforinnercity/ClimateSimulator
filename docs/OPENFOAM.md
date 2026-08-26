# OpenFOAM urban-wind path

The Wind panel's **Direction** and **Comfort** lenses are both driven by
solved OpenFOAM volumes. There is no "layered preview" fallback in that panel
any more — the older fast, mass-conserving horizontal screening model has
been retired from it. It's still used elsewhere (the Canvas 2D compatibility
fallback, and the standalone `/api/wind/preview`, `/api/wind/comfort`,
`/api/wind/validate` API routes), just not to drive the WebGL wind UI. See
`README.md`'s "Wind explorer API" section for that split.

Running CFD on every browser click is still not a useful target: mesh
generation and convergence are offline jobs. The browser only samples compact
converted volumes checked into `public/assets/cfd/<case>/`.

## Solved cases today

| Direction | Sector | Case directory | Browser asset |
| --- | --- | --- | --- |
| 135° | SE | `data/openfoam/cases/cbd_se_full` | `public/assets/cfd/cbd_se_pilot/` |
| 315° | NW | `data/openfoam/cases/cbd_nw_full` | `public/assets/cfd/cbd_nw_full/` |

(The SE case's browser asset directory is still named `cbd_se_pilot` for
historical reasons — it holds the full-CBD result, not the original small
pilot domain. Name new case asset directories after their actual case.)

Both are full-CBD domains enclosing all 1,891 source building centroids: 2600
m analysis size, 24 m base grid refined locally, 220 m top, 300 m
lateral/upstream clearance and a 600 m downstream wake. Each is an
unvalidated steady k-epsilon RANS solve with a uniform 10 m/s neutral inlet —
proves geometry, meshing and solver integration; it is not yet the
atmospheric-boundary-layer configuration validated planning evidence needs.

The browser's `CFD_CASES` registry (`public/webglRenderer.js`) is the single
source of truth for which directions the UI will offer. Adding a case to
`data/openfoam/cases/` and converting it to `public/assets/cfd/` does nothing
until you also add a `{ direction_deg, sector, label, base }` entry there and
enable the matching compass button (remove `disabled`/`title` from its
`data-wind-direction` button in `public/app/index.html`).

## Generating a new direction

This is the exact sequence used for the NW case, end to end:

```bash
.venv/bin/python scripts/export_openfoam_case.py \
  --full-scene \
  --output data/openfoam/cases/cbd_<name>_full \
  --direction-deg <degrees> \
  --analysis-size-m 2600 \
  --base-cell-m 24 \
  --terrain-spacing-m 12 \
  --top-m 220

data/openfoam/cases/cbd_<name>_full/Allmesh   # ~6-7 min: surfaceCheck, blockMesh, snappyHexMesh, checkMesh
data/openfoam/cases/cbd_<name>_full/Allrun    # ~10 min: potentialFoam init, decomposePar, foamRun, reconstructPar
data/openfoam/cases/cbd_<name>_full/Allpost   # foamToVTK -latestTime

.venv/bin/python scripts/convert_openfoam_vtk.py \
  data/openfoam/cases/cbd_<name>_full/VTK/cbd_<name>_full_500.vtk \
  --output public/assets/cfd/cbd_<name>_full
```

Budget **~25-35 minutes** end to end on an 8-core/16GB machine; run it in the
background. Each generated runner sources `/opt/openfoam14/etc/bashrc`
itself, so an interactive shell doesn't need OpenFOAM configured in advance.
`Allmesh` cleans and rebuilds the mesh and requires the standard `checkMesh`
result to say `Mesh OK`; `Allrun` reuses the existing mesh and resumes from
the latest written time; `Allpost` exports the latest `U`, `p`, `k` and
`epsilon` fields to `VTK/`. The exhaustive `checkMesh` pass typically still
flags some low-quality decomposition faces, small-determinant cells and
concavity even when the standard check passes — full-CBD cases remain
exploratory visualisation cases, not certified meshes.

**`convert_openfoam_vtk.py` needs the `vtk` Python package** — it's in
`requirements-dev.txt` (`.venv/bin/pip install -r requirements-dev.txt`), not
`requirements.txt`, because it's only needed for this offline conversion
step, never at runtime.

The converter reads `case.json` (written beside the case by the export
script), rotates vector components back into viewer coordinates, samples a
regular 3D volume at the given `--spacing` (default 10×10×6 m — pass
explicit `--spacing` to match an existing case's resolution if you want
comparable file sizes; omitting it silently defaults to 10×10×6 regardless of
what an earlier case used), writes an explicit valid-fluid mask, and updates
the target `public/assets/cfd/<name>/` directory with `volume.json`,
`fields.f32` and `valid.u8`. This is a visualisation product, not a
substitute for the native mesh in engineering analysis.

```json
{
  "schema": "climate-explorer-cfd-volume/1",
  "solver": {"name": "OpenFOAM", "version": "14", "case_id": "cbd_nw_full"},
  "direction_deg_from": 315.0,
  "validation_status": "exploratory_unvalidated_pilot",
  "dimensions": [246, 260, 37],
  "spacing_foam_m": [10.0, 10.0, 6.1],
  "channels": ["u_viewer_x", "w_up", "v_viewer_z", "speed", "p", "k", "epsilon"],
  "fields": "fields.f32",
  "valid_mask": "valid.u8",
  "building_coverage": {"scene_buildings": 1891, "centroids_in_domain": 1891, "fraction": 1.0}
}
```

The browser reads coverage from this manifest and never colours buildings or
ground outside the solved volume — see the Direction/Pedestrian view's finer
(12 m, independent of the native ~10-20 m OpenFOAM grid) sampling grid in
`buildCfdPedestrianSurface`, which trilinearly interpolates between native
grid points so narrow streets between them aren't left as holes.

## What the browser does with it

- Coloured 3D flowlines, seeded and constrained inside a user-drawn,
  movable/resizable flow box (not the old fixed upstream curtain over the
  whole domain) with an adjustable seed height.
- Horizontal and vertical slice planes, draggable directly in the 3D scene
  along their own normal axis.
- Façade pressure and terrain-following pedestrian speed maps.
- Comfort statistics combining every *solved* direction with the ERA5 wind
  rose (`GET /api/wind/climatology/sectors`) — summed, never interpolated
  between directions that lack a solved case.

Not yet built: wake/recirculation inspection via vorticity or Q-criterion
exports, and before/after design comparisons (towers, podiums, screens).

## Guardrails

- Label volume results with solver, mesh, case, direction and validation
  status (the manifest already carries these; the panel surfaces them).
- Never interpolate between directional CFD cases for certification without
  a documented validation method — Comfort enforces this by construction
  (see `runComfortStudy` in `public/webglRenderer.js`).
- Keep thermal buoyancy as a separate later case. Coupled heat/moisture and
  urban wind are valuable, but substantially increase setup and validation
  scope.

## Trees

`--include-trees` on `export_openfoam_case.py` meshes mapped tree canopy
(`public/assets/canopy.json`, which carries per-crown crown-base/crown-top
height and footprint rings) as a porous `cellZone`, not a wall — air still
flows through it, but a Darcy-Forchheimer momentum sink is applied inside it:

```bash
.venv/bin/python scripts/export_openfoam_case.py \
  --full-scene \
  --output data/openfoam/cases/cbd_<name>_full \
  --direction-deg <degrees> \
  --analysis-size-m 2600 --base-cell-m 24 --terrain-spacing-m 12 --top-m 220 \
  --include-trees
```

Each crown becomes its own closed, capped prism between its mapped
crown-base and crown-top height (same construction as buildings), exported
to `constant/triSurface/trees.stl`. `snappyHexMeshDict`'s
`refinementSurfaces` picks it up with `cellZoneInside inside` and
`faceType internal` (no wall patch), and `constant/fvModels` applies an
isotropic `porosityForce`/`DarcyForchheimer` source over the resulting
`trees` cellZone: `d (0 0 0)`, `f = Cd·LAD` in all three axes. `Cd ≈ 0.2` and
`LAD ≈ 1.5 m²/m³` (`TREE_DRAG_COEFFICIENT` /
`TREE_LEAF_AREA_DENSITY_M2_PER_M3` in `export_openfoam_case.py`) are
standard street-tree values from urban-tree CFD literature (Gromke & Ruck;
Buccolieri et al.), not a measured value for any specific mapped crown —
tune them there if you have better local data.

This has been verified to generate valid dictionaries and a `surfaceCheck`-clean
geometry (~124k triangles across ~2,500 crowns for the current scene, only 6
non-manifold edges out of that — the same order of imperfection the existing
`buildings.stl` pipeline already tolerates) but **has not been meshed or
solved** — neither existing case (SE, NW) has been regenerated with it yet.
Budget the same ~25-35 minutes per direction as above when you do; both would
need a full remesh, not just a resolve, since the geometry changes.
