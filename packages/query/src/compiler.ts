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
 * Powertrains and their engines and batteries. One row is one vehicle-year
 * plus one powertrain.
 *
 * Fields whose columns live elsewhere -- bodies, trims, configurations -- are
 * reached by a correlated EXISTS instead of being joined in, because each is
 * one-to-many against a vehicle-year and two of those in one view multiply
 * against each other. See SOURCES in fields.ts.
 */

import {
  getField, sourceOf, FIELDS, SOURCES,
  type FieldDef, type SourceId,
} from './fields.js';
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
  /**
   * How several build-level filters combine.
   *
   * `any_build` (the default) reads each capability filter against the
   * vehicle's rollup independently: "tows 10,000" and "carries 2,000" can be
   * satisfied by two *different* configurations of the same truck.
   *
   * `same_build` requires one configuration to satisfy all of them at once,
   * by routing every build-level predicate into a single shared EXISTS. That
   * is a genuinely different -- and usually stricter -- question, which is why
   * it is explicit rather than inferred.
   */
  combine?: 'any_build' | 'same_build';
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
// Facets are requested lazily by the UI -- active filters, the open dropdown,
// and the common fields -- rather than one per field on every search. At this
// field count "facet everything" would be over a hundred GROUP BY statements
// per keystroke-debounced request. Each facet is its own prepared statement in
// the D1 batch, so an unbounded array here is an unbounded batch size at
// someone else's request.
const MAX_FACETS = 40;

/**
 * Columns returned for every result row.
 *
 * Derived from the field registry rather than hand-listed, so a field added
 * there cannot go missing here. Only base-view fields qualify: anything reached
 * through an EXISTS has no column on the outer row to select. The identity
 * columns lead, and are not fields.
 */
const RESULT_COLUMNS = [
  'combo_index', 'ymm_index', 'powertrain_index', 'engine_index',
  'Powertrain_Type', 'Trim_Summary', 'Build_Count',
  ...FIELDS.filter((f) => (f.source ?? 'view') === 'view').map((f) => f.column),
]
  // The same column can back more than one field, and Search_View exposes some
  // columns (Powertrain_Type) both as a field and as part of the result shape.
  .filter((c, i, all) => all.indexOf(c) === i)
  .map((c) => `\`${c}\``)
  .join(', ');

/** A predicate body, before provenance is attached. */
interface RawPredicate {
  sql: string;
  params: unknown[];
  /** Lower sorts earlier. Reflects rough evaluation cost. */
  cost: number;
}

interface Predicate extends RawPredicate {
  /**
   * Which relation this predicate reads. Carried structurally rather than
   * recovered by inspecting the SQL text: a predicate wrapped in an EXISTS
   * mentions several columns, so string-matching a column name to decide what a
   * predicate is about breaks as soon as subqueries exist.
   */
  source: SourceId;
  /** Field names this predicate constrains, for facet self-exclusion. */
  fields: string[];
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

  const raw: Predicate[] = filters.map(compileFieldFilter);
  if (req.q) raw.push(compileTextSearch(req.q));

  const sameBuild = req.combine === 'same_build';
  const predicates = assemble(raw, sameBuild);

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
    const source = sourceOf(field);

    // A facet's own filter is excluded from its count -- otherwise selecting
    // "Turbocharged" makes every other aspiration read zero, which is useless
    // for answering "what else could I pick".
    //
    // The exclusion is by field name, structurally, and it happens BEFORE the
    // EXISTS wrappers are built. Dropping a whole wrapper instead would also
    // drop its sibling constraints -- so picking a cab config would silently
    // stop constraining the bed-length dropdown, and the numbers would look
    // perfectly plausible while being wrong.
    const others = assemble(raw.filter((p) => !p.fields.includes(name)), sameBuild);
    const facetWhere = others.length ? `WHERE ${others.map((p) => p.sql).join(' AND ')}` : '';
    const facetParams = others.flatMap((p) => p.params);

    // Rows with no recorded value are grouped out rather than shown as a
    // nameless bucket -- "(null) 412" is not a filter anyone can click.
    // Ordered by value rather than count: this drives a <select>, and years or
    // displacements in chronological/numeric order are usable in a dropdown in
    // a way that popularity order is not.
    if (source.kind === 'base') {
      return {
        facet: name,
        sql: `SELECT \`${field.column}\` AS value, COUNT(*) AS n
              FROM Search_View ${facetWhere}
              GROUP BY \`${field.column}\`
              HAVING \`${field.column}\` IS NOT NULL
              ORDER BY \`${field.column}\` ASC
              LIMIT 100`,
        params: facetParams,
      };
    }

    // A field reached through a semi-join has no column on the outer row, so
    // its facet has to join out and count distinct vehicles -- "how many cars
    // remain if I pick Crew Cab", not "how many body-config rows match".
    const alias = source.alias!;
    return {
      facet: name,
      sql: `SELECT \`${alias}\`.\`${field.column}\` AS value,
                   COUNT(DISTINCT Search_View.combo_index) AS n
            FROM Search_View
            JOIN ${source.from} ON ${source.correlate}
            ${source.joins ?? ''}
            ${facetWhere}
            GROUP BY \`${alias}\`.\`${field.column}\`
            HAVING \`${alias}\`.\`${field.column}\` IS NOT NULL
            ORDER BY \`${alias}\`.\`${field.column}\` ASC
            LIMIT 100`,
      params: facetParams,
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

/**
 * Turn raw per-filter predicates into the final WHERE terms.
 *
 * Base-view predicates pass through untouched. Everything else is grouped by
 * source and wrapped in one EXISTS per source -- one subquery holding all of
 * that relation's constraints, never one subquery per constraint. Per-predicate
 * wrapping would pay N subquery costs *and* quietly change the meaning: three
 * separate EXISTS over Builds can be satisfied by three different builds.
 *
 * With `same_build`, every build-level source collapses into a single EXISTS
 * over Builds so one configuration has to satisfy all of them together.
 */
function assemble(raw: Predicate[], sameBuild: boolean): Predicate[] {
  const base = raw.filter((p) => SOURCES[p.source].kind === 'base');
  const rest = raw.filter((p) => SOURCES[p.source].kind === 'exists');

  const wrapped: Predicate[] = [];

  if (sameBuild) {
    // Sources whose semi-join starts from Builds can share one subquery. The
    // others (body configs, trims) hang off the vehicle-year, not off a build,
    // so they cannot honestly be folded in.
    const buildish = rest.filter((p) => BUILD_ROOTED.has(p.source));
    const other = rest.filter((p) => !BUILD_ROOTED.has(p.source));
    if (buildish.length) wrapped.push(wrapSameBuild(buildish));
    wrapped.push(...groupBySource(other));
  } else {
    wrapped.push(...groupBySource(rest));
  }

  // Cheapest predicates first -- see rule 2. Semi-joins cost more than any
  // plain column test, and their cost is set below to sort after all of them.
  return [...base, ...wrapped].sort((a, b) => a.cost - b.cost);
}

/** Sources whose FROM begins at Builds, and so can share one correlated row. */
const BUILD_ROOTED: ReadonlySet<SourceId> = new Set<SourceId>([
  'build', 'transmission', 'drivetrain', 'suspension', 'seating',
]);

function groupBySource(preds: Predicate[]): Predicate[] {
  const bySource = new Map<SourceId, Predicate[]>();
  for (const p of preds) {
    const list = bySource.get(p.source);
    if (list) list.push(p);
    else bySource.set(p.source, [p]);
  }

  return [...bySource.entries()].map(([sourceId, group]) => {
    const source = SOURCES[sourceId];
    return {
      sql:
        `EXISTS (SELECT 1 FROM ${source.from} ${source.joins ?? ''} ` +
        `WHERE ${source.correlate} AND ${group.map((p) => p.sql).join(' AND ')})`,
      params: group.flatMap((p) => p.params),
      // Sorted after every base predicate, so a cheap Make test narrows the
      // scan before any subquery is evaluated.
      cost: 100 + Math.max(...group.map((p) => p.cost)),
      source: sourceId,
      fields: group.flatMap((p) => p.fields),
    };
  });
}

/**
 * One EXISTS over Builds carrying every build-rooted constraint, with the
 * catalog joins each one needs. This is what makes "tows 10,000 AND has a
 * 10-speed" mean one truck rather than two.
 */
function wrapSameBuild(preds: Predicate[]): Predicate {
  const joins = new Set<string>();
  for (const p of preds) {
    if (p.source === 'build') continue;
    // Each build-rooted source declares its own Builds alias; inside this one
    // shared subquery there is only one, so only the catalog joins are taken.
    const j = SOURCES[p.source].joins;
    if (j) joins.add(j);
  }

  const from = ['Builds b', ...joins].join(' ');
  // Those catalog joins reference their own Builds alias (btx, bdt, ...).
  // Rewrite them onto the single alias this subquery actually has.
  const normalised = from.replace(/\bb(tx|dt|sus|sc)\./g, 'b.');

  return {
    sql:
      `EXISTS (SELECT 1 FROM ${normalised} ` +
      `WHERE b.YMM_Index = Search_View.ymm_index AND ` +
      `${preds.map((p) => p.sql).join(' AND ')})`,
    params: preds.flatMap((p) => p.params),
    cost: 100 + Math.max(...preds.map((p) => p.cost)),
    source: 'build',
    fields: preds.flatMap((p) => p.fields),
  };
}

// ---------------------------------------------------------------------------
// Field filters
// ---------------------------------------------------------------------------

function compileFieldFilter(f: FieldFilter): Predicate {
  const field = getField(f.field);
  const source = sourceOf(field);
  const sourceId: SourceId = field.source ?? 'view';

  // A base-view column stands alone; anything else has to be qualified with
  // its subquery's alias, because several of these relations have columns of
  // the same name (Transmissions.Code and Engine_Specs.Code both exist).
  const col = source.kind === 'base'
    ? `\`${field.column}\``
    : `\`${source.alias}\`.\`${field.column}\``;

  const base = f.op === 'exists'
    ? { sql: `${col} IS NOT NULL`, params: [] as unknown[], cost: 10 }
    : field.kind === 'text'
      ? compileTextFilter(f, field, col)
      : compileNumericFilter(f, field, col);

  return { ...base, source: sourceId, fields: [field.name] };
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

function compileTextFilter(f: FieldFilter, field: FieldDef, col: string): RawPredicate {
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

function compileNumericFilter(f: FieldFilter, field: FieldDef, col: string): RawPredicate {
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

  // `q` is not a field, so it has no name to exclude from any facet -- an
  // empty `fields` list means every facet keeps the text constraint, which is
  // right: typing "porsche" should narrow every dropdown.
  if (tokens.length === 0) {
    return { sql: '1=1', params: [], cost: 0, source: 'view', fields: [] };
  }

  return {
    sql: tokens.map(() => `\`Search_Text\` LIKE ? ESCAPE '\\'`).join(' AND '),
    params: tokens,
    cost: 65,
    source: 'view',
    fields: [],
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
      // Only base-view columns can be sorted on. A field reached through a
      // semi-join has no column on the result row to order by, and there is no
      // single value to pick from the many rows the subquery matched -- sorting
      // by "cab config" when a truck has three is not a defined question.
      if ((field.source ?? 'view') !== 'view') {
        throw new QueryError(
          `Cannot sort by ${field.name}: it describes configurations of a vehicle rather than ` +
            `the vehicle itself, so a result row has no single value for it.`,
        );
      }
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
