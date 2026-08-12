from __future__ import annotations

from shapely.geometry import Polygon

import server.mitigation as mitigation


def reference_layers():
    return {
        "heat": [{
            "geometry": Polygon([(0, 0), (10, 0), (10, 10), (0, 10)]),
            "surface_c": 35.0,
            "air_c": 22.0,
            "pedestrian_c": 12.0,
            "land_type": "Impervious",
        }],
        "buildings": Polygon([(2, 2), (8, 2), (8, 8), (2, 8)]),
        "canopies": Polygon([(0, 0), (5, 0), (5, 5), (0, 5)]),
    }


def preview(method: str, monkeypatch, date="2026-01-15", minutes=720):
    monkeypatch.setattr(mitigation, "_reference_layers", reference_layers)
    return mitigation.mitigation_preview({
        "interventions": [{
            "id": "test",
            "method": method,
            "height_m": 3,
            "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
        }],
        "sun_date": date,
        "sun_minutes": minutes,
    })


def test_cool_pavement_returns_low_central_high_and_temperature_floor(monkeypatch):
    result = preview("cool_pavement", monkeypatch)
    estimates = result["zones"][0]["estimates"]
    assert estimates["low"]["surface_reduction_c"] == 5
    assert estimates["central"]["surface_reduction_c"] == 7
    assert estimates["high"]["surface_temperature_c"] == 22
    assert result["status"].startswith("planning_estimate")


def test_nighttime_shade_has_zero_thermal_benefit(monkeypatch):
    result = preview("constructed_shade", monkeypatch, minutes=0)
    assert result["sun"]["daylight"] is False
    assert result["zones"][0]["estimates"]["central"]["surface_reduction_c"] == 0


def test_green_roof_is_clipped_to_eligible_roof(monkeypatch):
    result = preview("green_roof", monkeypatch)
    assert result["interventions"][0]["treated_area_m2"] == 36
    assert result["interventions"][0]["affected_or_shaded_area_m2"] == 36


def test_canopy_protection_is_clipped_to_existing_canopy(monkeypatch):
    result = preview("canopy_protection", monkeypatch)
    assert result["interventions"][0]["treated_area_m2"] == 25


def test_invalid_intervention_polygon_is_rejected(monkeypatch):
    monkeypatch.setattr(mitigation, "_reference_layers", reference_layers)
    try:
        mitigation.mitigation_preview({
            "interventions": [{"method": "added_canopy", "geometry": {"type": "Point", "coordinates": [0, 0]}}],
        })
    except ValueError as error:
        assert "Polygon" in str(error)
    else:
        raise AssertionError("non-polygon intervention should fail")


def test_self_intersecting_freehand_polygon_is_repaired(monkeypatch):
    monkeypatch.setattr(mitigation, "_reference_layers", reference_layers)
    result = mitigation.mitigation_preview({
        "interventions": [{
            "method": "constructed_shade",
            "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]]},
        }],
        "sun_date": "2026-01-15",
        "sun_minutes": 720,
    })
    assert result["summary"]["treated_area_m2"] > 0


def test_cool_roof_is_clipped_to_building_roof(monkeypatch):
    result = preview("cool_roof", monkeypatch)
    assert result["interventions"][0]["treated_area_m2"] == 36
    assert result["zones"][0]["estimates"]["central"]["pedestrian_reduction_c"] == 0


def test_permeable_pavement_reports_conceptual_runoff_capture(monkeypatch):
    result = preview("permeable_pavement", monkeypatch)
    # The eligible 100 m² drawing excludes the 36 m² building footprint.
    assert result["summary"]["treated_area_m2"] == 64
    assert result["summary"]["co_benefits"]["conceptual_runoff_capture_m3"] == 1.6
    assert result["interventions"][0]["parameter"]["key"] == "runoff_capture_mm"


def test_rain_garden_uses_a_cooling_buffer(monkeypatch):
    result = preview("rain_garden", monkeypatch)
    intervention = result["interventions"][0]
    assert intervention["affected_or_shaded_area_m2"] > intervention["treated_area_m2"]
    assert intervention["parameter"]["key"] == "influence_m"


def test_canopy_maturity_scales_temperature_effect(monkeypatch):
    monkeypatch.setattr(mitigation, "_reference_layers", reference_layers)
    result = mitigation.mitigation_preview({
        "interventions": [{
            "method": "added_canopy",
            "maturity_pct": 50,
            "height_m": 8,
            "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
        }],
        "sun_date": "2026-01-15",
        "sun_minutes": 720,
    })
    assert result["interventions"][0]["co_benefits"]["added_canopy_m2"] == 32
    assert result["zones"][0]["estimates"]["central"]["surface_reduction_c"] < 5
