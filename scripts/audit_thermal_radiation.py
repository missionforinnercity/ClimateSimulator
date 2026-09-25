#!/usr/bin/env python3
"""Run a reproducible radiation-component audit without publishing a forecast."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import thermal_worker as worker
from server.weather_forcing import normalize_satellite_radiation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--forcing', type=Path, required=True)
    parser.add_argument('--at', required=True, help='Exact UTC forcing timestamp')
    parser.add_argument('--surfaces', type=Path, default=worker.SURFACE_ROOT)
    parser.add_argument('--native-payload', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--work-dir', type=Path, required=True)
    args = parser.parse_args()
    worker.SURFACE_ROOT = args.surfaces
    rows = json.loads(args.forcing.read_text())['rows']
    row = next(dict(item) for item in rows if item['valid_at'] == args.at)
    if args.native_payload:
        native = normalize_satellite_radiation(json.loads(args.native_payload.read_text()), native=True)[-1]
        row.update({key: native[key] for key in (*native['provenance'], 'valid_at', 'radiation')})
    args.work_dir.mkdir(parents=True, exist_ok=True)
    products, model = worker.run_solweig([row], [row], args.work_dir)
    result = products[0]
    _, atlas_paths = worker.load_wind_atlas()
    with np.load(atlas_paths[worker.sector_index(row['wind_direction_10m_deg'])]) as atlas:
        speed = np.maximum(atlas['speed_ratio_10'] * row['wind_speed_10m_mps'], .5)
        all_valid = atlas['valid'].astype(bool) & np.isfinite(result['tmrt'])
    valid = all_valid & result['ground_mask']
    utci = worker.calculate_utci(row['temperature_2m_c'], result['tmrt'], speed, row['relative_humidity_2m_pct'])
    no_radiant_excess = worker.calculate_utci(row['temperature_2m_c'], np.full_like(result['tmrt'], row['temperature_2m_c']), speed, row['relative_humidity_2m_pct'])
    report = {
        'valid_at': row['valid_at'], 'model': model,
        'forcing': {key: row.get(key) for key in ('temperature_2m_c','relative_humidity_2m_pct','global_radiation_wm2','direct_radiation_wm2','diffuse_radiation_wm2','radiation')},
        'ground_cells': int(valid.sum()), 'all_cells_including_roofs': int(all_valid.sum()),
        'radiation_diagnostics': result['diagnostics'],
        'utci_ground_c': worker.radiation_summary(utci, valid),
        'utci_including_roofs_c': worker.radiation_summary(utci, all_valid),
        'utci_without_radiant_excess_c': worker.radiation_summary(no_radiant_excess, valid),
        'radiation_effect_on_utci_c': worker.radiation_summary(utci-no_radiant_excess, valid),
        'wind_10m_mps': worker.radiation_summary(speed, valid),
        'limitations': ['Horizontal fluxes do not include the full lateral human radiation budget.',
                        'Tmrt=air counterfactual diagnoses combined radiation effect, not separate shortwave/longwave effects.',
                        'Single-frame run starts without prior surface thermal history; not field validation.'],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
