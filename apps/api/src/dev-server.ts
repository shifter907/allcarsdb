/**
 * Local development server.
 *
 * Runs the exact Hono app that ships to Cloudflare, against the local
 * dist/allcars.sqlite, by implementing just enough of the D1 interface on top
 * of node:sqlite. Nothing about the routes or the query compiler changes
 * between here and production -- which is the point: a bug found locally is
 * the same bug that would have shipped.
 *
 *   npm run dev -w @allcarsdb/api
 */

import { serve } from '@hono/node-server';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import app from './index.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DB_PATH = join(ROOT, 'dist', 'allcars.sqlite');

if (!existsSync(DB_PATH)) {
  console.error(`\n  No database at ${DB_PATH}\n  Run: npm run build:db\n`);
  process.exit(1);
}

const sqlite = new DatabaseSync(DB_PATH, { readOnly: true });

// ---------------------------------------------------------------------------
// Minimal D1 shim
// ---------------------------------------------------------------------------
// Covers prepare/bind/all/first/run/batch, which is everything the Worker
// uses. Deliberately not a general-purpose emulator -- if a route starts
// needing more of D1, that should be a visible failure here rather than a
// silent behaviour difference in production.

type Bound = { stmt: StatementSync; params: unknown[]; sql: string };

function toBindable(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

class ShimStatement {
  constructor(private readonly bound: Bound) {}

  bind(...params: unknown[]) {
    return new ShimStatement({ ...this.bound, params: params.map(toBindable) });
  }

  async all() {
    try {
      return { results: this.bound.stmt.all(...(this.bound.params as never[])), success: true };
    } catch (e) {
      throw new Error(`${(e as Error).message}\n  SQL: ${this.bound.sql}`);
    }
  }

  async first<T = unknown>(): Promise<T | null> {
    const rows = this.bound.stmt.all(...(this.bound.params as never[]));
    return (rows[0] as T) ?? null;
  }

  async run() {
    const r = this.bound.stmt.run(...(this.bound.params as never[]));
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
}

const shim = {
  prepare(sql: string) {
    return new ShimStatement({ stmt: sqlite.prepare(sql), params: [], sql });
  },
  async batch(statements: ShimStatement[]) {
    return Promise.all(statements.map((s) => s.all()));
  },
};

// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: (req: Request) => app.fetch(req, { DB: shim as never }), port }, (info) => {
  const { rows } = sqlite
    .prepare('SELECT COUNT(*) AS rows FROM Search_View')
    .get() as { rows: number };
  console.log(`\n  AllCarsDB API  http://localhost:${info.port}`);
  console.log(`  ${rows} searchable rows loaded from dist/allcars.sqlite\n`);
  console.log('  Try:');
  console.log(`    http://localhost:${info.port}/v1/search?layout=Flat&cylinders=6`);
  console.log(`    http://localhost:${info.port}/v1/search?displacement=lt:2l`);
  console.log(`    http://localhost:${info.port}/v1/fields\n`);
});
