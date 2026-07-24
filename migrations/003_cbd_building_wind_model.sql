-- Registers a building-resolved CBD wind model as a new field version.
-- Additive only: wind.ventilation_* polygon tables, and both prior version
-- rows, remain untouched. This replaces the externally-imported ventilation
-- polygons as the CBD-scale micro-factor with one derived from this
-- project's own LiDAR building footprints/heights, using the same
-- mass-conserving solver already used for the regional/mountain field.

INSERT INTO wind.field_versions (version, model_kind, validation_status, terrain_version, geometry_version, metadata)
VALUES (
    'terrain-buildings-2026-07-23',
    'mass_conserving_terrain_buildings',
    'exploratory_not_engineering_grade',
    'cbd-lidar-buildings-3m',
    'cbd-lidar-current',
    '{"source": "wind.ventilation_* + regional DEM + CBD building-resolved mass-conserving solve", "vector_direction": "building_resolved", "note": "Diagnostic WindNinja-style mass-conservation over CBD LiDAR buildings at 3m resolution, precomputed per direction from scripts/export_cbd_wind_fields.py and served cropped/resampled; still not validated CFD, and not yet coupled to the regional field (both assume the same raw compass bearing as their background flow)."}'::jsonb
)
ON CONFLICT (version) DO UPDATE SET
    model_kind = EXCLUDED.model_kind,
    validation_status = EXCLUDED.validation_status,
    metadata = EXCLUDED.metadata;
