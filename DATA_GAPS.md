# Building model data gaps

The current scene has a good analytical starting point but is not yet a
reality mesh or a LoD2 city model.

## Present

- 2D building footprints with persistent `fid`/`OBJECTID` values.
- `BLD_HGT` for 7,522 of 7,693 source features.
- Photogrammetry acquisition method and acquisition period.
- 2 m LiDAR DTM and a 1 m surface/height raster.
- Local projected CRS: Hartbeesthoek94 Lo19.

## Missing for better building models

- Roof type and roof breaklines: flat, gabled, hipped, sawtooth, parapets,
  dormers, and roof elevations.
- Building parts and vertical subdivisions: podiums, towers, setbacks, and
  separate roof surfaces.
- Façade observations or calibrated imagery for windows, doors, balconies,
  materials, and colour.
- A current authoritative building release. Most footprints are from 2013,
  so change detection against 2025/26 imagery or survey data is needed.
- Floors, use, year built, heritage status, and a confidence/quality flag.
- A vertical datum statement for the building heights and DTM, plus survey
  control points to quantify horizontal and vertical error.
- Textured aerial/oblique imagery or a selected-area photogrammetry/reality
  mesh for the visual version.

## Recommended acquisition order

1. Obtain current municipal building footprints and roof attributes, retaining
   the supplied `fid`/`OBJECTID` as crosswalks where possible.
2. Use the supplied normalised height surface for visible roof relief, then
   derive clean roof planes and breaklines from classified LiDAR point clouds
   or dense stereo where formal LoD2 geometry is required.
3. Add oblique imagery/reality mesh only for priority streets or buildings.
4. Record source date, CRS, vertical datum, LOD, error tolerance, and licence
   on every generated asset.

The first colour mode in the viewer is therefore elevation-based. It is useful
for reading massing and height, but it is deliberately not labelled as façade
or land-use colour until those attributes exist.
