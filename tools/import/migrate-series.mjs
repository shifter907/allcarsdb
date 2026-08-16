/**
 * Apply the series rename to the two hand-authored files.
 *
 * Only year_make_model.csv and ymm_powertrains.csv are migrated here. The body
 * configs and builds are generated files -- re-running their importers against
 * the renamed catalogue produces correct links directly, which is safer than
 * rewriting references after the fact.
 *
 * Run with --write to apply; without it, prints what it would do.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, esc } from './match-lib.mjs';
import { proposedRows, span } from './series-propose.mjs';
import { DATA } from './paths.mjs';

const WRITE = process.argv.includes('--write');
const toCsv = (header, rows) =>
  [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';

/**
 * Which nameplate each existing model belongs to.
 *
 * "Silverado HD" and "Silverado" both fold into the Silverado nameplate and are
 * then re-split by series, which is the whole point: the old pair of rows drew
 * the line in the wrong place, merging 2500HD with 3500HD while separating
 * neither from the 1500.
 *
 * Dodge's "Ram Van" and "Ram Wagon" both map to the B-Series vans they are.
 * Cargo versus passenger is a body configuration, not a different model, and it
 * is already recorded as one.
 */
const OLD_TO_NAMEPLATE = new Map(Object.entries({
  'Chevrolet|Silverado': 'Silverado',
  'Chevrolet|Silverado HD': 'Silverado',
  'Chevrolet|Silverado LD': 'Silverado',
  'Chevrolet|Express': 'Express',
  'Chevrolet|Suburban': 'Suburban',
  'Chevrolet|C/K Pickup': 'C/K',
  'GMC|Sierra': 'Sierra',
  'GMC|Sierra HD': 'Sierra',
  'GMC|Sierra Limited': 'Sierra',
  'GMC|Savana': 'Savana',
  'GMC|Suburban': 'Suburban',
  'GMC|Yukon XL': 'Yukon XL',
  'GMC|Vandura': 'Vandura',
  'GMC|Rally': 'Rally',
  'GMC|C/K Pickup': 'C/K',
  'Dodge|Ram': 'Ram',
  'Dodge|Ram 1500': 'Ram',
  'Dodge|Ram Van': 'B-Series',
  'Dodge|Ram Wagon': 'B-Series',
}));

/**
 * Which weight class each engine belongs to.
 *
 * This is the one part of the migration that cannot be mechanical. Renaming
 * "Silverado" to "Silverado 1500" wholesale would hang the 6.0L LQ4 on a
 * half-ton, and the LQ4 is the heavy-duty engine -- it went in the 1500HD,
 * 2500, 2500HD and 3500, never the base 1500. The LQ9 is the opposite case: a
 * 6.0 that genuinely is a light-duty engine, because it is the Silverado SS
 * unit. Displacement alone does not decide it, so each engine is listed.
 */
const HEAVY_ENGINES = new Set([
  'pt-chevrolet-lq4-6.0',   // Vortec 6000, the 2500/3500 gas V8 through 2007
  'pt-chevrolet-ly6-6.0',   // Vortec 6000 VVT, 2500-class
  'pt-chevrolet-l96-6.0',   // Vortec 6000, 2500HD/3500HD and 2500/3500 vans
  'pt-chevrolet-l8t-6.6',   // 6.6 gas V8, HD only
]);

/**
 * How a weight class maps to concrete series, per nameplate.
 *
 * Vans differ from pickups here: an Express 2500 was sold with the same 4.8 and
 * 5.3 as the 1500, so a light engine belongs to both. A Silverado 2500HD never
 * was, so it belongs only to the 1500.
 */
const CLASS_SERIES = {
  Silverado:  { light: ['1500', '1500 LD'], heavy: ['1500HD', '2500', '2500HD', '3500', '3500HD'] },
  Sierra:     { light: ['1500', '1500 Limited'], heavy: ['1500HD', '2500', '2500HD', '3500', '3500HD'] },
  Suburban:   { light: ['1500'], heavy: ['2500'] },
  'Yukon XL': { light: ['1500'], heavy: ['2500'] },
  Express:    { light: ['1500', '2500'], heavy: ['2500', '3500'] },
  Savana:     { light: ['1500', '2500'], heavy: ['2500', '3500'] },
};

// --- build the new catalogue -------------------------------------------------
const proposal = proposedRows();

/** make|nameplate|year -> Set(full model names the proposal puts there) */
const byNameplateYear = new Map();
/** Recover the nameplate from a proposed model name by longest-prefix. */
const NAMEPLATES = [...new Set(Object.values(Object.fromEntries(OLD_TO_NAMEPLATE)))]
  .sort((a, b) => b.length - a.length);
const nameplateOf = (model) =>
  NAMEPLATES.find((n) => model === n || model.startsWith(n + ' ')) ?? null;

for (const [make, model, year] of proposal) {
  const np = nameplateOf(model);
  if (!np) continue;
  const k = `${make}|${np}|${year}`;
  if (!byNameplateYear.has(k)) byNameplateYear.set(k, new Set());
  byNameplateYear.get(k).add(model);
}

const ymmRaw = parseCsv(readFileSync(DATA + 'year_make_model.csv', 'utf8'));
const ymmHeader = ymmRaw[0];
const kept = [], dropped = [];
for (const row of ymmRaw.slice(1)) {
  const [make, model, year] = row;
  const np = OLD_TO_NAMEPLATE.get(`${make}|${model}`);
  // Replaced only where the proposal actually covers that nameplate-year;
  // outside that range the original row is the only thing we know.
  if (np && byNameplateYear.has(`${make}|${np}|${year}`)) { dropped.push(row); continue; }
  kept.push(row);
}

const keptKeys = new Set(kept.map((r) => `${r[0]}|${r[1]}|${r[2]}`));
const added = [];
for (const [make, model, year] of proposal) {
  const k = `${make}|${model}|${year}`;
  if (keptKeys.has(k)) continue;
  keptKeys.add(k);
  added.push([make, model, String(year), '', '', '', '']);
}

const newYmm = [...kept, ...added].sort(
  (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || Number(a[2]) - Number(b[2]),
);

// --- migrate the engine pairings ---------------------------------------------
const newCatalogue = new Set(newYmm.map((r) => `${r[0]}|${r[1]}|${r[2]}`));
const ptRaw = parseCsv(readFileSync(DATA + 'ymm_powertrains.csv', 'utf8'));
const ptHeader = ptRaw[0];
const newPairs = new Map();
const unmapped = new Map();
let carried = 0, expanded = 0;

for (const row of ptRaw.slice(1)) {
  const [make, model, year, ref] = row;
  const np = OLD_TO_NAMEPLATE.get(`${make}|${model}`);
  const targets = byNameplateYear.get(`${make}|${np}|${year}`);
  if (!np || !targets) {
    newPairs.set(`${make}|${model}|${year}|${ref}`, row);
    carried++;
    continue;
  }

  const spec = CLASS_SERIES[np];
  if (!spec) {
    unmapped.set(`${make} ${np}`, (unmapped.get(`${make} ${np}`) ?? 0) + 1);
    continue;
  }
  const wanted = new Set(
    (HEAVY_ENGINES.has(ref) ? spec.heavy : spec.light).map((s) => `${np} ${s}`),
  );
  let hit = 0;
  for (const model2 of targets) {
    // The nameplate alone is a valid target when that year had one series.
    if (!wanted.has(model2) && model2 !== np) continue;
    if (!newCatalogue.has(`${make}|${model2}|${year}`)) continue;
    newPairs.set(`${make}|${model2}|${year}|${ref}`, [make, model2, year, ref]);
    hit++;
  }
  if (hit === 0) unmapped.set(`${make} ${np} ${ref}`, (unmapped.get(`${make} ${np} ${ref}`) ?? 0) + 1);
  else expanded += hit;
}

const newPtRows = [...newPairs.values()].sort(
  (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) ||
            Number(a[2]) - Number(b[2]) || a[3].localeCompare(b[3]),
);

// --- report ------------------------------------------------------------------
console.log(`year_make_model: ${ymmRaw.length - 1} -> ${newYmm.length}  (${dropped.length} replaced, ${added.length} added)`);
console.log(`ymm_powertrains: ${ptRaw.length - 1} -> ${newPtRows.length}  (${carried} untouched, ${expanded} re-pointed)`);

const byModel = new Map();
for (const r of added) {
  const k = `${r[0]} ${r[1]}`;
  if (!byModel.has(k)) byModel.set(k, new Set());
  byModel.get(k).add(Number(r[2]));
}
console.log(`\nnew models (${byModel.size}):`);
for (const k of [...byModel.keys()].sort()) console.log(`  ${k.padEnd(30)} ${span(byModel.get(k))}`);

if (unmapped.size) {
  console.log('\nPAIRINGS DROPPED (no series could be determined):');
  for (const [k, n] of unmapped) console.log(`  ${k}: ${n}`);
}

if (WRITE) {
  writeFileSync(DATA + 'year_make_model.csv', toCsv(ymmHeader, newYmm));
  writeFileSync(DATA + 'ymm_powertrains.csv', toCsv(ptHeader, newPtRows));
  console.log('\nwritten.');
} else {
  console.log('\n(dry run -- pass --write to apply)');
}
