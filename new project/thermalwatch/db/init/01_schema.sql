-- ThermalWatch schema (PostgreSQL 16 + PostGIS 3.4)
-- Applied automatically by the postgis Docker image on first start,
-- or manually with: python -m thermalwatch.cli init-db

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------
-- 1. Raw thermal detections (one row per satellite pixel detection)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS detections (
    id            BIGSERIAL PRIMARY KEY,
    source        TEXT NOT NULL,               -- VIIRS_NOAA20_NRT, MODIS_NRT, DEMO_SYNTHETIC ...
    instrument    TEXT,                        -- VIIRS | MODIS
    satellite     TEXT,
    acq_time      TIMESTAMPTZ NOT NULL,        -- UTC
    lat           DOUBLE PRECISION NOT NULL,
    lon           DOUBLE PRECISION NOT NULL,
    geom          geometry(Point, 4326)
                  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED,
    bright_mir    REAL,                        -- VIIRS bright_ti4 / MODIS brightness (K)
    bright_tir    REAL,                        -- VIIRS bright_ti5 / MODIS bright_t31 (K)
    frp           REAL,                        -- fire radiative power (MW)
    scan          REAL,
    track         REAL,
    confidence    TEXT,                        -- VIIRS l/n/h, MODIS 0-100 as text
    daynight      CHAR(1),
    cell_x        INTEGER NOT NULL,            -- persistence grid cell (see features/persistence.py)
    cell_y        INTEGER NOT NULL,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, acq_time, lat, lon)
);
CREATE INDEX IF NOT EXISTS detections_geom_idx ON detections USING GIST (geom);
CREATE INDEX IF NOT EXISTS detections_time_idx ON detections (acq_time);
CREATE INDEX IF NOT EXISTS detections_cell_idx ON detections (cell_x, cell_y, acq_time);

-- ---------------------------------------------------------------
-- 2. Industrial infrastructure reference (OSM + GEM + WRI merged)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS infrastructure (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT,
    infra_type   TEXT NOT NULL,   -- refinery | steel | power_plant | industrial_zone | mine | brick_kiln | flare | cement | other_industrial
    operator     TEXT,
    status       TEXT,
    capacity     TEXT,
    source       TEXT NOT NULL,   -- OSM | GEM | WRI_GPPD | DEMO_SYNTHETIC
    source_ref   TEXT NOT NULL,   -- id within the source (e.g. way/123)
    geom         geometry(Geometry, 4326) NOT NULL,
    loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS infrastructure_geom_idx ON infrastructure USING GIST (geom);

-- ---------------------------------------------------------------
-- 3. Classified events (the product: one row per classified detection)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    detection_id          BIGINT PRIMARY KEY REFERENCES detections(id) ON DELETE CASCADE,
    predicted_class       TEXT NOT NULL,
    confidence            REAL NOT NULL,
    method                TEXT NOT NULL,         -- rules | xgboost
    model_version         TEXT,
    class_scores          JSONB NOT NULL,
    evidence              JSONB NOT NULL,        -- list of human-readable strings
    persistence_class     TEXT NOT NULL,         -- temporary | recurring | persistent
    land_cover            TEXT,
    nearest_infra_id      BIGINT REFERENCES infrastructure(id) ON DELETE SET NULL,
    nearest_infra_dist_m  REAL,
    needs_verification    BOOLEAN NOT NULL DEFAULT FALSE,
    features              JSONB NOT NULL,        -- full feature vector, for audit + retraining
    classified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_class_idx ON events (predicted_class);

-- ---------------------------------------------------------------
-- 4. Labels (ground truth). Analyst verifications build the gold set.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labels (
    id            BIGSERIAL PRIMARY KEY,
    detection_id  BIGINT NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
    label         TEXT NOT NULL,
    label_source  TEXT NOT NULL,   -- analyst | synthetic_truth
    analyst       TEXT,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS labels_detection_idx ON labels (detection_id);
