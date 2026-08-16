/**
 * Build a reviewable list of the EPA rows the importer drops.
 *
 * Grouped by distinct (make, EPA model name) rather than listed per row: the
 * unmatched rows collapse to far fewer distinct names, and a decision about a
 * name applies to every row carrying it. Each one gets the closest models we
 * already have, with the evidence behind the guess -- how much of the name
 * overlaps, and how well the model years line up -- so a human can confirm or
 * reject without looking each car up.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseCsv, esc, loadCatalogue, matchVehicle, stripSuffixes, loose } from './match-lib.mjs';
import { resolveSeries } from './series-map.mjs';
import { DATA, CACHE } from './paths.mjs';

const ALIASES = DATA + 'epa_model_aliases.csv';

const cat = loadCatalogue(DATA + 'year_make_model.csv');
const epa = parseCsv(readFileSync(CACHE + 'epa-vehicles.csv', 'utf8'));
const hdr = epa[0];
const ix = Object.fromEntries(hdr.map((h, i) => [h, i]));

// Already-confirmed aliases are excluded -- reviewing a decision twice is a
// good way to make a different one.
const confirmed = new Set();
if (existsSync(ALIASES)) {
  for (const r of parseCsv(readFileSync(ALIASES, 'utf8')).slice(1)) {
    if (r[0] && r[1]) confirmed.add(`${r[0].toLowerCase()}|${r[1].toLowerCase()}`);
  }
}

// --- collect the unmatched, grouped by name ---------------------------------
const groups = new Map();
for (const r of epa.slice(1)) {
  const year = Number(r[ix.year]);
  if (!Number.isFinite(year)) continue;
  const make = r[ix.make].trim();
  const model = r[ix.model].trim();
  // Mirrors epa-import's resolve() exactly. If the two disagreed, this sheet
  // would list names the importer already handles -- or worse, hide ones it
  // does not.
  if (matchVehicle(cat, make, model, String(year))) continue;
  if (resolveSeries(cat, make, model, String(year))) continue;
  if (confirmed.has(`${make.toLowerCase()}|${model.toLowerCase()}`)) continue;

  const key = `${make}|${model}`;
  let g = groups.get(key);
  if (!g) g = groups.set(key, { make, epaModel: model, rows: 0, years: new Set() }).get(key);
  g.rows++;
  g.years.add(year);
}

// --- scoring ----------------------------------------------------------------
const tokens = (s) => new Set(stripSuffixes(s).split(/[\s/]+/).filter(Boolean));

function tokenScore(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / new Set([...A, ...B]).size;
}
function yearScore(epaYears, ourYears) {
  if (!epaYears.size) return 0;
  let hit = 0;
  for (const y of epaYears) if (ourYears.has(y)) hit++;
  return hit / epaYears.size;
}
const span = (set) => {
  const a = [...set].sort((x, y) => x - y);
  return a.length ? (a[0] === a[a.length - 1] ? `${a[0]}` : `${a[0]}-${a[a.length - 1]}`) : '';
};

const out = [];
for (const g of groups.values()) {
  const models = cat.byMake.get(g.make.toLowerCase());
  const scored = [];
  if (models) {
    for (const [model, years] of models) {
      const ts = tokenScore(g.epaModel, model);
      const ys = yearScore(g.years, years);
      const ln = loose(stripSuffixes(g.epaModel));
      const lo = loose(model);
      // The commonest shape of these near-misses is one name being the other
      // plus a series number: "Sierra 1500" against "Sierra".
      const contains = ln && lo && (ln.startsWith(lo) || lo.startsWith(ln)) ? 0.35 : 0;

      // Year overlap on its own is not evidence of identity. Without this,
      // every unmatched Chevrolet was suggested as a Corvette -- not because
      // the names resemble each other at all, but because the Corvette's
      // 1963-2025 span overlaps everything, and overlap alone was scoring.
      if (ts === 0 && contains === 0) continue;

      const score = ts * 0.5 + ys * 0.3 + contains;
      if (score > 0.15) scored.push({ model, score, ts, ys, years });
    }
    scored.sort((a, b) => b.score - a.score);
  }
  out.push({ ...g, candidates: scored.slice(0, 3) });
}
out.sort((a, b) => b.rows - a.rows);

const withC = out.filter((o) => o.candidates.length);
const strong = withC.filter((o) => o.candidates[0].score >= 0.6);
const weak = withC.filter((o) => o.candidates[0].score < 0.6);
const none = out.filter((o) => !o.candidates.length);
const sum = (a) => a.reduce((s, o) => s + o.rows, 0);

console.log('distinct unmatched EPA names:', out.length, `(${sum(out)} rows)`);
console.log('  strong candidate (>=0.60):', strong.length, `(${sum(strong)} rows)`);
console.log('  weak candidate   (<0.60): ', weak.length, `(${sum(weak)} rows)`);
console.log('  no candidate:             ', none.length, `(${sum(none)} rows)`);

// --- review sheet -----------------------------------------------------------
const header = [
  'Decision', 'Make', 'EPA_Model', 'Suggested_Our_Model', 'EPA_Rows', 'EPA_Years',
  'Our_Years', 'Year_Overlap_Pct', 'Name_Overlap_Pct', 'Score', 'Alt_1', 'Alt_2',
];
const rows = out.map((o) => {
  const c = o.candidates[0];
  return [
    '', o.make, o.epaModel, c?.model ?? '', o.rows, span(o.years),
    c ? span(c.years) : '', c ? Math.round(c.ys * 100) : '', c ? Math.round(c.ts * 100) : '',
    c ? c.score.toFixed(2) : '', o.candidates[1]?.model ?? '', o.candidates[2]?.model ?? '',
  ];
});
writeFileSync(CACHE + 'epa-unmatched-review.csv',
  [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n');

writeFileSync(CACHE + 'epa-unmatched.json', JSON.stringify(out.map((o) => ({
  make: o.make, epaModel: o.epaModel, rows: o.rows, epaYears: span(o.years),
  candidates: o.candidates.map((c) => ({
    model: c.model, score: Number(c.score.toFixed(3)),
    yearOverlap: Math.round(c.ys * 100), nameOverlap: Math.round(c.ts * 100),
    ourYears: span(c.years),
  })),
}))));

console.log('\nwrote epa-unmatched-review.csv and epa-unmatched.json');
