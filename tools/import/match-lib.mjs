/**
 * Shared EPA <-> catalogue matcher.
 *
 * Extracted so the importer and the review-sheet generator cannot drift: if
 * they disagreed about what counts as a match, the review sheet would list
 * names the importer had already handled, or worse, hide ones it had not.
 */

import { readFileSync } from 'node:fs';

export function parseCsv(text) {
  const rows = [];
  let f = '', row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r') {}
    else if (c === '\n') { row.push(f); if (row.length > 1) rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

export const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * EPA appends configuration annotations to the model name -- "Silverado 2WD",
 * "F150 Pickup 4WD FFV". These are not different models.
 *
 * Applied to BOTH sides. Our own catalogue contains names like "S15 Pickup"
 * that carry the same words, and stripping only EPA's side meant "S15 Pickup
 * 2WD" reduced to "s15" and then failed to find "S15 Pickup" -- a match the
 * rules were already meant to make.
 */
const SUFFIXES = [
  '2wd', '4wd', 'awd', 'fwd', 'rwd', '2v', '4v',
  'ffv', 'cng', 'flex fuel', 'hybrid', 'phev', 'ev',
  'pickup', 'wagon', 'van', 'cab chassis',
];

export function stripSuffixes(s) {
  let t = s.toLowerCase().trim(), changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      if (t.endsWith(' ' + suf)) { t = t.slice(0, -(suf.length + 1)).trim(); changed = true; }
    }
  }
  return t;
}

/** Punctuation-insensitive: "F150" and "F-150" are one name written two ways. */
export const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every spelling of a name we are willing to treat as the same name. */
export function variants(name) {
  const raw = name.toLowerCase().trim();
  const stripped = stripSuffixes(name);
  return new Set([raw, stripped, loose(raw), loose(stripped)].filter(Boolean));
}

export function loadCatalogue(path) {
  const byKey = new Map();     // "make|variant|year" -> [Make, Model, Year]
  const ambiguous = new Set(); // keys where two different models collide
  const byMake = new Map();    // make -> Map(Model -> Set(years))
  const makes = new Set();

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(1)) {
    const m = line.match(/^(?:"([^"]*)"|([^,]*)),(?:"([^"]*)"|([^,]*)),(\d+)/);
    if (!m) continue;
    const Make = (m[1] ?? m[2]).trim();
    const Model = (m[3] ?? m[4]).trim();
    const Year = m[5];
    const mk = Make.toLowerCase();
    makes.add(mk);

    if (!byMake.has(mk)) byMake.set(mk, new Map());
    const models = byMake.get(mk);
    if (!models.has(Model)) models.set(Model, new Set());
    models.get(Model).add(Number(Year));

    for (const v of variants(Model)) {
      const key = `${mk}|${v}|${Year}`;
      const prior = byKey.get(key);
      // Two different models of one make reducing to the same variant makes
      // that key unusable -- picking either would be arbitrary.
      if (prior && prior[1].toLowerCase() !== Model.toLowerCase()) ambiguous.add(key);
      else byKey.set(key, [Make, Model, Year]);
    }
  }
  return { byKey, ambiguous, byMake, makes };
}

/**
 * Resolve an EPA (make, model, year) to one of ours, or null.
 * Returns null for both "not found" and "found more than one", because acting
 * on an ambiguous match is worse than dropping the row.
 */
export function matchVehicle(cat, make, model, year) {
  const mk = make.toLowerCase().trim();
  if (!cat.makes.has(mk)) return null;
  for (const v of variants(model)) {
    const key = `${mk}|${v}|${year}`;
    if (cat.ambiguous.has(key)) return null;
    const hit = cat.byKey.get(key);
    if (hit) return hit;
  }
  return null;
}
