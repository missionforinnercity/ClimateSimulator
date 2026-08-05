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

## Newly integrated municipal street data

The local `data/street_data` delivery is now part of the semantic build. It
adds stable municipal road keys and detailed road attributes, public lighting,
monuments, public toilets, pedestrian crossings, on-street parking, survey
marks, and the five supplied festoon-lighting alignments. Every record is
clipped to the irregular scene footprint and retains a source reference.

These layers close the earlier CityFurniture coverage gap, but most remain
LoD0 points: a point proves inventory/location, not the dimensions, orientation,
condition, installation date, or exact 3D shape of the physical object.
The viewer therefore labels streetlight heights and parking-bay dimensions as
inferred. Replace them with surveyed pole height/outreach, fixture catalogue
models, and marked-bay polygons when those become available. Monuments are not
rendered until object-specific geometry can replace a misleading generic symbol.

## Recommended acquisition order

1. Obtain current municipal building footprints and roof attributes, retaining
   the supplied `fid`/`OBJECTID` as crosswalks where possible.
2. Use the supplied normalised height surface for visible roof relief, then
   derive clean roof planes and breaklines from classified LiDAR point clouds
   or dense stereo where formal LoD2 geometry is required.
3. Add oblique imagery/reality mesh only for priority streets or buildings.
4. Record source date, CRS, vertical datum, LOD, error tolerance, and licence
   on every generated asset.

## Data needed for a complete semantic city model

The new `city_model.json` can represent these classes now, but the following
authoritative inputs are still required before the empty or inferred fields can
be treated as reliable city data.

### Priority 1 — identity, currency, and survey control

- Current authoritative building, footway, rail, vegetation, and water datasets
  with immutable source IDs and a crosswalk from the IDs already in this project.
  Municipal road and several street-furniture IDs are now present.
- Per-dataset capture date, update date, responsible organisation, licence,
  lineage, CRS, and explicit horizontal and vertical datum.
- Survey checkpoints and published horizontal/vertical accuracy so the null
  accuracy fields can be replaced by measured values.
- Change sets or successive releases to establish `validFrom`, `validTo`, and
  version transitions instead of assuming every feature is version 1.

### Priority 2 — LoD2 buildings and transport surfaces

- Classified LiDAR point cloud (LAS/LAZ), not only raster products, with point
  classes, returns, flight date, density, and accuracy report.
- Roof planes and breaklines, eaves/ridges, parapets, dormers, and explicit
  building-part boundaries for podiums, towers, setbacks, and extensions.
- Authoritative carriageway, sidewalk, cycleway, crossing, island, kerb, and
  road-edge polygons. Current OSM centrelines and inferred widths are LoD0.
- Bridge, tunnel, level, traffic direction, access, surface material, and
  operational-status attributes for the transport network.

### Priority 3 — vegetation, water, and public realm

- Tree inventory with persistent tree ID, species, planting/removal date,
  health, trunk position/diameter, crown dimensions, and measured height.
- Vegetation/land-cover polygons with class, maintenance regime, capture date,
  and seasonal condition.
- Waterbody and drainage geometries with type, normal water level, bed level,
  tidal/seasonal behavior, and source date.
- Complete the street-furniture inventory with benches, bins, signs, signals,
  shelters, bollards, hydrants, and public art; add surveyed dimensions,
  orientation and type-specific 3D templates to the point inventories now present.

### Priority 4 — richer LoD and dynamic properties

- Façade/oblique imagery or survey for openings, materials, colours, balconies,
  and priority-building LoD3 geometry; indoor units are only needed for LoD4.
- Sensor/simulation feeds with stable sensor IDs, units, timestamps, sampling
  interval, quality flags, and object/property links for CityGML-style
  Dynamizers (weather, temperature, wind, traffic, water level, and energy).
- A scenario registry for proposed interventions containing author, status,
  creation/approval dates, parent scenario, geometry version, assumptions,
  model version, result lineage, and uncertainty.

The first colour mode in the viewer is therefore elevation-based. It is useful
for reading massing and height, but it is deliberately not labelled as façade
or land-use colour until those attributes exist.
