from __future__ import annotations

import numpy as np

from scripts.build_runoff_screening import d8_accumulation
from server.runoff import runoff_screening_manifest


def test_priority_flood_fills_closed_bowl_and_d8_conserves_source_area():
    dem = np.array([
        [9, 9, 9, 9, 9],
        [9, 4, 4, 4, 9],
        [9, 4, 0, 4, 9],
        [9, 4, 4, 4, 9],
        [9, 9, 9, 9, 9],
    ], dtype=np.float32)
    valid = np.ones(dem.shape, dtype=bool)
    source = np.zeros(dem.shape, dtype=np.float32)
    source[2, 2] = 4.0

    filled, receiver, accumulation = d8_accumulation(dem, valid, source)

    assert filled[2, 2] == 9
    assert np.all(filled >= dem)
    assert accumulation[2, 2] == 4.0
    assert np.isclose(accumulation[receiver < 0].sum(), source.sum())


def test_priority_flood_keeps_nodata_outside_and_routes_around_invalid_cells():
    dem = np.array([
        [5, 5, 5, 5, 5],
        [5, 4, 3, 4, 5],
        [5, 3, 1, 3, 5],
        [5, 4, 3, 4, 5],
        [5, 5, 5, 5, 5],
    ], dtype=np.float32)
    valid = np.ones(dem.shape, dtype=bool)
    valid[2, 1] = False
    source = np.zeros(dem.shape, dtype=np.float32)
    source[2, 2] = 10.0

    filled, receiver, accumulation = d8_accumulation(dem, valid, source)

    assert np.isnan(filled[2, 1])
    assert receiver[2, 1] == -1
    assert np.isclose(accumulation[receiver < 0].sum(), source.sum())


def test_runoff_manifest_matches_built_sparse_asset():
    payload = runoff_screening_manifest()

    assert payload["available"] is True
    assert payload["grid"]["resolution_m"] == 2.0
    assert payload["mapped_paved_area_m2"] > 0
    assert payload["asset_bytes"] == 36 + payload["record_count"] * 8
