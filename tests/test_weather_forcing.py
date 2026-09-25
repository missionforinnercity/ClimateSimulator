from __future__ import annotations

from datetime import datetime, timezone

import pytest
import server.weather_forcing as forcing


def test_meteostat_normalization_converts_wind_and_pressure():
    rows = forcing.normalize_meteostat({"data": [{
        "time": "2026-09-20 12:00:00", "temp": 20, "dwpt": 12, "rhum": 60,
        "prcp": 0.5, "wspd": 18, "wdir": 180, "pres": 1013.25,
    }]}, elevation_m=25)
    assert rows[0]["wind_speed_10m_mps"] == 5
    assert 1009 < rows[0]["surface_pressure_hpa"] < 1013.25
    assert rows[0]["global_radiation_wm2"] is None
    assert rows[0]["data_kind"] == "station_informed_point_observation"


def test_observations_overlay_variables_but_not_radiation():
    model = [{
        "valid_at": "2026-09-20T10:00:00Z", "temperature_2m_c": 22,
        "global_radiation_wm2": 500, "provenance": {"temperature_2m_c": "open_meteo_forecast", "global_radiation_wm2": "open_meteo_forecast"},
    }]
    observed = [{
        "valid_at": "2026-09-20T10:00:00Z", "temperature_2m_c": 20,
        "global_radiation_wm2": None, "provenance": {"temperature_2m_c": "meteostat_point_observation"},
    }]
    result = forcing.merge_forcing(model, observed, datetime(2026, 9, 20, 11, tzinfo=timezone.utc))[0]
    assert result["temperature_2m_c"] == 20
    assert result["global_radiation_wm2"] == 500
    assert result["provenance"]["temperature_2m_c"] == "meteostat_point_observation"
    assert result["provenance"]["global_radiation_wm2"] == "open_meteo_forecast"


def test_legacy_meteoblue_name_is_accepted_without_exposing_value(monkeypatch):
    monkeypatch.delenv("METEOSTAT_RAPIDAPI_KEY", raising=False)
    monkeypatch.setenv("METEOBLUEAPI", "private-key")
    assert forcing.meteostat_api_key() == ("private-key", "METEOBLUEAPI")


def test_satellite_provenance_is_per_hour_and_preserves_fallback_warning(monkeypatch):
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    current = now.isoformat().replace('+00:00', 'Z')
    row = dict(valid_at=current, source='Open-Meteo', data_kind='modelled_forecast',
               global_radiation_wm2=595, provenance={'shortwave_radiation': 'open_meteo_forecast'},
               weather_warnings=['single-provider fallback in use'])
    monkeypatch.setattr(forcing, 'fetch_open_meteo', lambda *a, **kw: [dict(row)])
    monkeypatch.setattr(forcing, 'fetch_meteostat', lambda *a: [])
    monkeypatch.setattr(forcing, 'fetch_metar', lambda *a: [])
    monkeypatch.setattr(forcing, 'fetch_satellite_radiation', lambda *a: [])
    output = forcing.forcing_window()['rows'][0]
    assert output['provenance']['global_radiation_wm2'] == 'open_meteo_forecast'
    assert 'single-provider fallback in use' in output['weather_warnings']
    assert any('current-hour satellite radiation unavailable' in w for w in output['weather_warnings'])
    satellite = dict(valid_at=current, source='satellite', global_radiation_wm2=120,
                     provenance={'global_radiation_wm2': 'open_meteo_eumetsat_satellite'})
    monkeypatch.setattr(forcing, 'fetch_satellite_radiation', lambda *a: [satellite])
    output = forcing.forcing_window()['rows'][0]
    assert output['global_radiation_wm2'] == 120
    assert output['provenance']['global_radiation_wm2'] == 'open_meteo_eumetsat_satellite'
    assert not any('current-hour satellite radiation unavailable' in w for w in output['weather_warnings'])


def test_native_satellite_radiation_preserves_timestamps_and_closes_budget():
    payload = {
        'utc_offset_seconds': 7200,
        'hourly': {'time': ['2026-09-23T14:40', '2026-09-23T14:50'],
                   'shortwave_radiation': [240, 210], 'direct_radiation': [20, 0],
                   'diffuse_radiation': [220, 210]},
    }
    rows = forcing.normalize_satellite_radiation(payload, native=True)
    assert [row['valid_at'] for row in rows] == ['2026-09-23T12:40:00Z', '2026-09-23T12:50:00Z']
    assert rows[-1]['radiation']['averaging_minutes'] == 10
    assert rows[-1]['global_radiation_wm2'] == rows[-1]['direct_radiation_wm2'] + rows[-1]['diffuse_radiation_wm2']


def test_irregular_or_nonclosing_native_satellite_data_is_rejected():
    payload = {'utc_offset_seconds': 7200, 'hourly': {
        'time': ['2026-09-23T14:40', '2026-09-23T14:52'],
        'shortwave_radiation': [240, 210], 'direct_radiation': [20, 0], 'diffuse_radiation': [220, 100],
    }}
    with pytest.raises(ValueError, match='irregular'):
        forcing.normalize_satellite_radiation(payload, native=True)
    payload['hourly']['time'] = ['2026-09-23T14:40', '2026-09-23T14:50']
    rows = forcing.normalize_satellite_radiation(payload, native=True)
    assert len(rows) == 1  # A broken later scan is discarded; earlier valid scans survive.
    assert rows[0]['valid_at'] == '2026-09-23T12:40:00Z'
