from __future__ import annotations

import pytest

import server.walking_routes as walking
from scripts.build_walking_network import _is_walkable


def _payload(departure: str = "2026-01-15T09:00:00") -> dict:
    return {
        "origin": {"x": -250, "z": 0},
        "destination": {"x": 250, "z": 100},
        "departure_at": departure,
    }


def _mock_conditions(monkeypatch, *, thermal_status: str = "available") -> None:
    monkeypatch.setattr(
        walking, "ground_shade_samples",
        lambda date_text, minutes, positions, bounds=None: [minutes < 720] * len(positions),
    )

    def sample_points(samples):
        rows = []
        for _, _, when in samples:
            assert when.tzinfo is not None
            rows.append({
                "utci_c": 28.0 if when.hour >= 11 else 20.0,
                "wind_1p5m_mps": 1.25,
                "frame_id": "20260115T1200Z",
                "valid_at": "2026-01-15T10:00:00Z",
                "offset_seconds": 0,
            } if thermal_status not in {"unavailable", "stale"} else None)
        return {"status": thermal_status, "run_id": "thermal_test", "samples": rows}

    monkeypatch.setattr(walking, "sample_points_at", sample_points)


def test_network_keeps_pedestrian_edges_steps_and_marks_uncertain_access():
    graph, manifest, edge_tree, edge_ids = walking._network()
    highways = {data["tags"].get("highway") for *_, data in graph.edges(data=True)}

    assert manifest["node_count"] == graph.number_of_nodes()
    assert manifest["edge_count"] == graph.number_of_edges()
    assert "steps" in highways
    assert not highways.intersection({"motorway", "motorway_link", "construction", "proposed", "raceway"})
    assert any(data["tags"].get("access_unknown") for *_, data in graph.edges(data=True))
    assert edge_tree is not None and edge_ids


def test_builder_filters_prohibited_roads_and_respects_explicit_foot_access():
    assert not _is_walkable({"highway": "motorway"})
    assert not _is_walkable({"highway": "footway", "foot": "no"})
    assert not _is_walkable({"highway": "residential", "access": "private"})
    assert not _is_walkable({"highway": "path", "foot": "customers"})
    assert _is_walkable({"highway": "motorway", "foot": "yes"})
    assert _is_walkable({"highway": "steps"})
    assert not _is_walkable({"highway": "busway"})
    assert not _is_walkable({"highway": "cycleway"})
    assert _is_walkable({"highway": "busway", "sidewalk": "both"})


def test_routes_snap_to_edges_return_matched_agents_and_repeat(monkeypatch):
    _mock_conditions(monkeypatch)
    morning = walking.walking_routes(_payload())
    repeated = walking.walking_routes(_payload())
    afternoon = walking.walking_routes(_payload("2026-01-15T13:00:00"))

    assert morning["origin"]["snap_distance_m"] <= 50
    assert morning["destination"]["snap_distance_m"] <= 50
    fastest = next(route for route in morning["routes"] if route["id"] == "fastest")
    later_fastest = next(route for route in afternoon["routes"] if route["id"] == "fastest")
    repeated_fastest = next(route for route in repeated["routes"] if route["id"] == "fastest")
    assert fastest["metrics"]["distance_m"] > 0
    assert fastest["metrics"]["estimated_walking_minutes"] == pytest.approx(
        fastest["metrics"]["distance_m"] / 80, abs=0.1,
    )
    assert fastest["metrics"]["direct_sun_minutes"] < later_fastest["metrics"]["direct_sun_minutes"]
    assert (fastest["metrics"]["heat_load_degree_minutes"] or 0) < (later_fastest["metrics"]["heat_load_degree_minutes"] or 0)
    assert (fastest["metrics"]["heat_load_degree_minutes"] or 0) == 0
    assert later_fastest["metrics"]["heat_load_degree_minutes"] > 0
    assert len(fastest["agents"]) == 100
    assert [agent["speed_kmh"] for agent in fastest["agents"]] == [agent["speed_kmh"] for agent in repeated_fastest["agents"]]
    assert [agent["direct_sun_minutes"] for agent in fastest["agents"]] == [agent["direct_sun_minutes"] for agent in repeated_fastest["agents"]]
    assert all(4.0 <= agent["speed_kmh"] <= 5.6 for agent in fastest["agents"])
    fastest_speeds = [agent["speed_kmh"] for agent in fastest["agents"]]
    assert all([agent["speed_kmh"] for agent in route["agents"]] == fastest_speeds for route in morning["routes"])
    assert morning["route_generation"]["agent_seed"] == repeated["route_generation"]["agent_seed"]


def test_routes_return_before_matched_walkers_and_trace_has_map_positions(monkeypatch):
    _mock_conditions(monkeypatch)
    response, plan, departure = walking.walking_routes(_payload(), include_agents=False, return_plan=True)

    assert response["routes"]
    assert response["route_generation"]["agent_status"] == "pending"
    assert all(not route["agents"] for route in response["routes"])
    cohorts = walking.walking_agent_comparison(plan, departure)
    fastest = next(route for route in cohorts["routes"] if route["id"] == "fastest")
    assert len(fastest["agents"]) == 100
    assert {"x", "z", "elapsed_minutes"} <= fastest["agent_summary"]["representative_trace"][0].keys()


@pytest.mark.parametrize("thermal_status", ["unavailable", "stale"])
def test_missing_or_stale_thermal_data_keeps_sun_routes_available(monkeypatch, thermal_status):
    _mock_conditions(monkeypatch, thermal_status=thermal_status)

    result = walking.walking_routes(_payload())

    assert result["conditions"]["thermal"]["status"] == thermal_status
    assert {route["id"] for route in result["routes"]}.issuperset({"fastest", "least_sun"})
    assert not result["route_generation"]["thermal_route_available"]
    fastest = next(route for route in result["routes"] if route["id"] == "fastest")
    assert fastest["metrics"]["thermal_coverage_percent"] == 0
    assert fastest["metrics"]["heat_load_degree_minutes"] is None


def test_endpoint_over_50m_from_walkable_edge_is_rejected(monkeypatch):
    _mock_conditions(monkeypatch)
    payload = _payload()
    payload["origin"] = {"x": -1020, "z": 880}

    with pytest.raises(ValueError, match="maximum snap distance is 50 m"):
        walking.walking_routes(payload)
