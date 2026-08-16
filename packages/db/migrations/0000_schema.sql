-- AllCarsDB schema.
--
-- Source-of-truth tables are authored as CSV under data/ and loaded by
-- packages/etl. Column names are kept verbatim as specified for this project,
-- including `Index` -- which is a SQL keyword, so every reference to it has to
-- be quoted (`"Index"` or backticks). SQLite is case-insensitive about
-- identifiers, so `Compression_ratio` and `compression_RATIO` address the same
-- column; the casing here is the canonical spelling used in the CSV headers
-- and the JSON the API returns.
--
-- `Index` is declared INTEGER PRIMARY KEY, which in SQLite aliases the internal
-- rowid: values are assigned automatically and are unique. They never appear in
-- the source CSVs. Contributors reference rows by natural key -- (Make, Model,
-- Year) for a vehicle and a short Ref for everything else -- and the loader
-- resolves those to indices at build time.
--
-- Because indices are assigned rather than authored, they are stable for a
-- given dataset but NOT guaranteed to survive data being added: inserting an
-- engine renumbers the ones sorted after it. Anything that needs to outlive a
-- rebuild (links, citations) should key on the natural key, not on an index.
--
-- ---------------------------------------------------------------------------
-- THE ORGANISING PRINCIPLE
--
-- Every spec attaches at the coarsest level where it is actually true, and no
-- coarser. Horsepower is true of an engine, so it lives on Engine_Specs.
-- Wheelbase is true of a body configuration, so it lives on Body_Configs.
-- Towing capacity is true only of a full combination -- engine and cab and bed
-- and drivetrain and axle ratio together -- so it lives on Builds, and nowhere
-- else.
--
-- The temptation is to define one "fully specified vehicle" row and hang every
-- spec off it. A 2024 Silverado has roughly 1,700 valid combinations before
-- options; storing horsepower there would store the same number 400 times and
-- require correcting it 400 times. That is the duplication problem normalising
-- Engine_Specs already solved once, and it is why Builds is deliberately
-- sparse: contributors add the specific configurations they can verify, never
-- a generated cross product.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- LAYER 1 -- IDENTITY
-- ===========================================================================

-- Every distinct vehicle-year. One row for "2026 Porsche 911", regardless of
-- how many trims, bodies or engines that car was offered with.
CREATE TABLE Year_Make_Model (
  "Index"          INTEGER PRIMARY KEY,
  Make             TEXT    NOT NULL COLLATE NOCASE,
  Model            TEXT    NOT NULL COLLATE NOCASE,
  Year             INTEGER NOT NULL,
  -- The ordinal generation number for this nameplate -- 4 for the E46 3
  -- Series, not "E46" itself. An integer, not a code; see Dev_Chassis_Code
  -- for the code.
  Generation       INTEGER,
  -- The manufacturer's internal development/chassis code for this specific
  -- generation of this specific nameplate -- "E46", "992", "ND".
  Dev_Chassis_Code TEXT    COLLATE NOCASE,
  -- The shared engineering architecture underneath -- distinct from
  -- Dev_Chassis_Code because a platform can span multiple nameplates.
  Platform_Code    TEXT    COLLATE NOCASE,
  -- What people actually call it, when that differs from any official name --
  -- "OBS" (Old Body Style) for the 1992-1996 F-150.
  Nickname         TEXT    COLLATE NOCASE,

  UNIQUE (Make, Model, Year)
);

CREATE INDEX idx_ymm_year  ON Year_Make_Model (Year);
CREATE INDEX idx_ymm_model ON Year_Make_Model (Model);

-- ===========================================================================
-- LAYER 2 -- POWERTRAIN CLUSTER
--
-- A vehicle is paired to a Powertrain, not to an engine. That indirection is
-- what lets one shape describe a 1965 Mustang (engine, no battery), a Prius
-- (both), and a Tesla (battery and motors, no engine at all) without any row
-- pretending a missing engine is an unknown engine. Before this existed an EV
-- rendered as "no engine data recorded yet", which says *missing* when the
-- truth is *not applicable*.
-- ===========================================================================

-- Every distinct combustion engine. Shared across vehicles: the same engine
-- fitted to a Golf and a Jetta is one row referenced twice, not two
-- near-identical rows that drift apart when one of them gets corrected.
CREATE TABLE Engine_Specs (
  "Index"           INTEGER PRIMARY KEY,
  -- Who actually designed/built this engine -- not always the same as the
  -- vehicle's Make. BMW's B58 shows up under the Toyota GR Supra.
  Manufacturer      TEXT COLLATE NOCASE,
  -- The manufacturer's own designation for the engine family -- "N54",
  -- "L76", "LQ9". Not unique on its own: one code covers every variant of it.
  Code              TEXT COLLATE NOCASE,
  -- A named differentiator appended to Code -- "B30" for the N54B30, or a
  -- tuner name like "Alpina" when that's how the variant is actually known.
  Named_Variant     TEXT COLLATE NOCASE,
  -- Differentiates variants that have no name at all -- the same code making
  -- different power in different cars. Deliberately excluded from search
  -- results and from the field registry: it exists only so two otherwise
  -- identical rows can both exist, not to be shown or filtered on.
  Silent_Variant    INTEGER,
  Layout            TEXT COLLATE NOCASE,
  Cylinders         INTEGER,
  CC_Displacement   INTEGER,
  Aspiration        TEXT COLLATE NOCASE,
  Fuel_Type         TEXT COLLATE NOCASE,
  Compression_ratio TEXT COLLATE NOCASE,
  Fuel_delivery     TEXT COLLATE NOCASE,
  -- SAE net (or the manufacturer's official published) rating. Gross vs net
  -- horsepower is a different test methodology, not a different unit, so a
  -- contributor has to source the right figure rather than the loader being
  -- able to fix a wrong one.
  Horsepower        INTEGER,
  Torque_lbft       INTEGER,
  Bore_mm             REAL,
  Stroke_mm           REAL,
  -- OHV / SOHC / DOHC.
  Valvetrain          TEXT COLLATE NOCASE,
  Valves_Per_Cylinder INTEGER,
  Redline_RPM         INTEGER,
  -- Regular / Premium / Diesel / E85. What the engine *requires*, which is not
  -- the same question as Fuel_Type -- a engine can run regular and recommend
  -- premium, and only one of those is a hard fact.
  Fuel_Requirement    TEXT COLLATE NOCASE,
  Oil_Capacity_qt     REAL
);

CREATE INDEX idx_engine_shape ON Engine_Specs (Cylinders, Layout, Aspiration);
CREATE INDEX idx_engine_disp  ON Engine_Specs (CC_Displacement);
CREATE INDEX idx_engine_fuel  ON Engine_Specs (Fuel_Type);
CREATE INDEX idx_engine_code  ON Engine_Specs (Manufacturer, Code);
CREATE INDEX idx_engine_power ON Engine_Specs (Horsepower);

-- Traction motors. An EV's equivalent of an engine, and a hybrid has both.
CREATE TABLE Electric_Motors (
  "Index"      INTEGER PRIMARY KEY,
  Manufacturer TEXT COLLATE NOCASE,
  Code         TEXT COLLATE NOCASE,
  -- PMSM / AC Induction / Switched Reluctance. Genuinely different machines
  -- with different efficiency and cost characteristics, not marketing labels.
  Motor_Type   TEXT COLLATE NOCASE,
  Horsepower   INTEGER,
  Torque_lbft  INTEGER,
  Cooling      TEXT COLLATE NOCASE
);

CREATE INDEX idx_motor_code ON Electric_Motors (Manufacturer, Code);

-- Traction batteries.
CREATE TABLE Batteries (
  "Index"             INTEGER PRIMARY KEY,
  -- NMC / LFP / NiMH / NCA.
  Chemistry           TEXT COLLATE NOCASE,
  -- Gross is the pack's physical size; Usable is what the software actually
  -- lets you draw. They differ by a real and commonly-misquoted margin -- an
  -- Audi Q8 e-tron is 114 gross and 106 usable -- so both are carried rather
  -- than collapsing them into one ambiguous "capacity".
  Gross_kWh           REAL,
  Usable_kWh          REAL,
  Nominal_Voltage     INTEGER,
  Thermal_Management  TEXT COLLATE NOCASE,
  Cell_Format         TEXT COLLATE NOCASE
);

CREATE INDEX idx_battery_capacity ON Batteries (Usable_kWh);

-- What a vehicle is actually paired to. Any of engine, battery and motors may
-- be absent; Powertrain_Type is what says which absences are meaningful.
CREATE TABLE Powertrains (
  "Index"              INTEGER PRIMARY KEY,
  -- ICE / Mild Hybrid / Full Hybrid / PHEV / EREV / BEV / FCEV.
  Powertrain_Type      TEXT COLLATE NOCASE,
  Engine_Index         INTEGER REFERENCES Engine_Specs("Index") ON DELETE CASCADE,
  Battery_Index        INTEGER REFERENCES Batteries("Index")    ON DELETE CASCADE,
  -- System output, which for a hybrid is deliberately NOT engine plus motor:
  -- the two peak at different rpm and the manufacturer's combined figure is
  -- its own measured number. Adding the parts would invent a figure.
  Combined_Horsepower  INTEGER,
  Combined_Torque_lbft INTEGER,
  Electric_Range_mi    INTEGER,
  DC_Charge_kW         INTEGER,
  AC_Charge_kW         REAL,
  Charge_Port          TEXT COLLATE NOCASE
);

CREATE INDEX idx_powertrain_type   ON Powertrains (Powertrain_Type);
CREATE INDEX idx_powertrain_engine ON Powertrains (Engine_Index);
CREATE INDEX idx_powertrain_power  ON Powertrains (Combined_Horsepower);

-- Which motors are in which powertrain. Many-to-many because a dual-motor EV
-- is two motors, often two *different* motors front and rear.
CREATE TABLE Powertrain_Motors (
  "Index"          INTEGER PRIMARY KEY,
  Powertrain_Index INTEGER NOT NULL REFERENCES Powertrains("Index")     ON DELETE CASCADE,
  Motor_Index      INTEGER NOT NULL REFERENCES Electric_Motors("Index") ON DELETE CASCADE,
  Position         TEXT COLLATE NOCASE,
  Quantity         INTEGER,

  UNIQUE (Powertrain_Index, Motor_Index, Position)
);

CREATE INDEX idx_ptm_motor ON Powertrain_Motors (Motor_Index, Powertrain_Index);

-- Which powertrains were offered in which vehicle-year. Replaces the old
-- YMM_Engines: this is the row a search actually returns.
CREATE TABLE YMM_Powertrains (
  "Index"          INTEGER PRIMARY KEY,
  YMM_Index        INTEGER NOT NULL REFERENCES Year_Make_Model("Index") ON DELETE CASCADE,
  Powertrain_Index INTEGER NOT NULL REFERENCES Powertrains("Index")     ON DELETE CASCADE,

  UNIQUE (YMM_Index, Powertrain_Index)
);

-- The UNIQUE above serves lookups starting from a vehicle. This one serves the
-- reverse -- "what else used this powertrain" -- which is the more interesting
-- question of the two.
CREATE INDEX idx_ymm_powertrains_pt ON YMM_Powertrains (Powertrain_Index, YMM_Index);

-- ===========================================================================
-- LAYER 3 -- MECHANICAL CATALOGS
--
-- Reusable across vehicles and years. A transfer case type is a fact about a
-- drivetrain, not about a Silverado: the same model year offers part-time and
-- full-time cases depending on configuration, so it cannot live on the vehicle.
-- ===========================================================================

CREATE TABLE Transmissions (
  "Index"          INTEGER PRIMARY KEY,
  Manufacturer     TEXT COLLATE NOCASE,
  -- "10R80", "8L90", "ZF 8HP".
  Code             TEXT COLLATE NOCASE,
  -- Manual / Automatic / CVT / DCT / AMT / Single-speed.
  Type             TEXT COLLATE NOCASE,
  Forward_Gears    INTEGER,
  First_Gear_Ratio REAL,
  Top_Gear_Ratio   REAL
);

CREATE INDEX idx_transmission_type ON Transmissions (Type, Forward_Gears);
CREATE INDEX idx_transmission_code ON Transmissions (Manufacturer, Code);

CREATE TABLE Drivetrains (
  "Index"             INTEGER PRIMARY KEY,
  -- RWD / FWD / AWD / 4WD.
  Layout              TEXT COLLATE NOCASE,
  -- Part-time / Full-time / Selectable / Single-speed / None. The distinction
  -- that decides whether you can legally drive it on dry pavement in 4WD.
  Transfer_Case_Type  TEXT COLLATE NOCASE,
  Transfer_Case_Model TEXT COLLATE NOCASE,
  Low_Range_Ratio     REAL,
  -- Manual Locking / Auto Locking / Fixed.
  Front_Hub_Type      TEXT COLLATE NOCASE,
  -- Open / Locking / Torsen / Viscous / Clutch-pack.
  Center_Differential TEXT COLLATE NOCASE,
  Front_Diff_Type     TEXT COLLATE NOCASE,
  Rear_Diff_Type      TEXT COLLATE NOCASE
);

CREATE INDEX idx_drivetrain_layout ON Drivetrains (Layout, Transfer_Case_Type);

CREATE TABLE Suspensions (
  "Index"                INTEGER PRIMARY KEY,
  -- MacPherson / Double Wishbone / Multi-link / Solid Axle / Torsion Bar.
  Front_Type             TEXT COLLATE NOCASE,
  -- Multi-link / Live Axle / Leaf / Torsion Beam / Air.
  Rear_Type              TEXT COLLATE NOCASE,
  Front_Spring           TEXT COLLATE NOCASE,
  Rear_Spring            TEXT COLLATE NOCASE,
  -- Passive / Adaptive / Magnetorheological.
  Damping                TEXT COLLATE NOCASE,
  Ride_Height_Adjustable INTEGER
);

CREATE INDEX idx_suspension_type ON Suspensions (Front_Type, Rear_Type);

-- ===========================================================================
-- LAYER 4 -- BODY AND INTERIOR
-- ===========================================================================

-- Cab/bed/body-style plus every exterior dimension. Exterior dimensions live
-- here rather than in a table of their own because they are strictly 1:1 with
-- a body configuration -- separating them would add a join and buy nothing.
CREATE TABLE Body_Configs (
  "Index"               INTEGER PRIMARY KEY,
  -- Sedan / Coupe / SUV / Pickup / Wagon / Van / Convertible / Hatchback.
  Body_Style            TEXT COLLATE NOCASE,
  Doors                 INTEGER,
  -- Regular / Extended / Double / Crew / Mega. Trucks only.
  Cab_Config            TEXT COLLATE NOCASE,
  Bed_Length_in         REAL,
  Bed_Volume_cuft       REAL,
  Roof_Height           TEXT COLLATE NOCASE,
  Wheelbase_in          REAL,
  Length_in             REAL,
  Width_in              REAL,
  Height_in             REAL,
  Track_Front_in        REAL,
  Track_Rear_in         REAL,
  Ground_Clearance_in   REAL,
  Approach_Angle_deg    REAL,
  Departure_Angle_deg   REAL,
  Breakover_Angle_deg   REAL,
  Drag_Coefficient      REAL,
  Cargo_Volume_cuft     REAL,
  Cargo_Volume_Max_cuft REAL,
  Fuel_Capacity_gal     REAL,
  Seating_Rows          INTEGER
);

CREATE INDEX idx_body_style     ON Body_Configs (Body_Style, Doors);
CREATE INDEX idx_body_wheelbase ON Body_Configs (Wheelbase_in);
CREATE INDEX idx_body_cab       ON Body_Configs (Cab_Config, Bed_Length_in);

CREATE TABLE YMM_Body_Configs (
  "Index"           INTEGER PRIMARY KEY,
  YMM_Index         INTEGER NOT NULL REFERENCES Year_Make_Model("Index") ON DELETE CASCADE,
  Body_Config_Index INTEGER NOT NULL REFERENCES Body_Configs("Index")    ON DELETE CASCADE,

  UNIQUE (YMM_Index, Body_Config_Index)
);

CREATE INDEX idx_ymm_body_body ON YMM_Body_Configs (Body_Config_Index, YMM_Index);

CREATE TABLE Seating_Configs (
  "Index"          INTEGER PRIMARY KEY,
  Rows             INTEGER,
  Capacity         INTEGER,
  -- Bench / Captain's Chairs. The single most-asked configuration question on
  -- three-row SUVs, and the reason this is its own table rather than a column.
  Second_Row_Type  TEXT COLLATE NOCASE,
  Third_Row_Type   TEXT COLLATE NOCASE,
  Front_Type       TEXT COLLATE NOCASE
);

CREATE INDEX idx_seating ON Seating_Configs (Capacity, Second_Row_Type);

-- Interior room, one row per seating row, measured to SAE J1100 (H-point
-- based). Seating_Config_Index is nullable on purpose: most dimensions do not
-- vary with seating and leave it blank, while a second-row legroom figure that
-- genuinely differs between bench and captain's chairs gets one row for each.
CREATE TABLE Interior_Dimensions (
  "Index"              INTEGER PRIMARY KEY,
  Body_Config_Index    INTEGER NOT NULL REFERENCES Body_Configs("Index")    ON DELETE CASCADE,
  Seating_Config_Index INTEGER REFERENCES Seating_Configs("Index")          ON DELETE CASCADE,
  Row_Number           INTEGER NOT NULL,
  Headroom_in          REAL,
  Legroom_in           REAL,
  Shoulder_Room_in     REAL,
  Hip_Room_in          REAL,

  UNIQUE (Body_Config_Index, Seating_Config_Index, Row_Number)
);

CREATE INDEX idx_interior_body ON Interior_Dimensions (Body_Config_Index, Row_Number);

-- ===========================================================================
-- LAYER 5 -- TRIM
-- ===========================================================================

CREATE TABLE Trims (
  "Index"     INTEGER PRIMARY KEY,
  YMM_Index   INTEGER NOT NULL REFERENCES Year_Make_Model("Index") ON DELETE CASCADE,
  Trim_Name   TEXT NOT NULL COLLATE NOCASE,
  -- Ordinal, so WT < LT < LTZ < High Country sorts correctly. Alphabetical
  -- order is meaningless for trim names and there is no other way to recover
  -- the hierarchy from the names themselves.
  Trim_Level  INTEGER,
  Notes       TEXT COLLATE NOCASE,

  UNIQUE (YMM_Index, Trim_Name)
);

CREATE INDEX idx_trim_name ON Trims (Trim_Name);

-- ===========================================================================
-- LAYER 6 -- THE LEAF
--
-- A specific, orderable configuration. Sparse by design: nobody enumerates a
-- Silverado's ~1,700 combinations, and the loader does not generate them. A
-- contributor who knows one real configuration adds one row.
-- ===========================================================================

CREATE TABLE Builds (
  "Index"               INTEGER PRIMARY KEY,
  YMM_Index             INTEGER NOT NULL REFERENCES Year_Make_Model("Index") ON DELETE CASCADE,
  Trim_Index            INTEGER REFERENCES Trims("Index")           ON DELETE CASCADE,
  Body_Config_Index     INTEGER REFERENCES Body_Configs("Index")    ON DELETE CASCADE,
  Powertrain_Index      INTEGER REFERENCES Powertrains("Index")     ON DELETE CASCADE,
  Transmission_Index    INTEGER REFERENCES Transmissions("Index")   ON DELETE CASCADE,
  Drivetrain_Index      INTEGER REFERENCES Drivetrains("Index")     ON DELETE CASCADE,
  Suspension_Index      INTEGER REFERENCES Suspensions("Index")     ON DELETE CASCADE,
  Seating_Config_Index  INTEGER REFERENCES Seating_Configs("Index") ON DELETE CASCADE,
  Axle_Ratio            REAL,
  -- The options discriminator -- "w/ Max Trailering Package". Two otherwise
  -- identical builds can have genuinely different tow ratings because of one
  -- box on the order sheet, and this is what tells them apart. Same idea as
  -- Named_Variant on an engine.
  Equipment_Note        TEXT COLLATE NOCASE,

  -- Specs that are true only of the whole combination. A 2018 Ram 3500 swings
  -- roughly 2,000 lb of tow rating on axle ratio alone -- that is why these
  -- are here and not on any single component table.
  Curb_Weight_lb        INTEGER,
  GVWR_lb               INTEGER,
  GCWR_lb               INTEGER,
  Payload_lb            INTEGER,
  Towing_Capacity_lb    INTEGER,
  Tongue_Weight_lb      INTEGER,
  EPA_City_mpg          REAL,
  EPA_Highway_mpg       REAL,
  EPA_Combined_mpg      REAL,
  EPA_Electric_Range_mi INTEGER,
  Zero_To_Sixty_s       REAL,
  Quarter_Mile_s        REAL,
  Top_Speed_mph         INTEGER,
  Braking_60_0_ft       INTEGER
);

-- The correlation key leads every index here: build-level filters are semi-
-- joins correlated on YMM_Index, and an index that does not lead with it
-- degrades the EXISTS into a scan of the whole table.
CREATE INDEX idx_builds_ymm      ON Builds (YMM_Index);
CREATE INDEX idx_builds_tow      ON Builds (YMM_Index, Towing_Capacity_lb);
CREATE INDEX idx_builds_payload  ON Builds (YMM_Index, Payload_lb);
CREATE INDEX idx_builds_weight   ON Builds (YMM_Index, Curb_Weight_lb);
CREATE INDEX idx_builds_mpg      ON Builds (YMM_Index, EPA_Combined_mpg);
CREATE INDEX idx_builds_body     ON Builds (Body_Config_Index);
CREATE INDEX idx_builds_pt       ON Builds (Powertrain_Index);

-- ===========================================================================
-- DERIVED -- built by the loader, never authored
-- ===========================================================================

-- Per vehicle-year min/max of every numeric build spec, plus a text summary of
-- the trims offered. This is what makes "tows at least 10,000 lb" a plain
-- indexed range filter instead of a correlated subquery on the hot path.
--
-- Keyed on the vehicle-year rather than on (vehicle, powertrain) so that the
-- rollup and the EXISTS path agree about what a build-level filter means. The
-- value repeats across a vehicle's powertrain rows, which is correct: it says
-- "this vehicle can be configured to tow X", which is the question people
-- actually ask.
--
-- A view cannot go stale; a table can. This one is written inside the same
-- transaction as everything else it summarises, so it carries exactly the same
-- staleness guarantee as the view -- the database is a full-rebuild artifact.
CREATE TABLE Build_Rollup (
  YMM_Index                 INTEGER PRIMARY KEY REFERENCES Year_Make_Model("Index") ON DELETE CASCADE,
  Build_Count               INTEGER NOT NULL,
  Min_Towing_Capacity_lb    INTEGER,
  Max_Towing_Capacity_lb    INTEGER,
  Min_Payload_lb            INTEGER,
  Max_Payload_lb            INTEGER,
  Min_Curb_Weight_lb        INTEGER,
  Max_Curb_Weight_lb        INTEGER,
  Min_GVWR_lb               INTEGER,
  Max_GVWR_lb               INTEGER,
  Min_EPA_Combined_mpg      REAL,
  Max_EPA_Combined_mpg      REAL,
  Min_Zero_To_Sixty_s       REAL,
  Max_Zero_To_Sixty_s       REAL,
  Trim_Summary              TEXT COLLATE NOCASE
);

CREATE INDEX idx_rollup_tow ON Build_Rollup (Max_Towing_Capacity_lb);
CREATE INDEX idx_rollup_mpg ON Build_Rollup (Max_EPA_Combined_mpg);

-- Materialised dropdown values. Computing these live means one GROUP BY per
-- field on every cold page load; at this field count over a multi-join view
-- that is the single most expensive query in the system, and it runs before
-- the visitor has done anything.
CREATE TABLE Field_Choices (
  Field_Name TEXT NOT NULL COLLATE NOCASE,
  Value      TEXT NOT NULL COLLATE NOCASE,
  N          INTEGER NOT NULL,

  PRIMARY KEY (Field_Name, Value)
);

-- ===========================================================================
-- SEARCH SURFACE
-- ===========================================================================

-- Flattened query surface, one row per vehicle-year x powertrain.
--
-- Only the powertrain fans this view out. Trims, body configs, transmissions,
-- drivetrains, suspensions and seating are all 1:N against a vehicle-year, and
-- two of those in one view is a cartesian product -- adding trim (x4) and body
-- (x3) would take ~41k rows to ~500k for no benefit. They are reached by
-- EXISTS from the compiler instead, and never joined here.
--
-- Engine, Battery and Build_Rollup are joined because each is at most one row
-- per row already present: N:1 or 1:1 lookups, no fan-out.
--
-- LEFT JOIN throughout, deliberately. A vehicle with nothing paired to it yet
-- must still be searchable by make, model or year -- this data will always
-- contain incomplete entries, and hiding a car entirely because one fact is
-- missing is a worse failure than showing it with a gap. combo_index falls
-- back to the negative of the vehicle's own index when there is no pairing row
-- to number it, which stays unique because a real pairing's index is always
-- positive.
CREATE VIEW Search_View AS
SELECT
  COALESCE(yp."Index", -ymm."Index") AS combo_index,
  ymm."Index"           AS ymm_index,
  pt."Index"            AS powertrain_index,
  eng."Index"           AS engine_index,

  ymm.Make              AS Make,
  ymm.Model             AS Model,
  ymm.Year              AS Year,
  ymm.Generation        AS Generation,
  ymm.Dev_Chassis_Code  AS Dev_Chassis_Code,
  ymm.Platform_Code     AS Platform_Code,
  ymm.Nickname          AS Nickname,

  pt.Powertrain_Type      AS Powertrain_Type,
  pt.Combined_Horsepower  AS Combined_Horsepower,
  pt.Combined_Torque_lbft AS Combined_Torque_lbft,
  pt.Electric_Range_mi    AS Electric_Range_mi,
  pt.DC_Charge_kW         AS DC_Charge_kW,
  pt.AC_Charge_kW         AS AC_Charge_kW,
  pt.Charge_Port          AS Charge_Port,

  eng.Manufacturer      AS Manufacturer,
  eng.Code              AS Code,
  eng.Named_Variant     AS Named_Variant,
  eng.Horsepower        AS Horsepower,
  eng.Torque_lbft       AS Torque_lbft,
  eng.Layout            AS Layout,
  eng.Cylinders         AS Cylinders,
  eng.CC_Displacement   AS CC_Displacement,
  eng.Aspiration        AS Aspiration,
  eng.Fuel_Type         AS Fuel_Type,
  eng.Compression_ratio AS Compression_ratio,
  eng.Fuel_delivery     AS Fuel_delivery,
  eng.Valvetrain        AS Valvetrain,
  eng.Redline_RPM       AS Redline_RPM,
  eng.Fuel_Requirement  AS Fuel_Requirement,

  bat.Chemistry         AS Battery_Chemistry,
  bat.Gross_kWh         AS Battery_Gross_kWh,
  bat.Usable_kWh        AS Battery_Usable_kWh,

  br.Max_Towing_Capacity_lb AS Max_Towing_Capacity_lb,
  br.Max_Payload_lb         AS Max_Payload_lb,
  br.Min_Curb_Weight_lb     AS Min_Curb_Weight_lb,
  br.Max_Curb_Weight_lb     AS Max_Curb_Weight_lb,
  br.Max_GVWR_lb            AS Max_GVWR_lb,
  br.Max_EPA_Combined_mpg   AS Max_EPA_Combined_mpg,
  br.Min_Zero_To_Sixty_s    AS Min_Zero_To_Sixty_s,
  br.Trim_Summary           AS Trim_Summary,
  br.Build_Count            AS Build_Count,

  ymm.Year || ' ' || ymm.Make || ' ' || ymm.Model AS Search_Text
FROM Year_Make_Model ymm
LEFT JOIN YMM_Powertrains yp ON yp.YMM_Index = ymm."Index"
LEFT JOIN Powertrains pt     ON pt."Index"   = yp.Powertrain_Index
LEFT JOIN Engine_Specs eng   ON eng."Index"  = pt.Engine_Index
LEFT JOIN Batteries bat      ON bat."Index"  = pt.Battery_Index
LEFT JOIN Build_Rollup br    ON br.YMM_Index = ymm."Index";

-- Build metadata, so the API can report what it is serving without needing the
-- repository it was built from.
CREATE TABLE build_info (
  key   TEXT PRIMARY KEY,
  value TEXT
);
