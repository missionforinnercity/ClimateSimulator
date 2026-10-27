"""Pedestrian wind screening metrics and observation-based validation.

These diagnostics deliberately sit above the flow solver.  They make the
exploratory field useful for comfort screening without pretending that a
diagnostic mass-conserving model is CFD or a calibrated wind-tunnel result.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from .wind_criteria import DEFAULT_CRITERION_ID, LAWSON_LDDC_SCREENING_V1, get_criterion


# Legacy default thresholds retained for backwards compatibility. The
# selected, versioned criterion and its source/method metadata are returned with
# each field. This default remains a screen, not formal compliance evidence.
COMFORT_CATEGORIES = tuple(LAWSON_LDDC_SCREENING_V1["categories"])

STABILITY_PROFILES = {
    "unstable": {"label": "Unstable / convective", "power_law_exponent": 0.20, "weibull_shape": 1.7},
    "neutral": {"label": "Neutral urban", "power_law_exponent": 0.33, "weibull_shape": 2.0},
    "stable": {"label": "Stable", "power_law_exponent": 0.45, "weibull_shape": 2.5},
}

MODEL_RELATIVE_UNCERTAINTY = {
    "directional_speed_proxy": 0.40,
    "mass_conserving_terrain": 0.32,
    "mass_conserving_terrain_buildings": 0.27,
}


def height_profile_factor(height_m: float, reference_height_m: float, stability: str) -> float:
    """Power-law conversion between reference and pedestrian height."""
    exponent = STABILITY_PROFILES[stability]["power_law_exponent"]
    return (height_m / reference_height_m) ** exponent


def weibull_quantile(mean_speed: np.ndarray, probability: float, shape: float) -> np.ndarray:
    """Return the quantile for a Weibull distribution parameterised by mean."""
    scale = mean_speed / math.gamma(1.0 + 1.0 / shape)
    return scale * (-math.log1p(-probability)) ** (1.0 / shape)


def weibull_exceedance(mean_speed: np.ndarray, threshold_mps: float, shape: float) -> np.ndarray:
    scale = mean_speed / math.gamma(1.0 + 1.0 / shape)
    with np.errstate(divide="ignore", invalid="ignore"):
        probability = np.exp(-np.power(threshold_mps / scale, shape))
    return np.where(mean_speed > 1e-9, probability, 0.0)


def comfort_codes(speed_exceeded_5pct: np.ndarray, categories: tuple[dict[str, Any], ...] | list[dict[str, Any]] = COMFORT_CATEGORIES) -> np.ndarray:
    codes = np.full(speed_exceeded_5pct.shape, int(categories[-1]["code"]), dtype=np.uint8)
    for category in reversed(categories[:-1]):
        codes = np.where(speed_exceeded_5pct <= category["max_speed_mps"], category["code"], codes)
    return codes


def comfort_codes_from_exceedance(
    exceedance_by_threshold: dict[float, np.ndarray], *, accepted_probability: float = 0.05,
    categories: tuple[dict[str, Any], ...] | list[dict[str, Any]] = COMFORT_CATEGORIES,
) -> np.ndarray:
    """Classify activity from wind-rose-weighted threshold exceedance.

    Unlike :func:`comfort_codes`, this consumes the annual/seasonal probability
    from all simulated direction sectors.  The first (most sensitive) activity
    whose threshold is exceeded no more than five percent of the time wins.
    """
    first = next(iter(exceedance_by_threshold.values()))
    uncomfortable_code = int(categories[-1]["code"])
    codes = np.full(np.asarray(first).shape, uncomfortable_code, dtype=np.uint8)
    for category in categories[:-1]:
        probability = np.asarray(exceedance_by_threshold[float(category["max_speed_mps"])])
        codes = np.where((codes == uncomfortable_code) & (probability <= accepted_probability), category["code"], codes)
    return codes


def add_screening_metrics(
    field: dict[str, Any], *, stability: str, exceedance_threshold_mps: float,
    weibull_shape: float | None = None, sector_frequency_fraction: float | None = None,
    criterion_id: str = DEFAULT_CRITERION_ID,
) -> dict[str, Any]:
    """Attach comfort, exceedance, and epistemic uncertainty grids."""
    speed = np.asarray(field["speed"], dtype=float)
    criterion = get_criterion(criterion_id)
    categories = criterion["categories"]
    shape = weibull_shape or STABILITY_PROFILES[stability]["weibull_shape"]
    speed_exceeded_5pct = weibull_quantile(speed, 0.95, shape)
    exceedance = weibull_exceedance(speed, exceedance_threshold_mps, shape)

    relative = MODEL_RELATIVE_UNCERTAINTY.get(field["model_kind"], 0.40)
    # Height extrapolation adds uncertainty when the requested and forcing
    # heights differ.  Cap the screening interval so it remains interpretable.
    height_ratio = max(field["reference_height_m"], field["height_m"]) / min(
        field["reference_height_m"], field["height_m"]
    )
    relative = min(0.60, relative + 0.04 * abs(math.log(height_ratio)))
    incomplete_era5 = bool(field.get("era5_profile")) and not field["era5_profile"]["coverage"]["complete_hourly_climatology"]
    if incomplete_era5:
        relative = min(0.60, relative + 0.05)
    lower = np.maximum(0.0, speed * (1.0 - relative))
    upper = speed * (1.0 + relative)

    exceedance_payload = {
        "threshold_mps": exceedance_threshold_mps,
        "basis": "conditional_on_selected_sector_and_mean_forcing",
        "distribution": "weibull",
        "weibull_shape": round(shape, 4),
        "probability": np.round(exceedance, 6).tolist(),
    }
    if sector_frequency_fraction is not None:
        exceedance_payload.update({
            "sector_frequency_fraction": sector_frequency_fraction,
            "sector_contribution_probability": np.round(exceedance * sector_frequency_fraction, 6).tolist(),
            "frequency_quality": "provisional_incomplete_hourly_archive" if incomplete_era5
            else "complete_hourly_era5_reanalysis_not_independent_station_validation",
        })
    field.update({
        "analysis_mode": "preview",
        "comfort_standard": criterion["name"],
        "comfort_criterion": criterion,
        "comfort_categories": categories,
        "comfort_category": comfort_codes(speed_exceeded_5pct, categories).tolist(),
        "speed_exceeded_5pct_mps": np.round(speed_exceeded_5pct, 4).tolist(),
        "exceedance": exceedance_payload,
        "uncertainty": {
            "kind": "screening_epistemic_interval_not_confidence_interval",
            "relative_fraction": round(relative, 4),
            "speed_lower_mps": np.round(lower, 4).tolist(),
            "speed_upper_mps": np.round(upper, 4).tolist(),
            "drivers": ["model_form", "unresolved_turbulence", "height_profile"]
            + (["incomplete_ERA5_temporal_sampling"] if incomplete_era5 else []),
        },
        "stability": {"key": stability, **STABILITY_PROFILES[stability]},
    })
    return field


def _bilinear(values: np.ndarray, field: dict[str, Any], x: float, z: float) -> float:
    rows, columns = values.shape
    column = np.clip((x - field["origin"][0]) / field["dx"] - 0.5, 0.0, columns - 1.001)
    row = np.clip((z - field["origin"][1]) / field["dz"] - 0.5, 0.0, rows - 1.001)
    c0, r0 = int(column), int(row)
    c1, r1 = min(c0 + 1, columns - 1), min(r0 + 1, rows - 1)
    fc, fr = column - c0, row - r0
    return float(
        (values[r0, c0] * (1 - fc) + values[r0, c1] * fc) * (1 - fr)
        + (values[r1, c0] * (1 - fc) + values[r1, c1] * fc) * fr
    )


def validate_against_observations(field: dict[str, Any], observations: list[dict[str, Any]]) -> dict[str, Any]:
    """Compare a field with pedestrian observations and build an IDW error map."""
    speed_grid = np.asarray(field["speed"], dtype=float).reshape(field["height"], field["width"])
    samples = []
    exponent = field["stability"]["power_law_exponent"]
    for observation in observations:
        predicted = _bilinear(speed_grid, field, observation["x"], observation["z"])
        adjusted_observation = observation["speed_mps"] * (field["height_m"] / observation["height_m"]) ** exponent
        error = predicted - adjusted_observation
        samples.append({
            **observation,
            "height_adjusted_observed_speed_mps": round(adjusted_observation, 4),
            "predicted_speed_mps": round(predicted, 4),
            "error_mps": round(error, 4),
        })
    errors = np.asarray([sample["error_mps"] for sample in samples], dtype=float)

    xs = field["origin"][0] + (np.arange(field["width"]) + 0.5) * field["dx"]
    zs = field["origin"][1] + (np.arange(field["height"]) + 0.5) * field["dz"]
    grid_x, grid_z = np.meshgrid(xs, zs)
    numerator = np.zeros_like(grid_x)
    denominator = np.zeros_like(grid_x)
    nearest_distance_sq = np.full_like(grid_x, np.inf)
    for sample in samples:
        distance_sq = (grid_x - sample["x"]) ** 2 + (grid_z - sample["z"]) ** 2
        nearest_distance_sq = np.minimum(nearest_distance_sq, distance_sq)
        weight = 1.0 / np.maximum(distance_sq, 1.0)
        numerator += weight * sample["error_mps"]
        denominator += weight
    error_map = numerator / denominator
    return {
        "status": "benchmark_only_not_validated",
        "observation_count": len(samples),
        "metrics": {
            "bias_mps": round(float(np.mean(errors)), 4),
            "mae_mps": round(float(np.mean(np.abs(errors))), 4),
            "rmse_mps": round(float(np.sqrt(np.mean(errors**2))), 4),
        },
        "samples": samples,
        "error_map_mps": np.round(error_map.ravel(), 4).tolist(),
        "distance_to_observation_m": np.round(np.sqrt(nearest_distance_sq).ravel(), 2).tolist(),
        "map_geometry": {key: field[key] for key in ("origin", "width", "height", "dx", "dz")},
    }
