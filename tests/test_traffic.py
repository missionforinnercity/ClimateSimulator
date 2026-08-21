from __future__ import annotations

import json
import xml.etree.ElementTree as ElementTree

import server.traffic as traffic


def sample_road_features():
    return [
        {
            "type": "Feature",
            "properties": {"highway": "secondary", "name": "Long Street", "oneway": "yes"},
            "geometry": {"type": "LineString", "coordinates": [[18.4180, -33.9250], [18.4183, -33.9210]]},
        },
        {
            "type": "Feature",
            "properties": {"highway": "secondary", "name": "Long Street", "oneway": "yes"},
            "geometry": {"type": "LineString", "coordinates": [[18.4183, -33.9210], [18.4186, -33.9180]]},
        },
        {
            "type": "Feature",
            "properties": {"highway": "footway", "name": "Company's Garden Path", "oneway": None},
            "geometry": {"type": "LineString", "coordinates": [[18.4165, -33.9280], [18.4168, -33.9276]]},
        },
        {
            "type": "Feature",
            "properties": {"highway": "residential", "name": None, "oneway": None},
            "geometry": {"type": "LineString", "coordinates": [[18.4200, -33.9260], [18.4204, -33.9256]]},
        },
    ]


def test_named_roads_filters_unnamed_and_non_vehicle_highways(monkeypatch):
    traffic.named_roads.cache_clear()
    monkeypatch.setattr(traffic, "_road_features", lambda: tuple(sample_road_features()))
    roads = {road["name"]: road for road in traffic.named_roads()}
    assert set(roads) == {"Long Street"}
    assert roads["Long Street"]["segment_count"] == 2
    assert roads["Long Street"]["highway"] == "secondary"
    assert "local" in roads["Long Street"] and "sample_point" in roads["Long Street"]
    assert roads["Long Street"]["direction_segments"]
    assert all(segment["direction"] == "oneway" for segment in roads["Long Street"]["direction_segments"])
    traffic.named_roads.cache_clear()


def test_generated_sumo_network_uses_left_hand_traffic():
    network_text = traffic.SUMO_NET_PATH.read_text(encoding="utf-8")
    assert 'lefthand="true"' in network_text


def test_adderley_full_block_closes_both_separate_carriageways():
    closure = traffic.resolve_closure_lanes("Adderley Street", "full", "block")
    assert closure["edges_total"] >= 2
    assert len(closure["edge_ids"]) == closure["edges_total"]


def test_permanent_road_statuses_exposes_pedestrian_geometry(monkeypatch):
    traffic.permanent_road_statuses.cache_clear()
    monkeypatch.setattr(traffic, "_road_features", lambda: tuple(sample_road_features()))
    statuses = traffic.permanent_road_statuses()
    assert len(statuses) == 0  # the sample uses a footway, not a pedestrianised street

    features = sample_road_features() + [{
        "type": "Feature",
        "properties": {"highway": "pedestrian", "name": "Government Avenue"},
        "geometry": {"type": "LineString", "coordinates": [[18.416, -33.927], [18.417, -33.927]]},
    }]
    monkeypatch.setattr(traffic, "_road_features", lambda: tuple(features))
    traffic.permanent_road_statuses.cache_clear()
    status = traffic.permanent_road_statuses()[0]
    assert status["name"] == "Government Avenue"
    assert status["status"] == "pedestrianised"
    assert status["vehicle_access"] is False
    assert len(status["points"]) == 2
    traffic.permanent_road_statuses.cache_clear()


def sample_flow_segment(current_speed=20.0, free_flow_speed=40.0):
    return {
        "currentSpeed": current_speed,
        "freeFlowSpeed": free_flow_speed,
        "confidence": 1,
        "roadClosure": False,
    }


def sample_roads_for_live():
    return (
        {"name": "Long Street", "highway": "tertiary", "sample_point": {"lat": -33.923, "lon": 18.418}},
        {"name": "Adderley Street", "highway": "secondary", "sample_point": {"lat": -33.922, "lon": 18.422}},
    )


def test_current_traffic_normalizes_and_caches(monkeypatch):
    traffic.clear_traffic_cache()
    calls = []
    monkeypatch.setenv("TOMTOM_API", "test-key")
    monkeypatch.setattr(traffic, "_sample_road_points", sample_roads_for_live)
    monkeypatch.setattr(
        traffic,
        "_fetch_flow_segment",
        lambda lat, lon, key: calls.append((lat, lon)) or sample_flow_segment(),
    )
    first = traffic.current_traffic()
    second = traffic.current_traffic()
    assert first["provider"] == traffic.TOMTOM_PROVIDER
    assert first["sampled_count"] == 2
    assert first["average_speed_ratio"] == 0.5
    assert first["congestion_level"] == "heavy"
    assert second == first
    assert len(calls) == 2  # two sampled roads, only fetched once thanks to caching


def test_current_traffic_uses_stale_value_after_refresh_failure(monkeypatch):
    traffic.clear_traffic_cache()
    monkeypatch.setenv("TOMTOM_API", "test-key")
    monkeypatch.setattr(traffic, "_sample_road_points", sample_roads_for_live)
    monkeypatch.setattr(traffic, "_fetch_flow_segment", lambda lat, lon, key: sample_flow_segment())
    traffic.current_traffic()
    monkeypatch.setattr(
        traffic,
        "_fetch_flow_segment",
        lambda lat, lon, key: (_ for _ in ()).throw(TimeoutError("offline")),
    )
    stale = traffic.current_traffic(force=True)
    assert stale["stale"] is True
    assert "last successful" in stale["warning"]


def test_current_traffic_requires_api_key(monkeypatch):
    traffic.clear_traffic_cache()
    monkeypatch.delenv("TOMTOM_API", raising=False)
    monkeypatch.setattr(traffic, "_sample_road_points", sample_roads_for_live)
    try:
        traffic.current_traffic()
    except RuntimeError as error:
        assert "TOMTOM_API" in str(error)
    else:
        raise AssertionError("missing TOMTOM_API should fail")


class _FakeEdge:
    def __init__(self, edge_id: str, name: str | None):
        self._id = edge_id
        self._name = name

    def getID(self) -> str:
        return self._id

    def getName(self) -> str | None:
        return self._name


class _FakeNet:
    def __init__(self, edges: list[_FakeEdge]):
        self._edges = edges

    def getEdges(self) -> list[_FakeEdge]:
        return self._edges


def fake_net():
    return _FakeNet(
        [
            _FakeEdge("123", "Long Street"),
            _FakeEdge("-123", "Long Street"),
            _FakeEdge("456", "Adderley Street"),
        ]
    )


def test_resolve_road_edges_matches_by_name(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_net)
    assert sorted(traffic.resolve_road_edges("Long Street")) == ["-123", "123"]


def test_resolve_road_edges_unknown_name_raises(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_net)
    try:
        traffic.resolve_road_edges("Nonexistent Street")
    except ValueError as error:
        assert "Nonexistent Street" in str(error)
    else:
        raise AssertionError("unknown road name should fail")


def test_demand_scale_increases_as_congestion_worsens():
    free_flow = traffic._demand_scale(1.0)
    severe = traffic._demand_scale(0.15)
    assert severe > free_flow
    assert 0.4 <= free_flow <= 2.0
    assert 0.4 <= severe <= 2.0


def write_observation_rows(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def observation_row(date, weekday, hour, ratio, road="Adderley Street"):
    return {"ts": f"{date}T{hour:02d}:00:00Z", "date": date, "weekday": weekday, "hour": hour, "road": road, "ratio": ratio}


def test_record_traffic_observation_writes_one_row_per_sampled_road(monkeypatch, tmp_path):
    log_path = tmp_path / "observations" / "traffic_speed_log.jsonl"
    monkeypatch.setattr(traffic, "TRAFFIC_OBSERVATIONS_PATH", log_path)
    monkeypatch.setenv("TOMTOM_API", "test-key")
    monkeypatch.setattr(traffic, "_sample_road_points", sample_roads_for_live)
    monkeypatch.setattr(traffic, "_fetch_flow_segment", lambda lat, lon, key: sample_flow_segment(10.0, 40.0))
    written = traffic.record_traffic_observation()
    assert written == 2
    rows = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    assert {row["road"] for row in rows} == {"Long Street", "Adderley Street"}
    assert all(row["ratio"] == 0.25 for row in rows)
    assert all("date" in row and "weekday" in row and "hour" in row for row in rows)


def test_record_traffic_observation_skips_without_api_key(monkeypatch, tmp_path):
    log_path = tmp_path / "observations" / "traffic_speed_log.jsonl"
    monkeypatch.setattr(traffic, "TRAFFIC_OBSERVATIONS_PATH", log_path)
    monkeypatch.delenv("TOMTOM_API", raising=False)
    assert traffic.record_traffic_observation() == 0
    assert not log_path.exists()


def test_historical_scenario_ratio_requires_enough_samples_and_distinct_days(monkeypatch, tmp_path):
    log_path = tmp_path / "traffic_speed_log.jsonl"
    monkeypatch.setattr(traffic, "TRAFFIC_OBSERVATIONS_PATH", log_path)
    monkeypatch.setattr(traffic, "MIN_HISTORICAL_SAMPLES", 4)
    monkeypatch.setattr(traffic, "MIN_HISTORICAL_DISTINCT_DAYS", 2)
    # Only one distinct day, even with enough raw rows -- should not count.
    write_observation_rows(log_path, [observation_row("2026-08-03", 0, 8, 0.5) for _ in range(4)])
    assert traffic._historical_scenario_ratio("am_peak") is None

    write_observation_rows(log_path, [
        observation_row("2026-08-03", 0, 8, 0.4), observation_row("2026-08-03", 0, 8, 0.4),
        observation_row("2026-08-04", 1, 8, 0.6), observation_row("2026-08-04", 1, 8, 0.6),
    ])
    result = traffic._historical_scenario_ratio("am_peak")
    assert result is not None
    assert result["sample_count"] == 4
    assert result["distinct_days"] == 2
    assert result["average_ratio"] == 0.5


def test_historical_scenario_ratio_excludes_weekends_for_peak_scenarios(monkeypatch, tmp_path):
    log_path = tmp_path / "traffic_speed_log.jsonl"
    monkeypatch.setattr(traffic, "TRAFFIC_OBSERVATIONS_PATH", log_path)
    monkeypatch.setattr(traffic, "MIN_HISTORICAL_SAMPLES", 2)
    monkeypatch.setattr(traffic, "MIN_HISTORICAL_DISTINCT_DAYS", 2)
    write_observation_rows(log_path, [
        observation_row("2026-08-08", 5, 8, 0.9),  # Saturday, must be excluded from am_peak
        observation_row("2026-08-09", 6, 8, 0.9),  # Sunday, must be excluded from am_peak
    ])
    assert traffic._historical_scenario_ratio("am_peak") is None


def test_historical_scenario_ratio_filters_by_hour_window(monkeypatch, tmp_path):
    log_path = tmp_path / "traffic_speed_log.jsonl"
    monkeypatch.setattr(traffic, "TRAFFIC_OBSERVATIONS_PATH", log_path)
    monkeypatch.setattr(traffic, "MIN_HISTORICAL_SAMPLES", 2)
    monkeypatch.setattr(traffic, "MIN_HISTORICAL_DISTINCT_DAYS", 2)
    write_observation_rows(log_path, [
        observation_row("2026-08-03", 0, 13, 0.9),  # midday hour, not am_peak
        observation_row("2026-08-04", 1, 13, 0.9),
    ])
    assert traffic._historical_scenario_ratio("am_peak") is None
    assert traffic._historical_scenario_ratio("midday") is not None


def test_resolve_scenario_nudges_demand_scale_toward_observed_history(monkeypatch):
    monkeypatch.setattr(
        traffic, "_historical_scenario_ratio",
        lambda scenario_key: {"average_ratio": 0.2, "sample_count": 40, "distinct_days": 5} if scenario_key == "am_peak" else None,
    )
    resolved = traffic.resolve_scenario("am_peak")
    base = traffic.SCENARIOS["am_peak"]["demand_scale"]
    # Heavier observed congestion (low ratio) should push demand up, but only
    # within the bounded +/-30% nudge band, never past it.
    assert resolved["demand_scale"] > base
    assert resolved["demand_scale"] <= base * 1.3 + 1e-9
    assert resolved["historical_calibration"]["applied"] is True
    assert resolved["historical_calibration"]["sample_count"] == 40


def test_resolve_scenario_unaffected_without_enough_history(monkeypatch):
    monkeypatch.setattr(traffic, "_historical_scenario_ratio", lambda scenario_key: None)
    resolved = traffic.resolve_scenario("am_peak")
    assert resolved["demand_scale"] == traffic.SCENARIOS["am_peak"]["demand_scale"]
    assert resolved["historical_calibration"] is None


def test_road_names_normalise_across_osm_and_municipal_conventions():
    assert traffic._normalise_road_name("Bree Street") == "BREE"
    assert traffic._normalise_road_name("BREE") == "BREE"
    assert traffic._normalise_road_name("F.W. De Klerk Boulevard") == "F W DE KLERK"


def test_speed_limit_overrides_include_inferred_values_with_separate_counts():
    overrides, counts = traffic._speed_limit_overrides([
        {"id": "confirmed", "municipal": {"speed_limit_kph": 40, "speed_limit_source": "Confirmed"}},
        {"id": "inferred", "municipal": {"speed_limit_kph": 60, "speed_limit_source": "Inferred"}},
        {"id": "unknown", "municipal": {"speed_limit_kph": 50, "speed_limit_source": None}},
    ])
    assert set(overrides) == {"confirmed", "inferred"}
    assert counts == {"confirmed": 1, "inferred": 1}


def test_city_road_centre_records_are_available_for_traffic_enrichment():
    records = traffic._municipal_road_records()
    assert records
    assert any(record["normalised_name"] == "BREE" for record in records)
    assert all(record["line"].length > 0 for record in records)


def test_edge_index_reverse_edge_id_is_symmetric():
    # Lets the UI offer an explicit "which direction stays open" choice for
    # an ordinary two-way street -- if A points to B as its reverse sibling,
    # B must point back to A.
    index = traffic._edge_index()
    paired = [(edge_id, record["reverse_edge_id"]) for edge_id, record in index.items() if record.get("reverse_edge_id")]
    assert paired
    sample_id, reverse_id = paired[0]
    assert index[reverse_id]["reverse_edge_id"] == sample_id


def test_diff_metrics_pairs_on_trips_completed_in_both_runs():
    """A severe closure must not look faster just because its worst trips
    never finished. Vehicle c is stuck in the closure run and drops out of
    its tripinfo; pairing on a+b must still show the closure as slower."""
    baseline = {
        "mean_duration_s": 100.0, "mean_time_loss_s": 20.0, "mean_speed_mps": 10.0, "trip_count": 3,
        "per_vehicle": {
            "a": {"duration_s": 100.0, "time_loss_s": 20.0, "route_length_m": 1000.0, "speed_mps": 10.0},
            "b": {"duration_s": 100.0, "time_loss_s": 20.0, "route_length_m": 1000.0, "speed_mps": 10.0},
            "c": {"duration_s": 100.0, "time_loss_s": 20.0, "route_length_m": 1000.0, "speed_mps": 10.0},
        },
    }
    closure = {
        # Unpaired, this run's mean duration (90) looks *better* than the
        # baseline's (100) purely because the slow trip vanished.
        "mean_duration_s": 90.0, "mean_time_loss_s": 15.0, "mean_speed_mps": 11.0, "trip_count": 2,
        "per_vehicle": {
            "a": {"duration_s": 130.0, "time_loss_s": 40.0, "route_length_m": 1000.0, "speed_mps": 7.7},
            "b": {"duration_s": 130.0, "time_loss_s": 40.0, "route_length_m": 1000.0, "speed_mps": 7.7},
        },
    }
    impact = traffic._diff_metrics(baseline, closure, planned_count=3)
    assert impact["comparison"] == "paired_on_trips_completed_in_both_runs"
    assert impact["compared_trip_count"] == 2
    assert impact["mean_duration_change_pct"] == 30.0  # slower, as it should be
    assert impact["mean_time_loss_change_s"] == 20.0
    assert impact["mean_speed_change_pct"] < 0
    assert impact["comparison_metrics"]["baseline"]["mean_duration_s"] == 100.0
    assert impact["comparison_metrics"]["closure"]["mean_duration_s"] == 130.0
    assert impact["assessment_ready"] is True
    # The trips the closure prevented from finishing are reported separately.
    assert impact["completed_trip_ratio_baseline"] == 1.0
    assert round(impact["completed_trip_ratio_closure"], 3) == 0.667


def test_diff_metrics_does_not_compare_unpaired_aggregate_populations():
    baseline = {"mean_duration_s": 100.0, "mean_time_loss_s": 20.0, "mean_speed_mps": 10.0, "trip_count": 45}
    closure = {"mean_duration_s": 120.0, "mean_time_loss_s": 30.0, "mean_speed_mps": 8.0, "trip_count": 40}
    impact = traffic._diff_metrics(baseline, closure, planned_count=50)
    assert impact["comparison"] == "unavailable_no_shared_completed_trips"
    assert impact["mean_duration_change_pct"] is None
    assert impact["mean_duration_change_s"] is None
    assert impact["assessment_ready"] is False


def test_diff_metrics_rejects_timed_out_run_for_assessment():
    baseline = {
        "trip_count": 1,
        "per_vehicle": {"a": {"duration_s": 10, "time_loss_s": 2, "route_length_m": 50, "speed_mps": 5}},
        "truncated_by_time_budget": False,
    }
    closure = {
        "trip_count": 1,
        "per_vehicle": {"a": {"duration_s": 12, "time_loss_s": 4, "route_length_m": 50, "speed_mps": 4.2}},
        "truncated_by_time_budget": True,
    }
    impact = traffic._diff_metrics(baseline, closure, planned_count=1)
    assert impact["simulation_complete"] is False
    assert impact["assessment_ready"] is False


def test_diff_metrics_rejects_an_overloaded_open_road_baseline():
    baseline = {
        "trip_count": 8,
        "per_vehicle": {
            f"v{i}": {"duration_s": 10, "time_loss_s": 2, "route_length_m": 50, "speed_mps": 5}
            for i in range(8)
        },
    }
    closure = {
        "trip_count": 8,
        "per_vehicle": {
            f"v{i}": {"duration_s": 12, "time_loss_s": 4, "route_length_m": 50, "speed_mps": 4.2}
            for i in range(8)
        },
    }
    impact = traffic._diff_metrics(baseline, closure, planned_count=10)
    assert impact["baseline_stable"] is False
    assert "open_road_baseline_overloaded" in impact["validity_reasons"]
    assert impact["assessment_ready"] is False


def test_diff_metrics_requires_a_meaningful_paired_share():
    common = {"duration_s": 10, "time_loss_s": 2, "route_length_m": 50, "speed_mps": 5}
    baseline = {"trip_count": 100, "per_vehicle": {f"v{i}": common for i in range(100)}}
    closure = {"trip_count": 15, "per_vehicle": {f"v{i}": common for i in range(15)}}
    impact = traffic._diff_metrics(baseline, closure, planned_count=100)
    assert impact["paired_trip_ratio"] == 0.15
    assert impact["paired_sample_sufficient"] is False
    assert "paired_sample_too_small" in impact["validity_reasons"]
    assert impact["assessment_ready"] is False


def test_diff_metrics_includes_departure_insertion_delay_in_journey_time():
    baseline = {
        "trip_count": 1,
        "per_vehicle": {"a": {
            "duration_s": 100, "depart_delay_s": 20, "journey_time_s": 120,
            "time_loss_s": 10, "route_length_m": 1000, "speed_mps": 10,
        }},
    }
    closure = {
        "trip_count": 1,
        "per_vehicle": {"a": {
            "duration_s": 105, "depart_delay_s": 40, "journey_time_s": 145,
            "time_loss_s": 15, "route_length_m": 1000, "speed_mps": 9.5,
        }},
    }
    impact = traffic._diff_metrics(baseline, closure, planned_count=1)
    assert impact["mean_duration_change_s"] == 5
    assert impact["mean_depart_delay_change_s"] == 20
    assert impact["mean_journey_time_change_s"] == 25
    assert round(impact["mean_journey_time_change_pct"], 3) == 20.833


def test_edge_speed_is_weighted_by_vehicle_observations_not_empty_samples():
    stats = traffic._summarize_edge_totals({
        "edge": {
            "samples": 3.0,
            "vehicle_count": 3.0,
            # Two vehicles at 10 m/s, then one at 4 m/s, plus one empty sample.
            "speed_vehicle_sum": 24.0,
            "halted": 1.0,
        },
        "empty": {
            "samples": 3.0,
            "vehicle_count": 0.0,
            "speed_vehicle_sum": 0.0,
            "halted": 0.0,
        },
    })
    assert stats["edge"]["mean_speed_mps"] == 8.0
    assert stats["edge"]["mean_vehicle_count"] == 1.0
    assert stats["empty"]["mean_speed_mps"] == 0.0


def test_parse_tripinfo_keeps_per_vehicle_rows_for_pairing(tmp_path):
    tripinfo = tmp_path / "tripinfo.xml"
    tripinfo.write_text(
        """<?xml version="1.0"?>
<tripinfos>
    <tripinfo id="v0" duration="100" departDelay="5" routeLength="1000" timeLoss="10"/>
    <tripinfo id="v1" duration="200" routeLength="1000" timeLoss="30"/>
</tripinfos>
""",
        encoding="utf-8",
    )
    metrics = traffic._parse_tripinfo(tripinfo)
    assert set(metrics["per_vehicle"]) == {"v0", "v1"}
    assert metrics["per_vehicle"]["v0"]["duration_s"] == 100.0
    assert metrics["per_vehicle"]["v0"]["depart_delay_s"] == 5.0
    assert metrics["per_vehicle"]["v0"]["journey_time_s"] == 105.0
    assert metrics["per_vehicle"]["v1"]["time_loss_s"] == 30.0


def test_diff_metrics_reports_percent_change():
    baseline = {
        "mean_duration_s": 100.0, "mean_time_loss_s": 20.0, "mean_speed_mps": 10.0, "trip_count": 45,
        "per_vehicle": {"a": {"duration_s": 100, "time_loss_s": 20, "route_length_m": 1000, "speed_mps": 10}},
    }
    closure = {
        "mean_duration_s": 120.0, "mean_time_loss_s": 30.0, "mean_speed_mps": 8.0, "trip_count": 40,
        "per_vehicle": {"a": {"duration_s": 120, "time_loss_s": 30, "route_length_m": 1100, "speed_mps": 8}},
    }
    impact = traffic._diff_metrics(baseline, closure, planned_count=50)
    assert impact["mean_duration_change_s"] == 20.0
    assert impact["mean_duration_change_pct"] == 20.0
    assert impact["completed_trip_ratio_baseline"] == 0.9
    assert impact["completed_trip_ratio_closure"] == 0.8
    assert impact["completed_trip_change"] == -5
    assert impact["completion_change_percentage_points"] == -10.0


def test_diff_metrics_reports_environmental_changes():
    baseline = {
        "mean_duration_s": 100.0, "mean_time_loss_s": 20.0, "mean_speed_mps": 10.0,
        "trip_count": 10, "environment": {"co2_kg": 4.0, "nox_g": 8.0},
    }
    closure = {
        "mean_duration_s": 120.0, "mean_time_loss_s": 30.0, "mean_speed_mps": 8.0,
        "trip_count": 9,
        "environment": {"co2_kg": 5.0, "nox_g": 10.0, "mean_active_edge_noise_db": 72.0},
    }
    baseline["environment"]["mean_active_edge_noise_db"] = 70.0
    impact = traffic._diff_metrics(baseline, closure, planned_count=10)
    assert impact["environment"]["co2_kg"]["change"] == 1.0
    assert impact["environment"]["co2_kg"]["change_pct"] == 25.0
    assert impact["environment"]["nox_g"]["change"] == 2.0
    assert impact["environment"]["mean_active_edge_noise_db"]["change"] == 2.0
    assert impact["environment"]["mean_active_edge_noise_db"]["change_pct"] is None


def test_flow_comparison_reports_changed_segments_and_geometry():
    corridor = [{
        "id": "edge-a",
        "name": "Loop Street",
        "line": traffic.LineString([(0, 0), (20, 0)]),
    }]
    flow = traffic._flow_comparison(
        corridor,
        {"edge-a": {"mean_vehicle_count": 2.0, "mean_speed_mps": 10.0, "mean_halted": 0.0}},
        {"edge-a": {"mean_vehicle_count": 5.0, "mean_speed_mps": 4.0, "mean_halted": 1.5}},
    )
    assert flow[0]["vehicle_delta"] == 3.0
    assert flow[0]["closure_halted"] == 1.5
    assert flow[0]["points"] == [[0.0, 0.0], [20.0, 0.0]]


def test_street_flow_summary_aggregates_duplicate_road_names():
    summary = traffic._aggregate_flow_by_street([
        {
            "name": "Strand Street", "vehicle_delta": -10.0,
            "closure_vehicles": 2.0, "closure_speed_mps": 5.0, "closure_halted": 1.0,
            "points": [[0, 0], [100, 0]],
        },
        {
            "name": "STRAND STREET", "vehicle_delta": -20.0,
            "closure_vehicles": 6.0, "closure_speed_mps": 10.0, "closure_halted": 3.0,
            "points": [[100, 0], [400, 0]],
        },
        {
            "name": "Buitengracht Street", "vehicle_delta": 8.0,
            "closure_vehicles": 4.0, "closure_speed_mps": 4.0, "closure_halted": 2.0,
            "points": [[0, 20], [50, 20]],
        },
    ])
    strand = next(item for item in summary if traffic._normalise_road_name(item["name"]) == "STRAND")
    assert strand["section_count"] == 2
    assert strand["vehicle_delta"] == -30.0
    assert strand["closure_speed_mps"] == 8.75
    assert strand["closure_halted"] == 4.0
    assert len(summary) == 2


def test_closure_preview_requires_road_name():
    try:
        traffic.closure_preview({"road_name": "  "})
    except ValueError as error:
        assert "road_name" in str(error)
    else:
        raise AssertionError("blank road_name should fail")


def test_closure_preview_validates_duration_range():
    try:
        traffic.closure_preview({"road_name": "Long Street", "duration_min": 500})
    except ValueError as error:
        assert "duration_min" in str(error)
    else:
        raise AssertionError("out-of-range duration_min should fail")


def test_closure_preview_monitors_a_wider_radius_than_it_generates_demand_in(monkeypatch):
    # SUMO's router isn't confined to the 250 m demand corridor, so the
    # report should look further out than that for diverted traffic instead
    # of silently dropping anything just past the buffer -- see
    # MONITORING_RADIUS_M in server/traffic.py.
    real_corridor_edges = traffic.corridor_edges
    requested_radii = []

    def spy_corridor_edges(road_name, radius_m=traffic.CORRIDOR_RADIUS_M):
        requested_radii.append(radius_m)
        return real_corridor_edges(road_name, radius_m)

    monkeypatch.setattr(traffic, "corridor_edges", spy_corridor_edges)
    monkeypatch.setattr(
        traffic, "resolve_closure_lanes",
        lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("stop before running SUMO")),
    )
    try:
        traffic.closure_preview({"road_name": "Adderley Street"})
    except ValueError:
        pass
    assert traffic.CORRIDOR_RADIUS_M in requested_radii
    assert traffic.MONITORING_RADIUS_M in requested_radii
    assert traffic.MONITORING_RADIUS_M > traffic.CORRIDOR_RADIUS_M


def test_closure_preview_validates_demand_sensitivity_range():
    try:
        traffic.closure_preview({"road_name": "Long Street", "demand_multiplier": 3})
    except ValueError as error:
        assert "demand_multiplier" in str(error)
    else:
        raise AssertionError("out-of-range demand_multiplier should fail")


def test_parse_tripinfo_computes_means(tmp_path):
    tripinfo = tmp_path / "tripinfo.xml"
    tripinfo.write_text(
        """<?xml version="1.0"?>
<tripinfos>
    <tripinfo id="0" duration="100" routeLength="1000" timeLoss="10"/>
    <tripinfo id="1" duration="200" routeLength="1000" timeLoss="30"/>
</tripinfos>
""",
        encoding="utf-8",
    )
    metrics = traffic._parse_tripinfo(tripinfo)
    assert metrics["trip_count"] == 2
    assert metrics["mean_duration_s"] == 150.0
    assert metrics["mean_time_loss_s"] == 20.0


def test_parse_tripinfo_handles_missing_file(tmp_path):
    metrics = traffic._parse_tripinfo(tmp_path / "does-not-exist.xml")
    assert metrics["trip_count"] == 0
    assert metrics["mean_duration_s"] == 0.0


# --------------------------------------------------------------------------
# Time-of-day scenarios
# --------------------------------------------------------------------------


def test_peak_scenarios_carry_more_demand_than_off_peak():
    am_peak = traffic.resolve_scenario("am_peak")
    midday = traffic.resolve_scenario("midday")
    evening = traffic.resolve_scenario("evening")
    assert am_peak["demand_scale"] > midday["demand_scale"] > evening["demand_scale"]


def test_morning_and_afternoon_peaks_bias_trips_in_opposite_directions():
    morning = traffic.resolve_scenario("am_peak")
    afternoon = traffic.resolve_scenario("pm_peak")
    assert morning["inbound_bias"] > 0  # toward the CBD core
    assert afternoon["inbound_bias"] < 0  # away from it
    assert morning["demand_scale"] == afternoon["demand_scale"]


def test_live_scenario_takes_its_demand_from_the_live_speed_ratio():
    congested = traffic.resolve_scenario("live", 0.2)
    flowing = traffic.resolve_scenario("live", 1.0)
    assert congested["demand_scale"] > flowing["demand_scale"]


def test_unknown_scenario_is_rejected():
    try:
        traffic.resolve_scenario("lunchtime")
    except ValueError as error:
        assert "lunchtime" in str(error)
    else:
        raise AssertionError("unknown scenario should fail")


# --------------------------------------------------------------------------
# Lane-level closure
# --------------------------------------------------------------------------


class _FakeLane:
    def __init__(self, lane_id: str):
        self._id = lane_id

    def getID(self) -> str:
        return self._id


class _FakeNode:
    def __init__(self, node_id: str):
        self._id = node_id
        self.outgoing: list["_FakeLaneEdge"] = []

    def getID(self) -> str:
        return self._id

    def getOutgoing(self) -> list["_FakeLaneEdge"]:
        return self.outgoing


class _FakeLaneEdge:
    def __init__(
        self,
        edge_id: str,
        name: str,
        lane_count: int,
        allows_passenger: bool = True,
        from_node: "_FakeNode | None" = None,
        to_node: "_FakeNode | None" = None,
    ):
        self._id = edge_id
        self._name = name
        self._lanes = [_FakeLane(f"{edge_id}_{index}") for index in range(lane_count)]
        self._allows = allows_passenger
        self._from_node = from_node or _FakeNode(f"{edge_id}_from")
        self._to_node = to_node or _FakeNode(f"{edge_id}_to")
        self._from_node.outgoing.append(self)

    def getID(self) -> str:
        return self._id

    def getName(self) -> str:
        return self._name

    def getLanes(self) -> list[_FakeLane]:
        return self._lanes

    def allows(self, vehicle_class: str) -> bool:
        return self._allows

    def getFromNode(self) -> _FakeNode:
        return self._from_node

    def getToNode(self) -> _FakeNode:
        return self._to_node


def fake_lane_net():
    return _FakeNet(
        [
            _FakeLaneEdge("a", "Bree Street", 3),
            _FakeLaneEdge("b", "Bree Street", 2),
            _FakeLaneEdge("c", "Bree Street", 1),  # too narrow to lose a lane
            _FakeLaneEdge("d", "Long Street", 2),
        ]
    )


def test_lane_closure_takes_left_hand_kerbside_lane_and_leaves_single_lane_sections(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_lane_net)
    closure = traffic.resolve_closure_lanes("Bree Street", "lane")
    # Verified against the network's actual lane geometry: index 0 runs along
    # the left side of the travel direction, which is the kerbside lane for
    # Cape Town's left-hand traffic -- exactly one removed per multi-lane edge.
    assert closure["lane_ids"] == ["a_0", "b_0"]
    assert closure["edges_narrowed"] == 2
    assert closure["edges_skipped_single_lane"] == 1
    assert closure["edges_total"] == 3
    # A narrowing must not sever the road, so no whole edge is disallowed.
    assert closure["edge_ids"] == []


def test_full_closure_removes_every_lane_and_edge(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_lane_net)
    closure = traffic.resolve_closure_lanes("Bree Street", "full")
    assert closure["lane_ids"] == ["a_0", "a_1", "a_2", "b_0", "b_1", "c_0"]
    assert sorted(closure["edge_ids"]) == ["a", "b", "c"]


def test_drawn_lane_closure_uses_only_selected_edges(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_lane_net)
    closure = traffic.resolve_drawn_closure(["b"], "lane")
    assert closure["lane_ids"] == ["b_0"]
    assert closure["affected_edge_ids"] == ["b"]
    assert closure["scope"] == "drawn"


def test_drawn_lane_closure_does_not_report_skipped_single_lane_edge(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_lane_net)
    closure = traffic.resolve_drawn_closure(["b", "c"], "lane")
    assert closure["lane_ids"] == ["b_0"]
    assert closure["affected_edge_ids"] == ["b"]
    assert closure["edges_skipped_single_lane"] == 1


def test_drawn_full_closure_includes_aligned_parallel_carriageway(monkeypatch):
    network = _FakeNet([
        _FakeLaneEdge("north", "Adderley Street", 2),
        _FakeLaneEdge("south", "Adderley Street", 2),
        _FakeLaneEdge("next", "Adderley Street", 2),
    ])
    monkeypatch.setattr(traffic, "_sumo_net", lambda: network)
    monkeypatch.setattr(traffic, "_edge_index", lambda: {
        "north": {"name": "Adderley Street", "line": traffic.LineString([(0, 0), (0, 40)])},
        "south": {"name": "Adderley Street", "line": traffic.LineString([(12, 40), (12, 0)])},
        "next": {"name": "Adderley Street", "line": traffic.LineString([(0, 40), (0, 80)])},
    })
    closure = traffic.resolve_drawn_closure(["north"], "full")
    assert set(closure["edge_ids"]) == {"north", "south"}
    assert "next" not in closure["edge_ids"]


def test_lane_closure_on_an_all_single_lane_road_is_rejected(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", lambda: _FakeNet([_FakeLaneEdge("z", "Alley", 1)]))
    try:
        traffic.resolve_closure_lanes("Alley", "lane")
    except ValueError as error:
        assert "multi-lane" in str(error)
    else:
        raise AssertionError("narrowing a single-lane road should fail")


def test_invalid_closure_mode_is_rejected(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_lane_net)
    try:
        traffic.resolve_closure_lanes("Bree Street", "sidewalk")
    except ValueError as error:
        assert "closure_mode" in str(error)
    else:
        raise AssertionError("unknown closure_mode should fail")


def fake_one_way_net():
    node_a = _FakeNode("A")
    node_b = _FakeNode("B")
    node_c = _FakeNode("C")
    forward = _FakeLaneEdge("fwd", "Alpha Street", 2, from_node=node_a, to_node=node_b)
    reverse = _FakeLaneEdge("rev", "Alpha Street Return", 2, from_node=node_b, to_node=node_a)
    lonely = _FakeLaneEdge("solo", "Solo Way", 2, from_node=node_b, to_node=node_c)
    return _FakeNet([forward, reverse, lonely])


def test_remaining_open_direction_finds_the_untouched_sibling():
    # A plain full closure of one direction of a two-way street -- what the
    # dedicated "one-way" drawing tool submits, with no `one_way` flag at
    # all -- should still be recognised as leaving the other direction open.
    net = fake_one_way_net()
    assert traffic._remaining_open_direction({"rev"}, net) == ["fwd"]
    assert traffic._remaining_open_direction({"fwd"}, net) == ["rev"]


def test_remaining_open_direction_empty_when_both_sides_closed():
    net = fake_one_way_net()
    assert traffic._remaining_open_direction({"fwd", "rev"}, net) == []


def test_remaining_open_direction_empty_with_no_sibling():
    net = fake_one_way_net()
    assert traffic._remaining_open_direction({"solo"}, net) == []


def test_resolve_closure_lanes_one_way_closes_reverse_edge(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_one_way_net)
    closure = traffic.resolve_closure_lanes("Alpha Street", "lane", one_way=True)
    # The forward edge is narrowed like any lane closure; the opposite-
    # direction sibling between the same node pair is fully closed to
    # enforce one-way travel, not narrowed.
    assert closure["lane_ids"] == ["fwd_0"]
    assert closure["reverse_edge_ids"] == ["rev"]
    assert closure["edge_ids"] == ["rev"]
    assert closure["already_one_way_edge_ids"] == []


def test_resolve_closure_lanes_reports_already_one_way_without_closing_anything(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_one_way_net)
    closure = traffic.resolve_closure_lanes("Solo Way", "lane", one_way=True)
    # No sibling edge runs the opposite way between the same nodes, so this
    # street is already one-way -- report it honestly instead of fabricating
    # a closure.
    assert closure["reverse_edge_ids"] == []
    assert closure["already_one_way_edge_ids"] == ["solo"]
    assert closure["edge_ids"] == []


def test_resolve_closure_lanes_without_one_way_leaves_reverse_edge_open(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_one_way_net)
    closure = traffic.resolve_closure_lanes("Alpha Street", "lane", one_way=False)
    assert closure["edge_ids"] == []
    assert closure["reverse_edge_ids"] == []
    assert closure["one_way"] is False


def test_resolve_drawn_closure_one_way_closes_reverse_edge(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_one_way_net)
    closure = traffic.resolve_drawn_closure(["fwd"], "lane", one_way=True)
    assert closure["lane_ids"] == ["fwd_0"]
    assert closure["reverse_edge_ids"] == ["rev"]
    assert closure["edge_ids"] == ["rev"]


def test_resolve_drawn_closure_one_way_reports_already_one_way(monkeypatch):
    monkeypatch.setattr(traffic, "_sumo_net", fake_one_way_net)
    closure = traffic.resolve_drawn_closure(["solo"], "lane", one_way=True)
    assert closure["reverse_edge_ids"] == []
    assert closure["already_one_way_edge_ids"] == ["solo"]
    assert closure["edge_ids"] == []


def test_closure_preview_ignores_one_way_for_full_closure_mode(monkeypatch):
    # A full closure already shuts the selected direction entirely; also
    # closing its reverse sibling would silently pedestrianise both
    # directions while still reporting it as "converted to one-way".
    captured = {}

    def fake_resolve_drawn_closure(edge_ids, closure_mode, one_way=False):
        captured["one_way"] = one_way
        raise ValueError("stop before running SUMO")

    monkeypatch.setattr(traffic, "resolve_drawn_closure", fake_resolve_drawn_closure)
    try:
        traffic.closure_preview({"edge_ids": ["any"], "closure_mode": "full", "one_way": True})
    except ValueError:
        pass
    assert captured["one_way"] is False


def test_closure_preview_keeps_one_way_for_lane_closure_mode(monkeypatch):
    captured = {}

    def fake_resolve_drawn_closure(edge_ids, closure_mode, one_way=False):
        captured["one_way"] = one_way
        raise ValueError("stop before running SUMO")

    monkeypatch.setattr(traffic, "resolve_drawn_closure", fake_resolve_drawn_closure)
    try:
        traffic.closure_preview({"edge_ids": ["any"], "closure_mode": "lane", "one_way": True})
    except ValueError:
        pass
    assert captured["one_way"] is True


def test_closure_preview_validates_closure_mode():
    try:
        traffic.closure_preview({"road_name": "Bree Street", "closure_mode": "sidewalk"})
    except ValueError as error:
        assert "closure_mode" in str(error)
    else:
        raise AssertionError("unknown closure_mode should fail")


# --------------------------------------------------------------------------
# Corridor-scoped demand generation
# --------------------------------------------------------------------------


def corridor_fixture():
    """Two edges near the CBD core and two out at the corridor rim."""
    from shapely.geometry import Point

    return [
        {"id": "core-a", "lane_count": 2, "length_m": 100.0, "midpoint": Point(0, 0)},
        {"id": "core-b", "lane_count": 2, "length_m": 100.0, "midpoint": Point(20, 20)},
        {"id": "rim-a", "lane_count": 2, "length_m": 100.0, "midpoint": Point(800, 0)},
        {"id": "rim-b", "lane_count": 2, "length_m": 100.0, "midpoint": Point(0, 800)},
    ]


def test_inbound_bias_sends_morning_trips_from_the_rim_toward_the_core():
    corridor = corridor_fixture()
    origins, destinations = traffic._trip_weights(corridor, inbound_bias=0.75)
    by_id = {record["id"]: index for index, record in enumerate(corridor)}
    # Morning: rim edges are favoured origins, core edges favoured destinations.
    assert origins[by_id["rim-a"]] > origins[by_id["core-a"]]
    assert destinations[by_id["core-a"]] > destinations[by_id["rim-a"]]


def test_outbound_bias_reverses_the_flow():
    corridor = corridor_fixture()
    origins, destinations = traffic._trip_weights(corridor, inbound_bias=-0.75)
    by_id = {record["id"]: index for index, record in enumerate(corridor)}
    assert origins[by_id["core-a"]] > origins[by_id["rim-a"]]
    assert destinations[by_id["rim-a"]] > destinations[by_id["core-a"]]


def test_undirected_scenario_weights_origins_and_destinations_alike():
    corridor = corridor_fixture()
    origins, destinations = traffic._trip_weights(corridor, inbound_bias=0.0)
    assert origins == destinations


def test_trip_weights_favour_larger_roads():
    from shapely.geometry import Point

    corridor = [
        {"id": "arterial", "lane_count": 4, "length_m": 400.0, "midpoint": Point(100, 0)},
        {"id": "service", "lane_count": 1, "length_m": 40.0, "midpoint": Point(100, 10)},
    ]
    origins, _ = traffic._trip_weights(corridor, inbound_bias=0.0)
    assert origins[0] > origins[1]


def test_trip_weights_use_municipal_lanes_and_right_of_way_class():
    from shapely.geometry import Point

    corridor = [
        {
            "id": "arterial", "lane_count": 1, "length_m": 100.0, "midpoint": Point(100, 0),
            "municipal": {"lane_count": 3, "right_of_way_class": "1"},
        },
        {
            "id": "local", "lane_count": 1, "length_m": 100.0, "midpoint": Point(100, 10),
            "municipal": {"lane_count": 1, "right_of_way_class": "5"},
        },
    ]
    origins, _ = traffic._trip_weights(corridor, inbound_bias=0.0)
    assert origins[0] > origins[1] * 4


def test_trip_weights_favour_currently_congested_roads():
    from shapely.geometry import Point

    corridor = [
        {"id": "jammed", "name": "Jammed Street", "lane_count": 2, "length_m": 100.0, "midpoint": Point(100, 0)},
        {"id": "clear", "name": "Clear Street", "lane_count": 2, "length_m": 100.0, "midpoint": Point(100, 10)},
    ]
    without_live_data, _ = traffic._trip_weights(corridor, inbound_bias=0.0)
    assert without_live_data[0] == without_live_data[1]  # identical roads, no live signal yet

    with_live_data, _ = traffic._trip_weights(
        corridor, inbound_bias=0.0,
        road_congestion={"Jammed Street": 0.2, "Clear Street": 1.1},
    )
    assert with_live_data[0] > with_live_data[1]


def test_corridor_sample_points_ranks_by_capacity_and_caps_at_limit():
    from shapely.geometry import Point

    corridor = [
        {"name": "Big Road", "lane_count": 4, "length_m": 400.0, "midpoint": Point(0, 0)},
        {"name": "Small Road", "lane_count": 1, "length_m": 40.0, "midpoint": Point(50, 0)},
        # Same street mapped as two edges -- only the larger should be kept.
        {"name": "Big Road", "lane_count": 1, "length_m": 20.0, "midpoint": Point(10, 10)},
    ]
    points = traffic._corridor_sample_points(corridor, limit=1)
    assert len(points) == 1
    assert points[0]["name"] == "Big Road"
    assert "lon" in points[0]["sample_point"] and "lat" in points[0]["sample_point"]


def test_corridor_live_ratios_falls_back_to_none_without_api_key(monkeypatch):
    monkeypatch.delenv("TOMTOM_API", raising=False)
    assert traffic._corridor_live_ratios(corridor_fixture()) is None


def test_corridor_live_ratios_uses_per_road_tomtom_samples(monkeypatch):
    from shapely.geometry import Point

    monkeypatch.setenv("TOMTOM_API", "test-key")
    corridor = [{"name": "Jammed Street", "lane_count": 2, "length_m": 100.0, "midpoint": Point(0, 0)}]
    monkeypatch.setattr(
        traffic, "_corridor_sample_points",
        lambda corridor, limit=8: [{"name": "Jammed Street", "sample_point": {"lat": -33.9, "lon": 18.4}}],
    )
    monkeypatch.setattr(traffic, "_fetch_flow_segment", lambda lat, lon, key: sample_flow_segment(10.0, 40.0))
    result = traffic._corridor_live_ratios(corridor)
    assert result["roads_sampled"] == 1
    assert result["per_road_ratio"]["Jammed Street"] == 0.25
    assert result["average_ratio"] == 0.25


def test_closure_preview_live_scenario_prefers_corridor_specific_tomtom_data(monkeypatch):
    monkeypatch.setenv("TOMTOM_API", "test-key")
    citywide_called = []
    monkeypatch.setattr(traffic, "current_traffic", lambda: citywide_called.append(True) or {"average_speed_ratio": 0.85})
    monkeypatch.setattr(
        traffic, "_corridor_live_ratios",
        lambda corridor: {"per_road_ratio": {"Adderley Street": 0.3}, "average_ratio": 0.3, "roads_sampled": 1, "roads_requested": 1},
    )
    captured = {}

    def fake_generate_trips(**kwargs):
        captured.update(kwargs)
        raise ValueError("stop before running SUMO")

    monkeypatch.setattr(traffic, "_generate_trips", fake_generate_trips)
    try:
        traffic.closure_preview({"road_name": "Adderley Street", "scenario": "live", "duration_min": 5})
    except ValueError:
        pass
    assert not citywide_called  # corridor-specific data was available, so the citywide fallback must not run
    assert captured.get("road_congestion") == {"Adderley Street": 0.3}


def test_street_activity_summary_counts_inventory_near_corridor(monkeypatch):
    corridor = [{"line": traffic.LineString([(0, 0), (100, 0)])}]
    monkeypatch.setattr(traffic, "_street_activity_records", lambda: (
        {"type": "parkingSpace", "point": traffic.Point(20, 4), "raised": False},
        {"type": "pedestrianCrossing", "point": traffic.Point(40, 2), "raised": True},
        {"type": "parkingSpace", "point": traffic.Point(20, 100), "raised": False},
    ))
    summary = traffic._street_activity_summary(corridor)
    assert summary["parking_spaces"] == 1
    assert summary["pedestrian_crossings"] == 1
    assert summary["raised_crossings"] == 1


def test_generated_fleet_has_distinct_emission_classes(tmp_path):
    trips_path, _ = traffic._generate_trips(
        corridor=corridor_fixture(), duration_s=300, vehicle_count=20,
        inbound_bias=0.0, seed=3, workdir=tmp_path,
    )
    root = ElementTree.parse(trips_path).getroot()
    classes = {item.get("id"): item.get("emissionClass") for item in root.findall("vType")}
    assert classes["car"].startswith("HBEFA3/PC_G")
    assert classes["minibus_taxi"].startswith("HBEFA3/PC_D")
    assert classes["delivery_van"].startswith("HBEFA3/LDV_D")
    assert classes["city_shuttle"].startswith("HBEFA3/HDV_D")


def test_generated_trips_are_departure_sorted_and_never_self_routing(tmp_path):
    corridor = corridor_fixture()
    trips_path, count = traffic._generate_trips(
        corridor=corridor,
        duration_s=600,
        vehicle_count=200,
        inbound_bias=0.5,
        seed=7,
        workdir=tmp_path,
    )
    root = ElementTree.parse(trips_path).getroot()
    trips = root.findall("trip")
    assert count == len(trips)
    assert 0 < count <= 200  # self-routing trips are dropped, so <= requested
    departures = [float(trip.get("depart")) for trip in trips]
    assert departures == sorted(departures)  # SUMO requires sorted input
    assert all(0.0 <= depart <= 600.0 for depart in departures)
    assert all(trip.get("from") != trip.get("to") for trip in trips)
    assert root.find("vType") is not None
    assert {trip.get("type") for trip in trips}.issubset(traffic.FLEET_MIX)
    assert len(root.findall("vType")) == len(traffic.FLEET_MIX)


def test_generated_trips_are_reproducible_for_a_given_seed(tmp_path):
    corridor = corridor_fixture()
    first, _ = traffic._generate_trips(
        corridor=corridor, duration_s=300, vehicle_count=50,
        inbound_bias=0.0, seed=99, workdir=tmp_path / "a",
    )
    second, _ = traffic._generate_trips(
        corridor=corridor, duration_s=300, vehicle_count=50,
        inbound_bias=0.0, seed=99, workdir=tmp_path / "b",
    )
    assert first.read_text(encoding="utf-8") == second.read_text(encoding="utf-8")


def test_longer_window_extends_the_same_demand_stream(tmp_path):
    """A longer preview must not silently swap in a different population."""
    corridor = corridor_fixture()
    short_path, _ = traffic._generate_trips(
        corridor=corridor, duration_s=300, vehicle_count=50,
        inbound_bias=0.0, seed=99, workdir=tmp_path / "short",
    )
    long_path, _ = traffic._generate_trips(
        corridor=corridor, duration_s=600, vehicle_count=100,
        inbound_bias=0.0, seed=99, workdir=tmp_path / "long",
    )
    short_trips = ElementTree.parse(short_path).getroot().findall("trip")
    long_trips = ElementTree.parse(long_path).getroot().findall("trip")
    short_rows = [
        (trip.get("depart"), trip.get("from"), trip.get("to"), trip.get("type"))
        for trip in short_trips
    ]
    long_prefix = [
        (trip.get("depart"), trip.get("from"), trip.get("to"), trip.get("type"))
        for trip in long_trips[:len(short_rows)]
    ]
    assert long_prefix == short_rows
