/**
 * The browsable-table registry.
 *
 * This is to raw table browsing what `fields.ts` is to search: the *only* place
 * a public table name maps to a real SQL table, and the only source of the
 * column list used to build a SELECT. A request names a table by key; if the
 * key is not in this object the request is rejected before any SQL exists.
 * Nothing user-supplied is ever concatenated into an identifier.
 *
 * Columns are listed explicitly rather than selected with `*` so the API's
 * response shape is the documented shape. That also makes drift loud: a column
 * added to the schema and not added here simply will not appear, rather than
 * silently showing up undocumented.
 *
 * Descriptions here are the same explanations carried in the schema comments
 * (packages/db/migrations/0000_schema.sql) and data/README.md -- this registry
 * is what puts them on the site instead of leaving them buried in source.
 */

export type TableColumnType = 'text' | 'integer' | 'real';

export interface TableColumnDef {
  name: string;
  type: TableColumnType;
  description: string;
  /** `pk` = assigned identity, `fk` = points at another table. */
  key?: 'pk' | 'fk';
  /** Table this column references, for `fk` columns. */
  references?: string;
}

export interface TableDef {
  /** SQL table name, and the identifier used in the URL. */
  name: string;
  label: string;
  /** `source` = loaded from a CSV. `derived` = built by the loader. */
  group: 'source' | 'derived';
  /** One line: what one row of this table *is*. */
  role: string;
  description: string;
  /** The CSV this table is authored in, when it is authored at all. */
  csv?: string;
  columns: TableColumnDef[];
  /** Default ordering. Must be a column name from this same definition. */
  orderBy: string;
}

const YEAR_MAKE_MODEL: TableDef = {
  name: 'Year_Make_Model',
  label: 'Year / Make / Model',
  group: 'source',
  role: 'One row per vehicle-year.',
  description:
    'The spine of the database. A 2026 Porsche 911 is one row here regardless of how many ' +
    'trims or engines it came with. Make, Model and Year together identify a row; the other ' +
    'four columns are descriptive and are very often blank, which is expected rather than a gap ' +
    'to be filled with a guess.',
  csv: 'data/year_make_model.csv',
  orderBy: 'Make',
  columns: [
    { name: 'Index', type: 'integer', key: 'pk', description: 'Assigned by the loader at build time. Never authored, and not stable across rebuilds — reference rows by Make/Model/Year instead.' },
    { name: 'Make', type: 'text', description: 'Manufacturer as marketed, e.g. "Chevrolet". Case-insensitive: "chevrolet" is the same make, not a second one.' },
    { name: 'Model', type: 'text', description: 'Model name, e.g. "Silverado", "911".' },
    { name: 'Year', type: 'integer', description: 'Model year, not calendar year of sale.' },
    { name: 'Generation', type: 'integer', description: 'Ordinal generation number for this nameplate — 4, not "E46". Optional.' },
    { name: 'Dev_Chassis_Code', type: 'text', description: 'Manufacturer development code for this generation — "E46", "992", "ND".' },
    { name: 'Platform_Code', type: 'text', description: 'Shared engineering architecture, which can span unrelated nameplates — VW\'s "MQB" underlies the Golf and the Audi A3 alike.' },
    { name: 'Nickname', type: 'text', description: 'What people actually call it when that differs from any official name — "OBS" for the 1992–96 F-150. Community language, not manufacturer terminology.' },
  ],
};

const ENGINE_SPECS: TableDef = {
  name: 'Engine_Specs',
  label: 'Engine Specs',
  group: 'source',
  role: 'One row per distinct engine variant.',
  description:
    'Engines are shared, not copied: the same engine fitted to a Golf and a Jetta is one row ' +
    'referenced twice, so correcting it corrects both. An engine is identified by Manufacturer + ' +
    'Code + Named_Variant + Silent_Variant — the loader rejects two rows that describe the same ' +
    'engine under different handles.',
  csv: 'data/engine_specs.csv',
  orderBy: 'Manufacturer',
  columns: [
    { name: 'Index', type: 'integer', key: 'pk', description: 'Assigned by the loader at build time.' },
    { name: 'Manufacturer', type: 'text', description: 'Who actually built the engine — not always the vehicle\'s own Make. The BMW-built B58 reads "BMW" even under a Toyota GR Supra.' },
    { name: 'Code', type: 'text', description: 'The manufacturer\'s own designation for the engine family — "N54", "L76", "LQ9". Not unique on its own: one code covers every variant of it.' },
    { name: 'Named_Variant', type: 'text', description: 'A named differentiator appended to the code — "B30" for the N54B30, or a tuner name like "Alpina". Most engines have none.' },
    { name: 'Silent_Variant', type: 'integer', description: 'Disambiguates variants with no name at all — the same code making different power in different cars. Deliberately never shown in search results or offered as a filter; it exists only so two otherwise-identical rows can coexist.' },
    { name: 'Layout', type: 'text', description: 'Cylinder arrangement — Inline, V, Flat, W, Rotary.' },
    { name: 'Cylinders', type: 'integer', description: 'Blank for a rotary, which has no cylinders in the piston sense.' },
    { name: 'CC_Displacement', type: 'integer', description: 'Real swept volume in cubic centimetres — a "3.0 litre" engine is 2981 if that is what it displaces, not 3000.' },
    { name: 'Aspiration', type: 'text', description: 'Naturally Aspirated, Turbocharged, Twin-Turbocharged, Supercharged.' },
    { name: 'Fuel_Type', type: 'text', description: 'Gasoline, Diesel, E85, and so on.' },
    { name: 'Compression_ratio', type: 'text', description: 'Recorded as published, e.g. "10.5:1". Text rather than a number because that is how every source writes it.' },
    { name: 'Fuel_delivery', type: 'text', description: 'Direct Injection, Port Injection, Carburetor, or a combination.' },
    { name: 'Horsepower', type: 'integer', description: 'SAE net, or the manufacturer\'s official published figure. Gross horsepower is a different test standard, not a different unit — a source that does not say which it is giving is a reason to leave this blank.' },
    { name: 'Torque_lbft', type: 'integer', description: 'Pound-feet, same sourcing rule as Horsepower.' },
  ],
};


// Engine_Specs gained seven columns in the schema expansion. They are appended
// here rather than interleaved so the order matches the CSV a contributor edits.
ENGINE_SPECS.columns.push(
  { name: 'Bore_mm', type: 'real', description: 'Cylinder bore. With stroke, this is what makes an engine over- or under-square.' },
  { name: 'Stroke_mm', type: 'real', description: 'Piston stroke.' },
  { name: 'Valvetrain', type: 'text', description: 'OHV, SOHC or DOHC.' },
  { name: 'Valves_Per_Cylinder', type: 'integer', description: 'Two for most pushrod engines, four for most modern overhead-cam ones.' },
  { name: 'Redline_RPM', type: 'integer', description: 'Where the tachometer goes red.' },
  { name: 'Fuel_Requirement', type: 'text', description: 'What the engine requires -- regular, premium, diesel. A different question from Fuel_Type: an engine can burn gasoline and still require premium.' },
  { name: 'Oil_Capacity_qt', type: 'real', description: 'Sump capacity in US quarts, including filter.' },
);


const ELECTRIC_MOTORS: TableDef = {
  name: "Electric_Motors",
  label: "Electric Motors",
  group: "source",
  role: "One row per distinct traction motor.",
  description:
    "An EV's equivalent of an engine, and a hybrid has both. Shared the same way engines are: a motor used front and rear, or across two models, is one row referenced several times.",
  csv: "data/electric_motors.csv",
  orderBy: "Manufacturer",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Manufacturer", type: "text", description: "Who built the motor." },
    { name: "Code", type: "text", description: "The manufacturer's designation, where one is published." },
    { name: "Motor_Type", type: "text", description: "PMSM, AC induction, switched reluctance. Genuinely different machines with different efficiency and cost, not marketing labels." },
    { name: "Horsepower", type: "integer", description: "Output of this motor alone, not of the system it sits in." },
    { name: "Torque_lbft", type: "integer", description: "Peak output of this motor alone." },
    { name: "Cooling", type: "text", description: "Liquid or air." },
  ],
};

const BATTERIES: TableDef = {
  name: "Batteries",
  label: "Batteries",
  group: "source",
  role: "One row per distinct traction battery pack.",
  description:
    "Gross and usable capacity are both carried because they are genuinely different numbers and are constantly conflated -- an Audi Q8 e-tron is 114 kWh gross and 106 usable. Collapsing them into one \"capacity\" would make the site wrong in the specific way most EV spec sheets are.",
  csv: "data/batteries.csv",
  orderBy: "Chemistry",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Chemistry", type: "text", description: "NMC, LFP, NiMH, NCA." },
    { name: "Gross_kWh", type: "real", description: "The pack's physical size." },
    { name: "Usable_kWh", type: "real", description: "What the software will actually let you draw. Always the smaller of the two; the loader rejects a row where it is not." },
    { name: "Nominal_Voltage", type: "integer", description: "Pack voltage. 400V and 800V architectures charge very differently." },
    { name: "Thermal_Management", type: "text", description: "Liquid, air or passive." },
    { name: "Cell_Format", type: "text", description: "Cylindrical, pouch or prismatic." },
  ],
};

const POWERTRAINS: TableDef = {
  name: "Powertrains",
  label: "Powertrains",
  group: "source",
  role: "One row per distinct powertrain -- what a vehicle is actually paired to.",
  description:
    "The table that makes an EV describable. A vehicle is paired to a powertrain rather than to an engine, so a battery-electric car can honestly have no engine at all instead of appearing to be missing one. Engine, battery and motors are each optional; Powertrain_Type is what says which absences are meaningful.",
  csv: "data/powertrains.csv",
  orderBy: "Powertrain_Type",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Powertrain_Type", type: "text", description: "ICE, mild hybrid, full hybrid, PHEV, EREV, BEV, FCEV." },
    { name: "Engine_Index", type: "integer", key: "fk", references: "Engine_Specs", description: "Empty for a battery-electric powertrain -- which the loader enforces, since a BEV with an engine is a contradiction rather than a gap." },
    { name: "Battery_Index", type: "integer", key: "fk", references: "Batteries", description: "Empty for a pure combustion powertrain." },
    { name: "Combined_Horsepower", type: "integer", description: "Total system output. Deliberately not engine-plus-motor arithmetic: the two peak at different rpm and the manufacturer's combined figure is its own measured number." },
    { name: "Combined_Torque_lbft", type: "integer", description: "Total system torque, same sourcing rule." },
    { name: "Electric_Range_mi", type: "integer", description: "EPA electric-only range." },
    { name: "DC_Charge_kW", type: "integer", description: "Peak DC fast-charge rate." },
    { name: "AC_Charge_kW", type: "real", description: "Onboard charger rate, which is what decides how long an overnight charge takes." },
    { name: "Charge_Port", type: "text", description: "NACS, CCS1, CCS2, CHAdeMO." },
  ],
};

const POWERTRAIN_MOTORS: TableDef = {
  name: "Powertrain_Motors",
  label: "Powertrain and Motor",
  group: "source",
  role: "One row per motor fitted to a powertrain.",
  description:
    "Many-to-many, because a dual-motor EV is two motors and they are often two different motors front and rear rather than the same one twice.",
  csv: "data/powertrain_motors.csv",
  orderBy: "Index",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Powertrain_Index", type: "integer", key: "fk", references: "Powertrains", description: "The powertrain this motor belongs to." },
    { name: "Motor_Index", type: "integer", key: "fk", references: "Electric_Motors", description: "The motor." },
    { name: "Position", type: "text", description: "Front, rear or in-wheel." },
    { name: "Quantity", type: "integer", description: "Usually 1. More than one identical motor in the same position is rare but real." },
  ],
};

const YMM_POWERTRAINS: TableDef = {
  name: "YMM_Powertrains",
  label: "Vehicle and Powertrain",
  group: "source",
  role: "One row per (vehicle-year, powertrain) pairing.",
  description:
    "The many-to-many join, and the row a search actually returns. A vehicle offered with three powertrains is three rows here and still one row in Year_Make_Model.",
  csv: "data/ymm_powertrains.csv",
  orderBy: "Index",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "YMM_Index", type: "integer", key: "fk", references: "Year_Make_Model", description: "The vehicle-year." },
    { name: "Powertrain_Index", type: "integer", key: "fk", references: "Powertrains", description: "The powertrain." },
  ],
};

const TRANSMISSIONS: TableDef = {
  name: "Transmissions",
  label: "Transmissions",
  group: "source",
  role: "One row per distinct transmission.",
  description:
    "A reusable catalog. GM's 10L90 appears in a dozen vehicles across several years; it is one row here rather than a repeated description on each of them.",
  csv: "data/transmissions.csv",
  orderBy: "Manufacturer",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Manufacturer", type: "text", description: "Who built it, which is often not the carmaker -- ZF and Aisin supply much of the industry." },
    { name: "Code", type: "text", description: "\"10R80\", \"8L90\", \"ZF 8HP\"." },
    { name: "Type", type: "text", description: "Manual, automatic, CVT, DCT, AMT, single-speed." },
    { name: "Forward_Gears", type: "integer", description: "Single-speed for most EVs." },
    { name: "First_Gear_Ratio", type: "real", description: "Decides launch behaviour and low-speed pulling." },
    { name: "Top_Gear_Ratio", type: "real", description: "Decides cruising rpm, and with it highway economy and noise." },
  ],
};

const DRIVETRAINS: TableDef = {
  name: "Drivetrains",
  label: "Drivetrains",
  group: "source",
  role: "One row per distinct drivetrain arrangement.",
  description:
    "Transfer case, hubs and differentials. These are drivetrain facts rather than vehicle facts: the same Silverado model year offers part-time and full-time cases depending on configuration, so they cannot live on the vehicle without being wrong for half of them.",
  csv: "data/drivetrains.csv",
  orderBy: "Layout",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Layout", type: "text", description: "RWD, FWD, AWD, 4WD." },
    { name: "Transfer_Case_Type", type: "text", description: "Part-time, full-time, selectable, single-speed. The distinction that decides whether 4WD can be used on dry pavement." },
    { name: "Transfer_Case_Model", type: "text", description: "The unit itself -- \"NV241\", \"BW4406\"." },
    { name: "Low_Range_Ratio", type: "real", description: "Reduction in 4-Lo. Blank where there is no low range." },
    { name: "Front_Hub_Type", type: "text", description: "Manual locking, auto locking or fixed." },
    { name: "Center_Differential", type: "text", description: "Open, locking, Torsen, viscous, clutch-pack." },
    { name: "Front_Diff_Type", type: "text", description: "Open, limited-slip, locking." },
    { name: "Rear_Diff_Type", type: "text", description: "Open, limited-slip, locking, e-locker." },
  ],
};

const SUSPENSIONS: TableDef = {
  name: "Suspensions",
  label: "Suspensions",
  group: "source",
  role: "One row per distinct suspension arrangement.",
  description:
    "Front and rear geometry, spring medium and damping type.",
  csv: "data/suspensions.csv",
  orderBy: "Front_Type",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Front_Type", type: "text", description: "MacPherson, double wishbone, multi-link, solid axle, torsion bar." },
    { name: "Rear_Type", type: "text", description: "Multi-link, live axle, leaf, torsion beam, air." },
    { name: "Front_Spring", type: "text", description: "Coil, leaf, air, torsion." },
    { name: "Rear_Spring", type: "text", description: "Coil, leaf, air, torsion." },
    { name: "Damping", type: "text", description: "Passive, adaptive, magnetorheological." },
    { name: "Ride_Height_Adjustable", type: "integer", description: "1 or 0. Blank where nobody has recorded it, which is not the same as \"no\"." },
  ],
};

const BODY_CONFIGS: TableDef = {
  name: "Body_Configs",
  label: "Body Configurations",
  group: "source",
  role: "One row per distinct body configuration.",
  description:
    "Cab and bed and body style, plus every exterior dimension. Exterior dimensions live here rather than in a table of their own because they are strictly one-to-one with a body configuration -- a separate table would add a join and buy nothing.",
  csv: "data/body_configs.csv",
  orderBy: "Body_Style",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Body_Style", type: "text", description: "Sedan, coupe, SUV, pickup, wagon, van, convertible, hatchback." },
    { name: "Doors", type: "integer", description: "Counting the tailgate or hatch where it is a door." },
    { name: "Cab_Config", type: "text", description: "Regular, extended, double, crew, mega. Trucks only." },
    { name: "Bed_Length_in", type: "real", description: "Actual bed length, not the marketing name -- a \"6.5-foot bed\" is usually 78.9 inches." },
    { name: "Bed_Volume_cuft", type: "real", description: "Bed capacity." },
    { name: "Roof_Height", type: "text", description: "Low, mid or high. Vans." },
    { name: "Wheelbase_in", type: "real", description: "Axle centreline to axle centreline." },
    { name: "Length_in", type: "real", description: "Bumper to bumper." },
    { name: "Width_in", type: "real", description: "Body width, conventionally excluding mirrors." },
    { name: "Height_in", type: "real", description: "Overall height, unladen." },
    { name: "Track_Front_in", type: "real", description: "Front wheel centre to wheel centre." },
    { name: "Track_Rear_in", type: "real", description: "Rear wheel centre to wheel centre." },
    { name: "Ground_Clearance_in", type: "real", description: "Minimum running clearance." },
    { name: "Approach_Angle_deg", type: "real", description: "Off-road geometry: how steep an obstacle can be driven onto without contact." },
    { name: "Departure_Angle_deg", type: "real", description: "The same, leaving an obstacle." },
    { name: "Breakover_Angle_deg", type: "real", description: "How sharp a crest can be crossed without grounding the belly." },
    { name: "Drag_Coefficient", type: "real", description: "Cd. Decides highway economy more than almost anything else on this row." },
    { name: "Cargo_Volume_cuft", type: "real", description: "Seats up." },
    { name: "Cargo_Volume_Max_cuft", type: "real", description: "Seats folded. Always the larger of the two; the loader rejects a row where it is not." },
    { name: "Fuel_Capacity_gal", type: "real", description: "Usable tank capacity." },
    { name: "Seating_Rows", type: "integer", description: "How many rows of seats the body has." },
  ],
};

const YMM_BODY_CONFIGS: TableDef = {
  name: "YMM_Body_Configs",
  label: "Vehicle and Body",
  group: "source",
  role: "One row per body configuration offered on a vehicle-year.",
  description:
    "Which bodies a given vehicle-year could be ordered in.",
  csv: "data/ymm_body_configs.csv",
  orderBy: "Index",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "YMM_Index", type: "integer", key: "fk", references: "Year_Make_Model", description: "The vehicle-year." },
    { name: "Body_Config_Index", type: "integer", key: "fk", references: "Body_Configs", description: "The body configuration." },
  ],
};

const SEATING_CONFIGS: TableDef = {
  name: "Seating_Configs",
  label: "Seating Configurations",
  group: "source",
  role: "One row per distinct seating arrangement.",
  description:
    "Its own table rather than a column because the bench-versus-captain's-chairs question is asked about nearly every three-row SUV, and because the same body can be ordered either way.",
  csv: "data/seating_configs.csv",
  orderBy: "Capacity",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Rows", type: "integer", description: "How many rows of seats." },
    { name: "Capacity", type: "integer", description: "Total seats. Captain's chairs usually cost one relative to a bench." },
    { name: "Second_Row_Type", type: "text", description: "Bench or captain's chairs." },
    { name: "Third_Row_Type", type: "text", description: "Bench, split-fold, or none." },
    { name: "Front_Type", type: "text", description: "Buckets or split bench." },
  ],
};

const INTERIOR_DIMENSIONS: TableDef = {
  name: "Interior_Dimensions",
  label: "Interior Dimensions",
  group: "source",
  role: "One row per seating row of a body configuration.",
  description:
    "Measured to SAE J1100, the H-point standard manufacturers publish against. A three-row SUV has three rows here. Seating_Config_Index is deliberately optional: a dimension that does not vary with seating leaves it blank, while second-row legroom that genuinely differs between a bench and captain's chairs gets one row for each.",
  csv: "data/interior_dimensions.csv",
  orderBy: "Index",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "Body_Config_Index", type: "integer", key: "fk", references: "Body_Configs", description: "The body this measurement was taken in." },
    { name: "Seating_Config_Index", type: "integer", key: "fk", references: "Seating_Configs", description: "Blank when the measurement is the same whichever seating is fitted." },
    { name: "Row_Number", type: "integer", description: "1 is the front row." },
    { name: "Headroom_in", type: "real", description: "Reduced by a sunroof, which is why the same car can be listed twice with different figures." },
    { name: "Legroom_in", type: "real", description: "SAE J1100 legroom for this row." },
    { name: "Shoulder_Room_in", type: "real", description: "Cabin width at shoulder height." },
    { name: "Hip_Room_in", type: "real", description: "Cabin width at hip height." },
  ],
};

const TRIMS: TableDef = {
  name: "Trims",
  label: "Trims",
  group: "source",
  role: "One row per trim offered on a vehicle-year.",
  description:
    "Trim_Level exists because alphabetical order is meaningless for trim names and there is no other way to recover the hierarchy: nothing about the strings \"WT\" and \"High Country\" says which is the top of the range.",
  csv: "data/trims.csv",
  orderBy: "Trim_Name",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "YMM_Index", type: "integer", key: "fk", references: "Year_Make_Model", description: "A trim only means something relative to its own vehicle-year -- \"LTZ\" alone identifies nothing." },
    { name: "Trim_Name", type: "text", description: "\"LT\", \"High Country\", \"Lariat\"." },
    { name: "Trim_Level", type: "integer", description: "Ordinal rank within the range, so WT below LT below LTZ below High Country sorts correctly." },
    { name: "Notes", type: "text", description: "Anything worth saying about the trim that is not a spec." },
  ],
};

const BUILDS: TableDef = {
  name: "Builds",
  label: "Builds",
  group: "source",
  role: "One row per specific, orderable configuration.",
  description:
    "The leaf of the model, and deliberately sparse. A 2024 Silverado has roughly 1,700 valid combinations; nobody enumerates those and the loader does not generate them. A contributor who knows one real configuration adds one row. Everything here is a spec that is true only of a whole combination -- a 2018 Ram 3500 swings about 2,000 lb of tow rating on axle ratio alone, which is exactly why towing cannot live on the engine or the body.",
  csv: "data/builds.csv",
  orderBy: "Index",
  columns: [
    { name: "Index", type: "integer", key: "pk", description: "Assigned by the loader at build time." },
    { name: "YMM_Index", type: "integer", key: "fk", references: "Year_Make_Model", description: "The vehicle-year this configuration belongs to." },
    { name: "Trim_Index", type: "integer", key: "fk", references: "Trims", description: "The trim." },
    { name: "Body_Config_Index", type: "integer", key: "fk", references: "Body_Configs", description: "The body." },
    { name: "Powertrain_Index", type: "integer", key: "fk", references: "Powertrains", description: "The powertrain." },
    { name: "Transmission_Index", type: "integer", key: "fk", references: "Transmissions", description: "The transmission." },
    { name: "Drivetrain_Index", type: "integer", key: "fk", references: "Drivetrains", description: "The drivetrain." },
    { name: "Suspension_Index", type: "integer", key: "fk", references: "Suspensions", description: "The suspension." },
    { name: "Seating_Config_Index", type: "integer", key: "fk", references: "Seating_Configs", description: "The seating." },
    { name: "Axle_Ratio", type: "real", description: "Final drive ratio. One of the largest single influences on tow rating." },
    { name: "Equipment_Note", type: "text", description: "The options discriminator -- \"w/ Max Trailering Package\". Two otherwise identical builds can have genuinely different ratings because of one box on the order sheet." },
    { name: "Curb_Weight_lb", type: "integer", description: "As-delivered weight with fluids, no occupants or cargo." },
    { name: "GVWR_lb", type: "integer", description: "Maximum permitted loaded weight. Always above curb weight; the loader rejects a row where it is not." },
    { name: "GCWR_lb", type: "integer", description: "Maximum combined weight of vehicle and trailer together." },
    { name: "Payload_lb", type: "integer", description: "GVWR minus curb weight -- what you may actually put in it, occupants included." },
    { name: "Towing_Capacity_lb", type: "integer", description: "Maximum trailer weight for this exact configuration." },
    { name: "Tongue_Weight_lb", type: "integer", description: "Maximum download on the hitch, which is often the real limit rather than the tow rating." },
    { name: "EPA_City_mpg", type: "real", description: "EPA city figure." },
    { name: "EPA_Highway_mpg", type: "real", description: "EPA highway figure." },
    { name: "EPA_Combined_mpg", type: "real", description: "EPA combined figure." },
    { name: "EPA_Electric_Range_mi", type: "integer", description: "EPA electric range for this configuration." },
    { name: "Zero_To_Sixty_s", type: "real", description: "Manufacturer or instrumented-test figure." },
    { name: "Quarter_Mile_s", type: "real", description: "Elapsed time over a standing quarter mile." },
    { name: "Top_Speed_mph", type: "integer", description: "Limited or unlimited, as published." },
    { name: "Braking_60_0_ft", type: "integer", description: "Stopping distance from 60 mph." },
  ],
};

const BUILD_ROLLUP: TableDef = {
  name: "Build_Rollup",
  label: "Build Rollup",
  group: "derived",
  role: "One row per vehicle-year that has any recorded builds.",
  description:
    "The minimum and maximum of every numeric build spec, plus a summary of the trims offered. It exists so \"tows at least 10,000 lb\" is an indexed range scan rather than a subquery on the hot path. Keyed on the vehicle-year rather than on a configuration, so it answers \"this vehicle can be configured to tow X\" -- which is the question people actually ask.",
  orderBy: "YMM_Index",
  columns: [
    { name: "YMM_Index", type: "integer", key: "fk", references: "Year_Make_Model", description: "Also the primary key: one rollup row per vehicle-year." },
    { name: "Build_Count", type: "integer", description: "How many builds were rolled up. A low number means the range below is provisional rather than the whole story." },
    { name: "Min_Towing_Capacity_lb", type: "integer", description: "Lowest recorded tow rating." },
    { name: "Max_Towing_Capacity_lb", type: "integer", description: "Highest recorded tow rating -- what a \"can it tow X\" filter reads." },
    { name: "Min_Payload_lb", type: "integer", description: "Lowest recorded payload." },
    { name: "Max_Payload_lb", type: "integer", description: "Highest recorded payload." },
    { name: "Min_Curb_Weight_lb", type: "integer", description: "Lightest recorded configuration." },
    { name: "Max_Curb_Weight_lb", type: "integer", description: "Heaviest recorded configuration." },
    { name: "Min_GVWR_lb", type: "integer", description: "Lowest recorded GVWR." },
    { name: "Max_GVWR_lb", type: "integer", description: "Highest recorded GVWR." },
    { name: "Min_EPA_Combined_mpg", type: "real", description: "Thirstiest recorded configuration." },
    { name: "Max_EPA_Combined_mpg", type: "real", description: "Most efficient recorded configuration." },
    { name: "Min_Zero_To_Sixty_s", type: "real", description: "Quickest recorded configuration." },
    { name: "Max_Zero_To_Sixty_s", type: "real", description: "Slowest recorded configuration." },
    { name: "Trim_Summary", type: "text", description: "The trims that have builds recorded, in range order -- \"WT, LT, RST, LTZ\"." },
  ],
};

const FIELD_CHOICES: TableDef = {
  name: "Field_Choices",
  label: "Field Choices",
  group: "derived",
  role: "One row per distinct value of each searchable field.",
  description:
    "The dropdown contents, materialised at build time. Computing these live meant one GROUP BY per field over a multi-join view on every cold page load -- the most expensive query in the system, running before the visitor had done anything.",
  orderBy: "Field_Name",
  columns: [
    { name: "Field_Name", type: "text", description: "The public field name, as used in a search URL." },
    { name: "Value", type: "text", description: "Stored as text regardless of the field's own type, since one column holds values of every type." },
    { name: "N", type: "integer", description: "How many searchable rows carry this value. Used to order and size the dropdowns, not shown to the user." },
  ],
};

const SEARCH_VIEW: TableDef = {
  name: "Search_View",
  label: "Search View",
  group: "derived",
  role: "One row per searchable vehicle-and-powertrain combination.",
  description:
    "A flattened view over the source tables -- not a table, and never edited directly. It is a LEFT JOIN on purpose: a vehicle with no powertrain recorded yet still appears here, so an incomplete entry stays findable by make, model and year instead of vanishing from the site until someone fills the gap. Only the powertrain fans this view out; trims, bodies and configurations are reached by subquery instead, because two one-to-many joins in one view would multiply rows against each other.",
  orderBy: "Make",
  columns: [
    { name: "combo_index", type: "integer", key: "pk", description: "Unique per row. Falls back to the negative of the vehicle's own index when there is no powertrain pairing to number it." },
    { name: "ymm_index", type: "integer", key: "fk", references: "Year_Make_Model", description: "The vehicle-year this row describes." },
    { name: "powertrain_index", type: "integer", key: "fk", references: "Powertrains", description: "Empty exactly when no powertrain has been recorded for this vehicle yet." },
    { name: "engine_index", type: "integer", key: "fk", references: "Engine_Specs", description: "Empty both when nothing is recorded and when the powertrain genuinely has no engine, such as a BEV. Powertrain_Type is what tells those apart." },
    { name: "Make", type: "text", description: "From Year_Make_Model." },
    { name: "Model", type: "text", description: "From Year_Make_Model." },
    { name: "Year", type: "integer", description: "From Year_Make_Model." },
    { name: "Generation", type: "integer", description: "From Year_Make_Model." },
    { name: "Dev_Chassis_Code", type: "text", description: "From Year_Make_Model." },
    { name: "Platform_Code", type: "text", description: "From Year_Make_Model." },
    { name: "Nickname", type: "text", description: "From Year_Make_Model." },
    { name: "Powertrain_Type", type: "text", description: "From Powertrains." },
    { name: "Combined_Horsepower", type: "integer", description: "From Powertrains." },
    { name: "Combined_Torque_lbft", type: "integer", description: "From Powertrains." },
    { name: "Electric_Range_mi", type: "integer", description: "From Powertrains." },
    { name: "DC_Charge_kW", type: "integer", description: "From Powertrains." },
    { name: "AC_Charge_kW", type: "real", description: "From Powertrains." },
    { name: "Charge_Port", type: "text", description: "From Powertrains." },
    { name: "Manufacturer", type: "text", description: "From Engine_Specs." },
    { name: "Code", type: "text", description: "From Engine_Specs." },
    { name: "Named_Variant", type: "text", description: "From Engine_Specs." },
    { name: "Horsepower", type: "integer", description: "From Engine_Specs." },
    { name: "Torque_lbft", type: "integer", description: "From Engine_Specs." },
    { name: "Layout", type: "text", description: "From Engine_Specs." },
    { name: "Cylinders", type: "integer", description: "From Engine_Specs." },
    { name: "CC_Displacement", type: "integer", description: "From Engine_Specs." },
    { name: "Aspiration", type: "text", description: "From Engine_Specs." },
    { name: "Fuel_Type", type: "text", description: "From Engine_Specs." },
    { name: "Compression_ratio", type: "text", description: "From Engine_Specs." },
    { name: "Fuel_delivery", type: "text", description: "From Engine_Specs." },
    { name: "Valvetrain", type: "text", description: "From Engine_Specs." },
    { name: "Redline_RPM", type: "integer", description: "From Engine_Specs." },
    { name: "Fuel_Requirement", type: "text", description: "From Engine_Specs." },
    { name: "Battery_Chemistry", type: "text", description: "From Batteries." },
    { name: "Battery_Gross_kWh", type: "real", description: "From Batteries." },
    { name: "Battery_Usable_kWh", type: "real", description: "From Batteries." },
    { name: "Max_Towing_Capacity_lb", type: "integer", description: "From Build_Rollup." },
    { name: "Max_Payload_lb", type: "integer", description: "From Build_Rollup." },
    { name: "Min_Curb_Weight_lb", type: "integer", description: "From Build_Rollup." },
    { name: "Max_Curb_Weight_lb", type: "integer", description: "From Build_Rollup." },
    { name: "Max_GVWR_lb", type: "integer", description: "From Build_Rollup." },
    { name: "Max_EPA_Combined_mpg", type: "real", description: "From Build_Rollup." },
    { name: "Min_Zero_To_Sixty_s", type: "real", description: "From Build_Rollup." },
    { name: "Trim_Summary", type: "text", description: "From Build_Rollup." },
    { name: "Build_Count", type: "integer", description: "From Build_Rollup. Zero or empty means no configurations have been recorded for this vehicle." },
    { name: "Search_Text", type: "text", description: "Year, make and model concatenated, so a free-text query can match across all three without knowing which is which." },
  ],
};

/** Every browsable table, in the order the docs page should present them. */
export const TABLES: readonly TableDef[] = [
  YEAR_MAKE_MODEL,
  ENGINE_SPECS,
  ELECTRIC_MOTORS,
  BATTERIES,
  POWERTRAINS,
  POWERTRAIN_MOTORS,
  YMM_POWERTRAINS,
  TRANSMISSIONS,
  DRIVETRAINS,
  SUSPENSIONS,
  BODY_CONFIGS,
  YMM_BODY_CONFIGS,
  SEATING_CONFIGS,
  INTERIOR_DIMENSIONS,
  TRIMS,
  BUILDS,
  SEARCH_VIEW,
  BUILD_ROLLUP,
  FIELD_CHOICES,
] as const;

export const TABLE_BY_NAME: ReadonlyMap<string, TableDef> = new Map(
  TABLES.map((t) => [t.name.toLowerCase(), t]),
);

/**
 * Resolve a requested table name. Throws on anything not in the registry --
 * which is what keeps a request from ever naming a table the site did not
 * choose to expose.
 */
export function getTable(name: string): TableDef {
  const t = TABLE_BY_NAME.get(name.toLowerCase());
  if (!t) throw new Error(`Unknown table: ${name}`);
  return t;
}
