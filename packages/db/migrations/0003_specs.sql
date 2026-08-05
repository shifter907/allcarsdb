-- =============================================================================
-- 0003_specs.sql -- Measured specifications, one table per domain
-- =============================================================================
--
-- Each of these is 1:1 with `variant`. They are split rather than kept as one
-- 200-column mega-table for three reasons:
--
--   1. Contribution granularity. Someone with a tape measure can fill in
--      interior dimensions without touching anything else, and the PR diff
--      is legible.
--   2. Sparsity. A 1968 Alfa has no efficiency row and no ADAS row. Splitting
--      means absent data costs zero bytes instead of 60 NULL columns.
--   3. Provenance. Sources attach per row, so "EPA supplied the mpg, Car and
--      Driver supplied the 0-60" is representable.
--
-- UNITS: every column carries its unit in the name. No exceptions, ever.
-- Storage is canonical-metric-or-canonical-imperial per domain, matching how
-- the figure is actually published; the API converts on the way out. Storing
-- a bare `length` and hoping is how spec databases end up with 4.5-metre-long
-- cars listed as 4.5 inches.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Exterior dimensions
-- -----------------------------------------------------------------------------

CREATE TABLE spec_exterior (
  variant_id          INTEGER PRIMARY KEY REFERENCES variant(id) ON DELETE CASCADE,

  length_mm           REAL,
  width_mm            REAL,               -- excluding mirrors
  width_mirrors_mm    REAL,
  width_mirrors_folded_mm REAL,
  height_mm           REAL,               -- unladen, at kerb weight
  wheelbase_mm        REAL,
  track_front_mm      REAL,
  track_rear_mm       REAL,
  front_overhang_mm   REAL,
  rear_overhang_mm    REAL,

  ground_clearance_mm REAL,
  -- Air-sprung cars have a range; record both ends.
  ground_clearance_min_mm REAL,
  ground_clearance_max_mm REAL,

  -- Off-road geometry
  approach_angle_deg   REAL,
  departure_angle_deg  REAL,
  breakover_angle_deg  REAL,
  wading_depth_mm      REAL,

  -- Mass
  curb_weight_kg       REAL,
  curb_weight_min_kg   REAL,              -- lightest configuration
  curb_weight_max_kg   REAL,
  gvwr_kg              REAL,
  weight_dist_front_pct REAL,             -- 0-100

  -- Aerodynamics
  drag_coefficient     REAL,
  frontal_area_m2      REAL,
  cda_m2               REAL,              -- Cd x A, the figure that matters
  lift_coefficient_front REAL,
  lift_coefficient_rear  REAL,
  downforce_at_speed_kg  REAL,
  downforce_speed_kph    REAL,

  turning_circle_curb_m  REAL,
  turning_circle_wall_m  REAL,

  notes                TEXT
);

-- -----------------------------------------------------------------------------
-- Interior dimensions
-- -----------------------------------------------------------------------------
-- Note `seat_height_*_mm`: H-point height above ground, i.e. how far you drop
-- into or climb up to the seat. It is the single most requested spec that
-- effectively no public database carries, and it is the reason this table
-- exists in this shape.

CREATE TABLE spec_interior (
  variant_id            INTEGER PRIMARY KEY REFERENCES variant(id) ON DELETE CASCADE,

  seating_capacity      INTEGER,
  seating_capacity_max  INTEGER,          -- with the optional bench
  seat_rows             INTEGER,
  seating_config        TEXT,             -- '2+3+2', '2+2', '3+3'

  headroom_front_mm     REAL,
  headroom_front_sunroof_mm REAL,         -- sunroof steals 25-40mm; it matters
  headroom_second_mm    REAL,
  headroom_third_mm     REAL,

  legroom_front_mm      REAL,
  legroom_second_mm     REAL,
  legroom_third_mm      REAL,

  shoulder_room_front_mm REAL,
  shoulder_room_second_mm REAL,
  shoulder_room_third_mm  REAL,

  hip_room_front_mm     REAL,
  hip_room_second_mm    REAL,
  hip_room_third_mm     REAL,

  -- H-point height above ground: seat height for ingress/egress
  seat_height_front_mm  REAL,
  seat_height_second_mm REAL,
  -- Vertical travel of the driver's seat adjustment
  seat_height_adjust_range_mm REAL,
  step_in_height_mm     REAL,

  -- Volumes, in litres (SAE cu ft is a derived view, not a second column)
  passenger_volume_l    REAL,
  cargo_behind_first_l  REAL,             -- all rows folded
  cargo_behind_second_l REAL,
  cargo_behind_third_l  REAL,             -- i.e. "boot with all seats up" on a 3-row
  cargo_frunk_l         REAL,
  cargo_max_l           REAL,
  cargo_load_length_mm  REAL,
  cargo_load_width_mm   REAL,
  cargo_width_between_arches_mm REAL,
  cargo_load_height_mm  REAL,
  liftover_height_mm    REAL,
  tailgate_opening_width_mm  REAL,
  tailgate_opening_height_mm REAL,

  -- Pickup beds
  bed_length_mm         REAL,
  bed_width_mm          REAL,
  bed_depth_mm          REAL,
  bed_volume_l          REAL,

  notes                 TEXT
);
-- The user-facing "big boot" filter. Indexed because it is a common leading
-- predicate and highly selective at the top end.
CREATE INDEX idx_interior_cargo ON spec_interior(cargo_behind_second_l);
CREATE INDEX idx_interior_seat_height ON spec_interior(seat_height_front_mm);

-- -----------------------------------------------------------------------------
-- Performance
-- -----------------------------------------------------------------------------
-- Split manufacturer claims from independently measured figures. Merging them
-- makes every performance comparison meaningless, since claims are marketing.

CREATE TABLE spec_performance (
  variant_id           INTEGER PRIMARY KEY REFERENCES variant(id) ON DELETE CASCADE,

  zero_to_60_mph_s     REAL,
  zero_to_100_kph_s    REAL,
  zero_to_100_mph_s    REAL,
  zero_to_200_kph_s    REAL,
  -- With a rollout subtracted, as US magazines report it
  zero_to_60_rollout_s REAL,

  quarter_mile_s       REAL,
  quarter_mile_trap_mph REAL,
  eighth_mile_s        REAL,

  top_speed_kph        REAL,
  top_speed_limited    INTEGER CHECK (top_speed_limited IN (0,1)),
  top_speed_unlimited_kph REAL,           -- with the limiter removed

  braking_60_0_ft      REAL,
  braking_70_0_ft      REAL,
  braking_100_0_kph_m  REAL,

  lateral_g            REAL,
  slalom_mph           REAL,
  figure_eight_s       REAL,

  nurburgring_s        REAL,
  nurburgring_date     TEXT,
  nurburgring_layout   TEXT,              -- '20.6km' vs '20.832km' -- not comparable

  -- 0 = manufacturer claim, 1 = independently instrumented
  is_measured          INTEGER CHECK (is_measured IN (0,1)),
  measured_by          TEXT,
  notes                TEXT
);
CREATE INDEX idx_perf_accel ON spec_performance(zero_to_60_mph_s);

-- -----------------------------------------------------------------------------
-- Efficiency, range and charging
-- -----------------------------------------------------------------------------
-- One row per (variant, test cycle). EPA and WLTP figures for the same car
-- differ by 15-25%, so they must never share a column.

CREATE TABLE spec_efficiency (
  id                   INTEGER PRIMARY KEY,
  variant_id           INTEGER NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
  cycle_code           INTEGER NOT NULL,  -- enums.TestCycle

  mpg_city             REAL,              -- US mpg
  mpg_highway          REAL,
  mpg_combined         REAL,
  l_per_100km_city     REAL,
  l_per_100km_highway  REAL,
  l_per_100km_combined REAL,

  mpge_city            REAL,
  mpge_highway         REAL,
  mpge_combined        REAL,
  kwh_per_100mi        REAL,
  kwh_per_100km        REAL,

  electric_range_mi    REAL,              -- PHEV/BEV
  total_range_mi       REAL,
  fuel_tank_l          REAL,

  co2_g_per_km         REAL,
  emissions_standard   TEXT,              -- 'Euro 6d', 'Tier 3 Bin 30', 'LEV III SULEV30'

  -- Charging
  dc_charge_10_80_min  REAL,
  dc_peak_kw           REAL,
  ac_charge_0_100_h    REAL,
  ac_onboard_kw        REAL,
  charge_port          TEXT,              -- 'NACS', 'CCS1', 'CCS2', 'CHAdeMO'
  v2l_kw               REAL,              -- vehicle-to-load output
  v2h_capable          INTEGER CHECK (v2h_capable IN (0,1)),

  notes                TEXT,
  UNIQUE (variant_id, cycle_code)
);
CREATE INDEX idx_efficiency_variant ON spec_efficiency(variant_id);

-- -----------------------------------------------------------------------------
-- Towing and payload
-- -----------------------------------------------------------------------------

CREATE TABLE spec_capacity (
  variant_id             INTEGER PRIMARY KEY REFERENCES variant(id) ON DELETE CASCADE,
  payload_kg             REAL,
  towing_braked_kg       REAL,
  towing_unbraked_kg     REAL,
  towing_max_kg          REAL,            -- with every tow package fitted
  tongue_weight_kg       REAL,
  gcwr_kg                REAL,
  gawr_front_kg          REAL,
  gawr_rear_kg           REAL,
  roof_load_kg           REAL,
  hitch_receiver_in      REAL,            -- 1.25, 2, 2.5
  fifth_wheel_capable    INTEGER CHECK (fifth_wheel_capable IN (0,1)),
  notes                  TEXT
);
CREATE INDEX idx_capacity_towing ON spec_capacity(towing_max_kg);

-- -----------------------------------------------------------------------------
-- Chassis: suspension, steering, brakes, wheels, tyres
-- -----------------------------------------------------------------------------

CREATE TABLE spec_chassis (
  variant_id            INTEGER PRIMARY KEY REFERENCES variant(id) ON DELETE CASCADE,

  suspension_front_code INTEGER,          -- enums.SuspensionType
  suspension_rear_code  INTEGER,
  spring_type_front     TEXT,             -- 'coil', 'air', 'leaf', 'torsion bar'
  spring_type_rear      TEXT,
  adaptive_dampers      INTEGER CHECK (adaptive_dampers IN (0,1)),
  damper_brand          TEXT,             -- 'Bilstein', 'Ohlins', 'Magneride'
  active_anti_roll      INTEGER CHECK (active_anti_roll IN (0,1)),
  ride_height_adjustable INTEGER CHECK (ride_height_adjustable IN (0,1)),

  steering_type_code    INTEGER,          -- enums.SteeringType
  steering_ratio        REAL,
  turns_lock_to_lock    REAL,
  rear_wheel_steering   INTEGER CHECK (rear_wheel_steering IN (0,1)),
  rear_steer_angle_deg  REAL,

  brake_front_code      INTEGER,          -- enums.BrakeType
  brake_rear_code       INTEGER,
  brake_front_dia_mm    REAL,
  brake_rear_dia_mm     REAL,
  brake_front_pistons   INTEGER,
  brake_rear_pistons    INTEGER,
  brake_caliper_brand   TEXT,             -- 'Brembo', 'AP Racing', 'Akebono'
  brake_by_wire         INTEGER CHECK (brake_by_wire IN (0,1)),

  wheel_front_dia_in    REAL,
  wheel_front_width_in  REAL,
  wheel_rear_dia_in     REAL,
  wheel_rear_width_in   REAL,
  wheel_material        TEXT,             -- 'cast aluminium', 'forged', 'carbon fibre'
  tire_front            TEXT,             -- '245/35ZR20'
  tire_rear             TEXT,
  tire_brand_oem        TEXT,
  staggered             INTEGER CHECK (staggered IN (0,1)),
  spare_type            TEXT,             -- 'full-size', 'compact', 'inflator kit', 'none'

  chassis_construction  TEXT,             -- 'unibody', 'body-on-frame', 'monocoque + subframes'
  body_material         TEXT,             -- 'steel', 'aluminium', 'CFRP', 'mixed'
  notes                 TEXT
);

-- -----------------------------------------------------------------------------
-- Safety ratings
-- -----------------------------------------------------------------------------

CREATE TABLE spec_safety (
  id                 INTEGER PRIMARY KEY,
  variant_id         INTEGER NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
  program            TEXT NOT NULL,       -- 'IIHS', 'NHTSA', 'Euro NCAP', 'ANCAP'
  program_year       INTEGER,
  overall_rating     TEXT,                -- '5 star', 'Top Safety Pick+'
  adult_occupant_pct REAL,
  child_occupant_pct REAL,
  vulnerable_road_pct REAL,
  assist_pct         REAL,
  detail_json        TEXT,                -- per-test breakdown
  source_url         TEXT,
  UNIQUE (variant_id, program, program_year)
);
CREATE INDEX idx_safety_variant ON spec_safety(variant_id);
