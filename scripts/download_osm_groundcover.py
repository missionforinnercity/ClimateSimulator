#!/usr/bin/env python3
"""Download OSM ground-cover polygons (water / paved / vegetated) for acoustic ground-absorption zones.

Reuses the same bbox-from-manifest + main OSM API pattern as download_osm_roads.py.
Output is classified into I-Simpa-style ground categories rather than raw OSM tags, since
noise propagation models need a ground-absorption coefficient (G-factor) per polygon:
  - "water": G = 0 (fully reflective)
  - "paved": G = 0 (fully reflective) -- roads, parking, plazas, pedestrian areas
  - "vegetated": G = 1 (fully absorptive) -- grass, meadow, wood, scrub, parks, gardens
Mixed/uncertain ground defaults to G ~ 0.5 in the consuming pipeline, not here.
"""

from __future__ import annotations

import json
from pathlib import Path
from xml.etree import ElementTree

import requests
from pyproj import Transformer

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "public/assets/manifest.json"
OUTPUT = ROOT / "data/osm_cbd_groundcover.geojson"

WATER_NATURAL = {"water", "wetland", "bay", "strait"}
WATER_WATERWAY = {"riverbank", "dock", "canal"}
VEGETATED_LEISURE = {"park", "garden", "golf_course", "pitch", "recreation_ground", "nature_reserve"}
VEGETATED_LANDUSE = {"grass", "meadow", "recreation_ground", "village_green", "cemetery", "forest", "orchard", "vineyard"}
VEGETATED_NATURAL = {"grassland", "scrub", "wood", "heath"}
VEGETATED_LANDCOVER = {"grass", "trees"}
PAVED_LANDUSE = {"paved", "construction", "railway", "commercial", "industrial", "retail"}
PAVED_AMENITY = {"parking", "parking_space", "bicycle_parking"}
PAVED_HIGHWAY_AREA = {"pedestrian", "footway", "living_street", "service"}
PAVED_SURFACE = {"asphalt", "concrete", "paving_stones", "paved", "sett", "cobblestone"}


def classify(tags):
    if tags.get("natural") in WATER_NATURAL or tags.get("waterway") in WATER_WATERWAY or tags.get("landuse") == "reservoir":
        return "water"
    if (
        tags.get("leisure") in VEGETATED_LEISURE
        or tags.get("landuse") in VEGETATED_LANDUSE
        or tags.get("natural") in VEGETATED_NATURAL
        or tags.get("landcover") in VEGETATED_LANDCOVER
    ):
        return "vegetated"
    if (
        tags.get("landuse") in PAVED_LANDUSE
        or tags.get("amenity") in PAVED_AMENITY
        or tags.get("area:highway") in PAVED_HIGHWAY_AREA
        or (tags.get("highway") in PAVED_HIGHWAY_AREA and tags.get("area") == "yes")
        or tags.get("surface") in PAVED_SURFACE
    ):
        return "paved"
    return None


def groundcover_feature(tags, coordinates, source_tag_key, source_tag_value, category):
    return {
        "type": "Feature",
        "properties": {"category": category, "source": f"{source_tag_key}={source_tag_value}"},
        "geometry": {"type": "Polygon", "coordinates": [coordinates]},
    }


def download_groundcover(south, west, north, east):
    url = f"https://api.openstreetmap.org/api/0.6/map?bbox={west},{south},{east},{north}"
    response = requests.get(url, timeout=120, headers={"User-Agent": "CapeTownClimateExplorer/1.0"})
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    nodes = {node.attrib["id"]: [float(node.attrib["lon"]), float(node.attrib["lat"])] for node in root.findall("node")}
    features = []
    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        category = classify(tags)
        if category is None:
            continue
        coordinates = [nodes[ref.attrib["ref"]] for ref in way.findall("nd") if ref.attrib["ref"] in nodes]
        if len(coordinates) < 4 or coordinates[0] != coordinates[-1]:
            continue
        source_key = next(
            (key for key in ("natural", "waterway", "leisure", "landuse", "natural", "landcover", "amenity", "surface") if key in tags),
            "unknown",
        )
        features.append(groundcover_feature(tags, coordinates, source_key, tags.get(source_key), category))
    return features


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    origin_x, origin_y = manifest["origin"]
    left, bottom, right, top = manifest["bounds"]
    transformer = Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)
    corners = [transformer.transform(origin_x + x, origin_y + y) for x, y in ((left, bottom), (left, top), (right, bottom), (right, top))]
    longitudes, latitudes = zip(*corners)
    south, west, north, east = min(latitudes), min(longitudes), max(latitudes), max(longitudes)
    print("Requesting OSM ground-cover polygons from the main OpenStreetMap API", flush=True)
    features = download_groundcover(south, west, north, east)
    counts = {}
    for feature in features:
        category = feature["properties"]["category"]
        counts[category] = counts.get(category, 0) + 1
    OUTPUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Saved {len(features)} ground-cover polygons -> {OUTPUT}  ({counts})")


if __name__ == "__main__":
    main()
