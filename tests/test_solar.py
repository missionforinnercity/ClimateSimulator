from __future__ import annotations

import math

from shapely.geometry import MultiPolygon, Point, Polygon

from server.solar import cast_shadow


ALTITUDE_45_DEGREES = math.pi / 4


def eastward_shadow(geometry, distance=2.0, *, swept=True):
    # At 45 degrees, height and horizontal shadow distance are equal. A sun
    # vector pointing west casts the shadow east.
    return cast_shadow(
        geometry, distance, ALTITUDE_45_DEGREES, -1.0, 0.0, swept=swept,
    )


def test_l_shaped_shadow_does_not_fill_the_convex_hull_notch():
    footprint = Polygon([(0, 0), (4, 0), (4, 1), (1, 1), (1, 4), (0, 4)])

    shadow = eastward_shadow(footprint)

    assert not shadow.covers(Point(3.5, 3.0))
    assert shadow.covers(Point(2.5, 0.5))
    assert shadow.area < eastward_shadow(footprint).convex_hull.area


def test_u_shaped_shadow_keeps_the_unswept_setback_open():
    footprint = Polygon([
        (0, 0), (5, 0), (5, 5), (4, 5),
        (4, 1), (1, 1), (1, 5), (0, 5),
    ])

    shadow = eastward_shadow(footprint)

    assert not shadow.covers(Point(3.5, 4.0))
    assert shadow.covers(Point(2.0, 0.5))


def test_courtyard_shadow_preserves_only_the_still_sunlit_hole():
    footprint = Polygon(
        [(0, 0), (10, 0), (10, 10), (0, 10)],
        [[(3, 3), (7, 3), (7, 7), (3, 7)]],
    )

    shadow = eastward_shadow(footprint)

    assert shadow.covers(Point(4.0, 5.0))  # shade cast by the west courtyard wall
    assert not shadow.covers(Point(6.0, 5.0))  # remaining direct-sun opening
    assert len(shadow.interiors) == 1


def test_non_swept_and_multipolygon_shadows_keep_source_topology():
    courtyard = Polygon(
        [(0, 0), (8, 0), (8, 8), (0, 8)],
        [[(2, 2), (6, 2), (6, 6), (2, 6)]],
    )
    detached = Polygon([(12, 0), (14, 0), (14, 2), (12, 2)])

    shadow = eastward_shadow(MultiPolygon([courtyard, detached]), swept=False)

    assert not shadow.covers(Point(6.0, 4.0))
    assert shadow.covers(Point(14.5, 1.0))
