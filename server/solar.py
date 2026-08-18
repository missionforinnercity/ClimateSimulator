"""Shared local solar position and planning-grade shadow geometry."""

from __future__ import annotations

from datetime import date
import math
from typing import Any

from shapely.affinity import translate
from shapely.geometry import Polygon
from shapely.ops import unary_union


def sun_position(date_text: str, minutes: int) -> tuple[float, float, float]:
    """Return altitude and local east/south horizontal unit components."""
    selected = date.fromisoformat(date_text)
    day_of_year = selected.timetuple().tm_yday
    hour = minutes / 60.0
    gamma = 2 * math.pi / 365 * (day_of_year - 1 + (hour - 12) / 24)
    equation = 229.18 * (
        0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma)
    )
    declination = (
        0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma)
    )
    latitude = math.radians(-33.9249)
    solar_minutes = minutes + equation + 4 * 18.4241 - 120
    hour_angle = math.radians(solar_minutes / 4 - 180)
    altitude = math.asin(max(-1.0, min(1.0, math.sin(latitude) * math.sin(declination) + math.cos(latitude) * math.cos(declination) * math.cos(hour_angle))))
    azimuth = (math.atan2(math.sin(hour_angle), math.cos(hour_angle) * math.sin(latitude) - math.tan(declination) * math.cos(latitude)) + math.pi) % (2 * math.pi)
    return altitude, math.sin(azimuth) * math.cos(altitude), -math.cos(azimuth) * math.cos(altitude)


def cast_shadow(
    geometry: Any, height: float, altitude: float, sun_x: float, sun_z: float,
    *, swept: bool = True, max_distance: float = 500.0,
) -> Any:
    """Project geometry to the ground; optionally include its vertical sweep.

    The sweep is the exact Minkowski sum of each polygon with the ground
    displacement segment.  Sweeping every exterior and interior boundary edge
    retains concavities and leaves the portion of a courtyard that can still
    see the sun open.  A convex hull cannot represent either property.
    """
    if geometry.is_empty or altitude <= 0.008 or height <= 0:
        return Polygon()
    distance = min(max_distance, height / max(math.tan(altitude), 0.03))
    length = math.hypot(sun_x, sun_z) or 1.0
    dx, dz = -sun_x / length * distance, -sun_z / length * distance
    parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else (geometry,)
    shadows = []
    for part in parts:
        if part.geom_type != "Polygon" or part.is_empty:
            continue
        shifted = translate(part, xoff=dx, yoff=dz)
        if not swept:
            shadows.append(shifted)
            continue
        swept_parts = [part, shifted]
        for ring in (part.exterior, *part.interiors):
            coordinates = list(ring.coords)
            for start, end in zip(coordinates, coordinates[1:]):
                strip = Polygon([
                    start, end,
                    (end[0] + dx, end[1] + dz),
                    (start[0] + dx, start[1] + dz),
                ])
                if not strip.is_empty and strip.area > 1e-10:
                    swept_parts.append(strip)
        shadow = unary_union(swept_parts)
        shadows.append(shadow if shadow.is_valid else shadow.buffer(0))
    return unary_union(shadows) if shadows else Polygon()
