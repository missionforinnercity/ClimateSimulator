"""Offline middleware contract tests; deliberately do not start provider polling."""
import asyncio
import importlib
import json
from collections import OrderedDict, deque

import httpx
import pytest

api = importlib.import_module("server.app")


@pytest.fixture(autouse=True)
def isolated_limits(monkeypatch):
    monkeypatch.delenv("CLIMATE_EXPLORER_API_KEY", raising=False)
    monkeypatch.setattr(api, "RATE_HISTORY", OrderedDict())
    monkeypatch.setattr(api, "RATE_LOCK", asyncio.Lock())
    monkeypatch.setattr(api, "HEAVY_SEMAPHORES", {})


def request(path, method="GET", **kwargs):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            return await client.request(method, path, **kwargs)
    return asyncio.run(run())


def test_auth_errors_have_request_id_and_security_headers(monkeypatch):
    monkeypatch.setenv("CLIMATE_EXPLORER_API_KEY", "private-test-value")
    result = request("/api/heat/metrics", headers={"X-Request-ID": "test-request-1", "Origin": api.ALLOWED_ORIGINS[0]})
    assert result.status_code == 401
    assert result.headers["x-request-id"] == "test-request-1"
    assert result.headers["x-content-type-options"] == "nosniff"
    assert result.headers["access-control-allow-origin"] == api.ALLOWED_ORIGINS[0]
    assert "private-test-value" not in result.text
    assert request("/api/heat/metrics", headers={"X-API-Key": "private-test-value"}).status_code == 200


def test_untrusted_request_id_is_replaced():
    result = request("/api/heat/metrics", headers={"X-Request-ID": "x" * 101})
    assert len(result.headers["x-request-id"]) == 16


def test_preflight_does_not_need_api_key(monkeypatch):
    monkeypatch.setenv("CLIMATE_EXPLORER_API_KEY", "private-test-value")
    result = request("/api/heat/metrics", "OPTIONS", headers={
        "Origin": api.ALLOWED_ORIGINS[0], "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-API-Key",
    })
    assert result.status_code == 200


def test_rate_limit_includes_retry_and_reference(monkeypatch):
    monkeypatch.setattr(api, "HEAVY_SEMAPHORES", {"/api/heat/metrics": asyncio.Semaphore(1)})
    monkeypatch.setattr(api, "RATE_LIMIT_REQUESTS", 1)
    assert request("/api/heat/metrics").status_code == 200
    result = request("/api/heat/metrics")
    assert result.status_code == 429
    assert int(result.headers["retry-after"]) >= 1
    assert result.headers["x-request-id"]


def test_busy_semaphore_is_not_released_without_acquisition(monkeypatch):
    semaphore = asyncio.Semaphore(0)
    monkeypatch.setattr(api, "HEAVY_SEMAPHORES", {"/api/heat/metrics": semaphore})
    result = request("/api/heat/metrics")
    assert result.status_code == 503
    assert semaphore.locked()
    assert result.headers["retry-after"] == "2"


def test_rate_tracker_does_not_evict_active_budgets(monkeypatch):
    monkeypatch.setattr(api, "HEAVY_SEMAPHORES", {"/api/heat/metrics": asyncio.Semaphore(1)})
    monkeypatch.setattr(api, "RATE_LIMIT_MAX_CLIENTS", 1)
    api.RATE_HISTORY["other-client"] = deque([api.time.monotonic()])
    assert request("/api/heat/metrics").status_code == 503
    assert list(api.RATE_HISTORY) == ["other-client"]
    api.RATE_HISTORY["other-client"] = deque([api.time.monotonic() - api.RATE_LIMIT_WINDOW_S - 1])
    assert request("/api/heat/metrics").status_code == 200
    assert "other-client" not in api.RATE_HISTORY


def test_invalid_simulation_parameters_do_not_reach_solver():
    result = request("/api/traffic/closure-preview", "POST", json={"duration_min": -1})
    assert result.status_code == 422
    assert result.headers["x-request-id"]


def test_missing_asset_not_cached_immutably():
    result = request("/assets/not-a-real-asset.bin?v=123")
    assert result.status_code == 404
    assert "immutable" not in result.headers.get("cache-control", "")


def test_health_separates_required_assets_and_optional_services(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "ASSET_ROOT", tmp_path)
    monkeypatch.setattr(api, "database_url", lambda: None)
    monkeypatch.setattr(api.shutil, "which", lambda _: None)
    (tmp_path / "manifest.json").write_text(json.dumps({"version": 3, "assets": {"fallback": "missing.json"}}))
    health = api.health()
    assert health["status"] == "degraded"
    assert health["checks"]["assets"]["required"]
    assert not health["checks"]["sumo"]["required"]
    assert health["optional_degraded"] == ["sumo"]
