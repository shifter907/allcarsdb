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
 * Columns resolve against `Search_View`, the flattened join of the three source
 * tables. See packages/db/migrations/0000_schema.sql.
 */

import type { Quantity } from './units.js';

export type FieldKind = 'number' | 'text';

export interface FieldDef {
  /** Public name used in the API and URL. */
  name: string;
  /** Column in `Search_View`. Never user-controlled. */
  column: string;
  kind: FieldKind;
  label: string;
  quantity?: Quantity;
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
  // --- Vehicle --------------------------------------------------------------
  F({ name: 'make', column: 'Make', kind: 'text', label: 'Make', group: 'vehicle', common: true }),
  F({ name: 'model', column: 'Model', kind: 'text', label: 'Model', group: 'vehicle', common: true }),
  F({ name: 'year', column: 'Year', kind: 'number', label: 'Model Year', group: 'vehicle', common: true, min: 1885, max: 2100 }),
  F({ name: 'generation', column: 'Generation', kind: 'number', label: 'Generation', group: 'vehicle', min: 1, max: 50, description: 'Ordinal generation number for this nameplate -- 4, not "E46". Often unset.' }),
  F({ name: 'dev_chassis_code', column: 'Dev_Chassis_Code', kind: 'text', label: 'Chassis Code', group: 'vehicle', description: 'Manufacturer development code for this generation -- "E46", "992", "ND".' }),
  F({ name: 'platform_code', column: 'Platform_Code', kind: 'text', label: 'Platform', group: 'vehicle', description: 'Shared architecture code -- can span multiple nameplates, unlike the chassis code.' }),
  F({ name: 'nickname', column: 'Nickname', kind: 'text', label: 'Nickname', group: 'vehicle', description: 'What people actually call it -- "OBS" for the 1992-1996 F-150 -- when that differs from the official name.' }),

  // --- Engine ---------------------------------------------------------------
  F({ name: 'manufacturer', column: 'Manufacturer', kind: 'text', label: 'Engine Manufacturer', group: 'engine', common: true, description: 'Who built the engine -- not always the vehicle\'s own Make. The BMW B58 shows up under the Toyota GR Supra.' }),
  F({ name: 'code', column: 'Code', kind: 'text', label: 'Engine Code', group: 'engine', description: 'The manufacturer\'s own designation for the engine family -- "N54", "L76", "LQ9".' }),
  F({ name: 'named_variant', column: 'Named_Variant', kind: 'text', label: 'Engine Variant', group: 'engine', description: 'A named differentiator appended to the code -- "B30" for the N54B30, or a tuner name like "Alpina". Most engines don\'t have one.' }),
  F({ name: 'layout', column: 'Layout', kind: 'text', label: 'Layout', group: 'engine', common: true, description: 'Cylinder arrangement -- inline, V, flat, W, rotary.' }),
  F({ name: 'cylinders', column: 'Cylinders', kind: 'number', label: 'Cylinders', group: 'engine', common: true, min: 0, max: 32 }),
  F({
    name: 'displacement',
    column: 'CC_Displacement',
    kind: 'number',
    quantity: 'displacement',
    label: 'Displacement',
    group: 'engine',
    common: true,
    min: 0,
    max: 200000,
    description: 'Stored in cc.',
  }),
  F({ name: 'aspiration', column: 'Aspiration', kind: 'text', label: 'Aspiration', group: 'engine', common: true, description: 'Naturally aspirated, turbocharged, supercharged, twin-turbo.' }),
  F({ name: 'fuel_type', column: 'Fuel_Type', kind: 'text', label: 'Fuel Type', group: 'engine', common: true }),
  F({ name: 'compression_ratio', column: 'Compression_ratio', kind: 'text', label: 'Compression Ratio', group: 'engine', description: 'Recorded as written, e.g. "10.5:1".' }),
  F({ name: 'fuel_delivery', column: 'Fuel_delivery', kind: 'text', label: 'Fuel Delivery', group: 'engine', description: 'Direct injection, port injection, carburettor.' }),
] as const;

export const FIELD_BY_NAME: ReadonlyMap<string, FieldDef> = new Map(FIELDS.map((f) => [f.name, f]));

export function getField(name: string): FieldDef {
  const f = FIELD_BY_NAME.get(name);
  if (!f) throw new Error(`Unknown field: ${name}`);
  return f;
}

/** Field groups in the order the filter panel should present them. */
export const FIELD_GROUPS = ['vehicle', 'engine'] as const;
