#!/usr/bin/env python3
"""Fetch a resumable multi-year, hourly Cape Town ERA5 wind archive."""

from __future__ import annotations

import argparse
import calendar
import os
from pathlib import Path

import cdsapi
from dotenv import load_dotenv


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-year", type=int, default=2021)
    parser.add_argument("--end-year", type=int, default=2025)
    parser.add_argument("--output-dir", type=Path, default=Path("data/era5_monthly_2021_2025"))
    args = parser.parse_args()
    if args.end_year < args.start_year:
        parser.error("end year must be on or after start year")
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    key = os.environ.get("ERA5API")
    if not key:
        raise SystemExit("ERA5API is missing from .env")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    client = cdsapi.Client(
        url=os.environ.get("CDSAPI_URL", "https://cds.climate.copernicus.eu/api"),
        key=key,
    )
    total = (args.end_year - args.start_year + 1) * 12
    completed = 0
    for year in range(args.start_year, args.end_year + 1):
        for month in range(1, 13):
            completed += 1
            target = args.output_dir / f"cape_town_era5_{year}_{month:02d}.grib"
            if target.exists() and target.stat().st_size > 1024:
                print(f"[{completed}/{total}] exists {target}", flush=True)
                continue
            request = {
                "product_type": ["reanalysis"],
                "variable": [
                    "10m_u_component_of_wind", "10m_v_component_of_wind",
                    "100m_u_component_of_wind", "100m_v_component_of_wind",
                    "10m_u_component_of_neutral_wind", "10m_v_component_of_neutral_wind",
                    "10m_wind_gust_since_previous_post_processing", "instantaneous_10m_wind_gust",
                ],
                "year": [str(year)],
                "month": [f"{month:02d}"],
                "day": [f"{day:02d}" for day in range(1, calendar.monthrange(year, month)[1] + 1)],
                "time": [f"{hour:02d}:00" for hour in range(24)],
                "data_format": "grib",
                "download_format": "unarchived",
                "area": [-33.50, 18.25, -34.50, 19.00],
            }
            print(f"[{completed}/{total}] requesting {year}-{month:02d}", flush=True)
            temporary = target.with_suffix(".grib.part")
            client.retrieve("reanalysis-era5-single-levels", request, str(temporary))
            if temporary.stat().st_size <= 1024:
                temporary.unlink(missing_ok=True)
                raise RuntimeError(f"CDS returned an unexpectedly small file for {year}-{month:02d}")
            temporary.replace(target)
    print(f"Archive ready in {args.output_dir}")


if __name__ == "__main__":
    main()
