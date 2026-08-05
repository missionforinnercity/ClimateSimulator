# Climate Explorer — Product Assessment

## Where It Compares Well

### 1. It has the right spatial foundation

The combination of LiDAR-derived terrain, building footprints, canopy, roads, rail, and terrain-following visualisation is appropriate for urban design and climate-resilience work.

The application is particularly useful for:

- Understanding massing and topography
- Visualising shade and solar exposure
- Exploring pedestrian-level wind patterns
- Testing heat and flood interventions
- Visualising street closures and public-realm changes
- Explaining climate impacts to non-technical stakeholders

This is a better foundation than a purely decorative 3D city model because it already connects geometry to simulation.

### 2. The product boundary is sensible

You should not duplicate the other dashboard's business, property, or zoning information.

The simulation twin should exchange only:

- Approved spatial IDs
- Building or parcel geometry where necessary
- Proposed intervention geometry
- Simulation outputs such as shade, heat exposure, flood depth, wind comfort, runoff, or visibility

That separation is architecturally correct and should remain explicit.

### 3. The current visual simulation approach is honest

The interface labels heat as a baseline, mitigation as an estimate, and traffic as synthetic. That is good practice. Many digital-twin products overstate the accuracy of their simulations.

---

## Main Gap Versus State of the Art

### 1. The 3D city is not yet an authoritative semantic city model

State-of-the-art systems separate objects such as:

- Buildings and building parts
- Roof surfaces
- Roads and pedestrian paths
- Trees and vegetation
- Terrain
- Water
- Street furniture
- Proposed interventions

They also attach persistent IDs, geometry quality, timestamps, source information, and levels of detail to each object.

CityGML 3.0 formalises this type of semantic 3D city model, including buildings, roads, railways, vegetation, terrain, multiple levels of detail, versioning, and time-varying simulation properties through Dynamizers (OGC CityGML 3.0 guide).

**Recommended improvement:**

- Create stable IDs for every building, road, tree, terrain tile, and intervention
- Expose source date, vertical datum, horizontal accuracy, geometry LOD, and confidence
- Distinguish analytical terrain from visual terrain
- Track changes between data releases
- Preserve feature IDs through simulation outputs

### 2. The asset delivery is not scalable

The current scene is a lightweight local CBD viewer using JSON/bin assets. That is fine for a prototype, but state-of-the-art web twins use hierarchical streaming and multiple levels of detail.

OGC 3D Tiles is designed for streaming massive 3D buildings, terrain, BIM, point clouds, photogrammetry, and instanced objects. Version 1.1 adds semantic metadata, implicit tiling, multiple contents per tile, and better integration with glTF (OGC 3D Tiles, OGC 3D Tiles 1.1 announcement).

**Recommended improvement:**

- Retain Three.js for now
- Introduce tiled terrain and building delivery
- Use GLB for proposed objects
- Use 3D Tiles for city-scale streaming
- Support overview, neighbourhood, street, and detailed building LODs
- Measure tile size, memory use, loading time, and frame rate

### 3. The simulations are broad but mostly proxy models

The application currently has more simulation categories than many early prototypes, but the models are not yet calibrated against measurements or reference simulations.

The most important upgrades are below.

#### Wind

Current wind is suitable for visual exploration, but it should be benchmarked against:

- CFD or WindNinja/OpenFOAM reference cases
- Anemometers
- Pedestrian-level field measurements
- Representative Cape Town wind directions and stability conditions

**Add:**

- Wind-comfort categories
- Exceedance frequency
- Pedestrian-height results
- Uncertainty bands
- Validation error maps
- Clear distinction between preview and validated modes

#### Heat

The current heat layer is primarily a static surface-temperature baseline. For placemaking, the more useful output is pedestrian thermal exposure.

**Add:**

- Shade by time of day
- Mean radiant temperature
- Air temperature
- Wind
- Surface temperature
- UTCI or PET comfort indicators
- Seasonal and extreme-heat scenarios
- Validation against fixed sensors and mobile transects

#### Flooding

The surface-flood model is a useful exploratory tool, but it should not imply drainage performance. The next meaningful layer is:

- Catchments
- Stormwater assets
- Inlets and culverts
- Imperviousness
- Design storms
- Calibrated runoff
- Surface-drainage coupling

Keep drainage engineering as a separately labelled model.

#### Traffic

The SUMO closure simulation is useful, but it is currently corridor-scoped and synthetic. For your stated purpose, pedestrian and public-realm simulation may provide greater value than expanding vehicle realism.

**Prioritise:**

- Pedestrian flows
- Walking accessibility
- Crossing delay
- Sidewalk capacity
- Universal-access routes
- Cycle movement
- Emergency access
- Street closure effects on public-space use

### 4. There is no real scenario system yet

This is the biggest product gap.

A user should be able to create:

- Baseline
- Proposal A
- Proposal B
- Approved scenario
- Temporary event scenario
- Climate adaptation scenario

Each scenario should store:

- Intervention geometry
- Model parameters
- Weather assumptions
- Model version
- Source-data version
- Author
- Creation date
- Result status
- Uncertainty
- Comparison metrics

Mature planning tools support scenario branching, comparison, metrics, and proposal analysis. ArcGIS Urban, for example, explicitly supports scenario switching and comparing impacts across proposals (ArcGIS Urban scenarios).

You do not need to copy its zoning or property workflows. You only need the scenario/version mechanism for spatial proposals and simulations.

### 5. The application needs stronger placemaking metrics

The current visualisations show effects, but planners need concise decision metrics.

**Add metrics such as:**

- Percentage of public space shaded at 09:00, 12:00, and 15:00
- Pedestrian thermal-comfort hours
- Wind-comfort compliance
- Number of uncomfortable pedestrian locations
- Flood depth at entrances and crossings
- Accessible route continuity
- Tree-canopy coverage
- Cool-surface coverage
- Visibility of landmarks
- Duration of solar access
- Public-space usability score
- Before/after affected area

ArcGIS Urban's broader benchmark is useful here: its planning tools quantify effects such as sunlight access, green-space ratio, suitability, viewshed, and drainage-related indicators (ArcGIS Urban analysis).

---

## Highest-Value Improvement Order

1. Add scenario persistence and before/after comparison.
2. Add persistent spatial IDs and simulation-result metadata.
3. Add uncertainty, assumptions, provenance, and confidence to every result.
4. Build pedestrian heat-comfort metrics.
5. Validate wind against reference CFD and local measurements.
6. Add shade, viewshed, solar access, and visibility analysis.
7. Add pedestrian accessibility and movement simulation.
8. Replace monolithic scene assets with tiled, multi-resolution delivery.
9. Add proposed-building and public-realm GLB import.
10. Add reproducible scenario export as JSON, GeoJSON, GLB, and report PDF.

---

## Recommended Target Position

The strongest product identity is:

> A climate-resilience and public-realm simulation twin for testing how spatial interventions affect pedestrian comfort, shade, wind, heat, flooding, movement, and visual experience.

That is narrower and more defensible than trying to become a complete city-management platform.

The project is already beyond a basic 3D viewer. Its next leap is not adding more simulation types; it is making existing simulations reproducible, validated, scenario-based, spatially attributable, and useful for clear placemaking decisions.