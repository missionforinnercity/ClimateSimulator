#!/usr/bin/env python3
"""Build the SUMO road network used by the traffic simulation.

Reuses the same OSM XML fetch as ``download_osm_roads.py`` (main OSM API,
bbox derived from ``manifest.json``), but keeps the raw XML instead of
reducing it to a lossy GeoJSON, and hands it to SUMO's ``netconvert`` to
build a routable network with real intersection topology, turn
restrictions, and oneway/lane data.

Mapped OSM traffic signals are retained. ``server/traffic.py`` uses their
SUMO programs by default and exposes priority right-of-way as an explicit
comparison mode, rather than silently removing intersection delay.

Cape Town drives on the left. ``--lefthand`` is mandatory here: without it,
one-way edge directions remain intact but lane offsets, lane changing and
junction approach behaviour are generated for right-hand traffic.

Pass ``--reuse-osm`` to rebuild from the already-downloaded XML instead of
re-fetching it from the OSM API.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import requests
from pyproj import Transformer

LOCAL_CRS = "+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"
ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "public/assets/manifest.json"
OSM_XML_OUTPUT = ROOT / "data/osm_cbd.osm.xml"
NET_OUTPUT = ROOT / "data/sumo/cbd.net.xml"


def _cbd_bbox() -> tuple[float, float, float, float]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    origin_x, origin_y = manifest["origin"]
    left, bottom, right, top = manifest["bounds"]
    transformer = Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)
    corners = [transformer.transform(origin_x + x, origin_y + y) for x, y in ((left, bottom), (left, top), (right, bottom), (right, top))]
    longitudes, latitudes = zip(*corners)
    return min(latitudes), min(longitudes), max(latitudes), max(longitudes)


def _download_osm_xml(south: float, west: float, north: float, east: float) -> bytes:
    url = f"https://api.openstreetmap.org/api/0.6/map?bbox={west},{south},{east},{north}"
    response = requests.get(url, timeout=120, headers={"User-Agent": "CapeTownClimateExplorer/1.0"})
    response.raise_for_status()
    return response.content


def _sumo_typemap() -> Path:
    import sumo

    typemap = Path(sumo.__file__).resolve().parent / "data" / "typemap" / "osmNetconvert.typ.xml"
    if not typemap.exists():
        raise RuntimeError(f"expected SUMO OSM typemap at {typemap}, not found")
    return typemap


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reuse-osm",
        action="store_true",
        help="rebuild from the already-downloaded OSM XML instead of re-fetching it",
    )
    arguments = parser.parse_args()

    if arguments.reuse_osm and OSM_XML_OUTPUT.exists():
        print(f"Reusing existing OSM XML at {OSM_XML_OUTPUT} ({OSM_XML_OUTPUT.stat().st_size} bytes)")
    else:
        south, west, north, east = _cbd_bbox()
        print(f"Requesting OSM XML for bbox south={south:.6f} west={west:.6f} north={north:.6f} east={east:.6f}", flush=True)
        osm_xml = _download_osm_xml(south, west, north, east)
        OSM_XML_OUTPUT.write_bytes(osm_xml)
        print(f"Saved raw OSM XML to {OSM_XML_OUTPUT} ({len(osm_xml)} bytes)")

    NET_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    typemap = _sumo_typemap()
    command = [
        "netconvert",
        "--osm-files",
        str(OSM_XML_OUTPUT),
        "--type-files",
        str(typemap),
        "--output-file",
        str(NET_OUTPUT),
        "--output.street-names",
        "true",
        "--lefthand",
        "--geometry.remove",
        "true",
        "--roundabouts.guess",
        "true",
        "--ramps.guess",
        "true",
        "--junctions.join",
        "true",
        "--remove-edges.isolated",
        "true",
    ]
    print("Running:", " ".join(command), flush=True)
    subprocess.run(command, check=True, cwd=ROOT)
    print(f"Wrote SUMO network to {NET_OUTPUT}")


if __name__ == "__main__":
    main()
