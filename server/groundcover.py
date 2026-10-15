"""Mapped ground-cover inventory for the Cape Town CBD viewer."""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as transform_geometry, unary_union

ROOT = Path(__file__).resolve().parents[1]
SOURCE_FILE = ROOT / "data/osm_cbd_groundcover.geojson"
FOOTPRINT_FILE = ROOT / "data/scene_footprint.geojson"
MANIFEST_FILE = ROOT / "public/assets/manifest.json"
LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"


def _local_geometry(geometry: dict[str, Any], transformer: Transformer, origin: tuple[float, float]):
    origin_x, origin_y = origin

    def project(x, y, z=None):
        projected_x, projected_y = transformer.transform(x, y)
        return projected_x - origin_x, -(projected_y - origin_y)

    return transform_geometry(project, shape(geometry))


def _polygon_rings(geometry) -> list[list[list[list[float]]]]:
    polygons = []
    pending = [geometry]
    while pending:
        item = pending.pop()
        if item.geom_type == "Polygon":
            polygons.append(item)
        elif hasattr(item, "geoms"):
            pending.extend(item.geoms)
    output = []
    for polygon in polygons:
        if polygon.geom_type != "Polygon" or polygon.is_empty or polygon.area < 1.0:
            continue
        rings = []
        for ring in [polygon.exterior, *polygon.interiors]:
            points = [[round(float(x), 2), round(float(z), 2)] for x, z in list(ring.coords)[:-1]]
            if len(points) >= 3:
                rings.append(points)
        if rings:
            output.append(rings)
    return output


@lru_cache(maxsize=1)
def mapped_groundcover() -> dict[str, Any]:
    """Project, clip, and dissolve source classes once per API process."""
    manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    origin = tuple(map(float, manifest["origin"]))
    transformer = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    footprint_collection = json.loads(FOOTPRINT_FILE.read_text(encoding="utf-8"))
    footprint_shapes = [
        _local_geometry(feature["geometry"], transformer, origin)
        for feature in footprint_collection.get("features", []) if feature.get("geometry")
    ]
    footprint = unary_union(footprint_shapes)

    source = json.loads(SOURCE_FILE.read_text(encoding="utf-8"))
    categories: dict[str, list[Any]] = {"paved": [], "vegetated": [], "water": []}
    source_counts = {name: 0 for name in categories}
    for feature in source.get("features", []):
        properties = feature.get("properties") or {}
        category = properties.get("category")
        geometry = feature.get("geometry")
        if category not in categories or not geometry:
            continue
        projected = _local_geometry(geometry, transformer, origin).intersection(footprint)
        if projected.is_empty or projected.area < 1.0:
            continue
        categories[category].append(projected)
        source_counts[category] += 1

    # Make mapped classes non-overlapping for area totals and display. Water
    # takes precedence, then vegetation, with paved polygons filling the rest.
    dissolved = {name: unary_union(items) if items else None for name, items in categories.items()}
    water = dissolved["water"]
    vegetated = dissolved["vegetated"].difference(water) if water is not None else dissolved["vegetated"]
    higher = [geometry for geometry in (water, vegetated) if geometry is not None]
    paved = dissolved["paved"]
    if paved is not None and higher:
        paved = paved.difference(unary_union(higher))

    shapes = {"paved": paved, "vegetated": vegetated, "water": water}
    labels = {"paved": "Mapped paved surfaces", "vegetated": "Mapped vegetated areas", "water": "Mapped water"}
    output = []
    total_area = 0.0
    for name in ("paved", "vegetated", "water"):
        geometry = shapes[name]
        if geometry is None or geometry.is_empty:
            continue
        area = float(geometry.area)
        total_area += area
        output.append({
            "category": name, "label": labels[name], "area_m2": round(area, 1),
            "feature_count": source_counts[name], "polygons": _polygon_rings(geometry),
        })
    footprint_area = float(footprint.area)
    return {
        "schema": "conditions-mapped-groundcover/1",
        "source": "OpenStreetMap ground-cover inventory",
        "source_file": "data/osm_cbd_groundcover.geojson",
        "mapped_area_m2": round(total_area, 1),
        "footprint_area_m2": round(footprint_area, 1),
        "coverage_percent": round(100 * total_area / footprint_area, 1) if footprint_area else 0.0,
        "categories": output,
        "caveat": "Mapped coverage only. Unmapped ground is unknown; mapped vegetation is not a measured infiltration class, and mapped paving is not a runoff estimate.",
    }
