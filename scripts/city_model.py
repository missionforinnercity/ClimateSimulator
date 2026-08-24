"""CityGML 3.0-aligned semantic model for the browser scene.

This is an application JSON encoding of CityGML concepts, not a conformant
CityGML GML/XML document.  The compact renderer adapter deliberately lives at
the edge of the application so semantic objects remain the canonical model.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import Point, Polygon, box, shape
from shapely.ops import transform as transform_geometry, unary_union
from shapely.strtree import STRtree

try:
    from .osm_extract import load_osm, polygon_parts
except ImportError:
    from osm_extract import load_osm, polygon_parts


MODEL_VERSION = "1.0"
ID_NAMESPACE = "za.capetown.climate-explorer"
LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"


def _road_lane_count(value: Any) -> int:
    """Return a usable lane count from municipal values such as ``2-3``.

    The source field is not consistently scalar: transition segments can be
    encoded as ``1,2-3``.  Using the largest stated count is a better width and
    capacity proxy than silently collapsing every non-integer value to one.
    """
    counts = [int(match) for match in re.findall(r"\d+", str(value or ""))]
    return max(1, min(8, max(counts, default=1)))


def _osm_vertical_semantics(attributes: dict[str, Any]) -> dict[str, Any]:
    """Translate OSM ordering tags into an explicitly inferred deck offset.

    OSM layer/bridge/tunnel tags establish ordering, not surveyed elevation.
    The offset is therefore only a renderer-safe visualization estimate and
    is kept out of analytical terrain and wind-obstruction geometry.
    """
    try:
        layer = max(-5, min(5, int(float(attributes.get("layer") or 0))))
    except (TypeError, ValueError):
        layer = 0
    bridge = str(attributes.get("bridge") or "").lower() not in {"", "no"}
    tunnel = str(attributes.get("tunnel") or "").lower() not in {"", "no"}
    if bridge:
        offset = max(4.5, max(layer, 1) * 3.0)
        method = "inferred_bridge_clearance"
    elif tunnel:
        offset = -max(3.0, abs(min(layer, -1)) * 3.0)
        method = "inferred_tunnel_depth"
    elif layer:
        offset = layer * 0.35
        method = "ordering_only_layer_offset"
    else:
        offset = 0.0
        method = "terrain_draped"
    has_vertical_tag = any(attributes.get(key) is not None for key in ("layer", "bridge", "tunnel"))
    return {
        "inferredVerticalOffsetM": offset,
        "verticalPlacementMethod": method,
        "verticalPlacementConfidence": "low" if has_vertical_tag else "medium",
    }


def _digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()[:20]


def _identity(kind: str, source_id: Any, geometry: Any, part: int = 0) -> tuple[str, str]:
    key = source_id if source_id is not None else _digest(geometry)
    identifier = f"urn:{ID_NAMESPACE}:{kind}:{key}:{part}"
    return identifier, f"{identifier}:v1"


def _source(path: Path, *, role: str, acquired: Any = None) -> dict[str, Any]:
    modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat() if path.exists() else None
    return {
        "dataset": path.name,
        "href": str(path),
        "role": role,
        "acquired": acquired,
        "fileModifiedAt": modified,
        "licence": "Open Database License (ODbL) 1.0" if ".osm" in path.name else "unknown; confirm before redistribution",
    }


def _quality(source: str, lod: str, **extra: Any) -> dict[str, Any]:
    return {
        "lod": lod,
        "geometrySource": source,
        "horizontalAccuracyM": None,
        "verticalAccuracyM": None,
        "topologyValidated": False,
        **extra,
    }


def _feature(
    object_type: str,
    identifier: str,
    feature_id: str,
    geometry: dict[str, Any],
    *,
    attributes: dict[str, Any] | None = None,
    sources: list[dict[str, Any]] | None = None,
    quality: dict[str, Any] | None = None,
    relationships: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": object_type,
        "identifier": identifier,
        "featureId": feature_id,
        "lifecycle": {"validFrom": None, "validTo": None, "version": 1},
        "geometry": geometry,
        "attributes": attributes or {},
        "quality": quality or {},
        "sources": sources or [],
        "relationships": relationships or {},
        "dynamizers": [],
    }


def _local_scene_clip(scene: dict[str, Any]) -> Any:
    polygons = [
        Polygon(rings[0], rings[1:])
        for rings in scene["terrain"].get("footprint", [])
        if rings and len(rings[0]) >= 3
    ]
    return unary_union(polygons) if polygons else box(-1040, -902, 1040, 902)


def _street_sources(street_dir: Path) -> dict[str, tuple[str, Path, str]]:
    return {
        "municipalRoads": ("TCT_Road_Centerline.geojson", street_dir / "TCT_Road_Centerline.geojson", "transportNetwork"),
        "publicLighting": ("Electricity_Public_Lighting_clipped.geojson", street_dir / "Electricity_Public_Lighting_clipped.geojson", "cityFurniture"),
        "monuments": ("Monuments.geojson", street_dir / "Monuments.geojson", "cityFurniture"),
        "publicToilets": ("Public_Toilets.geojson", street_dir / "Public_Toilets.geojson", "publicFacility"),
        "pedestrianCrossings": ("Pedestrian_Crossing.geojson", street_dir / "Pedestrian_Crossing.geojson", "transportNetwork"),
        "parking": ("On_Street_Parking.geojson", street_dir / "On_Street_Parking.geojson", "transportNetwork"),
        "surveyMarks": ("Town_Survey_Marks.geojson", street_dir / "Town_Survey_Marks.geojson", "surveyControl"),
        "festoonLighting": ("festoonLighting.json", street_dir / "festoonLighting.json", "cityFurniture"),
    }


def _add_street_objects(
    objects: dict[str, dict[str, Any]],
    scene: dict[str, Any],
    manifest: dict[str, Any],
    street_dir: Path,
) -> bool:
    """Add authoritative municipal public-realm objects clipped to the scene."""
    road_path = street_dir / "TCT_Road_Centerline.geojson"
    if not road_path.exists():
        return False
    scene_clip = _local_scene_clip(scene)
    origin_x, origin_y = manifest["origin"]
    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    to_wgs84 = Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)
    bounds = manifest["bounds"]
    corners = [
        to_wgs84.transform(origin_x + x, origin_y - z)
        for x, z in ((bounds[0], bounds[1]), (bounds[0], bounds[3]), (bounds[2], bounds[1]), (bounds[2], bounds[3]))
    ]
    lon_min, lon_max = min(p[0] for p in corners), max(p[0] for p in corners)
    lat_min, lat_max = min(p[1] for p in corners), max(p[1] for p in corners)

    def localize(raw_geometry: dict[str, Any]) -> Any:
        projected = transform_geometry(to_local.transform, shape(raw_geometry))
        return transform_geometry(lambda x, y, z=None: (x - origin_x, -(y - origin_y)), projected)

    def near_scene(raw_geometry: dict[str, Any]) -> bool:
        raw_bounds = shape(raw_geometry).bounds
        return not (raw_bounds[2] < lon_min or raw_bounds[0] > lon_max or raw_bounds[3] < lat_min or raw_bounds[1] > lat_max)

    road_data = json.loads(road_path.read_text(encoding="utf-8-sig"))
    road_context: list[dict[str, Any]] = []
    for source_index, raw in enumerate(road_data.get("features", [])):
        raw_geometry = raw.get("geometry")
        if not raw_geometry or not near_scene(raw_geometry):
            continue
        clipped = localize(raw_geometry).intersection(scene_clip)
        parts = clipped.geoms if clipped.geom_type == "MultiLineString" else (clipped,)
        properties = raw.get("properties") or {}
        source_id = properties.get("SL_RCL_KEY") or properties.get("OBJECTID")
        for part_index, part in enumerate(parts):
            if part.is_empty or part.geom_type != "LineString" or len(part.coords) < 2:
                continue
            # Remove survey-scale vertex noise before the line becomes a GPU
            # ribbon. This also prevents sharp micro-turns from producing
            # miter spikes at road/path junctions.
            part = part.simplify(0.35, preserve_topology=False)
            if part.is_empty or len(part.coords) < 2:
                continue
            points = [[round(x, 1), round(z, 1)] for x, z in part.coords]
            identifier, feature_id = _identity("municipal-road", source_id, points, part_index)
            lanes = _road_lane_count(properties.get("NR_LANES"))
            try:
                source_width = float(properties.get("RD_WIDTH"))
            except (TypeError, ValueError):
                source_width = float("nan")
            # A handful of portal records contain route-length or otherwise
            # implausible widths. Keep a plausible carriageway width rather
            # than allowing one bad attribute to create a city-scale ribbon.
            width = source_width if math.isfinite(source_width) and 2.0 <= source_width <= 18.0 else lanes * 3.2
            width = max(2.5, min(18.0, width))
            pedestrian = str(properties.get("PED") or "").upper() in {"Y", "YES", "1", "TRUE"}
            objects[feature_id] = _feature(
                "TrafficSpace" if pedestrian else "Road",
                identifier,
                feature_id,
                {"lod": "0", "type": "MultiCurve", "centerline": points, "nominalWidthM": round(float(width), 2)},
                attributes={
                    "name": properties.get("ROAD_NAME"), "class": properties.get("ROAD_TYPE"),
                    "renderClass": "pedestrian" if pedestrian else "residential",
                    "routeKey": properties.get("SL_RTE_KEY"), "speedLimitKph": properties.get("SPD_LMT"),
                    "routeNumber": properties.get("RTE_NR"), "rightOfWayClass": properties.get("PROW_CLSF_CODE"),
                    "speedLimitSource": properties.get("SPD_LMT_SRC"), "surface": properties.get("SURF_TYPE"),
                    "lanes": lanes, "oneWay": properties.get("ONE_WAY"), "bus": properties.get("BUS"),
                    "bicycle": properties.get("BICYCLE"), "owner": properties.get("OWNRSHP"),
                    "maintainingAuthority": properties.get("MNT_AUTH"),
                },
                sources=["municipalRoads"],
                quality=_quality("City of Cape Town road centreline", "0", confidence="high"),
            )
            road_context.append({
                "line": part,
                "name": properties.get("ROAD_NAME"),
                "width": round(float(width), 2),
                "featureId": feature_id,
            })

    road_tree = STRtree([item["line"] for item in road_context]) if road_context else None

    def nearby_road(point: Any) -> dict[str, Any]:
        if road_tree is None:
            return {}
        candidate_indices = list(road_tree.query(point.buffer(35.0)))
        if not candidate_indices:
            return {}
        nearest_index = min(candidate_indices, key=lambda index: road_context[int(index)]["line"].distance(point))
        nearest = road_context[int(nearest_index)]
        line = nearest["line"]
        along = line.project(point)
        # A sub-metre tangent follows every digitising kink and can rotate a
        # crossing several degrees away from the visible carriageway. Sample
        # a longer local chord so markings stay straight while still tracking
        # genuine bends in the road.
        bearing_sample_m = min(6.0, max(1.5, line.length * 0.2))
        before = line.interpolate(max(0.0, along - bearing_sample_m))
        after = line.interpolate(min(line.length, along + bearing_sample_m))
        dx, dz = after.x - before.x, after.y - before.y
        length = math.hypot(dx, dz) or 1.0
        tx, tz = dx / length, dz / length
        nx, nz = -tz, tx
        centre = line.interpolate(along)
        road_name = nearest["name"]
        edges = []
        for candidate_index in candidate_indices:
            candidate = road_context[int(candidate_index)]
            # Only merge genuinely parallel halves of the same named road.
            # Previously every nearby unnamed centreline matched every other
            # unnamed centreline, while same-name lines crossing at a junction
            # could be combined into a huge, skewed carriageway. Crossing and
            # parking paint then appeared far away from the actual asphalt.
            same_road = (
                candidate["name"] == road_name
                if road_name
                else candidate["featureId"] == nearest["featureId"]
            )
            if not same_road or candidate["line"].distance(point) > 30.0:
                continue
            candidate_line = candidate["line"]
            candidate_along = candidate_line.project(point)
            candidate_sample_m = min(6.0, max(1.5, candidate_line.length * 0.2))
            candidate_before = candidate_line.interpolate(max(0.0, candidate_along - candidate_sample_m))
            candidate_after = candidate_line.interpolate(min(candidate_line.length, candidate_along + candidate_sample_m))
            candidate_dx = candidate_after.x - candidate_before.x
            candidate_dz = candidate_after.y - candidate_before.y
            candidate_length = math.hypot(candidate_dx, candidate_dz) or 1.0
            alignment = abs((candidate_dx / candidate_length) * tx + (candidate_dz / candidate_length) * tz)
            if alignment < math.cos(math.radians(25.0)):
                continue
            candidate_centre = candidate_line.interpolate(candidate_along)
            offset = (candidate_centre.x - centre.x) * nx + (candidate_centre.y - centre.y) * nz
            half_width = max(1.6, float(candidate["width"]) * 0.5)
            edges.extend((offset - half_width, offset + half_width))
        centre_offset = (max(edges) + min(edges)) * 0.5 if edges else 0.0
        inferred_width = max(edges) - min(edges) if edges else float(nearest["width"])
        inferred_width = round(max(5.0, min(18.0, inferred_width)), 2)
        facing = math.degrees(math.atan2(centre.y - point.y, centre.x - point.x))
        aggregate_centre = Point(centre.x + nx * centre_offset, centre.y + nz * centre_offset)
        return {
            "roadName": road_name,
            "roadFeatureId": nearest["featureId"],
            "roadWidthM": inferred_width,
            "roadBearingDeg": round(math.degrees(math.atan2(tz, tx)), 2),
            "roadFacingDeg": round(facing, 2),
            "roadCentre": [round(aggregate_centre.x, 2), round(aggregate_centre.y, 2)],
        }

    point_layers = [
        ("publicLighting", "CityFurniture", "publicLight", "OBJECTID"),
        ("monuments", "CityFurniture", "monument", "OBJECTID"),
        ("publicToilets", "CityFurniture", "publicToilet", "OBJECTID"),
        ("pedestrianCrossings", "TrafficSpace", "pedestrianCrossing", "GlobalID"),
        ("parking", "AuxiliaryTrafficSpace", "parkingSpace", "GlobalID"),
        ("surveyMarks", "GeodeticControlPoint", "surveyMark", "PNT"),
    ]
    source_map = _street_sources(street_dir)
    crossing_ids: list[str] = []
    for source_key, object_type, object_class, id_field in point_layers:
        path = source_map[source_key][1]
        if not path.exists():
            continue
        collection = json.loads(path.read_text(encoding="utf-8-sig"))
        for source_index, raw in enumerate(collection.get("features", [])):
            raw_geometry = raw.get("geometry")
            if not raw_geometry or not near_scene(raw_geometry):
                continue
            point = localize(raw_geometry)
            if point.is_empty or point.geom_type != "Point" or not scene_clip.covers(point):
                continue
            properties = raw.get("properties") or {}
            source_id = properties.get(id_field) or properties.get("OBJECTID")
            coordinates = [round(point.x, 2), round(point.y, 2)]
            identifier, feature_id = _identity(object_class, source_id, coordinates, source_index)
            road_attributes = nearby_road(point) if object_class in {"publicLight", "pedestrianCrossing", "parkingSpace", "publicToilet"} else {}
            representation_attributes: dict[str, Any] = {}
            if object_class == "publicLight":
                support = str(properties.get("FixtureSupport") or "").lower()
                try:
                    wattage = float(properties.get("Wattage") or 150)
                except (TypeError, ValueError):
                    wattage = 150.0
                if wattage <= 0:
                    wattage = 150.0
                inferred_height = 18.0 if "high mast" in support else 6.0 if wattage <= 80 else 8.0 if wattage <= 150 else 10.0 if wattage <= 250 else 12.0
                if "post top" in support or "top entry" in support:
                    inferred_height = min(inferred_height, 8.0)
                representation_attributes = {
                    "inferredHeightM": inferred_height,
                    "heightBasis": "support type and wattage rule v1",
                    "heightConfidence": "low; source inventory has no measured pole height",
                }
            elif object_class == "parkingSpace":
                representation_attributes = {"inferredBayLengthM": 5.2, "inferredBayWidthM": 2.4}
            elif object_class == "pedestrianCrossing":
                representation_attributes = {"markingDepthM": 3.2, "markingSemantics": "full-road-width zebra crossing"}
            elif object_class == "publicToilet":
                representation_attributes = {"representation": "generic public-toilet facility; source is point-only"}
            objects[feature_id] = _feature(
                object_type,
                identifier,
                feature_id,
                {"lod": "0", "type": "Point", "coordinates": coordinates},
                attributes={"class": object_class, **properties, **road_attributes, **representation_attributes},
                sources=[source_key],
                quality=_quality("City of Cape Town point inventory", "0", confidence="unknown"),
            )
            if object_class == "pedestrianCrossing":
                crossing_ids.append(feature_id)

    # The special artwork is the double crossing at St George's Mall and
    # Strand Street, not every crossing whose nearest road is Strand Street.
    daisy_centre = Point(-52.0, -174.0)
    daisy_candidates = [
        feature_id for feature_id in crossing_ids
        if str(objects[feature_id]["attributes"].get("roadName") or "").upper() == "STRAND"
        and Point(objects[feature_id]["geometry"]["coordinates"]).distance(daisy_centre) <= 28.0
    ]
    if daisy_candidates:
        daisy_id = min(
            daisy_candidates,
            key=lambda feature_id: Point(objects[feature_id]["geometry"]["coordinates"]).distance(daisy_centre),
        )
        for feature_id in daisy_candidates:
            objects[feature_id]["attributes"]["crossingDesign"] = "daisy" if feature_id == daisy_id else "coveredByDaisyInstallation"
        objects[daisy_id]["geometry"]["coordinates"] = [-52.0, -174.0]
        objects[daisy_id]["attributes"]["roadCentre"] = [-52.0, -174.0]
        objects[daisy_id]["attributes"]["roadWidthM"] = max(12.0, float(objects[daisy_id]["attributes"].get("roadWidthM") or 0.0))
        objects[daisy_id]["attributes"]["designer"] = "Heather Moore / Skinny laMinx"
        objects[daisy_id]["attributes"]["implementedBy"] = "Mission for Inner City Cape Town"

    festoon_path = source_map["festoonLighting"][1]
    if festoon_path.exists():
        collection = json.loads(festoon_path.read_text(encoding="utf-8-sig"))
        for source_index, raw in enumerate(collection.get("features", [])):
            raw_geometry = raw.get("geometry")
            if not raw_geometry or not near_scene(raw_geometry):
                continue
            line = localize(raw_geometry).intersection(scene_clip)
            if line.is_empty or line.geom_type != "LineString":
                continue
            points = [[round(x, 2), round(z, 2)] for x, z in line.coords]
            properties = raw.get("properties") or {}
            identifier, feature_id = _identity("festoon-lighting", properties.get("id"), points, source_index)
            objects[feature_id] = _feature(
                "CityFurniture", identifier, feature_id,
                {"lod": "0", "type": "MultiCurve", "centerline": points},
                attributes={"class": "festoonLighting", **properties},
                sources=["festoonLighting"],
                quality=_quality("project-provided alignment", "0", confidence="medium"),
            )
    return True


OSM_POINT_FURNITURE = {
    ("amenity", "fountain"): ("fountain", "generic mapped fountain; dimensions inferred"),
    ("amenity", "bench"): ("bench", "generic mapped bench; orientation and dimensions inferred"),
    ("amenity", "waste_basket"): ("wasteBasket", "generic mapped litter bin; dimensions inferred"),
    ("amenity", "bicycle_parking"): ("bicycleParking", "generic mapped bicycle stands; capacity may be unknown"),
    ("amenity", "clock"): ("streetClock", "generic mapped street clock; dimensions inferred"),
    ("barrier", "bollard"): ("bollard", "generic mapped bollard; dimensions inferred"),
    ("highway", "bus_stop"): ("busStop", "generic mapped bus-stop marker; not a live vehicle position"),
}


def _add_osm_point_furniture(
    objects: dict[str, dict[str, Any]],
    scene: dict[str, Any],
    manifest: dict[str, Any],
    osm_path: Path,
) -> None:
    """Promote useful OSM point amenities into lightweight CityFurniture.

    OSM describes the presence and position of these objects, not a surveyed
    3D mesh. The semantic record therefore keeps LoD0 point geometry and marks
    the renderer representation as generic/inferred.
    """
    if not osm_path.exists():
        return
    scene_clip = _local_scene_clip(scene)
    origin_x, origin_y = manifest["origin"]
    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    root = ET.parse(osm_path).getroot()
    for node in root.findall("node"):
        tags = {tag.attrib.get("k"): tag.attrib.get("v") for tag in node.findall("tag")}
        match = next((value for key, value in OSM_POINT_FURNITURE.items() if tags.get(key[0]) == key[1]), None)
        if match is None:
            continue
        object_class, representation = match
        try:
            projected_x, projected_y = to_local.transform(float(node.attrib["lon"]), float(node.attrib["lat"]))
        except (KeyError, TypeError, ValueError):
            continue
        point = Point(projected_x - origin_x, -(projected_y - origin_y))
        if not scene_clip.covers(point):
            continue
        coordinates = [round(point.x, 2), round(point.y, 2)]
        source_id = node.attrib.get("id")
        identifier, feature_id = _identity(f"osm-{object_class}", source_id, coordinates)
        attributes = {
            "class": object_class,
            "name": tags.get("name"),
            "representation": representation,
            "osmId": source_id,
            "osmTags": tags,
        }
        objects[feature_id] = _feature(
            "CityFurniture",
            identifier,
            feature_id,
            {"lod": "0", "type": "Point", "coordinates": coordinates},
            attributes=attributes,
            sources=["osmPointFurniture"],
            quality=_quality("OpenStreetMap point", "0", confidence="medium", dimensions="inferred"),
        )


def _add_osm_context(
    objects: dict[str, dict[str, Any]],
    scene: dict[str, Any],
    manifest: dict[str, Any],
    osm_path: Path,
) -> dict[str, int]:
    """Add mapped building installations, barriers and water geometries."""
    counts = {"entrances": 0, "barriers": 0, "solar": 0, "waterBodies": 0}
    if not osm_path.exists():
        return counts
    extract = load_osm(osm_path)
    all_tags = [node.tags for node in extract.nodes.values()] + [way.tags for way in extract.ways.values()] + [relation.tags for relation in extract.relations]
    counts["sourceInventory"] = {
        "roofShape": sum("roof:shape" in tags for tags in all_tags),
        "roofHeight": sum("roof:height" in tags for tags in all_tags),
        "roofDirection": sum("roof:direction" in tags for tags in all_tags),
        "roofOrientation": sum("roof:orientation" in tags for tags in all_tags),
        "roofMaterial": sum("roof:material" in tags for tags in all_tags),
        "roofColour": sum("roof:colour" in tags for tags in all_tags),
        "facadeColour": sum("building:colour" in tags for tags in all_tags),
        "bridge": sum("bridge" in tags for tags in all_tags),
        "tunnel": sum("tunnel" in tags for tags in all_tags),
        "layer": sum("layer" in tags for tags in all_tags),
        "entrance": sum("entrance" in tags for tags in all_tags),
        "barrier": sum("barrier" in tags for tags in all_tags),
        "photovoltaic": sum(tags.get("generator:source") == "solar" or tags.get("power") == "solar_panel" for tags in all_tags),
        "surface": sum("surface" in tags for tags in all_tags),
        "sidewalk": sum("sidewalk" in tags for tags in all_tags),
    }
    origin_x, origin_y = manifest["origin"]
    clip = _local_scene_clip(scene)

    def local_point(x, y):
        return Point(x - origin_x, -(y - origin_y))

    def local_geometry(geometry):
        return transform_geometry(lambda x, y, z=None: (x - origin_x, -(y - origin_y)), geometry)

    def compact_tags(tags):
        return {key: value for key, value in tags.items() if key not in {"source"}}

    for node in extract.nodes.values():
        point = local_point(node.x, node.y)
        if not clip.covers(point):
            continue
        coordinates = [round(point.x, 2), round(point.y, 2)]
        if node.tags.get("entrance") and node.tags.get("entrance") != "no":
            identifier, feature_id = _identity("osm-entrance", node.identifier, coordinates)
            objects[feature_id] = _feature(
                "BuildingInstallation", identifier, feature_id,
                {"lod": "0", "type": "Point", "coordinates": coordinates},
                attributes={"class": "buildingEntrance", "osmId": node.identifier, "osmTags": compact_tags(node.tags)},
                sources=["osmDetails"],
                quality=_quality("OpenStreetMap entrance node", "0", confidence="medium", dimensions="inferred"),
            )
            counts["entrances"] += 1
        solar = node.tags.get("generator:source") == "solar" or node.tags.get("power") == "solar_panel"
        if solar:
            identifier, feature_id = _identity("osm-solar", node.identifier, coordinates)
            objects[feature_id] = _feature(
                "BuildingInstallation", identifier, feature_id,
                {"lod": "0", "type": "Point", "coordinates": coordinates},
                attributes={"class": "roofSolarPanel", "osmId": node.identifier, "osmTags": compact_tags(node.tags)},
                sources=["osmDetails"],
                quality=_quality("OpenStreetMap photovoltaic object", "0", confidence="medium", elevation="drapedToRoof"),
            )
            counts["solar"] += 1
        barrier = node.tags.get("barrier")
        if barrier and barrier != "no" and barrier != "bollard":
            identifier, feature_id = _identity("osm-barrier", node.identifier, coordinates)
            objects[feature_id] = _feature(
                "CityFurniture", identifier, feature_id,
                {"lod": "0", "type": "Point", "coordinates": coordinates},
                attributes={"class": f"barrier:{barrier}", "osmId": node.identifier, "osmTags": compact_tags(node.tags)},
                sources=["osmDetails"], quality=_quality("OpenStreetMap barrier node", "0", confidence="medium", dimensions="inferred"),
            )
            counts["barriers"] += 1

    water_relation_members = set()
    for relation in extract.relations:
        tags = relation.tags
        is_water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank" or tags.get("landuse") in {"reservoir", "basin"}
        if not is_water:
            continue
        water_relation_members.update(reference for kind, reference, _ in relation.members if kind == "way")
        for part_index, polygon in enumerate(extract.relation_polygons(relation)):
            polygon = local_geometry(polygon).intersection(clip)
            for local_index, part in enumerate(polygon_parts(polygon)):
                if part.area < 2:
                    continue
                rings = [[[round(x, 2), round(y, 2)] for x, y in list(ring.coords)[:-1]] for ring in (part.exterior, *part.interiors)]
                identifier, feature_id = _identity("osm-water", relation.identifier, rings, part_index + local_index)
                objects[feature_id] = _feature(
                    "WaterBody", identifier, feature_id,
                    {"lod": "0", "type": "MultiSurface", "rings": rings},
                    attributes={"class": tags.get("water") or tags.get("natural") or tags.get("landuse"), "osmId": relation.identifier, "osmTags": compact_tags(tags)},
                    sources=["osmDetails"], quality=_quality("OpenStreetMap water multipolygon", "0", confidence="medium"),
                )
                counts["waterBodies"] += 1

    for way in extract.ways.values():
        tags = way.tags
        line = extract.way_line(way)
        if line is None:
            continue
        local_line = local_geometry(line).intersection(clip)
        barrier = tags.get("barrier")
        if barrier and barrier != "no" and not local_line.is_empty:
            parts = local_line.geoms if local_line.geom_type == "MultiLineString" else (local_line,)
            for part_index, part in enumerate(parts):
                if part.geom_type != "LineString" or len(part.coords) < 2:
                    continue
                points = [[round(x, 2), round(y, 2)] for x, y in part.coords]
                identifier, feature_id = _identity("osm-barrier", way.identifier, points, part_index)
                objects[feature_id] = _feature(
                    "CityFurniture", identifier, feature_id,
                    {"lod": "0", "type": "MultiCurve", "centerline": points},
                    attributes={"class": f"barrier:{barrier}", "osmId": way.identifier, "osmTags": compact_tags(tags)},
                    sources=["osmDetails"], quality=_quality("OpenStreetMap barrier way", "0", confidence="medium", dimensions="inferred"),
                )
                counts["barriers"] += 1
        solar = tags.get("generator:source") == "solar" or tags.get("power") == "solar_panel"
        if solar:
            geometry = extract.way_polygon(way)
            if geometry is None:
                continue
            for part_index, part in enumerate(polygon_parts(local_geometry(geometry).intersection(clip))):
                rings = [[[round(x, 2), round(y, 2)] for x, y in list(ring.coords)[:-1]] for ring in (part.exterior, *part.interiors)]
                identifier, feature_id = _identity("osm-solar", way.identifier, rings, part_index)
                objects[feature_id] = _feature(
                    "BuildingInstallation", identifier, feature_id,
                    {"lod": "0", "type": "MultiSurface", "rings": rings},
                    attributes={"class": "roofSolarPanel", "osmId": way.identifier, "osmTags": compact_tags(tags)},
                    sources=["osmDetails"], quality=_quality("OpenStreetMap photovoltaic polygon", "0", confidence="medium", elevation="drapedToRoof"),
                )
                counts["solar"] += 1
        is_water = way.identifier not in water_relation_members and (
            tags.get("natural") == "water" or tags.get("waterway") == "riverbank" or tags.get("landuse") in {"reservoir", "basin"}
        )
        if is_water:
            geometry = extract.way_polygon(way)
            if geometry is None:
                continue
            for part_index, part in enumerate(polygon_parts(local_geometry(geometry).intersection(clip))):
                if part.area < 2:
                    continue
                rings = [[[round(x, 2), round(y, 2)] for x, y in list(ring.coords)[:-1]] for ring in (part.exterior, *part.interiors)]
                identifier, feature_id = _identity("osm-water", way.identifier, rings, part_index)
                objects[feature_id] = _feature(
                    "WaterBody", identifier, feature_id,
                    {"lod": "0", "type": "MultiSurface", "rings": rings},
                    attributes={"class": tags.get("water") or tags.get("natural") or tags.get("landuse"), "osmId": way.identifier, "osmTags": compact_tags(tags)},
                    sources=["osmDetails"], quality=_quality("OpenStreetMap water polygon", "0", confidence="medium"),
                )
                counts["waterBodies"] += 1
    return counts


def build_city_model(
    scene: dict[str, Any],
    canopy: dict[str, Any],
    manifest: dict[str, Any],
    source_paths: dict[str, Path],
) -> dict[str, Any]:
    """Convert compact renderer records into named, stable semantic objects."""
    objects: dict[str, dict[str, Any]] = {}

    terrain_id, terrain_feature_id = _identity("relief", "hybrid-dem", manifest["bounds"])
    objects[terrain_feature_id] = _feature(
        "ReliefFeature",
        terrain_id,
        terrain_feature_id,
        {"lod": "0", "type": "TINRelief", "grid": scene["terrain"]},
        attributes={"role": "analyticalTerrain", **manifest["layers"]["terrain"]},
        sources=["terrain"],
        quality=_quality("hybrid LiDAR/SRTM raster", "0", resolutionM=manifest["layers"]["terrain"]["resolution_m"]),
    )

    for index, record in enumerate(scene.get("buildings", [])):
        ground, height, ring, source_id, height_source, wall_height, detailed, coverage, roof_model, wall_profile, *tail = record
        # Older compact assets stored acquisition metadata immediately after
        # wall_profile. New assets insert the numeric vertical clearance first.
        if tail and isinstance(tail[0], (int, float)):
            min_height, source_metadata = tail[0], tail[1:]
        else:
            min_height, source_metadata = 0.0, tail
        acquisition_method = source_metadata[0] if len(source_metadata) > 0 else None
        acquisition_period = source_metadata[1] if len(source_metadata) > 1 else None
        interior_rings = source_metadata[2] if len(source_metadata) > 2 and isinstance(source_metadata[2], list) else []
        osm_attributes = source_metadata[3] if len(source_metadata) > 3 and isinstance(source_metadata[3], dict) else {}
        height_class = {
            "survey_height": "observed",
            "osm_height": "observed",
            "lidar_surface_fallback": "derived",
            "lidar_2025": "derived",
        }.get(height_source, "inferred")
        identifier, feature_id = _identity("building", source_id, ring, index)
        roof_identifier = f"{identifier}:roof"
        roof_feature_id = f"{feature_id}:roof"
        objects[feature_id] = _feature(
            "Building",
            identifier,
            feature_id,
            {
                "lod": "1", "type": "Solid", "footprint": ring, "interiorRings": interior_rings,
                "groundElevationM": ground, "heightM": height, "minHeightM": min_height,
            },
            attributes={
                f"{height_class}HeightM": height,
                "heightReference": height_source,
                "heightProvenance": {
                    "classification": height_class,
                    "sourceTag": height_source,
                    "acquisitionMethod": acquisition_method,
                    "acquisitionPeriod": acquisition_period,
                    **({"osmHeightTag": osm_attributes["height"]} if osm_attributes.get("height") else {}),
                },
                "acquisitionMethod": acquisition_method,
                "acquisitionPeriod": acquisition_period,
                "minHeightM": min_height,
                "class": osm_attributes.get("building") or osm_attributes.get("building:part"),
                "name": osm_attributes.get("name"),
                "levels": osm_attributes.get("building:levels"),
                "facadeMaterial": osm_attributes.get("building:material"),
                "facadeColour": osm_attributes.get("building:colour"),
                "osm": osm_attributes,
            },
            sources=["buildings"],
            quality=_quality(
                "municipal footprint extrusion",
                "1",
                roofRasterCoverage=coverage,
                confidence="high" if height_source == "survey_height" else "medium",
            ),
            relationships={"boundaries": [roof_feature_id], "parts": []},
        )
        objects[roof_feature_id] = _feature(
            "RoofSurface",
            roof_identifier,
            roof_feature_id,
            {
                "lod": "2" if detailed else "1",
                "type": "MultiSurface",
                "footprint": ring, "interiorRings": interior_rings,
                "eaveHeightM": wall_height,
                "boundaryHeightProfileM": wall_profile,
                "externalMesh": "roof_surface.bin" if detailed else None,
            },
            attributes={
                "roofModel": roof_model,
                "shape": osm_attributes.get("roof:shape"),
                "height": osm_attributes.get("roof:height"),
                "direction": osm_attributes.get("roof:direction"),
                "orientation": osm_attributes.get("roof:orientation"),
                "material": osm_attributes.get("roof:material"),
                "colour": osm_attributes.get("roof:colour"),
            },
            sources=["height", "buildings"],
            quality=_quality(
                "regularised 1 m normalized LiDAR height raster" if detailed else "building height extrusion",
                "2" if detailed else "1",
                rasterCoverage=coverage,
                confidence="medium" if detailed else "low",
            ),
            relationships={"parent": feature_id},
        )

    street_dir = source_paths.get("street_data")
    if street_dir:
        _add_street_objects(objects, scene, manifest, street_dir)
    osm_path = source_paths.get("osm")
    if osm_path:
        _add_osm_point_furniture(objects, scene, manifest, osm_path)
        osm_detail_counts = _add_osm_context(objects, scene, manifest, osm_path)
    else:
        osm_detail_counts = {"entrances": 0, "barriers": 0, "solar": 0, "waterBodies": 0, "sourceInventory": {}}
    # Keep the complete OSM network as the visible representation: its ways
    # are continuous through junctions and its highway classes drive the road
    # hierarchy colours. Municipal centrelines remain authoritative semantic
    # records for street furniture, widths, crossings and traffic enrichment,
    # but rendering both products would double the asphalt and cause z-fights.
    for index, record in enumerate(scene.get("roads", [])):
        width, highway, points, *tail = record
        osm_attributes = tail[0] if tail and isinstance(tail[0], dict) else {}
        identifier, feature_id = _identity("transport", None, [highway, points], index)
        pedestrian = highway == "pedestrian" or highway in {"footway", "path", "cycleway", "steps", "corridor", "elevator"}
        objects[feature_id] = _feature(
            "TrafficSpace" if pedestrian else "Road",
            identifier,
            feature_id,
            {"lod": "0", "type": "MultiCurve", "centerline": points, "nominalWidthM": width},
            attributes={
                "class": highway, "renderClass": highway, "usage": "pedestrian" if pedestrian else "vehicular",
                "surface": osm_attributes.get("surface"), "sidewalk": osm_attributes.get("sidewalk"),
                "sidewalkLeft": osm_attributes.get("sidewalk:left"), "sidewalkRight": osm_attributes.get("sidewalk:right"),
                "bridge": osm_attributes.get("bridge"), "tunnel": osm_attributes.get("tunnel"),
                "layer": osm_attributes.get("layer"), "lanes": osm_attributes.get("lanes"),
                "oneway": osm_attributes.get("oneway"), "lit": osm_attributes.get("lit"),
                "name": osm_attributes.get("name"), "osmId": osm_attributes.get("osmId"),
                **_osm_vertical_semantics(osm_attributes),
            },
            sources=["roads"],
            quality=_quality("OSM centreline with class-derived width", "0", confidence="medium"),
        )

    for index, record in enumerate(scene.get("railways", [])):
        railway, points, *tail = record
        osm_attributes = tail[0] if tail and isinstance(tail[0], dict) else {}
        identifier, feature_id = _identity("railway", None, [railway, points], index)
        objects[feature_id] = _feature(
            "Railway",
            identifier,
            feature_id,
            {"lod": "0", "type": "MultiCurve", "centerline": points},
            attributes={"class": railway, **osm_attributes, **_osm_vertical_semantics(osm_attributes)},
            sources=["railways"],
            quality=_quality("OSM centreline", "0", confidence="medium"),
        )

    for index, ring in enumerate(scene.get("grass", [])):
        identifier, feature_id = _identity("plant-cover", None, ring, index)
        objects[feature_id] = _feature(
            "PlantCover",
            identifier,
            feature_id,
            {"lod": "0", "type": "MultiSurface", "rings": [ring]},
            attributes={"class": "mappedGreenArea"},
            sources=["green"],
            quality=_quality("OSM polygon", "0", confidence="medium"),
        )

    for index, tree in enumerate(scene.get("trees", [])):
        x, ground, z, crown_x, height, crown_z = tree
        identifier, feature_id = _identity("vegetation-object", None, tree, index)
        objects[feature_id] = _feature(
            "SolitaryVegetationObject",
            identifier,
            feature_id,
            {"lod": "1", "type": "ImplicitGeometry", "referencePoint": [x, ground, z], "crownRadiusM": [crown_x, crown_z], "heightM": height},
            attributes={"class": "tree", "species": None},
            sources=["canopy", "height"],
            quality=_quality("derived instance within mapped canopy", "1", confidence="low"),
        )

    return {
        "type": "CityModel",
        "schemaVersion": MODEL_VERSION,
        "conceptualModel": "OGC CityGML 3.0",
        "encodingProfile": "Climate Explorer application JSON (non-conformant exchange encoding)",
        "metadata": {
            "title": "Cape Town CBD Climate Explorer semantic city model",
            "referenceSystem": manifest["crs"],
            "origin": manifest["origin"],
            "bounds": manifest["bounds"],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "objectCount": len(objects),
            "osmDetailCounts": osm_detail_counts,
            "availableModules": ["Core", "Building", "Transportation", "Vegetation", "Relief", "WaterBody", "CityFurniture", "Dynamizer", "Versioning", "Generics"],
            "emptyModules": [] if osm_detail_counts["waterBodies"] else ["WaterBody"],
            "lodPolicy": {"0": "2D/2.5D thematic geometry", "1": "volumetric massing or implicit object", "2": "thematic boundary surfaces"},
        },
        "sources": {
            "terrain": _source(source_paths["terrain"], role="elevation"),
            "height": _source(source_paths["height"], role="height"),
            "buildings": _source(source_paths["buildings"], role="footprintAndHeight"),
            "canopy": _source(source_paths["canopy"], role="vegetationExtent"),
            "roads": _source(source_paths["roads"], role="transportNetwork"),
            "railways": _source(source_paths["railways"], role="transportNetwork"),
            "green": _source(source_paths["green"], role="landCover"),
            **({
                "osmPointFurniture": _source(source_paths["osm"], role="cityFurniture"),
                "osmDetails": _source(source_paths["osm"], role="buildingAndSurfaceDetail"),
            } if source_paths.get("osm") else {}),
            **({
                key: _source(path, role=role)
                for key, (_, path, role) in _street_sources(street_dir).items()
                if path.exists()
            } if street_dir else {}),
        },
        "cityObjects": objects,
        "dynamizers": [],
        "versionTransitions": [],
        "proposedInterventions": [],
    }


def write_city_model(model: dict[str, Any], output: Path) -> dict[str, Any]:
    output.write_text(json.dumps(model, separators=(",", ":")) + "\n", encoding="utf-8")
    counts: dict[str, int] = {}
    for feature in model["cityObjects"].values():
        counts[feature["type"]] = counts.get(feature["type"], 0) + 1
    return {
        "objects": len(model["cityObjects"]), "types": counts, "bytes": output.stat().st_size,
        "cache_key": hashlib.sha256(output.read_bytes()).hexdigest()[:16],
    }


def add_semantic_renderer_context(scene: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    """Copy water into the compact interactive asset.

    The full semantic model retains installations and city furniture for
    analysis. Keeping those thousands of records out of the browser's compact
    scene preserves interactive performance.
    """
    scene["water"] = []
    for item in model.get("cityObjects", {}).values():
        geometry = item.get("geometry") or {}
        attributes = item.get("attributes") or {}
        item_type = item.get("type")
        if item_type == "WaterBody":
            scene["water"].append({"rings": geometry.get("rings") or [], "attributes": attributes})
    return scene
