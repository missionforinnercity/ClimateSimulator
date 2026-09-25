#!/usr/bin/env python3
"""Build the pinned SuPy/SUEWS CBD site config from prepared 250 m cells."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import yaml
from supy import SUEWSSimulation


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cells", type=Path, default=Path("data/thermal/surfaces/suews_cells.geojson"))
    parser.add_argument("--output", type=Path, default=Path("data/thermal/suews/config.yml"))
    args = parser.parse_args()
    source = json.loads(args.cells.read_text(encoding="utf-8"))
    features = source.get("features", [])
    if not features:
        raise SystemExit("SUEWS cell GeoJSON has no features")
    weights = [float(f["properties"].get("valid_area_m2", 0.0)) for f in features]
    if sum(weights) <= 0:
        raise SystemExit("SUEWS cells have no valid area")
    keys = ("paved", "building", "grass", "water", "bare_soil", "tree")
    fractions = {key: sum(w * float(f["properties"]["surface_fractions"].get(key, 0.0))
                          for f, w in zip(features, weights)) / sum(weights) for key in keys}
    # SuPy's sample configuration is the supported schema baseline.  We only
    # replace site-specific CBD geometry and land-cover fractions here; all
    # other physics/defaults remain versioned by the pinned SuPy release.
    simulation = SUEWSSimulation.from_sample_data()
    config = copy.deepcopy(simulation.config._yaml_raw)
    site = config["sites"][0]
    props = site["properties"]
    props["lat"]["value"] = -33.925
    props["lng"]["value"] = 18.424
    props["timezone"]["value"] = 2
    props["surfacearea"]["value"] = float(sum(weights))
    mean_height = sum(w * float(f["properties"].get("mean_building_height_m", 0.0))
                      for f, w in zip(features, weights)) / sum(weights)
    props["z"]["value"] = max(10.0, mean_height * 2.0)
    props["land_cover"]["paved"]["sfr"]["value"] = fractions["paved"]
    props["land_cover"]["bldgs"]["sfr"]["value"] = fractions["building"]
    props["land_cover"]["grass"]["sfr"]["value"] = fractions["grass"]
    props["land_cover"]["water"]["sfr"]["value"] = fractions["water"]
    props["land_cover"]["bsoil"]["sfr"]["value"] = fractions["bare_soil"]
    props["land_cover"]["dectr"]["sfr"]["value"] = fractions["tree"]
    props["land_cover"]["evetr"]["sfr"]["value"] = 0.0
    props["land_cover"]["bldgs"]["bldgh"]["value"] = max(2.0, mean_height)
    config["name"] = "cape_town_cbd_thermal"
    config["description"] = "Cape Town CBD SUEWS site generated from 250 m morphology cells; model defaults retained where source data are unavailable."
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "cells": len(features), "fractions": fractions}, indent=2))


if __name__ == "__main__":
    main()
