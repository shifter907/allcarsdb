/**
 * EPA fueleconomy.gov -> transmissions.csv, drivetrains.csv, builds.csv
 *
 * Why EPA rather than NHTSA for this: NHTSA's vPIC has no fuel economy and no
 * per-model-year configuration list. Its Canadian Vehicle Specifications
 * endpoint does have dimensions, and that is used separately for body configs.
 * EPA's dataset is the authoritative US source for exactly the fields a build
 * carries -- city/highway/combined mpg, drive layout and transmission -- and it
 * is explicitly keyed by model year.
 *
 * Every figure written here is EPA's own. Nothing is derived, averaged or
 * inferred; rows that cannot be matched to a vehicle we already have are
 * dropped rather than guessed into place.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseCsv, esc, loadCatalogue, matchVehicle } from './match-lib.mjs';
import { resolveSeries } from './series-map.mjs';
import { DATA, CACHE } from './paths.mjs';

const ALIAS_FILE = DATA + 'epa_model_aliases.csv';

const toCsv = (header, rows) =>
  [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';

const epa = parseCsv(readFileSync(CACHE + 'epa-vehicles.csv', 'utf8'));
const hdr = epa[0];
const ix = Object.fromEntries(hdr.map((h, i) => [h, i]));
const rows = epa.slice(1);

// --- our catalogue + confirmed aliases -------------------------------------
const cat = loadCatalogue(DATA + 'year_make_model.csv');

/**
 * Human-confirmed name equivalences, from data/epa_model_aliases.csv.
 *
 * The automatic rules are deliberately conservative -- they only join two
 * spellings of one name. Anything requiring a judgement ("Sierra 1500" is our
 * "Sierra"; "A4 quattro" is our "A4") is a decision a person has to make, and
 * this file is where those decisions live so they survive a re-import and can
 * be argued with in a pull request.
 */
const aliases = new Map();
if (existsSync(ALIAS_FILE)) {
  for (const r of parseCsv(readFileSync(ALIAS_FILE, 'utf8')).slice(1)) {
    if (r[0] && r[1] && r[2]) {
      aliases.set(`${r[0].toLowerCase().trim()}|${r[1].toLowerCase().trim()}`, r[2].trim());
    }
  }
}

function resolve(make, model, year) {
  const direct = matchVehicle(cat, make, model, year);
  if (direct) return direct;

  // Series-numbered trucks and vans, where EPA's name carries a designation
  // our catalogue now spells differently -- "Silverado C15" is EPA's internal
  // code for what GM badges Silverado 1500, and "Sierra 2500 HD" is one space
  // away from ours. Tried before the alias file so those thousands of rows do
  // not each need a hand-written entry.
  const series = resolveSeries(cat, make, model, year);
  if (series) return series;

  const alias = aliases.get(`${make.toLowerCase().trim()}|${model.toLowerCase().trim()}`);
  if (!alias) return null;
  // An alias renames the model; the year still has to exist on its own. A
  // confirmed name equivalence is not a claim that we hold every year of it.
  return matchVehicle(cat, make, alias, year);
}

// --- transmissions ----------------------------------------------------------
/**
 * EPA writes transmissions three ways: "Automatic 6-spd", "Manual 5-spd", and a
 * parenthesised code -- "(S8)" select-shift, "(AM-S7)" automated manual with
 * select shift, "(AV)" continuously variable, "(A1)" single speed.
 *
 * The gear count is taken only where EPA states one. "Automatic (variable gear
 * ratios)" has no gear count by definition and gets none rather than a zero.
 */
function parseTransmission(trany) {
  if (!trany) return null;
  const t = trany.trim();

  let type = null;
  if (/^Manual/i.test(t)) type = 'Manual';
  else if (/^Automatic/i.test(t)) type = 'Automatic';
  else return null;

  // Continuously variable -- no fixed gears at all.
  if (/variable gear ratios|\(AV[-)]|\(AV\)/i.test(t)) {
    return { type: 'CVT', gears: null, label: t };
  }
  // Automated manual (a manual gearbox shifted by the car, mechanically
  // different from a torque-converter automatic even though EPA files both
  // under "Automatic").
  if (/\(AM/i.test(t)) {
    const g = t.match(/(\d+)/);
    return { type: 'Automated Manual', gears: g ? Number(g[1]) : null, label: t };
  }

  const spd = t.match(/(\d+)-spd/i);
  if (spd) return { type, gears: Number(spd[1]), label: t };

  // "(S8)", "(A1)" etc.
  const code = t.match(/\((?:S|A)(\d+)\)/i);
  if (code) {
    const gears = Number(code[1]);
    return { type: gears === 1 ? 'Single-speed' : type, gears, label: t };
  }
  return { type, gears: null, label: t };
}

const tranyMap = new Map(); // EPA string -> Ref
const transmissionRows = [];
for (const [label] of new Map(rows.map((r) => [r[ix.trany], true]))) {
  const parsed = parseTransmission(label);
  if (!parsed) continue;
  const ref = 'epa-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  tranyMap.set(label, ref);
  transmissionRows.push([ref, '', '', parsed.type, parsed.gears ?? '', '', '']);
}
transmissionRows.sort((a, b) => a[0].localeCompare(b[0]));

// --- drivetrains ------------------------------------------------------------
/**
 * "4-Wheel or All-Wheel Drive" is EPA's own label for rows where it does not
 * distinguish the two. It is carried through verbatim rather than resolved to
 * one or the other: guessing would put genuinely-4WD trucks into an AWD filter.
 * Anyone filtering for AWD correctly will not match these, which is the honest
 * outcome when the source declines to say.
 */
const DRIVE_MAP = {
  'Front-Wheel Drive': { ref: 'epa-fwd', layout: 'FWD' },
  'Rear-Wheel Drive': { ref: 'epa-rwd', layout: 'RWD' },
  'All-Wheel Drive': { ref: 'epa-awd', layout: 'AWD' },
  '4-Wheel Drive': { ref: 'epa-4wd', layout: '4WD' },
  'Part-time 4-Wheel Drive': { ref: 'epa-4wd-parttime', layout: '4WD', transferCase: 'Part-time' },
  '4-Wheel or All-Wheel Drive': { ref: 'epa-4wd-or-awd', layout: '4WD or AWD' },
  '2-Wheel Drive': { ref: 'epa-2wd', layout: '2WD' },
};
const drivetrainRows = Object.values(DRIVE_MAP).map((d) => [
  d.ref, d.layout, d.transferCase ?? '', '', '', '', '', '', '',
]);

// --- builds -----------------------------------------------------------------
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : '';
};

const buildRows = [];
const seenRefs = new Set();
let matched = 0, skipped = 0, viaAlias = 0;

for (const r of rows) {
  const year = Number(r[ix.year]);
  if (!Number.isFinite(year)) continue;
  const hit = resolve(r[ix.make], r[ix.model], String(year));
  if (!hit) { skipped++; continue; }
  matched++;
  if (!matchVehicle(cat, r[ix.make], r[ix.model], String(year))) viaAlias++;

  const [Make, Model, Year] = hit;
  const ref = `epa-${r[ix.id]}`;
  if (seenRefs.has(ref)) continue;
  seenRefs.add(ref);

  // EPA's own model string is kept when it says more than ours does --
  // "Legacy AWD Turbo" against our "Legacy" is the difference between two
  // builds of the same car, which is exactly what this column is for.
  const epaModel = r[ix.model].trim();
  const notes = [];
  if (epaModel.toLowerCase() !== Model.toLowerCase()) notes.push(epaModel);
  if (r[ix.atvType]) notes.push(r[ix.atvType]);
  if (r[ix.tCharger] === 'T') notes.push('Turbo');
  if (r[ix.sCharger] === 'S') notes.push('Supercharged');

  buildRows.push([
    ref, Make, Model, Year,
    '',                                   // Trim_Name -- EPA has none
    '',                                   // Body_Config_Ref
    '',                                   // Powertrain_Ref -- see note below
    tranyMap.get(r[ix.trany]) ?? '',
    DRIVE_MAP[r[ix.drive]]?.ref ?? '',
    '', '',                               // Suspension_Ref, Seating_Config_Ref
    '',                                   // Axle_Ratio
    notes.join(' · '),
    '', '', '', '', '', '',               // weights and towing -- EPA has none
    num(r[ix.city08]), num(r[ix.highway08]), num(r[ix.comb08]),
    num(r[ix.range]),                     // EPA_Electric_Range_mi
    '', '', '', '',                       // performance -- EPA has none
  ]);
}

buildRows.sort((a, b) => a[0].localeCompare(b[0]));

// --- write ------------------------------------------------------------------
/**
 * Rows this importer generated are prefixed `epa-`, so a re-run replaces its
 * own previous output instead of appending a second copy. Hand-authored rows
 * are left untouched -- the first version appended blindly, and running it
 * twice produced duplicate refs that the loader rightly rejected.
 */
function mergeGenerated(file, header, generated) {
  const existing = parseCsv(readFileSync(DATA + file, 'utf8')).slice(1)
    .filter((r) => r.length > 1 && !r[0].startsWith('epa-'));
  writeFileSync(DATA + file, toCsv(header, [...existing, ...generated]));
  return existing.length;
}

const keptTx = mergeGenerated('transmissions.csv',
  ['Ref', 'Manufacturer', 'Code', 'Type', 'Forward_Gears', 'First_Gear_Ratio', 'Top_Gear_Ratio'],
  transmissionRows);

const keptDt = mergeGenerated('drivetrains.csv',
  ['Ref', 'Layout', 'Transfer_Case_Type', 'Transfer_Case_Model', 'Low_Range_Ratio',
   'Front_Hub_Type', 'Center_Differential', 'Front_Diff_Type', 'Rear_Diff_Type'],
  drivetrainRows);


writeFileSync(DATA + 'builds.csv', toCsv(
  ['Ref', 'Make', 'Model', 'Year', 'Trim_Name', 'Body_Config_Ref', 'Powertrain_Ref',
   'Transmission_Ref', 'Drivetrain_Ref', 'Suspension_Ref', 'Seating_Config_Ref',
   'Axle_Ratio', 'Equipment_Note', 'Curb_Weight_lb', 'GVWR_lb', 'GCWR_lb', 'Payload_lb',
   'Towing_Capacity_lb', 'Tongue_Weight_lb', 'EPA_City_mpg', 'EPA_Highway_mpg',
   'EPA_Combined_mpg', 'EPA_Electric_Range_mi', 'Zero_To_Sixty_s', 'Quarter_Mile_s',
   'Top_Speed_mph', 'Braking_60_0_ft'],
  buildRows,
));

console.log(`transmissions: ${keptTx} hand-authored + ${transmissionRows.length} from EPA`);
console.log(`drivetrains:   ${keptDt} hand-authored + ${drivetrainRows.length} from EPA`);
console.log(`builds:         ${buildRows.length} written (${matched} matched, ${skipped} unmatched EPA rows)`);
console.log(`                ${viaAlias} of those came from confirmed aliases (${aliases.size} in file)`);
