from __future__ import annotations

from server.app import health


def test_health_reports_dependency_checks_and_limits():
    result = health()
    assert result["status"] in {"ok", "degraded"}
    assert result["checks"]["assets"]["manifest_version"] == 3
    assert {"assets", "sumo", "database"} <= result["checks"].keys()
    assert result["limits"]["heavy_concurrency"]
