#!/usr/bin/env python3
"""Build a terrain-only D8 screening grid for mapped paved rainfall inputs."""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
from pathlib import Path
import struct
from typing import Any

import numpy as np
import rasterio
from rasterio.features import rasterize
from shapely.geometry import mapping, shape
from shapely.ops import transform as transform_geometry
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DEM = ROOT / "data/derived/company_gardens_hybrid_dem_2m.tif"
DEFAULT_COVER = ROOT / "data/osm_cbd_groundcover.geojson"
DEFAULT_VIEWER_MANIFEST = ROOT / "public/assets/manifest.json"
DEFAULT_OUTPUT = ROOT / "public/assets/runoff_screening.bin"
DEFAULT_SUMMARY = ROOT / "public/assets/runoff_screening.json"
MAGIC = b"CTFLOW01"
HEADER = struct.Struct("<8sIIffffI")
RECORD_DTYPE = np.dtype([("row", "<u2"), ("column", "<u2"), ("area_m2", "<u4")])
NEIGHBOURS = tuple(
    (row, column, 1.4142135623730951 if row and column else 1.0)
    for row in (-1, 0, 1) for column in (-1, 0, 1) if row or column
)


def priority_flood(dem: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Fill closed depressions and return a deterministic rank toward outlets."""
    if dem.ndim != 2 or dem.shape != valid.shape:
        raise ValueError("DEM and valid mask must be same-sized 2D arrays")
    height, width = dem.shape
    valid = valid.astype(bool, copy=False)
    boundary = np.zeros_like(valid)
    boundary[0, :] = valid[0, :]
    boundary[-1, :] = valid[-1, :]
    boundary[:, 0] |= valid[:, 0]
    boundary[:, -1] |= valid[:, -1]
    boundary[1:, :] |= valid[1:, :] & ~valid[:-1, :]
    boundary[:-1, :] |= valid[:-1, :] & ~valid[1:, :]
    boundary[:, 1:] |= valid[:, 1:] & ~valid[:, :-1]
    boundary[:, :-1] |= valid[:, :-1] & ~valid[:, 1:]

    filled = np.full(dem.shape, np.nan, dtype=np.float32)
    rank = np.full(dem.shape, -1, dtype=np.int32)
    visited = np.zeros(dem.shape, dtype=bool)
    heap: list[tuple[float, int]] = []
    for flat_index in np.flatnonzero(boundary):
        row, column = divmod(int(flat_index), width)
        level = float(dem[row, column])
        filled[row, column] = level
        visited[row, column] = True
        heap.append((level, int(flat_index)))
    heapq.heapify(heap)

    pop_rank = 0
    while heap:
        level, flat_index = heapq.heappop(heap)
        row, column = divmod(flat_index, width)
        rank[row, column] = pop_rank
        pop_rank += 1
        for row_step, column_step, _distance in NEIGHBOURS:
            next_row, next_column = row + row_step, column + column_step
            if not (0 <= next_row < height and 0 <= next_column < width):
                continue
            if not valid[next_row, next_column] or visited[next_row, next_column]:
                continue
            visited[next_row, next_column] = True
            next_level = max(float(dem[next_row, next_column]), level)
            filled[next_row, next_column] = next_level
            heapq.heappush(heap, (next_level, next_row * width + next_column))

    if np.any(valid & ~visited):
        raise RuntimeError("Priority-Flood could not reach every valid terrain component")
    return filled, rank


def d8_accumulation(
    dem: np.ndarray, valid: np.ndarray, source_area_m2: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return filled elevation, receiver indices, and single-flow D8 accumulation."""
    if dem.shape != valid.shape or source_area_m2.shape != dem.shape:
        raise ValueError("DEM, valid mask, and source area must have the same shape")
    valid = valid.astype(bool, copy=False)
    filled, rank = priority_flood(dem, valid)
    height, width = dem.shape
    receiver = np.full(dem.shape, -1, dtype=np.int64)
    best_slope = np.full(dem.shape, -1.0, dtype=np.float32)
    best_rank = np.full(dem.shape, np.iinfo(np.int32).max, dtype=np.int32)
    rows, columns = np.indices(dem.shape, dtype=np.int64)

    for row_step, column_step, distance in NEIGHBOURS:
        dst_r0, dst_r1 = max(0, -row_step), min(height, height - row_step)
        dst_c0, dst_c1 = max(0, -column_step), min(width, width - column_step)
        src_r0, src_r1 = dst_r0 + row_step, dst_r1 + row_step
        src_c0, src_c1 = dst_c0 + column_step, dst_c1 + column_step
        dst = np.s_[dst_r0:dst_r1, dst_c0:dst_c1]
        src = np.s_[src_r0:src_r1, src_c0:src_c1]
        destination_fill, neighbour_fill = filled[dst], filled[src]
        destination_rank, neighbour_rank = rank[dst], rank[src]
        pair_valid = valid[dst] & valid[src]
        drop = destination_fill - neighbour_fill
        descends = (drop > 1e-6) | ((np.abs(drop) <= 1e-6) & (neighbour_rank < destination_rank))
        slope = np.maximum(drop, 0.0) / distance
        current_slope = best_slope[dst]
        current_rank = best_rank[dst]
        better = pair_valid & descends & (
            (slope > current_slope + 1e-7)
            | ((np.abs(slope - current_slope) <= 1e-7) & (neighbour_rank < current_rank))
        )
        if not np.any(better):
            continue
        destination_rows = rows[dst][better]
        destination_columns = columns[dst][better]
        best_slope[destination_rows, destination_columns] = slope[better]
        best_rank[destination_rows, destination_columns] = neighbour_rank[better]
        receiver[destination_rows, destination_columns] = (
            (rows[src][better] * width + columns[src][better])
        )

    accumulation = np.where(valid, source_area_m2, 0.0).astype(np.float64, copy=True)
    valid_indices = np.flatnonzero(valid)
    order = valid_indices[np.lexsort((
        -rank.ravel()[valid_indices], -filled.ravel()[valid_indices],
    ))]
    flat_receiver = receiver.ravel()
    flat_accumulation = accumulation.ravel()
    for flat_index in order:
        downstream = flat_receiver[flat_index]
        if downstream >= 0:
            flat_accumulation[downstream] += flat_accumulation[flat_index]
    return filled, receiver, accumulation


def _paved_mask(cover_path: Path, crs: Any, transform, shape_: tuple[int, int]) -> np.ndarray:
    source = json.loads(cover_path.read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    projected = []
    for feature in source.get("features", []):
        if (feature.get("properties") or {}).get("category") != "paved" or not feature.get("geometry"):
            continue
        geometry = transform_geometry(transformer.transform, shape(feature["geometry"]))
        if not geometry.is_empty:
            projected.append((mapping(geometry), 1))
    if not projected:
        return np.zeros(shape_, dtype=bool)
    return rasterize(
        projected, out_shape=shape_, transform=transform,
        fill=0, all_touched=False, dtype="uint8",
    ).astype(bool)


def build(
    dem_path: Path = DEFAULT_DEM, cover_path: Path = DEFAULT_COVER,
    viewer_manifest_path: Path = DEFAULT_VIEWER_MANIFEST,
    output_path: Path = DEFAULT_OUTPUT, summary_path: Path = DEFAULT_SUMMARY,
    threshold_m2: float = 64.0,
) -> dict[str, Any]:
    if threshold_m2 <= 0:
        raise ValueError("minimum displayed contributing area must be positive")
    with rasterio.open(dem_path) as source:
        dem = source.read(1).astype(np.float32)
        valid = (source.read_masks(1) > 0) & np.isfinite(dem)
        transform = source.transform
        crs = source.crs
        height, width = dem.shape
        cell_area_m2 = abs(float(transform.a * transform.e - transform.b * transform.d))
        resolution_m = float((abs(transform.a) + abs(transform.e)) / 2.0)
        paved = _paved_mask(cover_path, crs, transform, dem.shape) & valid

    if not valid.any() or not paved.any():
        raise RuntimeError("terrain or mapped paved input has no valid cells")
    source_area = paved.astype(np.float32) * cell_area_m2
    _filled, receiver, accumulation = d8_accumulation(dem, valid, source_area)
    outlet_total = float(accumulation.ravel()[receiver.ravel() < 0].sum())
    source_total = float(source_area.sum())
    if not np.isclose(outlet_total, source_total, rtol=1e-6, atol=1e-3):
        raise RuntimeError(f"D8 accumulation did not conserve mapped paved input: {outlet_total} != {source_total} m²")
    selected = valid & (accumulation >= threshold_m2)
    selected_rows, selected_columns = np.nonzero(selected)
    selected_area = np.rint(accumulation[selected]).astype(np.uint32)
    if np.any(accumulation[selected] > np.iinfo(np.uint32).max):
        raise OverflowError("accumulated mapped area exceeds the binary asset range")
    records = np.empty(selected_rows.size, dtype=RECORD_DTYPE)
    records["row"] = selected_rows.astype(np.uint16)
    records["column"] = selected_columns.astype(np.uint16)
    records["area_m2"] = selected_area

    viewer_manifest = json.loads(viewer_manifest_path.read_text(encoding="utf-8"))
    origin_x, origin_y = map(float, viewer_manifest["origin"])
    min_x = float(transform.c - origin_x)
    min_z = float(-(transform.f - origin_y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    header = HEADER.pack(
        MAGIC, width, height, resolution_m, min_x, min_z,
        float(threshold_m2), int(records.size),
    )
    with output_path.open("wb") as stream:
        stream.write(header)
        stream.write(records.tobytes())

    digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
    mapped_paved_area = int(paved.sum()) * cell_area_m2
    valid_area = int(valid.sum()) * cell_area_m2
    summary = {
        "schema": "conditions-runoff-screening/1",
        "available": True,
        "terrain_source": str(dem_path.relative_to(ROOT)),
        "terrain_source_sha256": hashlib.sha256(dem_path.read_bytes()).hexdigest(),
        "surface_source": str(cover_path.relative_to(ROOT)),
        "surface_source_sha256": hashlib.sha256(cover_path.read_bytes()).hexdigest(),
        "terrain_resolution_m": resolution_m,
        "terrain_area_m2": round(valid_area, 1),
        "mapped_paved_area_m2": round(mapped_paved_area, 1),
        "mapped_paved_coverage_percent": round(100 * mapped_paved_area / valid_area, 2) if valid_area else 0.0,
        "rainfall_depth_mm_default": 25,
        "runoff_assumption": "100% of rainfall on mapped paved cells becomes surface input; vegetation, water and unmapped cells contribute no input in this screen.",
        "method": "Priority-Flood depression filling followed by single-direction D8 flow accumulation on the 2 m terrain grid.",
        "display_threshold_contributing_area_m2": threshold_m2,
        "record_count": int(records.size),
        "grid": {
            "width": width, "height": height, "resolution_m": resolution_m,
            "bounds": [min_x, min_z, min_x + width * resolution_m, min_z + height * resolution_m],
            "invalid_cells": int((~valid).sum()),
        },
        "asset": "runoff_screening.bin",
        "asset_format": "CTFLOW01 header followed by sparse little-endian uint16 row, uint16 column, uint32 accumulated mapped area m² records.",
        "asset_bytes": output_path.stat().st_size,
        "asset_sha256": digest,
        "limitations": "Terrain-only screening. No rainfall duration/intensity or return period, soil infiltration, vegetation runoff, building roof input, surface routing losses, culverts, storm drains, kerbs, observed ponding or flood depth are modelled. Mapped absence is unknown.",
    }
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dem", type=Path, default=DEFAULT_DEM)
    parser.add_argument("--cover", type=Path, default=DEFAULT_COVER)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--threshold-m2", type=float, default=64.0)
    args = parser.parse_args()
    print(json.dumps(build(args.dem, args.cover, DEFAULT_VIEWER_MANIFEST, args.output, args.summary, args.threshold_m2), indent=2))


if __name__ == "__main__":
    main()
