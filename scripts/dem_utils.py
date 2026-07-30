"""Shared DEM loading helpers for regional terrain and terrain-aware wind."""

from __future__ import annotations

import math

import numpy as np
import rasterio
import rasterio.transform
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.merge import merge
from rasterio.warp import Resampling, reproject

from scripts.build_scene import fill_nearest

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"


def load_regional_heightfield(dem_paths, center_lon, center_lat, extent_km, resolution_m):
    """Return a regular local-CRS heightfield covering the requested extent.

    Unlike a decimated visual mesh, this
    returns a plain ``(rows, columns)`` array of elevations on a regular grid
    in local metres, suitable for numerical terrain-following wind modelling.
    """
    lon_delta = extent_km / (111.32 * math.cos(math.radians(center_lat)))
    lat_delta = extent_km / 111.32
    bounds = (center_lon - lon_delta, center_lat - lat_delta, center_lon + lon_delta, center_lat + lat_delta)
    sources = [rasterio.open(path) for path in dem_paths]
    try:
        raster, transform = merge(sources, bounds=bounds)
        values = raster[0].astype(np.float32)
        nodata = sources[0].nodata
        valid = np.isfinite(values)
        if nodata is not None:
            valid &= ~np.isclose(values, nodata)
        values = fill_nearest(np.where(valid, values, 0), valid)
    finally:
        for source in sources:
            source.close()

    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    origin_x, origin_y = to_local.transform(center_lon, center_lat)

    # Sample the source raster onto a regular local-metre grid at the
    # requested resolution (the source pixels are geographic and slightly
    # non-square in local metres, so we resample rather than reuse them raw).
    half_extent = extent_km * 1000.0 / 2.0
    width = max(2, int(round(2 * half_extent / resolution_m)))
    height = max(2, int(round(2 * half_extent / resolution_m)))
    dx = 2 * half_extent / width
    dz = 2 * half_extent / height

    to_geo = Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)
    columns_idx, rows_idx = np.meshgrid(np.arange(width), np.arange(height))
    local_x = -half_extent + (columns_idx + 0.5) * dx
    local_z = -half_extent + (rows_idx + 0.5) * dz
    lons, lats = to_geo.transform(origin_x + local_x, origin_y - local_z)
    cols_px, rows_px = ~transform * (lons, lats)
    rows_px = np.clip(np.round(rows_px).astype(int), 0, values.shape[0] - 1)
    cols_px = np.clip(np.round(cols_px).astype(int), 0, values.shape[1] - 1)
    heights = values[rows_px, cols_px]

    return heights, -half_extent, -half_extent, dx, dz


def load_cbd_building_heightfield(dtm_path, footprints_path, height_path, resolution_m):
    """Return a local-CRS surface heightfield (bare ground + building roofs).

    Unlike ``load_regional_heightfield`` (built for geographic-CRS regional DEM
    tiles merged/reprojected from lon/lat), the CBD LiDAR DTM is already in
    the project's local metre CRS, so this only resamples it to the requested
    resolution (no reprojection) and rasterizes buildings on top of it -- a
    real surface for the same mass-conserving solver used for the mountain,
    but shaped by individual buildings and street canyons instead of ridges.

    Returns (heights, origin_x, origin_z, dx, dz) in the same (row=z-index,
    col=x-index, z south-positive) layout as ``load_regional_heightfield``.
    """
    from scripts.build_scene import load_building_records

    with rasterio.open(dtm_path) as source:
        center_x = (source.bounds.left + source.bounds.right) / 2.0
        center_y = (source.bounds.bottom + source.bounds.top) / 2.0
        west, south, east, north = source.bounds
        width = max(2, int(round((east - west) / resolution_m)))
        height = max(2, int(round((north - south) / resolution_m)))
        dst_transform = rasterio.transform.from_bounds(west, south, east, north, width, height)
        dtm = np.zeros((height, width), dtype=np.float32)
        reproject(
            source=rasterio.band(source, 1),
            destination=dtm,
            src_transform=source.transform,
            src_crs=source.crs,
            dst_transform=dst_transform,
            dst_crs=source.crs,
            resampling=Resampling.bilinear,
        )

    dx = (east - west) / width
    dz = (north - south) / height
    shapes = [
        (polygon, ground + building_height)
        for ground, building_height, polygon in load_building_records(footprints_path, height_path, dtm_path)
    ]
    building_top = (
        rasterize(shapes, out_shape=(height, width), transform=dst_transform, fill=0.0, dtype="float32")
        if shapes else np.zeros((height, width), dtype=np.float32)
    )
    surface = np.where(building_top > 0, building_top, dtm)
    return surface.astype(np.float32), west - center_x, -(north - center_y), dx, dz


def load_cbd_obstacle_fields(dtm_path, footprints_path, height_path, canopy_path, resolution_m):
    """Return explicit solid building and porous canopy layers on the DTM grid."""
    import json
    from shapely.geometry import Polygon

    with rasterio.open(dtm_path) as source:
        west, south, east, north = source.bounds
        center_x = (west + east) / 2.0
        center_y = (south + north) / 2.0
        width = max(2, int(round((east - west) / resolution_m)))
        height = max(2, int(round((north - south) / resolution_m)))
        dst_transform = rasterio.transform.from_bounds(west, south, east, north, width, height)
    dx = (east - west) / width
    dz = (north - south) / height

    def raster_polygon(ring, local=False):
        # Viewer local coordinates are x,z; the source raster is absolute x,y
        # and z is south-positive, hence y = centre_y - z.
        if hasattr(ring, "exterior"):
            return Polygon(
                [(x + center_x if local else x, center_y - z if local else z) for x, z in ring.exterior.coords],
                [[(x + center_x if local else x, center_y - z if local else z) for x, z in hole.coords] for hole in ring.interiors],
            )
        return Polygon([(x + center_x if local else x, center_y - z if local else z) for x, z in ring])

    from scripts.build_scene import load_building_records
    building_shapes = [(raster_polygon(record[2]), 1) for record in load_building_records(footprints_path, height_path, dtm_path)]
    solid = rasterize(building_shapes, out_shape=(height, width), transform=dst_transform, fill=0, dtype="uint8")

    canopy_shapes = []
    canopy_data = json.loads(canopy_path.read_text(encoding="utf-8"))
    for record in canopy_data.get("canopies", []):
        for component in record[-1] if record and isinstance(record[-1], list) else []:
            ring = component[0] if component and isinstance(component[0][0], (list, tuple)) else component
            if len(ring) >= 3:
                canopy_shapes.append((raster_polygon(ring, local=True), 1))
    canopy = rasterize(canopy_shapes, out_shape=(height, width), transform=dst_transform, fill=0, dtype="float32")
    # Canopy is a momentum sink, not a wall. This leaves all gaps traversable.
    drag = np.clip(canopy * 0.45, 0.0, 0.75).astype(np.float32)
    return solid.astype(bool), drag, west - center_x, -(north - center_y), dx, dz
