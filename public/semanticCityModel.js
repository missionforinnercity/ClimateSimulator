// The renderers consume compact arrays for speed. Keep that representation at
// the rendering boundary while the loaded asset remains a named semantic model.
export function sceneFromCityModel(model) {
  const scene = {
    buildings: [], trees: [], roads: [], railways: [], grass: [], terrain: null,
    cityFurniture: [], crossings: [], parking: [], surveyMarks: [], water: [], installations: [],
  };
  for (const object of Object.values(model?.cityObjects || {})) {
    const geometry = object.geometry || {};
    if (object.type === 'ReliefFeature') scene.terrain = geometry.grid;
    if (object.type === 'Building') {
      const roofId = object.relationships?.boundaries?.[0];
      const roof = model.cityObjects[roofId] || {};
      const roofGeometry = roof.geometry || {};
      scene.buildings.push([
        geometry.groundElevationM, geometry.heightM, geometry.footprint,
        object.identifier, object.attributes?.heightReference,
        roofGeometry.eaveHeightM ?? geometry.heightM,
        Boolean(roofGeometry.externalMesh), roof.quality?.rasterCoverage ?? 0,
        roof.attributes?.roofModel || 'height_fallback', roofGeometry.boundaryHeightProfileM || null,
        geometry.minHeightM || 0,
        object.attributes?.acquisitionMethod, object.attributes?.acquisitionPeriod,
        geometry.interiorRings || [],
        {
          ...(object.attributes?.osm || {}),
          'building:colour': object.attributes?.facadeColour,
          'building:material': object.attributes?.facadeMaterial,
          'roof:shape': roof.attributes?.shape,
          'roof:height': roof.attributes?.height,
          'roof:direction': roof.attributes?.direction,
          'roof:orientation': roof.attributes?.orientation,
          'roof:material': roof.attributes?.material,
          'roof:colour': roof.attributes?.colour,
        },
      ]);
    }
    if ((object.type === 'Road' || object.type === 'TrafficSpace')
      && geometry.centerline
      && !object.sources?.includes('municipalRoads')) {
      scene.roads.push([
        geometry.nominalWidthM,
        object.attributes?.renderClass || object.attributes?.class,
        geometry.centerline,
        'osm',
        object.attributes,
      ]);
    }
    if (object.type === 'Railway') scene.railways.push([object.attributes?.class, geometry.centerline, object.attributes]);
    if (object.type === 'PlantCover') scene.grass.push(geometry.rings?.[0]);
    if (object.type === 'SolitaryVegetationObject') {
      const [x, ground, z] = geometry.referencePoint;
      scene.trees.push([x, ground, z, geometry.crownRadiusM?.[0], geometry.heightM, geometry.crownRadiusM?.[1]]);
    }
    if (object.type === 'CityFurniture') {
      scene.cityFurniture.push({
        identifier: object.identifier, class: object.attributes?.class,
        coordinates: geometry.coordinates, centerline: geometry.centerline,
        attributes: object.attributes,
      });
    }
    if (object.type === 'TrafficSpace' && geometry.type === 'Point') {
      scene.crossings.push({ identifier: object.identifier, coordinates: geometry.coordinates, attributes: object.attributes });
    }
    if (object.type === 'AuxiliaryTrafficSpace') {
      scene.parking.push({ identifier: object.identifier, coordinates: geometry.coordinates, attributes: object.attributes });
    }
    if (object.type === 'GeodeticControlPoint') {
      scene.surveyMarks.push({ identifier: object.identifier, coordinates: geometry.coordinates, attributes: object.attributes });
    }
    if (object.type === 'WaterBody') scene.water.push({ rings: geometry.rings || [], attributes: object.attributes });
    if (object.type === 'BuildingInstallation') {
      scene.installations.push({
        identifier: object.identifier, class: object.attributes?.class,
        coordinates: geometry.coordinates, rings: geometry.rings,
        attributes: object.attributes,
      });
    }
  }
  if (!scene.terrain) throw new Error('semantic city model has no ReliefFeature');
  return scene;
}
