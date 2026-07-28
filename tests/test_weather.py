from __future__ import annotations

import server.weather as weather


def sample_payload():
    return {
        "latitude": -33.925,
        "longitude": 18.424,
        "timezone": "Africa/Johannesburg",
        "current": {
            "time": "2026-07-28T14:15",
            "temperature_2m": 17.2,
            "apparent_temperature": 16.1,
            "relative_humidity_2m": 68,
            "precipitation": 0,
            "weather_code": 2,
            "cloud_cover": 41,
            "shortwave_radiation": 412,
            "wind_speed_10m": 7.4,
            "wind_direction_10m": 155,
            "wind_gusts_10m": 12.3,
            "is_day": 1,
        },
    }


def test_current_weather_normalizes_and_caches(monkeypatch):
    weather.clear_weather_cache()
    calls = []
    monkeypatch.setattr(weather, "_scene_location", lambda: (18.424, -33.925))
    monkeypatch.setattr(weather, "_fetch_json", lambda url: calls.append(url) or sample_payload())
    first = weather.current_weather()
    second = weather.current_weather()
    assert first["data_kind"] == "modelled_current_conditions"
    assert first["wind_speed_10m_mps"] == 7.4
    assert first["location"]["timezone"] == "Africa/Johannesburg"
    assert second == first
    assert len(calls) == 1


def test_current_weather_uses_stale_value_after_refresh_failure(monkeypatch):
    weather.clear_weather_cache()
    monkeypatch.setattr(weather, "_scene_location", lambda: (18.424, -33.925))
    monkeypatch.setattr(weather, "_fetch_json", lambda url: sample_payload())
    weather.current_weather()
    monkeypatch.setattr(weather, "_fetch_json", lambda url: (_ for _ in ()).throw(TimeoutError("offline")))
    stale = weather.current_weather(force=True)
    assert stale["stale"] is True
    assert "last successful" in stale["warning"]


def test_missing_required_current_variable_is_rejected():
    payload = sample_payload()
    del payload["current"]["wind_speed_10m"]
    try:
        weather._normalize(payload, "2026-07-28T12:00:00Z")
    except RuntimeError as error:
        assert "wind_speed_10m" in str(error)
    else:
        raise AssertionError("missing weather variable should fail normalization")
