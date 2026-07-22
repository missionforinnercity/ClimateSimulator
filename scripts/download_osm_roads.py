#!/usr/bin/env python3
"""Download OSM roads and green public-space polygons for the CBD scene."""

from __future__ import annotations

import json
from pathlib import Path
from xml.etree import ElementTree

import requests
from pyproj import Transformer

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "public/assets/manifest.json"
OUTPUT = ROOT / "data/osm_cbd_roads.geojson"
GREEN_OUTPUT = ROOT / "data/osm_cbd_green_areas.geojson"
WAYFINDING_OUTPUT = ROOT / "data/osm_cbd_wayfinding.geojson"


def feature_from_way(tags, coordinates):
    return {
        "type": "Feature",
        "properties": {"highway": tags.get("highway", "residential"), "name": tags.get("name"), "oneway": tags.get("oneway")},
        "geometry": {"type": "LineString", "coordinates": coordinates},
    }


def green_feature(tags, coordinates):
    return {
        "type": "Feature",
        "properties": {"type": tags.get("leisure") or tags.get("landuse") or tags.get("natural") or tags.get("landcover") or "green"},
        "geometry": {"type": "Polygon", "coordinates": [coordinates]},
    }


def label_feature(name, coordinates, kind):
    x = sum(point[0] for point in coordinates) / len(coordinates)
    y = sum(point[1] for point in coordinates) / len(coordinates)
    return {"type": "Feature", "properties": {"name": name, "kind": kind}, "geometry": {"type": "Point", "coordinates": [x, y]}}


def download_main_api(south, west, north, east):
    """Use the main OSM map API first; it is reliable for this small CBD extent."""
    url = f"https://api.openstreetmap.org/api/0.6/map?bbox={west},{south},{east},{north}"
    response = requests.get(url, timeout=120, headers={"User-Agent": "CapeTownClimateExplorer/1.0"})
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    nodes = {node.attrib["id"]: [float(node.attrib["lon"]), float(node.attrib["lat"])] for node in root.findall("node")}
    roads, greens, labels = [], [], []
    seen_labels = set()
    pedestrian_types = {"pedestrian", "living_street", "footway", "path"}
    for node in root.findall("node"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in node.findall("tag")}
        name = tags.get("name")
        if name and (tags.get("place") == "square" or tags.get("highway") in pedestrian_types):
            key = (name, node.attrib["lon"], node.attrib["lat"])
            if key not in seen_labels:
                labels.append(label_feature(name, [[float(node.attrib["lon"]), float(node.attrib["lat"])]], tags.get("place") or tags.get("highway")))
                seen_labels.add(key)
    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        coordinates = [nodes[ref.attrib["ref"]] for ref in way.findall("nd") if ref.attrib["ref"] in nodes]
        if "highway" in tags and len(coordinates) >= 2:
            roads.append(feature_from_way(tags, coordinates))
        is_green = tags.get("leisure") in {"park", "garden", "golf_course", "pitch", "recreation_ground", "nature_reserve"} or tags.get("landuse") in {"grass", "meadow", "recreation_ground", "village_green", "cemetery"} or tags.get("natural") in {"grassland", "scrub", "wood"} or tags.get("landcover") in {"grass", "trees"}
        if is_green and len(coordinates) >= 4 and coordinates[0] == coordinates[-1]:
            greens.append(green_feature(tags, coordinates))
        name = tags.get("name")
        if name and len(coordinates) >= 2 and (tags.get("place") == "square" or tags.get("highway") in pedestrian_types or tags.get("leisure") in {"park", "garden"}):
            key = (name, round(sum(point[0] for point in coordinates) / len(coordinates), 6), round(sum(point[1] for point in coordinates) / len(coordinates), 6))
            if key not in seen_labels:
                labels.append(label_feature(name, coordinates, tags.get("place") or tags.get("highway") or tags.get("leisure")))
                seen_labels.add(key)
    return roads, greens, labels


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    origin_x, origin_y = manifest["origin"]
    left, bottom, right, top = manifest["bounds"]
    transformer = Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)
    corners = [transformer.transform(origin_x + x, origin_y + y) for x, y in ((left, bottom), (left, top), (right, bottom), (right, top))]
    longitudes, latitudes = zip(*corners)
    south, west, north, east = min(latitudes), min(longitudes), max(latitudes), max(longitudes)
    print("Requesting OSM roads and green areas from the main OpenStreetMap API", flush=True)
    roads, greens, labels = download_main_api(south, west, north, east)
    OUTPUT.write_text(json.dumps({"type": "FeatureCollection", "features": roads}, separators=(",", ":")) + "\n", encoding="utf-8")
    GREEN_OUTPUT.write_text(json.dumps({"type": "FeatureCollection", "features": greens}, separators=(",", ":")) + "\n", encoding="utf-8")
    WAYFINDING_OUTPUT.write_text(json.dumps({"type": "FeatureCollection", "features": labels}, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Saved {len(roads)} OSM roads, {len(greens)} green areas, and {len(labels)} wayfinding labels")


if __name__ == "__main__":
    main()
