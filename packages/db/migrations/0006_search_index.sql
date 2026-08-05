-- =============================================================================
-- 0006_search_index.sql -- The denormalized query surface
-- =============================================================================
--
-- THE PROBLEM
-- A query like "hybrid + AWD + >=65 cu ft cargo + 28 in seat height + massage
-- seat option" touches six tables. Normalized, that is a five-way join over
-- millions of rows with no single selective predicate, and SQLite will use
-- exactly one index and filter the rest.
--
-- THE SHAPE OF THE FIX
-- `variant_search` is a flat, integer-only projection of every commonly
-- filtered attribute. Three properties make it fast:
--
--   1. NO TEXT. Enums are the stable numeric codes from packages/schema.
--      Integer comparison beats collated string comparison, and more
--      importantly the row stays small, so more rows fit per page and a
--      scan reads far fewer pages.
--
--   2. A FEATURE BITMASK. The 128 most-requested boolean features are packed
--      into two 64-bit integers. "Has massage seats AND has a tow package"
--      becomes `(feat_lo & ?) = ?` -- evaluated during the same scan, with
--      no join at all. Rarer features still go through `variant_feature`,
--      whose covering index makes them cheap too.
--
--   3. IT IS DISPOSABLE. Every row is derived. It is dropped and rebuilt by
--      the ETL, so it can be reshaped whenever query patterns change without
--      any migration of real data.
--
-- Display strings live in `variant_display`, joined only for the ~50 rows on
-- the page the user is actually looking at.
-- =============================================================================

DROP TABLE IF EXISTS variant_search;

CREATE TABLE variant_search (
  variant_id        INTEGER PRIMARY KEY,   -- = variant.id, no FK: rebuilt wholesale

  -- --- Identity ------------------------------------------------------------
  make_id           INTEGER NOT NULL,
  model_id          INTEGER NOT NULL,
  generation_id     INTEGER NOT NULL,
  trim_id           INTEGER NOT NULL,
  year              INTEGER NOT NULL,
  market_code       INTEGER NOT NULL,

  -- --- Body ----------------------------------------------------------------
  body_category_code INTEGER,
  roof_code          INTEGER,
  cab_code           INTEGER,
  doors              INTEGER,
  seat_rows          INTEGER,
  seating_capacity   INTEGER,
  seating_capacity_max INTEGER,

  -- --- Engine --------------------------------------------------------------
  engine_id          INTEGER,
  cylinders          INTEGER,
  engine_layout_code INTEGER,
  displacement_cc    INTEGER,
  valves_total       INTEGER,
  valves_per_cylinder INTEGER,
  cam_config_code    INTEGER,
  aspiration_code    INTEGER,
  fuel_type_code     INTEGER,
  fuel_delivery_code INTEGER,
  compression_ratio  REAL,
  redline_rpm        INTEGER,

  -- --- Electrification -----------------------------------------------------
  hybrid_type_code   INTEGER,
  motor_count        INTEGER,
  battery_net_kwh    REAL,
  battery_architecture_volts INTEGER,

  -- --- Transmission & driveline -------------------------------------------
  transmission_type_code INTEGER,
  forward_gears      INTEGER,
  drivetrain_type_code INTEGER,
  has_low_range      INTEGER,
  rear_locker        INTEGER,

  -- --- Output --------------------------------------------------------------
  combined_hp        REAL,
  combined_torque_lbft REAL,
  power_peak_rpm     INTEGER,
  -- Derived at build time so "most power per litre" is a plain ORDER BY.
  hp_per_liter       REAL,
  hp_per_tonne       REAL,

  -- --- Exterior ------------------------------------------------------------
  length_mm          REAL,
  width_mm           REAL,
  height_mm          REAL,
  wheelbase_mm       REAL,
  ground_clearance_mm REAL,
  curb_weight_kg     REAL,
  drag_coefficient   REAL,
  approach_angle_deg REAL,
  departure_angle_deg REAL,

  -- --- Interior ------------------------------------------------------------
  seat_height_front_mm REAL,
  headroom_front_mm  REAL,
  legroom_front_mm   REAL,
  legroom_second_mm  REAL,
  legroom_third_mm   REAL,
  passenger_volume_l REAL,
  cargo_behind_first_l  REAL,
  cargo_behind_second_l REAL,
  cargo_behind_third_l  REAL,
  cargo_frunk_l      REAL,

  -- --- Performance ---------------------------------------------------------
  zero_to_60_mph_s   REAL,
  quarter_mile_s     REAL,
  top_speed_kph      REAL,
  braking_60_0_ft    REAL,
  lateral_g          REAL,

  -- --- Efficiency (EPA figures specifically; other cycles stay in
  -- --- spec_efficiency and are queried by joining) -------------------------
  mpg_combined       REAL,
  mpge_combined      REAL,
  electric_range_mi  REAL,
  total_range_mi     REAL,

  -- --- Capacity ------------------------------------------------------------
  towing_max_kg      REAL,
  payload_kg         REAL,

  -- --- Commercial ----------------------------------------------------------
  msrp_minor         INTEGER,
  msrp_currency      TEXT,

  -- --- Feature bitmask -----------------------------------------------------
  -- Bit n of feat_lo  = feature with common_bit n      (0-63)
  -- Bit n of feat_hi  = feature with common_bit n + 64 (64-127)
  -- Availability is folded in as "available at all" (standard/optional/package).
  -- A second pair tracks standard-only, so "AWD as standard" is expressible.
  feat_lo            INTEGER NOT NULL DEFAULT 0,
  feat_hi            INTEGER NOT NULL DEFAULT 0,
  feat_std_lo        INTEGER NOT NULL DEFAULT 0,
  feat_std_hi        INTEGER NOT NULL DEFAULT 0,

  -- --- Quality -------------------------------------------------------------
  confidence_code    INTEGER,
  -- 0-100: how much of the schema this variant actually fills in. Powers the
  -- "hide sparse entries" toggle and the contribution leaderboard.
  completeness       INTEGER NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
-- Chosen for the predicates that most often appear FIRST and are most
-- selective. SQLite picks one index per table per query, so the goal is not
-- to cover every combination -- it is to make sure the common leading filter
-- collapses the candidate set before the scan does the rest.

CREATE INDEX idx_vs_make_model_year ON variant_search(make_id, model_id, year);
CREATE INDEX idx_vs_year            ON variant_search(year, body_category_code);
CREATE INDEX idx_vs_body            ON variant_search(body_category_code, roof_code, year);

-- Powertrain shape: the "flat-6, NA, 24v" class of query.
CREATE INDEX idx_vs_engine_shape    ON variant_search(engine_layout_code, cylinders, aspiration_code);
CREATE INDEX idx_vs_hybrid          ON variant_search(hybrid_type_code, drivetrain_type_code);
CREATE INDEX idx_vs_drivetrain      ON variant_search(drivetrain_type_code, body_category_code);

-- Numeric ranges people sort and filter by most.
CREATE INDEX idx_vs_hp              ON variant_search(combined_hp);
CREATE INDEX idx_vs_accel           ON variant_search(zero_to_60_mph_s);
CREATE INDEX idx_vs_cargo2          ON variant_search(cargo_behind_second_l);
CREATE INDEX idx_vs_seat_height     ON variant_search(seat_height_front_mm);
CREATE INDEX idx_vs_towing          ON variant_search(towing_max_kg);
CREATE INDEX idx_vs_price           ON variant_search(msrp_minor);
CREATE INDEX idx_vs_range           ON variant_search(total_range_mi);

-- Partial index: BEV/PHEV-only queries skip the ~95% of rows that are neither.
CREATE INDEX idx_vs_electric ON variant_search(electric_range_mi, battery_net_kwh)
  WHERE hybrid_type_code IN (805, 806, 807, 808);

-- Partial index: performance queries typically want quick cars only.
CREATE INDEX idx_vs_quick ON variant_search(zero_to_60_mph_s, combined_hp)
  WHERE zero_to_60_mph_s IS NOT NULL AND zero_to_60_mph_s < 6.0;

-- -----------------------------------------------------------------------------
-- Display projection
-- -----------------------------------------------------------------------------
-- Joined only for the rows on screen. Keeping these strings out of
-- variant_search is what keeps the scan table narrow.

DROP TABLE IF EXISTS variant_display;

CREATE TABLE variant_display (
  variant_id     INTEGER PRIMARY KEY,
  make_name      TEXT NOT NULL,
  make_slug      TEXT NOT NULL,
  model_name     TEXT NOT NULL,
  model_slug     TEXT NOT NULL,
  generation_code TEXT,
  year           INTEGER NOT NULL,
  trim_name      TEXT,
  variant_name   TEXT,
  -- '2026 Porsche 911 GT3 Touring 4.0 6MT'
  full_name      TEXT NOT NULL,
  body_name      TEXT,
  engine_summary TEXT,                    -- '4.0L NA flat-6, 24v DOHC'
  drivetrain_summary TEXT,                -- '6-speed manual, RWD'
  url_path       TEXT NOT NULL,           -- '/porsche/911/2026/gt3-touring/40-6mt'
  spec_key       TEXT NOT NULL
);
CREATE INDEX idx_vd_url ON variant_display(url_path);

-- -----------------------------------------------------------------------------
-- Full-text search over names
-- -----------------------------------------------------------------------------
-- Powers the "type a car name" box, which is a different problem from faceted
-- filtering and deserves a different structure. External-content FTS5 keeps
-- one copy of the text.

DROP TABLE IF EXISTS variant_fts;

CREATE VIRTUAL TABLE variant_fts USING fts5(
  full_name,
  make_name,
  model_name,
  trim_name,
  engine_summary,
  content = 'variant_display',
  content_rowid = 'variant_id',
  tokenize = "unicode61 remove_diacritics 2"
);

-- -----------------------------------------------------------------------------
-- Facet count cache
-- -----------------------------------------------------------------------------
-- The unfiltered counts shown before a user narrows anything. Computing these
-- per request is wasteful when the answer only changes at build time.

DROP TABLE IF EXISTS facet_count;

CREATE TABLE facet_count (
  facet      TEXT    NOT NULL,            -- 'body_category_code'
  value_code INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (facet, value_code)
);
