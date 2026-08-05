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
 *      a range, which goes before a bitmask test, which goes before a
 *      subquery. On a wide scan this ordering alone is worth several-fold.
 *
 *   3. FEATURES TAKE THE CHEAPEST AVAILABLE ROUTE. A feature that owns a bit
 *      in the search index is tested with an AND-mask inside the scan. Anything
 *      else falls back to an EXISTS against variant_feature's covering index.
 *
 *   4. NULL IS NOT ZERO. A car with no recorded 0-60 time must not appear in
 *      "0-60 under 5 seconds". Every range predicate carries an implicit
 *      IS NOT NULL, and the response reports how many rows were excluded for
 *      missing data -- silently dropping them is how users lose trust.
 */

import { getField, resolveEnumValue, type FieldDef } from './fields.js';
import { toCanonical } from './units.js';
import { Availability } from '@allcarsdb/schema/enums';

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

export type ComparisonOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'in' | 'exists';

export interface FieldFilter {
  field: string;
  op: ComparisonOp;
  value?: number | string | boolean | (number | string)[];
  /** Unit the value is expressed in; converted to canonical storage units. */
  unit?: string;
  /** Tolerance for `eq` on a measured quantity. "28 in seat height" almost
   *  never means exactly 711.2 mm -- it means "about 28 inches". */
  tolerance?: number;
}

export interface FeatureFilter {
  feature: string;
  /** Which availability levels count as a match. Defaults to anything the
   *  buyer could actually get: standard, standalone option, or in a package. */
  availability?: string[];
  /** Set true to find cars that explicitly do NOT offer it. */
  absent?: boolean;
  /** For numeric-valued features, e.g. screen size >= 12. */
  op?: ComparisonOp;
  value?: number;
}

export interface SortSpec {
  field: string;
  dir?: 'asc' | 'desc';
  /** Where NULLs go. Defaults to last, which is what people expect. */
  nulls?: 'first' | 'last';
}

export interface SearchRequest {
  filters?: FieldFilter[];
  features?: FeatureFilter[];
  /** Free-text query against the FTS index. */
  q?: string;
  sort?: SortSpec[];
  limit?: number;
  offset?: number;
  /** Field names to compute facet counts for over the filtered set. */
  facets?: string[];
  /** Collapse to one row per trim rather than one per variant. */
  groupByTrim?: boolean;
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

/**
 * Features that own a bit in variant_search.feat_lo / feat_hi.
 * Populated by the ETL and injected here so the compiler can decide between
 * the bitmask path and the join path. Keys are feature slugs, values are bit
 * positions 0-127.
 */
export type FeatureBitMap = ReadonlyMap<string, number>;

interface Predicate {
  sql: string;
  params: unknown[];
  /** Lower sorts earlier. Reflects rough evaluation cost. */
  cost: number;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export function compile(req: SearchRequest, featureBits: FeatureBitMap = new Map()): CompiledQuery {
  const filters = req.filters ?? [];
  const features = req.features ?? [];

  if (filters.length + features.length > MAX_FILTERS) {
    throw new QueryError(`Too many filters (max ${MAX_FILTERS})`);
  }

  const predicates: Predicate[] = [];

  for (const f of filters) predicates.push(compileFieldFilter(f));
  for (const f of features) predicates.push(compileFeatureFilter(f, featureBits));

  if (req.q) predicates.push(compileTextSearch(req.q));

  // Cheapest predicates first -- see rule 2.
  predicates.sort((a, b) => a.cost - b.cost);

  const where = predicates.length ? `WHERE ${predicates.map((p) => p.sql).join('\n    AND ')}` : '';
  const whereParams = predicates.flatMap((p) => p.params);

  const orderBy = compileSort(req.sort);
  const limit = Math.min(Math.max(req.limit ?? 50, 1), MAX_LIMIT);
  const offset = Math.max(req.offset ?? 0, 0);

  // The display join happens after LIMIT so it only touches rows on the page.
  const sql = `
SELECT
  d.variant_id, d.full_name, d.make_name, d.make_slug, d.model_name, d.model_slug,
  d.year, d.trim_name, d.variant_name, d.body_name, d.engine_summary,
  d.drivetrain_summary, d.url_path,
  s.combined_hp, s.combined_torque_lbft, s.curb_weight_kg, s.zero_to_60_mph_s,
  s.cargo_behind_second_l, s.seat_height_front_mm, s.mpg_combined, s.mpge_combined,
  s.electric_range_mi, s.towing_max_kg, s.msrp_minor, s.msrp_currency,
  s.completeness, s.confidence_code
FROM (
  SELECT variant_id${orderBy.selectExtras}
  FROM variant_search
  ${where}
  ${orderBy.sql}
  LIMIT ? OFFSET ?
) AS page
JOIN variant_search  s ON s.variant_id = page.variant_id
JOIN variant_display d ON d.variant_id = page.variant_id
${orderBy.outerSql}`.trim();

  const countSql = `SELECT COUNT(*) AS n FROM variant_search ${where}`;

  const facetQueries = (req.facets ?? []).map((name) => {
    const field = getField(name);
    // A facet's own filter is excluded from its count -- otherwise selecting
    // "SUV" makes every other body style read zero, which is useless for
    // "what else could I pick".
    const others = predicates.filter((p) => !p.sql.includes(`\`${field.column}\``));
    const facetWhere = others.length ? `WHERE ${others.map((p) => p.sql).join(' AND ')}` : '';
    return {
      facet: name,
      sql: `SELECT \`${field.column}\` AS value, COUNT(*) AS n
            FROM variant_search ${facetWhere}
            GROUP BY \`${field.column}\`
            ORDER BY n DESC
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

  if (field.kind === 'enum') {
    return compileEnumFilter(f, field, col);
  }

  if (field.kind === 'bool') {
    const want = f.value === true || f.value === 1 || f.value === 'true' ? 1 : 0;
    return { sql: `${col} = ?`, params: [want], cost: 12 };
  }

  return compileNumericFilter(f, field, col);
}

function compileEnumFilter(f: FieldFilter, field: FieldDef, col: string): Predicate {
  const raw = Array.isArray(f.value) ? f.value : [f.value as string | number];
  const codes = raw.map((v) => resolveEnumValue(field, v as string | number));

  if (f.op === 'ne') {
    const holes = codes.map(() => '?').join(',');
    // NULL must not match a negation silently.
    return { sql: `(${col} IS NULL OR ${col} NOT IN (${holes}))`, params: codes, cost: 20 };
  }
  if (codes.length === 1) {
    return { sql: `${col} = ?`, params: codes, cost: 5 };
  }
  return { sql: `${col} IN (${codes.map(() => '?').join(',')})`, params: codes, cost: 15 };
}

function compileNumericFilter(f: FieldFilter, field: FieldDef, col: string): Predicate {
  const conv = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new QueryError(`${field.name}: "${v}" is not a number`);
    const canonical = field.quantity ? toCanonical(field.quantity, n, f.unit) : n;
    // Bounds are a sanity check on input, not on stored data -- catching
    // "length = 4.5" when the user meant metres and forgot the unit.
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
      // Tolerance turns "28 inch seat height" into a usable query. Without it
      // a floating-point equality against a converted value matches nothing.
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
 * Published specs are rounded, and rounded differently in each market -- the
 * same seat sits at "28.0 in" in a US brochure and "711 mm" in a European one,
 * and those are not the same number. Matching to the precision the user
 * implied (roughly half a display unit) is the behaviour people expect.
 */
function defaultTolerance(field: FieldDef, value: number): number {
  switch (field.quantity) {
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
// Feature filters
// ---------------------------------------------------------------------------

const DEFAULT_AVAILABILITY = ['standard', 'optional', 'package', 'late_availability'];

function compileFeatureFilter(f: FeatureFilter, bits: FeatureBitMap): Predicate {
  const availSlugs = f.availability ?? DEFAULT_AVAILABILITY;
  const availCodes = availSlugs.map((s) => {
    const c = Availability.code(s);
    if (c === null) throw new QueryError(`Unknown availability "${s}"`);
    return c;
  });

  const bit = bits.get(f.feature);
  const standardOnly =
    availSlugs.length === 1 && availSlugs[0] === 'standard';

  // Fast path: the feature has a reserved bit and the query does not need a
  // value comparison. Tested inside the scan, no join.
  if (bit !== undefined && f.op === undefined) {
    const hi = bit >= 64;
    const col = standardOnly
      ? hi ? '`feat_std_hi`' : '`feat_std_lo`'
      : hi ? '`feat_hi`' : '`feat_lo`';

    // The mask is emitted as a SQL LITERAL rather than a bound parameter, on
    // purpose. Bits above 52 exceed Number.MAX_SAFE_INTEGER, and the only
    // exact JS representation is a BigInt -- which Cloudflare D1 will not
    // bind. Interpolating is safe here because `bit` comes from the server's
    // own feature catalog, never from the request; the branch is unreachable
    // unless the slug matched a catalog entry.
    //
    // SQLite integers are signed 64-bit, so bit 63 lands on the sign bit.
    // asIntN gives the correct negative literal, and `col & mask = mask`
    // is sign-agnostic, so the comparison stays correct there.
    const mask = BigInt.asIntN(64, 1n << BigInt(hi ? bit - 64 : bit)).toString();

    return f.absent
      ? { sql: `(${col} & ${mask}) = 0`, params: [], cost: 8 }
      : { sql: `(${col} & ${mask}) = ${mask}`, params: [], cost: 8 };
  }

  // General path: covering-index lookup on variant_feature.
  const holes = availCodes.map(() => '?').join(',');
  let valueClause = '';
  const params: unknown[] = [f.feature, ...availCodes];

  if (f.op !== undefined && f.value !== undefined) {
    const opSql = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[
      f.op as 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
    ];
    if (!opSql) throw new QueryError(`Unsupported operator "${f.op}" on feature ${f.feature}`);
    valueClause = ` AND vf.value_num ${opSql} ?`;
    params.push(f.value);
  }

  const exists = `EXISTS (
      SELECT 1 FROM variant_feature vf
      JOIN feature ft ON ft.id = vf.feature_id
      WHERE vf.variant_id = variant_search.variant_id
        AND ft.slug = ?
        AND vf.availability_code IN (${holes})${valueClause}
    )`;

  return {
    sql: f.absent ? `NOT ${exists}` : exists,
    params,
    cost: f.absent ? 90 : 70,
  };
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

function compileTextSearch(q: string): Predicate {
  // FTS5 treats a lot of punctuation as syntax. Quoting each token keeps a
  // stray '-' or '"' from turning into an operator or a parse error.
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => `"${t.replace(/"/g, '""')}"`);

  if (tokens.length === 0) return { sql: '1=1', params: [], cost: 0 };

  return {
    sql: `variant_search.variant_id IN (SELECT rowid FROM variant_fts WHERE variant_fts MATCH ?)`,
    params: [tokens.join(' ')],
    cost: 40,
  };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function compileSort(sorts: SortSpec[] | undefined): {
  sql: string;
  outerSql: string;
  selectExtras: string;
} {
  if (!sorts || sorts.length === 0) {
    return {
      sql: 'ORDER BY year DESC, combined_hp DESC, variant_id',
      outerSql: 'ORDER BY s.year DESC, s.combined_hp DESC, s.variant_id',
      selectExtras: ', year, combined_hp',
    };
  }

  const inner: string[] = [];
  const outer: string[] = [];
  const extras = new Set<string>();

  for (const s of sorts.slice(0, 4)) {
    const field = getField(s.field);
    const dir = s.dir === 'asc' ? 'ASC' : 'DESC';
    const nulls = s.nulls ?? 'last';
    const col = `\`${field.column}\``;

    // SQLite has NULLS LAST from 3.30, but D1 and older builds are safer with
    // an explicit sort key. `x IS NULL` is 0/1, so this sorts NULLs to the end.
    if (nulls === 'last') {
      inner.push(`(${col} IS NULL) ASC`, `${col} ${dir}`);
      outer.push(`(s.${col} IS NULL) ASC`, `s.${col} ${dir}`);
    } else {
      inner.push(`(${col} IS NOT NULL) ASC`, `${col} ${dir}`);
      outer.push(`(s.${col} IS NOT NULL) ASC`, `s.${col} ${dir}`);
    }
    extras.add(field.column);
  }

  // Stable tiebreak, so pagination cannot repeat or skip a row.
  inner.push('variant_id');
  outer.push('s.variant_id');

  return {
    sql: `ORDER BY ${inner.join(', ')}`,
    outerSql: `ORDER BY ${outer.join(', ')}`,
    selectExtras: extras.size ? `, ${[...extras].map((c) => `\`${c}\``).join(', ')}` : '',
  };
}
