from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from scripts import city_model


ROOT = Path(__file__).resolve().parents[1]


def test_semantic_city_model_has_stable_identity_and_common_metadata():
    model = json.loads((ROOT / "public/assets/city_model.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "public/assets/manifest.json").read_text(encoding="utf-8"))
    objects = model["cityObjects"]

    assert model["conceptualModel"] == "OGC CityGML 3.0"
    assert "non-conformant" in model["encodingProfile"]
    assert len(objects) == manifest["layers"]["city_model"]["objects"]
    assert len({item["identifier"] for item in objects.values()}) == len(objects)
    assert all(key == item["featureId"] for key, item in objects.items())
    assert all("lod" in item["geometry"] for item in objects.values())
    assert all(item["sources"] and "quality" in item and "lifecycle" in item for item in objects.values())
    assert all(source in model["sources"] for item in objects.values() for source in item["sources"])


def test_semantic_types_and_building_roof_relationships_are_explicit():
    model = json.loads((ROOT / "public/assets/city_model.json").read_text(encoding="utf-8"))
    objects = model["cityObjects"]
    counts = Counter(item["type"] for item in objects.values())

    assert counts["ReliefFeature"] == 1
    assert counts["Building"] > 0
    assert counts["Building"] == counts["RoofSurface"]
    assert counts["Road"] > 0 and counts["TrafficSpace"] > 0 and counts["Railway"] > 0
    assert counts["PlantCover"] > 0 and counts["SolitaryVegetationObject"] > 0
    for building in (item for item in objects.values() if item["type"] == "Building"):
        roof_id = building["relationships"]["boundaries"][0]
        assert objects[roof_id]["type"] == "RoofSurface"
        assert objects[roof_id]["relationships"]["parent"] == building["featureId"]


def test_municipal_street_data_is_clipped_and_semantically_typed():
    model = json.loads((ROOT / "public/assets/city_model.json").read_text(encoding="utf-8"))
    objects = model["cityObjects"].values()
    classes = Counter(item["attributes"].get("class") for item in objects)

    assert classes["publicLight"] > 3000
    assert classes["parkingSpace"] > 3000
    assert classes["pedestrianCrossing"] > 300
    assert classes["monument"] > 40
    assert classes["publicToilet"] > 0
    assert classes["surveyMark"] > 50
    assert classes["festoonLighting"] == 5
    municipal_roads = [item for item in objects if "municipalRoads" in item["sources"]]
    assert municipal_roads
    assert sum(":RCL" in item["identifier"] for item in municipal_roads) > 700
    assert all(item["identifier"].startswith("urn:za.capetown.climate-explorer:municipal-road:") for item in municipal_roads)
    assert all(item["attributes"].get("owner") or item["attributes"].get("maintainingAuthority") for item in municipal_roads)


def test_street_assets_have_road_orientation_and_honest_model_dimensions():
    model = json.loads((ROOT / "public/assets/city_model.json").read_text(encoding="utf-8"))
    objects = list(model["cityObjects"].values())
    lights = [item for item in objects if item["attributes"].get("class") == "publicLight"]
    parking = [item for item in objects if item["attributes"].get("class") == "parkingSpace"]
    crossings = [item for item in objects if item["attributes"].get("class") == "pedestrianCrossing"]

    assert {item["attributes"]["inferredHeightM"] for item in lights} <= {6.0, 8.0, 10.0, 12.0, 18.0}
    assert all("source inventory has no measured pole height" in item["attributes"]["heightConfidence"] for item in lights)
    assert sum("roadFacingDeg" in item["attributes"] for item in lights) > 3500
    assert sum("roadBearingDeg" in item["attributes"] for item in parking) > 3300
    assert all(item["attributes"]["inferredBayLengthM"] == 5.2 for item in parking)
    assert sum("roadWidthM" in item["attributes"] for item in crossings) > 375
    oriented_street_objects = [*lights, *parking, *crossings]
    assert all(
        item["attributes"].get("roadWidthM", 0) <= 18.0
        for item in oriented_street_objects
    )
    assert sum(item["attributes"].get("crossingDesign") == "daisy" for item in crossings) == 1
    assert sum(item["attributes"].get("crossingDesign") == "coveredByDaisyInstallation" for item in crossings) == 3
    daisy = next(item for item in crossings if item["attributes"].get("crossingDesign") == "daisy")
    assert daisy["attributes"]["roadName"] == "STRAND"
    assert daisy["attributes"]["implementedBy"] == "Mission for Inner City Cape Town"


def test_municipal_road_ribbons_have_sanitized_widths_and_simplified_lines():
    model = json.loads((ROOT / "public/assets/city_model.json").read_text(encoding="utf-8"))
    roads = [
        item for item in model["cityObjects"].values()
        if "municipalRoads" in item["sources"] and item["type"] == "Road"
    ]
    assert roads
    assert all(2.5 <= item["geometry"]["nominalWidthM"] <= 18.0 for item in roads)
    assert all(len(item["geometry"]["centerline"]) >= 2 for item in roads)
    assert max(len(item["geometry"]["centerline"]) for item in roads) < 180


def test_osm_visible_network_retains_continuous_coloured_road_hierarchy():
    model = json.loads((ROOT / "public/assets/city_model.json").read_text(encoding="utf-8"))
    osm_roads = [
        item for item in model["cityObjects"].values()
        if "roads" in item["sources"] and item["geometry"].get("centerline")
    ]
    classes = Counter(item["attributes"].get("renderClass") for item in osm_roads)
    assert classes["primary"] > 50
    assert classes["secondary"] > 100
    assert classes["tertiary"] > 50
    assert classes["residential"] > 200


def test_osm_point_furniture_is_preserved_with_honest_generic_geometry():
    model = json.loads((ROOT / "public/assets/city_model.json").read_text(encoding="utf-8"))
    furniture = [
        item for item in model["cityObjects"].values()
        if "osmPointFurniture" in item["sources"]
    ]
    classes = Counter(item["attributes"].get("class") for item in furniture)

    assert classes["fountain"] > 0
    assert classes["bench"] > 0
    assert classes["wasteBasket"] > 0
    assert classes["bicycleParking"] > 0
    assert classes["bollard"] > 0
    assert classes["busStop"] > 0
    assert all(item["geometry"]["type"] == "Point" for item in furniture)
    assert all(item["quality"]["dimensions"] == "inferred" for item in furniture)
    assert all(item["attributes"].get("osmId") for item in furniture)


def test_municipal_lane_count_handles_transition_values():
    assert city_model._road_lane_count("2-3") == 3
    assert city_model._road_lane_count("1,2-3,2") == 3
    assert city_model._road_lane_count(None) == 1
    assert city_model._road_lane_count("99") == 8
