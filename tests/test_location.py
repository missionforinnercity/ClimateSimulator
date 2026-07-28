from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from server.location import streetview_location


def test_streetview_link_converts_scene_center_to_cape_town():
    result = streetview_location(0, 0)
    assert -34.0 < result["latitude"] < -33.8
    assert 18.3 < result["longitude"] < 18.6
    parsed = urlparse(result["streetview_url"])
    query = parse_qs(parsed.query)
    assert parsed.netloc == "www.google.com"
    assert query["api"] == ["1"]
    assert query["map_action"] == ["pano"]
    assert query["viewpoint"][0].startswith(f"{result['latitude']:.7f},")


def test_streetview_link_rejects_points_outside_scene():
    with pytest.raises(ValueError, match="outside"):
        streetview_location(100_000, 100_000)
