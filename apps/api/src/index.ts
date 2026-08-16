/**
 * The AllCarsDB read API.
 *
 * Read-only by design. There is no write path, no authentication and no session
 * state: data changes by merging a pull request against the CSVs and rebuilding,
 * which means the API has no privileged operation to protect and no way for a
 * request to corrupt anything.
 *
 * Runs on Cloudflare Workers against a D1 database that is replaced wholesale on
 * every deploy.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  compile,
  QueryError,
  getField,
  getTable,
  FIELDS,
  FIELD_BY_NAME,
  FIELD_GROUPS,
  TABLES,
  type SearchRequest,
} from '@allcarsdb/query';

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();

/**
 * CORS is scoped to real origins now that the API lives on its own subdomain
 * (api.allcarsdb.com) rather than behind the same origin as the UI.
 *
 * `*` would be the easy choice and would cost nothing in practice -- every
 * response here is public, cacheable, non-authenticated data, so an open CORS
 * policy leaks nothing. It's scoped anyway because a third party building on
 * this API should go through a real origin check rather than relying on a
 * wildcard that could quietly change later, and because Pages preview
 * deployments (`*.allcarsdb.pages.dev`) need to work without being lumped in
 * with "anyone, anywhere."
 */
const ALLOWED_ORIGINS = [
  'https://allcarsdb.com',
  'https://www.allcarsdb.com',
  // The Pages project's own canonical hostname. This is NOT covered by the
  // preview-deployment pattern below -- that one requires a subdomain label
  // (`<hash>.allcarsdb.pages.dev`), so the bare hostname has to be listed
  // explicitly or the production Pages URL is CORS-blocked while every
  // preview URL works.
  'https://allcarsdb.pages.dev',
  'http://localhost:5173', // vite dev server
];

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return origin; // same-origin / non-browser requests carry no Origin header
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      if (/^https:\/\/[a-z0-9-]+\.allcarsdb\.pages\.dev$/.test(origin)) return origin;
      return null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);

/**
 * Cache-Control for data endpoints.
 *
 * The edge TTL is long because the database is immutable between builds, and
 * that is where the load is actually absorbed -- a day of edge caching plus
 * stale-while-revalidate means a deploy never causes a latency spike.
 *
 * The *browser* TTL is deliberately short. A long one was the obvious choice
 * and was wrong: the UI builds its filter panel from /v1/fields, so a visitor
 * holding an hour-old copy of that after a schema change renders the old
 * filters against the new data and the page looks broken in a way no amount of
 * reloading fixes. Sixty seconds costs one conditional request and bounds how
 * long a client can disagree with the server about what the data looks like.
 */
const CACHE = 'public, max-age=60, s-maxage=86400, stale-while-revalidate=604800';

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

app.post('/v1/search', async (c) => {
  let req: SearchRequest;
  try {
    req = await c.req.json<SearchRequest>();
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400);
  }
  return runSearch(c.env.DB, req, c);
});

app.get('/v1/search', async (c) => {
  const req: SearchRequest = { filters: [] };
  const url = new URL(c.req.url);

  for (const [key, raw] of url.searchParams.entries()) {
    switch (key) {
      case 'q': req.q = raw; continue;
      case 'limit': req.limit = Number(raw); continue;
      case 'offset': req.offset = Number(raw); continue;
      case 'facets': req.facets = raw.split(',').filter(Boolean); continue;
      case 'combine':
        // Anything other than the one recognised value falls back to the
        // default rather than erroring: a stale link should still search.
        req.combine = raw === 'same_build' ? 'same_build' : 'any_build';
        continue;
      case 'sort':
        req.sort = raw.split(',').filter(Boolean).map((s) =>
          s.startsWith('-')
            ? { field: s.slice(1), dir: 'desc' as const }
            : { field: s, dir: 'asc' as const },
        );
        continue;
    }

    try {
      req.filters!.push(parseFilterParam(key, raw));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  }

  return runSearch(c.env.DB, req, c);
});

const OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'between', 'exists', 'contains']);

function parseFilterParam(field: string, raw: string) {
  getField(field); // throws on an unknown field, before anything else happens

  const colon = raw.indexOf(':');
  const maybeOp = colon > 0 ? raw.slice(0, colon) : '';
  const op = OPS.has(maybeOp) ? maybeOp : 'eq';
  const rest = OPS.has(maybeOp) ? raw.slice(colon + 1) : raw;

  if (op === 'exists') return { field, op: 'exists' as const };

  if (op === 'between') {
    const [lo, hi] = rest.split('..');
    if (lo === undefined || hi === undefined) {
      throw new Error(`${field}: "between" needs lo..hi`);
    }
    const a = splitUnit(lo);
    const b = splitUnit(hi);
    return { field, op: 'between' as const, value: [a.value, b.value], unit: a.unit ?? b.unit };
  }

  if (op === 'contains') return { field, op: 'contains' as const, value: rest };

  if (op === 'in' || rest.includes(',')) {
    const parts = rest.split(',').filter(Boolean);
    const parsed = parts.map(splitUnit);
    return {
      field,
      op: 'in' as const,
      value: parsed.map((p) => p.value),
      unit: parsed.find((p) => p.unit)?.unit,
    };
  }

  const { value, unit } = splitUnit(rest);
  return { field, op: op as 'eq', value, unit };
}

/** "3.0l" -> { value: 3, unit: 'l' }; "Flat" -> { value: 'Flat' }. */
function splitUnit(s: string): { value: string | number; unit?: string } {
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z/%0-9]*)$/.exec(s.trim());
  if (!m) return { value: s.trim() };
  return { value: Number(m[1]), unit: m[2] || undefined };
}

async function runSearch(db: D1Database, req: SearchRequest, c: { json: Function }) {
  let q;
  try {
    q = compile(req);
  } catch (e) {
    if (e instanceof QueryError || e instanceof Error) {
      return c.json({ error: (e as Error).message }, 400);
    }
    throw e;
  }

  try {
    const batch = await db.batch<Record<string, unknown>>([
      db.prepare(q.countSql).bind(...(q.countParams as never[])),
      db.prepare(q.sql).bind(...(q.params as never[])),
      ...q.facetQueries.map((f) => db.prepare(f.sql).bind(...(f.params as never[]))),
    ]);

    const countRow = batch[0]?.results?.[0] as { n: number } | undefined;
    const rows = batch[1]?.results ?? [];

    const facets = q.facetQueries.map((f, i) => ({
      field: f.facet,
      // +2 skips the count and page queries, which lead the batch.
      values: (batch[i + 2]?.results ?? []) as unknown as { value: unknown; n: number }[],
    }));

    return c.json(
      {
        total: countRow?.n ?? 0,
        limit: q.params[q.params.length - 2],
        offset: q.params[q.params.length - 1],
        results: rows.map(shapeResult),
        facets,
      },
      200,
      { 'Cache-Control': CACHE },
    );
  } catch (e) {
    return c.json({ error: `Query failed: ${(e as Error).message}` }, 500);
  }
}

/**
 * Reshape a flat row into vehicle/engine halves.
 *
 * The view returns them side by side because that is what makes the query one
 * scan, but a consumer thinks in terms of "a car, and the engine in it" -- and
 * a flat bag of thirteen keys makes the caller re-derive that structure every
 * time.
 *
 * `engine` is `null` when the vehicle has no engine paired yet -- Search_View
 * is a LEFT JOIN specifically so an incomplete entry is still returned rather
 * than dropped, and `null` here is what lets the UI say so instead of
 * rendering a bogus "0 cylinders, undefined L" engine that was never recorded.
 */
function shapeResult(r: Record<string, unknown>) {
  const type = r.Powertrain_Type ? String(r.Powertrain_Type) : null;
  // "Has no engine" and "has an engine nobody has recorded" are different
  // facts, and only the powertrain type can tell them apart. A BEV genuinely
  // has none; a car with no powertrain row at all is simply unrecorded.
  const electricOnly = type !== null && ['bev', 'fcev'].includes(type.toLowerCase());

  return {
    index: r.combo_index,
    vehicle: {
      index: r.ymm_index,
      make: r.Make,
      model: r.Model,
      year: r.Year,
      generation: r.Generation,
      dev_chassis_code: r.Dev_Chassis_Code,
      platform_code: r.Platform_Code,
      nickname: r.Nickname,
      name: `${r.Year} ${r.Make} ${r.Model}`,
    },
    powertrain:
      r.powertrain_index === null
        ? null
        : {
            index: r.powertrain_index,
            type,
            combined_horsepower: r.Combined_Horsepower,
            combined_torque_lbft: r.Combined_Torque_lbft,
            electric_range_mi: r.Electric_Range_mi,
            dc_charge_kw: r.DC_Charge_kW,
            ac_charge_kw: r.AC_Charge_kW,
            charge_port: r.Charge_Port,
            battery:
              r.Battery_Usable_kWh === null && r.Battery_Chemistry === null
                ? null
                : {
                    chemistry: r.Battery_Chemistry,
                    gross_kwh: r.Battery_Gross_kWh,
                    usable_kwh: r.Battery_Usable_kWh,
                  },
            // `false` where an engine is genuinely absent by design, `true`
            // where one just has not been entered. The UI needs the difference
            // to avoid telling someone a Tesla is missing data.
            engine_expected: !electricOnly,
          },
    engine:
      r.engine_index === null
        ? null
        : {
            index: r.engine_index,
            manufacturer: r.Manufacturer,
            code: r.Code,
            named_variant: r.Named_Variant,
            layout: r.Layout,
            cylinders: r.Cylinders,
            displacement_cc: r.CC_Displacement,
            aspiration: r.Aspiration,
            fuel_type: r.Fuel_Type,
            compression_ratio: r.Compression_ratio,
            fuel_delivery: r.Fuel_delivery,
            valvetrain: r.Valvetrain,
            redline_rpm: r.Redline_RPM,
            fuel_requirement: r.Fuel_Requirement,
            horsepower: r.Horsepower,
            torque_lbft: r.Torque_lbft,
            summary: engineSummary(r),
          },
    // Present only where builds have been recorded. These are the specs that
    // are true of a configuration rather than of the car, so they are reported
    // as the range across everything known rather than as single figures.
    capability:
      r.Build_Count === null || r.Build_Count === 0
        ? null
        : {
            build_count: r.Build_Count,
            max_towing_lb: r.Max_Towing_Capacity_lb,
            max_payload_lb: r.Max_Payload_lb,
            min_curb_weight_lb: r.Min_Curb_Weight_lb,
            max_gvwr_lb: r.Max_GVWR_lb,
            best_epa_combined_mpg: r.Max_EPA_Combined_mpg,
            quickest_zero_to_sixty_s: r.Min_Zero_To_Sixty_s,
            trims: r.Trim_Summary,
          },
  };
}

/** "3.0L twin-turbocharged flat-6, 503 hp" from the parts that are actually present. */
function engineSummary(r: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof r.CC_Displacement === 'number') {
    parts.push(`${(r.CC_Displacement / 1000).toFixed(1)}L`);
  }
  if (r.Aspiration) parts.push(String(r.Aspiration).toLowerCase());
  if (r.Layout && typeof r.Cylinders === 'number') {
    parts.push(`${String(r.Layout).toLowerCase()}-${r.Cylinders}`);
  } else if (r.Layout) {
    parts.push(String(r.Layout).toLowerCase());
  } else if (typeof r.Cylinders === 'number') {
    parts.push(`${r.Cylinders}-cylinder`);
  }
  let summary = parts.length ? parts.join(' ') : null;
  if (typeof r.Horsepower === 'number') {
    summary = summary ? `${summary}, ${r.Horsepower} hp` : `${r.Horsepower} hp`;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

// The UI builds its filter panel from this rather than a hand-kept copy, so a
// field added to the registry appears in the interface without a UI change.
app.get('/v1/fields', (c) =>
  c.json(
    {
      fields: FIELDS.map((f) => ({
        name: f.name,
        label: f.label,
        kind: f.kind,
        group: f.group,
        common: f.common ?? false,
        quantity: f.quantity,
        min: f.min,
        max: f.max,
        description: f.description,
        // `grain` tells the UI what a filter narrows to -- a car, the engine in
        // it, or one specific configuration of it. `sortable` is derived rather
        // than declared: only a column on the base view has a single value per
        // result row to order by.
        grain: f.grain ?? 'vehicle',
        sortable: (f.source ?? 'view') === 'view',
      })),
      // Sent so the filter panel can order its sections deliberately instead of
      // by whatever order the fields happen to appear in.
      groups: FIELD_GROUPS,
    },
    200,
    { 'Cache-Control': CACHE },
  ),
);

/**
 * Distinct values for every field, numeric or text alike.
 *
 * None of these columns have a controlled vocabulary -- there is no enum
 * table behind Layout or Fuel_Type, and Cylinders or Year are just whatever
 * has been entered. Serving the actual distinct values is what lets every
 * filter in the UI be a dropdown of real options instead of a free-text box
 * that invites a typo the database will silently fail to match.
 */
app.get('/v1/choices', async (c) => {
  // One indexed read of a table the loader already built, rather than one
  // GROUP BY per field over a multi-join view. At this field count the live
  // version was the most expensive query in the system and it ran on every
  // cold page load, before the visitor had done anything at all.
  const { results } = await c.env.DB.prepare(
    'SELECT Field_Name, Value, N FROM Field_Choices ORDER BY Field_Name, Value',
  ).all<{ Field_Name: string; Value: string; N: number }>();

  const choices: Record<string, { value: string | number; n: number }[]> = {};
  for (const f of FIELDS) choices[f.name] = [];
  for (const row of results ?? []) {
    const field = FIELD_BY_NAME.get(row.Field_Name);
    if (!field) continue;
    // Numeric fields are stored as text in the choice table (one column, mixed
    // types); handing them back as numbers keeps the client from having to
    // guess which ones to coerce before comparing against a filter value.
    choices[row.Field_Name]!.push({
      value: field.kind === 'number' ? Number(row.Value) : row.Value,
      n: row.N,
    });
  }

  return c.json({ choices }, 200, { 'Cache-Control': CACHE });
});

app.get('/v1/makes', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT Make AS make,
            COUNT(DISTINCT Model) AS models,
            COUNT(DISTINCT ymm_index) AS vehicle_years,
            MIN(Year) AS earliest,
            MAX(Year) AS latest
       FROM Search_View
      GROUP BY Make
      ORDER BY Make`,
  ).all();
  return c.json({ makes: results }, 200, { 'Cache-Control': CACHE });
});

// ---------------------------------------------------------------------------
// Table browsing
//
// Every table name and every column name below comes from the registry in
// packages/query/src/tables.ts, never from the request. A request names a table
// by key; an unknown key is rejected before any SQL is built. That is the same
// injection-safety-by-construction argument the field registry makes for
// search, applied to the one other place identifiers reach SQL.
// ---------------------------------------------------------------------------

app.get('/v1/tables', async (c) => {
  // Row counts come from one batched pass rather than a query per table.
  const counts = await c.env.DB.batch<{ n: number }>(
    TABLES.map((t) => c.env.DB.prepare(`SELECT COUNT(*) AS n FROM \`${t.name}\``)),
  );

  return c.json(
    {
      tables: TABLES.map((t, i) => ({
        name: t.name,
        label: t.label,
        group: t.group,
        role: t.role,
        description: t.description,
        csv: t.csv,
        column_count: t.columns.length,
        row_count: counts[i]?.results?.[0]?.n ?? 0,
      })),
    },
    200,
    { 'Cache-Control': CACHE },
  );
});

app.get('/v1/table/:name', async (c) => {
  let table;
  try {
    table = getTable(c.req.param('name'));
  } catch {
    return c.json({ error: `Unknown table: ${c.req.param('name')}` }, 404);
  }

  const url = new URL(c.req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

  const cols = table.columns.map((col) => `\`${col.name}\``).join(', ');

  const [countRes, rowsRes] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM \`${table.name}\``),
    c.env.DB
      .prepare(
        `SELECT ${cols} FROM \`${table.name}\`
          ORDER BY \`${table.orderBy}\`
          LIMIT ? OFFSET ?`,
      )
      .bind(limit, offset),
  ]);

  const total = (countRes?.results?.[0] as { n: number } | undefined)?.n ?? 0;

  return c.json(
    {
      table: {
        name: table.name,
        label: table.label,
        group: table.group,
        role: table.role,
        description: table.description,
        csv: table.csv,
        columns: table.columns,
      },
      total,
      limit,
      offset,
      rows: rowsRes?.results ?? [],
    },
    200,
    { 'Cache-Control': CACHE },
  );
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

app.get('/v1/vehicle/:index', async (c) => {
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index)) return c.json({ error: 'index must be an integer' }, 400);

  const vehicle = await c.env.DB.prepare(
    `SELECT "Index" AS "index", Make AS make, Model AS model, Year AS year, Generation AS generation,
            Dev_Chassis_Code AS dev_chassis_code, Platform_Code AS platform_code, Nickname AS nickname
       FROM Year_Make_Model WHERE "Index" = ?`,
  ).bind(index).first();

  if (!vehicle) return c.json({ error: 'Not found' }, 404);

  const { results: powertrains } = await c.env.DB.prepare(
    `SELECT p."Index" AS "index", p.Powertrain_Type AS type,
            p.Combined_Horsepower AS combined_horsepower,
            p.Combined_Torque_lbft AS combined_torque_lbft,
            p.Electric_Range_mi AS electric_range_mi,
            p.DC_Charge_kW AS dc_charge_kw, p.AC_Charge_kW AS ac_charge_kw,
            p.Charge_Port AS charge_port,
            e."Index" AS engine_index, e.Manufacturer AS engine_manufacturer,
            e.Code AS engine_code, e.Named_Variant AS engine_named_variant,
            e.Layout AS layout, e.Cylinders AS cylinders,
            e.CC_Displacement AS displacement_cc, e.Aspiration AS aspiration,
            e.Fuel_Type AS fuel_type, e.Compression_ratio AS compression_ratio,
            e.Fuel_delivery AS fuel_delivery, e.Horsepower AS horsepower,
            e.Torque_lbft AS torque_lbft,
            b.Chemistry AS battery_chemistry, b.Gross_kWh AS battery_gross_kwh,
            b.Usable_kWh AS battery_usable_kwh
       FROM YMM_Powertrains yp
       JOIN Powertrains p ON p."Index" = yp.Powertrain_Index
       LEFT JOIN Engine_Specs e ON e."Index" = p.Engine_Index
       LEFT JOIN Batteries b    ON b."Index" = p.Battery_Index
      WHERE yp.YMM_Index = ?
      ORDER BY e.CC_Displacement, p."Index"`,
  ).bind(index).all();

  // Every recorded configuration of this vehicle. This is the drill-down the
  // search results deliberately do not fan out into -- one row per build here,
  // rather than one result card per build on the search page.
  const { results: builds } = await c.env.DB.prepare(
    `SELECT bd."Index" AS "index", t.Trim_Name AS trim,
            bc.Body_Style AS body_style, bc.Cab_Config AS cab_config,
            bc.Bed_Length_in AS bed_length_in, bc.Wheelbase_in AS wheelbase_in,
            tx.Code AS transmission, tx.Type AS transmission_type,
            dt.Layout AS drive_layout, dt.Transfer_Case_Type AS transfer_case,
            sc.Capacity AS seating_capacity, sc.Second_Row_Type AS second_row_type,
            bd.Axle_Ratio AS axle_ratio, bd.Equipment_Note AS equipment_note,
            bd.Curb_Weight_lb AS curb_weight_lb, bd.GVWR_lb AS gvwr_lb,
            bd.Payload_lb AS payload_lb, bd.Towing_Capacity_lb AS towing_capacity_lb,
            bd.EPA_Combined_mpg AS epa_combined_mpg,
            bd.Zero_To_Sixty_s AS zero_to_sixty_s
       FROM Builds bd
       LEFT JOIN Trims t            ON t."Index"  = bd.Trim_Index
       LEFT JOIN Body_Configs bc    ON bc."Index" = bd.Body_Config_Index
       LEFT JOIN Transmissions tx   ON tx."Index" = bd.Transmission_Index
       LEFT JOIN Drivetrains dt     ON dt."Index" = bd.Drivetrain_Index
       LEFT JOIN Seating_Configs sc ON sc."Index" = bd.Seating_Config_Index
      WHERE bd.YMM_Index = ?
      ORDER BY t.Trim_Level, bd."Index"`,
  ).bind(index).all();

  const { results: bodies } = await c.env.DB.prepare(
    `SELECT bc."Index" AS "index", bc.Body_Style AS body_style, bc.Doors AS doors,
            bc.Cab_Config AS cab_config, bc.Bed_Length_in AS bed_length_in,
            bc.Wheelbase_in AS wheelbase_in, bc.Length_in AS length_in,
            bc.Width_in AS width_in, bc.Height_in AS height_in,
            bc.Ground_Clearance_in AS ground_clearance_in,
            bc.Cargo_Volume_cuft AS cargo_volume_cuft,
            bc.Fuel_Capacity_gal AS fuel_capacity_gal
       FROM YMM_Body_Configs ybc
       JOIN Body_Configs bc ON bc."Index" = ybc.Body_Config_Index
      WHERE ybc.YMM_Index = ?
      ORDER BY bc.Body_Style, bc.Cab_Config`,
  ).bind(index).all();

  const { results: trims } = await c.env.DB.prepare(
    `SELECT "Index" AS "index", Trim_Name AS name, Trim_Level AS level, Notes AS notes
       FROM Trims WHERE YMM_Index = ? ORDER BY Trim_Level, Trim_Name`,
  ).bind(index).all();

  return c.json(
    { vehicle, powertrains, builds, bodies, trims },
    200,
    { 'Cache-Control': CACHE },
  );
});

app.get('/v1/engine/:index', async (c) => {
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index)) return c.json({ error: 'index must be an integer' }, 400);

  const engine = await c.env.DB.prepare(
    `SELECT "Index" AS "index", Manufacturer AS manufacturer, Code AS code,
            Named_Variant AS named_variant, Layout AS layout, Cylinders AS cylinders,
            CC_Displacement AS displacement_cc, Aspiration AS aspiration,
            Fuel_Type AS fuel_type, Compression_ratio AS compression_ratio,
            Fuel_delivery AS fuel_delivery, Horsepower AS horsepower, Torque_lbft AS torque_lbft
       FROM Engine_Specs WHERE "Index" = ?`,
  ).bind(index).first();

  if (!engine) return c.json({ error: 'Not found' }, 404);

  // "What else used this engine" is the question the junction table exists to
  // answer, and the one a normalised engine catalog can answer that a
  // per-car spec sheet cannot.
  const { results: vehicles } = await c.env.DB.prepare(
    `SELECT v."Index" AS "index", v.Make AS make, v.Model AS model, v.Year AS year, v.Generation AS generation,
            v.Dev_Chassis_Code AS dev_chassis_code, v.Platform_Code AS platform_code, v.Nickname AS nickname
       FROM Powertrains p
       JOIN YMM_Powertrains yp   ON yp.Powertrain_Index = p."Index"
       JOIN Year_Make_Model v    ON v."Index" = yp.YMM_Index
      WHERE p.Engine_Index = ?
      ORDER BY v.Make, v.Model, v.Year`,
  ).bind(index).all();

  return c.json({ engine, vehicles }, 200, { 'Cache-Control': CACHE });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

app.get('/v1/stats', async (c) => {
  const summary = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM Year_Make_Model)          AS vehicle_years,
       (SELECT COUNT(DISTINCT Make) FROM Year_Make_Model) AS makes,
       (SELECT COUNT(*) FROM Engine_Specs)             AS engines,
       (SELECT COUNT(*) FROM Powertrains)              AS powertrains,
       (SELECT COUNT(*) FROM YMM_Powertrains)          AS pairings,
       (SELECT COUNT(*) FROM Builds)                   AS builds,
       (SELECT COUNT(*) FROM Body_Configs)             AS body_configs,
       (SELECT COUNT(*) FROM Trims)                    AS trims,
       (SELECT MIN(Year) FROM Year_Make_Model)         AS earliest_year,
       (SELECT MAX(Year) FROM Year_Make_Model)         AS latest_year`,
  ).first();

  const { results } = await c.env.DB.prepare('SELECT key, value FROM build_info').all<{
    key: string; value: string;
  }>();
  const build = Object.fromEntries((results ?? []).map((r) => [r.key, r.value]));

  return c.json({ ...summary, build }, 200, { 'Cache-Control': CACHE });
});

app.get('/health', (c) => c.json({ ok: true }));

export default app;
