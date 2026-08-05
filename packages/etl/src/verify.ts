/**
 * Smoke test: run the compiler against the built database.
 *
 * Not a substitute for unit tests, but it is the check that matters most --
 * it proves the whole chain works end to end, from a filter expressed in the
 * units a person would actually type, through unit conversion and enum
 * resolution, to rows out of the index.
 *
 *   npm run verify -w @allcarsdb/etl
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type SearchRequest } from '@allcarsdb/query/compiler';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const db = new DatabaseSync(join(ROOT, 'dist', 'allcars.sqlite'), { readOnly: true });

// The bit map the compiler needs in order to take the fast path. In the Worker
// this is loaded once at startup and cached.
const featureBits = new Map<string, number>();
for (const row of db.prepare(`SELECT slug, id FROM feature`).all() as { slug: string; id: number }[]) {
  void row;
}
// Bits live in data/features.yaml, not the database, so read them from the
// same place the build did. Kept deliberately simple here.
const { parse } = await import('yaml');
const { readFile } = await import('node:fs/promises');
const catalog = parse(await readFile(join(ROOT, 'data', 'features.yaml'), 'utf8')) as {
  features: { slug: string; search_bit?: number }[];
};
for (const f of catalog.features) {
  if (f.search_bit !== undefined) featureBits.set(f.slug, f.search_bit);
}

function run(label: string, req: SearchRequest) {
  console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);
  let q;
  try {
    q = compile(req, featureBits);
  } catch (e) {
    console.log(`  REJECTED: ${(e as Error).message}`);
    return;
  }

  const total = (db.prepare(q.countSql).get(...(q.countParams as never[])) as { n: number }).n;
  const rows = db.prepare(q.sql).all(...(q.params as never[])) as Record<string, unknown>[];

  console.log(`  ${total} match${total === 1 ? '' : 'es'}`);
  for (const r of rows) {
    const bits: string[] = [];
    if (r.combined_hp) bits.push(`${r.combined_hp} hp`);
    if (r.zero_to_60_mph_s) bits.push(`${r.zero_to_60_mph_s}s 0-60`);
    if (r.curb_weight_kg) bits.push(`${Math.round((r.curb_weight_kg as number) / 0.45359237)} lb`);
    if (r.cargo_behind_second_l) bits.push(`${((r.cargo_behind_second_l as number) / 28.3168).toFixed(1)} cu ft`);
    if (r.electric_range_mi) bits.push(`${Math.round(r.electric_range_mi as number)} mi EV`);
    if (r.msrp_minor) bits.push(`$${((r.msrp_minor as number) / 100).toLocaleString('en-US')}`);
    console.log(`    ${r.full_name}`);
    console.log(`      ${r.engine_summary ?? '-'} | ${r.drivetrain_summary ?? '-'}`);
    if (bits.length) console.log(`      ${bits.join('  ')}`);
  }
  if (total === 0) console.log('    (none)');
}

// ---------------------------------------------------------------------------

run('Flat-6, at least 24 valves, naturally aspirated', {
  filters: [
    { field: 'engine_layout', op: 'eq', value: 'flat' },
    { field: 'cylinders', op: 'eq', value: 6 },
    { field: 'valves_total', op: 'gte', value: 24 },
    { field: 'aspiration', op: 'eq', value: 'naturally_aspirated' },
  ],
  sort: [{ field: 'horsepower', dir: 'desc' }],
});

run('...and an open roof of any kind (the full original query)', {
  filters: [
    { field: 'engine_layout', op: 'eq', value: 'flat' },
    { field: 'cylinders', op: 'eq', value: 6 },
    { field: 'valves_total', op: 'gte', value: 24 },
    { field: 'aspiration', op: 'eq', value: 'naturally_aspirated' },
    { field: 'roof_type', op: 'in', value: ['soft_top', 'retractable_hardtop', 'targa', 't_top'] },
  ],
});

run('Any flat-6 with a targa or folding hardtop roof', {
  filters: [
    { field: 'engine_layout', op: 'eq', value: 'flat' },
    { field: 'cylinders', op: 'eq', value: 6 },
    { field: 'roof_type', op: 'in', value: ['targa', 'retractable_hardtop'] },
  ],
});

run('Hybrid + AWD + massage seat option + 65 cu ft cargo', {
  filters: [
    { field: 'hybrid_type', op: 'in', value: ['hev', 'phev', 'mhev_48v', 'erev'] },
    { field: 'drivetrain', op: 'in', value: ['awd', 'through_road_awd', 'fwd_biased_awd', 'rwd_biased_awd'] },
    { field: 'cargo_behind_first', op: 'gte', value: 65, unit: 'cuft' },
  ],
  features: [{ feature: 'massage-seats-front' }],
});

run('Same, but massage seats must be STANDARD (not optional)', {
  filters: [
    { field: 'hybrid_type', op: 'in', value: ['hev', 'phev', 'mhev_48v'] },
    { field: 'drivetrain', op: 'in', value: ['awd', 'through_road_awd'] },
  ],
  features: [{ feature: 'massage-seats-front', availability: ['standard'] }],
});

run('Manual transmission, under 2500 lb', {
  filters: [
    { field: 'transmission_type', op: 'eq', value: 'manual' },
    { field: 'curb_weight', op: 'lt', value: 2500, unit: 'lb' },
  ],
});

run('Metric input: over 370 kW, i.e. ~500 hp', {
  filters: [{ field: 'horsepower', op: 'gte', value: 370, unit: 'kw' }],
  sort: [{ field: 'horsepower', dir: 'desc' }],
});

run('Free text: "gt3 manual"', { q: 'gt3 manual' });

run('Guard rail: length of 4.5 with no unit (means 4.5 mm)', {
  filters: [{ field: 'length', op: 'gte', value: 4.5 }],
});

// ---------------------------------------------------------------------------
// Query plan -- confirms the index strategy is doing what it claims
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(78)}\nQuery plan for the flat-6 search\n${'='.repeat(78)}`);
const plan = compile({
  filters: [
    { field: 'engine_layout', op: 'eq', value: 'flat' },
    { field: 'cylinders', op: 'eq', value: 6 },
    { field: 'aspiration', op: 'eq', value: 'naturally_aspirated' },
  ],
}, featureBits);
for (const r of db.prepare(`EXPLAIN QUERY PLAN ${plan.countSql}`).all(...(plan.countParams as never[])) as { detail: string }[]) {
  console.log(`  ${r.detail}`);
}

console.log(`\n${'='.repeat(78)}\nQuery plan for a bitmask feature filter\n${'='.repeat(78)}`);
const plan2 = compile({ features: [{ feature: 'massage-seats-front' }] }, featureBits);
console.log(`  SQL: ${plan2.countSql.replace(/\s+/g, ' ').trim()}`);
for (const r of db.prepare(`EXPLAIN QUERY PLAN ${plan2.countSql}`).all(...(plan2.countParams as never[])) as { detail: string }[]) {
  console.log(`  ${r.detail}`);
}

db.close();
