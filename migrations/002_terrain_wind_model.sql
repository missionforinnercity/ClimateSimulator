-- Registers the mass-conserving terrain wind model as a new field version.
-- Additive only: wind.ventilation_* polygon tables and the prior proxy version
-- row both remain untouched; the ventilation speed factors are still used as
-- a local micro-scale modulation on top of the terrain-resolved direction.

INSERT INTO wind.field_versions (version, model_kind, validation_status, terrain_version, geometry_version, metadata)
VALUES (
    'terrain-2026-07-23',
    'mass_conserving_terrain',
    'exploratory_not_engineering_grade',
    'regional-srtm-8km-25m',
    'cbd-lidar-current',
    '{"source": "wind.ventilation_* + regional DEM mass-conserving solve", "vector_direction": "terrain_resolved", "note": "Diagnostic WindNinja-style mass-conservation over an 8km regional DEM, precomputed per direction and served cropped/resampled; still not validated CFD."}'::jsonb
)
ON CONFLICT (version) DO UPDATE SET
    model_kind = EXCLUDED.model_kind,
    validation_status = EXCLUDED.validation_status,
    metadata = EXCLUDED.metadata;
