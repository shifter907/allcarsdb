-- =============================================================================
-- 0001_core.sql -- The vehicle identity hierarchy
-- =============================================================================
--
-- Six levels, narrowing from "who built it" to "the exact thing you could buy":
--
--   manufacturer   Volkswagen Group
--     make         Porsche
--       model      911
--         generation  992.2 (2025-)
--           model_year  2026 911, US market
--             trim        GT3 Touring
--               variant     GT3 Touring / coupe / 4.0 flat-6 + 6MT + RWD
--
-- `variant` is the unit of search. Every spec table hangs off it. The split
-- exists because a single trim routinely spans several genuinely different
-- cars: a 911 Carrera is sold as coupe and cabriolet, with PDK or manual, and
-- those have different weights, different EPA numbers, different 0-60 times.
-- Collapsing them into one row is how every other spec site ends up lying.
--
-- Targeting SQLite (Cloudflare D1). Postgres notes are inline where they differ.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Corporate structure
-- -----------------------------------------------------------------------------

CREATE TABLE manufacturer (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  country_code  TEXT,                      -- ISO 3166-1 alpha-2
  founded_year  INTEGER,
  defunct_year  INTEGER,
  parent_id     INTEGER REFERENCES manufacturer(id),
  wikidata_id   TEXT,                      -- e.g. Q246 -- lets us reconcile externally
  notes         TEXT
);

CREATE TABLE make (
  id              INTEGER PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE, -- 'porsche', 'mercedes-benz'
  name            TEXT    NOT NULL,
  manufacturer_id INTEGER REFERENCES manufacturer(id),
  country_code    TEXT,
  founded_year    INTEGER,
  defunct_year    INTEGER,                 -- NULL = still trading
  logo_path       TEXT,
  wikidata_id     TEXT,
  notes           TEXT
);
CREATE INDEX idx_make_manufacturer ON make(manufacturer_id);

CREATE TABLE model (
  id           INTEGER PRIMARY KEY,
  make_id      INTEGER NOT NULL REFERENCES make(id) ON DELETE CASCADE,
  slug         TEXT    NOT NULL,           -- '911', 'f-150', 'model-s'
  name         TEXT    NOT NULL,
  -- Some models are sold under different names in different markets
  -- (Chevrolet Trax / Holden Barina). Aliases are JSON so we do not need
  -- a whole table for a rarely-queried field.
  aliases_json TEXT    NOT NULL DEFAULT '[]',
  first_year   INTEGER,
  last_year    INTEGER,
  wikidata_id  TEXT,
  notes        TEXT,
  UNIQUE (make_id, slug)
);

CREATE TABLE generation (
  id          INTEGER PRIMARY KEY,
  model_id    INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  slug        TEXT    NOT NULL,            -- '992-2', 'mk8', 'w206'
  code        TEXT,                        -- factory code: '992.2', 'W206', 'ND'
  name        TEXT,                        -- '8th generation'
  ordinal     INTEGER,                     -- 1, 2, 3... for sorting
  start_year  INTEGER NOT NULL,
  end_year    INTEGER,                     -- NULL = still in production
  -- A facelift/LCI is stored as its own generation row with facelift_of set,
  -- because facelifts frequently change engines and dimensions.
  facelift_of INTEGER REFERENCES generation(id),
  platform    TEXT,                        -- 'MQB Evo', 'GM BT1', 'TNGA-K'
  designer    TEXT,
  notes       TEXT,
  UNIQUE (model_id, slug)
);
CREATE INDEX idx_generation_model ON generation(model_id);
CREATE INDEX idx_generation_years ON generation(start_year, end_year);

-- -----------------------------------------------------------------------------
-- Model year: a generation as sold in one year, in one market
-- -----------------------------------------------------------------------------
-- Market belongs here rather than on `variant` because the entire lineup
-- differs by market -- Europe gets trims the US never sees, and vice versa.

CREATE TABLE model_year (
  id            INTEGER PRIMARY KEY,
  generation_id INTEGER NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  market_code   INTEGER NOT NULL,          -- enums.Market
  -- Calendar year of first deliveries, when it differs from the model year.
  release_date  TEXT,
  notes         TEXT,
  UNIQUE (generation_id, year, market_code)
);
CREATE INDEX idx_model_year_year ON model_year(year, market_code);

-- -----------------------------------------------------------------------------
-- Trim: the marketing/pricing unit
-- -----------------------------------------------------------------------------

CREATE TABLE trim (
  id            INTEGER PRIMARY KEY,
  model_year_id INTEGER NOT NULL REFERENCES model_year(id) ON DELETE CASCADE,
  slug          TEXT    NOT NULL,          -- 'gt3-touring', 'xlt', 'long-range-awd'
  name          TEXT    NOT NULL,          -- 'GT3 Touring'
  ordinal       INTEGER,                   -- lineup position, low = base
  -- Manufacturer's own trim/order code where one exists.
  oem_code      TEXT,
  -- Limited/special editions: production count and whether it is a sub-trim.
  is_special_edition INTEGER NOT NULL DEFAULT 0 CHECK (is_special_edition IN (0,1)),
  production_count   INTEGER,
  notes         TEXT,
  UNIQUE (model_year_id, slug)
);
CREATE INDEX idx_trim_model_year ON trim(model_year_id);

-- -----------------------------------------------------------------------------
-- Variant: the searchable unit
-- -----------------------------------------------------------------------------
-- One row per distinct buildable combination that has its own specifications.
-- `spec_key` is a deterministic hash of the identity columns, generated by the
-- ETL. It makes rebuilds idempotent and gives us stable permalinks even when
-- integer ids get reassigned by a full reimport.

CREATE TABLE variant (
  id              INTEGER PRIMARY KEY,
  trim_id         INTEGER NOT NULL REFERENCES trim(id) ON DELETE CASCADE,
  spec_key        TEXT    NOT NULL UNIQUE,
  slug            TEXT    NOT NULL,
  name            TEXT,                    -- display suffix: '6MT Coupe'

  body_style_id   INTEGER NOT NULL REFERENCES body_style(id),
  powertrain_id   INTEGER NOT NULL REFERENCES powertrain(id),

  -- Pricing is per variant and per market; stored in minor units (cents) to
  -- avoid float drift, alongside the currency it was quoted in.
  msrp_minor      INTEGER,
  msrp_currency   TEXT DEFAULT 'USD',
  destination_minor INTEGER,
  price_as_of     TEXT,                    -- ISO date the price was captured

  production_start TEXT,
  production_end   TEXT,
  production_count INTEGER,

  -- Rollup of the confidence of this variant's underlying facts. Recomputed
  -- by the ETL; lets the UI filter out placeholder data cheaply.
  confidence_code INTEGER,

  notes           TEXT,
  UNIQUE (trim_id, slug)
);
CREATE INDEX idx_variant_trim ON variant(trim_id);
CREATE INDEX idx_variant_powertrain ON variant(powertrain_id);
CREATE INDEX idx_variant_body ON variant(body_style_id);

-- -----------------------------------------------------------------------------
-- Body styles
-- -----------------------------------------------------------------------------
-- Shared catalog rather than free text, so "2-door hardtop convertible" is
-- one canonical row and not forty spellings.

CREATE TABLE body_style (
  id             INTEGER PRIMARY KEY,
  slug           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  category_code  INTEGER NOT NULL,         -- enums.BodyCategory
  roof_code      INTEGER NOT NULL,         -- enums.RoofType
  doors          INTEGER,                  -- counting the tailgate/hatch
  -- Pickups only.
  cab_code       INTEGER,                  -- enums.CabStyle
  bed_length_in  REAL,
  -- Rows of seats the body can physically accommodate (not the seat count).
  seat_rows      INTEGER,
  notes          TEXT
);
CREATE INDEX idx_body_style_cat ON body_style(category_code, roof_code);
