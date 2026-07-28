"""Location-link helpers for points selected in the local CBD scene."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from .field import load_viewer_config, local_to_web


def streetview_location(x: float, z: float) -> dict[str, Any]:
    config = load_viewer_config()
    left, bottom, right, top = (float(value) for value in config["bounds"])
    min_z, max_z = -top, -bottom
    if x < left or x > right or z < min_z or z > max_z:
        raise ValueError("selected point is outside the Cape Town CBD scene")
    longitude, latitude = local_to_web(float(x), float(z), config)
    query = urlencode({
        "api": 1,
        "map_action": "pano",
        "viewpoint": f"{latitude:.7f},{longitude:.7f}",
    })
    return {
        "x": round(float(x), 3),
        "z": round(float(z), 3),
        "latitude": round(latitude, 7),
        "longitude": round(longitude, 7),
        "streetview_url": f"https://www.google.com/maps/@?{query}",
        "note": "Google Maps opens the Street View panorama nearest to this viewpoint when imagery is available.",
    }
