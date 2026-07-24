-- Metadata and tile storage for replacing the directional proxy with
-- validated precomputed u/v fields. This migration is intentionally additive:
-- the existing wind.ventilation_* polygon tables remain untouched.

CREATE SCHEMA IF NOT EXISTS wind;

CREATE TABLE IF NOT EXISTS wind.field_versions (
    version text PRIMARY KEY,
    model_kind text NOT NULL,
    validation_status text NOT NULL,
    terrain_version text,
    geometry_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS wind.field_tiles (
    version text NOT NULL REFERENCES wind.field_versions(version),
    direction_deg double precision NOT NULL,
    season text NOT NULL,
    height_m double precision NOT NULL,
    resolution_m double precision NOT NULL,
    tile_x integer NOT NULL,
    tile_y integer NOT NULL,
    origin_x double precision NOT NULL,
    origin_z double precision NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    dx double precision NOT NULL,
    dz double precision NOT NULL,
    u_mps bytea NOT NULL,
    v_mps bytea NOT NULL,
    speed_mps bytea NOT NULL,
    PRIMARY KEY (version, direction_deg, season, height_m, resolution_m, tile_x, tile_y)
);

CREATE INDEX IF NOT EXISTS field_tiles_lookup_idx
    ON wind.field_tiles (direction_deg, season, height_m, resolution_m);

INSERT INTO wind.field_versions (version, model_kind, validation_status, terrain_version, geometry_version, metadata)
VALUES (
    'proxy-2026-07-22',
    'directional_speed_proxy',
    'exploratory_not_engineering_grade',
    'wide-dem-current',
    'cbd-lidar-current',
    '{"source": "wind.ventilation_*", "vector_direction": "constant_inflow", "note": "Replace with validated precomputed u/v fields before engineering use"}'::jsonb
)
ON CONFLICT (version) DO UPDATE SET
    model_kind = EXCLUDED.model_kind,
    validation_status = EXCLUDED.validation_status,
    metadata = EXCLUDED.metadata;
