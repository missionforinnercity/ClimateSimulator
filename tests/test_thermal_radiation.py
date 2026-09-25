from datetime import datetime

import numpy as np
import pytest

from server.thermal_worker import calculate_utci, solweig_weather


def test_hourly_horizontal_beam_is_converted_to_normal_and_budget_closes():
    solweig = pytest.importorskip('solweig')
    location = solweig.Location(latitude=-33.925, longitude=18.424, utc_offset=2)
    item = dict(valid_at='2026-09-23T12:00:00Z', temperature_2m_c=16,
                relative_humidity_2m_pct=80, global_radiation_wm2=120,
                direct_radiation_wm2=20, diffuse_radiation_wm2=100,
                wind_speed_10m_mps=3, surface_pressure_hpa=1017)
    weather = solweig_weather(item, location)
    assert weather.datetime == datetime(2026, 9, 23, 14)
    assert weather.timestep_minutes == 60
    assert weather.direct_rad > 20
    assert weather.direct_rad * np.sin(np.deg2rad(weather.sun_altitude)) + weather.diffuse_rad == pytest.approx(120)
    item.update(valid_at='2026-09-23T23:00:00Z', global_radiation_wm2=0,
                direct_radiation_wm2=0, diffuse_radiation_wm2=0)
    night = solweig_weather(item, location)
    assert night.direct_rad == 0
    assert night.diffuse_rad == 0


def test_cool_conditions_do_not_become_heat_stress_in_utci_polynomial():
    pytest.importorskip('pythermalcomfort')
    result = calculate_utci(16, np.array([16., 20.]), np.array([3., 3.]), 80)
    assert np.all(np.isfinite(result))
    assert np.all((result > 5) & (result < 20))


def test_satellite_refresh_recurs_each_hour_without_startup_drift():
    from server.thermal_worker import next_refresh_at
    hour = 3600 * 100
    assert next_refresh_at(hour + 60, 3600, 600) == hour + 660
    assert next_refresh_at(hour + 660, 3600, 600) == hour + 1260
    assert next_refresh_at(hour + 3660, 3600, 600) == hour + 4260
    assert next_refresh_at(hour + 600, 3600, 600) == hour + 1200


def test_latest_native_radiation_replaces_only_current_hour_and_keeps_weather_time():
    from server.thermal_worker import thermal_forecast_rows
    hourly = [
        {'valid_at': '2026-09-23T12:00:00Z', 'temperature_2m_c': 21,
         'global_radiation_wm2': 300, 'provenance': {'temperature_2m_c': 'forecast'},
         'weather_warnings': ['current-hour satellite radiation unavailable'], 'sources': ['forecast']},
        {'valid_at': '2026-09-23T13:00:00Z', 'temperature_2m_c': 20},
    ]
    native = {'valid_at': '2026-09-23T12:50:00Z', 'global_radiation_wm2': 37,
              'direct_radiation_wm2': 0, 'diffuse_radiation_wm2': 37,
              'radiation': {'interval_end': '2026-09-23T12:50:00Z', 'averaging_minutes': 10},
              'provenance': {'global_radiation_wm2': 'satellite'}}
    rows = thermal_forecast_rows({'latest_native_radiation': native}, hourly)
    assert rows[0]['valid_at'] == '2026-09-23T12:50:00Z'
    assert rows[0]['weather_valid_at'] == '2026-09-23T12:00:00Z'
    assert rows[0]['temperature_2m_c'] == 21
    assert rows[0]['global_radiation_wm2'] == 37
    assert rows[0]['weather_warnings'] == []
    assert rows[1] is hourly[1]
