from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


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
    assert sum(item["attributes"].get("crossingDesign") == "daisy" for item in crossings) == 1
    assert sum(item["attributes"].get("crossingDesign") == "coveredByDaisyInstallation" for item in crossings) == 3
    daisy = next(item for item in crossings if item["attributes"].get("crossingDesign") == "daisy")
    assert daisy["attributes"]["roadName"] == "STRAND"
    assert daisy["attributes"]["implementedBy"] == "Mission for Inner City Cape Town"
