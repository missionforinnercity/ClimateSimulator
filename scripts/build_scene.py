#!/usr/bin/env python3
"""Build the compact browser scene (fallback.json) from the supplied Cape Town datasets."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path

import numpy as np
import rasterio
import shapely
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.errors import WindowError
from rasterio.features import geometry_mask, geometry_window, rasterize, shapes
from rasterio.warp import reproject
from scipy.ndimage import distance_transform_edt, find_objects, median_filter
from scipy.spatial import Delaunay, QhullError
from shapely.geometry import LineString, Point, Polygon, box, mapping, shape
from shapely.ops import transform as transform_geometry, unary_union
from shapely.strtree import STRtree

try:
    from .city_model import add_semantic_renderer_context, build_city_model, write_city_model
    from .osm_extract import load_osm
except ImportError:  # Direct execution: python scripts/build_scene.py
    from city_model import add_semantic_renderer_context, build_city_model, write_city_model
    from osm_extract import load_osm

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROAD_WIDTHS = {"motorway": 15.0, "trunk": 13.0, "primary": 11.0, "secondary": 9.0, "tertiary": 7.0, "residential": 5.5, "unclassified": 5.5, "living_street": 5.0, "service": 4.0, "pedestrian": 4.0, "cycleway": 2.5, "footway": 2.0, "path": 1.5}
GROUND_SURFACE_OVERRIDES = {
    # Site materials checked against the reference images supplied for this scene.
    "5216621": "grand_parade",
    "724854797": "red_pavers",
    "23106905": "concrete",
}


def surface_material(surface: str | None) -> str | None:
    """Map observed surface tags to the compact renderer's neutral material families."""
    value = str(surface or "").strip().lower().replace(" ", "_")
    if value in {"asphalt", "tar", "chipseal", "tarmac"}:
        return "asphalt"
    if value in {"concrete", "concrete:plates"}:
        return "concrete"
    if value in {"brick", "bricks"}:
        return "brick"
    if value in {"paving_stones", "sett", "cobblestone", "cobblestone:flattened", "unhewn_cobblestone"}:
        return "stone"
    if value in {"gravel", "fine_gravel", "compacted", "ground", "dirt", "earth", "sand", "unpaved"}:
        return "gravel"
    if value == "paved":
        return "paved"
    return None


def source_fingerprint(path: Path) -> dict[str, object]:
    """Return a reproducible digest for a build input file or directory."""
    digest = hashlib.sha256()
    files = sorted(item for item in ([path] if path.is_file() else path.rglob("*")) if item.is_file())
    total_bytes = 0
    for item in files:
        relative = item.name if path.is_file() else item.relative_to(path).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        with item.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
                total_bytes += len(block)
    return {
        "path": str(path),
        "sha256": digest.hexdigest(),
        "bytes": total_bytes,
        "files": len(files),
    }


def valid_lidar_footprint(source, simplify_m=2.0):
    """Return the polygon represented by valid DTM pixels, not raster bounds."""
    valid = source.read_masks(1) > 0
    polygons = [
        shape(geometry)
        for geometry, value in shapes(valid.astype("uint8"), mask=valid, transform=source.transform)
        if value == 1
    ]
    footprint = unary_union(polygons)
    return footprint.simplify(simplify_m, preserve_topology=True) if simplify_m else footprint


def write_lidar_footprint(dtm_path, output):
    """Write the valid-data footprint in WGS84 for external GIS use."""
    with rasterio.open(dtm_path) as source:
        footprint = valid_lidar_footprint(source)
        valid_area_m2 = int((source.read_masks(1) > 0).sum()) * abs(source.transform.a * source.transform.e)
    to_wgs84 = Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)
    geographic = transform_geometry(to_wgs84.transform, footprint)
    collection = {
        "type": "FeatureCollection",
        "name": "conditions_valid_lidar_footprint",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [{
            "type": "Feature",
            "properties": {
                "source": str(dtm_path),
                "mask_semantics": "valid DTM pixels",
                "valid_area_m2": round(valid_area_m2, 1),
                "simplification_m": 2.0,
            },
            "geometry": mapping(geographic),
        }],
    }
    output.write_text(json.dumps(collection, indent=2) + "\n", encoding="utf-8")


def sample(data, transform, x, y, default=0.0):
    col, row = (~transform) * (x, y)
    row, col = int(round(row)), int(round(col))
    if row < 0 or col < 0 or row >= data.shape[0] or col >= data.shape[1]:
        return default
    value = float(data[row, col])
    return value if math.isfinite(value) else default


def sample_median(data, transform, x, y, radius=2, default=float("nan")):
    """Return a small-window median to suppress isolated LiDAR returns."""
    col, row = (~transform) * (x, y)
    row, col = int(round(row)), int(round(col))
    row0, row1 = max(0, row - radius), min(data.shape[0], row + radius + 1)
    col0, col1 = max(0, col - radius), min(data.shape[1], col + radius + 1)
    values = data[row0:row1, col0:col1]
    values = values[np.isfinite(values)]
    return float(np.median(values)) if values.size else default


def fill_nearest(values, valid):
    """Fill raster gaps with the nearest valid terrain sample."""
    if valid.all():
        return values
    if not valid.any():
        return values
    indices = distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return values[tuple(indices)]


def building_min_height(value, total_height, minimum_level=None, total_levels=None):
    """Return metric clearance, deriving level-based clearance when needed."""
    try:
        clearance = float(value)
        height = float(total_height)
    except (TypeError, ValueError):
        try:
            height = float(total_height)
            minimum_level = float(minimum_level)
            total_levels = float(total_levels)
            clearance = height * minimum_level / total_levels
        except (TypeError, ValueError, ZeroDivisionError):
            return 0.0
    return clearance if math.isfinite(clearance) and 0 < clearance < height else 0.0


def osm_direction_degrees(value):
    """Parse OSM numeric or 16-point compass roof directions."""
    compass = {
        "N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5,
        "SE": 135, "SSE": 157.5, "S": 180, "SSW": 202.5, "SW": 225,
        "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5,
    }
    text = str(value or "").strip().upper()
    try:
        result = float(text)
    except ValueError:
        result = compass.get(text, float("nan"))
    return result % 360 if math.isfinite(result) else None


def local_osm_transport(osm_path, clip, keys, extract=None):
    """Yield clipped OSM transport lines with their rendering attributes."""
    extract = extract or load_osm(osm_path)
    for way in extract.ways.values():
        feature_class = next((way.tags.get(key) for key in keys if way.tags.get(key)), None)
        if not feature_class:
            continue
        line = extract.way_line(way)
        if line is None:
            continue
        line = line.intersection(clip)
        parts = line.geoms if line.geom_type == "MultiLineString" else (line,)
        for part in parts:
            if not part.is_empty and len(part.coords) >= 2:
                attributes = {
                    key: value for key, value in way.tags.items()
                    if key in {
                        "surface", "sidewalk", "sidewalk:left", "sidewalk:right", "bridge", "tunnel",
                        "layer", "width", "lanes", "oneway", "lit", "name", "access", "service",
                    }
                }
                attributes["osmId"] = way.identifier
                yield feature_class, part.simplify(0.35, preserve_topology=False), attributes


def municipal_surface_index(path, clip):
    """Index mapped City road materials near the scene for OSM surface-tag gaps."""
    if path is None or not path.exists():
        return None, [], 0
    to_wgs84 = Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)
    left, bottom, right, top = clip.bounds
    corners = [to_wgs84.transform(x, y) for x, y in ((left, bottom), (left, top), (right, bottom), (right, top))]
    lon_min, lon_max = min(point[0] for point in corners), max(point[0] for point in corners)
    lat_min, lat_max = min(point[1] for point in corners), max(point[1] for point in corners)
    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    collection = json.loads(path.read_text(encoding="utf-8-sig"))
    lines = []
    materials = []
    counts = {"Asphalt": "asphalt", "Paving Blocks": "stone", "Concrete": "concrete", "Gravel": "gravel"}
    for feature in collection.get("features", []):
        properties = feature.get("properties") or {}
        material = counts.get(str(properties.get("SURF_TYPE") or "").strip())
        geometry = feature.get("geometry")
        if material is None or not geometry:
            continue
        raw = shape(geometry)
        bounds = raw.bounds
        if bounds[2] < lon_min or bounds[0] > lon_max or bounds[3] < lat_min or bounds[1] > lat_max:
            continue
        projected = transform_geometry(to_local.transform, raw).intersection(clip)
        parts = projected.geoms if projected.geom_type == "MultiLineString" else (projected,)
        for part in parts:
            if part.geom_type != "LineString" or part.length < 3:
                continue
            lines.append(part.simplify(0.5, preserve_topology=False))
            materials.append(material)
    return (STRtree(lines) if lines else None), materials, len(lines)


def match_municipal_surface(line, tree, materials, maximum_distance=6.0):
    if tree is None or line.is_empty or line.length < 2:
        return None
    candidates = tree.query(line.buffer(maximum_distance))
    best = None
    best_score = 0.0
    search_area = line.buffer(4.0)
    for candidate_index in candidates:
        candidate = tree.geometries[int(candidate_index)]
        distance = line.distance(candidate)
        if distance > maximum_distance:
            continue
        overlap = candidate.intersection(search_area).length
        coverage = min(1.0, overlap / max(line.length, 1.0))
        score = coverage - distance * 0.02
        if score > best_score:
            best = materials[int(candidate_index)]
            best_score = score
    return best if best_score >= 0.35 else None


def local_ground_surfaces(extract, clip, building_records, origin_x, origin_y):
    """Export clipped OSM area surfaces plus the three image-verified site finishes."""
    building_mask = unary_union([record[2] for record in building_records if record[2] is not None])
    candidates = []

    def add_source(source_kind, source_id, tags, polygons):
        if tags.get("building") or tags.get("indoor") == "yes":
            return
        if tags.get("amenity") == "parking" and tags.get("parking") not in {None, "surface"}:
            return
        try:
            layer = float(tags.get("layer", 0) or 0)
        except (TypeError, ValueError):
            layer = 0
        if layer < 0 or tags.get("parking") in {"underground", "multi-storey", "rooftop", "carports", "garage_boxes"}:
            return
        surface = tags.get("surface")
        material = GROUND_SURFACE_OVERRIDES.get(str(source_id))
        if material is None:
            material = surface_material(surface)
        if material == "paved":
            material = "stone"
        if material is None and tags.get("place") == "square":
            material = "stone"
        if material is None and tags.get("highway") in {"pedestrian", "footway"} and tags.get("area") == "yes":
            material = "stone"
        if material is None and tags.get("amenity") == "parking" and tags.get("parking") == "surface":
            material = "asphalt"
        if material is None:
            return
        name = tags.get("name")
        special = str(source_id) in GROUND_SURFACE_OVERRIDES
        for polygon in polygons:
            if polygon.is_empty or polygon.area < 4:
                continue
            clipped = polygon.intersection(clip)
            if clipped.is_empty:
                continue
            # Building footprints have their own mapped geometry and remain clear
            # of the ground-surface overlays even where source areas are coarse.
            clipped = clipped.difference(building_mask)
            parts = clipped.geoms if clipped.geom_type == "MultiPolygon" else (clipped,)
            for part in parts:
                if part.geom_type != "Polygon" or part.area < 4:
                    continue
                # OSM often maps a square as one broad polygon and then maps
                # its parking bays or paved islands as separate polygons.
                # Keep their source geometry until all candidates are known
                # so those more specific surfaces can replace the square
                # instead of z-fighting with it in the renderer.
                priority = 4 if special else 3 if tags.get("amenity") == "parking" else 1 if tags.get("place") == "square" else 2
                candidates.append({
                    "osmId": str(source_id), "source": f"osm:{source_kind}",
                    "name": name, "material": material, "special": special,
                    "amenity": tags.get("amenity"), "parking": tags.get("parking"),
                    "access": tags.get("access"),
                    "_priority": priority, "_geometry": part,
                })

    for way in extract.ways.values():
        tags = way.tags
        if tags.get("building") or not way.refs or way.refs[0] != way.refs[-1]:
            continue
        explicit_area = tags.get("area") == "yes"
        surface_area = surface_material(tags.get("surface")) is not None
        outdoor_parking = tags.get("amenity") == "parking" and tags.get("building") is None
        named_square = tags.get("place") == "square"
        if not (explicit_area or surface_area or outdoor_parking or named_square or str(way.identifier) in GROUND_SURFACE_OVERRIDES):
            continue
        polygon = extract.way_polygon(way)
        if polygon is not None:
            add_source("way", way.identifier, tags, [polygon])

    for relation in extract.relations:
        tags = relation.tags
        if tags.get("building") or not (
            surface_material(tags.get("surface")) or tags.get("place") == "square"
            or tags.get("amenity") == "parking"
        ):
            continue
        add_source("relation", relation.identifier, tags, extract.relation_polygons(relation))

    # Resolve mapped area overlaps once, in semantic priority order. This
    # prevents coplanar meshes from competing in the depth buffer, while a
    # broad square remains visible anywhere no more specific finish exists.
    candidates.sort(key=lambda record: -record["_priority"])
    claimed = None
    resolved = []
    for candidate in candidates:
        geometry = candidate.pop("_geometry")
        candidate.pop("_priority")
        visible_geometry = geometry if claimed is None else geometry.difference(claimed)
        parts = visible_geometry.geoms if visible_geometry.geom_type == "MultiPolygon" else (visible_geometry,)
        for part in parts:
            if part.geom_type != "Polygon" or part.area < 4:
                continue
            part = part.simplify(0.15, preserve_topology=True)
            # Simplifying can move a boundary slightly back into an area that
            # was already claimed. Re-cut against emitted geometry to keep
            # the final surfaces strictly disjoint after simplification.
            if claimed is not None:
                part = part.difference(claimed)
            output_parts = part.geoms if part.geom_type == "MultiPolygon" else (part,)
            for output_part in output_parts:
                if output_part.geom_type != "Polygon" or output_part.area < 4:
                    continue
                rings = []
                for ring in [output_part.exterior, *output_part.interiors]:
                    points = [[round(x - origin_x, 2), round(-(y - origin_y), 2)] for x, y in list(ring.coords)[:-1]]
                    if len(points) >= 3:
                        rings.append(points)
                if rings:
                    resolved.append({**candidate, "rings": rings})
                    claimed = output_part if claimed is None else unary_union((claimed, output_part))
    return resolved


def local_traffic_signals(extract, clip, origin_x, origin_y):
    """Return mapped OSM traffic-signal nodes in the viewer's local frame."""
    signals = []
    for node in extract.nodes.values():
        if node.tags.get("highway") != "traffic_signals" and node.tags.get("crossing") != "traffic_signals":
            continue
        if not clip.covers(Point(node.x, node.y)):
            continue
        signals.append({
            "osmId": node.identifier,
            "coordinates": [round(node.x - origin_x, 1), round(-(node.y - origin_y), 1)],
            "kind": node.tags.get("highway", "crossing"),
        })
    return sorted(signals, key=lambda item: item["osmId"])


def local_green_areas(green_path, clip):
    collection = json.loads(green_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    polygons = []
    for feature in collection.get("features", []):
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), shape(feature["geometry"])).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        for polygon in parts:
            if not polygon.is_empty and polygon.area >= 12.0:
                polygons.append(polygon)
    # Multiple source green-area records often overlap at park boundaries.
    # Drawing each as a separate terrain-hugging mesh causes depth fighting
    # and dark serrated seams, so dissolve overlaps before exporting them.
    dissolved = unary_union(polygons)
    parts = dissolved.geoms if dissolved.geom_type == "MultiPolygon" else (dissolved,)
    yield from (polygon for polygon in parts if not polygon.is_empty and polygon.area >= 12.0)


def compact_terrain_grid(dtm, valid, transform, bounds, origin_x, origin_y, footprint, size=384):
    """An elevation grid grounds the renderer's roads and terrain mesh.

    The CBD climbs almost 50m from the harbour toward the mountain, and a
    cell on this 384 x 384 grid spans roughly 5.4m x 4.7m. The previous
    192 x 192 renderer grid was too coarse around small landforms and water
    edges, so roads and grass could look stepped even though the source DTM
    is sampled at 2m. Buildings retain their direct per-building DTM heights.
    """
    left, bottom, right, top = bounds
    heights = []
    validity = []
    for row in range(size):
        y = top - (top - bottom) * row / (size - 1)
        for column in range(size):
            x = left + (right - left) * column / (size - 1)
            # A small median rejects isolated returns while retaining more
            # local slope detail for the denser renderer grid.
            heights.append(round(sample_median(dtm, transform, x, y, radius=1, default=sample(dtm, transform, x, y)), 2))
            validity.append(1 if sample(valid, transform, x, y, default=0) > 0 else 0)
    polygon_parts = footprint.geoms if footprint.geom_type == "MultiPolygon" else (footprint,)
    footprint_polygons = []
    for polygon in polygon_parts:
        rings = []
        for ring in [polygon.exterior, *polygon.interiors]:
            points = [
                [round(x - origin_x, 1), round(-(y - origin_y), 1)]
                for x, y in list(ring.coords)[:-1]
            ]
            if len(points) >= 3:
                rings.append(points)
        if rings:
            footprint_polygons.append(rings)
    return {
        "columns": size,
        "rows": size,
        "heights": heights,
        "valid": validity,
        "footprint": footprint_polygons,
        "base": round(float(np.percentile(np.asarray(heights)[np.asarray(validity, dtype=bool)], 2)) - 12.0, 2),
    }


def build_tree_instances(tree_path, height_path, dtm_path, origin_x, origin_y):
    """Place tree instances (position, crown size, height, orientation) for the compact scene."""
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        surface_raster = height_source.read(1, masked=True)
        surface = fill_nearest(surface_raster.filled(0.0).astype(np.float32), ~np.asarray(surface_raster.mask))
        surface_transform = height_source.transform
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = fill_nearest(dtm_raster.filled(0.0).astype(np.float32), ~np.asarray(dtm_raster.mask))
        dtm_transform = dtm_source.transform
        clip = valid_lidar_footprint(dtm_source)
    with tree_path.open(encoding="utf-8") as stream:
        collection = json.load(stream)
    transformer = Transformer.from_crs("EPSG:3857", LOCAL_CRS, always_xy=True)
    instances = []

    def emit_tree(point, crown_x, crown_z, orientation, seed):
        col, row = (~dtm_transform) * (point.x, point.y)
        row, col = int(round(row)), int(round(col))
        if row < 0 or col < 0 or row >= dtm.shape[0] or col >= dtm.shape[1]:
            return
        ground = sample(dtm, dtm_transform, point.x, point.y)
        lidar_height = sample_median(surface, surface_transform, point.x, point.y, radius=2)
        height = lidar_height if math.isfinite(lidar_height) and 3.0 <= lidar_height <= 18.0 else 4.5 + max(crown_x, crown_z) * 0.8
        height = max(4.0, min(18.0, height))
        x, z = point.x - origin_x, -(point.y - origin_y)
        instances.append((x, ground, z, crown_x, height, crown_z, orientation + seed * 2.399963229728653))

    for feature in collection.get("features", []):
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), shape(feature["geometry"])).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        for polygon in parts:
            if polygon.is_empty or polygon.area < 1.0:
                continue
            rectangle = list(polygon.minimum_rotated_rectangle.exterior.coords)[:-1]
            edges = [(rectangle[(i + 1) % 4][0] - rectangle[i][0], rectangle[(i + 1) % 4][1] - rectangle[i][1]) for i in range(4)]
            lengths = [math.hypot(x, y) for x, y in edges]
            major_edge = int(np.argmax(lengths))
            orientation = math.atan2(edges[major_edge][1], edges[major_edge][0])
            if polygon.area > 120.0:
                # Large canopy polygons generally represent a few mature
                # trees, not a dense grid of small trees.
                spacing = max(10.0, min(18.0, math.sqrt(polygon.area / 1.5)))
                min_x, min_y, max_x, max_y = polygon.bounds
                points = [Point(x, y) for x in np.arange(min_x, max_x + spacing, spacing) for y in np.arange(min_y, max_y + spacing, spacing) if polygon.covers(Point(x, y))]
                if not points:
                    points = [polygon.representative_point()]
                crown_x, crown_z = min(8.0, spacing * 0.55), min(6.0, spacing * 0.42)
            else:
                points = [polygon.representative_point()]
                crown_x = max(1.0, min(18.0, lengths[major_edge] * 0.5))
                crown_z = max(0.8, min(14.0, lengths[(major_edge + 1) % 4] * 0.5))
            for point_index, point in enumerate(points):
                emit_tree(point, crown_x, crown_z, orientation, len(instances) + point_index)
    return instances


def build_canopy_records(tree_path, height_path, dtm_path, origin_x, origin_y):
    """Preserve source canopy components and attach robust LiDAR crown heights.

    Each compact record is:
      [source_id, ground_y, crown_base_y, crown_top_y, seed, [outer, ...holes]]
    Rings use viewer-local [x, z] metres and omit the repeated closing vertex.
    """
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        surface_raster = height_source.read(1, masked=True)
        surface = fill_nearest(surface_raster.filled(0.0).astype(np.float32), ~np.asarray(surface_raster.mask))
        surface_transform = height_source.transform
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = fill_nearest(dtm_raster.filled(0.0).astype(np.float32), ~np.asarray(dtm_raster.mask))
        dtm_transform = dtm_source.transform
        clip = valid_lidar_footprint(dtm_source)
    collection = json.loads(tree_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:3857", LOCAL_CRS, always_xy=True)
    records = []
    source_area = 0.0
    exported_area = 0.0

    for feature_index, feature in enumerate(collection.get("features", [])):
        geometry = transform_geometry(
            lambda x, y, z=None: transformer.transform(x, y),
            shape(feature["geometry"]),
        ).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        source_id = (feature.get("properties") or {}).get("fid", feature_index)
        for part_index, polygon in enumerate(parts):
            if polygon.is_empty or polygon.area < 1.0:
                continue
            original_polygon = polygon
            source_area += original_polygon.area
            # 0.25 m keeps aggregate canopy area drift below 2% for the
            # supplied layer while still removing most survey noise.
            simplified = polygon.simplify(0.25, preserve_topology=True)
            # Preserve small but valid source components when a fixed
            # simplification tolerance would collapse too much of their area.
            polygon = simplified if not simplified.is_empty and simplified.area >= 1.0 else original_polygon
            representative = polygon.representative_point()
            sample_points = [representative, polygon.centroid]
            boundary = list(polygon.exterior.coords)[:-1]
            if boundary:
                stride = max(1, len(boundary) // 8)
                sample_points.extend(Point(*boundary[index]) for index in range(0, len(boundary), stride))
            grounds = [
                sample(dtm, dtm_transform, point.x, point.y, default=float("nan"))
                for point in sample_points
            ]
            grounds = [value for value in grounds if math.isfinite(value)]
            if not grounds:
                ground = float(np.percentile(dtm, 2))
            else:
                ground = float(np.median(grounds))
            lidar_heights = []
            for point in sample_points:
                point_surface = sample_median(surface, surface_transform, point.x, point.y, radius=2)
                if math.isfinite(point_surface):
                    lidar_heights.append(point_surface)
            plausible = [value for value in lidar_heights if 3.0 <= value <= 18.0]
            fallback_height = 4.5 + min(10.0, math.sqrt(polygon.area) * 0.25)
            height = float(np.percentile(plausible, 75)) if plausible else fallback_height
            height = max(4.0, min(18.0, height))
            rings = []
            for ring in [polygon.exterior, *polygon.interiors]:
                coordinates = [
                    [round(x - origin_x, 1), round(-(y - origin_y), 1)]
                    for x, y in list(ring.coords)[:-1]
                ]
                if len(coordinates) >= 3:
                    rings.append(coordinates)
            if not rings:
                continue
            exported_area += Polygon(rings[0], rings[1:]).area
            seed = (int(source_id) * 2654435761 + part_index * 2246822519) & 0xFFFFFFFF
            records.append([
                int(source_id),
                round(ground, 1),
                round(ground + height * 0.54, 1),
                round(ground + height, 1),
                seed,
                rings,
            ])
    return {
        "canopies": records,
        "source_area_m2": round(source_area, 2),
        "exported_area_m2": round(exported_area, 2),
        "area_drift_pct": round(abs(exported_area - source_area) / max(source_area, 1.0) * 100, 4),
    }


def load_building_records(footprints_path, height_path, dtm_path):
    """Yield (ground, height, polygon, metadata) per building footprint.

    OSM outlines and parts define mapped geometry; municipal photogrammetry
    footprints fill OSM gaps. Matched municipal heights take precedence, then
    robust interior LiDAR samples, then OSM height/level tags.
    """
    with rasterio.open(height_path) as height_raster_source, rasterio.open(dtm_path) as dtm_source:
        surface = height_raster_source.read(1, masked=True)
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = fill_nearest(dtm_raster.filled(0.0).astype(np.float32), ~np.asarray(dtm_raster.mask))
        dtm_transform = dtm_source.transform
        clip = valid_lidar_footprint(dtm_source)

    collection = json.loads(footprints_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:3857", LOCAL_CRS, always_xy=True)
    for feature in collection.get("features", []):
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), shape(feature["geometry"])).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        properties = feature.get("properties") or {}
        source_height = properties.get("BLD_HGT")
        source_id = properties.get("fid", properties.get("OBJECTID"))
        for polygon in parts:
            if polygon.is_empty or polygon.area < 2.0:
                continue
            polygon = polygon.simplify(0.45, preserve_topology=True)
            point = polygon.representative_point()
            ground = sample(dtm, dtm_transform, point.x, point.y, default=float("nan"))
            if not math.isfinite(ground):
                continue
            height_source = properties.get("HEIGHT_SRC") or "survey_height"
            try:
                height = float(source_height)
            except (TypeError, ValueError):
                height = float("nan")
            if not math.isfinite(height) or height <= 0:
                tags = properties.get("OSM_TAGS") or {}
                lidar_height = float("nan")
                try:
                    window = geometry_window(height_raster_source, [mapping(polygon)])
                    patch = surface[
                        int(window.row_off):int(window.row_off + window.height),
                        int(window.col_off):int(window.col_off + window.width),
                    ]
                    inside = geometry_mask(
                        [mapping(polygon.buffer(-0.5) if not polygon.buffer(-0.5).is_empty else polygon)],
                        out_shape=patch.shape,
                        transform=height_raster_source.window_transform(window),
                        invert=True,
                    )
                    valid_heights = patch.data.ravel()[inside.ravel() & ~np.ma.getmaskarray(patch).ravel()]
                    valid_heights = valid_heights[np.isfinite(valid_heights) & (valid_heights >= 2.0) & (valid_heights <= 160.0)]
                    if valid_heights.size:
                        median = float(np.median(valid_heights))
                        mad = float(np.median(np.abs(valid_heights - median)))
                        roof_values = valid_heights[valid_heights <= median + max(5.0, 4.5 * 1.4826 * mad)]
                        lidar_height = float(np.percentile(roof_values, 80))
                except (ValueError, WindowError):
                    pass
                if math.isfinite(lidar_height) and lidar_height > 0:
                    height = lidar_height
                    height_source = "lidar_2025"
                else:
                    explicit_osm_height = properties.get("OSM_TAGS", {}).get("height")
                    try:
                        height = float(str(explicit_osm_height).lower().replace("metres", "").replace("meters", "").replace("m", "").strip())
                    except (TypeError, ValueError):
                        height = float("nan")
                    if math.isfinite(height) and height > 0:
                        height_source = "osm_height"
                try:
                    levels = float(tags.get("building:levels", ""))
                    roof_levels = float(tags.get("roof:levels", 0) or 0)
                except (TypeError, ValueError):
                    levels, roof_levels = float("nan"), 0.0
                if not math.isfinite(height) and math.isfinite(levels) and 0 < levels <= 50:
                    height = levels * 3.2 + min(roof_levels, 3.0) * 2.5
                    height_source = "osm_levels"
                elif not math.isfinite(height):
                    # Prefer a conservative class-based estimate over heights
                    # sampled from trees, roof equipment, or neighbouring façades.
                    building_class = str(tags.get("building:part") or tags.get("building") or "").lower()
                    defaults = {
                        "house": 6.5, "detached": 6.5, "residential": 9.0,
                        "apartments": 15.0, "commercial": 12.0, "retail": 8.0,
                        "industrial": 9.0, "warehouse": 8.0, "church": 14.0,
                        "cathedral": 24.0, "office": 16.0, "school": 9.0,
                    }
                    base = defaults.get(building_class, 8.0)
                    # Large footprints suggest larger structures without
                    # allowing area alone to create implausibly tall blocks.
                    height = min(24.0, max(base, base + math.log1p(polygon.area / 250.0) * 1.5))
                    height_source = "osm_inferred"
            yield ground, max(2.5, min(140.0, height)), polygon, {
                "source_id": source_id,
                "height_source": height_source,
                "roof_shape_hint": properties.get("OSM_ROOF"),
                "osm_tags": properties.get("OSM_TAGS") or {},
                "osm_id": properties.get("OSM_ID"),
                "osm_type": properties.get("OSM_TYPE"),
                "acquisition_method": properties.get("ACQS_MTHD"),
                "acquisition_period": properties.get("ACQS_PRD"),
                # OSM building parts such as bridges and skyways can start
                # several metres above ground. Preserve that open volume.
                "min_height": building_min_height(
                    properties.get("OSM_MIN_HEIGHT"), height,
                    properties.get("OSM_MIN_LEVEL"), properties.get("OSM_LEVELS"),
                ),
            }


def build_compact_scene(building_records, roof_profiles, dtm_path, osm_path, green_path, instances, output, origin_x, origin_y, municipal_roads_path=None):
    """Write the compact footprint scene used by the browser viewer and analyses."""
    with rasterio.open(dtm_path) as dtm_source:
        dtm_raster = dtm_source.read(1, masked=True)
        valid = ~np.asarray(dtm_raster.mask)
        dtm = fill_nearest(dtm_raster.filled(0.0).astype(np.float32), valid)
        dtm_transform = dtm_source.transform
        raster_bounds = dtm_source.bounds
        clip = valid_lidar_footprint(dtm_source)

    buildings = []
    for building_index, (ground, height, polygon, metadata) in enumerate(building_records):
        ring = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in list(polygon.exterior.coords)[:-1]]
        if len(ring) >= 3:
            holes = [
                [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in list(interior.coords)[:-1]]
                for interior in polygon.interiors if len(interior.coords) >= 4
            ]
            profile = roof_profiles[building_index]
            # The compact scene's first three positions hold ground, height,
            # and footprint. Extra metadata lets the WebGL model expose
            # provenance without duplicating the source GeoJSON in-browser.
            buildings.append([
                round(ground, 1), round(height, 1), ring,
                metadata.get("source_id"), metadata.get("height_source"),
                round(profile["wall_height"], 1), profile["detailed"],
                round(profile["coverage"], 3), profile["roof_model"],
                [round(value, 1) for value in (profile.get("wall_profile") or [])] or None,
                round(metadata.get("min_height") or 0.0, 1),
                metadata.get("acquisition_method"), metadata.get("acquisition_period"),
                holes,
                {
                    **metadata.get("osm_tags", {}),
                    "osm:id": metadata.get("osm_id"),
                    "osm:type": metadata.get("osm_type"),
                } if metadata.get("osm_tags") else {},
            ])

    trees = [[round(float(value), 1) for value in row[:6]] for row in instances]
    osm_extract = load_osm(osm_path)
    municipal_tree, municipal_materials, municipal_segment_count = municipal_surface_index(municipal_roads_path, clip)
    roads = []
    municipal_matches = 0
    for highway, line, attributes in local_osm_transport(osm_path, clip, ("highway",), osm_extract):
        coordinates = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in line.coords]
        if len(coordinates) >= 2:
            try:
                width = float(str(attributes.get("width", "")).replace("m", "").strip())
            except ValueError:
                width = ROAD_WIDTHS.get(highway, 4.0)
            if not math.isfinite(width) or not 0.5 <= width <= 30:
                width = ROAD_WIDTHS.get(highway, 4.0)
            normalized_name = " ".join(str(attributes.get("name") or "").lower().replace("'", "").replace(".", "").split())
            if normalized_name in {"saint george s mall", "st george s mall", "saint georges mall", "st georges mall"}:
                # The named pedestrian mall is a full-width red-paved corridor;
                # OSM stores its centerline but not the paved area width.
                attributes["groundMaterialOverride"] = "red_pavers"
                attributes["renderWidthM"] = 14.0
                width = 14.0
            osm_surface = surface_material(attributes.get("surface"))
            if not osm_surface or osm_surface == "paved":
                municipal_surface = match_municipal_surface(line, municipal_tree, municipal_materials)
                if municipal_surface:
                    attributes["renderSurface"] = municipal_surface
                    attributes["municipalSurfaceSource"] = "City of Cape Town SURF_TYPE"
                    municipal_matches += 1
            roads.append([width, highway, coordinates, attributes])
    railways = []
    for railway, line, attributes in local_osm_transport(osm_path, clip, ("railway",), osm_extract):
        if railway not in {"rail", "tram", "light_rail"}:
            continue
        coordinates = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in line.coords]
        if len(coordinates) >= 2:
            railways.append([railway, coordinates, attributes])
    grass = []
    for polygon in local_green_areas(green_path, clip):
        ring = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in list(polygon.simplify(0.6, preserve_topology=True).exterior.coords)[:-1]]
        if len(ring) >= 3:
            grass.append(ring)
    ground_surfaces = local_ground_surfaces(osm_extract, clip, building_records, origin_x, origin_y)
    traffic_signals = local_traffic_signals(osm_extract, clip, origin_x, origin_y)
    terrain = compact_terrain_grid(
        dtm,
        valid.astype("uint8"),
        dtm_transform,
        raster_bounds,
        origin_x,
        origin_y,
        clip,
    )
    output.write_text(json.dumps({"buildings": buildings, "trees": trees, "roads": roads, "railways": railways, "grass": grass, "groundSurfaces": ground_surfaces, "trafficSignals": traffic_signals, "terrain": terrain}, separators=(",", ":")) + "\n", encoding="utf-8")
    return {
        "buildings": len(buildings), "trees": len(trees), "roads": len(roads),
        "railways": len(railways), "grass": len(grass), "groundSurfaces": len(ground_surfaces),
        "trafficSignals": len(traffic_signals),
        "municipalSurfaceSegments": municipal_segment_count, "municipalSurfaceMatches": municipal_matches,
        "bytes": output.stat().st_size,
    }


def parametric_roof_is_credible(
    polygon,
    coverage,
    shape_name,
    rise,
    half_short_m,
    shape_inlier_fraction,
    shape_rmse,
    flat_rmse,
    observed_range,
    roof_shape_hint=None,
):
    """Reject LiDAR roof fits that would create implausible spikes or pyramids.

    A one-metre surface raster is particularly noisy along walls and on large,
    irregular city blocks. Parametric roofs are therefore reserved for compact,
    mostly rectangular footprints with broad raster support and a meaningful
    improvement over a flat roof. Explicit OSM roof tags relax the outline
    thresholds slightly, but never the physical slope/rise limits.
    """
    if polygon.is_empty or polygon.area < 25.0 or polygon.interiors:
        return False

    hint = str(roof_shape_hint or "").strip().lower()
    hint_shapes = {
        "gable": "gable",
        "gabled": "gable",
        "hip": "hip",
        "hipped": "hip",
        "pyramid": "hip",
        "pyramidal": "hip",
        "pitched": "gable",
    }
    tagged_match = hint_shapes.get(hint) == shape_name
    # Do not replace an explicit roof description with a different primitive.
    # Unsupported forms (flat, dome, mansard, onion, and so on) are safer as a
    # clean regularized cap than as an invented gable or pyramid.
    if hint and not tagged_match:
        return False
    simplified = polygon.simplify(0.75, preserve_topology=True)
    vertex_count = max(0, len(simplified.exterior.coords) - 1)
    hull_area = max(float(polygon.convex_hull.area), 1e-6)
    rectangle_area = max(float(polygon.minimum_rotated_rectangle.area), 1e-6)
    convexity = float(polygon.area) / hull_area
    rectangularity = float(polygon.area) / rectangle_area

    if coverage < (0.64 if tagged_match else 0.72):
        return False
    if convexity < (0.72 if tagged_match else 0.82):
        return False
    if rectangularity < (0.58 if tagged_match else 0.70):
        return False
    if vertex_count > (24 if tagged_match else 16):
        return False
    if rise < 1.2 or rise > 8.0:
        return False
    if half_short_m <= 0.0 or rise / half_short_m > 0.65:
        return False
    if shape_name == "hip" and not tagged_match:
        if polygon.area > 350.0 or rise / half_short_m > 0.50:
            return False
    if rise > max(2.5, observed_range * 1.6):
        return False
    if polygon.area > (3200.0 if tagged_match else 2200.0):
        return False
    if shape_name == "hip" and polygon.area > (2400.0 if tagged_match else 1500.0):
        return False
    if shape_inlier_fraction < (0.66 if tagged_match else 0.72):
        return False
    if not math.isfinite(flat_rmse) or flat_rmse <= 1e-6:
        return False
    return shape_rmse <= flat_rmse * (0.80 if tagged_match else 0.74)


def build_roof_surface(building_records, height_path, dtm_path, output, origin_x, origin_y, stride=2):
    """Write the empty legacy roof buffer and OSM-based wall profiles."""
    # OSM is the sole source of building form. Keep the legacy binary asset
    # readable for older clients, but emit no raster-derived roof triangles.
    positions = np.empty((0, 3), dtype=np.float32)
    roof_heights = np.empty((0,), dtype=np.float32)
    indices = np.empty((0,), dtype=np.uint32)
    profiles = []
    for _ground, height, _polygon, metadata in building_records:
        profiles.append({
            "wall_height": height, "detailed": False, "coverage": 0.0,
            "roof_model": metadata.get("osm_tags", {}).get("roof:shape") or "osm_flat_fallback",
            "wall_profile": None,
        })
    with output.open("wb") as stream:
        stream.write(struct.pack("<II", 0, 0))
    return {
        "buildings": len(building_records), "detailed_buildings": 0,
        "fallback_buildings": len(building_records), "roof_models": {},
        "vertices": 0, "triangles": 0, "sample_spacing_m": None,
        "height_semantics": "municipal survey heights, then robust LiDAR height samples; no raster roof mesh",
        "bytes": output.stat().st_size,
    }, profiles


def write_canopy_asset(asset, output):
    output.write_text(
        json.dumps({
            "version": 1,
            "format": "[source_id,ground_y,crown_base_y,crown_top_y,seed,rings]",
            **asset,
        }, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return {
        "components": len(asset["canopies"]),
        "area_drift_pct": asset["area_drift_pct"],
        "bytes": output.stat().st_size,
        "cache_key": hashlib.sha256(output.read_bytes()).hexdigest()[:16],
    }


def write_lighting_asset(model, output):
    """Write the small subset of city furniture used by the lighting renderer.

    The full semantic model is intentionally kept out of the first scene load.
    Public lamp records are a compact, independently cacheable sidecar so the
    browser can render the mapped fixtures without parsing every city object.
    """
    fixtures = []
    for item in model.get("cityObjects", {}).values():
        if item.get("type") != "CityFurniture":
            continue
        geometry = item.get("geometry") or {}
        attributes = item.get("attributes") or {}
        fixture_class = attributes.get("class")
        if fixture_class not in {"publicLight", "festoonLighting"}:
            continue
        fixtures.append({
            "identifier": item.get("identifier"),
            "class": fixture_class,
            "coordinates": geometry.get("coordinates"),
            "centerline": geometry.get("centerline"),
            "attributes": attributes,
        })
    output.write_text(json.dumps({"cityFurniture": fixtures}, separators=(",", ":")) + "\n", encoding="utf-8")
    payload = output.read_bytes()
    return {
        "objects": len(fixtures),
        "publicLights": sum(item["class"] == "publicLight" for item in fixtures),
        "festoonInstallations": sum(item["class"] == "festoonLighting" for item in fixtures),
        "bytes": len(payload),
        "cache_key": hashlib.sha256(payload).hexdigest()[:16],
    }


def write_public_realm_asset(model, output):
    """Write a lazy-loaded inventory of mapped public-realm and street-use points."""
    supported_classes = {
        "bench", "bollard", "bicycleParking", "busStop", "fountain",
        "publicToilet", "streetClock", "wasteBasket",
    }
    records = []
    crossings = []
    parking = []
    for item in model.get("cityObjects", {}).values():
        geometry = item.get("geometry") or {}
        attributes = item.get("attributes") or {}
        feature_class = attributes.get("class")
        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) != 2:
            continue
        record = {
            "identifier": item.get("identifier"),
            "class": feature_class,
            "coordinates": coordinates,
            "attributes": attributes,
        }
        if item.get("type") == "CityFurniture" and feature_class in supported_classes:
            records.append(record)
        elif item.get("type") == "TrafficSpace" and feature_class == "pedestrianCrossing":
            crossings.append(record)
        elif item.get("type") == "AuxiliaryTrafficSpace" and feature_class == "parkingSpace":
            parking.append(record)
    records.sort(key=lambda item: (item["class"], item["identifier"] or ""))
    crossings.sort(key=lambda item: item["identifier"] or "")
    parking.sort(key=lambda item: item["identifier"] or "")
    output.write_text(json.dumps({"publicRealm": records, "crossings": crossings, "parking": parking}, separators=(",", ":")) + "\n", encoding="utf-8")
    payload = output.read_bytes()
    counts: dict[str, int] = {}
    for item in records:
        counts[item["class"]] = counts.get(item["class"], 0) + 1
    return {
        "features": len(records),
        "classes": counts,
        "crossings": len(crossings),
        "parking_spaces": len(parking),
        "bytes": len(payload),
        "cache_key": hashlib.sha256(payload).hexdigest()[:16],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dtm", type=Path, default=Path("data/derived/company_gardens_hybrid_dem_2m.tif"))
    parser.add_argument("--height", type=Path, default=Path("data/raw/LiDAR2025/Lidar2025_Height_Map_1m.tif"))
    parser.add_argument("--footprints", type=Path, default=Path("data/derived/BuildingFootprintsHybrid.geojson"))
    parser.add_argument("--trees", type=Path, default=Path("data/raw/tree_canopy.geojson"))
    parser.add_argument("--roads", type=Path, default=Path("data/osm_cbd_roads.geojson"))
    parser.add_argument("--railways", type=Path, default=Path("data/osm_cbd_railways.geojson"))
    parser.add_argument("--green", type=Path, default=Path("data/osm_cbd_green_areas.geojson"))
    parser.add_argument("--osm", type=Path, default=Path("data/osm_cbd.osm.xml"))
    parser.add_argument("--street-data", type=Path, default=Path("data/street_data"))
    parser.add_argument("--scene-footprint", type=Path, default=Path("data/scene_footprint.geojson"))
    parser.add_argument("--out", type=Path, default=Path("public/assets"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    write_lidar_footprint(args.dtm, args.scene_footprint)
    with rasterio.open(args.dtm) as source:
        origin_x = (source.bounds.left + source.bounds.right) / 2.0
        origin_y = (source.bounds.bottom + source.bounds.top) / 2.0
        bounds = source.bounds
        valid_cells = int((source.read_masks(1) > 0).sum())
        provenance = source.read(2) if source.count >= 2 else None
        terrain_metadata = {
            "source": str(args.dtm),
            "resolution_m": abs(source.transform.a),
            "valid_area_m2": round(valid_cells * abs(source.transform.a * source.transform.e), 1),
            "lidar_cells": int((provenance == 1).sum()) if provenance is not None else valid_cells,
            "coarse_cells": int((provenance == 2).sum()) if provenance is not None else 0,
            "coarse_source": "calibrated_30m_srtm_company_gardens" if provenance is not None else None,
        }
    manifest = {
        "version": 3,
        "crs": "custom Hartbeesthoek94 Lo19 east/north grid",
        "origin": [origin_x, origin_y],
        "bounds": [bounds.left - origin_x, bounds.bottom - origin_y, bounds.right - origin_x, bounds.top - origin_y],
        "building_record": "[ground_y,height,outer_ring,source_id,height_source,wall_height,detailed_roof,coverage,roof_model,wall_profile,min_height,acquisition_method,acquisition_period,interior_rings,osm_attributes]",
        "layers": {"terrain": terrain_metadata},
        "assets": {
            "fallback": "fallback.json",
            "city_model": "city_model.json",
            "canopy": "canopy.json",
            "lighting": "lighting.json",
            "public_realm": "public_realm.json",
            "roof_surface": "roof_surface.bin",
        },
        "buildInputs": {
            name: source_fingerprint(path)
            for name, path in {
                "terrain": args.dtm, "height": args.height, "buildings": args.footprints,
                "canopy": args.trees, "roads": args.roads, "railways": args.railways,
                "green": args.green, "osm": args.osm, "streetData": args.street_data,
            }.items()
        },
    }
    instances = build_tree_instances(args.trees, args.height, args.dtm, origin_x, origin_y)
    canopies = build_canopy_records(args.trees, args.height, args.dtm, origin_x, origin_y)
    building_records = list(load_building_records(args.footprints, args.height, args.dtm))
    roof_metadata, roof_profiles = build_roof_surface(
        building_records,
        args.height,
        args.dtm,
        args.out / "roof_surface.bin",
        origin_x,
        origin_y,
    )
    manifest["layers"]["roof_surface"] = roof_metadata
    manifest["layers"]["fallback"] = build_compact_scene(
        building_records,
        roof_profiles,
        args.dtm,
        args.osm,
        args.green,
        instances,
        args.out / "fallback.json",
        origin_x,
        origin_y,
        args.street_data / "TCT_Road_Centerline.geojson",
    )
    manifest["layers"]["canopy"] = write_canopy_asset(canopies, args.out / "canopy.json")
    compact_scene = json.loads((args.out / "fallback.json").read_text(encoding="utf-8"))
    city_model = build_city_model(
        compact_scene,
        canopies,
        manifest,
        {
            "terrain": args.dtm,
            "height": args.height,
            "buildings": args.footprints,
            "canopy": args.trees,
            "roads": args.roads,
            "railways": args.railways,
            "green": args.green,
            "osm": args.osm,
            "street_data": args.street_data,
        },
    )
    add_semantic_renderer_context(compact_scene, city_model)
    fallback_path = args.out / "fallback.json"
    fallback_path.write_text(json.dumps(compact_scene, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest["layers"]["fallback"].update({
        "water": len(compact_scene["water"]),
        "bytes": fallback_path.stat().st_size,
        "cache_key": hashlib.sha256(fallback_path.read_bytes()).hexdigest()[:16],
    })
    manifest["layers"]["city_model"] = write_city_model(city_model, args.out / "city_model.json")
    manifest["layers"]["lighting"] = write_lighting_asset(city_model, args.out / "lighting.json")
    manifest["layers"]["public_realm"] = write_public_realm_asset(city_model, args.out / "public_realm.json")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
