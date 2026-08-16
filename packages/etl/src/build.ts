/**
 * data/*.csv -> dist/allcars.sqlite
 *
 *   npm run build:db          build to disk
 *   npm run validate          parse and check only, nothing written
 *
 * The build is a full rebuild every time. There is no incremental path and no
 * migration of existing rows, because the CSVs are the source of truth and the
 * database is a derived artifact -- which is what makes a bad merge recoverable
 * by reverting a commit rather than by repairing production data.
 *
 * Indices are assigned here rather than authored in the CSVs. Rows are sorted
 * deterministically first, so the same input always produces the same numbers;
 * see the note in 0000_schema.sql about what that does and does not guarantee.
 *
 * Load order matters: a table can only be loaded once everything it references
 * has been, because references are resolved through in-memory maps built during
 * each table's own insert pass rather than trusted to the database.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, requireHeaders, intCell, realCell, boolCell, textCell, CsvError, type CsvRow,
} from './csv.js';
import { FIELDS } from '@allcarsdb/query';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const MIGRATIONS = join(ROOT, 'packages', 'db', 'migrations');
const OUT_DIR = join(ROOT, 'dist');
const OUT_PATH = join(OUT_DIR, 'allcars.sqlite');

const VALIDATE_ONLY = process.argv.includes('--validate-only');

// `--data=<dir>` points the loader at a different set of CSVs. The tests use it
// to run the real pipeline over fixtures: validating the production files is
// worth little while they are nearly empty, since a loader that silently
// accepted nothing would pass just as well.
const dataArg = process.argv.find((a) => a.startsWith('--data='));
const DATA = dataArg ? dataArg.slice('--data='.length) : join(ROOT, 'data');

/** Normalised key for a vehicle, so "Porsche" and "porsche" resolve alike. */
const ymmKey = (make: string, model: string, year: number) =>
  `${make.toLowerCase()} ${model.toLowerCase()} ${year}`;

async function readCsv(name: string) {
  const path = join(DATA, name);
  if (!existsSync(path)) {
    throw new CsvError(`data/${name} is missing. It must exist, even if it only has a header row.`);
  }
  return { ...parseCsv(await readFile(path, 'utf8'), `data/${name}`), file: `data/${name}` };
}

/**
 * Every catalog table follows the same shape: a `Ref` handle unique within the
 * file, used to point at the row from elsewhere and then thrown away. This
 * builds the Ref -> assigned index map and enforces that uniqueness once,
 * rather than repeating the same twelve lines per table.
 */
function refResolver(file: string, label: string) {
  const seen = new Map<string, number>();
  const index = new Map<string, number>();
  return {
    claim(ref: string, line: number) {
      const key = ref.toLowerCase();
      const prior = seen.get(key);
      if (prior !== undefined) {
        throw new CsvError(
          `${file}:${line}: ${label} ref "${ref}" is already used on line ${prior}. ` +
            `Refs identify a row and must be unique within the file.`,
        );
      }
      seen.set(key, line);
    },
    record(ref: string, id: number) { index.set(ref.toLowerCase(), id); },
    /** Resolve a reference, or throw naming the file and line that got it wrong. */
    resolve(ref: string, file2: string, line: number, column: string): number {
      const id = index.get(ref.toLowerCase());
      if (id === undefined) {
        throw new CsvError(
          `${file2}:${line}: ${column} "${ref}" is not in ${file}. ` +
            `Add it there first, or correct the spelling here.`,
        );
      }
      return id;
    },
    /** Same, but a blank reference is allowed and yields null. */
    resolveOptional(ref: string | null, file2: string, line: number, column: string): number | null {
      if (ref === null) return null;
      return this.resolve(ref, file2, line, column);
    },
    get size() { return index.size; },
  };
}

async function main() {
  const started = Date.now();

  if (!VALIDATE_ONLY) {
    await mkdir(OUT_DIR, { recursive: true });
    await rm(OUT_PATH, { force: true });
  }

  // Validation runs against an in-memory database so it can be executed while
  // a dev server holds the file open, and so a failed build never leaves a
  // half-written artifact on disk.
  const db = new DatabaseSync(VALIDATE_ONLY ? ':memory:' : OUT_PATH);
  db.exec('PRAGMA foreign_keys = ON');

  for (const f of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(await readFile(join(MIGRATIONS, f), 'utf8'));
  }

  db.exec('BEGIN');
  try {
    const counts: Record<string, number> = {};

    // === LAYER 1 -- Year_Make_Model =========================================
    const ymmCsv = await readCsv('year_make_model.csv');
    requireHeaders(
      ymmCsv.headers,
      ['Make', 'Model', 'Year', 'Generation', 'Dev_Chassis_Code', 'Platform_Code', 'Nickname'],
      ymmCsv.file,
    );

    interface YmmRow {
      make: string; model: string; year: number;
      generation: number | null; devChassisCode: string | null;
      platformCode: string | null; nickname: string | null;
      line: number;
    }
    const ymmRows: YmmRow[] = ymmCsv.rows.map((r) => ({
      make: textCell(r, 'Make', ymmCsv.file, { required: true })!,
      model: textCell(r, 'Model', ymmCsv.file, { required: true })!,
      // 1885 is the Benz Patent-Motorwagen; the upper bound leaves room for a
      // model year announced ahead of the calendar year without accepting a
      // transposed digit like 20226 as a real car.
      year: intCell(r, 'Year', ymmCsv.file, { required: true, min: 1885, max: 2100 })!,
      generation: intCell(r, 'Generation', ymmCsv.file, { min: 1, max: 50 }),
      devChassisCode: textCell(r, 'Dev_Chassis_Code', ymmCsv.file),
      platformCode: textCell(r, 'Platform_Code', ymmCsv.file),
      nickname: textCell(r, 'Nickname', ymmCsv.file),
      line: r.line,
    }));

    // Sort before insert so index assignment does not depend on the order
    // someone happened to append rows to the file.
    ymmRows.sort(
      (a, b) =>
        a.make.toLowerCase().localeCompare(b.make.toLowerCase()) ||
        a.model.toLowerCase().localeCompare(b.model.toLowerCase()) ||
        a.year - b.year,
    );

    const insertYmm = db.prepare(
      `INSERT INTO Year_Make_Model
         (Make, Model, Year, Generation, Dev_Chassis_Code, Platform_Code, Nickname)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const ymmIndex = new Map<string, number>();
    const ymmSeenAt = new Map<string, number>();

    for (const r of ymmRows) {
      const key = ymmKey(r.make, r.model, r.year);
      const prior = ymmSeenAt.get(key);
      if (prior !== undefined) {
        throw new CsvError(
          `${ymmCsv.file}:${r.line}: ${r.year} ${r.make} ${r.model} is already listed on ` +
            `line ${prior}. Each vehicle-year belongs on exactly one row.`,
        );
      }
      ymmSeenAt.set(key, r.line);
      const id = insertYmm.run(
        r.make, r.model, r.year, r.generation, r.devChassisCode, r.platformCode, r.nickname,
      ).lastInsertRowid;
      ymmIndex.set(key, Number(id));
    }
    counts.vehicles = ymmRows.length;

    /** Resolve a Make/Model/Year triple from any file that references one. */
    const resolveYmm = (
      make: string, model: string, year: number, file: string, line: number,
    ): number => {
      const vid = ymmIndex.get(ymmKey(make, model, year));
      if (vid === undefined) {
        throw new CsvError(
          `${file}:${line}: "${year} ${make} ${model}" is not in year_make_model.csv. ` +
            `Add it there first, or correct the spelling here.`,
        );
      }
      return vid;
    };

    // === LAYER 2 -- Engine_Specs ============================================
    const engCsv = await readCsv('engine_specs.csv');
    requireHeaders(
      engCsv.headers,
      [
        'Ref', 'Manufacturer', 'Code', 'Named_Variant', 'Silent_Variant',
        'Layout', 'Cylinders', 'CC_Displacement', 'Aspiration', 'Fuel_Type',
        'Compression_ratio', 'Fuel_delivery', 'Horsepower', 'Torque_lbft',
        'Bore_mm', 'Stroke_mm', 'Valvetrain', 'Valves_Per_Cylinder',
        'Redline_RPM', 'Fuel_Requirement', 'Oil_Capacity_qt',
      ],
      engCsv.file,
    );

    const engRefs = refResolver(engCsv.file, 'engine');
    const insertEng = db.prepare(
      `INSERT INTO Engine_Specs
         (Manufacturer, Code, Named_Variant, Silent_Variant, Layout, Cylinders,
          CC_Displacement, Aspiration, Fuel_Type, Compression_ratio, Fuel_delivery,
          Horsepower, Torque_lbft, Bore_mm, Stroke_mm, Valvetrain,
          Valves_Per_Cylinder, Redline_RPM, Fuel_Requirement, Oil_Capacity_qt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Ref uniqueness catches two rows sharing a build handle. This catches the
    // more useful mistake: the same real engine entered twice under two
    // different Refs, which Ref alone would never notice.
    const engIdentitySeenAt = new Map<string, number>();

    const engSorted = [...engCsv.rows].sort((a, b) =>
      textCell(a, 'Ref', engCsv.file, { required: true })!.toLowerCase()
        .localeCompare(textCell(b, 'Ref', engCsv.file, { required: true })!.toLowerCase()),
    );

    for (const r of engSorted) {
      const ref = textCell(r, 'Ref', engCsv.file, { required: true })!;
      engRefs.claim(ref, r.line);

      const manufacturer = textCell(r, 'Manufacturer', engCsv.file);
      const code = textCell(r, 'Code', engCsv.file);
      const namedVariant = textCell(r, 'Named_Variant', engCsv.file);
      const silentVariant = intCell(r, 'Silent_Variant', engCsv.file, { min: 1, max: 20 });

      if (manufacturer && code) {
        const identityKey = [
          manufacturer.toLowerCase(), code.toLowerCase(),
          namedVariant?.toLowerCase() ?? '', silentVariant ?? '',
        ].join('|');
        const identityPrior = engIdentitySeenAt.get(identityKey);
        if (identityPrior !== undefined) {
          throw new CsvError(
            `${engCsv.file}:${r.line}: this looks like the same engine as line ${identityPrior} ` +
              `(same Manufacturer, Code, Named_Variant and Silent_Variant) under a different Ref. ` +
              `If it really is a different variant, give it a Named_Variant or Silent_Variant that ` +
              `tells them apart.`,
          );
        }
        engIdentitySeenAt.set(identityKey, r.line);
      }

      const id = insertEng.run(
        manufacturer, code, namedVariant, silentVariant,
        textCell(r, 'Layout', engCsv.file),
        intCell(r, 'Cylinders', engCsv.file, { min: 0, max: 32 }),
        intCell(r, 'CC_Displacement', engCsv.file, { min: 0, max: 200000 }),
        textCell(r, 'Aspiration', engCsv.file),
        textCell(r, 'Fuel_Type', engCsv.file),
        textCell(r, 'Compression_ratio', engCsv.file),
        textCell(r, 'Fuel_delivery', engCsv.file),
        intCell(r, 'Horsepower', engCsv.file, { min: 0, max: 3000 }),
        intCell(r, 'Torque_lbft', engCsv.file, { min: 0, max: 5000 }),
        realCell(r, 'Bore_mm', engCsv.file, { min: 0, max: 500 }),
        realCell(r, 'Stroke_mm', engCsv.file, { min: 0, max: 500 }),
        textCell(r, 'Valvetrain', engCsv.file),
        intCell(r, 'Valves_Per_Cylinder', engCsv.file, { min: 0, max: 8 }),
        intCell(r, 'Redline_RPM', engCsv.file, { min: 0, max: 25000 }),
        textCell(r, 'Fuel_Requirement', engCsv.file),
        realCell(r, 'Oil_Capacity_qt', engCsv.file, { min: 0, max: 60 }),
      ).lastInsertRowid;
      engRefs.record(ref, Number(id));
    }
    counts.engines = engCsv.rows.length;

    // === LAYER 2 -- Electric_Motors =========================================
    const motorCsv = await readCsv('electric_motors.csv');
    requireHeaders(
      motorCsv.headers,
      ['Ref', 'Manufacturer', 'Code', 'Motor_Type', 'Horsepower', 'Torque_lbft', 'Cooling'],
      motorCsv.file,
    );
    const motorRefs = refResolver(motorCsv.file, 'motor');
    const insertMotor = db.prepare(
      `INSERT INTO Electric_Motors (Manufacturer, Code, Motor_Type, Horsepower, Torque_lbft, Cooling)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of motorCsv.rows) {
      const ref = textCell(r, 'Ref', motorCsv.file, { required: true })!;
      motorRefs.claim(ref, r.line);
      const id = insertMotor.run(
        textCell(r, 'Manufacturer', motorCsv.file),
        textCell(r, 'Code', motorCsv.file),
        textCell(r, 'Motor_Type', motorCsv.file),
        intCell(r, 'Horsepower', motorCsv.file, { min: 0, max: 3000 }),
        intCell(r, 'Torque_lbft', motorCsv.file, { min: 0, max: 10000 }),
        textCell(r, 'Cooling', motorCsv.file),
      ).lastInsertRowid;
      motorRefs.record(ref, Number(id));
    }
    counts.motors = motorCsv.rows.length;

    // === LAYER 2 -- Batteries ===============================================
    const batCsv = await readCsv('batteries.csv');
    requireHeaders(
      batCsv.headers,
      ['Ref', 'Chemistry', 'Gross_kWh', 'Usable_kWh', 'Nominal_Voltage', 'Thermal_Management', 'Cell_Format'],
      batCsv.file,
    );
    const batRefs = refResolver(batCsv.file, 'battery');
    const insertBat = db.prepare(
      `INSERT INTO Batteries (Chemistry, Gross_kWh, Usable_kWh, Nominal_Voltage, Thermal_Management, Cell_Format)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of batCsv.rows) {
      const ref = textCell(r, 'Ref', batCsv.file, { required: true })!;
      batRefs.claim(ref, r.line);
      const gross = realCell(r, 'Gross_kWh', batCsv.file, { min: 0, max: 1000 });
      const usable = realCell(r, 'Usable_kWh', batCsv.file, { min: 0, max: 1000 });
      // Usable is what the software lets you draw out of Gross, so it cannot
      // exceed it. Getting these backwards is an easy transcription slip and
      // produces a plausible-looking row.
      if (gross !== null && usable !== null && usable > gross) {
        throw new CsvError(
          `${batCsv.file}:${r.line}: Usable_kWh (${usable}) is larger than Gross_kWh (${gross}). ` +
            `Usable is the portion of the pack the car will actually use, so it cannot exceed gross.`,
        );
      }
      const id = insertBat.run(
        textCell(r, 'Chemistry', batCsv.file),
        gross, usable,
        intCell(r, 'Nominal_Voltage', batCsv.file, { min: 0, max: 2000 }),
        textCell(r, 'Thermal_Management', batCsv.file),
        textCell(r, 'Cell_Format', batCsv.file),
      ).lastInsertRowid;
      batRefs.record(ref, Number(id));
    }
    counts.batteries = batCsv.rows.length;

    // === LAYER 2 -- Powertrains =============================================
    const ptCsv = await readCsv('powertrains.csv');
    requireHeaders(
      ptCsv.headers,
      ['Ref', 'Powertrain_Type', 'Engine_Ref', 'Battery_Ref', 'Combined_Horsepower',
       'Combined_Torque_lbft', 'Electric_Range_mi', 'DC_Charge_kW', 'AC_Charge_kW', 'Charge_Port'],
      ptCsv.file,
    );
    const ptRefs = refResolver(ptCsv.file, 'powertrain');
    const insertPt = db.prepare(
      `INSERT INTO Powertrains
         (Powertrain_Type, Engine_Index, Battery_Index, Combined_Horsepower,
          Combined_Torque_lbft, Electric_Range_mi, DC_Charge_kW, AC_Charge_kW, Charge_Port)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const ptSorted = [...ptCsv.rows].sort((a, b) =>
      textCell(a, 'Ref', ptCsv.file, { required: true })!.toLowerCase()
        .localeCompare(textCell(b, 'Ref', ptCsv.file, { required: true })!.toLowerCase()),
    );

    for (const r of ptSorted) {
      const ref = textCell(r, 'Ref', ptCsv.file, { required: true })!;
      ptRefs.claim(ref, r.line);
      const type = textCell(r, 'Powertrain_Type', ptCsv.file);
      const engineRef = textCell(r, 'Engine_Ref', ptCsv.file);
      const batteryRef = textCell(r, 'Battery_Ref', ptCsv.file);

      // The whole reason this table exists is to stop a missing engine reading
      // as an unknown engine. A BEV with an engine attached would undo that, so
      // it is rejected rather than quietly stored.
      if (type && type.toLowerCase() === 'bev' && engineRef) {
        throw new CsvError(
          `${ptCsv.file}:${r.line}: powertrain "${ref}" is typed BEV but names an engine ` +
            `("${engineRef}"). A battery-electric powertrain has no combustion engine -- if this ` +
            `one does, it is a hybrid of some kind and Powertrain_Type should say which.`,
        );
      }

      const id = insertPt.run(
        type,
        engRefs.resolveOptional(engineRef, ptCsv.file, r.line, 'Engine_Ref'),
        batRefs.resolveOptional(batteryRef, ptCsv.file, r.line, 'Battery_Ref'),
        intCell(r, 'Combined_Horsepower', ptCsv.file, { min: 0, max: 5000 }),
        intCell(r, 'Combined_Torque_lbft', ptCsv.file, { min: 0, max: 20000 }),
        intCell(r, 'Electric_Range_mi', ptCsv.file, { min: 0, max: 2000 }),
        intCell(r, 'DC_Charge_kW', ptCsv.file, { min: 0, max: 2000 }),
        realCell(r, 'AC_Charge_kW', ptCsv.file, { min: 0, max: 100 }),
        textCell(r, 'Charge_Port', ptCsv.file),
      ).lastInsertRowid;
      ptRefs.record(ref, Number(id));
    }
    counts.powertrains = ptCsv.rows.length;

    // === LAYER 2 -- Powertrain_Motors =======================================
    const ptmCsv = await readCsv('powertrain_motors.csv');
    requireHeaders(ptmCsv.headers, ['Powertrain_Ref', 'Motor_Ref', 'Position', 'Quantity'], ptmCsv.file);
    const insertPtm = db.prepare(
      `INSERT INTO Powertrain_Motors (Powertrain_Index, Motor_Index, Position, Quantity)
       VALUES (?, ?, ?, ?)`,
    );
    for (const r of ptmCsv.rows) {
      insertPtm.run(
        ptRefs.resolve(textCell(r, 'Powertrain_Ref', ptmCsv.file, { required: true })!, ptmCsv.file, r.line, 'Powertrain_Ref'),
        motorRefs.resolve(textCell(r, 'Motor_Ref', ptmCsv.file, { required: true })!, ptmCsv.file, r.line, 'Motor_Ref'),
        textCell(r, 'Position', ptmCsv.file),
        intCell(r, 'Quantity', ptmCsv.file, { min: 1, max: 8 }),
      );
    }
    counts.powertrain_motors = ptmCsv.rows.length;

    // === LAYER 2 -- YMM_Powertrains =========================================
    const ympCsv = await readCsv('ymm_powertrains.csv');
    requireHeaders(ympCsv.headers, ['Make', 'Model', 'Year', 'Powertrain_Ref'], ympCsv.file);
    const insertYmp = db.prepare(
      'INSERT INTO YMM_Powertrains (YMM_Index, Powertrain_Index) VALUES (?, ?)',
    );
    const ympSeenAt = new Map<string, number>();
    for (const r of ympCsv.rows) {
      const make = textCell(r, 'Make', ympCsv.file, { required: true })!;
      const model = textCell(r, 'Model', ympCsv.file, { required: true })!;
      const year = intCell(r, 'Year', ympCsv.file, { required: true, min: 1885, max: 2100 })!;
      const ref = textCell(r, 'Powertrain_Ref', ympCsv.file, { required: true })!;

      const vid = resolveYmm(make, model, year, ympCsv.file, r.line);
      const pid = ptRefs.resolve(ref, ympCsv.file, r.line, 'Powertrain_Ref');

      const key = `${vid} ${pid}`;
      const prior = ympSeenAt.get(key);
      if (prior !== undefined) {
        throw new CsvError(
          `${ympCsv.file}:${r.line}: "${year} ${make} ${model}" is already paired with powertrain ` +
            `"${ref}" on line ${prior}.`,
        );
      }
      ympSeenAt.set(key, r.line);
      insertYmp.run(vid, pid);
    }
    counts.pairings = ympCsv.rows.length;

    // === LAYER 3 -- Transmissions ===========================================
    const txCsv = await readCsv('transmissions.csv');
    requireHeaders(
      txCsv.headers,
      ['Ref', 'Manufacturer', 'Code', 'Type', 'Forward_Gears', 'First_Gear_Ratio', 'Top_Gear_Ratio'],
      txCsv.file,
    );
    const txRefs = refResolver(txCsv.file, 'transmission');
    const insertTx = db.prepare(
      `INSERT INTO Transmissions (Manufacturer, Code, Type, Forward_Gears, First_Gear_Ratio, Top_Gear_Ratio)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of txCsv.rows) {
      const ref = textCell(r, 'Ref', txCsv.file, { required: true })!;
      txRefs.claim(ref, r.line);
      const id = insertTx.run(
        textCell(r, 'Manufacturer', txCsv.file),
        textCell(r, 'Code', txCsv.file),
        textCell(r, 'Type', txCsv.file),
        intCell(r, 'Forward_Gears', txCsv.file, { min: 1, max: 12 }),
        realCell(r, 'First_Gear_Ratio', txCsv.file, { min: 0, max: 20 }),
        realCell(r, 'Top_Gear_Ratio', txCsv.file, { min: 0, max: 20 }),
      ).lastInsertRowid;
      txRefs.record(ref, Number(id));
    }
    counts.transmissions = txCsv.rows.length;

    // === LAYER 3 -- Drivetrains =============================================
    const dtCsv = await readCsv('drivetrains.csv');
    requireHeaders(
      dtCsv.headers,
      ['Ref', 'Layout', 'Transfer_Case_Type', 'Transfer_Case_Model', 'Low_Range_Ratio',
       'Front_Hub_Type', 'Center_Differential', 'Front_Diff_Type', 'Rear_Diff_Type'],
      dtCsv.file,
    );
    const dtRefs = refResolver(dtCsv.file, 'drivetrain');
    const insertDt = db.prepare(
      `INSERT INTO Drivetrains
         (Layout, Transfer_Case_Type, Transfer_Case_Model, Low_Range_Ratio,
          Front_Hub_Type, Center_Differential, Front_Diff_Type, Rear_Diff_Type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of dtCsv.rows) {
      const ref = textCell(r, 'Ref', dtCsv.file, { required: true })!;
      dtRefs.claim(ref, r.line);
      const id = insertDt.run(
        textCell(r, 'Layout', dtCsv.file),
        textCell(r, 'Transfer_Case_Type', dtCsv.file),
        textCell(r, 'Transfer_Case_Model', dtCsv.file),
        realCell(r, 'Low_Range_Ratio', dtCsv.file, { min: 0, max: 10 }),
        textCell(r, 'Front_Hub_Type', dtCsv.file),
        textCell(r, 'Center_Differential', dtCsv.file),
        textCell(r, 'Front_Diff_Type', dtCsv.file),
        textCell(r, 'Rear_Diff_Type', dtCsv.file),
      ).lastInsertRowid;
      dtRefs.record(ref, Number(id));
    }
    counts.drivetrains = dtCsv.rows.length;

    // === LAYER 3 -- Suspensions =============================================
    const susCsv = await readCsv('suspensions.csv');
    requireHeaders(
      susCsv.headers,
      ['Ref', 'Front_Type', 'Rear_Type', 'Front_Spring', 'Rear_Spring', 'Damping', 'Ride_Height_Adjustable'],
      susCsv.file,
    );
    const susRefs = refResolver(susCsv.file, 'suspension');
    const insertSus = db.prepare(
      `INSERT INTO Suspensions
         (Front_Type, Rear_Type, Front_Spring, Rear_Spring, Damping, Ride_Height_Adjustable)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of susCsv.rows) {
      const ref = textCell(r, 'Ref', susCsv.file, { required: true })!;
      susRefs.claim(ref, r.line);
      const id = insertSus.run(
        textCell(r, 'Front_Type', susCsv.file),
        textCell(r, 'Rear_Type', susCsv.file),
        textCell(r, 'Front_Spring', susCsv.file),
        textCell(r, 'Rear_Spring', susCsv.file),
        textCell(r, 'Damping', susCsv.file),
        boolCell(r, 'Ride_Height_Adjustable', susCsv.file),
      ).lastInsertRowid;
      susRefs.record(ref, Number(id));
    }
    counts.suspensions = susCsv.rows.length;

    // === LAYER 4 -- Body_Configs ============================================
    const bodyCsv = await readCsv('body_configs.csv');
    requireHeaders(
      bodyCsv.headers,
      ['Ref', 'Body_Style', 'Doors', 'Cab_Config', 'Bed_Length_in', 'Bed_Volume_cuft',
       'Roof_Height', 'Wheelbase_in', 'Length_in', 'Width_in', 'Height_in',
       'Track_Front_in', 'Track_Rear_in', 'Ground_Clearance_in', 'Approach_Angle_deg',
       'Departure_Angle_deg', 'Breakover_Angle_deg', 'Drag_Coefficient',
       'Cargo_Volume_cuft', 'Cargo_Volume_Max_cuft', 'Fuel_Capacity_gal', 'Seating_Rows'],
      bodyCsv.file,
    );
    const bodyRefs = refResolver(bodyCsv.file, 'body config');
    const insertBody = db.prepare(
      `INSERT INTO Body_Configs
         (Body_Style, Doors, Cab_Config, Bed_Length_in, Bed_Volume_cuft, Roof_Height,
          Wheelbase_in, Length_in, Width_in, Height_in, Track_Front_in, Track_Rear_in,
          Ground_Clearance_in, Approach_Angle_deg, Departure_Angle_deg, Breakover_Angle_deg,
          Drag_Coefficient, Cargo_Volume_cuft, Cargo_Volume_Max_cuft, Fuel_Capacity_gal, Seating_Rows)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of bodyCsv.rows) {
      const ref = textCell(r, 'Ref', bodyCsv.file, { required: true })!;
      bodyRefs.claim(ref, r.line);
      const cargo = realCell(r, 'Cargo_Volume_cuft', bodyCsv.file, { min: 0, max: 1000 });
      const cargoMax = realCell(r, 'Cargo_Volume_Max_cuft', bodyCsv.file, { min: 0, max: 1000 });
      // Seats-folded volume is the seats-up volume plus whatever the seats were
      // occupying, so it cannot be the smaller of the two.
      if (cargo !== null && cargoMax !== null && cargoMax < cargo) {
        throw new CsvError(
          `${bodyCsv.file}:${r.line}: Cargo_Volume_Max_cuft (${cargoMax}) is smaller than ` +
            `Cargo_Volume_cuft (${cargo}). Max is the seats-folded figure, so it should be the larger one.`,
        );
      }
      const id = insertBody.run(
        textCell(r, 'Body_Style', bodyCsv.file),
        intCell(r, 'Doors', bodyCsv.file, { min: 0, max: 8 }),
        textCell(r, 'Cab_Config', bodyCsv.file),
        realCell(r, 'Bed_Length_in', bodyCsv.file, { min: 0, max: 400 }),
        realCell(r, 'Bed_Volume_cuft', bodyCsv.file, { min: 0, max: 1000 }),
        textCell(r, 'Roof_Height', bodyCsv.file),
        realCell(r, 'Wheelbase_in', bodyCsv.file, { min: 0, max: 400 }),
        realCell(r, 'Length_in', bodyCsv.file, { min: 0, max: 600 }),
        realCell(r, 'Width_in', bodyCsv.file, { min: 0, max: 200 }),
        realCell(r, 'Height_in', bodyCsv.file, { min: 0, max: 200 }),
        realCell(r, 'Track_Front_in', bodyCsv.file, { min: 0, max: 150 }),
        realCell(r, 'Track_Rear_in', bodyCsv.file, { min: 0, max: 150 }),
        realCell(r, 'Ground_Clearance_in', bodyCsv.file, { min: 0, max: 60 }),
        realCell(r, 'Approach_Angle_deg', bodyCsv.file, { min: 0, max: 90 }),
        realCell(r, 'Departure_Angle_deg', bodyCsv.file, { min: 0, max: 90 }),
        realCell(r, 'Breakover_Angle_deg', bodyCsv.file, { min: 0, max: 90 }),
        realCell(r, 'Drag_Coefficient', bodyCsv.file, { min: 0, max: 2 }),
        cargo, cargoMax,
        realCell(r, 'Fuel_Capacity_gal', bodyCsv.file, { min: 0, max: 200 }),
        intCell(r, 'Seating_Rows', bodyCsv.file, { min: 1, max: 6 }),
      ).lastInsertRowid;
      bodyRefs.record(ref, Number(id));
    }
    counts.body_configs = bodyCsv.rows.length;

    // === LAYER 4 -- YMM_Body_Configs ========================================
    const ybCsv = await readCsv('ymm_body_configs.csv');
    requireHeaders(ybCsv.headers, ['Make', 'Model', 'Year', 'Body_Config_Ref'], ybCsv.file);
    const insertYb = db.prepare(
      'INSERT INTO YMM_Body_Configs (YMM_Index, Body_Config_Index) VALUES (?, ?)',
    );
    const ybSeenAt = new Map<string, number>();
    for (const r of ybCsv.rows) {
      const make = textCell(r, 'Make', ybCsv.file, { required: true })!;
      const model = textCell(r, 'Model', ybCsv.file, { required: true })!;
      const year = intCell(r, 'Year', ybCsv.file, { required: true, min: 1885, max: 2100 })!;
      const vid = resolveYmm(make, model, year, ybCsv.file, r.line);
      const bid = bodyRefs.resolve(
        textCell(r, 'Body_Config_Ref', ybCsv.file, { required: true })!, ybCsv.file, r.line, 'Body_Config_Ref',
      );
      const key = `${vid} ${bid}`;
      const prior = ybSeenAt.get(key);
      if (prior !== undefined) {
        throw new CsvError(
          `${ybCsv.file}:${r.line}: "${year} ${make} ${model}" already lists that body config on line ${prior}.`,
        );
      }
      ybSeenAt.set(key, r.line);
      insertYb.run(vid, bid);
    }
    counts.ymm_body_configs = ybCsv.rows.length;

    // === LAYER 4 -- Seating_Configs =========================================
    const seatCsv = await readCsv('seating_configs.csv');
    requireHeaders(
      seatCsv.headers,
      ['Ref', 'Rows', 'Capacity', 'Second_Row_Type', 'Third_Row_Type', 'Front_Type'],
      seatCsv.file,
    );
    const seatRefs = refResolver(seatCsv.file, 'seating config');
    const insertSeat = db.prepare(
      `INSERT INTO Seating_Configs (Rows, Capacity, Second_Row_Type, Third_Row_Type, Front_Type)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of seatCsv.rows) {
      const ref = textCell(r, 'Ref', seatCsv.file, { required: true })!;
      seatRefs.claim(ref, r.line);
      const id = insertSeat.run(
        intCell(r, 'Rows', seatCsv.file, { min: 1, max: 6 }),
        intCell(r, 'Capacity', seatCsv.file, { min: 1, max: 20 }),
        textCell(r, 'Second_Row_Type', seatCsv.file),
        textCell(r, 'Third_Row_Type', seatCsv.file),
        textCell(r, 'Front_Type', seatCsv.file),
      ).lastInsertRowid;
      seatRefs.record(ref, Number(id));
    }
    counts.seating_configs = seatCsv.rows.length;

    // === LAYER 4 -- Interior_Dimensions =====================================
    const intCsv = await readCsv('interior_dimensions.csv');
    requireHeaders(
      intCsv.headers,
      ['Body_Config_Ref', 'Seating_Config_Ref', 'Row_Number', 'Headroom_in', 'Legroom_in',
       'Shoulder_Room_in', 'Hip_Room_in'],
      intCsv.file,
    );
    const insertInt = db.prepare(
      `INSERT INTO Interior_Dimensions
         (Body_Config_Index, Seating_Config_Index, Row_Number, Headroom_in, Legroom_in,
          Shoulder_Room_in, Hip_Room_in)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of intCsv.rows) {
      insertInt.run(
        bodyRefs.resolve(textCell(r, 'Body_Config_Ref', intCsv.file, { required: true })!, intCsv.file, r.line, 'Body_Config_Ref'),
        seatRefs.resolveOptional(textCell(r, 'Seating_Config_Ref', intCsv.file), intCsv.file, r.line, 'Seating_Config_Ref'),
        intCell(r, 'Row_Number', intCsv.file, { required: true, min: 1, max: 6 }),
        realCell(r, 'Headroom_in', intCsv.file, { min: 0, max: 100 }),
        realCell(r, 'Legroom_in', intCsv.file, { min: 0, max: 100 }),
        realCell(r, 'Shoulder_Room_in', intCsv.file, { min: 0, max: 100 }),
        realCell(r, 'Hip_Room_in', intCsv.file, { min: 0, max: 100 }),
      );
    }
    counts.interior_dimensions = intCsv.rows.length;

    // === LAYER 5 -- Trims ===================================================
    const trimCsv = await readCsv('trims.csv');
    requireHeaders(trimCsv.headers, ['Make', 'Model', 'Year', 'Trim_Name', 'Trim_Level', 'Notes'], trimCsv.file);
    const insertTrim = db.prepare(
      'INSERT INTO Trims (YMM_Index, Trim_Name, Trim_Level, Notes) VALUES (?, ?, ?, ?)',
    );
    /** (vehicle index + lowercased trim name) -> assigned trim index. */
    const trimIndex = new Map<string, number>();
    const trimSeenAt = new Map<string, number>();
    for (const r of trimCsv.rows) {
      const make = textCell(r, 'Make', trimCsv.file, { required: true })!;
      const model = textCell(r, 'Model', trimCsv.file, { required: true })!;
      const year = intCell(r, 'Year', trimCsv.file, { required: true, min: 1885, max: 2100 })!;
      const name = textCell(r, 'Trim_Name', trimCsv.file, { required: true })!;
      const vid = resolveYmm(make, model, year, trimCsv.file, r.line);

      const key = `${vid}|${name.toLowerCase()}`;
      const prior = trimSeenAt.get(key);
      if (prior !== undefined) {
        throw new CsvError(
          `${trimCsv.file}:${r.line}: "${year} ${make} ${model}" already lists a "${name}" trim on line ${prior}.`,
        );
      }
      trimSeenAt.set(key, r.line);
      const id = insertTrim.run(
        vid, name,
        intCell(r, 'Trim_Level', trimCsv.file, { min: 0, max: 50 }),
        textCell(r, 'Notes', trimCsv.file),
      ).lastInsertRowid;
      trimIndex.set(key, Number(id));
    }
    counts.trims = trimCsv.rows.length;

    // === LAYER 6 -- Builds ==================================================
    const buildCsv = await readCsv('builds.csv');
    requireHeaders(
      buildCsv.headers,
      ['Ref', 'Make', 'Model', 'Year', 'Trim_Name', 'Body_Config_Ref', 'Powertrain_Ref',
       'Transmission_Ref', 'Drivetrain_Ref', 'Suspension_Ref', 'Seating_Config_Ref',
       'Axle_Ratio', 'Equipment_Note', 'Curb_Weight_lb', 'GVWR_lb', 'GCWR_lb', 'Payload_lb',
       'Towing_Capacity_lb', 'Tongue_Weight_lb', 'EPA_City_mpg', 'EPA_Highway_mpg',
       'EPA_Combined_mpg', 'EPA_Electric_Range_mi', 'Zero_To_Sixty_s', 'Quarter_Mile_s',
       'Top_Speed_mph', 'Braking_60_0_ft'],
      buildCsv.file,
    );
    const buildRefs = refResolver(buildCsv.file, 'build');
    const insertBuild = db.prepare(
      `INSERT INTO Builds
         (YMM_Index, Trim_Index, Body_Config_Index, Powertrain_Index, Transmission_Index,
          Drivetrain_Index, Suspension_Index, Seating_Config_Index, Axle_Ratio, Equipment_Note,
          Curb_Weight_lb, GVWR_lb, GCWR_lb, Payload_lb, Towing_Capacity_lb, Tongue_Weight_lb,
          EPA_City_mpg, EPA_Highway_mpg, EPA_Combined_mpg, EPA_Electric_Range_mi,
          Zero_To_Sixty_s, Quarter_Mile_s, Top_Speed_mph, Braking_60_0_ft)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const r of buildCsv.rows) {
      const ref = textCell(r, 'Ref', buildCsv.file, { required: true })!;
      buildRefs.claim(ref, r.line);
      const make = textCell(r, 'Make', buildCsv.file, { required: true })!;
      const model = textCell(r, 'Model', buildCsv.file, { required: true })!;
      const year = intCell(r, 'Year', buildCsv.file, { required: true, min: 1885, max: 2100 })!;
      const vid = resolveYmm(make, model, year, buildCsv.file, r.line);

      // A trim is named rather than Ref'd, because a trim is only meaningful
      // relative to its own vehicle-year -- "LTZ" alone identifies nothing.
      const trimName = textCell(r, 'Trim_Name', buildCsv.file);
      let trimId: number | null = null;
      if (trimName) {
        trimId = trimIndex.get(`${vid}|${trimName.toLowerCase()}`) ?? null;
        if (trimId === null) {
          throw new CsvError(
            `${buildCsv.file}:${r.line}: "${year} ${make} ${model}" has no "${trimName}" trim in ` +
              `trims.csv. Add it there first, or correct the spelling here.`,
          );
        }
      }

      const gvwr = intCell(r, 'GVWR_lb', buildCsv.file, { min: 0, max: 100000 });
      const curb = intCell(r, 'Curb_Weight_lb', buildCsv.file, { min: 0, max: 100000 });
      // GVWR is curb weight plus everything you are allowed to put in it, so a
      // GVWR below curb weight is a transcription error every time.
      if (gvwr !== null && curb !== null && gvwr < curb) {
        throw new CsvError(
          `${buildCsv.file}:${r.line}: GVWR_lb (${gvwr}) is below Curb_Weight_lb (${curb}). ` +
            `GVWR includes the weight of the vehicle itself, so it is always the larger figure.`,
        );
      }

      insertBuild.run(
        vid, trimId,
        bodyRefs.resolveOptional(textCell(r, 'Body_Config_Ref', buildCsv.file), buildCsv.file, r.line, 'Body_Config_Ref'),
        ptRefs.resolveOptional(textCell(r, 'Powertrain_Ref', buildCsv.file), buildCsv.file, r.line, 'Powertrain_Ref'),
        txRefs.resolveOptional(textCell(r, 'Transmission_Ref', buildCsv.file), buildCsv.file, r.line, 'Transmission_Ref'),
        dtRefs.resolveOptional(textCell(r, 'Drivetrain_Ref', buildCsv.file), buildCsv.file, r.line, 'Drivetrain_Ref'),
        susRefs.resolveOptional(textCell(r, 'Suspension_Ref', buildCsv.file), buildCsv.file, r.line, 'Suspension_Ref'),
        seatRefs.resolveOptional(textCell(r, 'Seating_Config_Ref', buildCsv.file), buildCsv.file, r.line, 'Seating_Config_Ref'),
        realCell(r, 'Axle_Ratio', buildCsv.file, { min: 0, max: 15 }),
        textCell(r, 'Equipment_Note', buildCsv.file),
        curb, gvwr,
        intCell(r, 'GCWR_lb', buildCsv.file, { min: 0, max: 200000 }),
        intCell(r, 'Payload_lb', buildCsv.file, { min: 0, max: 50000 }),
        intCell(r, 'Towing_Capacity_lb', buildCsv.file, { min: 0, max: 100000 }),
        intCell(r, 'Tongue_Weight_lb', buildCsv.file, { min: 0, max: 20000 }),
        realCell(r, 'EPA_City_mpg', buildCsv.file, { min: 0, max: 250 }),
        realCell(r, 'EPA_Highway_mpg', buildCsv.file, { min: 0, max: 250 }),
        realCell(r, 'EPA_Combined_mpg', buildCsv.file, { min: 0, max: 250 }),
        intCell(r, 'EPA_Electric_Range_mi', buildCsv.file, { min: 0, max: 2000 }),
        realCell(r, 'Zero_To_Sixty_s', buildCsv.file, { min: 0, max: 60 }),
        realCell(r, 'Quarter_Mile_s', buildCsv.file, { min: 0, max: 60 }),
        intCell(r, 'Top_Speed_mph', buildCsv.file, { min: 0, max: 400 }),
        intCell(r, 'Braking_60_0_ft', buildCsv.file, { min: 0, max: 400 }),
      );
    }
    counts.builds = buildCsv.rows.length;

    // === DERIVED -- Build_Rollup ============================================
    // Computed in SQL rather than in JS because the source rows are already in
    // the database at this point and this is exactly what a GROUP BY is for.
    db.exec(`
      INSERT INTO Build_Rollup (
        YMM_Index, Build_Count,
        Min_Towing_Capacity_lb, Max_Towing_Capacity_lb,
        Min_Payload_lb, Max_Payload_lb,
        Min_Curb_Weight_lb, Max_Curb_Weight_lb,
        Min_GVWR_lb, Max_GVWR_lb,
        Min_EPA_Combined_mpg, Max_EPA_Combined_mpg,
        Min_Zero_To_Sixty_s, Max_Zero_To_Sixty_s,
        Trim_Summary
      )
      SELECT
        b.YMM_Index,
        COUNT(*),
        MIN(b.Towing_Capacity_lb), MAX(b.Towing_Capacity_lb),
        MIN(b.Payload_lb),         MAX(b.Payload_lb),
        MIN(b.Curb_Weight_lb),     MAX(b.Curb_Weight_lb),
        MIN(b.GVWR_lb),            MAX(b.GVWR_lb),
        MIN(b.EPA_Combined_mpg),   MAX(b.EPA_Combined_mpg),
        MIN(b.Zero_To_Sixty_s),    MAX(b.Zero_To_Sixty_s),
        (SELECT GROUP_CONCAT(t.Trim_Name, ', ')
           FROM (SELECT DISTINCT t2.Trim_Name, t2.Trim_Level
                   FROM Builds b2
                   JOIN Trims t2 ON t2."Index" = b2.Trim_Index
                  WHERE b2.YMM_Index = b.YMM_Index
                  ORDER BY t2.Trim_Level, t2.Trim_Name) t)
      FROM Builds b
      GROUP BY b.YMM_Index
    `);
    counts.build_rollup =
      (db.prepare('SELECT COUNT(*) AS n FROM Build_Rollup').get() as { n: number }).n;

    // === DERIVED -- Field_Choices ===========================================
    // One pass per searchable field over Search_View, done once here so the API
    // never has to. Only fields backed by a plain view column are materialised;
    // anything reached through an EXISTS has no single column to group by.
    const insertChoice = db.prepare(
      'INSERT OR REPLACE INTO Field_Choices (Field_Name, Value, N) VALUES (?, ?, ?)',
    );
    let choiceRows = 0;
    for (const field of FIELDS) {
      if (field.source && field.source !== 'view') continue;
      const rows = db.prepare(
        `SELECT \`${field.column}\` AS value, COUNT(*) AS n
           FROM Search_View
          WHERE \`${field.column}\` IS NOT NULL
          GROUP BY \`${field.column}\`
          ORDER BY \`${field.column}\`
          LIMIT 500`,
      ).all() as { value: unknown; n: number }[];
      for (const row of rows) {
        insertChoice.run(field.name, String(row.value), row.n);
        choiceRows++;
      }
    }
    counts.field_choices = choiceRows;

    // === Build metadata =====================================================
    const meta = db.prepare('INSERT INTO build_info (key, value) VALUES (?, ?)');
    meta.run('built_at', new Date().toISOString());
    meta.run('schema_version', '3');
    meta.run('git_commit', process.env.GITHUB_SHA ?? 'local');

    db.exec('COMMIT');

    const combos = db.prepare('SELECT COUNT(*) AS n FROM Search_View').get() as { n: number };
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);

    console.log(
      `\n  ${counts.vehicles} vehicle-years / ${counts.powertrains} powertrains ` +
        `(${counts.engines} engines, ${counts.motors} motors, ${counts.batteries} batteries) ` +
        `/ ${counts.pairings} pairings\n` +
        `  ${counts.transmissions} transmissions / ${counts.drivetrains} drivetrains / ` +
        `${counts.suspensions} suspensions\n` +
        `  ${counts.body_configs} body configs / ${counts.seating_configs} seating configs / ` +
        `${counts.interior_dimensions} interior dimensions\n` +
        `  ${counts.trims} trims / ${counts.builds} builds ` +
        `(${counts.build_rollup} rolled up) / ${counts.field_choices} materialised choices\n` +
        `  ${combos.n} searchable combinations in ${elapsed}s\n` +
        (VALIDATE_ONLY ? '  Validated. Nothing written.\n' : `  Output: ${OUT_PATH}\n`),
    );
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}

main().catch((e) => {
  // A CSV problem is a contributor's problem, not a crash. Print the message
  // and nothing else -- a stack trace through the parser tells them nothing
  // about which row of their spreadsheet is wrong.
  if (e instanceof CsvError) {
    console.error(`\n  ${e.message}\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
