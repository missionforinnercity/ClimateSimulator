#!/usr/bin/env python3
"""Extend the CBD LiDAR DTM into Company's Garden with calibrated SRTM.

Band 1 is elevation in metres. Band 2 is provenance: 0 outside coverage,
1 supplied 2025 LiDAR DTM, 2 calibrated/coarse SRTM supplemental terrain.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import geometry_mask, shapes
from rasterio.merge import merge
from rasterio.warp import reproject
from scipy.ndimage import distance_transform_edt, gaussian_filter
from shapely.geometry import Point, Polygon, box, shape
from shapely.ops import transform as transform_geometry, unary_union

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROAD_WIDTHS = {
    "motorway": 15.0, "trunk": 13.0, "primary": 11.0, "secondary": 9.0,
    "tertiary": 7.0, "residential": 5.5, "unclassified": 5.5,
    "living_street": 5.0, "service": 4.0, "pedestrian": 4.0,
    "cycleway": 2.5, "footway": 2.0, "path": 1.5,
}


def company_garden(green_path: Path, wayfinding_path: Path):
    wayfinding = json.loads(wayfinding_path.read_text(encoding="utf-8"))
    marker = next(
        shape(feature["geometry"])
        for feature in wayfinding.get("features", [])
        if (feature.get("properties") or {}).get("name") == "Company's Garden"
    )
    green = json.loads(green_path.read_text(encoding="utf-8"))
    garden = next(
        shape(feature["geometry"])
        for feature in green.get("features", [])
        if shape(feature["geometry"]).covers(marker)
    )
    return garden


def valid_footprint(source):
    valid = source.read_masks(1) > 0
    return unary_union([
        shape(geometry)
        for geometry, value in shapes(
            valid.astype("uint8"),
            mask=valid,
            transform=source.transform,
        )
        if value == 1
    ])


def _remove_holes(geometry):
    """Return the same outer boundaries without internal terrain voids."""
    polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    return unary_union([
        Polygon(polygon.exterior)
        for polygon in polygons
        if polygon.geom_type == "Polygon" and not polygon.is_empty
    ])


def supplemental_area(garden_wgs84, roads_path: Path, raster_bounds, lidar_footprint):
    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    garden = transform_geometry(to_local.transform, garden_wgs84)
    street_search = garden.buffer(105)
    roads = json.loads(roads_path.read_text(encoding="utf-8"))
    street_surfaces = []
    for feature in roads.get("features", []):
        geometry = transform_geometry(to_local.transform, shape(feature["geometry"]))
        clipped = geometry.intersection(street_search)
        if clipped.is_empty:
            continue
        highway = (feature.get("properties") or {}).get("highway", "service")
        width = ROAD_WIDTHS.get(highway, 4.0)
        street_surfaces.append(clipped.buffer(width / 2 + 5, cap_style=1, join_style=1))

    # Include the nearby LiDAR edge in the closing operation. This joins the
    # garden and its edge streets into one continuous patch instead of leaving
    # narrow disconnected strips and black notches between valid cells.
    local_limit = garden.buffer(135, join_style=1)
    nearby_lidar = lidar_footprint.intersection(local_limit)
    seed = unary_union([
        nearby_lidar,
        garden.buffer(48, join_style=1),
        *street_surfaces,
    ])
    rounded = seed.buffer(30, join_style=1).buffer(-30, join_style=1)
    rounded = _remove_holes(rounded).buffer(4, join_style=1).buffer(-4, join_style=1)
    supplement = rounded.intersection(local_limit).intersection(box(*raster_bounds))
    return supplement, garden


def coarse_dem_on_lidar_grid(coarse_paths, lidar_source):
    to_wgs84 = Transformer.from_crs(lidar_source.crs, "EPSG:4326", always_xy=True)
    corners = [
        to_wgs84.transform(lidar_source.bounds.left, lidar_source.bounds.bottom),
        to_wgs84.transform(lidar_source.bounds.right, lidar_source.bounds.top),
    ]
    bounds = (
        min(point[0] for point in corners),
        min(point[1] for point in corners),
        max(point[0] for point in corners),
        max(point[1] for point in corners),
    )
    sources = [rasterio.open(path) for path in coarse_paths]
    try:
        mosaic, mosaic_transform = merge(sources, bounds=bounds)
        coarse = np.full((lidar_source.height, lidar_source.width), np.nan, dtype=np.float32)
        reproject(
            source=mosaic[0],
            destination=coarse,
            src_transform=mosaic_transform,
            src_crs=sources[0].crs,
            src_nodata=sources[0].nodata,
            dst_transform=lidar_source.transform,
            dst_crs=lidar_source.crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        return coarse
    finally:
        for source in sources:
            source.close()


def build(args):
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(args.lidar) as source:
        profile = source.profile.copy()
        lidar_masked = source.read(1, masked=True)
        lidar = lidar_masked.filled(np.nan).astype(np.float32)
        lidar_valid = ~np.asarray(lidar_masked.mask)
        footprint = valid_footprint(source)
        supplement, garden = supplemental_area(
            company_garden(args.green, args.wayfinding),
            args.roads,
            source.bounds,
            footprint,
        )
        # A supplement can enclose a void only after it joins the original
        # footprint. Fill those final enclosed pockets as part of the same
        # coarse-data patch so the garden edge has no missing terrain gaps.
        hybrid_footprint = _remove_holes(footprint.union(supplement))
        supplement = hybrid_footprint.difference(footprint)
        supplemental_mask = geometry_mask(
            [supplement],
            out_shape=lidar.shape,
            transform=source.transform,
            invert=True,
        )
        coarse = coarse_dem_on_lidar_grid(args.coarse_dem, source)
        resolution_m = abs(source.transform.a)

    overlap = lidar_valid & np.isfinite(coarse)
    global_offset = float(np.median(lidar[overlap] - coarse[overlap]))
    difference = np.where(overlap, lidar - coarse, global_offset)
    nearest = distance_transform_edt(~overlap, return_distances=False, return_indices=True)
    nearest_difference = difference[tuple(nearest)]
    nearest_difference = np.clip(nearest_difference, global_offset - 6.0, global_offset + 6.0)
    smooth_difference = gaussian_filter(nearest_difference.astype(np.float32), sigma=8)
    distance_m = distance_transform_edt(~lidar_valid) * resolution_m
    seam_weight = np.exp(-distance_m / 65.0)
    correction = global_offset * (1 - seam_weight) + smooth_difference * seam_weight
    calibrated_coarse = coarse + correction

    hybrid_mask = geometry_mask(
        [hybrid_footprint],
        out_shape=lidar.shape,
        transform=profile["transform"],
        invert=True,
    )
    coarse_use = supplemental_mask & ~lidar_valid & np.isfinite(calibrated_coarse)
    elevation = np.full_like(lidar, -32767.0, dtype=np.float32)
    elevation[lidar_valid] = lidar[lidar_valid]
    elevation[coarse_use] = calibrated_coarse[coarse_use]
    elevation[~hybrid_mask] = -32767.0
    provenance = np.zeros_like(elevation, dtype=np.float32)
    provenance[lidar_valid & hybrid_mask] = 1
    provenance[coarse_use & hybrid_mask] = 2

    profile.update(count=2, dtype="float32", nodata=-32767.0, compress="deflate", predictor=3)
    with rasterio.open(args.output, "w", **profile) as destination:
        destination.write(elevation, 1)
        destination.write(provenance, 2)
        destination.set_band_description(1, "hybrid ground elevation metres")
        destination.set_band_description(2, "terrain provenance 0=none 1=LiDAR 2=calibrated SRTM")
        destination.update_tags(
            model="LiDAR retained plus calibrated SRTM Company's Garden supplement",
            lidar_source=str(args.lidar),
            coarse_sources=";".join(map(str, args.coarse_dem)),
            coarse_global_offset_m=round(global_offset, 3),
            supplemental_area_m2=round(float(supplement.area), 1),
            company_garden_area_m2=round(float(garden.area), 1),
        )

    summary = {
        "output": str(args.output),
        "lidar_cells": int((provenance == 1).sum()),
        "coarse_cells": int((provenance == 2).sum()),
        "supplemental_area_m2": round(float((provenance == 2).sum() * resolution_m**2), 1),
        "combined_area_m2": round(float((provenance > 0).sum() * resolution_m**2), 1),
        "srtm_offset_m": round(global_offset, 3),
    }
    print(json.dumps(summary, indent=2))
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lidar", type=Path, default=Path("data/raw/LiDAR2025/LiDAR2025_2m_DTM.tif"))
    parser.add_argument(
        "--coarse-dem",
        type=Path,
        nargs="+",
        default=[
            Path("/home/anees/mission_projects/shadow_and_wind/s34_e018_1arc_v3.tif"),
            Path("/home/anees/mission_projects/shadow_and_wind/s35_e018_1arc_v3.tif"),
        ],
    )
    parser.add_argument("--green", type=Path, default=Path("data/osm_cbd_green_areas.geojson"))
    parser.add_argument("--roads", type=Path, default=Path("data/osm_cbd_roads.geojson"))
    parser.add_argument("--wayfinding", type=Path, default=Path("data/osm_cbd_wayfinding.geojson"))
    parser.add_argument("--output", type=Path, default=Path("data/derived/company_gardens_hybrid_dem_2m.tif"))
    build(parser.parse_args())


if __name__ == "__main__":
    main()
