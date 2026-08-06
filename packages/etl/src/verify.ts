/**
 * Smoke test against the built database.
 *
 *   npm run verify
 *
 * The compiler has unit tests; this checks the other half -- that the SQL it
 * emits is valid against the real schema and that the indices are actually
 * used. A query can be perfectly correct and still be a full scan, and the
 * only way to know is to ask SQLite what it plans to do.
 *
 * Exits non-zero on the first failure so CI stops on it.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile, type SearchRequest } from '@allcarsdb/query';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DB_PATH = join(ROOT, 'dist', 'allcars.sqlite');

if (!existsSync(DB_PATH)) {
  console.error('\n  dist/allcars.sqlite not found. Run `npm run build:db` first.\n');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
let failures = 0;

function run(label: string, req: SearchRequest) {
  const q = compile(req);
  try {
    const { n } = db.prepare(q.countSql).get(...(q.countParams as never[])) as { n: number };
    const rows = db.prepare(q.sql).all(...(q.params as never[]));
    for (const f of q.facetQueries) db.prepare(f.sql).all(...(f.params as never[]));
    console.log(`  ok    ${label} -> ${n} match(es), ${rows.length} returned`);
    return n;
  } catch (e) {
    failures++;
    console.error(`  FAIL  ${label}\n        ${(e as Error).message}`);
    return -1;
  }
}

function rejects(label: string, req: SearchRequest, expect: RegExp) {
  try {
    compile(req);
    failures++;
    console.error(`  FAIL  ${label} -- expected a rejection, got none`);
  } catch (e) {
    if (expect.test((e as Error).message)) {
      console.log(`  ok    ${label} -> rejected`);
    } else {
      failures++;
      console.error(`  FAIL  ${label} -- wrong error: ${(e as Error).message}`);
    }
  }
}

console.log('\n  Queries\n');

run('all rows', {});
run('naturally aspirated flat-6', {
  filters: [
    { field: 'layout', op: 'eq', value: 'Flat' },
    { field: 'cylinders', op: 'eq', value: 6 },
    { field: 'aspiration', op: 'eq', value: 'Naturally Aspirated' },
  ],
});
run('3.0 litres, give or take', {
  filters: [{ field: 'displacement', op: 'eq', value: 3, unit: 'l' }],
});
run('under 2 litres, turbocharged', {
  filters: [
    { field: 'displacement', op: 'lt', value: 2, unit: 'l' },
    { field: 'aspiration', op: 'contains', value: 'turbo' },
  ],
});
run('diesel, 2015 or newer', {
  filters: [
    { field: 'fuel_type', op: 'eq', value: 'Diesel' },
    { field: 'year', op: 'gte', value: 2015 },
  ],
});
run('free text', { q: 'porsche 911' });
run('faceted', { filters: [{ field: 'cylinders', op: 'gte', value: 8 }], facets: ['make', 'aspiration', 'fuel_type'] });
run('sorted by displacement', { sort: [{ field: 'displacement', dir: 'desc' }], limit: 5 });
run('paginated', { limit: 10, offset: 20 });

console.log('\n  Guards\n');

rejects(
  'a five-digit year',
  { filters: [{ field: 'year', op: 'eq', value: 20226 }] },
  /plausible maximum/,
);
rejects(
  'a numeric comparison on a text column',
  { filters: [{ field: 'fuel_type', op: 'gte', value: 5 }] },
  /which is text/,
);
rejects(
  'an unknown field',
  { filters: [{ field: 'horsepower', op: 'gte', value: 500 }] },
  /Unknown field/,
);

// --- Query plans -----------------------------------------------------------
// A query that returns the right answer by scanning everything is a bug that
// only shows up as a slow site once the data grows, so the plan is checked
// while the dataset is still small enough for a scan to look fast.
console.log('\n  Query plans\n');

for (const [label, req] of [
  ['by make', { filters: [{ field: 'make', op: 'eq', value: 'Porsche' }] }],
  ['by engine shape', { filters: [{ field: 'cylinders', op: 'eq', value: 6 }, { field: 'layout', op: 'eq', value: 'Flat' }] }],
  ['by displacement', { filters: [{ field: 'displacement', op: 'lt', value: 2000 }] }],
] as [string, SearchRequest][]) {
  const q = compile(req);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.countSql}`).all(...(q.countParams as never[])) as
    { detail: string }[];
  console.log(`  ${label}`);
  for (const p of plan) console.log(`    ${p.detail}`);
}

const counts = db.prepare(
  `SELECT
     (SELECT COUNT(*) FROM Year_Make_Model) AS vehicles,
     (SELECT COUNT(*) FROM Engine_Specs)    AS engines,
     (SELECT COUNT(*) FROM YMM_Engines)     AS pairings,
     (SELECT COUNT(*) FROM Search_View)     AS searchable`,
).get() as Record<string, number>;

console.log(
  `\n  ${counts.vehicles} vehicle-years, ${counts.engines} engines, ` +
    `${counts.pairings} pairings, ${counts.searchable} searchable rows`,
);

db.close();

if (failures) {
  console.error(`\n  ${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
