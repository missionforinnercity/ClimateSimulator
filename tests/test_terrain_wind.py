from __future__ import annotations

import numpy as np
import pytest

from server.terrain_wind import initial_field, mass_conserve, resample_bilinear_grid, sample_bilinear, solve_terrain_field


def test_flat_terrain_passes_through_uniform_field():
    heights = np.zeros((40, 40), dtype=np.float32)
    u0 = np.full_like(heights, 3.0, dtype=np.float64)
    v0 = np.zeros_like(heights, dtype=np.float64)
    u, v = mass_conserve(u0, v0, heights, dx=10.0, dz=10.0, sample_height_m=10.0, iterations=50)
    assert np.allclose(u[5:-5, 5:-5], 3.0, atol=0.05)
    assert np.allclose(v[5:-5, 5:-5], 0.0, atol=0.05)


def test_ridge_deflects_and_blocks_flow():
    size = 60
    heights = np.zeros((size, size), dtype=np.float32)
    # A tall ridge through the middle columns spanning most (not all) of the
    # domain's rows, leaving a gap at the top so flow must channel through it
    # or deflect laterally around the blocked span -- an infinite ridge would
    # be translation-invariant and produce no lateral deflection at all.
    heights[15:size, size // 2 - 2 : size // 2 + 2] = 200.0

    u0 = np.full((size, size), 5.0, dtype=np.float64)
    v0 = np.zeros((size, size), dtype=np.float64)
    u, v = mass_conserve(u0, v0, heights, dx=25.0, dz=25.0, sample_height_m=10.0, iterations=1500)

    ridge_column = size // 2
    # Flow must be diverted (nonzero cross-stream component) just upstream of the ridge,
    # near the blocked span (away from the open gap at the top rows).
    upstream = v[20:size, ridge_column - 4]
    assert np.abs(upstream).max() > 0.02

    # Directly over the blocked ridge cells, the near-surface field is zeroed out.
    assert np.allclose(u[20:size, ridge_column], 0.0)
    assert np.allclose(v[20:size, ridge_column], 0.0)


def test_solve_terrain_field_shapes_and_sampling():
    heights = np.zeros((20, 20), dtype=np.float32)
    heights[8:12, 8:12] = 50.0
    u, v = solve_terrain_field(heights, dx=20.0, dz=20.0, direction_deg=90.0, sample_height_m=5.0)
    assert u.shape == heights.shape
    assert v.shape == heights.shape

    value = sample_bilinear(u, origin_x=-200.0, origin_z=-200.0, dx=20.0, dz=20.0, x=0.0, z=0.0)
    assert isinstance(value, float)


def test_initial_field_follows_spatially_varying_background():
    # Flat terrain isolates the background-direction seeding from the
    # slope-based speed_factor (which is 1.0 everywhere here), so u0/v0
    # should exactly match the (renormalised) background per cell.
    heights = np.zeros((10, 10), dtype=np.float32)
    background_u = np.zeros((10, 10))
    background_v = np.zeros((10, 10))
    background_u[:, :5] = 2.0  # west half blows east (+x)
    background_v[:, 5:] = 3.0  # east half blows south (+z)
    u0, v0 = initial_field(heights, dx=10.0, dz=10.0, background_u=background_u, background_v=background_v)
    assert np.allclose(u0[:, :5], 1.0)
    assert np.allclose(v0[:, :5], 0.0)
    assert np.allclose(u0[:, 5:], 0.0)
    assert np.allclose(v0[:, 5:], 1.0)


def test_initial_field_requires_direction_or_background():
    heights = np.zeros((4, 4), dtype=np.float32)
    with pytest.raises(TypeError):
        initial_field(heights, dx=10.0, dz=10.0)


def test_solve_terrain_field_uses_background_direction_when_given():
    heights = np.zeros((10, 10), dtype=np.float32)
    background_u = np.full((10, 10), 0.0)
    background_v = np.full((10, 10), 4.0)  # uniform southward background
    u, v = solve_terrain_field(heights, dx=10.0, dz=10.0, sample_height_m=10.0, background_u=background_u, background_v=background_v)
    assert u.shape == heights.shape
    # Flat terrain + uniform background is already divergence-free, so the
    # solve should pass it through essentially unchanged (same shape as
    # test_flat_terrain_passes_through_uniform_field, unit-normalised).
    assert np.allclose(u[3:-3, 3:-3], 0.0, atol=0.05)
    assert np.allclose(v[3:-3, 3:-3], 1.0, atol=0.05)


def test_resample_bilinear_grid_matches_scalar_sample_bilinear():
    field = np.arange(16.0).reshape(4, 4)
    target_x = np.array([[-5.0, 5.0], [-5.0, 5.0]])
    target_z = np.array([[-5.0, -5.0], [5.0, 5.0]])
    grid_values = resample_bilinear_grid(field, origin_x=-20.0, origin_z=-20.0, dx=10.0, dz=10.0, target_x=target_x, target_z=target_z)
    for row in range(2):
        for column in range(2):
            scalar_value = sample_bilinear(field, origin_x=-20.0, origin_z=-20.0, dx=10.0, dz=10.0, x=target_x[row, column], z=target_z[row, column])
            assert grid_values[row, column] == pytest.approx(scalar_value)


def test_explicit_solid_mask_preserves_a_gap():
    heights = np.zeros((30, 30), dtype=np.float32)
    solid = np.zeros_like(heights, dtype=bool)
    solid[:, 14:16] = True
    solid[13:17, 14:16] = False
    u0 = np.full_like(heights, 3.0, dtype=np.float64)
    v0 = np.zeros_like(heights, dtype=np.float64)
    u, v = mass_conserve(u0, v0, heights, 5.0, 5.0, solid_mask=solid, iterations=250)
    assert np.any(u[13:17, 14:16] > 0.5)
    assert np.allclose(u[:, 14:16][solid[:, 14:16]], 0.0)


def test_porous_drag_slows_but_does_not_block_flow():
    heights = np.zeros((20, 20), dtype=np.float32)
    drag = np.zeros_like(heights)
    drag[7:13, 7:13] = 0.6
    u0 = np.full_like(heights, 3.0, dtype=np.float64)
    v0 = np.zeros_like(heights, dtype=np.float64)
    u, _ = mass_conserve(u0, np.zeros_like(u0), heights, 5.0, 5.0, porous_drag=drag, iterations=100)
    assert np.all(u[7:13, 7:13] > 0.0)
    assert u[9, 9] < u[3, 3]
