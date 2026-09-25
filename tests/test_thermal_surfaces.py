import numpy as np
import pytest

from scripts.build_thermal_surfaces import LAND_COVER, solweig_ground_cover


def test_project_ground_classes_match_solweig_material_classes():
    project = np.array([[LAND_COVER[name] for name in
                        ('paved', 'building', 'grass', 'water', 'bare_soil', 'nodata')]], dtype=np.uint8)
    assert solweig_ground_cover(project).tolist() == [[1, 2, 5, 7, 6, 255]]


def test_canopy_is_not_mistaken_for_its_underlying_ground():
    canopy_code = LAND_COVER['tree']
    with pytest.raises(ValueError, match='ground cover beneath trees'):
        solweig_ground_cover(np.array([[canopy_code]], dtype=np.uint8))
