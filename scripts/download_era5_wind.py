#!/usr/bin/env python3
"""Download one complete month of Cape Town ERA5 wind forcing."""

from __future__ import annotations

import argparse
import calendar
import os
from pathlib import Path

import cdsapi
from dotenv import load_dotenv


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--month", type=int, choices=range(1, 13), required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("data/era5_monthly"))
    args = parser.parse_args()
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    key = os.environ.get("ERA5API")
    if not key:
        raise SystemExit("ERA5API is missing from .env")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    target = args.output_dir / f"cape_town_era5_{args.year}_{args.month:02d}.grib"
    request = {
        "product_type": ["reanalysis"],
        "variable": [
            "10m_u_component_of_wind", "10m_v_component_of_wind",
            "100m_u_component_of_wind", "100m_v_component_of_wind",
            "10m_u_component_of_neutral_wind", "10m_v_component_of_neutral_wind",
            "10m_wind_gust_since_previous_post_processing", "instantaneous_10m_wind_gust",
        ],
        "year": [str(args.year)],
        "month": [f"{args.month:02d}"],
        "day": [f"{day:02d}" for day in range(1, calendar.monthrange(args.year, args.month)[1] + 1)],
        "time": [f"{hour:02d}:00" for hour in range(24)],
        "data_format": "grib",
        "download_format": "unarchived",
        "area": [-33.50, 18.25, -34.50, 19.00],
    }
    client = cdsapi.Client(url=os.environ.get("CDSAPI_URL", "https://cds.climate.copernicus.eu/api"), key=key)
    client.retrieve("reanalysis-era5-single-levels", request, str(target))
    print(f"downloaded {target}")


if __name__ == "__main__":
    main()
