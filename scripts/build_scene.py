#!/usr/bin/env python3
"""Build the Canvas2D compatibility scene (fallback.json) from the supplied Cape Town datasets."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from scipy.ndimage import distance_transform_edt
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import transform as transform_geometry

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROAD_WIDTHS = {"motorway": 15.0, "trunk": 13.0, "primary": 11.0, "secondary": 9.0, "tertiary": 7.0, "residential": 5.5, "unclassified": 5.5, "living_street": 5.0, "service": 4.0, "pedestrian": 4.0, "cycleway": 2.5, "footway": 2.0, "path": 1.5}


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


def local_green_areas(green_path, clip):
    collection = json.loads(green_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    for feature in collection.get("features", []):
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), shape(feature["geometry"])).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        for polygon in parts:
            if not polygon.is_empty and polygon.area >= 12.0:
                yield polygon


def canvas_terrain_grid(dtm, transform, bounds, origin_x, origin_y, size=128):
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
    for row in range(size):
        y = top - (top - bottom) * row / (size - 1)
        for column in range(size):
            x = left + (right - left) * column / (size - 1)
            heights.append(round(sample(dtm, transform, x, y), 2))
    return {"columns": size, "rows": size, "heights": heights, "base": round(float(np.percentile(heights, 2)) - 12.0, 2)}


def build_tree_instances(tree_path, height_path, dtm_path, origin_x, origin_y):
    """Place tree instances (position, crown size, height, orientation) for the canvas renderer."""
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        surface_raster = height_source.read(1, masked=True)
        surface = fill_nearest(surface_raster.filled(0.0).astype(np.float32), ~np.asarray(surface_raster.mask))
        surface_transform = height_source.transform
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = fill_nearest(dtm_raster.filled(0.0).astype(np.float32), ~np.asarray(dtm_raster.mask))
        dtm_transform = dtm_source.transform
        clip = box(*dtm_source.bounds)
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
        lidar_height = sample_median(surface, surface_transform, point.x, point.y, radius=2) - ground
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
        clip = box(*dtm_source.bounds)
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
                point_ground = sample(dtm, dtm_transform, point.x, point.y, default=float("nan"))
                point_surface = sample_median(surface, surface_transform, point.x, point.y, radius=2)
                if math.isfinite(point_ground) and math.isfinite(point_surface):
                    lidar_heights.append(point_surface - point_ground)
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
    """Yield (ground, height, polygon) per building footprint, in raw local CRS.

    The 1 m height raster is a mixed surface model containing trees and other
    objects. It is used only as a fallback when a footprint has no BLD_HGT;
    the footprint layer is the authoritative source for building presence and
    outline geometry.
    """
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        surface_raster = height_source.read(1, masked=True)
        surface = fill_nearest(surface_raster.filled(0.0).astype(np.float32), ~np.asarray(surface_raster.mask))
        surface_transform = height_source.transform
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = fill_nearest(dtm_raster.filled(0.0).astype(np.float32), ~np.asarray(dtm_raster.mask))
        dtm_transform = dtm_source.transform
        clip = box(*dtm_source.bounds)

    collection = json.loads(footprints_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:3857", LOCAL_CRS, always_xy=True)
    for feature in collection.get("features", []):
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), shape(feature["geometry"])).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        source_height = (feature.get("properties") or {}).get("BLD_HGT")
        for polygon in parts:
            if polygon.is_empty or polygon.area < 2.0:
                continue
            polygon = polygon.simplify(0.45, preserve_topology=True)
            point = polygon.representative_point()
            ground = sample(dtm, dtm_transform, point.x, point.y, default=float("nan"))
            if not math.isfinite(ground):
                continue
            try:
                height = float(source_height)
            except (TypeError, ValueError):
                height = float("nan")
            if not math.isfinite(height) or height <= 0:
                surface_height = sample(surface, surface_transform, point.x, point.y, default=float("nan"))
                height = surface_height - ground if math.isfinite(surface_height) else 6.0
            yield ground, max(2.5, min(140.0, height)), polygon


def build_canvas_fallback(footprints_path, height_path, dtm_path, roads_path, green_path, instances, output, origin_x, origin_y):
    """Write the compact footprint scene the Canvas2D renderer loads."""
    with rasterio.open(dtm_path) as dtm_source:
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = fill_nearest(dtm_raster.filled(0.0).astype(np.float32), ~np.asarray(dtm_raster.mask))
        dtm_transform = dtm_source.transform
        clip = box(*dtm_source.bounds)

    buildings = []
    for ground, height, polygon in load_building_records(footprints_path, height_path, dtm_path):
        ring = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in list(polygon.exterior.coords)[:-1]]
        if len(ring) >= 3:
            buildings.append([round(ground, 1), round(height, 1), ring])

    trees = [[round(float(value), 1) for value in row[:6]] for row in instances]
    roads = []
    for highway, line in local_roads(roads_path, clip):
        coordinates = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in line.coords]
        if len(coordinates) >= 2:
            roads.append([ROAD_WIDTHS.get(highway, 4.0), highway, coordinates])
    grass = []
    for polygon in local_green_areas(green_path, clip):
        ring = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in list(polygon.simplify(0.6, preserve_topology=True).exterior.coords)[:-1]]
        if len(ring) >= 3:
            grass.append(ring)
    terrain = canvas_terrain_grid(dtm, dtm_transform, clip.bounds, origin_x, origin_y)
    output.write_text(json.dumps({"buildings": buildings, "trees": trees, "roads": roads, "grass": grass, "terrain": terrain}, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"buildings": len(buildings), "trees": len(trees), "roads": len(roads), "grass": len(grass), "bytes": output.stat().st_size}


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
    parser.add_argument("--dtm", type=Path, default=Path("data/raw/LiDAR2025/LiDAR2025_2m_DTM.tif"))
    parser.add_argument("--height", type=Path, default=Path("data/raw/LiDAR2025/Lidar2025_Height_Map_1m.tif"))
    parser.add_argument("--footprints", type=Path, default=Path("data/raw/BuildingFootprints2D.geojson"))
    parser.add_argument("--trees", type=Path, default=Path("data/raw/tree_canopy.geojson"))
    parser.add_argument("--roads", type=Path, default=Path("data/osm_cbd_roads.geojson"))
    parser.add_argument("--green", type=Path, default=Path("data/osm_cbd_green_areas.geojson"))
    parser.add_argument("--out", type=Path, default=Path("public/assets"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with rasterio.open(args.dtm) as source:
        origin_x = (source.bounds.left + source.bounds.right) / 2.0
        origin_y = (source.bounds.bottom + source.bounds.top) / 2.0
        bounds = source.bounds
    manifest = {"version": 2, "crs": "custom Hartbeesthoek94 Lo19 east/north grid", "origin": [origin_x, origin_y], "bounds": [bounds.left - origin_x, bounds.bottom - origin_y, bounds.right - origin_x, bounds.top - origin_y], "layers": {}, "assets": {"fallback": "fallback.json", "canopy": "canopy.json"}}
    instances = build_tree_instances(args.trees, args.height, args.dtm, origin_x, origin_y)
    canopies = build_canopy_records(args.trees, args.height, args.dtm, origin_x, origin_y)
    manifest["layers"]["fallback"] = build_canvas_fallback(args.footprints, args.height, args.dtm, args.roads, args.green, instances, args.out / "fallback.json", origin_x, origin_y)
    manifest["layers"]["canopy"] = write_canopy_asset(canopies, args.out / "canopy.json")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
