from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import shapes
from shapely.geometry import shape
from shapely.ops import unary_union

from server.flood import flood_preview

ROOT = Path(__file__).resolve().parents[1]
LIDAR = ROOT / "data" / "raw" / "LiDAR2025" / "LiDAR2025_2m_DTM.tif"
HYBRID = ROOT / "data" / "derived" / "company_gardens_hybrid_dem_2m.tif"


def test_hybrid_dem_preserves_every_valid_lidar_cell_and_records_provenance():
    with rasterio.open(LIDAR) as lidar_source, rasterio.open(HYBRID) as hybrid_source:
        lidar = lidar_source.read(1, masked=True)
        hybrid = hybrid_source.read(1, masked=True)
        provenance = hybrid_source.read(2)
        valid_lidar = ~np.asarray(lidar.mask)
        assert hybrid_source.count == 2
        assert np.array_equal(hybrid.data[valid_lidar], lidar.data[valid_lidar])
        assert np.all(provenance[valid_lidar] == 1)
        # The rounded envelope includes Company's Garden and its bordering
        # streets while remaining a small, local supplement to the LiDAR.
        assert 35_000 < int((provenance == 2).sum()) < 45_000
        valid_hybrid = ~np.asarray(hybrid.mask)
        footprint = unary_union([
            shape(geometry)
            for geometry, value in shapes(
                valid_hybrid.astype("uint8"),
                mask=valid_hybrid,
                transform=hybrid_source.transform,
            )
            if value == 1
        ])
        assert footprint.geom_type == "Polygon"
        assert len(footprint.interiors) == 0


def test_company_gardens_flood_box_uses_coarse_terrain_and_retains_water():
    result = flood_preview({
        "bounds_local": [-600, 420, -500, 520],
        "resolution_m": 6,
        "rainfall_mm_h": 30,
        "duration_min": 5,
        "infiltration_mm_h": 0,
        "manning_n": 0.04,
    })
    assert result["summary"]["coarse_terrain_pct"] == 100
    assert result["summary"]["retained_water_m3"] > 0
    assert result["summary"]["mass_balance_error_pct"] < 0.01
