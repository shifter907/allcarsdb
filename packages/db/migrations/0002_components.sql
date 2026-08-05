-- =============================================================================
-- 0002_components.sql -- Powertrain component catalogs
-- =============================================================================
--
-- Engines, motors, batteries, transmissions and axles are shared hardware.
-- The GM LS3 went into a Corvette, a Camaro, a Vauxhall VXR8 and a Caterham.
-- Modelling them as reusable catalog rows means:
--
--   * "show me every car that used the 2JZ-GTE" is a one-join query
--   * fixing a bore/stroke typo fixes it everywhere at once
--   * contributors add a variant by *referencing* an engine, not retyping it
--
-- Tuning-dependent outputs (hp, torque) deliberately live on `powertrain`,
-- not on `engine` -- the same physical LS3 makes 430 hp in a C6 and 436 with
-- the dual-mode exhaust. Bore, stroke and valve count go on the engine because
-- they are properties of the casting.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Combustion engines
-- -----------------------------------------------------------------------------

CREATE TABLE engine (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT    NOT NULL UNIQUE,   -- 'gm-ls3-6200', 'porsche-9a2-evo-4-0'
  code               TEXT,                      -- factory code: 'LS3', '2JZ-GTE', 'M177'
  name               TEXT    NOT NULL,
  family             TEXT,                      -- 'GM Gen IV Small Block', 'Toyota JZ'
  manufacturer_id    INTEGER REFERENCES manufacturer(id),

  -- --- Architecture ----------------------------------------------------------
  cylinders          INTEGER,                   -- rotors, for a Wankel
  layout_code        INTEGER NOT NULL,          -- enums.EngineLayout
  vee_angle_deg      REAL,                      -- 60, 90, 15 (VR6)...
  displacement_cc    INTEGER,
  -- Rotary engines quote chamber volume; store it here and set displacement_cc
  -- to the nominal figure used for taxation so numeric filters stay sane.
  chamber_volume_cc  INTEGER,

  valves_per_cylinder INTEGER,
  valves_total        INTEGER,                  -- ETL derives this when omitted
  cam_config_code     INTEGER,                  -- enums.CamConfig
  cam_count           INTEGER,

  bore_mm            REAL,
  stroke_mm          REAL,
  compression_ratio  REAL,                      -- 11.5 means 11.5:1
  -- For variable-compression engines (Nissan VC-Turbo) record the range.
  compression_ratio_max REAL,

  aspiration_code    INTEGER NOT NULL,          -- enums.Aspiration
  forced_induction_count INTEGER DEFAULT 0,     -- number of turbos/blowers
  intercooled        INTEGER CHECK (intercooled IN (0,1)),
  charge_cooling     TEXT,                      -- 'air-to-air', 'air-to-water'
  max_boost_psi      REAL,

  fuel_type_code     INTEGER NOT NULL,          -- enums.FuelType
  fuel_delivery_code INTEGER,                   -- enums.FuelDelivery
  min_octane_ron     INTEGER,

  block_material     TEXT,                      -- 'aluminium', 'cast iron', 'CGI'
  head_material      TEXT,
  liner_type         TEXT,                      -- 'nikasil', 'alusil', 'iron sleeve'

  redline_rpm        INTEGER,
  fuel_cutoff_rpm    INTEGER,
  idle_rpm           INTEGER,
  firing_order       TEXT,

  dry_weight_kg      REAL,
  oil_capacity_l     REAL,
  coolant_capacity_l REAL,

  -- --- Notable technologies (booleans kept here, not in the feature table,
  -- --- because they are properties of the engine rather than of a car) ------
  variable_valve_timing  INTEGER CHECK (variable_valve_timing IN (0,1)),
  variable_valve_lift    INTEGER CHECK (variable_valve_lift IN (0,1)),
  cylinder_deactivation  INTEGER CHECK (cylinder_deactivation IN (0,1)),
  dry_sump               INTEGER CHECK (dry_sump IN (0,1)),
  start_stop             INTEGER CHECK (start_stop IN (0,1)),
  individual_throttle_bodies INTEGER CHECK (individual_throttle_bodies IN (0,1)),

  production_start_year INTEGER,
  production_end_year   INTEGER,
  notes              TEXT
);
CREATE INDEX idx_engine_arch  ON engine(layout_code, cylinders, aspiration_code);
CREATE INDEX idx_engine_disp  ON engine(displacement_cc);
CREATE INDEX idx_engine_code  ON engine(code);
CREATE INDEX idx_engine_valves ON engine(valves_total);

-- -----------------------------------------------------------------------------
-- Electric drive
-- -----------------------------------------------------------------------------

CREATE TABLE electric_motor (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,
  code          TEXT,
  name          TEXT    NOT NULL,
  manufacturer_id INTEGER REFERENCES manufacturer(id),
  motor_type_code INTEGER,                  -- enums.MotorType
  peak_power_kw   REAL,
  continuous_power_kw REAL,
  peak_torque_nm  REAL,
  max_rpm         INTEGER,
  voltage_nominal INTEGER,
  cooling         TEXT,                     -- 'liquid', 'oil', 'air'
  weight_kg       REAL,
  notes           TEXT
);

CREATE TABLE battery_pack (
  id                   INTEGER PRIMARY KEY,
  slug                 TEXT    NOT NULL UNIQUE,
  name                 TEXT,
  chemistry_code       INTEGER,             -- enums.BatteryChemistry
  cell_supplier        TEXT,
  cell_format          TEXT,                -- 'pouch', '2170', '4680', 'prismatic'
  -- Gross vs net (usable) matters enormously for efficiency comparisons.
  capacity_gross_kwh   REAL,
  capacity_net_kwh     REAL,
  nominal_voltage      REAL,
  architecture_volts   INTEGER,             -- 400 or 800
  module_count         INTEGER,
  cell_count           INTEGER,
  weight_kg            REAL,
  max_dc_charge_kw     REAL,
  max_ac_charge_kw     REAL,
  thermal_management   TEXT,                -- 'liquid', 'air', 'passive'
  warranty_years       INTEGER,
  warranty_miles       INTEGER,
  notes                TEXT
);

-- -----------------------------------------------------------------------------
-- Transmission
-- -----------------------------------------------------------------------------

CREATE TABLE transmission (
  id              INTEGER PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE,
  code            TEXT,                     -- 'ZF 8HP70', 'PDK ML2', 'T-56'
  name            TEXT    NOT NULL,
  manufacturer_id INTEGER REFERENCES manufacturer(id),
  type_code       INTEGER NOT NULL,         -- enums.TransmissionType
  forward_gears   INTEGER,
  reverse_gears   INTEGER DEFAULT 1,
  clutch_type     TEXT,                     -- 'single dry', 'twin wet', 'torque converter'
  paddle_shifters INTEGER CHECK (paddle_shifters IN (0,1)),
  -- Individual gear ratios as a JSON array, e.g. [3.91,2.29,1.55,1.15,0.94,0.79]
  -- Rarely filtered on, frequently displayed -- JSON is the right trade here.
  gear_ratios_json TEXT,
  final_drive_ratio REAL,
  max_torque_nm   REAL,                     -- rated capacity
  weight_kg       REAL,
  notes           TEXT
);
CREATE INDEX idx_transmission_type ON transmission(type_code, forward_gears);

-- -----------------------------------------------------------------------------
-- Driveline
-- -----------------------------------------------------------------------------

CREATE TABLE drivetrain (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT    NOT NULL UNIQUE,
  name                TEXT    NOT NULL,     -- 'quattro w/ sport differential'
  type_code           INTEGER NOT NULL,     -- enums.DrivetrainType
  marketing_name      TEXT,                 -- 'xDrive', '4MATIC+', 'SH-AWD'

  transfer_case       TEXT,
  has_low_range       INTEGER CHECK (has_low_range IN (0,1)),
  low_range_ratio     REAL,

  front_diff_type     TEXT,                 -- 'open', 'LSD clutch', 'e-locker', 'Torsen'
  center_diff_type    TEXT,
  rear_diff_type      TEXT,
  front_locker        INTEGER CHECK (front_locker IN (0,1)),
  rear_locker         INTEGER CHECK (rear_locker IN (0,1)),

  -- Nominal front torque share, 0-100. 0 = pure RWD, 100 = pure FWD.
  default_front_torque_pct REAL,
  max_front_torque_pct     REAL,
  max_rear_torque_pct      REAL,
  torque_vectoring    INTEGER CHECK (torque_vectoring IN (0,1)),
  disconnect_capable  INTEGER CHECK (disconnect_capable IN (0,1)),
  notes               TEXT
);
CREATE INDEX idx_drivetrain_type ON drivetrain(type_code);

-- -----------------------------------------------------------------------------
-- Powertrain: the assembled combination
-- -----------------------------------------------------------------------------
-- This is where outputs live, because output is a property of a specific
-- calibration in a specific car, not of the bare engine.

CREATE TABLE powertrain (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT    NOT NULL UNIQUE,
  name               TEXT,

  engine_id          INTEGER REFERENCES engine(id),        -- NULL for a BEV
  engine_count       INTEGER DEFAULT 1,
  transmission_id    INTEGER REFERENCES transmission(id),
  drivetrain_id      INTEGER NOT NULL REFERENCES drivetrain(id),
  placement_code     INTEGER,                              -- enums.EnginePlacement

  hybrid_type_code   INTEGER NOT NULL,                     -- enums.HybridType

  front_motor_id     INTEGER REFERENCES electric_motor(id),
  front_motor_count  INTEGER DEFAULT 0,
  rear_motor_id      INTEGER REFERENCES electric_motor(id),
  rear_motor_count   INTEGER DEFAULT 0,
  battery_pack_id    INTEGER REFERENCES battery_pack(id),

  -- --- Outputs ---------------------------------------------------------------
  -- "combined" is the manufacturer's system figure, which for hybrids is NOT
  -- engine_hp + electric_hp (peaks occur at different rpm). Store all three.
  combined_hp            REAL,
  combined_torque_lbft   REAL,
  combined_power_kw      REAL,
  combined_torque_nm     REAL,
  engine_hp              REAL,
  engine_torque_lbft     REAL,
  electric_hp            REAL,
  electric_torque_lbft   REAL,

  power_peak_rpm         INTEGER,
  power_peak_rpm_high    INTEGER,           -- for a plateau: "480 hp @ 5500-6500"
  torque_peak_rpm        INTEGER,
  torque_peak_rpm_high   INTEGER,

  power_standard_code    INTEGER,           -- enums.PowerStandard -- SAE net vs DIN vs gross
  notes                  TEXT
);
CREATE INDEX idx_powertrain_engine ON powertrain(engine_id);
CREATE INDEX idx_powertrain_hybrid ON powertrain(hybrid_type_code);
CREATE INDEX idx_powertrain_hp     ON powertrain(combined_hp);
