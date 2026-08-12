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
  F({ name: 'generation', column: 'Generation', kind: 'text', label: 'Generation', group: 'vehicle', description: 'Platform or chassis code -- "992", "Mk7", "E46" -- not a trim name. Often unset.' }),

  // --- Engine ---------------------------------------------------------------
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
