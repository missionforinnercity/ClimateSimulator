#!/usr/bin/env python3
"""Create compact local WebGL meshes from the supplied Cape Town datasets."""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import shapes
from scipy.ndimage import distance_transform_edt
from shapely.geometry import LineString, Point, box, shape
from shapely.ops import transform as transform_geometry, triangulate, unary_union

HEADER = struct.Struct("<4sIII")
INSTANCE_HEADER = struct.Struct("<4sII")
LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROAD_WIDTHS = {"motorway": 15.0, "trunk": 13.0, "primary": 11.0, "secondary": 9.0, "tertiary": 7.0, "residential": 5.5, "unclassified": 5.5, "living_street": 5.0, "service": 4.0, "pedestrian": 4.0, "cycleway": 2.5, "footway": 2.0, "path": 1.5}


def write_mesh(path: Path, positions, normals, indices):
    positions = np.asarray(positions, dtype=np.float32).reshape((-1, 3))
    normals = np.asarray(normals, dtype=np.float32).reshape((-1, 3))
    indices = np.asarray(indices, dtype=np.uint32)
    if len(positions) != len(normals) or len(indices) % 3:
        raise ValueError(f"invalid mesh arrays: {path}")
    with path.open("wb") as stream:
        stream.write(HEADER.pack(b"CM3D", 1, len(positions), len(indices)))
        stream.write(positions.tobytes())
        stream.write(normals.tobytes())
        stream.write(indices.tobytes())


def write_instances(path: Path, instances):
    values = np.asarray(instances, dtype=np.float32).reshape((-1, 7))
    with path.open("wb") as stream:
        stream.write(INSTANCE_HEADER.pack(b"CINS", 1, len(values)))
        stream.write(values.tobytes())


def face_normal(a, b, c):
    vector = np.cross(np.asarray(b) - np.asarray(a), np.asarray(c) - np.asarray(a))
    length = float(np.linalg.norm(vector))
    return np.asarray([0.0, 1.0, 0.0] if length < 1e-8 else vector / length)


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


def valid_data_footprint(mask, transform):
    """Return the polygon covering valid raster cells, including any holes."""
    geometries = [shape(geometry) for geometry, value in shapes(mask.astype(np.uint8), mask=mask, transform=transform) if value]
    return unary_union(geometries) if geometries else None


def fill_nearest(values, valid):
    """Fill raster gaps with the nearest valid terrain sample."""
    if valid.all():
        return values
    if not valid.any():
        return values
    indices = distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return values[tuple(indices)]


def build_terrain(path, output, stride, origin_x, origin_y):
    with rasterio.open(path) as source:
        raster = source.read(1, masked=True)
        values = raster.filled(0.0).astype(np.float32)
        valid = ~np.asarray(raster.mask)
        values = fill_nearest(values, valid)
        valid = np.ones(values.shape, dtype=bool)
        transform = source.transform

    positions, normals, indices = [], [], []
    vertex_ids = {}

    def vertex(row, col):
        key = (row, col)
        if key not in vertex_ids:
            x, y = transform * (col + 0.5, row + 0.5)
            vertex_ids[key] = len(positions)
            positions.append((x - origin_x, float(values[row, col]), -(y - origin_y)))
            normals.append(np.zeros(3))
        return vertex_ids[key]

    for row in range(0, values.shape[0] - stride, stride):
        for col in range(0, values.shape[1] - stride, stride):
            corners = ((row, col), (row, col + stride), (row + stride, col + stride), (row + stride, col))
            if not all(valid[r, c] for r, c in corners):
                continue
            a, b, c, d = (vertex(*corner) for corner in corners)
            for triangle in ((a, b, c), (a, c, d)):
                indices.extend(triangle)
                n = face_normal(*(positions[index] for index in triangle))
                for index in triangle:
                    normals[index] += n

    normals = [n / (np.linalg.norm(n) or 1.0) for n in normals]
    normals = [n if n[1] >= 0 else -n for n in normals]
    write_mesh(output, positions, normals, indices)
    return {"vertices": len(positions), "triangles": len(indices) // 3}


def build_plinth(path, output, origin_x, origin_y):
    """Create the shallow vertical sides beneath the terrain surface."""
    with rasterio.open(path) as source:
        raster = source.read(1, masked=True)
        values = fill_nearest(raster.filled(0.0).astype(np.float32), ~np.asarray(raster.mask))
        transform = source.transform
        bounds = source.bounds
    corners_xy = [(bounds.left, bounds.bottom), (bounds.right, bounds.bottom), (bounds.right, bounds.top), (bounds.left, bounds.top)]
    top = [sample(values, transform, x, y) for x, y in corners_xy]
    bottom = min(top) - 12.0
    positions, normals, indices = [], [], []
    for index, ((x0, y0), (x1, y1)) in enumerate(zip(corners_xy, corners_xy[1:] + corners_xy[:1])):
        base = len(positions)
        positions.extend(((x0 - origin_x, top[index], -(y0 - origin_y)), (x1 - origin_x, top[(index + 1) % 4], -(y1 - origin_y)), (x1 - origin_x, bottom, -(y1 - origin_y)), (x0 - origin_x, bottom, -(y0 - origin_y))))
        normal = face_normal(positions[base], positions[base + 1], positions[base + 2])
        normals.extend((normal, normal, normal, normal))
        indices.extend((base, base + 1, base + 2, base, base + 2, base + 3))
    write_mesh(output, positions, normals, indices)
    return {"vertices": len(positions), "triangles": len(indices) // 3}


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


def build_roads(roads_path, dtm_path, output, origin_x, origin_y):
    """Build thin road ribbons just above terrain, avoiding expensive polygons."""
    with rasterio.open(dtm_path) as source:
        raster = source.read(1, masked=True)
        dtm = fill_nearest(raster.filled(0.0).astype(np.float32), ~np.asarray(raster.mask))
        transform = source.transform
        clip = box(*source.bounds)
    positions, normals, indices = [], [], []
    road_count = 0
    for highway, line in local_roads(roads_path, clip):
        coordinates = list(line.coords)
        half_width = ROAD_WIDTHS.get(highway, 4.0) * 0.5
        for (x0, y0), (x1, y1) in zip(coordinates, coordinates[1:]):
            dx, dy = x1 - x0, y1 - y0
            length = math.hypot(dx, dy)
            if length < 0.1:
                continue
            nx, ny = -dy / length * half_width, dx / length * half_width
            corners = ((x0 + nx, y0 + ny), (x0 - nx, y0 - ny), (x1 - nx, y1 - ny), (x1 + nx, y1 + ny))
            base = len(positions)
            for x, y in corners:
                positions.append((x - origin_x, sample(dtm, transform, x, y) + 0.14, -(y - origin_y)))
                normals.append((0.0, 1.0, 0.0))
            indices.extend((base, base + 1, base + 2, base, base + 2, base + 3))
        road_count += 1
    write_mesh(output, positions, normals, indices)
    return {"features": road_count, "vertices": len(positions), "triangles": len(indices) // 3}


def local_green_areas(green_path, clip):
    collection = json.loads(green_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    for feature in collection.get("features", []):
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), shape(feature["geometry"])).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        for polygon in parts:
            if not polygon.is_empty and polygon.area >= 12.0:
                yield polygon


def build_grass(green_path, dtm_path, output, origin_x, origin_y):
    with rasterio.open(dtm_path) as source:
        raster = source.read(1, masked=True)
        dtm = fill_nearest(raster.filled(0.0).astype(np.float32), ~np.asarray(raster.mask))
        transform = source.transform
        clip = box(*source.bounds)
    positions, normals, indices = [], [], []
    feature_count = 0
    for polygon in local_green_areas(green_path, clip):
        for triangle in triangulate(polygon):
            if not polygon.covers(triangle.representative_point()):
                continue
            base = len(positions)
            for x, y in list(triangle.exterior.coords)[:3]:
                positions.append((x - origin_x, sample(dtm, transform, x, y) + 0.09, -(y - origin_y)))
                normals.append((0.0, 1.0, 0.0))
            indices.extend((base, base + 1, base + 2))
        feature_count += 1
    write_mesh(output, positions, normals, indices)
    return {"features": feature_count, "vertices": len(positions), "triangles": len(indices) // 3}


def canvas_terrain_grid(dtm, transform, bounds, origin_x, origin_y, size=32):
    """A small elevation grid grounds the non-WebGL compatibility renderer."""
    left, bottom, right, top = bounds
    heights = []
    for row in range(size):
        y = top - (top - bottom) * row / (size - 1)
        for column in range(size):
            x = left + (right - left) * column / (size - 1)
            heights.append(round(sample(dtm, transform, x, y), 2))
    return {"columns": size, "rows": size, "heights": heights, "base": round(float(np.percentile(heights, 2)) - 12.0, 2)}


def polygons_from_mask(mask, transform, clip):
    for geometry, value in shapes(mask.astype(np.uint8), mask=mask, transform=transform):
        if not value:
            continue
        clipped = shape(geometry).intersection(clip)
        parts = clipped.geoms if clipped.geom_type == "MultiPolygon" else (clipped,)
        for polygon in parts:
            if not polygon.is_empty and polygon.area >= 4.0:
                yield polygon


def add_building(polygon, ground, height, origin_x, origin_y, positions, normals, indices, roof_positions, roof_normals, roof_indices):
    """Create footprint walls and a separate procedural roof mesh."""
    polygon = polygon.simplify(0.08, preserve_topology=True)
    ring = list(polygon.exterior.coords)[:-1]
    if len(ring) < 3:
        return False

    compactness = polygon.area / (polygon.convex_hull.area or 1.0)
    rectangle = list(polygon.minimum_rotated_rectangle.exterior.coords)[:-1]
    edge_lengths = [math.dist(rectangle[i], rectangle[(i + 1) % 4]) for i in range(4)] if len(rectangle) == 4 else [1.0]
    long_edge = max(edge_lengths)
    short_edge = max(0.1, min(edge_lengths))
    aspect = long_edge / short_edge
    gabled = height <= 18.0 and polygon.area <= 700.0 and compactness >= 0.86 and aspect >= 1.28
    hipped = not gabled and height <= 15.0 and polygon.area <= 500.0 and compactness >= 0.72 and len(ring) <= 20
    roof_rise = max(1.0, min(4.0, min(short_edge * 0.28, height * 0.24))) if (gabled or hipped) else 0.0
    roof_elevation = ground + height
    eave_elevation = roof_elevation - roof_rise

    normal_start = len(normals)
    base = len(positions)
    for x, y in ring:
        positions.append((x - origin_x, ground, -(y - origin_y)))
    top = len(positions)
    for x, y in ring:
        positions.append((x - origin_x, eave_elevation, -(y - origin_y)))
    normals.extend([np.zeros(3) for _ in range(len(ring) * 2)])

    for i, (x, y) in enumerate(ring):
        j = (i + 1) % len(ring)
        triangles = ((base + i, base + j, top + j), (base + i, top + j, top + i))
        n = face_normal(*(positions[index] for index in triangles[0]))
        indices.extend((*triangles[0], *triangles[1]))
        for index in (base + i, base + j, top + j, top + i):
            normals[index] += n

    roof_normal_start = len(roof_normals)

    def roof_vertex(x, y, elevation):
        roof_positions.append((x - origin_x, elevation, -(y - origin_y)))
        roof_normals.append(np.zeros(3))
        return len(roof_positions) - 1

    def roof_triangle(a, b, c):
        roof_indices.extend((a, b, c))
        normal = face_normal(roof_positions[a], roof_positions[b], roof_positions[c])
        for index in (a, b, c):
            roof_normals[index] += normal

    if gabled:
        # Rotate the rectangle so edge 0 is the long edge. The ridge connects
        # the midpoints of the two short ends.
        if edge_lengths[1] > edge_lengths[0]:
            rectangle = rectangle[1:] + rectangle[:1]
        a, b, c, d = rectangle
        ridge_a_xy = ((a[0] + d[0]) * 0.5, (a[1] + d[1]) * 0.5)
        ridge_b_xy = ((b[0] + c[0]) * 0.5, (b[1] + c[1]) * 0.5)
        ra = roof_vertex(*ridge_a_xy, roof_elevation)
        rb = roof_vertex(*ridge_b_xy, roof_elevation)
        va, vb = roof_vertex(*a, eave_elevation), roof_vertex(*b, eave_elevation)
        vc, vd = roof_vertex(*c, eave_elevation), roof_vertex(*d, eave_elevation)
        roof_triangle(va, vb, rb)
        roof_triangle(va, rb, ra)
        roof_triangle(vd, ra, rb)
        roof_triangle(vd, rb, vc)
        roof_triangle(va, ra, vd)
        roof_triangle(vb, vc, rb)
    elif hipped:
        apex_point = polygon.representative_point()
        apex = roof_vertex(apex_point.x, apex_point.y, roof_elevation)
        roof_ring = [roof_vertex(x, y, eave_elevation) for x, y in ring]
        for i in range(len(ring)):
            j = (i + 1) % len(ring)
            roof_triangle(roof_ring[i], roof_ring[j], apex)
    else:
        for triangle in triangulate(polygon):
            if not polygon.covers(triangle.representative_point()):
                continue
            ids = [roof_vertex(x, y, roof_elevation) for x, y in list(triangle.exterior.coords)[:3]]
            roof_triangle(*ids)
        if polygon.area >= 90.0:
            # A shallow parapet gives flat CBD roofs a readable edge without
            # fabricating detailed rooftop equipment.
            parapet_height = 0.45
            for i, (x0, y0) in enumerate(ring):
                x1, y1 = ring[(i + 1) % len(ring)]
                a = roof_vertex(x0, y0, roof_elevation)
                b = roof_vertex(x1, y1, roof_elevation)
                c = roof_vertex(x1, y1, roof_elevation + parapet_height)
                d = roof_vertex(x0, y0, roof_elevation + parapet_height)
                roof_triangle(a, b, c)
                roof_triangle(a, c, d)

    for i in range(normal_start, len(normals)):
        value = normals[i]
        length = float(np.linalg.norm(value))
        normals[i] = value / (length or 1.0)
    for i in range(roof_normal_start, len(roof_normals)):
        value = roof_normals[i]
        length = float(np.linalg.norm(value))
        roof_normals[i] = value / (length or 1.0)
    return True


def build_buildings(footprints_path, height_path, dtm_path, wall_output, roof_output, origin_x, origin_y):
    """Extrude the supplied building footprints at their surveyed heights.

    The 1 m height raster is a mixed surface model containing trees and other
    objects. It is used only as a fallback when a footprint has no BLD_HGT;
    the footprint layer is the authoritative source for building presence and
    outline geometry.
    """
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        surface_raster = height_source.read(1, masked=True)
        surface = surface_raster.filled(0.0).astype(np.float32)
        surface_transform = height_source.transform
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = dtm_raster.filled(0.0).astype(np.float32)
        dtm_transform = dtm_source.transform
        clip = box(*dtm_source.bounds)
        dtm = fill_nearest(dtm, ~np.asarray(dtm_raster.mask))

    collection = json.loads(footprints_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:3857", LOCAL_CRS, always_xy=True)
    positions, normals, indices = [], [], []
    roof_positions, roof_normals, roof_indices = [], [], []
    feature_count = 0
    for feature in collection.get("features", []):
        geometry = shape(feature["geometry"])
        geometry = transform_geometry(lambda x, y, z=None: transformer.transform(x, y), geometry).intersection(clip)
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
        properties = feature.get("properties") or {}
        source_height = properties.get("BLD_HGT")
        for polygon in parts:
            if polygon.is_empty or polygon.area < 2.0:
                continue
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
            height = max(2.5, min(140.0, height))
            if add_building(polygon, ground, height, origin_x, origin_y, positions, normals, indices, roof_positions, roof_normals, roof_indices):
                feature_count += 1
    write_mesh(wall_output, positions, normals, indices)
    write_mesh(roof_output, roof_positions, roof_normals, roof_indices)
    return {
        "walls": {"vertices": len(positions), "triangles": len(indices) // 3, "features": feature_count},
        "roofs": {"vertices": len(roof_positions), "triangles": len(roof_indices) // 3, "features": feature_count},
    }


def load_tree_obj(path):
    vertices = []
    faces = {"tree": [], "bark": []}
    material = "tree"
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("v "):
            vertices.append(tuple(float(value) for value in line.split()[1:4]))
        elif line.startswith("usemtl "):
            material = "bark" if "bark" in line.lower() else "tree"
        elif line.startswith("f "):
            refs = [int(token.split("/")[0]) - 1 for token in line.split()[1:]]
            for i in range(1, len(refs) - 1):
                faces[material].append((refs[0], refs[i], refs[i + 1]))
    values = np.asarray(vertices, dtype=np.float32)
    if not len(values) or not faces["tree"]:
        raise ValueError(f"tree model has no usable geometry: {path}")
    minimum, maximum = values.min(axis=0), values.max(axis=0)
    return {"vertices": values, "faces": faces, "minimum": minimum, "size": maximum - minimum}


def generate_low_poly_tree_model():
    """Create a small, faceted deciduous tree without an external OBJ asset."""
    vertices, foliage_faces, bark_faces = [], [], []

    def ring(radius, elevation, segments=6):
        ids = []
        for index in range(segments):
            angle = math.tau * index / segments
            ids.append(len(vertices))
            vertices.append((math.cos(angle) * radius, elevation, math.sin(angle) * radius))
        return ids

    # Short hexagonal trunk.
    trunk_base = ring(0.13, 0.0)
    trunk_top = ring(0.10, 0.36)
    for index in range(6):
        next_index = (index + 1) % 6
        bark_faces.extend(((trunk_base[index], trunk_base[next_index], trunk_top[next_index]), (trunk_base[index], trunk_top[next_index], trunk_top[index])))

    # A rounded, low-poly crown made from broad hexagonal bands.
    lower = ring(0.64, 0.28)
    middle = ring(1.0, 0.48)
    upper = ring(0.78, 0.72)
    crown_top = ring(0.32, 0.91)
    top_cap = len(vertices)
    vertices.append((0.0, 0.98, 0.0))
    for lower_ring, upper_ring in ((lower, middle), (middle, upper), (upper, crown_top)):
        for index in range(6):
            next_index = (index + 1) % 6
            foliage_faces.extend(((lower_ring[index], lower_ring[next_index], upper_ring[next_index]), (lower_ring[index], upper_ring[next_index], upper_ring[index])))
    for index in range(6):
        next_index = (index + 1) % 6
        foliage_faces.append((crown_top[index], crown_top[next_index], top_cap))

    values = np.asarray(vertices, dtype=np.float32)
    return {"vertices": values, "faces": {"tree": foliage_faces, "bark": bark_faces}, "minimum": values.min(axis=0), "size": values.max(axis=0) - values.min(axis=0)}


def write_tree_model_mesh(model, material, output):
    source = model["vertices"]
    minimum, size = model["minimum"], model["size"]
    center_x, center_z = minimum[0] + size[0] * 0.5, minimum[2] + size[2] * 0.5
    positions, normals, indices, mapping = [], [], [], {}
    for face in model["faces"][material]:
        ids = []
        for source_index in face:
            if source_index not in mapping:
                x, y, z = source[source_index]
                mapping[source_index] = len(positions)
                positions.append(((x - center_x) / (size[0] * 0.5), (y - minimum[1]) / size[1], (z - center_z) / (size[2] * 0.5)))
                normals.append(np.zeros(3))
            ids.append(mapping[source_index])
        indices.extend(ids)
        normal = face_normal(*(positions[index] for index in ids))
        for index in ids:
            normals[index] += normal
    normals = [normal / (np.linalg.norm(normal) or 1.0) for normal in normals]
    write_mesh(output, positions, normals, indices)
    return {"vertices": len(positions), "triangles": len(indices) // 3}


def build_trees(tree_path, height_path, dtm_path, canopy_output, trunk_output, instances_output, origin_x, origin_y, model_path=None):
    with rasterio.open(height_path) as height_source, rasterio.open(dtm_path) as dtm_source:
        surface_raster = height_source.read(1, masked=True)
        surface = surface_raster.filled(0.0).astype(np.float32)
        surface = fill_nearest(surface, ~np.asarray(surface_raster.mask))
        surface_transform = height_source.transform
        dtm_raster = dtm_source.read(1, masked=True)
        dtm = dtm_raster.filled(0.0).astype(np.float32)
        dtm_valid = ~np.asarray(dtm_raster.mask)
        dtm_transform = dtm_source.transform
        clip = box(*dtm_source.bounds)
        dtm = fill_nearest(dtm, dtm_valid)
        dtm_valid = np.ones(dtm.shape, dtype=bool)
        target_crs = LOCAL_CRS
    with tree_path.open(encoding="utf-8") as stream:
        collection = json.load(stream)
    transformer = Transformer.from_crs("EPSG:3857", target_crs, always_xy=True)
    # Keep a project-owned, predictable visual style regardless of supplied OBJ files.
    tree_model = generate_low_poly_tree_model()
    positions, normals, indices = [], [], []
    trunk_positions, trunk_normals, trunk_indices = [], [], []
    instances = []
    tree_count = 0

    def emit_tree(point, crown_x, crown_z, orientation, seed):
        nonlocal tree_count
        col, row = (~dtm_transform) * (point.x, point.y)
        row, col = int(round(row)), int(round(col))
        if row < 0 or col < 0 or row >= dtm.shape[0] or col >= dtm.shape[1]:
            return
        ground = sample(dtm, dtm_transform, point.x, point.y)
        lidar_height = sample_median(surface, surface_transform, point.x, point.y, radius=2) - ground
        height = lidar_height if math.isfinite(lidar_height) and 3.0 <= lidar_height <= 18.0 else 4.5 + max(crown_x, crown_z) * 0.8
        height = max(4.0, min(18.0, height))
        if tree_model:
            x, z = point.x - origin_x, -(point.y - origin_y)
            instances.append((x, ground, z, crown_x, height, crown_z, orientation + seed * 2.399963229728653))
            tree_count += 1
            return
        x, z = point.x - origin_x, -(point.y - origin_y)
        segments = 8
        variant = seed % 3
        profiles = (
            ((0.26, 0.30), (0.43, 0.90), (0.63, 1.00), (0.84, 0.62)),
            ((0.24, 0.42), (0.45, 1.00), (0.68, 0.78), (0.91, 0.34)),
            ((0.30, 0.24), (0.50, 0.72), (0.73, 0.88), (0.95, 0.42)),
        )[variant]
        rings = []
        for ring_y, ring_scale in profiles:
            ring = []
            for i in range(segments):
                theta = 2.0 * math.pi * (i + (variant * 0.17)) / segments
                ring.append(len(positions))
                local_x = math.cos(theta) * crown_x * ring_scale
                local_z = math.sin(theta) * crown_z * ring_scale
                positions.append((x + math.cos(orientation) * local_x - math.sin(orientation) * local_z, ground + height * ring_y, z + math.sin(orientation) * local_x + math.cos(orientation) * local_z))
                normals.append(np.array([0.0, 1.0, 0.0]))
            rings.append(ring)
        for lower, upper in zip(rings, rings[1:]):
            for i in range(segments):
                j = (i + 1) % segments
                indices.extend((lower[i], lower[j], upper[j], lower[i], upper[j], upper[i]))
        top = len(positions)
        positions.append((x, ground + height, z))
        normals.append(np.array([0.0, 1.0, 0.0]))
        for i in range(segments):
            j = (i + 1) % segments
            indices.extend((rings[-1][i], rings[-1][j], top))
        trunk_base = len(trunk_positions)
        trunk_radius = max(0.16, min(0.45, min(crown_x, crown_z) * 0.12))
        trunk_height = height * 0.38
        for ring_y in (0.0, trunk_height):
            for i in range(6):
                a = 2.0 * math.pi * i / 6.0
                trunk_positions.append((x + math.cos(a) * trunk_radius, ground + ring_y, z + math.sin(a) * trunk_radius))
                trunk_normals.append(np.array([math.cos(a), 0.25, math.sin(a)]))
        for i in range(6):
            j = (i + 1) % 6
            trunk_indices.extend((trunk_base + i, trunk_base + j, trunk_base + 6 + j, trunk_base + i, trunk_base + 6 + j, trunk_base + 6 + i))
        tree_count += 1

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
                emit_tree(point, crown_x, crown_z, orientation, tree_count + point_index)
    if tree_model:
        canopy_stats = write_tree_model_mesh(tree_model, "tree", canopy_output)
        trunk_stats = write_tree_model_mesh(tree_model, "bark", trunk_output)
        write_instances(instances_output, instances)
    else:
        write_mesh(canopy_output, positions, normals, indices)
        write_mesh(trunk_output, trunk_positions, trunk_normals, trunk_indices)
        write_instances(instances_output, [])
        canopy_stats = {"vertices": len(positions), "triangles": len(indices) // 3}
        trunk_stats = {"vertices": len(trunk_positions), "triangles": len(trunk_indices) // 3}
    canopy_stats.update({"features": tree_count, "instances": len(instances)})
    trunk_stats.update({"features": tree_count, "instances": len(instances)})
    return {"canopy": canopy_stats, "trunks": trunk_stats}


def build_canvas_fallback(footprints_path, height_path, dtm_path, roads_path, green_path, instances_path, output, origin_x, origin_y):
    """Write a compact footprint scene for browsers where WebGL is blocked."""
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
    buildings = []
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
            ring = [[round(x - origin_x, 1), round(-(y - origin_y), 1)] for x, y in list(polygon.exterior.coords)[:-1]]
            if len(ring) >= 3:
                buildings.append([round(ground, 1), round(max(2.5, min(140.0, height)), 1), ring])

    with instances_path.open("rb") as stream:
        magic, version, count = INSTANCE_HEADER.unpack(stream.read(INSTANCE_HEADER.size))
        if magic != b"CINS" or version != 1:
            raise ValueError(f"invalid tree instances: {instances_path}")
        values = np.frombuffer(stream.read(), dtype=np.float32).reshape((count, 7))
    trees = [[round(float(value), 1) for value in row[:6]] for row in values]
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dtm", type=Path, default=Path("LiDAR2025/LiDAR2025_2m_DTM.tif"))
    parser.add_argument("--height", type=Path, default=Path("LiDAR2025/Lidar2025_Height_Map_1m.tif"))
    parser.add_argument("--footprints", type=Path, default=Path("BuildingFootprints2D.geojson"))
    parser.add_argument("--trees", type=Path, default=Path("tree_canopy.geojson"))
    parser.add_argument("--roads", type=Path, default=Path("data/osm_cbd_roads.geojson"))
    parser.add_argument("--green", type=Path, default=Path("data/osm_cbd_green_areas.geojson"))
    parser.add_argument("--tree-model", type=Path, default=Path("Lowpoly_tree_sample.obj"))
    parser.add_argument("--out", type=Path, default=Path("public/assets"))
    # Buildings, roads, and trees are sampled from the source DTM independently.
    # A 4 m display grid is therefore sufficient for the city base while keeping
    # the GPU mesh light enough for subsequent climate-data layers.
    parser.add_argument("--terrain-stride", type=int, default=4)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with rasterio.open(args.dtm) as source:
        origin_x = (source.bounds.left + source.bounds.right) / 2.0
        origin_y = (source.bounds.bottom + source.bounds.top) / 2.0
        bounds = source.bounds
    manifest = {"version": 1, "crs": "custom Hartbeesthoek94 Lo19 east/north grid", "origin": [origin_x, origin_y], "bounds": [bounds.left - origin_x, bounds.bottom - origin_y, bounds.right - origin_x, bounds.top - origin_y], "layers": {}, "assets": {}}
    for name in ("terrain", "base", "grass", "roads", "buildings", "roofs", "trees", "trunks", "tree_instances"):
        manifest["assets"][name] = f"{name}.bin"
    manifest["assets"]["fallback"] = "fallback.json"
    manifest["layers"]["terrain"] = build_terrain(args.dtm, args.out / "terrain.bin", args.terrain_stride, origin_x, origin_y)
    manifest["layers"]["base"] = build_plinth(args.dtm, args.out / "base.bin", origin_x, origin_y)
    manifest["layers"]["grass"] = build_grass(args.green, args.dtm, args.out / "grass.bin", origin_x, origin_y)
    manifest["layers"]["roads"] = build_roads(args.roads, args.dtm, args.out / "roads.bin", origin_x, origin_y)
    building_layers = build_buildings(args.footprints, args.height, args.dtm, args.out / "buildings.bin", args.out / "roofs.bin", origin_x, origin_y)
    manifest["layers"]["buildings"] = building_layers["walls"]
    manifest["layers"]["roofs"] = building_layers["roofs"]
    tree_layers = build_trees(args.trees, args.height, args.dtm, args.out / "trees.bin", args.out / "trunks.bin", args.out / "tree_instances.bin", origin_x, origin_y, args.tree_model)
    manifest["layers"]["trees"] = tree_layers["canopy"]
    manifest["layers"]["trunks"] = tree_layers["trunks"]
    manifest["layers"]["fallback"] = build_canvas_fallback(args.footprints, args.height, args.dtm, args.roads, args.green, args.out / "tree_instances.bin", args.out / "fallback.json", origin_x, origin_y)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
