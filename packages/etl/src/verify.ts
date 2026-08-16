/**
 * Smoke test against the built database.
 *
 *   npm run verify
 *
 * The compiler has unit tests; this checks the other half -- that the SQL it
 * emits is valid against the real schema, that the indices are actually used,
 * and that the row counts are what they should be.
 *
 * This file used to print query plans and assert nothing, which read like a
 * guard rail and was not one. Every check below either passes or fails the
 * build. The one that matters most is the plan check: a query that returns the
 * right answer by scanning a table nobody indexed is a bug that only shows up
 * as a slow site months later, once there is enough data for it to hurt.
 *
 * Exits non-zero on any failure so CI stops on it.
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

function pass(label: string, detail = '') {
  console.log(`  ok    ${label}${detail ? ` -> ${detail}` : ''}`);
}
function fail(label: string, detail: string) {
  failures++;
  console.error(`  FAIL  ${label}\n        ${detail}`);
}

function run(label: string, req: SearchRequest): number {
  const q = compile(req);
  try {
    const { n } = db.prepare(q.countSql).get(...(q.countParams as never[])) as { n: number };
    const rows = db.prepare(q.sql).all(...(q.params as never[]));
    for (const f of q.facetQueries) db.prepare(f.sql).all(...(f.params as never[]));
    pass(label, `${n} match(es), ${rows.length} returned`);
    return n;
  } catch (e) {
    fail(label, (e as Error).message);
    return -1;
  }
}

function rejects(label: string, req: SearchRequest, expect: RegExp) {
  try {
    compile(req);
    fail(label, 'expected a rejection, got none');
  } catch (e) {
    const msg = (e as Error).message;
    if (expect.test(msg)) pass(label, 'rejected');
    else fail(label, `wrong error: ${msg}`);
  }
}

/** Assert an exact row count, so a fan-out bug fails CI instead of going quiet. */
function expectCount(label: string, req: SearchRequest, expected: number) {
  const q = compile(req);
  try {
    const { n } = db.prepare(q.countSql).get(...(q.countParams as never[])) as { n: number };
    if (n === expected) pass(label, `${n}`);
    else fail(label, `expected ${expected} rows, got ${n}`);
  } catch (e) {
    fail(label, (e as Error).message);
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
run('at least 400 hp', { filters: [{ field: 'horsepower', op: 'gte', value: 400 }] });
run('free text', { q: 'porsche 911' });
run('faceted', {
  filters: [{ field: 'cylinders', op: 'gte', value: 8 }],
  facets: ['make', 'aspiration', 'fuel_type'],
});
run('sorted by displacement', { sort: [{ field: 'displacement', dir: 'desc' }], limit: 5 });
run('paginated', { limit: 10, offset: 20 });

console.log('\n  Expanded schema\n');

run('battery-electric', { filters: [{ field: 'powertrain_type', op: 'eq', value: 'BEV' }] });
run('body style (semi-join)', { filters: [{ field: 'body_style', op: 'eq', value: 'Pickup' }] });
run('towing (rollup fast path)', { filters: [{ field: 'towing_capacity', op: 'gte', value: 5000 }] });
run('drivetrain (semi-join through builds)', {
  filters: [{ field: 'drive_layout', op: 'eq', value: '4WD' }],
});
run('two build filters, any build', {
  filters: [
    { field: 'towing_capacity', op: 'gte', value: 5000 },
    { field: 'payload', op: 'gte', value: 1000 },
  ],
});
run('two build filters, same build', {
  combine: 'same_build',
  filters: [
    { field: 'axle_ratio', op: 'gte', value: 3.5 },
    { field: 'transmission_type', op: 'eq', value: 'Automatic' },
  ],
});
run('faceted on a semi-join field', {
  filters: [{ field: 'body_style', op: 'eq', value: 'Pickup' }],
  facets: ['cab_config', 'make'],
});

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
  { filters: [{ field: 'top_speed', op: 'gte', value: 150 }] },
  /Unknown field/,
);
rejects(
  'sorting by a semi-join field',
  { sort: [{ field: 'cab_config', dir: 'asc' }] },
  /no single value/,
);

// --- Row-count regressions --------------------------------------------------
// Pinned numbers, so a join that starts multiplying rows fails here rather than
// silently inflating every result count on the site.
console.log('\n  Row counts\n');

const vehicles = (db.prepare('SELECT COUNT(*) AS n FROM Year_Make_Model').get() as { n: number }).n;
const pairings = (db.prepare('SELECT COUNT(*) AS n FROM YMM_Powertrains').get() as { n: number }).n;
const unpaired = (
  db.prepare(
    `SELECT COUNT(*) AS n FROM Year_Make_Model ymm
      WHERE NOT EXISTS (SELECT 1 FROM YMM_Powertrains yp WHERE yp.YMM_Index = ymm."Index")`,
  ).get() as { n: number }
).n;

// Every vehicle contributes either its pairings or exactly one placeholder row.
// If Search_View ever gains a second one-to-many join, this is what catches it.
expectCount('search rows == pairings + unpaired vehicles', {}, pairings + unpaired);
pass('vehicles', `${vehicles}`);

// --- Query plans ------------------------------------------------------------
// A query that returns the right answer by scanning everything is a bug that
// only shows up as a slow site once the data grows, so the plan is checked
// while the dataset is still small enough for a scan to look fast.
console.log('\n  Query plans\n');

function planFor(req: SearchRequest): string[] {
  const q = compile(req);
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${q.countSql}`).all(...(q.countParams as never[])) as
      { detail: string }[]
  ).map((p) => p.detail);
}

function checkPlan(label: string, req: SearchRequest, forbidden: RegExp) {
  const plan = planFor(req);
  console.log(`  ${label}`);
  for (const line of plan) console.log(`    ${line}`);
  const offender = plan.find((l) => forbidden.test(l));
  if (offender) fail(`${label} -- plan`, `unindexed access: ${offender}`);
}

checkPlan(
  'by make',
  { filters: [{ field: 'make', op: 'eq', value: 'Porsche' }] },
  /SCAN (ymm|Year_Make_Model)\b(?!.*USING (COVERING )?INDEX)/,
);
checkPlan(
  'by engine shape',
  { filters: [{ field: 'cylinders', op: 'eq', value: 6 }, { field: 'layout', op: 'eq', value: 'Flat' }] },
  /SCAN eng\b(?!.*USING)/,
);
// The one that matters most at scale: a build-level filter must seek into
// Builds through its correlation index, never scan the whole table per row.
checkPlan(
  'by towing (rollup)',
  { filters: [{ field: 'towing_capacity', op: 'gte', value: 10000 }] },
  /SCAN br\b(?!.*USING)/,
);
checkPlan(
  'by axle ratio (semi-join into Builds)',
  { filters: [{ field: 'axle_ratio', op: 'eq', value: 3.73 }] },
  /SCAN b\b(?!.*USING)/,
);

const counts = db.prepare(
  `SELECT
     (SELECT COUNT(*) FROM Year_Make_Model) AS vehicles,
     (SELECT COUNT(*) FROM Powertrains)     AS powertrains,
     (SELECT COUNT(*) FROM Engine_Specs)    AS engines,
     (SELECT COUNT(*) FROM Builds)          AS builds,
     (SELECT COUNT(*) FROM Field_Choices)   AS choices,
     (SELECT COUNT(*) FROM Search_View)     AS searchable`,
).get() as Record<string, number>;

console.log(
  `\n  ${counts.vehicles} vehicle-years, ${counts.powertrains} powertrains, ` +
    `${counts.engines} engines, ${counts.builds} builds, ` +
    `${counts.choices} materialised choices, ${counts.searchable} searchable rows`,
);

db.close();

if (failures) {
  console.error(`\n  ${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
