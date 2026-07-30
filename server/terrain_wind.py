"""Diagnostic mass-conserving terrain wind model (WindNinja-style).

Given a terrain heightfield and a background flow direction, this produces a
unit-reference-speed, divergence-free ``u``/``v`` field: an initial guess that
follows terrain slope, corrected by an iterative mass-conservation pass that
treats terrain protruding above the sampling height as a blocking wall. This
is what makes flow bend around ridges and channel through gaps/saddles instead
of running in one constant direction irrespective of the mountain underneath
it.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import minimum_filter


def initial_field(
    heights: np.ndarray,
    dx: float,
    dz: float,
    direction_deg: float | None = None,
    background_u: np.ndarray | None = None,
    background_v: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Seed a terrain-following flow: speed up on windward slopes, slow in the lee.

    Either a scalar ``direction_deg`` (spatially-constant background flow --
    what the regional/mountain solve uses, since it has nothing upstream to
    couple to) or per-cell ``background_u``/``background_v`` arrays (a
    spatially-varying background -- what the CBD/building solve uses, seeded
    from the regional field's own already mountain-shaped direction) must be
    given, not both. Only *direction* is taken from the background arrays
    (renormalised to a unit vector): magnitude is deliberately re-derived from
    local slope below, the same as the constant-bearing path, because the
    caller (server/field.py) already multiplies the regional and CBD speed
    factors together at request time -- carrying the regional magnitude in
    here too would double-count the mountain's speed-up/slow-down.
    """
    if background_u is not None:
        magnitude = np.hypot(background_u, background_v)
        safe_magnitude = np.where(magnitude > 1e-6, magnitude, 1.0)
        flow_x = np.where(magnitude > 1e-6, background_u / safe_magnitude, 0.0)
        flow_z = np.where(magnitude > 1e-6, background_v / safe_magnitude, 0.0)
    else:
        angle = math.radians(direction_deg)
        flow_x, flow_z = -math.sin(angle), math.cos(angle)

    # Gradient of terrain height in local metres (row axis = z, column axis = x).
    dhdz, dhdx = np.gradient(heights, dz, dx)

    # Slope component along the flow direction: positive means climbing (windward),
    # negative means descending (lee). Scale factor is a mild, bounded heuristic,
    # not a physical law -- it only needs to seed the solver with something more
    # realistic than a flat field before mass-conservation removes divergence.
    along_flow_slope = flow_x * dhdx + flow_z * dhdz
    speed_factor = np.clip(1.0 - 1.5 * along_flow_slope, 0.4, 1.8)

    u0 = flow_x * speed_factor
    v0 = flow_z * speed_factor
    return u0.astype(np.float64), v0.astype(np.float64)


def mass_conserve(
    u0: np.ndarray,
    v0: np.ndarray,
    heights: np.ndarray,
    dx: float,
    dz: float,
    sample_height_m: float = 50.0,
    prominence_window_m: float = 1000.0,
    iterations: int = 500,
    omega: float = 1.0,
    solid_mask: np.ndarray | None = None,
    porous_drag: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Remove divergence from (u0, v0), treating prominent terrain as solid.

    Solves d(phi)/dn via relaxation on the Poisson equation
    grad^2(phi) = div(u0, v0) over free (non-blocked) cells, then returns
    u = u0 - dphi/dx, v = v0 - dphi/dz. A cell is "blocked" (treated as solid,
    zero velocity) when its height exceeds the lowest terrain within
    ``prominence_window_m`` of it by more than ``sample_height_m`` -- i.e. it
    is a real topographic feature (a ridge, foothill, mountain) rather than
    gentle regional undulation. Using the raw elevation above the domain's
    global minimum instead of this local-prominence test would flag most of a
    hilly coastal city as "blocked" purely because it sits above a nearby bay
    or valley floor.

    omega is kept at 1.0 (plain Jacobi): because blocked cells hard-clamp phi
    to zero every iteration, this is effectively a mixed Dirichlet/Poisson
    system, and over-relaxation (omega > 1) was found to diverge numerically
    on real terrain (unbounded phi within ~1300 iterations). Plain Jacobi
    converges cleanly within a few hundred iterations for these grid sizes.
    """
    rows, columns = heights.shape
    window_cells = max(3, int(round(prominence_window_m / min(dx, dz))) | 1)
    local_base = minimum_filter(heights, size=window_cells, mode="nearest")
    blocked = (heights - local_base) > sample_height_m if solid_mask is None else np.asarray(solid_mask, dtype=bool)
    if blocked.shape != heights.shape:
        raise ValueError("solid_mask must have the same shape as heights")

    u0 = np.where(blocked, 0.0, u0)
    v0 = np.where(blocked, 0.0, v0)
    if porous_drag is not None:
        drag = np.clip(np.asarray(porous_drag, dtype=np.float64), 0.0, 0.95)
        if drag.shape != heights.shape:
            raise ValueError("porous_drag must have the same shape as heights")
        u0 *= 1.0 - drag
        v0 *= 1.0 - drag

    divergence = np.zeros_like(u0)
    divergence[:, 1:-1] += (u0[:, 2:] - u0[:, :-2]) / (2 * dx)
    divergence[1:-1, :] += (v0[2:, :] - v0[:-2, :]) / (2 * dz)

    phi = np.zeros_like(u0)
    free = ~blocked
    denom = 2.0 / dx**2 + 2.0 / dz**2

    for _ in range(iterations):
        phi_left = np.roll(phi, 1, axis=1)
        phi_right = np.roll(phi, -1, axis=1)
        phi_up = np.roll(phi, 1, axis=0)
        phi_down = np.roll(phi, -1, axis=0)
        phi_left[:, 0] = phi[:, 0]
        phi_right[:, -1] = phi[:, -1]
        phi_up[0, :] = phi[0, :]
        phi_down[-1, :] = phi[-1, :]

        laplacian_rhs = (phi_left + phi_right) / dx**2 + (phi_up + phi_down) / dz**2 - divergence
        phi_new = laplacian_rhs / denom
        phi = np.where(free, phi + omega * (phi_new - phi), 0.0)

    dphidx = np.zeros_like(phi)
    dphidx[:, 1:-1] = (phi[:, 2:] - phi[:, :-2]) / (2 * dx)
    dphidz = np.zeros_like(phi)
    dphidz[1:-1, :] = (phi[2:, :] - phi[:-2, :]) / (2 * dz)

    u = np.where(blocked, 0.0, u0 - dphidx)
    v = np.where(blocked, 0.0, v0 - dphidz)
    return u, v


def solve_terrain_field(
    heights: np.ndarray,
    dx: float,
    dz: float,
    direction_deg: float | None = None,
    sample_height_m: float = 50.0,
    prominence_window_m: float = 1000.0,
    background_u: np.ndarray | None = None,
    background_v: np.ndarray | None = None,
    solid_mask: np.ndarray | None = None,
    porous_drag: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Full pipeline: terrain-following seed field -> mass-conserving correction.

    See ``initial_field`` for the ``direction_deg`` vs. ``background_u``/
    ``background_v`` choice.
    """
    u0, v0 = initial_field(heights, dx, dz, direction_deg, background_u, background_v)
    return mass_conserve(
        u0, v0, heights, dx, dz, sample_height_m=sample_height_m, prominence_window_m=prominence_window_m,
        solid_mask=solid_mask, porous_drag=porous_drag,
    )


def sample_bilinear(field: np.ndarray, origin_x: float, origin_z: float, dx: float, dz: float, x: float, z: float) -> float:
    """Bilinear sample of a regular grid at world coordinates (x, z)."""
    rows, columns = field.shape
    column_f = (x - origin_x) / dx - 0.5
    row_f = (z - origin_z) / dz - 0.5
    column_f = min(max(column_f, 0.0), columns - 1.001)
    row_f = min(max(row_f, 0.0), rows - 1.001)
    c0, r0 = int(column_f), int(row_f)
    c1, r1 = min(c0 + 1, columns - 1), min(r0 + 1, rows - 1)
    fc, fr = column_f - c0, row_f - r0
    top = field[r0, c0] * (1 - fc) + field[r0, c1] * fc
    bottom = field[r1, c0] * (1 - fc) + field[r1, c1] * fc
    return float(top * (1 - fr) + bottom * fr)


def resample_bilinear_grid(
    field: np.ndarray, origin_x: float, origin_z: float, dx: float, dz: float, target_x: np.ndarray, target_z: np.ndarray
) -> np.ndarray:
    """Vectorized twin of ``sample_bilinear`` for resampling onto a whole target grid at once.

    Used to downscale a coarse precomputed field (e.g. the regional/mountain
    field) onto a finer target grid's coordinates, rather than looping
    ``sample_bilinear`` once per cell.
    """
    rows, columns = field.shape
    column_f = (target_x - origin_x) / dx - 0.5
    row_f = (target_z - origin_z) / dz - 0.5
    column_f = np.clip(column_f, 0.0, columns - 1.001)
    row_f = np.clip(row_f, 0.0, rows - 1.001)
    c0 = column_f.astype(int)
    r0 = row_f.astype(int)
    c1 = np.minimum(c0 + 1, columns - 1)
    r1 = np.minimum(r0 + 1, rows - 1)
    fc = column_f - c0
    fr = row_f - r0
    top = field[r0, c0] * (1 - fc) + field[r0, c1] * fc
    bottom = field[r1, c0] * (1 - fc) + field[r1, c1] * fc
    return top * (1 - fr) + bottom * fr
