from __future__ import annotations

from server.app import app, health


def test_health_reports_dependency_checks_and_limits():
    result = health()
    assert result["status"] in {"ok", "degraded"}
    assert result["checks"]["assets"]["manifest_version"] == 3
    assert {"assets", "sumo", "database", "thermal"} <= result["checks"].keys()
    assert result["checks"]["walking_routes"]["status"] == "ok"
    assert result["limits"]["heavy_concurrency"]


def test_walking_route_post_endpoint_is_registered():
    route = next(item for item in app.routes if item.path == "/api/walking/routes")
    assert route.methods == {"POST"}
