#!/usr/bin/env python3
"""Build a compact pedestrian graph from the checked-in OpenStreetMap extract."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys

import osmnx as ox
from pyproj import Transformer
from shapely.geometry import LineString, box

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from server.field import LOCAL_CRS, load_viewer_config  # noqa: E402

SOURCE = PROJECT_ROOT / "data/osm_cbd.osm.xml"
DEFAULT_OUTPUT = PROJECT_ROOT / "data/derived/walking_network.json.gz"
BUFFER_M = 60.0
EXCLUDED_HIGHWAYS = {"motorway", "motorway_link", "construction", "proposed", "raceway"}
MOTOR_ONLY_WITHOUT_FOOT = {"trunk", "trunk_link", "busway", "cycleway"}
DENIED_ACCESS = {"no", "private", "permit", "customers", "restricted", "military", "emergency"}
POSITIVE_FOOT = {"yes", "designated", "permissive", "official"}
PEDESTRIAN_HIGHWAYS = {"footway", "pedestrian", "steps", "path", "living_street"}
SIDEWALK_PRESENT = {"yes", "both", "left", "right", "separate"}
WAY_TAGS = [
    "access", "bridge", "crossing", "foot", "highway", "incline", "kerb",
    "layer", "lit", "name", "oneway:foot", "sidewalk", "smoothness",
    "surface", "tunnel", "width",
]


def _string(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    return str(value)


def _is_walkable(tags: dict) -> bool:
    highway = _string(tags.get("highway"))
    foot = (_string(tags.get("foot")) or "").lower()
    access = (_string(tags.get("access")) or "").lower()
    sidewalk = (_string(tags.get("sidewalk")) or "").lower()
    if not highway:
        return False
    if foot in DENIED_ACCESS:
        return False
    if highway in EXCLUDED_HIGHWAYS and foot not in POSITIVE_FOOT:
        return False
    if highway in MOTOR_ONLY_WITHOUT_FOOT and foot not in POSITIVE_FOOT and sidewalk not in SIDEWALK_PRESENT:
        return False
    if access in DENIED_ACCESS and foot not in POSITIVE_FOOT:
        return False
    return True


def build(source: Path = SOURCE, output: Path = DEFAULT_OUTPUT) -> dict:
    if not source.is_file():
        raise FileNotFoundError(f"OpenStreetMap source does not exist: {source}")

    ox.settings.useful_tags_way = list(dict.fromkeys([*ox.settings.useful_tags_way, *WAY_TAGS]))
    osm_graph = ox.graph.graph_from_xml(
        source, bidirectional=True, simplify=False, retain_all=True,
    )
    config = load_viewer_config()
    origin_x, origin_y = map(float, config["origin"])
    left, bottom, right, top = map(float, config["bounds"])
    min_z, max_z = -top, -bottom
    clip = box(left - BUFFER_M, min_z - BUFFER_M, right + BUFFER_M, max_z + BUFFER_M)
    transform = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)

    coordinates = {
        node: (
            lambda xy: (round(xy[0] - origin_x, 2), round(-(xy[1] - origin_y), 2))
        )(transform.transform(float(data["x"]), float(data["y"])))
        for node, data in osm_graph.nodes(data=True)
    }

    nodes: dict[str, tuple[float, float]] = {}
    edges: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for u, v, key, data in osm_graph.edges(keys=True, data=True):
        if not _is_walkable(data):
            continue
        line = LineString([coordinates[u], coordinates[v]])
        if line.length <= 0.05 or not line.intersects(clip):
            continue
        osmid = _string(data.get("osmid")) or "unknown"
        identity = (str(u), str(v), f"{osmid}:{key}")
        if identity in seen:
            continue
        seen.add(identity)
        reversed_way = bool(data.get("reversed", False))
        one_way_foot = (_string(data.get("oneway:foot")) or "").lower()
        if one_way_foot in {"yes", "true", "1"} and reversed_way:
            continue
        if one_way_foot == "-1" and not reversed_way:
            continue
        nodes[str(u)] = coordinates[u]
        nodes[str(v)] = coordinates[v]
        tags = {tag: _string(data.get(tag)) for tag in WAY_TAGS if data.get(tag) is not None}
        tags["osmid"] = osmid
        foot = (tags.get("foot") or "").lower()
        sidewalk = (tags.get("sidewalk") or "").lower()
        tags["pedestrian_evidence"] = (
            "foot_tag" if foot in POSITIVE_FOOT else
            "pedestrian_way" if tags.get("highway") in PEDESTRIAN_HIGHWAYS else
            "sidewalk" if sidewalk in SIDEWALK_PRESENT else "inferred"
        )
        tags["access_unknown"] = tags["pedestrian_evidence"] == "inferred"
        edges.append({
            "id": f"{osmid}:{u}>{v}:{key}",
            "u": str(u),
            "v": str(v),
            "length_m": round(float(line.length), 2),
            "tags": tags,
        })

    if not edges:
        raise RuntimeError("No walkable OSM edges intersect the current CBD scene")

    payload = {
        "schema": "conditions-walking-network/1",
        "built_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "data/osm_cbd.osm.xml",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "attribution": "© OpenStreetMap contributors · ODbL",
        "crs": "viewer-local x/z metres; Hartbeesthoek94 Lo19 aligned to scene origin",
        "scene_bounds": [left, min_z, right, max_z],
        "buffer_m": BUFFER_M,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "nodes": [[node, xy[0], xy[1]] for node, xy in sorted(nodes.items())],
        "edges": edges,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8", compresslevel=9) as stream:
        json.dump(payload, stream, separators=(",", ":"), ensure_ascii=False)
        stream.write("\n")
    return {key: value for key, value in payload.items() if key not in {"nodes", "edges"}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output), indent=2))


if __name__ == "__main__":
    main()
