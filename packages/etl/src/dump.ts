/**
 * dist/allcars.sqlite -> dist/allcars.sql
 *
 * Cloudflare D1 imports SQL text, not a SQLite file, so the artifact needs a
 * textual twin. This also gives us the format most useful to anyone who wants
 * to load the whole dataset into Postgres, DuckDB or a spreadsheet -- an open
 * database that is hard to bulk-download is not meaningfully open.
 *
 *   npm run dump -w @allcarsdb/etl
 */

import { DatabaseSync } from 'node:sqlite';
import { createWriteStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DB_PATH = join(ROOT, 'dist', 'allcars.sqlite');
const OUT_PATH = join(ROOT, 'dist', 'allcars.sql');
const MIGRATIONS = join(ROOT, 'packages', 'db', 'migrations');

/** Rows per INSERT. D1 rejects oversized statements; this stays well under. */
const BATCH = 500;

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) {
    return `X'${Buffer.from(v).toString('hex')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const out = createWriteStream(OUT_PATH, { encoding: 'utf8' });

  const write = async (s: string) => {
    if (!out.write(s)) await once(out, 'drain');
  };

  await write('-- AllCarsDB full dump\n');
  await write(`-- Generated ${new Date().toISOString()}\n`);
  await write('-- Load with: wrangler d1 execute allcarsdb --remote --file=allcars.sql\n\n');
  await write('PRAGMA foreign_keys = OFF;\n\n');

  const tables = (
    db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    ).all() as { name: string }[]
  ).map((t) => t.name);

  const views = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`).all() as
      { name: string }[]
  ).map((v) => v.name);

  // Idempotency: this file is applied with `wrangler d1 execute` against
  // whatever the live database currently looks like, not necessarily an empty
  // one -- a hand-provisioned schema, a partial prior deploy, a table added
  // out of band. Dropping everything first (FKs are off, so order doesn't
  // matter) means every deploy is a clean reload regardless of what state the
  // target database started in, rather than a "table already exists" failure
  // that only reproduces if you happen to know the database's history.
  //
  // The drop list is taken from the database being dumped, so it only covers
  // objects this schema knows about. Tables left behind by an *older* schema
  // are listed separately below, because nothing in the current build has any
  // record that they ever existed.
  await write('-- Drop everything first so this script is safe to run against a\n');
  await write('-- database that already has some or all of this schema.\n');
  for (const view of views) {
    await write(`DROP VIEW IF EXISTS ${view};\n`);
  }
  for (const table of tables) {
    await write(`DROP TABLE IF EXISTS ${table};\n`);
  }

  // Superseded by the CSV-sourced schema. Left here so a database provisioned
  // under the old YAML model converges to the current one instead of keeping
  // 39 orphaned tables that no code reads and no build maintains.
  const RETIRED = [
    'variant_fts', 'variant_display', 'variant_search', 'facet_count', 'data_gap',
    'fact_source', 'source', 'contributor', 'variant_feature', 'feature',
    'spec_chassis', 'spec_capacity', 'spec_efficiency', 'spec_performance',
    'spec_interior', 'spec_exterior', 'powertrain', 'drivetrain', 'transmission',
    'battery_pack', 'electric_motor', 'engine', 'variant', 'trim', 'model_year',
    'generation', 'model', 'make', 'manufacturer', 'body_style', 'enum_label',
    'data_file',
  ];
  await write('\n-- Retired by the CSV schema; dropped so old databases converge.\n');
  for (const t of RETIRED) {
    if (!tables.includes(t)) await write(`DROP TABLE IF EXISTS ${t};\n`);
  }
  await write('\n');

  // Schema comes from the migrations rather than sqlite_master, so the dump
  // keeps its comments -- they are a large part of what makes this schema
  // legible to someone encountering it cold.
  for (const f of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    await write(`-- ===== ${f} =====\n`);
    await write(await readFile(join(MIGRATIONS, f), 'utf8'));
    await write('\n');
  }

  let totalRows = 0;

  for (const table of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (cols.length === 0) continue;

    const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM ${table}`).all() as Record<string, unknown>[];
    if (rows.length === 0) continue;

    await write(`\n-- ${table}: ${rows.length} rows\n`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = chunk
        .map((r) => `(${cols.map((c) => literal(r[c])).join(',')})`)
        .join(',\n  ');
      await write(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES\n  ${values};\n`);
    }
    totalRows += rows.length;
  }

  // Search_View is a view, so it needs no rows dumped -- the CREATE VIEW in the
  // migration above is the whole of it, and it recomputes from the three
  // source tables the moment they are populated.
  await write('\nPRAGMA foreign_keys = ON;\n');

  db.close();
  out.end();
  await once(out, 'finish');

  const size = (await stat(OUT_PATH)).size;
  console.log(
    `  Dumped ${totalRows} rows from ${tables.length} tables\n` +
      `  ${OUT_PATH} (${(size / 1024).toFixed(0)} KB)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
