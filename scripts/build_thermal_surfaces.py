#!/usr/bin/env python3
"""Build aligned SOLWEIG rasters and SUEWS site-characteristic cells."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import numpy as np
import rasterio
from rasterio.enums import MergeAlg, Resampling
from rasterio.features import rasterize
from rasterio.warp import reproject
from shapely.geometry import LineString, Polygon, box, mapping

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

LAND_COVER = {"nodata": 0, "paved": 1, "building": 2, "grass": 3, "water": 4, "bare_soil": 5, "tree": 6}
SOLWEIG_LAND_COVER = {"nodata": 255, "paved": 1, "building": 2, "grass": 5, "water": 7, "bare_soil": 6}


def solweig_ground_cover(surface_cover: np.ndarray) -> np.ndarray:
    """Translate project surface classes; canopy is supplied separately as CDSM."""
    if not np.isin(surface_cover, [LAND_COVER[name] for name in SOLWEIG_LAND_COVER]).all():
        raise ValueError("SOLWEIG requires ground cover beneath trees, not a tree material")
    result = np.full(surface_cover.shape, 255, dtype=np.uint8)
    for name, code in SOLWEIG_LAND_COVER.items():
        result[surface_cover == LAND_COVER[name]] = code
    return result


def _project_ring(ring, origin_x: float, origin_y: float):
    return [(origin_x + float(x), origin_y - float(z)) for x, z in ring]


def _polygon(ring, holes, origin_x, origin_y):
    return Polygon(_project_ring(ring, origin_x, origin_y), [_project_ring(item, origin_x, origin_y) for item in holes])


def build(output: Path, resolution: float = 2.0, suews_cell_m: float = 250.0) -> dict:
    scene_path = PROJECT_ROOT / "public/assets/fallback.json"
    canopy_path = PROJECT_ROOT / "public/assets/canopy.json"
    dtm_path = PROJECT_ROOT / "data/derived/company_gardens_hybrid_dem_2m.tif"
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    canopy = json.loads(canopy_path.read_text(encoding="utf-8"))
    viewer = json.loads((PROJECT_ROOT / "public/assets/manifest.json").read_text(encoding="utf-8"))
    origin_x, origin_y = map(float, viewer["origin"])
    local_bounds = tuple(map(float, viewer["bounds"]))
    projected_bounds = (origin_x + local_bounds[0], origin_y - local_bounds[3], origin_x + local_bounds[2], origin_y - local_bounds[1])
    width = math.ceil((projected_bounds[2] - projected_bounds[0]) / resolution)
    height = math.ceil((projected_bounds[3] - projected_bounds[1]) / resolution)
    transform = rasterio.transform.from_origin(projected_bounds[0], projected_bounds[3], resolution, resolution)
    with rasterio.open(dtm_path) as source:
        dem = np.full((height, width), np.nan, dtype=np.float32)
        reproject(
            rasterio.band(source, 1), dem, src_transform=source.transform, src_crs=source.crs,
            dst_transform=transform, dst_crs=source.crs, dst_nodata=np.nan, resampling=Resampling.bilinear,
        )
        crs = source.crs
    valid = np.isfinite(dem)
    profile = {
        "driver": "GTiff", "width": width, "height": height, "count": 1, "crs": crs,
        "transform": transform, "compress": "deflate", "tiled": True, "nodata": -9999.0,
    }
    output.mkdir(parents=True, exist_ok=True)
    with rasterio.open(output / "dem.tif", "w", dtype="float32", **profile) as target:
        target.write(np.where(valid, dem, -9999).astype(np.float32), 1)

    building_shapes = []
    building_polygons = []
    for record in scene.get("buildings", []):
        holes = record[13] if len(record) > 13 and isinstance(record[13], list) else []
        geometry = _polygon(record[2], holes, origin_x, origin_y)
        if geometry.is_valid and not geometry.is_empty:
            height_m = max(float(record[1]), float(record[5]) if len(record) > 5 else float(record[1]))
            building_shapes.append((geometry, float(record[0]) + height_m))
            building_polygons.append((geometry, height_m))
    building_surface = rasterize(
        sorted(building_shapes, key=lambda item: item[1]), out_shape=(height, width), transform=transform,
        fill=np.nan, dtype="float32", merge_alg=MergeAlg.replace,
    )
    dsm = np.where(np.isfinite(building_surface), building_surface, dem)
    dsm[~valid] = np.nan
    with rasterio.open(output / "dsm.tif", "w", dtype="float32", **profile) as target:
        target.write(np.where(valid, dsm, -9999).astype(np.float32), 1)

    canopy_shapes = []
    canopy_polygons = []
    for record in canopy.get("canopies", []):
        if len(record) < 6:
            continue
        ground, crown_top = float(record[1]), float(record[3])
        for component in record[5] or []:
            if not component:
                continue
            if isinstance(component[0][0], (list, tuple)):
                ring, holes = component[0], component[1:]
            else:
                ring, holes = component, []
            geometry = _polygon(ring, holes, origin_x, origin_y)
            if geometry.is_valid and not geometry.is_empty:
                canopy_shapes.append((geometry, crown_top))
                canopy_polygons.append((geometry, max(0.0, crown_top - ground)))
    cdsm = rasterize(
        sorted(canopy_shapes, key=lambda item: item[1]), out_shape=(height, width), transform=transform,
        fill=0, dtype="float32", merge_alg=MergeAlg.replace,
    )
    cdsm[~valid] = -9999
    with rasterio.open(output / "cdsm.tif", "w", dtype="float32", **profile) as target:
        target.write(cdsm.astype(np.float32), 1)

    landcover = np.full((height, width), LAND_COVER["paved"], dtype=np.uint8)
    landcover[~valid] = LAND_COVER["nodata"]
    grass = [(_polygon(ring, [], origin_x, origin_y), LAND_COVER["grass"]) for ring in scene.get("grass", []) if len(ring) >= 3]
    water = []
    for item in scene.get("water", []):
        rings = item.get("rings") or []
        if rings:
            water.append((_polygon(rings[0], rings[1:], origin_x, origin_y), LAND_COVER["water"]))
    roads = []
    for width_m, _, coordinates, *_ in scene.get("roads", []):
        if len(coordinates) >= 2:
            line = LineString(_project_ring(coordinates, origin_x, origin_y)).buffer(max(1.0, float(width_m) / 2), cap_style=2)
            roads.append((line, LAND_COVER["paved"]))
    ground_cover = None
    for index, shapes in enumerate((grass, water, roads, [(geometry, LAND_COVER["tree"]) for geometry, _ in canopy_polygons],
                   [(geometry, LAND_COVER["building"]) for geometry, _ in building_polygons])):
        if index == 3:
            ground_cover = landcover.copy()
        shapes = [(geometry, value) for geometry, value in shapes if geometry.is_valid and not geometry.is_empty]
        if shapes:
            burned = rasterize(shapes, out_shape=(height, width), transform=transform, fill=0, dtype="uint8")
            landcover[burned > 0] = burned[burned > 0]
    # Trees shade the actual grass/paving beneath them; a canopy footprint
    # must not replace that ground with SOLWEIG code 6 (bare soil).
    ground_cover[landcover == LAND_COVER["building"]] = LAND_COVER["building"]
    ground_cover[~valid] = LAND_COVER["nodata"]
    landcover[~valid] = LAND_COVER["nodata"]
    lc_profile = {**profile, "nodata": SOLWEIG_LAND_COVER["nodata"]}
    with rasterio.open(output / "landcover.tif", "w", dtype="uint8", **lc_profile) as target:
        target.write(solweig_ground_cover(ground_cover), 1)

    cells = []
    scene_box = box(*projected_bounds)
    columns = math.ceil((projected_bounds[2] - projected_bounds[0]) / suews_cell_m)
    rows = math.ceil((projected_bounds[3] - projected_bounds[1]) / suews_cell_m)
    for row in range(rows):
        for column in range(columns):
            cell = box(
                projected_bounds[0] + column * suews_cell_m, projected_bounds[1] + row * suews_cell_m,
                min(projected_bounds[2], projected_bounds[0] + (column + 1) * suews_cell_m),
                min(projected_bounds[3], projected_bounds[1] + (row + 1) * suews_cell_m),
            ).intersection(scene_box)
            window = rasterio.windows.from_bounds(*cell.bounds, transform=transform).round_offsets().round_lengths()
            subset = landcover[int(window.row_off):int(window.row_off + window.height), int(window.col_off):int(window.col_off + window.width)]
            subset = subset[subset != LAND_COVER["nodata"]]
            if subset.size < max(1, int(cell.area / resolution**2 * 0.25)):
                continue
            fractions = {name: round(float(np.count_nonzero(subset == code) / subset.size), 6) for name, code in LAND_COVER.items() if name != "nodata"}
            buildings = [(geometry.intersection(cell).area, height_m) for geometry, height_m in building_polygons if geometry.intersects(cell)]
            weighted_height = sum(area * h for area, h in buildings) / sum(area for area, _ in buildings) if buildings else 0.0
            cells.append({
                "id": f"r{row}c{column}", "geometry": mapping(cell), "surface_fractions": fractions,
                "mean_building_height_m": round(weighted_height, 2), "valid_area_m2": round(subset.size * resolution**2, 1),
            })
    metadata = {
        "schema": "conditions-thermal-surfaces/1", "resolution_m": resolution,
        "viewer_bounds": list(local_bounds), "projected_bounds": list(projected_bounds), "crs": str(crs),
        "width": width, "height": height, "land_cover_codes": SOLWEIG_LAND_COVER,
        "land_cover_convention": "SOLWEIG_UMEP_ground_v1", "suews_surface_codes": LAND_COVER,
        "sources": {"dem": str(dtm_path.relative_to(PROJECT_ROOT)), "scene": str(scene_path.relative_to(PROJECT_ROOT)), "canopy": str(canopy_path.relative_to(PROJECT_ROOT))},
        "limitations": ["unmapped valid ground defaults to paved", "tree species and material properties use model defaults"],
    }
    (output / "grid.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    (output / "suews_cells.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": cell.pop("geometry"), "properties": cell} for cell in cells
    ]}, separators=(",", ":")) + "\n", encoding="utf-8")
    return {**metadata, "suews_cells": len(cells)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "data/thermal/surfaces")
    parser.add_argument("--resolution", type=float, default=2.0)
    parser.add_argument("--suews-cell", type=float, default=250.0)
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.resolution, args.suews_cell), indent=2))


if __name__ == "__main__":
    main()
