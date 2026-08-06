"""Runtime access to the compact ERA5 Cape Town forcing climatology."""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

CLIMATOLOGY_PATH = Path(__file__).resolve().parents[1] / "data" / "wind_climatology" / "cape_town_era5.json"
SECTORS = {name: index * 22.5 for index, name in enumerate(("n", "nne", "ne", "ene", "e", "ese", "se", "sse", "s", "ssw", "sw", "wsw", "w", "wnw", "nw", "nnw"))}


@functools.lru_cache(maxsize=1)
def load_climatology() -> dict[str, Any] | None:
    if not CLIMATOLOGY_PATH.exists():
        return None
    return json.loads(CLIMATOLOGY_PATH.read_text(encoding="utf-8"))


def nearest_sector(direction_deg: float) -> str:
    normalized = direction_deg % 360.0
    return min(SECTORS, key=lambda name: abs(((SECTORS[name] - normalized + 180.0) % 360.0) - 180.0))


def forcing_profile(season: str, direction_deg: float, stability: str) -> dict[str, Any] | None:
    climatology = load_climatology()
    if climatology is None:
        return None
    sector = nearest_sector(direction_deg)
    season_profiles = climatology["profiles"].get(season, climatology["profiles"]["annual"])
    group = season_profiles.get(stability, season_profiles["all"])
    item = group["sectors"].get(sector)
    if item is None:
        item = season_profiles["all"]["sectors"].get(sector)
    if item is None:
        return None
    return {
        **item,
        "sector": sector,
        "season": season,
        "stability": stability,
        "dataset_version": climatology["version"],
        "coverage": climatology["coverage"],
    }


def climatology_summary() -> dict[str, Any] | None:
    data = load_climatology()
    if data is None:
        return None
    return {key: data[key] for key in ("version", "generated_at", "source", "location", "coverage")}
