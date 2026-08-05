#!/usr/bin/env python3
"""Build the Canvas2D compatibility scene (fallback.json) from the supplied Cape Town datasets."""

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
from rasterio.features import rasterize, shapes
from rasterio.warp import reproject
from scipy.ndimage import distance_transform_edt, find_objects, median_filter
from scipy.spatial import Delaunay, QhullError
from shapely.geometry import LineString, Point, Polygon, box, mapping, shape
from shapely.ops import transform as transform_geometry, unary_union

from city_model import build_city_model, write_city_model

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROAD_WIDTHS = {"motorway": 15.0, "trunk": 13.0, "primary": 11.0, "secondary": 9.0, "tertiary": 7.0, "residential": 5.5, "unclassified": 5.5, "living_street": 5.0, "service": 4.0, "pedestrian": 4.0, "cycleway": 2.5, "footway": 2.0, "path": 1.5}


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
        "name": "climateExplorer_valid_lidar_footprint",
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


def local_roads(roads_path, clip):
    collection = json.loads(roads_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    for feature in collection.get("features", []):
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        if len(coordinates) < 2:
            continue
        properties = feature.get("properties") or {}
        highway = properties.get("highway", "residential")
        line = LineString([transformer.transform(x, y) for x, y in coordinates]).intersection(clip)
        parts = line.geoms if line.geom_type == "MultiLineString" else (line,)
        for part in parts:
            if not part.is_empty and len(part.coords) >= 2:
                yield highway, part.simplify(0.35, preserve_topology=False)


def local_railways(railways_path, clip):
    """Yield active rail and tram centre-lines clipped to the scene."""
    collection = json.loads(railways_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    for feature in collection.get("features", []):
        properties = feature.get("properties") or {}
        railway = properties.get("railway")
        if railway not in {"rail", "tram", "light_rail"}:
            continue
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        if len(coordinates) < 2:
            continue
        line = LineString([transformer.transform(x, y) for x, y in coordinates]).intersection(clip)
        parts = line.geoms if line.geom_type == "MultiLineString" else (line,)
        for part in parts:
            if not part.is_empty and len(part.coords) >= 2:
                yield railway, part.simplify(0.2, preserve_topology=False)


def local_green_areas(green_path, clip):
    collection = json.loads(green_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    for feature in collection.get("features", []):
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), shape(feature["geometry"])).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        for polygon in parts:
            if not polygon.is_empty and polygon.area >= 12.0:
                yield polygon


def canvas_terrain_grid(dtm, valid, transform, bounds, origin_x, origin_y, footprint, size=192):
    """An elevation grid grounds the renderer's roads and terrain mesh.

    The CBD climbs almost 50m from the harbour toward the mountain, and a
    single grid cell at the old size=32 spanned ~65m x ~58m - wide enough for
    the DTM to vary by several metres within one cell. Roads and the terrain
    mesh are draped on this bilinearly-interpolated grid, while buildings use
    a direct per-building DTM sample, so that coarse grid made roads drift
    vertically relative to nearby building bases and visibly cut through
    rooftops on sloped blocks.
    """
    left, bottom, right, top = bounds
    heights = []
    validity = []
    for row in range(size):
        y = top - (top - bottom) * row / (size - 1)
        for column in range(size):
            x = left + (right - left) * column / (size - 1)
            heights.append(round(sample(dtm, transform, x, y), 2))
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
    """Place tree instances (position, crown size, height, orientation) for the canvas renderer."""
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

    The 1 m raster stores surface height above ground and contains trees and
    other objects. It is used only as a fallback when a footprint has no
    BLD_HGT; the footprint layer remains authoritative for building presence
    and outline geometry.
    """
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        surface_raster = height_source.read(1, masked=True)
        surface = fill_nearest(surface_raster.filled(0.0).astype(np.float32), ~np.asarray(surface_raster.mask))
        surface_transform = height_source.transform
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
            height_source = "survey_height"
            try:
                height = float(source_height)
            except (TypeError, ValueError):
                height = float("nan")
            if not math.isfinite(height) or height <= 0:
                height_source = "lidar_surface_fallback"
                surface_height = sample(surface, surface_transform, point.x, point.y, default=float("nan"))
                height = surface_height if math.isfinite(surface_height) else 6.0
            yield ground, max(2.5, min(140.0, height)), polygon, {
                "source_id": source_id,
                "height_source": height_source,
                "acquisition_method": properties.get("ACQS_MTHD"),
                "acquisition_period": properties.get("ACQS_PRD"),
            }


def build_canvas_fallback(building_records, roof_profiles, dtm_path, roads_path, railways_path, green_path, instances, output, origin_x, origin_y):
    """Write the compact footprint scene the Canvas2D renderer loads."""
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
            profile = roof_profiles[building_index]
            # The first three positions remain backward compatible with the
            # Canvas renderer. Extra metadata lets the WebGL model expose
            # provenance without duplicating the source GeoJSON in-browser.
            buildings.append([
                round(ground, 1), round(height, 1), ring,
                metadata.get("source_id"), metadata.get("height_source"),
                round(profile["wall_height"], 1), profile["detailed"],
                round(profile["coverage"], 3), profile["roof_model"],
                [round(value, 1) for value in (profile.get("wall_profile") or [])] or None,
                metadata.get("acquisition_method"), metadata.get("acquisition_period"),
            ])

    trees = [[round(float(value), 1) for value in row[:6]] for row in instances]
    roads = []
    for highway, line in local_roads(roads_path, clip):
        coordinates = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in line.coords]
        if len(coordinates) >= 2:
            roads.append([ROAD_WIDTHS.get(highway, 4.0), highway, coordinates])
    railways = []
    for railway, line in local_railways(railways_path, clip):
        coordinates = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in line.coords]
        if len(coordinates) >= 2:
            railways.append([railway, coordinates])
    grass = []
    for polygon in local_green_areas(green_path, clip):
        ring = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in list(polygon.simplify(0.6, preserve_topology=True).exterior.coords)[:-1]]
        if len(ring) >= 3:
            grass.append(ring)
    terrain = canvas_terrain_grid(
        dtm,
        valid.astype("uint8"),
        dtm_transform,
        raster_bounds,
        origin_x,
        origin_y,
        clip,
    )
    output.write_text(json.dumps({"buildings": buildings, "trees": trees, "roads": roads, "railways": railways, "grass": grass, "terrain": terrain}, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"buildings": len(buildings), "trees": len(trees), "roads": len(roads), "railways": len(railways), "grass": len(grass), "bytes": output.stat().st_size}


def build_roof_surface(building_records, height_path, dtm_path, output, origin_x, origin_y, stride=2):
    """Build regularised roof geometry from the normalised height raster.

    Standard raster-LiDAR cleanup is applied per building: coverage testing,
    robust percentile rejection, nearest-neighbour gap filling, median
    filtering, surveyed-height anchoring, and least-squares roof-plane fitting
    where residuals support a gently planar model. Ambiguous surfaces become a
    robust flat roof instead of preserving trees, edge mixing, or raster
    spikes. Buildings without sufficient raster coverage are marked for the
    authoritative 2D-height fallback.

    Binary layout (little endian):
      uint32 vertex_count, uint32 index_count,
      float32 positions[vertex_count * 3],
      float32 heights[vertex_count],
      uint32 indices[index_count]
    """
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        height_raster = height_source.read(1, masked=True)
        heights = height_raster.filled(float("nan")).astype(np.float32)
        ground = np.full(heights.shape, np.nan, dtype=np.float32)
        reproject(
            source=rasterio.band(dtm_source, 1),
            destination=ground,
            src_transform=dtm_source.transform,
            src_crs=dtm_source.crs,
            src_nodata=dtm_source.nodata,
            dst_transform=height_source.transform,
            dst_crs=height_source.crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        transform = height_source.transform
        out_shape = heights.shape

    raster_shapes = [
        (mapping(record[2]), building_index + 1)
        for building_index, record in enumerate(building_records)
    ]
    building_ids = rasterize(
        raster_shapes,
        out_shape=out_shape,
        transform=transform,
        fill=0,
        dtype=np.int32,
        all_touched=False,
    )
    processed = np.full(heights.shape, np.nan, dtype=np.float32)
    profiles = [
        {
            "coverage": 0.0,
            "wall_height": float(record[1]),
            "detailed": False,
            "roof_model": "height_fallback",
            "wall_profile": None,
        }
        for record in building_records
    ]
    candidate = np.zeros(len(building_records) + 1, dtype=bool)
    model_patches = [None] * len(building_records)
    pixel_area = abs(transform.a * transform.e)
    object_slices = find_objects(building_ids)

    for building_index, record in enumerate(building_records):
        object_slice = object_slices[building_index] if building_index < len(object_slices) else None
        if object_slice is None:
            continue
        row_start = object_slice[0].start
        column_start = object_slice[1].start
        local_ids = building_ids[object_slice]
        footprint = local_ids == building_index + 1
        local_heights = heights[object_slice]
        valid = (
            footprint
            & np.isfinite(local_heights)
            & (local_heights >= 2.0)
            & (local_heights <= 140.0)
        )
        expected_pixels = max(1.0, record[2].area / max(pixel_area, 1e-6))
        coverage = min(1.0, float(np.count_nonzero(valid)) / expected_pixels)
        profiles[building_index]["coverage"] = coverage
        if np.count_nonzero(valid) < 12 or coverage < 0.55:
            continue

        # The footprint attribute is the strongest building-height evidence we
        # have. Use it to reject canopy, neighbouring towers, and façade-edge
        # pixels before fitting a roof. Keep an unanchored path for buildings
        # whose height itself came from the raster.
        if record[3].get("height_source") == "survey_height":
            expected_height = float(record[1])
            tolerance = max(3.0, min(12.0, expected_height * 0.25))
            anchored = (
                valid
                & (local_heights >= expected_height - tolerance)
                & (local_heights <= expected_height + tolerance)
            )
            minimum_anchor_pixels = max(8, int(np.count_nonzero(valid) * 0.35))
            if np.count_nonzero(anchored) >= minimum_anchor_pixels:
                valid = anchored

        observed = local_heights[valid]
        low, high = np.percentile(observed, [5, 95])
        cleaned_valid = valid & (local_heights >= low) & (local_heights <= high)
        if np.count_nonzero(cleaned_valid) < 8:
            continue
        nearest = distance_transform_edt(
            ~cleaned_valid,
            return_distances=False,
            return_indices=True,
        )
        filled = np.clip(local_heights[tuple(nearest)], low, high)
        denoised = median_filter(filled, size=3, mode="nearest")
        roof_values = denoised[footprint]
        p10, p90 = np.percentile(roof_values, [10, 90])

        local_rows, local_columns = np.nonzero(footprint)
        design = np.column_stack((
            local_columns.astype(np.float64),
            local_rows.astype(np.float64),
            np.ones(len(local_rows), dtype=np.float64),
        ))
        target = roof_values.astype(np.float64)
        inliers = np.ones(len(target), dtype=bool)
        coefficients = np.linalg.lstsq(design, target, rcond=None)[0]
        for _ in range(3):
            residuals = target - design @ coefficients
            residual_median = float(np.median(residuals[inliers]))
            mad = float(np.median(np.abs(residuals[inliers] - residual_median)))
            threshold = max(0.45, 2.8 * 1.4826 * mad)
            next_inliers = np.abs(residuals - residual_median) <= threshold
            if np.count_nonzero(next_inliers) < max(8, int(len(target) * 0.35)):
                break
            inliers = next_inliers
            coefficients = np.linalg.lstsq(design[inliers], target[inliers], rcond=None)[0]
        fitted_values = design @ coefficients
        rmse = float(np.sqrt(np.mean((fitted_values[inliers] - target[inliers]) ** 2)))
        inlier_fraction = float(np.count_nonzero(inliers)) / len(inliers)
        slope = float(math.hypot(coefficients[0], coefficients[1]))
        half_metre_bins = np.round(target * 2.0).astype(np.int32)
        bin_values, bin_counts = np.unique(half_metre_bins, return_counts=True)
        dominant_bin = bin_values[int(np.argmax(bin_counts))]
        dominant = np.abs(target - dominant_bin / 2.0) <= 0.75
        dominant_fraction = float(np.count_nonzero(dominant)) / len(target)

        # Fit two architectural roof volumes against the cleaned samples. The
        # minimum-area footprint rectangle supplies the ridge orientation,
        # which remains stable for L-shaped and courtyard buildings where PCA
        # can turn the roof away from its actual walls. A gable has a
        # full-length ridge; a hip tapers toward all four sides.
        roof_shape = None
        roof_shape_rmse = float("inf")
        footprint_coordinates = np.column_stack((local_columns, local_rows)).astype(np.float64)
        footprint_center = footprint_coordinates.mean(axis=0)
        centered = footprint_coordinates - footprint_center
        if len(centered) >= 8:
            rectangle = record[2].minimum_rotated_rectangle
            rectangle_pixels = []
            for x, y in list(rectangle.exterior.coords)[:4]:
                raster_column, raster_row = (~transform) * (x, y)
                rectangle_pixels.append((
                    raster_column - column_start,
                    raster_row - row_start,
                ))
            rectangle_pixels = np.asarray(rectangle_pixels, dtype=np.float64)
            rectangle_edges = np.roll(rectangle_pixels, -1, axis=0) - rectangle_pixels
            edge_lengths = np.linalg.norm(rectangle_edges, axis=1)
            longest_edge = rectangle_edges[int(np.argmax(edge_lengths))]
            if float(np.linalg.norm(longest_edge)) > 1e-6:
                long_axis = longest_edge / np.linalg.norm(longest_edge)
            else:
                covariance = np.cov(centered, rowvar=False)
                eigenvalues, eigenvectors = np.linalg.eigh(covariance)
                long_axis = eigenvectors[:, int(np.argmax(eigenvalues))]
            short_axis = np.array([-long_axis[1], long_axis[0]])
            long_projection = centered @ long_axis
            short_projection = centered @ short_axis
            half_long = max(1.0, float(np.percentile(np.abs(long_projection), 98)))
            half_short = max(1.0, float(np.percentile(np.abs(short_projection), 98)))
            row_grid, column_grid = np.indices(denoised.shape)
            grid_centered = np.column_stack((
                column_grid.ravel() - footprint_center[0],
                row_grid.ravel() - footprint_center[1],
            ))
            grid_long = (grid_centered @ long_axis).reshape(denoised.shape)
            grid_short = (grid_centered @ short_axis).reshape(denoised.shape)
            gable_factor = np.clip(1.0 - np.abs(grid_short) / half_short, 0.0, 1.0)
            hip_factor = np.clip(
                np.minimum(
                    1.0 - np.abs(grid_short) / half_short,
                    1.0 - np.abs(grid_long) / half_long,
                ),
                0.0,
                1.0,
            )
            for shape_name, factor in (("gable", gable_factor), ("hip", hip_factor)):
                factor_values = factor[footprint]
                shape_inliers = np.ones(len(target), dtype=bool)
                rise = 0.0
                base = float(np.median(target))
                for _ in range(3):
                    selected_factor = factor_values[shape_inliers]
                    selected_target = target[shape_inliers]
                    factor_mean = float(np.mean(selected_factor))
                    target_mean = float(np.mean(selected_target))
                    variance = float(np.sum((selected_factor - factor_mean) ** 2))
                    if variance < 1e-6:
                        break
                    rise = float(np.sum(
                        (selected_factor - factor_mean) * (selected_target - target_mean)
                    ) / variance)
                    rise = max(0.0, min(rise, max(2.0, min(18.0, float(record[1]) * 0.45))))
                    base = float(np.mean(selected_target - rise * selected_factor))
                    residual = target - (base + rise * factor_values)
                    residual_median = float(np.median(residual[shape_inliers]))
                    mad = float(np.median(np.abs(residual[shape_inliers] - residual_median)))
                    next_inliers = np.abs(residual - residual_median) <= max(0.6, 2.8 * 1.4826 * mad)
                    if np.count_nonzero(next_inliers) < max(8, int(len(target) * 0.55)):
                        break
                    shape_inliers = next_inliers
                prediction = base + rise * factor_values
                shape_rmse = float(np.sqrt(np.mean((prediction[shape_inliers] - target[shape_inliers]) ** 2)))
                flat_height = float(np.mean(target[shape_inliers]))
                flat_rmse = float(np.sqrt(np.mean((target[shape_inliers] - flat_height) ** 2)))
                shape_inlier_fraction = float(np.count_nonzero(shape_inliers)) / len(target)
                if (
                    rise >= 1.2
                    and shape_inlier_fraction >= 0.62
                    and shape_rmse < roof_shape_rmse
                    and shape_rmse <= flat_rmse * 0.82
                ):
                    roof_shape = (shape_name, base, rise, factor)
                    roof_shape_rmse = shape_rmse

        if p90 - p10 <= 0.85:
            modelled = np.full_like(denoised, float(np.median(roof_values)))
            roof_model = "flat_plane"
        elif roof_shape is not None:
            shape_name, base, rise, factor = roof_shape
            modelled = np.clip(base + rise * factor, low, high).astype(np.float32)
            roof_model = f"parametric_{shape_name}"
        elif rmse <= 0.45 and inlier_fraction >= 0.70 and slope <= 0.35:
            row_grid, column_grid = np.indices(denoised.shape)
            modelled = (
                coefficients[0] * column_grid
                + coefficients[1] * row_grid
                + coefficients[2]
            ).astype(np.float32)
            modelled = np.clip(modelled, low, high)
            roof_model = "fitted_plane"
        elif dominant_fraction >= 0.45:
            dominant_height = float(np.median(target[dominant]))
            modelled = np.full_like(denoised, dominant_height)
            roof_model = "dominant_flat"
        else:
            # A 1 m normalised raster cannot reliably distinguish roof detail
            # from trees, plant rooms, façade mixing, or registration error.
            # Prefer a clean, footprint-aligned mass over a draped surface.
            if record[3].get("height_source") == "survey_height":
                regular_height = float(record[1])
            else:
                regular_height = float(np.median(target[inliers]))
            regular_height = max(float(low), min(float(high), regular_height))
            modelled = np.full_like(denoised, regular_height)
            roof_model = "regularized_flat"

        # The principal roof level is a better façade termination than the
        # lowest DSM edge pixels, which commonly contain wall/ground mixing.
        wall_height = float(np.percentile(modelled[footprint], 40))
        wall_height = max(2.5, min(140.0, wall_height))
        processed_patch = processed[object_slice]
        processed_patch[footprint] = modelled[footprint]
        profiles[building_index]["wall_height"] = wall_height
        profiles[building_index]["roof_model"] = roof_model
        model_patches[building_index] = (object_slice, modelled)
        candidate[building_index + 1] = True

    all_positions = []
    all_heights = []
    all_indices = []
    detailed_ids = set()

    for building_index, record in enumerate(building_records):
        if not candidate[building_index + 1] or model_patches[building_index] is None:
            continue
        object_slice, modelled = model_patches[building_index]
        row_start, column_start = object_slice[0].start, object_slice[1].start
        polygon = record[2]
        boundary = list(polygon.exterior.coords)[:-1]
        if len(boundary) < 3:
            continue

        point_coordinates = []
        point_heights = []
        point_elevations = []
        seen = set()

        def append_point(x, y, roof_height, ground_height):
            key = (round(x, 3), round(y, 3))
            if key in seen:
                return
            seen.add(key)
            point_coordinates.append((float(x), float(y)))
            point_heights.append(float(roof_height))
            point_elevations.append(float(ground_height + roof_height))

        wall_profile = []
        for x, y in boundary:
            # Match each façade top to the regularised roof model. This keeps
            # flat roofs crisp and lets a fitted plane meet the wall without
            # creating the near-vertical wedges produced by a constant eave.
            raster_row, raster_column = rasterio.transform.rowcol(transform, x, y)
            local_row = raster_row - row_start
            local_column = raster_column - column_start
            if 0 <= local_row < modelled.shape[0] and 0 <= local_column < modelled.shape[1]:
                roof_height = float(modelled[local_row, local_column])
            else:
                roof_height = profiles[building_index]["wall_height"]
            append_point(x, y, roof_height, record[0])
            wall_profile.append(roof_height)

        local_ids = building_ids[object_slice]
        local_processed = processed[object_slice]
        local_ground = ground[object_slice]
        local_rows, local_columns = np.nonzero(
            (local_ids == building_index + 1)
            & np.isfinite(local_processed)
            & np.isfinite(local_ground)
        )
        keep = (
            ((local_rows + row_start) % stride == 0)
            & ((local_columns + column_start) % stride == 0)
        )
        local_rows = local_rows[keep]
        local_columns = local_columns[keep]
        raster_rows = local_rows + row_start
        raster_columns = local_columns + column_start
        xs, ys = rasterio.transform.xy(transform, raster_rows, raster_columns, offset="center")
        for point_index, (x, y) in enumerate(zip(xs, ys)):
            local_row = local_rows[point_index]
            local_column = local_columns[point_index]
            append_point(
                x,
                y,
                local_processed[local_row, local_column],
                local_ground[local_row, local_column],
            )

        if len(point_coordinates) < 3:
            continue
        coordinates = np.asarray(point_coordinates, dtype=np.float64)
        try:
            triangulation = Delaunay(coordinates)
        except QhullError:
            continue
        triangles = triangulation.simplices.astype(np.int32)
        triangle_coordinates = coordinates[triangles]
        triangle_polygons = shapely.polygons(triangle_coordinates)
        triangle_areas = shapely.area(triangle_polygons)
        inside = (triangle_areas > 1e-5) & shapely.covers(polygon, triangle_polygons)
        triangles = triangles[inside]
        if not len(triangles):
            continue
        signed_areas = (
            (coordinates[triangles[:, 1], 0] - coordinates[triangles[:, 0], 0])
            * (coordinates[triangles[:, 2], 1] - coordinates[triangles[:, 0], 1])
            - (coordinates[triangles[:, 1], 1] - coordinates[triangles[:, 0], 1])
            * (coordinates[triangles[:, 2], 0] - coordinates[triangles[:, 0], 0])
        )
        reverse = signed_areas < 0
        triangles[reverse, 1], triangles[reverse, 2] = (
            triangles[reverse, 2].copy(),
            triangles[reverse, 1].copy(),
        )
        local_triangles = triangles.reshape(-1)

        vertex_offset = len(all_heights)
        all_positions.extend(
            (
                x - origin_x,
                point_elevations[index],
                -(y - origin_y),
            )
            for index, (x, y) in enumerate(point_coordinates)
        )
        all_heights.extend(point_heights)
        all_indices.extend((vertex_offset + local_triangles).tolist())
        detailed_ids.add(building_index + 1)
        profiles[building_index]["wall_profile"] = wall_profile

    positions = np.asarray(all_positions, dtype="<f4")
    roof_heights = np.asarray(all_heights, dtype="<f4")
    indices = np.asarray(all_indices, dtype="<u4")
    for building_index, profile in enumerate(profiles):
        profile["detailed"] = building_index + 1 in detailed_ids
        if not profile["detailed"]:
            profile["wall_height"] = float(building_records[building_index][1])
            profile["roof_model"] = "height_fallback"
            profile["wall_profile"] = None

    with output.open("wb") as stream:
        stream.write(struct.pack("<II", len(positions), len(indices)))
        stream.write(positions.tobytes(order="C"))
        stream.write(roof_heights.tobytes(order="C"))
        stream.write(indices.tobytes(order="C"))
    model_counts = {}
    for profile in profiles:
        model_counts[profile["roof_model"]] = model_counts.get(profile["roof_model"], 0) + 1
    metadata = {
        "buildings": len(building_records),
        "detailed_buildings": len(detailed_ids),
        "fallback_buildings": len(building_records) - len(detailed_ids),
        "roof_models": model_counts,
        "vertices": len(positions),
        "triangles": len(indices) // 3,
        "sample_spacing_m": stride,
        "height_semantics": "height_above_dtm",
        "bytes": output.stat().st_size,
        "cache_key": hashlib.sha256(output.read_bytes()).hexdigest()[:16],
    }
    return metadata, profiles


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
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dtm", type=Path, default=Path("data/derived/company_gardens_hybrid_dem_2m.tif"))
    parser.add_argument("--height", type=Path, default=Path("data/raw/LiDAR2025/Lidar2025_Height_Map_1m.tif"))
    parser.add_argument("--footprints", type=Path, default=Path("data/raw/BuildingFootprints2D.geojson"))
    parser.add_argument("--trees", type=Path, default=Path("data/raw/tree_canopy.geojson"))
    parser.add_argument("--roads", type=Path, default=Path("data/osm_cbd_roads.geojson"))
    parser.add_argument("--railways", type=Path, default=Path("data/osm_cbd_railways.geojson"))
    parser.add_argument("--green", type=Path, default=Path("data/osm_cbd_green_areas.geojson"))
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
        "building_record": "[ground_y,height,outer_ring,source_id,height_source,wall_height,detailed_roof,coverage,roof_model,wall_profile,acquisition_method,acquisition_period]",
        "layers": {"terrain": terrain_metadata},
        "assets": {
            "fallback": "fallback.json",
            "city_model": "city_model.json",
            "canopy": "canopy.json",
            "roof_surface": "roof_surface.bin",
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
    manifest["layers"]["fallback"] = build_canvas_fallback(
        building_records,
        roof_profiles,
        args.dtm,
        args.roads,
        args.railways,
        args.green,
        instances,
        args.out / "fallback.json",
        origin_x,
        origin_y,
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
            "street_data": args.street_data,
        },
    )
    manifest["layers"]["city_model"] = write_city_model(city_model, args.out / "city_model.json")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
