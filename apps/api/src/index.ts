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
  FIELDS,
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
            summary: engineSummary(r),
          },
  };
}

/** "3.0L twin-turbocharged flat-6" from the parts that are actually present. */
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
  return parts.length ? parts.join(' ') : null;
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
      })),
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
  const rows = await c.env.DB.batch(
    FIELDS.map((f) =>
      c.env.DB.prepare(
        `SELECT \`${f.column}\` AS value, COUNT(*) AS n
           FROM Search_View
          WHERE \`${f.column}\` IS NOT NULL
          GROUP BY \`${f.column}\`
          ORDER BY \`${f.column}\` ASC
          LIMIT 500`,
      ),
    ),
  );

  const choices: Record<string, { value: string | number; n: number }[]> = {};
  FIELDS.forEach((f, i) => {
    choices[f.name] = (rows[i]?.results ?? []) as { value: string | number; n: number }[];
  });

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

  const { results: engines } = await c.env.DB.prepare(
    `SELECT e."Index" AS "index", e.Manufacturer AS manufacturer, e.Code AS code,
            e.Named_Variant AS named_variant, e.Layout AS layout, e.Cylinders AS cylinders,
            e.CC_Displacement AS displacement_cc, e.Aspiration AS aspiration,
            e.Fuel_Type AS fuel_type, e.Compression_ratio AS compression_ratio,
            e.Fuel_delivery AS fuel_delivery
       FROM YMM_Engines ye
       JOIN Engine_Specs e ON e."Index" = ye.Engine_Index
      WHERE ye.YMM_Index = ?
      ORDER BY e.CC_Displacement`,
  ).bind(index).all();

  return c.json({ vehicle, engines }, 200, { 'Cache-Control': CACHE });
});

app.get('/v1/engine/:index', async (c) => {
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index)) return c.json({ error: 'index must be an integer' }, 400);

  const engine = await c.env.DB.prepare(
    `SELECT "Index" AS "index", Manufacturer AS manufacturer, Code AS code,
            Named_Variant AS named_variant, Layout AS layout, Cylinders AS cylinders,
            CC_Displacement AS displacement_cc, Aspiration AS aspiration,
            Fuel_Type AS fuel_type, Compression_ratio AS compression_ratio,
            Fuel_delivery AS fuel_delivery
       FROM Engine_Specs WHERE "Index" = ?`,
  ).bind(index).first();

  if (!engine) return c.json({ error: 'Not found' }, 404);

  // "What else used this engine" is the question the junction table exists to
  // answer, and the one a normalised engine catalog can answer that a
  // per-car spec sheet cannot.
  const { results: vehicles } = await c.env.DB.prepare(
    `SELECT v."Index" AS "index", v.Make AS make, v.Model AS model, v.Year AS year, v.Generation AS generation,
            v.Dev_Chassis_Code AS dev_chassis_code, v.Platform_Code AS platform_code, v.Nickname AS nickname
       FROM YMM_Engines ye
       JOIN Year_Make_Model v ON v."Index" = ye.YMM_Index
      WHERE ye.Engine_Index = ?
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
       (SELECT COUNT(*) FROM YMM_Engines)              AS pairings,
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
