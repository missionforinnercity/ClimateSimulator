import numpy as np

from scripts.convert_openfoam_vtk import foam_velocity_to_viewer, robust_range


def test_foam_velocity_rotates_horizontal_components_and_preserves_vertical():
    velocity = np.array([[10.0, 2.0, -0.5]], dtype=np.float32)
    converted = foam_velocity_to_viewer(
        velocity,
        np.array([-0.70710678, -0.70710678]),
        np.array([0.70710678, -0.70710678]),
    )
    assert np.allclose(converted[0], [-5.656854, -0.5, -8.485281])


def test_robust_range_ignores_invalid_and_non_finite_values():
    values = np.array([1.0, 2.0, 3.0, 999.0, np.nan])
    mask = np.array([True, True, True, False, True])
    assert np.allclose(robust_range(values, mask, 0, 100), [1.0, 3.0])
