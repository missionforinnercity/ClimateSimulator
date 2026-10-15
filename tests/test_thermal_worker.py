from __future__ import annotations

import os
from types import SimpleNamespace

from server.thermal_worker import _prune_stale_staging, _run_forecast_subprocess


def test_prune_stale_staging_removes_only_old_temporary_directories(tmp_path, monkeypatch):
    import server.thermal_worker as worker

    monkeypatch.setattr(worker, "PRODUCT_ROOT", tmp_path)
    stale = tmp_path / ".thermal_20260923T185547Z-abandoned"
    recent = tmp_path / ".thermal_20261014T111410Z-active"
    unrelated = tmp_path / "thermal_20260923T185547Z"
    for path in (stale, recent, unrelated):
        path.mkdir()
        (path / "artifact.bin").write_bytes(b"scratch")
    now = 2_000_000_000.0
    old_time = now - 2 * 86400
    os.utime(stale, (old_time, old_time))
    os.utime(recent, (now - 60, now - 60))

    assert _prune_stale_staging(now=now, max_age_seconds=86400) == 1
    assert not stale.exists()
    assert recent.is_dir()
    assert unrelated.is_dir()


def test_scheduled_forecast_runs_in_one_shot_child(monkeypatch):
    import server.thermal_worker as worker

    calls = []
    monkeypatch.setattr(worker.subprocess, "run", lambda command, check: (
        calls.append((command, check)) or SimpleNamespace(returncode=0)
    ))

    assert _run_forecast_subprocess() == 0
    assert calls == [([worker.sys.executable, "-m", "server.thermal_worker", "--once"], False)]
