/**
 * Search request -> parameterized SQL.
 *
 * Design rules, in priority order:
 *
 *   1. NO STRING INTERPOLATION OF USER INPUT. Column names come from the field
 *      registry; every value is a bound parameter. There is no path by which a
 *      request body reaches the SQL text.
 *
 *   2. PREDICATES ARE EMITTED CHEAPEST-FIRST. SQLite evaluates a WHERE clause
 *      left to right within a scan, so equality on a small integer goes before
 *      a range, which goes before a LIKE. On a wide scan this ordering alone is
 *      worth several-fold.
 *
 *   3. NULL IS NOT ZERO. A car with no recorded displacement must not appear in
 *      "under 2000cc". Every range predicate carries an implicit IS NOT NULL,
 *      because silently treating unknown as zero is how users lose trust.
 *
 * Queries run against `Search_View`, the flattened join of Year_Make_Model,
 * Engine_Specs and YMM_Engines. One row is one vehicle-year-plus-engine.
 */

import { getField, type FieldDef } from './fields.js';
import { toCanonical } from './units.js';

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

export type ComparisonOp =
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'in' | 'exists' | 'contains';

export interface FieldFilter {
  field: string;
  op: ComparisonOp;
  value?: number | string | boolean | (number | string)[];
  /** Unit the value is expressed in; converted to canonical storage units. */
  unit?: string;
  /** Tolerance for `eq` on a measured quantity. "3.0 litres" almost never means
   *  exactly 3000cc -- it means "about three litres". */
  tolerance?: number;
}

export interface SortSpec {
  field: string;
  dir?: 'asc' | 'desc';
  /** Where NULLs go. Defaults to last, which is what people expect. */
  nulls?: 'first' | 'last';
}

export interface SearchRequest {
  filters?: FieldFilter[];
  /** Free-text query across year, make and model. */
  q?: string;
  sort?: SortSpec[];
  limit?: number;
  offset?: number;
  /** Field names to compute facet counts for over the filtered set. */
  facets?: string[];
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  countSql: string;
  countParams: unknown[];
  facetQueries: { facet: string; sql: string; params: unknown[] }[];
}

export class QueryError extends Error {}

const MAX_LIMIT = 200;
const MAX_FILTERS = 60;
// The UI now requests a facet for every field on every search, to drive
// cascading dropdowns -- so this is sized to comfortably exceed the field
// registry, not to allow arbitrary growth. Each facet is its own prepared
// statement in the D1 batch, so an unbounded array here is an unbounded
// batch size at someone else's request.
const MAX_FACETS = 40;

/** Columns returned for every result row. Fixed list, never user-controlled. */
const RESULT_COLUMNS = [
  'combo_index', 'ymm_index', 'engine_index',
  'Make', 'Model', 'Year', 'Generation', 'Dev_Chassis_Code', 'Platform_Code', 'Nickname',
  'Manufacturer', 'Code', 'Named_Variant',
  'Layout', 'Cylinders', 'CC_Displacement',
  'Aspiration', 'Fuel_Type', 'Compression_ratio', 'Fuel_delivery',
  'Horsepower', 'Torque_lbft',
].map((c) => `\`${c}\``).join(', ');

interface Predicate {
  sql: string;
  params: unknown[];
  /** Lower sorts earlier. Reflects rough evaluation cost. */
  cost: number;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export function compile(req: SearchRequest): CompiledQuery {
  const filters = req.filters ?? [];

  if (filters.length > MAX_FILTERS) {
    throw new QueryError(`Too many filters (max ${MAX_FILTERS})`);
  }
  if ((req.facets?.length ?? 0) > MAX_FACETS) {
    throw new QueryError(`Too many facets (max ${MAX_FACETS})`);
  }

  const predicates: Predicate[] = filters.map(compileFieldFilter);
  if (req.q) predicates.push(compileTextSearch(req.q));

  // Cheapest predicates first -- see rule 2.
  predicates.sort((a, b) => a.cost - b.cost);

  const where = predicates.length ? `WHERE ${predicates.map((p) => p.sql).join('\n    AND ')}` : '';
  const whereParams = predicates.flatMap((p) => p.params);

  const orderBy = compileSort(req.sort);
  const limit = Math.min(Math.max(req.limit ?? 50, 1), MAX_LIMIT);
  const offset = Math.max(req.offset ?? 0, 0);

  const sql = `
SELECT ${RESULT_COLUMNS}
FROM Search_View
${where}
${orderBy}
LIMIT ? OFFSET ?`.trim();

  const countSql = `SELECT COUNT(*) AS n FROM Search_View ${where}`;

  const facetQueries = (req.facets ?? []).map((name) => {
    const field = getField(name);
    // A facet's own filter is excluded from its count -- otherwise selecting
    // "Turbocharged" makes every other aspiration read zero, which is useless
    // for answering "what else could I pick".
    const others = predicates.filter((p) => !p.sql.includes(`\`${field.column}\``));
    const facetWhere = others.length ? `WHERE ${others.map((p) => p.sql).join(' AND ')}` : '';
    return {
      facet: name,
      // Rows with no recorded value are grouped out rather than shown as a
      // nameless bucket -- "(null) 412" is not a filter anyone can click.
      // Ordered by value rather than count: this result drives a <select>
      // now as well as the "narrow it down" panel, and years or displacements
      // in chronological/numeric order are usable in a dropdown in a way that
      // popularity order is not.
      sql: `SELECT \`${field.column}\` AS value, COUNT(*) AS n
            FROM Search_View ${facetWhere}
            GROUP BY \`${field.column}\`
            HAVING \`${field.column}\` IS NOT NULL
            ORDER BY \`${field.column}\` ASC
            LIMIT 100`,
      params: others.flatMap((p) => p.params),
    };
  });

  return {
    sql,
    params: [...whereParams, limit, offset],
    countSql,
    countParams: whereParams,
    facetQueries,
  };
}

// ---------------------------------------------------------------------------
// Field filters
// ---------------------------------------------------------------------------

function compileFieldFilter(f: FieldFilter): Predicate {
  const field = getField(f.field);
  const col = `\`${field.column}\``;

  if (f.op === 'exists') {
    return { sql: `${col} IS NOT NULL`, params: [], cost: 10 };
  }

  return field.kind === 'text'
    ? compileTextFilter(f, field, col)
    : compileNumericFilter(f, field, col);
}

/**
 * LIKE metacharacters in a user's value are escaped rather than honoured.
 *
 * Someone searching for a model literally named "100%" means the string, not
 * "anything at all" -- and a bare `_` matching any single character turns a
 * precise search into a vague one without the user ever being told.
 */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function compileTextFilter(f: FieldFilter, field: FieldDef, col: string): Predicate {
  const asText = (v: unknown): string => {
    if (v === null || v === undefined) throw new QueryError(`${field.name}: missing value`);
    if (typeof v === 'object') throw new QueryError(`${field.name}: expected a single value`);
    return String(v);
  };

  switch (f.op) {
    case 'contains': {
      const v = escapeLike(asText(f.value));
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${v}%`], cost: 60 };
    }
    case 'in': {
      const arr = (Array.isArray(f.value) ? f.value : [f.value]).map(asText);
      if (arr.length === 0) throw new QueryError(`${field.name}: "in" needs at least one value`);
      return { sql: `${col} IN (${arr.map(() => '?').join(',')})`, params: arr, cost: 15 };
    }
    case 'ne': {
      // NULL must not match a negation silently.
      return { sql: `(${col} IS NULL OR ${col} <> ?)`, params: [asText(f.value)], cost: 20 };
    }
    case 'eq': {
      // The columns are declared COLLATE NOCASE, so this is already
      // case-insensitive at the storage layer -- "flat" finds "Flat".
      return { sql: `${col} = ?`, params: [asText(f.value)], cost: 5 };
    }
    default:
      throw new QueryError(
        `Operator "${f.op}" does not apply to ${field.name}, which is text. ` +
          `Use eq, ne, in or contains.`,
      );
  }
}

function compileNumericFilter(f: FieldFilter, field: FieldDef, col: string): Predicate {
  const conv = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new QueryError(`${field.name}: "${v}" is not a number`);
    const canonical = field.quantity ? toCanonical(field.quantity, n, f.unit) : n;
    // Bounds are a sanity check on input, not on stored data -- catching
    // "displacement = 3" when the user meant litres and forgot the unit.
    if (field.min !== undefined && canonical < field.min - 1e-9) {
      throw new QueryError(
        `${field.name}: ${n}${f.unit ?? ''} is below the plausible minimum. Did you mean to specify a unit?`,
      );
    }
    if (field.max !== undefined && canonical > field.max + 1e-9) {
      throw new QueryError(
        `${field.name}: ${n}${f.unit ?? ''} is above the plausible maximum. Did you mean to specify a unit?`,
      );
    }
    return canonical;
  };

  switch (f.op) {
    case 'between': {
      const arr = f.value as (number | string)[];
      if (!Array.isArray(arr) || arr.length !== 2) {
        throw new QueryError(`${field.name}: "between" needs exactly two values`);
      }
      const [lo, hi] = [conv(arr[0]), conv(arr[1])];
      return {
        sql: `${col} BETWEEN ? AND ?`,
        params: lo <= hi ? [lo, hi] : [hi, lo],
        cost: 30,
      };
    }
    case 'in': {
      const arr = (Array.isArray(f.value) ? f.value : [f.value]).map(conv);
      return { sql: `${col} IN (${arr.map(() => '?').join(',')})`, params: arr, cost: 25 };
    }
    case 'eq': {
      const v = conv(f.value);
      // Tolerance turns "3.0 litres" into a usable query. Without it, a
      // floating-point equality against a converted value matches nothing.
      const tol = f.tolerance ?? defaultTolerance(field, v);
      if (tol > 0) {
        return { sql: `${col} BETWEEN ? AND ?`, params: [v - tol, v + tol], cost: 30 };
      }
      return { sql: `${col} = ?`, params: [v], cost: 20 };
    }
    case 'ne':
      return { sql: `(${col} IS NULL OR ${col} <> ?)`, params: [conv(f.value)], cost: 30 };
    case 'lt':
      return { sql: `${col} < ?`, params: [conv(f.value)], cost: 28 };
    case 'lte':
      return { sql: `${col} <= ?`, params: [conv(f.value)], cost: 28 };
    case 'gt':
      return { sql: `${col} > ?`, params: [conv(f.value)], cost: 28 };
    case 'gte':
      return { sql: `${col} >= ?`, params: [conv(f.value)], cost: 28 };
    default:
      throw new QueryError(`Unsupported operator "${f.op}" on ${field.name}`);
  }
}

/**
 * Half-width of the match window for an `eq` on a measured quantity.
 *
 * Published displacements are rounded and rounded inconsistently -- the same
 * engine is "3.0 litre" in the brochure and 2981cc on the spec sheet, and those
 * are not the same number. Matching to the precision the user implied is the
 * behaviour people expect.
 */
function defaultTolerance(field: FieldDef, value: number): number {
  switch (field.quantity) {
    case 'displacement':
      // 2% covers the gap between a marketed round number and the real
      // swept volume without letting a 3.0 match a 3.5.
      return Math.max(value * 0.02, 5);
    case 'length':
      return 12.7; // half an inch, in mm
    case 'volume':
      return Math.max(value * 0.01, 1);
    case 'mass':
      return Math.max(value * 0.01, 5);
    case 'power':
    case 'torque':
      return 2;
    case 'time':
      return 0.05;
    case 'speed':
      return 1.5;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

/**
 * Free text across year, make and model.
 *
 * Every token must match, so "2026 porsche" narrows rather than widens. This is
 * a LIKE rather than a full-text index: at this shape the whole searchable set
 * is one small view, and an FTS table would be a second copy of the data that
 * can fall out of step with the source tables it was built from.
 */
function compileTextSearch(q: string): Predicate {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `%${escapeLike(t)}%`);

  if (tokens.length === 0) return { sql: '1=1', params: [], cost: 0 };

  return {
    sql: tokens.map(() => `\`Search_Text\` LIKE ? ESCAPE '\\'`).join(' AND '),
    params: tokens,
    cost: 65,
  };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function compileSort(sorts: SortSpec[] | undefined): string {
  const terms: string[] = [];

  if (!sorts || sorts.length === 0) {
    terms.push('`Year` DESC', '`Make` ASC', '`Model` ASC');
  } else {
    for (const s of sorts.slice(0, 4)) {
      const field = getField(s.field);
      const dir = s.dir === 'asc' ? 'ASC' : 'DESC';
      const nulls = s.nulls ?? 'last';
      const col = `\`${field.column}\``;

      // SQLite has NULLS LAST from 3.30, but D1 and older builds are safer with
      // an explicit sort key. `x IS NULL` is 0/1, so this sorts NULLs to the end.
      terms.push(nulls === 'last' ? `(${col} IS NULL) ASC` : `(${col} IS NOT NULL) ASC`);
      terms.push(`${col} ${dir}`);
    }
  }

  // Stable tiebreak, so pagination cannot repeat or skip a row.
  terms.push('`combo_index`');
  return `ORDER BY ${terms.join(', ')}`;
}
