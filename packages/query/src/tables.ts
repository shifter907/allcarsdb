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

export type TableColumnType = 'text' | 'integer';

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

const YMM_ENGINES: TableDef = {
  name: 'YMM_Engines',
  label: 'Vehicle ↔ Engine Pairings',
  group: 'source',
  role: 'One row per (vehicle-year, engine) pairing.',
  description:
    'The many-to-many join, and the row a search actually returns. "2026 Porsche 911 with the ' +
    '3.0 twin-turbo flat-6" is one row here. A vehicle offered with three engines is three rows ' +
    'here and still one row in Year_Make_Model.',
  csv: 'data/ymm_engines.csv',
  orderBy: 'Index',
  columns: [
    { name: 'Index', type: 'integer', key: 'pk', description: 'Assigned by the loader at build time.' },
    { name: 'YMM_Index', type: 'integer', key: 'fk', references: 'Year_Make_Model', description: 'The vehicle-year.' },
    { name: 'Engine_Index', type: 'integer', key: 'fk', references: 'Engine_Specs', description: 'The engine.' },
  ],
};

const SEARCH_VIEW: TableDef = {
  name: 'Search_View',
  label: 'Search View',
  group: 'derived',
  role: 'One row per searchable vehicle-and-engine combination.',
  description:
    'A flattened view over the three source tables — not a table, and never edited directly. ' +
    'It is a LEFT JOIN on purpose: a vehicle with no engine recorded yet still appears here with ' +
    'engine_index empty, so an incomplete entry stays findable by make, model and year instead of ' +
    'vanishing from the site until someone fills the gap.',
  orderBy: 'Make',
  columns: [
    { name: 'combo_index', type: 'integer', key: 'pk', description: 'Unique per row. Falls back to the negative of the vehicle\'s own index when there is no engine pairing to number it.' },
    { name: 'ymm_index', type: 'integer', key: 'fk', references: 'Year_Make_Model', description: 'The vehicle-year this row describes.' },
    { name: 'engine_index', type: 'integer', key: 'fk', references: 'Engine_Specs', description: 'Empty exactly when no engine has been recorded for this vehicle yet.' },
    { name: 'Make', type: 'text', description: 'From Year_Make_Model.' },
    { name: 'Model', type: 'text', description: 'From Year_Make_Model.' },
    { name: 'Year', type: 'integer', description: 'From Year_Make_Model.' },
    { name: 'Generation', type: 'integer', description: 'From Year_Make_Model.' },
    { name: 'Dev_Chassis_Code', type: 'text', description: 'From Year_Make_Model.' },
    { name: 'Platform_Code', type: 'text', description: 'From Year_Make_Model.' },
    { name: 'Nickname', type: 'text', description: 'From Year_Make_Model.' },
    { name: 'Manufacturer', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Code', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Named_Variant', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Horsepower', type: 'integer', description: 'From Engine_Specs.' },
    { name: 'Torque_lbft', type: 'integer', description: 'From Engine_Specs.' },
    { name: 'Layout', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Cylinders', type: 'integer', description: 'From Engine_Specs.' },
    { name: 'CC_Displacement', type: 'integer', description: 'From Engine_Specs.' },
    { name: 'Aspiration', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Fuel_Type', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Compression_ratio', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Fuel_delivery', type: 'text', description: 'From Engine_Specs.' },
    { name: 'Search_Text', type: 'text', description: 'Year, make and model concatenated, so a free-text query can match across all three without knowing which is which.' },
  ],
};

/** Every browsable table, in the order the docs page should present them. */
export const TABLES: readonly TableDef[] = [
  YEAR_MAKE_MODEL,
  ENGINE_SPECS,
  YMM_ENGINES,
  SEARCH_VIEW,
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
