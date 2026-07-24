#!/usr/bin/env python3
"""Export reproducible local directional proxy fields from the wind database."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.field import (
    VALID_DIRECTIONS,
    build_field,
    load_viewer_config,
    project_polygons,
    query_polygons,
    request_from_payload,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path("data/wind_fields"))
    parser.add_argument("--size-m", type=float, default=250.0)
    parser.add_argument("--resolution-m", type=float, default=5.0)
    parser.add_argument("--speed-mps", type=float, default=10.0)
    parser.add_argument("--directions", nargs="+", default=["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW", "CAPE_DOCTOR"])
    args = parser.parse_args()
    config = load_viewer_config()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for token in args.directions:
        key = token.upper()
        if key not in VALID_DIRECTIONS:
            raise SystemExit(f"Unsupported direction: {token}")
        direction = VALID_DIRECTIONS[key]
        request = request_from_payload({"center_local": [0, 0], "size_m": args.size_m, "direction_deg": direction, "reference_speed_mps": args.speed_mps, "resolution_m": args.resolution_m}, config)
        bounds = (request.center_local[0] - request.size_m / 2, request.center_local[1] - request.size_m / 2, request.center_local[0] + request.size_m / 2, request.center_local[1] + request.size_m / 2)
        polygons = project_polygons(query_polygons(request, bounds, config), config)
        field = build_field(request, bounds, polygons)
        field["direction_name"] = key.lower()
        field["polygon_count"] = len(polygons)
        output = args.output_dir / f"{key.lower()}.json"
        output.write_text(json.dumps(field, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"{key}: {output}")


if __name__ == "__main__":
    main()
