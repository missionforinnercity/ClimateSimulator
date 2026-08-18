from __future__ import annotations

import pytest
from pydantic import ValidationError

from server.app import FloodPayload, health


def test_flood_payload_rejects_excessive_combined_work():
    with pytest.raises(ValidationError, match="service budget"):
        FloodPayload(size_m=1200, resolution_m=2, duration_min=360)


def test_flood_payload_accepts_default_interactive_workload():
    payload = FloodPayload()
    assert payload.size_m == 500


def test_health_reports_dependency_checks_and_limits():
    result = health()
    assert result["status"] in {"ok", "degraded"}
    assert result["checks"]["assets"]["manifest_version"] == 3
    assert {"assets", "sumo", "database"} <= result["checks"].keys()
    assert result["limits"]["heavy_concurrency"]["/api/flood/preview"] == 1
