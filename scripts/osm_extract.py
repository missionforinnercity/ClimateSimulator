"""Small, deterministic OSM XML extractor used by the offline scene builds.

The checked-in OSM extract is the source of truth.  Keeping this reader local
avoids an Overpass dependency during production builds and, unlike the old
way-only import, preserves multipolygon relations and their interior rings.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

from pyproj import Transformer
from shapely.geometry import LineString, Polygon
from shapely.ops import linemerge, polygonize, unary_union


LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"


@dataclass(frozen=True)
class OSMNode:
    identifier: str
    x: float
    y: float
    tags: dict[str, str]


@dataclass(frozen=True)
class OSMWay:
    identifier: str
    refs: tuple[str, ...]
    tags: dict[str, str]


@dataclass(frozen=True)
class OSMRelation:
    identifier: str
    members: tuple[tuple[str, str, str], ...]
    tags: dict[str, str]


@dataclass
class OSMExtract:
    nodes: dict[str, OSMNode]
    ways: dict[str, OSMWay]
    relations: list[OSMRelation]

    def way_coordinates(self, way: OSMWay) -> list[tuple[float, float]]:
        return [(self.nodes[ref].x, self.nodes[ref].y) for ref in way.refs if ref in self.nodes]

    def way_line(self, way: OSMWay):
        coordinates = self.way_coordinates(way)
        return LineString(coordinates) if len(coordinates) >= 2 else None

    def way_polygon(self, way: OSMWay):
        coordinates = self.way_coordinates(way)
        if len(coordinates) < 4 or coordinates[0] != coordinates[-1]:
            return None
        polygon = Polygon(coordinates)
        return polygon if polygon.is_valid else polygon.buffer(0)

    def relation_polygons(self, relation: OSMRelation, outer_roles=("outer", "outline", "")):
        """Assemble split member ways and subtract explicitly mapped holes."""
        outer_lines = []
        inner_lines = []
        for member_type, reference, role in relation.members:
            if member_type != "way" or reference not in self.ways:
                continue
            line = self.way_line(self.ways[reference])
            if line is None:
                continue
            if role == "inner":
                inner_lines.append(line)
            elif role in outer_roles:
                outer_lines.append(line)

        def polygons(lines):
            if not lines:
                return []
            united = unary_union(lines)
            merged = united if united.geom_type == "LineString" else linemerge(united)
            return [polygon for polygon in polygonize(merged) if not polygon.is_empty]

        outers = polygons(outer_lines)
        inners = polygons(inner_lines)
        inner_union = unary_union(inners) if inners else None
        result = []
        for outer in outers:
            geometry = outer.difference(inner_union) if inner_union is not None else outer
            if not geometry.is_empty:
                result.extend(geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,))
        return result


def load_osm(path: Path | str) -> OSMExtract:
    root = ElementTree.parse(path).getroot()
    to_local = Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)
    nodes = {}
    for element in root.findall("node"):
        x, y = to_local.transform(float(element.attrib["lon"]), float(element.attrib["lat"]))
        nodes[element.attrib["id"]] = OSMNode(
            element.attrib["id"], x, y,
            {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")},
        )
    ways = {
        element.attrib["id"]: OSMWay(
            element.attrib["id"],
            tuple(nd.attrib["ref"] for nd in element.findall("nd")),
            {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")},
        )
        for element in root.findall("way")
    }
    relations = [
        OSMRelation(
            element.attrib["id"],
            tuple((member.attrib["type"], member.attrib["ref"], member.attrib.get("role", "")) for member in element.findall("member")),
            {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")},
        )
        for element in root.findall("relation")
    ]
    return OSMExtract(nodes, ways, relations)


def polygon_parts(geometry):
    if geometry is None or geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    return [part for part in getattr(geometry, "geoms", []) if part.geom_type == "Polygon"]
