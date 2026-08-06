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
 */

import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, requireHeaders, intCell, textCell, CsvError, type CsvRow } from './csv.js';

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
    // --- Year_Make_Model ----------------------------------------------------
    const ymmCsv = await readCsv('year_make_model.csv');
    requireHeaders(ymmCsv.headers, ['Make', 'Model', 'Year'], ymmCsv.file);

    interface YmmRow { make: string; model: string; year: number; line: number }
    const ymmRows: YmmRow[] = ymmCsv.rows.map((r) => ({
      make: textCell(r, 'Make', ymmCsv.file, { required: true })!,
      model: textCell(r, 'Model', ymmCsv.file, { required: true })!,
      // 1885 is the Benz Patent-Motorwagen; the upper bound leaves room for a
      // model year announced ahead of the calendar year without accepting a
      // transposed digit like 20226 as a real car.
      year: intCell(r, 'Year', ymmCsv.file, { required: true, min: 1885, max: 2100 })!,
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
      'INSERT INTO Year_Make_Model (Make, Model, Year) VALUES (?, ?, ?)',
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
      const id = insertYmm.run(r.make, r.model, r.year).lastInsertRowid;
      ymmIndex.set(key, Number(id));
    }

    // --- Engine_Specs -------------------------------------------------------
    const engCsv = await readCsv('engine_specs.csv');
    requireHeaders(
      engCsv.headers,
      ['Code', 'Layout', 'Cylinders', 'CC_Displacement', 'Aspiration', 'Fuel_Type', 'Compression_ratio', 'Fuel_delivery'],
      engCsv.file,
    );

    interface EngRow {
      code: string; layout: string | null; cylinders: number | null;
      cc: number | null; aspiration: string | null; fuelType: string | null;
      compression: string | null; delivery: string | null; line: number;
    }

    const engRows: EngRow[] = engCsv.rows.map((r: CsvRow) => ({
      // Code is a build-time handle only. It is how ymm_engines.csv points at
      // an engine without anyone having to know its assigned index, and it is
      // deliberately not a column in Engine_Specs -- that table holds the specs
      // describing the engine, not the label this repository files it under.
      code: textCell(r, 'Code', engCsv.file, { required: true })!,
      layout: textCell(r, 'Layout', engCsv.file),
      cylinders: intCell(r, 'Cylinders', engCsv.file, { min: 0, max: 32 }),
      cc: intCell(r, 'CC_Displacement', engCsv.file, { min: 0, max: 200000 }),
      aspiration: textCell(r, 'Aspiration', engCsv.file),
      fuelType: textCell(r, 'Fuel_Type', engCsv.file),
      compression: textCell(r, 'Compression_ratio', engCsv.file),
      delivery: textCell(r, 'Fuel_delivery', engCsv.file),
      line: r.line,
    }));

    engRows.sort((a, b) => a.code.toLowerCase().localeCompare(b.code.toLowerCase()));

    const insertEng = db.prepare(
      `INSERT INTO Engine_Specs
         (Layout, Cylinders, CC_Displacement, Aspiration, Fuel_Type, Compression_ratio, Fuel_delivery)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const engIndex = new Map<string, number>();
    const engSeenAt = new Map<string, number>();

    for (const r of engRows) {
      const key = r.code.toLowerCase();
      const prior = engSeenAt.get(key);
      if (prior !== undefined) {
        throw new CsvError(
          `${engCsv.file}:${r.line}: engine code "${r.code}" is already used on line ${prior}. ` +
            `Codes identify an engine and must be unique.`,
        );
      }
      engSeenAt.set(key, r.line);
      const id = insertEng.run(
        r.layout, r.cylinders, r.cc, r.aspiration, r.fuelType, r.compression, r.delivery,
      ).lastInsertRowid;
      engIndex.set(key, Number(id));
    }

    // --- YMM_Engines --------------------------------------------------------
    const linkCsv = await readCsv('ymm_engines.csv');
    requireHeaders(linkCsv.headers, ['Make', 'Model', 'Year', 'Engine_Code'], linkCsv.file);

    const insertLink = db.prepare(
      'INSERT INTO YMM_Engines (YMM_Index, Engine_Index) VALUES (?, ?)',
    );
    const linkSeenAt = new Map<string, number>();
    let links = 0;

    for (const r of linkCsv.rows) {
      const make = textCell(r, 'Make', linkCsv.file, { required: true })!;
      const model = textCell(r, 'Model', linkCsv.file, { required: true })!;
      const year = intCell(r, 'Year', linkCsv.file, { required: true, min: 1885, max: 2100 })!;
      const code = textCell(r, 'Engine_Code', linkCsv.file, { required: true })!;

      // Both sides are resolved strictly. A typo here would otherwise create a
      // vehicle that exists only in this file and shows up in searches as a
      // near-duplicate of the real one.
      const vid = ymmIndex.get(ymmKey(make, model, year));
      if (vid === undefined) {
        throw new CsvError(
          `${linkCsv.file}:${r.line}: "${year} ${make} ${model}" is not in year_make_model.csv. ` +
            `Add it there first, or correct the spelling here.`,
        );
      }
      const eid = engIndex.get(code.toLowerCase());
      if (eid === undefined) {
        throw new CsvError(
          `${linkCsv.file}:${r.line}: engine code "${code}" is not in engine_specs.csv.`,
        );
      }

      const key = `${vid} ${eid}`;
      const prior = linkSeenAt.get(key);
      if (prior !== undefined) {
        throw new CsvError(
          `${linkCsv.file}:${r.line}: "${year} ${make} ${model}" is already paired with engine ` +
            `"${code}" on line ${prior}.`,
        );
      }
      linkSeenAt.set(key, r.line);
      insertLink.run(vid, eid);
      links++;
    }

    // --- Build metadata -----------------------------------------------------
    const meta = db.prepare('INSERT INTO build_info (key, value) VALUES (?, ?)');
    meta.run('built_at', new Date().toISOString());
    meta.run('schema_version', '2');
    meta.run('git_commit', process.env.GITHUB_SHA ?? 'local');

    db.exec('COMMIT');

    const combos = db.prepare('SELECT COUNT(*) AS n FROM Search_View').get() as { n: number };
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);

    console.log(
      `\n  ${ymmRows.length} vehicle-years / ${engRows.length} engines / ${links} pairings\n` +
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
