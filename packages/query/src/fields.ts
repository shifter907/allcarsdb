/**
 * The searchable field registry.
 *
 * This is the *only* place a public field name is mapped to a database column.
 * Nothing else in the query path concatenates an identifier into SQL, which is
 * what makes the compiler injection-safe by construction: a field name either
 * appears in this table or the request is rejected.
 *
 * It also doubles as the API's self-documentation -- `GET /v1/fields` returns
 * this registry, so the UI builds its filter panel from the server's own
 * definition rather than a hand-maintained copy that drifts.
 *
 * Two axes decide how a field reaches SQL, and they are deliberately separate:
 *
 *   `source` is mechanical -- which relation holds the column, and therefore
 *   whether the compiler emits a plain WHERE or wraps the predicate in an
 *   EXISTS. See SOURCES below.
 *
 *   `grain` is semantic -- what a row means. A `vehicle` field describes the
 *   car, a `powertrain` field describes the engine in it, a `build` field
 *   describes one specific orderable configuration. It is what tells the UI
 *   whether a filter narrows to cars or to configurations of a car.
 *
 * Columns for `source: 'view'` resolve against `Search_View`, the flattened
 * join. See packages/db/migrations/0000_schema.sql.
 */

import type { Quantity } from './units.js';

export type FieldKind = 'number' | 'text';

/** Which relation a field's column lives on. Closed set, never user-supplied. */
export type SourceId =
  | 'view'
  | 'build'
  | 'body'
  | 'interior'
  | 'trim'
  | 'transmission'
  | 'drivetrain'
  | 'suspension'
  | 'seating';

/** What one row described by this field represents. */
export type Grain = 'vehicle' | 'powertrain' | 'build';

export interface SourceDef {
  /** `base` columns are on Search_View; everything else is a semi-join. */
  kind: 'base' | 'exists';
  /** Alias the predicate's column is qualified with, for `exists` sources. */
  alias?: string;
  /**
   * The root relation of the semi-join -- the one the correlation attaches to.
   * Kept separate from `joins` because the two are assembled in different
   * orders depending on the shape being built: an EXISTS puts the correlation
   * in its WHERE, while a facet has to attach it as the JOIN's ON clause. One
   * combined string cannot serve both without producing `JOIN a JOIN b ON x ON y`.
   */
  from?: string;
  /** Any further joins onto the root relation. Applied verbatim after it. */
  joins?: string;
  /** Predicate tying the root relation back to the outer Search_View row. */
  correlate?: string;
}

/**
 * How each source reaches the outer row.
 *
 * Everything correlates on `Search_View.ymm_index` -- the vehicle-year -- so a
 * build-level filter means "this vehicle can be configured this way", which is
 * the question people actually ask, and it agrees with how Build_Rollup is
 * keyed. Correlating on the powertrain as well would make a build filter
 * silently disagree with the rollup fast path for the same question.
 */
export const SOURCES: Record<SourceId, SourceDef> = {
  view: { kind: 'base' },
  build: {
    kind: 'exists',
    alias: 'b',
    from: 'Builds b',
    correlate: 'b.YMM_Index = Search_View.ymm_index',
  },
  body: {
    kind: 'exists',
    alias: 'bc',
    from: 'YMM_Body_Configs ybc',
    joins: 'JOIN Body_Configs bc ON bc."Index" = ybc.Body_Config_Index',
    correlate: 'ybc.YMM_Index = Search_View.ymm_index',
  },
  interior: {
    kind: 'exists',
    alias: 'idim',
    from: 'YMM_Body_Configs ybc2',
    joins: 'JOIN Interior_Dimensions idim ON idim.Body_Config_Index = ybc2.Body_Config_Index',
    correlate: 'ybc2.YMM_Index = Search_View.ymm_index',
  },
  trim: {
    kind: 'exists',
    alias: 'tr',
    from: 'Trims tr',
    correlate: 'tr.YMM_Index = Search_View.ymm_index',
  },
  transmission: {
    kind: 'exists',
    alias: 'tx',
    from: 'Builds btx',
    joins: 'JOIN Transmissions tx ON tx."Index" = btx.Transmission_Index',
    correlate: 'btx.YMM_Index = Search_View.ymm_index',
  },
  drivetrain: {
    kind: 'exists',
    alias: 'dt',
    from: 'Builds bdt',
    joins: 'JOIN Drivetrains dt ON dt."Index" = bdt.Drivetrain_Index',
    correlate: 'bdt.YMM_Index = Search_View.ymm_index',
  },
  suspension: {
    kind: 'exists',
    alias: 'sus',
    from: 'Builds bsus',
    joins: 'JOIN Suspensions sus ON sus."Index" = bsus.Suspension_Index',
    correlate: 'bsus.YMM_Index = Search_View.ymm_index',
  },
  seating: {
    kind: 'exists',
    alias: 'sc',
    from: 'Builds bsc',
    joins: 'JOIN Seating_Configs sc ON sc."Index" = bsc.Seating_Config_Index',
    correlate: 'bsc.YMM_Index = Search_View.ymm_index',
  },
};

export interface FieldDef {
  /** Public name used in the API and URL. */
  name: string;
  /** Column on the field's source relation. Never user-controlled. */
  column: string;
  kind: FieldKind;
  label: string;
  quantity?: Quantity;
  /** Grouping for the filter UI. */
  group: string;
  /** Which relation holds the column. Defaults to the base view. */
  source?: SourceId;
  /** What a row means. Defaults to the vehicle. */
  grain?: Grain;
  /** Show in the default filter panel rather than under "more filters". */
  common?: boolean;
  /** Plausible bounds, used for slider ranges and to catch nonsense input. */
  min?: number;
  max?: number;
  description?: string;
}

const F = (d: FieldDef): FieldDef => d;

export const FIELDS: readonly FieldDef[] = [
  // --- Vehicle --------------------------------------------------------------
  F({ name: 'make', column: 'Make', kind: 'text', label: 'Make', group: 'vehicle', common: true }),
  F({ name: 'model', column: 'Model', kind: 'text', label: 'Model', group: 'vehicle', common: true }),
  F({ name: 'year', column: 'Year', kind: 'number', label: 'Model Year', group: 'vehicle', common: true, min: 1885, max: 2100 }),
  F({ name: 'generation', column: 'Generation', kind: 'number', label: 'Generation', group: 'vehicle', min: 1, max: 50, description: 'Ordinal generation number for this nameplate -- 4, not "E46". Often unset.' }),
  F({ name: 'dev_chassis_code', column: 'Dev_Chassis_Code', kind: 'text', label: 'Chassis Code', group: 'vehicle', description: 'Manufacturer development code for this generation -- "E46", "992", "ND".' }),
  F({ name: 'platform_code', column: 'Platform_Code', kind: 'text', label: 'Platform', group: 'vehicle', description: 'Shared architecture code -- can span multiple nameplates, unlike the chassis code.' }),
  F({ name: 'nickname', column: 'Nickname', kind: 'text', label: 'Nickname', group: 'vehicle', description: 'What people actually call it -- "OBS" for the 1992-1996 F-150 -- when that differs from the official name.' }),

  // --- Powertrain -----------------------------------------------------------
  F({ name: 'powertrain_type', column: 'Powertrain_Type', kind: 'text', label: 'Powertrain', group: 'powertrain', grain: 'powertrain', common: true, description: 'ICE, hybrid, plug-in hybrid, battery-electric, fuel cell.' }),
  F({ name: 'combined_horsepower', column: 'Combined_Horsepower', kind: 'number', quantity: 'power', label: 'Combined Horsepower', group: 'powertrain', grain: 'powertrain', min: 0, max: 5000, description: 'Total system output. Set for hybrids and EVs, where no single engine figure describes the car.' }),
  F({ name: 'combined_torque', column: 'Combined_Torque_lbft', kind: 'number', quantity: 'torque', label: 'Combined Torque', group: 'powertrain', grain: 'powertrain', min: 0, max: 20000 }),
  F({ name: 'electric_range', column: 'Electric_Range_mi', kind: 'number', quantity: 'length', label: 'Electric Range', group: 'powertrain', grain: 'powertrain', min: 0, max: 2000, description: 'EPA electric-only range, in miles.' }),
  F({ name: 'dc_charge_kw', column: 'DC_Charge_kW', kind: 'number', label: 'DC Fast Charge (kW)', group: 'powertrain', grain: 'powertrain', min: 0, max: 2000 }),
  F({ name: 'charge_port', column: 'Charge_Port', kind: 'text', label: 'Charge Port', group: 'powertrain', grain: 'powertrain', description: 'NACS, CCS, CHAdeMO.' }),
  F({ name: 'battery_chemistry', column: 'Battery_Chemistry', kind: 'text', label: 'Battery Chemistry', group: 'powertrain', grain: 'powertrain', description: 'NMC, LFP, NiMH, NCA.' }),
  F({ name: 'battery_usable_kwh', column: 'Battery_Usable_kWh', kind: 'number', label: 'Usable Battery (kWh)', group: 'powertrain', grain: 'powertrain', min: 0, max: 1000, description: 'What the car will actually draw, which is less than the pack\'s gross capacity.' }),

  // --- Engine ---------------------------------------------------------------
  F({ name: 'manufacturer', column: 'Manufacturer', kind: 'text', label: 'Engine Manufacturer', group: 'engine', grain: 'powertrain', common: true, description: 'Who built the engine -- not always the vehicle\'s own Make. The BMW B58 shows up under the Toyota GR Supra.' }),
  F({ name: 'code', column: 'Code', kind: 'text', label: 'Engine Code', group: 'engine', grain: 'powertrain', description: 'The manufacturer\'s own designation for the engine family -- "N54", "L76", "LQ9".' }),
  F({ name: 'named_variant', column: 'Named_Variant', kind: 'text', label: 'Engine Variant', group: 'engine', grain: 'powertrain', description: 'A named differentiator appended to the code -- "B30" for the N54B30, or a tuner name like "Alpina". Most engines don\'t have one.' }),
  F({ name: 'layout', column: 'Layout', kind: 'text', label: 'Layout', group: 'engine', grain: 'powertrain', common: true, description: 'Cylinder arrangement -- inline, V, flat, W, rotary.' }),
  F({ name: 'cylinders', column: 'Cylinders', kind: 'number', label: 'Cylinders', group: 'engine', grain: 'powertrain', common: true, min: 0, max: 32 }),
  F({
    name: 'displacement',
    column: 'CC_Displacement',
    kind: 'number',
    quantity: 'displacement',
    label: 'Displacement',
    group: 'engine',
    grain: 'powertrain',
    common: true,
    min: 0,
    max: 200000,
    description: 'Stored in cc.',
  }),
  F({ name: 'aspiration', column: 'Aspiration', kind: 'text', label: 'Aspiration', group: 'engine', grain: 'powertrain', common: true, description: 'Naturally aspirated, turbocharged, supercharged, twin-turbo.' }),
  F({ name: 'fuel_type', column: 'Fuel_Type', kind: 'text', label: 'Fuel Type', group: 'engine', grain: 'powertrain', common: true }),
  F({ name: 'compression_ratio', column: 'Compression_ratio', kind: 'text', label: 'Compression Ratio', group: 'engine', grain: 'powertrain', description: 'Recorded as written, e.g. "10.5:1".' }),
  F({ name: 'fuel_delivery', column: 'Fuel_delivery', kind: 'text', label: 'Fuel Delivery', group: 'engine', grain: 'powertrain', description: 'Direct injection, port injection, carburettor.' }),
  F({ name: 'valvetrain', column: 'Valvetrain', kind: 'text', label: 'Valvetrain', group: 'engine', grain: 'powertrain', description: 'OHV, SOHC, DOHC.' }),
  F({ name: 'redline', column: 'Redline_RPM', kind: 'number', label: 'Redline (rpm)', group: 'engine', grain: 'powertrain', min: 0, max: 25000 }),
  F({ name: 'fuel_requirement', column: 'Fuel_Requirement', kind: 'text', label: 'Fuel Required', group: 'engine', grain: 'powertrain', description: 'What the engine requires, which is a different question from what fuel it burns.' }),
  F({
    name: 'horsepower',
    column: 'Horsepower',
    kind: 'number',
    quantity: 'power',
    label: 'Horsepower',
    group: 'engine',
    grain: 'powertrain',
    common: true,
    min: 0,
    max: 3000,
    description: 'SAE net (or the manufacturer\'s official published figure). Stored in hp.',
  }),
  F({
    name: 'torque',
    column: 'Torque_lbft',
    kind: 'number',
    quantity: 'torque',
    label: 'Torque',
    group: 'engine',
    grain: 'powertrain',
    common: true,
    min: 0,
    max: 5000,
    description: 'SAE net (or the manufacturer\'s official published figure). Stored in lb-ft.',
  }),

  // --- Transmission / drivetrain / suspension -------------------------------
  F({ name: 'transmission_type', column: 'Type', kind: 'text', label: 'Transmission', group: 'drivetrain', source: 'transmission', grain: 'build', common: true, description: 'Manual, automatic, CVT, DCT.' }),
  F({ name: 'forward_gears', column: 'Forward_Gears', kind: 'number', label: 'Gears', group: 'drivetrain', source: 'transmission', grain: 'build', min: 1, max: 12 }),
  F({ name: 'transmission_code', column: 'Code', kind: 'text', label: 'Transmission Code', group: 'drivetrain', source: 'transmission', grain: 'build', description: '"10R80", "8L90", "ZF 8HP".' }),
  F({ name: 'drive_layout', column: 'Layout', kind: 'text', label: 'Drive Layout', group: 'drivetrain', source: 'drivetrain', grain: 'build', common: true, description: 'RWD, FWD, AWD, 4WD.' }),
  F({ name: 'transfer_case_type', column: 'Transfer_Case_Type', kind: 'text', label: 'Transfer Case', group: 'drivetrain', source: 'drivetrain', grain: 'build', description: 'Part-time, full-time, selectable. Decides whether 4WD is usable on dry pavement.' }),
  F({ name: 'front_hub_type', column: 'Front_Hub_Type', kind: 'text', label: 'Locking Hubs', group: 'drivetrain', source: 'drivetrain', grain: 'build', description: 'Manual locking, auto locking, fixed.' }),
  F({ name: 'center_differential', column: 'Center_Differential', kind: 'text', label: 'Center Differential', group: 'drivetrain', source: 'drivetrain', grain: 'build', description: 'Open, locking, Torsen, viscous, clutch-pack.' }),
  F({ name: 'rear_diff_type', column: 'Rear_Diff_Type', kind: 'text', label: 'Rear Differential', group: 'drivetrain', source: 'drivetrain', grain: 'build' }),
  F({ name: 'front_suspension', column: 'Front_Type', kind: 'text', label: 'Front Suspension', group: 'drivetrain', source: 'suspension', grain: 'build', description: 'MacPherson, double wishbone, multi-link, solid axle.' }),
  F({ name: 'rear_suspension', column: 'Rear_Type', kind: 'text', label: 'Rear Suspension', group: 'drivetrain', source: 'suspension', grain: 'build', description: 'Multi-link, live axle, leaf, torsion beam, air.' }),
  F({ name: 'damping', column: 'Damping', kind: 'text', label: 'Damping', group: 'drivetrain', source: 'suspension', grain: 'build', description: 'Passive, adaptive, magnetorheological.' }),

  // --- Body -----------------------------------------------------------------
  F({ name: 'body_style', column: 'Body_Style', kind: 'text', label: 'Body Style', group: 'body', source: 'body', grain: 'vehicle', common: true, description: 'Sedan, coupe, SUV, pickup, wagon, van.' }),
  F({ name: 'doors', column: 'Doors', kind: 'number', label: 'Doors', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 8 }),
  F({ name: 'cab_config', column: 'Cab_Config', kind: 'text', label: 'Cab', group: 'body', source: 'body', grain: 'vehicle', description: 'Regular, extended, double, crew, mega. Trucks only.' }),
  F({ name: 'bed_length', column: 'Bed_Length_in', kind: 'number', quantity: 'length', label: 'Bed Length', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 400 }),
  F({ name: 'wheelbase', column: 'Wheelbase_in', kind: 'number', quantity: 'length', label: 'Wheelbase', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 400 }),
  F({ name: 'length', column: 'Length_in', kind: 'number', quantity: 'length', label: 'Overall Length', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 600 }),
  F({ name: 'width', column: 'Width_in', kind: 'number', quantity: 'length', label: 'Width', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 200 }),
  F({ name: 'height', column: 'Height_in', kind: 'number', quantity: 'length', label: 'Height', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 200 }),
  F({ name: 'ground_clearance', column: 'Ground_Clearance_in', kind: 'number', quantity: 'length', label: 'Ground Clearance', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 60 }),
  F({ name: 'approach_angle', column: 'Approach_Angle_deg', kind: 'number', label: 'Approach Angle', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 90 }),
  F({ name: 'departure_angle', column: 'Departure_Angle_deg', kind: 'number', label: 'Departure Angle', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 90 }),
  F({ name: 'cargo_volume', column: 'Cargo_Volume_cuft', kind: 'number', label: 'Cargo Volume (cu ft)', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 1000 }),
  F({ name: 'fuel_capacity', column: 'Fuel_Capacity_gal', kind: 'number', label: 'Fuel Capacity (gal)', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 200 }),
  F({ name: 'drag_coefficient', column: 'Drag_Coefficient', kind: 'number', label: 'Drag Coefficient', group: 'body', source: 'body', grain: 'vehicle', min: 0, max: 2 }),

  // --- Interior -------------------------------------------------------------
  F({ name: 'headroom', column: 'Headroom_in', kind: 'number', quantity: 'length', label: 'Headroom', group: 'interior', source: 'interior', grain: 'vehicle', min: 0, max: 100, description: 'SAE J1100, any seating row.' }),
  F({ name: 'legroom', column: 'Legroom_in', kind: 'number', quantity: 'length', label: 'Legroom', group: 'interior', source: 'interior', grain: 'vehicle', min: 0, max: 100, description: 'SAE J1100, any seating row.' }),
  F({ name: 'shoulder_room', column: 'Shoulder_Room_in', kind: 'number', quantity: 'length', label: 'Shoulder Room', group: 'interior', source: 'interior', grain: 'vehicle', min: 0, max: 100 }),
  F({ name: 'hip_room', column: 'Hip_Room_in', kind: 'number', quantity: 'length', label: 'Hip Room', group: 'interior', source: 'interior', grain: 'vehicle', min: 0, max: 100 }),
  F({ name: 'seating_capacity', column: 'Capacity', kind: 'number', label: 'Seating Capacity', group: 'interior', source: 'seating', grain: 'build', min: 1, max: 20 }),
  F({ name: 'second_row_type', column: 'Second_Row_Type', kind: 'text', label: 'Second Row', group: 'interior', source: 'seating', grain: 'build', description: 'Bench or captain\'s chairs.' }),

  // --- Trim -----------------------------------------------------------------
  F({ name: 'trim', column: 'Trim_Name', kind: 'text', label: 'Trim', group: 'trim', source: 'trim', grain: 'vehicle', description: 'Filters to vehicles offering this trim. Trims are not fanned out into separate results.' }),

  // --- Capability (build level) ---------------------------------------------
  // These are the specs that are only true of a whole configuration. The
  // columns named here are the Build_Rollup maxima on Search_View, so the
  // common "can it tow 10,000 lb" question is a plain indexed range scan
  // rather than a subquery. Filtering several of them at once with
  // `combine: 'same_build'` switches to a shared EXISTS over Builds.
  F({ name: 'towing_capacity', column: 'Max_Towing_Capacity_lb', kind: 'number', quantity: 'mass', label: 'Max Towing', group: 'capability', grain: 'build', common: true, min: 0, max: 100000, description: 'The most this vehicle can be configured to tow. Varies with engine, cab, bed, drivetrain and axle ratio together.' }),
  F({ name: 'payload', column: 'Max_Payload_lb', kind: 'number', quantity: 'mass', label: 'Max Payload', group: 'capability', grain: 'build', min: 0, max: 50000 }),
  F({ name: 'curb_weight', column: 'Min_Curb_Weight_lb', kind: 'number', quantity: 'mass', label: 'Curb Weight (lightest)', group: 'capability', grain: 'build', min: 0, max: 100000 }),
  F({ name: 'gvwr', column: 'Max_GVWR_lb', kind: 'number', quantity: 'mass', label: 'Max GVWR', group: 'capability', grain: 'build', min: 0, max: 100000 }),
  F({ name: 'fuel_economy', column: 'Max_EPA_Combined_mpg', kind: 'number', label: 'Best EPA Combined (mpg)', group: 'capability', grain: 'build', min: 0, max: 250, description: 'EPA combined figure for the most efficient recorded configuration. Electric vehicles carry MPGe, which EPA publishes on this same scale so the two can be compared -- which is why an EV reads well above any combustion car here.' }),
  F({ name: 'zero_to_sixty', column: 'Min_Zero_To_Sixty_s', kind: 'number', quantity: 'time', label: 'Quickest 0-60 (s)', group: 'capability', grain: 'build', min: 0, max: 60 }),
  // Reached through the Builds table rather than the rollup, because these have
  // no single "best" that means anything -- an axle ratio maximum is not a
  // useful fact about a vehicle, but "offered with 3.73 gears" is.
  F({ name: 'axle_ratio', column: 'Axle_Ratio', kind: 'number', label: 'Axle Ratio', group: 'capability', source: 'build', grain: 'build', min: 0, max: 15, description: 'Final drive ratio. A truck\'s tow rating can swing 2,000 lb on this alone.' }),
] as const;

export const FIELD_BY_NAME: ReadonlyMap<string, FieldDef> = new Map(FIELDS.map((f) => [f.name, f]));

export function getField(name: string): FieldDef {
  const f = FIELD_BY_NAME.get(name);
  if (!f) throw new Error(`Unknown field: ${name}`);
  return f;
}

/** Resolve a field's source definition. Always a key of the closed SOURCES map. */
export function sourceOf(field: FieldDef): SourceDef {
  return SOURCES[field.source ?? 'view'];
}

/** Field groups in the order the filter panel should present them. */
export const FIELD_GROUPS = [
  'vehicle',
  'powertrain',
  'engine',
  'drivetrain',
  'body',
  'interior',
  'capability',
  'trim',
] as const;
