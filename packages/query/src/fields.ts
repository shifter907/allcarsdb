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
 */

import type { Quantity } from './units.js';
import { ENUM_REGISTRY, type EnumName } from '@allcarsdb/schema/enums';

export type FieldKind = 'number' | 'enum' | 'bool' | 'text';

export interface FieldDef {
  /** Public name used in the API and URL. */
  name: string;
  /** Column in `variant_search`. Never user-controlled. */
  column: string;
  kind: FieldKind;
  label: string;
  quantity?: Quantity;
  /** Which controlled vocabulary an enum field draws from. */
  enumName?: EnumName;
  /** Grouping for the filter UI. */
  group: string;
  /** Show in the default filter panel rather than under "more filters". */
  common?: boolean;
  /** Plausible bounds, used for slider ranges and to catch nonsense input. */
  min?: number;
  max?: number;
  description?: string;
}

const F = (d: FieldDef): FieldDef => d;

export const FIELDS: readonly FieldDef[] = [
  // --- Identity -------------------------------------------------------------
  F({ name: 'year', column: 'year', kind: 'number', label: 'Model Year', group: 'identity', common: true, min: 1885, max: 2100 }),
  F({ name: 'make_id', column: 'make_id', kind: 'number', label: 'Make', group: 'identity', common: true }),
  F({ name: 'model_id', column: 'model_id', kind: 'number', label: 'Model', group: 'identity', common: true }),
  F({ name: 'market', column: 'market_code', kind: 'enum', enumName: 'market', label: 'Market', group: 'identity', common: true }),

  // --- Body -----------------------------------------------------------------
  F({ name: 'body_category', column: 'body_category_code', kind: 'enum', enumName: 'body_category', label: 'Body Style', group: 'body', common: true }),
  F({ name: 'roof_type', column: 'roof_code', kind: 'enum', enumName: 'roof_type', label: 'Roof Type', group: 'body', common: true, description: 'Distinguishes a folding hardtop from a fabric soft top or a targa.' }),
  F({ name: 'cab_style', column: 'cab_code', kind: 'enum', enumName: 'cab_style', label: 'Cab Style', group: 'body' }),
  F({ name: 'doors', column: 'doors', kind: 'number', label: 'Doors', group: 'body', common: true, min: 0, max: 6 }),
  F({ name: 'seat_rows', column: 'seat_rows', kind: 'number', label: 'Rows of Seats', group: 'body', min: 1, max: 4 }),
  F({ name: 'seating_capacity', column: 'seating_capacity', kind: 'number', label: 'Seats', group: 'body', common: true, min: 1, max: 20 }),

  // --- Engine ---------------------------------------------------------------
  F({ name: 'cylinders', column: 'cylinders', kind: 'number', label: 'Cylinders', group: 'engine', common: true, min: 0, max: 16 }),
  F({ name: 'engine_layout', column: 'engine_layout_code', kind: 'enum', enumName: 'engine_layout', label: 'Engine Layout', group: 'engine', common: true }),
  F({ name: 'displacement', column: 'displacement_cc', kind: 'number', quantity: 'volume', label: 'Displacement', group: 'engine', common: true, min: 0, max: 30000, description: 'Stored in cc. Accepts l/cc/cuin.' }),
  F({ name: 'valves_total', column: 'valves_total', kind: 'number', label: 'Total Valves', group: 'engine', common: true, min: 0, max: 64 }),
  F({ name: 'valves_per_cylinder', column: 'valves_per_cylinder', kind: 'number', label: 'Valves per Cylinder', group: 'engine', min: 0, max: 8 }),
  F({ name: 'cam_config', column: 'cam_config_code', kind: 'enum', enumName: 'cam_config', label: 'Camshaft Configuration', group: 'engine' }),
  F({ name: 'aspiration', column: 'aspiration_code', kind: 'enum', enumName: 'aspiration', label: 'Aspiration', group: 'engine', common: true }),
  F({ name: 'fuel_type', column: 'fuel_type_code', kind: 'enum', enumName: 'fuel_type', label: 'Fuel Type', group: 'engine', common: true }),
  F({ name: 'fuel_delivery', column: 'fuel_delivery_code', kind: 'enum', enumName: 'fuel_delivery', label: 'Fuel Delivery', group: 'engine' }),
  F({ name: 'compression_ratio', column: 'compression_ratio', kind: 'number', label: 'Compression Ratio', group: 'engine', min: 4, max: 25 }),
  F({ name: 'redline', column: 'redline_rpm', kind: 'number', label: 'Redline', group: 'engine', min: 0, max: 22000 }),

  // --- Electrification ------------------------------------------------------
  F({ name: 'hybrid_type', column: 'hybrid_type_code', kind: 'enum', enumName: 'hybrid_type', label: 'Electrification', group: 'powertrain', common: true }),
  F({ name: 'motor_count', column: 'motor_count', kind: 'number', label: 'Electric Motors', group: 'powertrain', min: 0, max: 4 }),
  F({ name: 'battery_capacity', column: 'battery_net_kwh', kind: 'number', quantity: 'energy', label: 'Usable Battery', group: 'powertrain', min: 0, max: 300 }),
  F({ name: 'battery_voltage', column: 'battery_architecture_volts', kind: 'number', label: 'Battery Architecture', group: 'powertrain', min: 0, max: 1000 }),

  // --- Transmission & driveline --------------------------------------------
  F({ name: 'transmission_type', column: 'transmission_type_code', kind: 'enum', enumName: 'transmission_type', label: 'Transmission', group: 'powertrain', common: true }),
  F({ name: 'gears', column: 'forward_gears', kind: 'number', label: 'Forward Gears', group: 'powertrain', min: 1, max: 12 }),
  F({ name: 'drivetrain', column: 'drivetrain_type_code', kind: 'enum', enumName: 'drivetrain_type', label: 'Drivetrain', group: 'powertrain', common: true }),
  F({ name: 'low_range', column: 'has_low_range', kind: 'bool', label: 'Low Range Transfer Case', group: 'powertrain' }),
  F({ name: 'rear_locker', column: 'rear_locker', kind: 'bool', label: 'Rear Locking Differential', group: 'powertrain' }),

  // --- Output ---------------------------------------------------------------
  F({ name: 'horsepower', column: 'combined_hp', kind: 'number', quantity: 'power', label: 'Horsepower', group: 'performance', common: true, min: 0, max: 2500 }),
  F({ name: 'torque', column: 'combined_torque_lbft', kind: 'number', quantity: 'torque', label: 'Torque', group: 'performance', common: true, min: 0, max: 3000 }),
  F({ name: 'hp_per_liter', column: 'hp_per_liter', kind: 'number', label: 'Specific Output (hp/L)', group: 'performance', min: 0, max: 400 }),
  F({ name: 'hp_per_tonne', column: 'hp_per_tonne', kind: 'number', label: 'Power to Weight (hp/tonne)', group: 'performance', min: 0, max: 1500 }),

  // --- Exterior -------------------------------------------------------------
  // The `min` values below are plausibility floors, not data floors. They are
  // what makes an unqualified `length: 4.5` (someone thinking in metres and
  // forgetting the unit) an error rather than a silent match against every car
  // longer than four and a half millimetres.
  F({ name: 'length', column: 'length_mm', kind: 'number', quantity: 'length', label: 'Overall Length', group: 'exterior', common: true, min: 1000, max: 20000 }),
  F({ name: 'width', column: 'width_mm', kind: 'number', quantity: 'length', label: 'Width (excl. mirrors)', group: 'exterior', common: true, min: 700, max: 4000 }),
  F({ name: 'height', column: 'height_mm', kind: 'number', quantity: 'length', label: 'Height', group: 'exterior', common: true, min: 500, max: 4500 }),
  F({ name: 'wheelbase', column: 'wheelbase_mm', kind: 'number', quantity: 'length', label: 'Wheelbase', group: 'exterior', min: 800, max: 6000 }),
  F({ name: 'ground_clearance', column: 'ground_clearance_mm', kind: 'number', quantity: 'length', label: 'Ground Clearance', group: 'exterior', common: true, min: 20, max: 800 }),
  F({ name: 'curb_weight', column: 'curb_weight_kg', kind: 'number', quantity: 'mass', label: 'Curb Weight', group: 'exterior', common: true, min: 50, max: 6000 }),
  F({ name: 'drag_coefficient', column: 'drag_coefficient', kind: 'number', label: 'Drag Coefficient (Cd)', group: 'exterior', min: 0.1, max: 1.2 }),
  F({ name: 'approach_angle', column: 'approach_angle_deg', kind: 'number', quantity: 'angle', label: 'Approach Angle', group: 'exterior', min: 0, max: 90 }),
  F({ name: 'departure_angle', column: 'departure_angle_deg', kind: 'number', quantity: 'angle', label: 'Departure Angle', group: 'exterior', min: 0, max: 90 }),

  // --- Interior -------------------------------------------------------------
  F({ name: 'seat_height', column: 'seat_height_front_mm', kind: 'number', quantity: 'length', label: 'Front Seat Height (H-point)', group: 'interior', common: true, min: 100, max: 1500, description: 'Height of the seat hip point above the ground -- how far you drop into, or climb up to, the driver seat.' }),
  F({ name: 'headroom_front', column: 'headroom_front_mm', kind: 'number', quantity: 'length', label: 'Front Headroom', group: 'interior', common: true, min: 300, max: 1500 }),
  F({ name: 'legroom_front', column: 'legroom_front_mm', kind: 'number', quantity: 'length', label: 'Front Legroom', group: 'interior', common: true, min: 300, max: 1500 }),
  F({ name: 'legroom_second', column: 'legroom_second_mm', kind: 'number', quantity: 'length', label: 'Second Row Legroom', group: 'interior', common: true, min: 200, max: 1500 }),
  F({ name: 'legroom_third', column: 'legroom_third_mm', kind: 'number', quantity: 'length', label: 'Third Row Legroom', group: 'interior', min: 200, max: 1500 }),
  F({ name: 'passenger_volume', column: 'passenger_volume_l', kind: 'number', quantity: 'volume', label: 'Passenger Volume', group: 'interior', min: 0, max: 8000 }),
  F({ name: 'cargo_behind_first', column: 'cargo_behind_first_l', kind: 'number', quantity: 'volume', label: 'Cargo (all rows folded)', group: 'interior', common: true, min: 0, max: 10000 }),
  F({ name: 'cargo_behind_second', column: 'cargo_behind_second_l', kind: 'number', quantity: 'volume', label: 'Cargo behind 2nd Row', group: 'interior', common: true, min: 0, max: 10000 }),
  F({ name: 'cargo_behind_third', column: 'cargo_behind_third_l', kind: 'number', quantity: 'volume', label: 'Cargo behind 3rd Row', group: 'interior', min: 0, max: 5000 }),
  F({ name: 'frunk', column: 'cargo_frunk_l', kind: 'number', quantity: 'volume', label: 'Front Trunk', group: 'interior', min: 0, max: 1000 }),

  // --- Performance ----------------------------------------------------------
  F({ name: 'zero_to_60', column: 'zero_to_60_mph_s', kind: 'number', quantity: 'time', label: '0-60 mph', group: 'performance', common: true, min: 0, max: 60 }),
  F({ name: 'quarter_mile', column: 'quarter_mile_s', kind: 'number', quantity: 'time', label: 'Quarter Mile', group: 'performance', min: 0, max: 40 }),
  F({ name: 'top_speed', column: 'top_speed_kph', kind: 'number', quantity: 'speed', label: 'Top Speed', group: 'performance', common: true, min: 0, max: 550 }),
  F({ name: 'braking_60_0', column: 'braking_60_0_ft', kind: 'number', quantity: 'length', label: '60-0 mph Braking', group: 'performance', min: 0, max: 400 }),
  F({ name: 'lateral_g', column: 'lateral_g', kind: 'number', label: 'Skidpad (g)', group: 'performance', min: 0, max: 2.5 }),

  // --- Efficiency -----------------------------------------------------------
  F({ name: 'mpg_combined', column: 'mpg_combined', kind: 'number', quantity: 'economy', label: 'Combined MPG (EPA)', group: 'efficiency', common: true, min: 0, max: 200 }),
  F({ name: 'mpge_combined', column: 'mpge_combined', kind: 'number', label: 'Combined MPGe (EPA)', group: 'efficiency', min: 0, max: 250 }),
  F({ name: 'electric_range', column: 'electric_range_mi', kind: 'number', quantity: 'length', label: 'Electric Range', group: 'efficiency', common: true, min: 0, max: 1000 }),
  F({ name: 'total_range', column: 'total_range_mi', kind: 'number', quantity: 'length', label: 'Total Range', group: 'efficiency', min: 0, max: 2000 }),

  // --- Capacity -------------------------------------------------------------
  F({ name: 'towing', column: 'towing_max_kg', kind: 'number', quantity: 'mass', label: 'Max Towing', group: 'capacity', common: true, min: 0, max: 20000 }),
  F({ name: 'payload', column: 'payload_kg', kind: 'number', quantity: 'mass', label: 'Payload', group: 'capacity', min: 0, max: 10000 }),

  // --- Commercial & quality -------------------------------------------------
  F({ name: 'price', column: 'msrp_minor', kind: 'number', quantity: 'currency', label: 'MSRP', group: 'commercial', common: true, min: 0, max: 100_000_000 }),
  F({ name: 'confidence', column: 'confidence_code', kind: 'enum', enumName: 'confidence', label: 'Data Confidence', group: 'quality' }),
  F({ name: 'completeness', column: 'completeness', kind: 'number', label: 'Data Completeness (%)', group: 'quality', min: 0, max: 100 }),
];

export const FIELD_BY_NAME: ReadonlyMap<string, FieldDef> = new Map(FIELDS.map((f) => [f.name, f]));

export function getField(name: string): FieldDef {
  const f = FIELD_BY_NAME.get(name);
  if (!f) throw new Error(`Unknown field "${name}"`);
  return f;
}

/** Resolve an enum slug to its stored numeric code for a given field. */
export function resolveEnumValue(field: FieldDef, value: string | number): number {
  if (typeof value === 'number') return value;
  if (!field.enumName) throw new Error(`Field "${field.name}" is not an enum`);
  const code = ENUM_REGISTRY[field.enumName].code(value);
  if (code === null) {
    throw new Error(`"${value}" is not a valid value for ${field.name}`);
  }
  return code;
}
