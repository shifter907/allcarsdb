/**
 * NHTSA Canadian Vehicle Specifications -> body_configs.csv, ymm_body_configs.csv
 *
 * Spot-checked against published figures before trusting:
 *   2020 Corvette   WB 107.1 / L 182.3 / W 76.0   published 107.2 / 182.3 / 76.1
 *   2020 Mustang    WB 107.1 / L 188.2 / W 75.6   published 107.1 / 188.5 / 75.4
 *   2020 MX-5       WB  90.9 / L 153.9 / W 68.1   published  90.9 / 154.1 / 68.3
 *   2020 Wrangler   WB 118.5 (4dr) / 96.9 (2dr)   published 118.4 / 96.8
 *
 * Wheelbase, width, height and curb weight agree closely throughout. Overall
 * length agrees to a few tenths on most vehicles but not all -- the Wrangler
 * comes back 181.9 against Jeep's published 188.4, a difference of measurement
 * convention on a vehicle with a tailgate-mounted spare rather than an error.
 * These are NHTSA's own measurements and are recorded as such; the data-model
 * page says so, because someone comparing a figure here against a brochure
 * deserves to know why they might differ.
 *
 * The model string is matched to our catalogue by longest prefix rather than by
 * parsing out trim names: "WRANGLER JL 3.6L RUBICON 4DR SUV" finds "Wrangler"
 * by trying successively shorter prefixes. That needs no vocabulary of trim
 * names, which is good, because there isn't one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, esc, loadCatalogue, matchVehicle } from './match-lib.mjs';
import { resolveSeries } from './series-map.mjs';
import { DATA, CACHE } from './paths.mjs';

const toCsv = (header, rows) =>
  [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';

const records = JSON.parse(readFileSync(CACHE + 'nhtsa-bodies-raw.json', 'utf8'));
const cat = loadCatalogue(DATA + 'year_make_model.csv');

// --- attribute extraction ---------------------------------------------------
const BODY_STYLES = [
  [/\bCONVERTIBLE\b|\bCABRIOLET\b|\bROADSTER\b|\bSPYDER\b/i, 'Convertible'],
  [/\bCOUPE\b|\bCPE\b/i, 'Coupe'],
  [/\bHATCHBACK\b|\bLIFTBACK\b|\bKAMMBACK\b/i, 'Hatchback'],
  [/\bWAGON\b|\bWGN\b|\bESTATE\b|\bTOURING\b/i, 'Wagon'],
  [/\bSUV\b|\bSPORT UTILITY\b/i, 'SUV'],
  [/\bPICKUP\b|\/BOX\b|\bCAB\b/i, 'Pickup'],
  [/\bVAN\b|\bMINIVAN\b/i, 'Van'],
  [/\bSD\b|\bSEDAN\b|\bSALOON\b/i, 'Sedan'],
];
const CAB_CONFIGS = [
  [/\bCREW CAB\b|\bCREWCAB\b|\bSUPERCREW\b|\bCREW MAX\b|\bCREWMAX\b/i, 'Crew'],
  [/\bDOUBLE CAB\b|\bDBL CAB\b/i, 'Double'],
  [/\bMEGA CAB\b/i, 'Mega'],
  [/\bQUAD CAB\b/i, 'Quad'],
  [/\bEXT CAB\b|\bEXTENDED CAB\b|\bSUPERCAB\b|\bSUPER CAB\b|\bKING CAB\b|\bACCESS CAB\b|\bCLUB CAB\b/i, 'Extended'],
  [/\bREG CAB\b|\bREGULAR CAB\b/i, 'Regular'],
];
// NHTSA writes box length as a size class rather than a measurement, so the
// class is recorded and the inches left blank rather than invented.
const BOXES = [
  [/\bL\/BOX\b|\bLONG BOX\b/i, 'Long'],
  [/\bM\/BOX\b|\bMED BOX\b/i, 'Standard'],
  [/\bS\/BOX\b|\bSHORT BOX\b/i, 'Short'],
];
const DOORS = [
  [/\b2\s?DR\b|\b2 DOOR\b/i, 2],
  [/\b3\s?DR\b|\b3 DOOR\b/i, 3],
  [/\b4\s?DR\b|\b4 DOOR\b/i, 4],
  [/\b5\s?DR\b|\b5 DOOR\b/i, 5],
];
const ROOF = [
  [/\bHIGH ROOF\b|\bHI ROOF\b|\bEXT ROOF\b/i, 'High'],
  [/\bMED ROOF\b|\bMID ROOF\b/i, 'Mid'],
  [/\bLOW ROOF\b|\bSTD ROOF\b/i, 'Low'],
];

const firstMatch = (table, s) => {
  for (const [re, val] of table) if (re.test(s)) return val;
  return '';
};

/**
 * A series designator immediately after the matched name -- "1500", "2500HD",
 * "F350" -- means a prefix match stopped short of the real model.
 *
 * This matters more than it looks. NHTSA's "SILVERADO 2500HD CREW CAB L/BOX"
 * once matched a plain "Silverado" and hung a 172-inch wheelbase off a
 * light-duty truck. Attaching a three-quarter-ton's dimensions to a half-ton is
 * exactly the kind of quiet wrongness that is worse than no data. The series
 * rename fixed the cause; this guard stays as the backstop for any nameplate
 * the rename did not cover.
 */
const SERIES_TOKEN = /^(\d{3,4}(HD|LD)?|HD|LD|XL|SRW|DRW)$/i;

/**
 * Resolve one model string in one year.
 *
 * Series models are tried first, because "SILVERADO 3500 CREW CAB" has to
 * become Silverado 3500 up to 2014 and Silverado 3500HD from 2015 -- the same
 * record spans a rename, so the answer genuinely depends on the year and cannot
 * be decided once for the whole record.
 */
function resolveYear(make, modelString, year) {
  const series = resolveSeries(cat, make, modelString, year);
  if (series) return { model: series[1], via: 'series' };

  const words = modelString.trim().split(/\s+/);
  for (let n = words.length; n >= 1; n--) {
    const hit = matchVehicle(cat, make, words.slice(0, n).join(' '), String(year));
    if (!hit) continue;
    const nextWord = words[n];
    if (nextWord && SERIES_TOKEN.test(nextWord)) return null;
    return { model: hit[1], via: 'prefix' };
  }
  return null;
}

const numOr = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (lo !== undefined && n < lo) return '';
  if (hi !== undefined && n > hi) return '';
  return Math.round(n * 10) / 10;
};

// --- build the configs ------------------------------------------------------
/** Identical bodies collapse to one row: a GT and an EcoBoost Mustang coupe are
 *  the same body, and the trim difference belongs on a build, not here. */
const configs = new Map();   // signature -> { ref, row }
const usedRefs = new Set();  // every ref handed out, so none is reused
const links = new Map();     // "Make|Model|Year|ref" -> row
let matchedRecords = 0, unmatchedRecords = 0, inconsistentDims = 0;

for (const rec of records) {
  const m = rec.spec.Model ?? '';

  // Group the record's years by the model each resolves to. One record can
  // span a rename -- Silverado 3500 became 3500HD in 2015 -- so its years do
  // not all belong to the same catalogue entry.
  const byModel = new Map();
  for (const y of rec.years) {
    const r = resolveYear(rec.make, m, y);
    if (!r) continue;
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(y);
  }
  if (!byModel.size) { unmatchedRecords++; continue; }
  matchedRecords++;

  const bodyStyle = firstMatch(BODY_STYLES, m);
  const cab = firstMatch(CAB_CONFIGS, m);
  const box = firstMatch(BOXES, m);
  const doors = firstMatch(DOORS, m) || '';
  const roof = firstMatch(ROOF, m);

  const wb = numOr(rec.spec.WB, 50, 400);
  const ol = numOr(rec.spec.OL, 80, 600);
  const ow = numOr(rec.spec.OW, 40, 200);
  const oh = numOr(rec.spec.OH, 30, 200);
  const twf = numOr(rec.spec.TWF, 30, 150);
  const twr = numOr(rec.spec.TWR, 30, 150);

  // A body with no wheelbase at all carries nothing worth recording.
  if (wb === '') continue;

  /**
   * Wheelbase and overall length have to be consistent with each other.
   *
   * Two records survive the absolute bounds above and still contradict
   * themselves: a 1985 Suburban at a 52-inch wheelbase against a correct
   * 219-inch length, and a Ram whose length reads 344 inches. Each is a single
   * corrupt field, but which one is wrong differs between them, so there is
   * nothing to salvage by guessing. Real vehicles sit between roughly 0.5 and
   * 0.75 on this ratio; the bounds here are wide enough to touch nothing else.
   */
  if (ol !== '' && (wb / ol < 0.45 || wb / ol > 0.95)) { inconsistentDims++; continue; }

  for (const [model, years] of byModel) {
    const sig = [
      rec.make, model, bodyStyle, doors, cab, box, roof, wb, ol, ow, oh, twf, twr,
    ].join('|');

    let cfg = configs.get(sig);
    if (!cfg) {
      // The ref is made unique at creation, before any link can point at it.
      // Renaming afterwards silently reattributed one body's links to another,
      // because the links had already been written with the old name.
      const base = 'nhtsa-' + [rec.make, model, bodyStyle || 'body', cab, box, doors ? doors + 'dr' : '', wb]
        .filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let ref = base;
      let n = 1;
      while (usedRefs.has(ref)) ref = `${base}-${++n}`;
      usedRefs.add(ref);

      cfg = {
        ref,
        row: [
          ref, bodyStyle, doors, cab, '', '', roof,
          wb, ol, ow, oh, twf, twr,
          '', '', '', '',   // ground clearance and approach angles -- not in this source
          '', '', '', '',   // drag, cargo, fuel capacity
          '',               // seating rows
        ],
      };
      configs.set(sig, cfg);
    }

    for (const y of years) {
      links.set(`${rec.make}|${model}|${y}|${cfg.ref}`, [rec.make, model, y, cfg.ref]);
    }
  }
}

const configRows = [...configs.values()].map((c) => c.row).sort((a, b) => a[0].localeCompare(b[0]));
const linkRows = [...links.values()].sort(
  (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2],
);

writeFileSync(DATA + 'body_configs.csv', toCsv(
  ['Ref', 'Body_Style', 'Doors', 'Cab_Config', 'Bed_Length_in', 'Bed_Volume_cuft', 'Roof_Height',
   'Wheelbase_in', 'Length_in', 'Width_in', 'Height_in', 'Track_Front_in', 'Track_Rear_in',
   'Ground_Clearance_in', 'Approach_Angle_deg', 'Departure_Angle_deg', 'Breakover_Angle_deg',
   'Drag_Coefficient', 'Cargo_Volume_cuft', 'Cargo_Volume_Max_cuft', 'Fuel_Capacity_gal', 'Seating_Rows'],
  configRows,
));
writeFileSync(DATA + 'ymm_body_configs.csv', toCsv(
  ['Make', 'Model', 'Year', 'Body_Config_Ref'], linkRows,
));

console.log(`records:      ${records.length} (${matchedRecords} matched, ${unmatchedRecords} unmatched)`);
console.log(`body configs: ${configRows.length}`);
console.log(`rejected:     ${inconsistentDims} records whose wheelbase and length contradict each other`);
console.log(`links:        ${linkRows.length}`);
