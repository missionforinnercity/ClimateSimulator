from __future__ import annotations

import numpy as np

from server import thermal_kpis


def test_monthly_area_time_shares_keep_physical_bands_and_composite_hours(tmp_path, monkeypatch):
    frame_rows = []
    for hour in range(24):
        frame_id = f"jan-{hour:02d}"
        frame_rows.append({"id": frame_id, "month": 1, "local_hour": hour})
        # One cell is cold (−1 °C UTCI), the other is heat stress (30 °C).
        np.asarray([-10, 300], dtype="<i2").tofile(tmp_path / f"{frame_id}.bin")
    payload = {
        "generated_at": "fixture-v1", "validation_status": "experimental_unvalidated_modelled_estimate",
        "baseline": {"start_year": 2016, "end_year": 2025},
        "grid": {"width": 2, "height": 1, "resolution_m": 2},
        "channels": [{"name": "utci_c", "scale": 0.1, "offset": 0}],
        "nodata": -32768, "frames": frame_rows,
    }
    monkeypatch.setattr(thermal_kpis, "manifest", lambda: payload)
    monkeypatch.setattr(thermal_kpis, "frame_path", lambda frame_id: tmp_path / f"{frame_id}.bin")
    thermal_kpis._all_frame_stats.cache_clear()

    result = thermal_kpis.category_area_time(aggregate="month", month=1)

    assert result["status"] == "composite_area_time_estimate"
    assert result["composite_frames_used"] == result["expected_composite_frames"] == 24
    assert sum(item["area_time_share_pct"] for item in result["bands"]) == 100
    bands = {item["id"]: item for item in result["bands"]}
    assert bands["cold_stress"]["area_time_share_pct"] == 50
    assert bands["no_thermal_stress"]["area_time_share_pct"] == 0
    assert bands["heat_stress"]["area_time_share_pct"] == 50
    assert bands["cold_stress"]["equivalent_hours_per_mapped_cell"] == 372
    assert "not observed hourly category frequencies" in result["method"]

