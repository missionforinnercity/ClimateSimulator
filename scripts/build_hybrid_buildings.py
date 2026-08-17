#!/usr/bin/env python3
"""Conflate detailed OSM building parts with municipal building coverage.

OSM is preferred for current outlines and explicitly mapped building parts.
The older municipal photogrammetry remains a gap-fill source and carries its
surveyed height where it is retained. OSM geometries without an explicit
height intentionally leave ``BLD_HGT`` empty so the scene build derives their
height and roof profile from the 2025 LiDAR raster.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from xml.etree import ElementTree

from pyproj import Transformer
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import transform as transform_geometry, unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"


def polygon_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    return [part for part in getattr(geometry, "geoms", []) if part.geom_type == "Polygon"]


def numeric_metres(value):
    if value is None:
        return None
    try:
        text = str(value).strip().lower().replace("metres", "").replace("meters", "").replace("m", "").strip()
        result = float(text)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and 2.0 <= result <= 250.0 else None


def osm_min_height(tags):
    """Return an explicitly mapped metric clearance, when one exists."""
    return numeric_metres(tags.get("min_height"))


def load_osm_way_buildings(osm_path, clip):
    root = ElementTree.parse(osm_path).getroot()
    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    nodes = {
        node.attrib["id"]: to_local.transform(float(node.attrib["lon"]), float(node.attrib["lat"]))
        for node in root.findall("node")
    }
    records = []
    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        if "building" not in tags and "building:part" not in tags:
            continue
        coordinates = [nodes[ref.attrib["ref"]] for ref in way.findall("nd") if ref.attrib["ref"] in nodes]
        if len(coordinates) < 4 or coordinates[0] != coordinates[-1]:
            continue
        geometry = Polygon(coordinates)
        if not geometry.is_valid:
            geometry = geometry.buffer(0)
        geometry = geometry.intersection(clip)
        for part_index, polygon in enumerate(polygon_parts(geometry)):
            if polygon.area < 2.0:
                continue
            records.append({
                "geometry": polygon,
                "osm_id": way.attrib["id"],
                "part_index": part_index,
                "tags": tags,
                "is_part": "building:part" in tags,
            })
    return records


def osm_render_parts(records):
    parts = [record for record in records if record["is_part"]]
    part_geometries = [record["geometry"] for record in parts]
    part_tree = STRtree(part_geometries) if part_geometries else None
    rendered = parts.copy()
    for record in (item for item in records if not item["is_part"]):
        geometry = record["geometry"]
        if part_tree is not None:
            candidates = [part_geometries[int(index)] for index in part_tree.query(geometry, predicate="intersects")]
            if candidates:
                geometry = geometry.difference(unary_union(candidates))
        for residual_index, polygon in enumerate(polygon_parts(geometry)):
            if polygon.area < 8.0:
                continue
            rendered.append({**record, "geometry": polygon, "part_index": residual_index})
    return rendered


def local_municipal_records(path, clip):
    collection = json.loads(path.read_text(encoding="utf-8"))
    to_local = Transformer.from_crs("EPSG:3857", LOCAL_CRS, always_xy=True)
    records = []
    for feature in collection.get("features", []):
        geometry = transform_geometry(to_local.transform, shape(feature["geometry"])).intersection(clip)
        for polygon in polygon_parts(geometry):
            if polygon.area >= 2.0:
                records.append({"geometry": polygon, "properties": feature.get("properties") or {}})
    return records


def municipal_gap_fill(records, osm_geometries):
    if not osm_geometries:
        return records
    osm_union = unary_union(osm_geometries)
    retained = []
    for record in records:
        geometry = record["geometry"]
        overlap = geometry.intersection(osm_union).area / max(geometry.area, 0.001)
        if overlap >= 0.55:
            continue
        if overlap <= 0.10:
            retained.append(record)
            continue
        residual = geometry.difference(osm_union.buffer(0.5))
        for polygon in polygon_parts(residual):
            if polygon.area >= 15.0:
                retained.append({**record, "geometry": polygon})
    return retained


def build_hybrid(osm_path, municipal_path, scene_footprint_path):
    footprint_data = json.loads(scene_footprint_path.read_text(encoding="utf-8"))
    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    clip = unary_union([
        transform_geometry(to_local.transform, shape(feature["geometry"]))
        for feature in footprint_data.get("features", [])
    ])
    osm_records = osm_render_parts(load_osm_way_buildings(osm_path, clip))
    municipal_records = municipal_gap_fill(
        local_municipal_records(municipal_path, clip),
        [record["geometry"] for record in osm_records],
    )
    to_web = Transformer.from_crs(LOCAL_CRS, "EPSG:3857", always_xy=True)
    features = []
    for record in osm_records:
        tags = record["tags"]
        explicit_height = numeric_metres(tags.get("height"))
        features.append({
            "type": "Feature",
            "properties": {
                "fid": f"osm-way-{record['osm_id']}-{record['part_index']}",
                "BLD_HGT": explicit_height,
                "HEIGHT_SRC": "osm_height" if explicit_height is not None else "lidar_2025",
                "ACQS_MTHD": "OpenStreetMap building part" if record["is_part"] else "OpenStreetMap outline",
                "ACQS_PRD": 2026,
                "OSM_ID": record["osm_id"],
                "OSM_PART": record["is_part"],
                "OSM_LEVELS": tags.get("building:levels"),
                "OSM_MIN_HEIGHT": osm_min_height(tags),
                "OSM_MIN_LEVEL": tags.get("building:min_level"),
                "OSM_ROOF": tags.get("roof:shape"),
            },
            "geometry": mapping(transform_geometry(to_web.transform, record["geometry"])),
        })
    for record in municipal_records:
        features.append({
            "type": "Feature",
            "properties": record["properties"],
            "geometry": mapping(transform_geometry(to_web.transform, record["geometry"])),
        })
    return {
        "type": "FeatureCollection",
        "name": "Cape Town hybrid OSM-municipal buildings",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3857"}},
        "metadata": {
            "osm_records": len(osm_records),
            "osm_parts": sum(record["is_part"] for record in osm_records),
            "municipal_gap_fills": len(municipal_records),
            "method": "OSM parts/outlines preferred; municipal footprints retained where OSM coverage is absent",
            "attribution": "© OpenStreetMap contributors; ODbL 1.0",
        },
        "features": features,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", type=Path, default=ROOT / "data/osm_cbd.osm.xml")
    parser.add_argument("--municipal", type=Path, default=ROOT / "data/raw/BuildingFootprints2D.geojson")
    parser.add_argument("--scene-footprint", type=Path, default=ROOT / "data/scene_footprint.geojson")
    parser.add_argument("--output", type=Path, default=ROOT / "data/derived/BuildingFootprintsHybrid.geojson")
    args = parser.parse_args()
    result = build_hybrid(args.osm, args.municipal, args.scene_footprint)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    metadata = result["metadata"]
    print(
        f"Saved {len(result['features'])} hybrid footprints "
        f"({metadata['osm_parts']} OSM parts, {metadata['municipal_gap_fills']} municipal gap fills) to {args.output}"
    )


if __name__ == "__main__":
    main()
