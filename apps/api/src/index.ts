/**
 * AllCarsDB read API -- Cloudflare Worker over D1.
 *
 * Read-only by design. There is no write path, no authentication and no
 * session state, because data changes happen as pull requests against the
 * YAML in this repository and reach production through a rebuild. That single
 * decision removes the entire class of problems a community database usually
 * spends its life fighting: spam, vandalism, account management, moderation
 * queues, and an admin UI nobody wants to maintain.
 *
 * Consequences worth knowing:
 *   - Every response is cacheable. The data only changes when a build ships.
 *   - The Worker can run at the edge with no origin.
 *   - Rolling back bad data is `git revert`.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compile, QueryError, type SearchRequest, type FeatureBitMap } from '@allcarsdb/query/compiler';
import { FIELDS, getField } from '@allcarsdb/query/fields';
import { ENUM_REGISTRY } from '@allcarsdb/schema/enums';

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
 * Cache-Control for data endpoints. The database is immutable between builds,
 * so a long browser TTL plus a longer edge TTL is correct rather than merely
 * convenient -- and stale-while-revalidate means a deploy never causes a
 * latency spike.
 */
const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

// ---------------------------------------------------------------------------
// Feature bit map, loaded once per isolate
// ---------------------------------------------------------------------------
// Needed by the compiler to choose the bitmask path over the join path. It
// changes only at build time, so caching it for the life of the isolate is
// safe; a deploy creates new isolates.

let featureBitsCache: FeatureBitMap | null = null;

async function getFeatureBits(db: D1Database): Promise<FeatureBitMap> {
  if (featureBitsCache) return featureBitsCache;
  // search_bit lives in the feature catalog YAML, and the build mirrors it
  // into build_info so the Worker does not need the repository.
  const row = await db
    .prepare(`SELECT value FROM build_info WHERE key = 'feature_bits'`)
    .first<{ value: string }>();
  const map = new Map<string, number>();
  if (row?.value) {
    for (const [slug, bit] of Object.entries(JSON.parse(row.value) as Record<string, number>)) {
      map.set(slug, bit);
    }
  }
  featureBitsCache = map;
  return map;
}

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

/**
 * GET form, so a search is a shareable URL.
 *
 *   /v1/search?engine_layout=flat&cylinders=6&aspiration=naturally_aspirated
 *             &valves_total=gte:24&has=massage-seats-front&sort=-horsepower
 *
 * Operators are a `op:value` prefix; bare values mean equality. Ranges use
 * `between:lo..hi`. Units attach to the value: `cargo_behind_second=gte:65cuft`.
 */
app.get('/v1/search', async (c) => {
  const req: SearchRequest = { filters: [], features: [] };
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
      case 'has':
        for (const slug of raw.split(',').filter(Boolean)) req.features!.push({ feature: slug });
        continue;
      case 'has_standard':
        for (const slug of raw.split(',').filter(Boolean)) {
          req.features!.push({ feature: slug, availability: ['standard'] });
        }
        continue;
      case 'without':
        for (const slug of raw.split(',').filter(Boolean)) {
          req.features!.push({ feature: slug, absent: true });
        }
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

const OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'between', 'exists']);

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

/** "65cuft" -> { value: 65, unit: 'cuft' }; "flat" -> { value: 'flat' }. */
function splitUnit(s: string): { value: string | number; unit?: string } {
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z/%0-9]*)$/.exec(s.trim());
  if (!m) return { value: s.trim() };
  return { value: Number(m[1]), unit: m[2] || undefined };
}

// ---------------------------------------------------------------------------

async function runSearch(db: D1Database, req: SearchRequest, c: { json: Function }) {
  let q;
  try {
    q = compile(req, await getFeatureBits(db));
  } catch (e) {
    if (e instanceof QueryError || e instanceof Error) {
      return c.json({ error: e.message }, 400);
    }
    throw e;
  }

  // D1 runs these in one round trip rather than three.
  const statements = [
    db.prepare(q.sql).bind(...(q.params as never[])),
    db.prepare(q.countSql).bind(...(q.countParams as never[])),
    ...q.facetQueries.map((f) => db.prepare(f.sql).bind(...(f.params as never[]))),
  ];

  const results = await db.batch(statements);
  const rows = (results[0]?.results ?? []) as Record<string, unknown>[];
  const total = ((results[1]?.results?.[0] as { n: number } | undefined)?.n) ?? 0;

  const facets: Record<string, { value: unknown; label: string | null; count: number }[]> = {};
  q.facetQueries.forEach((fq, i) => {
    const field = getField(fq.facet);
    const raw = (results[2 + i]?.results ?? []) as { value: number; n: number }[];
    facets[fq.facet] = raw.map((r) => ({
      value: field.enumName ? ENUM_REGISTRY[field.enumName].fromCode(r.value)?.slug ?? r.value : r.value,
      label: field.enumName ? ENUM_REGISTRY[field.enumName].fromCode(r.value)?.label ?? null : null,
      count: r.n,
    }));
  });

  return c.json(
    {
      total,
      limit: Math.min(req.limit ?? 50, 200),
      offset: req.offset ?? 0,
      results: rows.map(shapeResult),
      facets: Object.keys(facets).length ? facets : undefined,
    },
    200,
    { 'Cache-Control': CACHE },
  );
}

function shapeResult(r: Record<string, unknown>) {
  return {
    id: r.variant_id,
    name: r.full_name,
    make: r.make_name,
    model: r.model_name,
    year: r.year,
    trim: r.trim_name,
    variant: r.variant_name,
    body: r.body_name,
    engine: r.engine_summary,
    drivetrain: r.drivetrain_summary,
    url: r.url_path,
    specs: {
      horsepower: r.combined_hp,
      torque_lbft: r.combined_torque_lbft,
      curb_weight_kg: r.curb_weight_kg,
      zero_to_60_s: r.zero_to_60_mph_s,
      cargo_behind_second_l: r.cargo_behind_second_l,
      seat_height_mm: r.seat_height_front_mm,
      mpg_combined: r.mpg_combined,
      mpge_combined: r.mpge_combined,
      electric_range_mi: r.electric_range_mi,
      towing_max_kg: r.towing_max_kg,
      msrp: r.msrp_minor != null ? (r.msrp_minor as number) / 100 : null,
      currency: r.msrp_currency,
    },
    quality: { completeness: r.completeness, confidence: r.confidence_code },
  };
}

// ---------------------------------------------------------------------------
// Metadata -- the UI builds its filter panel from these, so the client can
// never drift from the server's idea of what is searchable.
// ---------------------------------------------------------------------------

app.get('/v1/fields', (c) =>
  c.json(
    {
      fields: FIELDS.map((f) => ({
        name: f.name,
        label: f.label,
        kind: f.kind,
        group: f.group,
        quantity: f.quantity ?? null,
        enum: f.enumName ?? null,
        common: !!f.common,
        min: f.min ?? null,
        max: f.max ?? null,
        description: f.description ?? null,
      })),
    },
    200,
    { 'Cache-Control': CACHE },
  ),
);

app.get('/v1/enums', (c) =>
  c.json(
    Object.fromEntries(
      Object.entries(ENUM_REGISTRY).map(([name, def]) => [
        name,
        def.members
          .filter((m) => !m.deprecated)
          .map((m) => ({ slug: m.slug, label: m.label, note: m.note ?? null })),
      ]),
    ),
    200,
    { 'Cache-Control': CACHE },
  ),
);

app.get('/v1/features', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.slug, f.name, f.value_type, f.value_unit, f.is_common,
            e.slug AS category, p.slug AS parent,
            (SELECT COUNT(*) FROM variant_feature vf WHERE vf.feature_id = f.id) AS usage_count
       FROM feature f
       LEFT JOIN feature p    ON p.id = f.parent_id
       LEFT JOIN enum_label e ON e.enum_name = 'feature_category' AND e.code = f.category_code
      ORDER BY f.category_code, f.name`,
  ).all();
  return c.json({ features: results }, 200, { 'Cache-Control': CACHE });
});

app.get('/v1/makes', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT mk.id, mk.slug, mk.name, mk.country_code,
            COUNT(DISTINCT vs.model_id) AS model_count,
            COUNT(*) AS variant_count
       FROM variant_search vs JOIN make mk ON mk.id = vs.make_id
      GROUP BY mk.id ORDER BY mk.name`,
  ).all();
  return c.json({ makes: results }, 200, { 'Cache-Control': CACHE });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

app.get('/v1/variant/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400);

  const batch = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT d.*, s.*,
              se.*, si.*, sp.*, sc.*, ch.*
         FROM variant_display d
         JOIN variant_search s        ON s.variant_id = d.variant_id
         LEFT JOIN spec_exterior se   ON se.variant_id = d.variant_id
         LEFT JOIN spec_interior si   ON si.variant_id = d.variant_id
         LEFT JOIN spec_performance sp ON sp.variant_id = d.variant_id
         LEFT JOIN spec_capacity sc   ON sc.variant_id = d.variant_id
         LEFT JOIN spec_chassis ch    ON ch.variant_id = d.variant_id
        WHERE d.variant_id = ?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT f.slug, f.name, f.value_type, vf.value_num, vf.value_text,
              a.slug AS availability, a.label AS availability_label,
              cat.slug AS category, op.name AS package_name,
              vf.price_minor
         FROM variant_feature vf
         JOIN feature f          ON f.id = vf.feature_id
         LEFT JOIN enum_label a  ON a.enum_name = 'availability' AND a.code = vf.availability_code
         LEFT JOIN enum_label cat ON cat.enum_name = 'feature_category' AND cat.code = f.category_code
         LEFT JOIN option_package op ON op.id = vf.package_id
        WHERE vf.variant_id = ?
        ORDER BY f.category_code, f.name`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT ef.*, c.slug AS cycle, c.label AS cycle_label
         FROM spec_efficiency ef
         LEFT JOIN enum_label c ON c.enum_name = 'test_cycle' AND c.code = ef.cycle_code
        WHERE ef.variant_id = ?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT DISTINCT s.title, s.publisher, s.url, s.archive_url, s.document_type,
              s.published_date, fs.column_name
         FROM fact_source fs JOIN source s ON s.id = fs.source_id
        WHERE fs.table_name IN ('variant','spec_exterior','spec_interior','spec_performance')
          AND fs.row_id = ?`,
    ).bind(id),
  ]);

  const rowsAt = (i: number) => batch[i]?.results ?? [];
  const row = rowsAt(0)[0];
  if (!row) return c.json({ error: 'Not found' }, 404);

  return c.json(
    {
      variant: row,
      features: rowsAt(1),
      efficiency: rowsAt(2),
      sources: rowsAt(3),
    },
    200,
    { 'Cache-Control': CACHE },
  );
});

// ---------------------------------------------------------------------------
// Contribution funnel
// ---------------------------------------------------------------------------
// The most effective way to turn a visitor into a contributor is to show them
// a specific, small, obviously-fillable gap rather than an invitation to
// "help out". This endpoint backs that page.

app.get('/v1/gaps', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const { results } = await c.env.DB.prepare(
    `SELECT d.full_name, d.url_path, g.column_name, g.priority, d.variant_id
       FROM data_gap g JOIN variant_display d ON d.variant_id = g.variant_id
      ORDER BY g.priority DESC, g.variant_id
      LIMIT ?`,
  ).bind(limit).all();
  return c.json({ gaps: results }, 200, { 'Cache-Control': 'public, max-age=600' });
});

app.get('/v1/stats', async (c) => {
  const batch = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS variants, ROUND(AVG(completeness)) AS avg_completeness,
              COUNT(DISTINCT make_id) AS makes, COUNT(DISTINCT model_id) AS models,
              MIN(year) AS earliest_year, MAX(year) AS latest_year
         FROM variant_search`,
    ),
    c.env.DB.prepare(`SELECT key, value FROM build_info WHERE key <> 'feature_bits'`),
  ]);

  const summary = (batch[0]?.results?.[0] ?? {}) as Record<string, unknown>;
  const build = Object.fromEntries(
    ((batch[1]?.results ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );

  return c.json({ ...summary, build }, 200, { 'Cache-Control': CACHE });
});

app.get('/health', (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((e, c) => {
  console.error(e);
  return c.json({ error: 'Internal error' }, 500);
});

export default app;
