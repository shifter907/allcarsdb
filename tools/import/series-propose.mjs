/**
 * Derive the canonical series-model list and its year spans from the sources.
 *
 * Printed for review before anything is written. The point is to catch a rule
 * that quietly does the wrong thing -- a "Silverado 3500HD 1999" would mean a
 * pattern is matching an era it should not.
 *
 * Exported so the migration uses exactly this list. If the two derived it
 * separately they would drift, and the review would stop describing what
 * actually lands in the catalogue.
 */

import { readFileSync } from 'node:fs';
import { parseCsv, loadCatalogue } from './match-lib.mjs';
import { canonicalSeries, collapseSingleSeries, isAnachronistic, SKIP_NAMEPLATES } from './series-map.mjs';
import { DATA, CACHE } from './paths.mjs';
export { DATA };  // re-exported so consumers need only one import

// The catalogue's own bounds. EPA publishes preliminary 2026-27 model years;
// carrying them here would put cars in the database a year before they exist.
const MIN_YEAR = 1981, MAX_YEAR = 2025;

export const span = (set) => {
  const a = [...set].sort((x, y) => x - y);
  if (!a.length) return '';
  const out = [];
  let s = a[0], p = a[0];
  for (const y of a.slice(1)) {
    if (y === p + 1) { p = y; continue; }
    out.push(s === p ? `${s}` : `${s}-${p}`); s = p = y;
  }
  out.push(s === p ? `${s}` : `${s}-${p}`);
  return out.join(',');
};

/** Every (make, nameplate, series, year) either source attests. */
export function collectAttested() {
  const out = [];
  const push = (make, model, years) => {
    const c = canonicalSeries(make, model);
    if (!c || SKIP_NAMEPLATES.has(c.nameplate)) return;
    for (const y of years) {
      if (y < MIN_YEAR || y > MAX_YEAR) continue;
      if (isAnachronistic(make, c.nameplate, c.series, y)) continue;
      out.push({ make, nameplate: c.nameplate, series: c.series, year: y });
    }
  };

  for (const rec of JSON.parse(readFileSync(CACHE + 'nhtsa-bodies-raw.json', 'utf8'))) {
    push(rec.make, rec.spec.Model, rec.years);
  }
  const rows = parseCsv(readFileSync(CACHE + 'epa-vehicles.csv', 'utf8'));
  const ix = Object.fromEntries(rows[0].map((h, i) => [h, i]));
  for (const r of rows.slice(1)) {
    const y = Number(r[ix.year]);
    if (Number.isFinite(y)) push(r[ix.make]?.trim(), r[ix.model], [y]);
  }
  return out;
}

/**
 * Fill short gaps inside each series' own attested range.
 *
 * A truck attested in 1994 and 1996 was sold in 1995; neither source is a
 * complete census, and NHTSA only files a record when a spec changed. But a
 * long gap is usually real, not sparse: GMC sold "Sierra Classic" as the
 * outgoing body in 1999-2000 and again in 2007, and filling that six-year hole
 * invented a model that was never on sale. Short gaps are filled, long ones are
 * left alone and reported. The range is never extended past what a source says
 * -- interpolation is a safe inference, extrapolation is not.
 */
const MAX_GAP = 6;

/**
 * "Classic" is a run-out badge: the outgoing body sold alongside its
 * replacement for a year or two. Those runs are inherently discontinuous --
 * GMC sold Sierra Classic in 1999-2000 and again in 2007 -- so their gaps are
 * real production breaks and are never bridged, whatever their length.
 */
const isRunOut = (nameplate) => /\bClassic\b/i.test(nameplate);

export function interpolate(attested, { maxGap = MAX_GAP, report = null } = {}) {
  const byKey = new Map();
  for (const a of attested) {
    const k = `${a.make}|${a.nameplate}|${a.series ?? ''}`;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(a.year);
  }
  const out = [];
  for (const [k, years] of byKey) {
    const [make, nameplate, series] = k.split('|');
    const a = [...years].sort((x, y) => x - y);
    const keep = new Set(a);
    const limit = isRunOut(nameplate) ? 0 : maxGap;
    for (let i = 1; i < a.length; i++) {
      const gap = a[i] - a[i - 1] - 1;
      if (gap > 0 && gap <= limit) {
        for (let y = a[i - 1] + 1; y < a[i]; y++) keep.add(y);
      } else if (gap > maxGap) {
        report?.push(`${make} ${nameplate}${series ? ' ' + series : ''}: ${a[i - 1]}..${a[i]} (${gap}y gap left open)`);
      }
    }
    for (const y of keep) out.push({ make, nameplate, series: series || null, year: y });
  }
  return out;
}

/**
 * Final (make, model, year) rows the rename should produce.
 *
 * Two different year sets are in play, deliberately. Which rows exist comes
 * from the gap-limited set, so no vehicle-year is invented. How they are named
 * comes from the fully-bridged set, so a nameplate does not flip between
 * "Suburban 1500" and "Suburban" and back again just because one source
 * happened to skip a year.
 */
export function proposedRows(report = null) {
  const attested = collectAttested();
  const rowYears = interpolate(attested, { report });
  const name = collapseSingleSeries(interpolate(attested, { maxGap: Infinity }));
  const rows = new Map();
  for (const f of rowYears) {
    const model = name(f.make, f.nameplate, f.series, f.year);
    rows.set(`${f.make}|${model}|${f.year}`, [f.make, model, f.year]);
  }
  return [...rows.values()];
}

// --- report -----------------------------------------------------------------
// Windows paths make the usual import.meta.url comparison fail (file:/// vs
// file://C:), so match on the entry script's name instead.
if (process.argv[1]?.endsWith('series-propose.mjs')) {
  const cat = loadCatalogue(DATA + 'year_make_model.csv');
  const gaps = [];
  const proposed = new Map();
  for (const [make, model, year] of proposedRows(gaps)) {
    const k = `${make}|${model}`;
    if (!proposed.has(k)) proposed.set(k, new Set());
    proposed.get(k).add(year);
  }

  console.log('make'.padEnd(11) + 'proposed model'.padEnd(26) + 'years'.padEnd(28) + 'catalogue has today');
  console.log('-'.repeat(104));
  let newModels = 0, newYears = 0;
  for (const k of [...proposed.keys()].sort()) {
    const [make, model] = k.split('|');
    const years = proposed.get(k);
    const held = cat.byMake.get(make.toLowerCase())?.get(model) ?? new Set();
    if (!held.size) newModels++;
    newYears += [...years].filter((y) => !held.has(y)).length;
    console.log(`${make.padEnd(10)} ${model.padEnd(25)} ${span(years).padEnd(27)} ${held.size ? span(held) : '(new model)'}`);
  }
  console.log('-'.repeat(104));
  console.log(`${proposed.size} models · ${newModels} new · ${newYears} vehicle-years added`);
  if (gaps.length) {
    console.log(`\ngaps left open (>${MAX_GAP}y, not filled -- verify these are real breaks in production):`);
    for (const g of [...new Set(gaps)].sort()) console.log('  ' + g);
  }
}
