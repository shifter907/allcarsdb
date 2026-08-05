/**
 * The build: data/**\/*.yaml -> dist/allcars.sqlite
 *
 * A full rebuild from source on every run. No incremental writes, no
 * migrations against live data, no "the database drifted from the files"
 * failure mode. The database is a build artifact; the YAML is the truth.
 * At the scale where a full rebuild stops being fast (millions of variants)
 * the fix is to shard the build by make, which this structure already allows.
 *
 * Ordering matters and is enforced by the phases below: catalogs before
 * components, components before vehicles, everything before the search index.
 */

import { readFile, readdir, mkdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
// node:sqlite rather than better-sqlite3, deliberately. better-sqlite3 needs a
// native compile, which on Windows means Python plus Visual Studio Build Tools
// -- a wall that stops casual contributors before they have written a line of
// YAML. Node 22+ ships SQLite (3.53 here) with FTS5 and partial indexes, which
// is everything this build needs.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  VehicleFileSchema,
  MakeFileSchema,
  BodyStyleFileSchema,
  FeatureCatalogSchema,
  EngineSchema,
  TransmissionSchema,
  DrivetrainSchema,
  ElectricMotorSchema,
  BatterySchema,
  PowertrainSchema,
  type VehicleFile,
  type Engine,
  type Transmission,
  type Drivetrain,
  type ElectricMotor,
  type Battery,
  type Powertrain,
} from '@allcarsdb/schema/vehicle';
import { ENUM_REGISTRY, Availability, Market, Confidence } from '@allcarsdb/schema/enums';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DATA = join(ROOT, 'data');
const MIGRATIONS = join(ROOT, 'packages', 'db', 'migrations');
const OUT_DIR = join(ROOT, 'dist');
const OUT_DB = join(OUT_DIR, 'allcars.sqlite');

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

interface Diagnostic {
  file: string;
  path?: string;
  message: string;
  severity: 'error' | 'warning';
}

const diagnostics: Diagnostic[] = [];
const err = (file: string, message: string, path?: string) =>
  diagnostics.push({ file, message, path, severity: 'error' });
const warn = (file: string, message: string, path?: string) =>
  diagnostics.push({ file, message, path, severity: 'warning' });

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Leading underscore means "not data": templates, drafts, notes-to-self.
    // Contributors reach for it naturally, and _template.yaml has to live
    // beside real files to be discoverable.
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

async function readYamlFile(path: string): Promise<unknown> {
  try {
    return parseYaml(await readFile(path, 'utf8'));
  } catch (e) {
    err(rel(path), `YAML parse error: ${(e as Error).message}`);
    return null;
  }
}

/** Key-sorted JSON, so two equivalent inline definitions hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

const hashOf = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// node:sqlite helpers
// ---------------------------------------------------------------------------

/** What node:sqlite will accept as a bound parameter. */
type SqlValue = null | number | bigint | string | Uint8Array;

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const columnsOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Generic insert driven by the table's own column list.
 *
 * Every column not present in `row` becomes NULL, and `undefined` is coerced
 * to NULL (node:sqlite refuses to bind it). The upshot is that adding a column
 * to a migration needs no ETL change at all -- the loader picks it up as soon
 * as a mapper starts producing it.
 */
function makeInserter(db: DatabaseSync) {
  const cache = new Map<string, { stmt: StatementSync; cols: string[] }>();

  return function insert(
    table: string,
    row: Record<string, unknown>,
    mode: 'insert' | 'replace' = 'insert',
  ): number {
    const key = `${table}:${mode}`;
    let entry = cache.get(key);
    if (!entry) {
      // 'id' is INTEGER PRIMARY KEY on the catalog tables and must be left to
      // SQLite; the spec tables key on variant_id, which is a real column.
      const cols = columnsOf(db, table).filter((c) => c !== 'id');
      const verb = mode === 'replace' ? 'INSERT OR REPLACE INTO' : 'INSERT INTO';
      entry = {
        stmt: db.prepare(
          `${verb} ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
        ),
        cols,
      };
      cache.set(key, entry);
    }
    const full: Record<string, SqlValue> = {};
    for (const c of entry.cols) full[c] = (row[c] ?? null) as SqlValue;
    return Number(entry.stmt.run(full).lastInsertRowid);
  };
}

type Insert = ReturnType<typeof makeInserter>;

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

async function createDatabase(inMemory: boolean): Promise<DatabaseSync> {
  // Validation builds entirely in memory. Besides being faster, it means
  // `npm run validate` works while the dev server has dist/allcars.sqlite
  // open -- which on Windows would otherwise fail with EBUSY, exactly when a
  // contributor is most likely to be iterating on a file.
  if (inMemory) {
    const mem = new DatabaseSync(':memory:');
    mem.exec('PRAGMA foreign_keys = OFF');
    for (const f of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
      mem.exec(await readFile(join(MIGRATIONS, f), 'utf8'));
    }
    return mem;
  }

  await mkdir(OUT_DIR, { recursive: true });
  if (existsSync(OUT_DB)) {
    try {
      await unlink(OUT_DB);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EBUSY') {
        throw new Error(
          `dist/allcars.sqlite is in use -- stop the dev API server (npm run dev:api) and try again.\n` +
            `  To check your data without writing a database, run: npm run validate`,
        );
      }
      throw e;
    }
  }

  const db = new DatabaseSync(OUT_DB);
  // Build-time pragmas: durability does not matter for an artifact we can
  // regenerate, and these make the import several times faster.
  db.exec('PRAGMA journal_mode = OFF');
  db.exec('PRAGMA synchronous = OFF');
  db.exec('PRAGMA foreign_keys = OFF'); // re-enabled and checked after loading
  db.exec('PRAGMA cache_size = -64000');

  for (const f of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(await readFile(join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

/** Mirror packages/schema/src/enums.ts into the artifact. */
function populateEnumLabels(db: DatabaseSync) {
  const stmt = db.prepare(
    `INSERT INTO enum_label (enum_name, code, slug, label, short, note, deprecated)
     VALUES (?,?,?,?,?,?,?)`,
  );
  transaction(db, () => {
    for (const [name, def] of Object.entries(ENUM_REGISTRY)) {
      for (const m of def.members) {
        stmt.run(name, m.code, m.slug, m.label, m.short ?? null, m.note ?? null, m.deprecated ? 1 : 0);
      }
    }
  });

  const info = db.prepare('INSERT OR REPLACE INTO build_info (key, value) VALUES (?,?)');
  info.run('built_at', new Date().toISOString());
  info.run('schema_version', '1');
  info.run('git_commit', process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? 'local');
}

// ---------------------------------------------------------------------------
// Interning: slug -> row id, with content-hash dedup for inline definitions
// ---------------------------------------------------------------------------

class Interner {
  private byKey = new Map<string, number>();

  constructor(
    private readonly name: string,
    private readonly table: string,
    private readonly insert: Insert,
  ) {}

  define(slug: string, row: Record<string, unknown>): number {
    const existing = this.byKey.get(slug);
    if (existing !== undefined) return existing;
    const id = this.insert(this.table, { ...row, slug });
    this.byKey.set(slug, id);
    return id;
  }

  has = (slug: string) => this.byKey.has(slug);
  get = (slug: string) => this.byKey.get(slug);

  /**
   * Resolve a reference that is either a slug string or an inline definition.
   *
   * `value` is ALREADY VALIDATED -- zod ran on the way in and turned enum slugs
   * into numeric codes. Re-parsing it here would fail, because the schema
   * expects the string form it has already consumed. That subtlety is why the
   * builders take typed input rather than `unknown`.
   *
   * Inline definitions are hoisted into the catalog under a slug derived from
   * their content hash, so the same engine written out in two files collapses
   * to one row.
   */
  resolve<T extends { slug?: string }>(
    value: string | T | undefined | null,
    context: string,
    file: string,
    build: (v: T) => Record<string, unknown>,
  ): number | null {
    if (value == null) return null;

    if (typeof value === 'string') {
      const id = this.byKey.get(value);
      if (id === undefined) {
        err(file, `Unknown ${this.name} "${value}" referenced by ${context}`);
        return null;
      }
      return id;
    }

    const key = value.slug ?? `${this.name}-${hashOf(value)}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    return this.define(key, build(value));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function build(opts: { validateOnly?: boolean } = {}): Promise<number> {
  const started = Date.now();
  const db = await createDatabase(opts.validateOnly === true);
  populateEnumLabels(db);

  const insert = makeInserter(db);
  const stats = {
    makes: 0, models: 0, generations: 0, trims: 0, variants: 0,
    engines: 0, powertrains: 0, features: 0, files: 0,
  };

  const engines = new Interner('engine', 'engine', insert);
  const transmissions = new Interner('transmission', 'transmission', insert);
  const drivetrains = new Interner('drivetrain', 'drivetrain', insert);
  const motors = new Interner('electric_motor', 'electric_motor', insert);
  const batteries = new Interner('battery_pack', 'battery_pack', insert);
  const powertrains = new Interner('powertrain', 'powertrain', insert);

  const makeIds = new Map<string, number>();
  const modelIds = new Map<string, number>();
  const generationIds = new Map<string, number>();
  const bodyStyleIds = new Map<string, number>();
  const featureIds = new Map<string, number>();
  const featureBits = new Map<string, number>();
  const featureValueTypes = new Map<string, string>();

  // =========================================================================
  // Phase 1 -- catalogs
  // =========================================================================

  await loadBodyStyles();
  await loadFeatures();
  await loadMakes();

  // The API needs the slug -> search_bit map to choose the bitmask path over
  // the join path. Stashing it in the artifact means the Worker never has to
  // read the repository, and the map can never drift from the index it
  // describes -- they ship in the same file.
  db.prepare('INSERT OR REPLACE INTO build_info (key, value) VALUES (?,?)')
    .run('feature_bits', JSON.stringify(Object.fromEntries(featureBits)));

  // =========================================================================
  // Phase 2 -- shared component catalogs
  // =========================================================================

  // Catalog files hold raw YAML, so they get validated here. Everything
  // downstream of this point works with already-validated objects.
  const componentDirs = [
    { dir: 'engines', schema: EngineSchema, build: buildEngineRow, interner: engines },
    { dir: 'transmissions', schema: TransmissionSchema, build: buildTransmissionRow, interner: transmissions },
    { dir: 'drivetrains', schema: DrivetrainSchema, build: buildDrivetrainRow, interner: drivetrains },
    { dir: 'motors', schema: ElectricMotorSchema, build: buildMotorRow, interner: motors },
    { dir: 'batteries', schema: BatterySchema, build: buildBatteryRow, interner: batteries },
  ] as const;

  for (const { dir, schema, build: builder, interner } of componentDirs) {
    for (const path of await walk(join(DATA, 'components', dir))) {
      const doc = await readYamlFile(path);
      if (doc == null) continue;
      for (const item of Array.isArray(doc) ? doc : [doc]) {
        const s = (item as { slug?: string }).slug;
        if (!s) { err(rel(path), 'Shared components must declare a slug'); continue; }
        if (interner.has(s)) { err(rel(path), `Duplicate component slug "${s}"`); continue; }
        const parsed = schema.safeParse(item);
        if (!parsed.success) { reportZod(rel(path), parsed.error); continue; }
        interner.define(s, (builder as (v: unknown) => Record<string, unknown>)(parsed.data));
      }
    }
  }

  // Powertrains reference the above, so they get their own pass.
  for (const path of await walk(join(DATA, 'components', 'powertrains'))) {
    const doc = await readYamlFile(path);
    if (doc == null) continue;
    for (const item of Array.isArray(doc) ? doc : [doc]) {
      const s = (item as { slug?: string }).slug;
      if (!s) { err(rel(path), 'Shared powertrains must declare a slug'); continue; }
      const parsed = PowertrainSchema.safeParse(item);
      if (!parsed.success) { reportZod(rel(path), parsed.error); continue; }
      internPowertrain(parsed.data, rel(path), s);
    }
  }

  // =========================================================================
  // Phase 3 -- vehicles
  // =========================================================================

  for (const path of await walk(join(DATA, 'vehicles'))) {
    stats.files++;
    const doc = await readYamlFile(path);
    if (doc == null) continue;
    const parsed = VehicleFileSchema.safeParse(doc);
    if (!parsed.success) { reportZod(rel(path), parsed.error); continue; }
    loadVehicleFile(parsed.data, rel(path));
  }

  // =========================================================================
  // Phase 4 -- derived tables
  // =========================================================================

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;

  if (errorCount === 0 && !opts.validateOnly) {
    buildSearchIndex(db, featureBits);
    db.exec('PRAGMA foreign_keys = ON');
    const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
    if (fkIssues.length) err('<database>', `${fkIssues.length} foreign key violations after load`);
    db.exec('ANALYZE');
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('VACUUM');
  }

  db.close();
  printDiagnostics();

  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  const finalErrors = diagnostics.filter((d) => d.severity === 'error').length;

  if (finalErrors > 0) {
    console.error(`\n  Build FAILED with ${finalErrors} error(s) in ${elapsed}s`);
    return 1;
  }

  if (opts.validateOnly) {
    console.log(`\n  Validated ${stats.files} data files, ${stats.variants} variants. No errors. (${elapsed}s)`);
    return 0;
  }

  const size = existsSync(OUT_DB) ? (await stat(OUT_DB)).size : 0;
  console.log(
    `\n  ${stats.variants} variants / ${stats.trims} trims / ${stats.generations} generations / ${stats.makes} makes\n` +
      `  ${stats.engines} engines, ${stats.powertrains} powertrains, ${stats.features} features in catalog\n` +
      `  ${stats.files} vehicle files -> ${(size / 1024).toFixed(0)} KB in ${elapsed}s\n` +
      `  Output: ${rel(OUT_DB)}`,
  );
  return 0;

  // =========================================================================
  // Catalog loaders
  // =========================================================================

  async function loadBodyStyles() {
    const path = join(DATA, 'body-styles.yaml');
    if (!existsSync(path)) { err('data/body-styles.yaml', 'Missing required catalog file'); return; }
    const parsed = BodyStyleFileSchema.safeParse(await readYamlFile(path));
    if (!parsed.success) { reportZod(rel(path), parsed.error); return; }

    for (const b of parsed.data.body_styles) {
      const category_code = ENUM_REGISTRY.body_category.code(b.category);
      const roof_code = ENUM_REGISTRY.roof_type.code(b.roof);
      if (category_code === null) { err(rel(path), `Unknown body category "${b.category}"`, b.slug); continue; }
      if (roof_code === null) { err(rel(path), `Unknown roof type "${b.roof}"`, b.slug); continue; }
      bodyStyleIds.set(
        b.slug,
        insert('body_style', {
          slug: b.slug, name: b.name, category_code, roof_code, doors: b.doors,
          cab_code: b.cab ? ENUM_REGISTRY.cab_style.code(b.cab) : null,
          bed_length_in: b.bed_length_in, seat_rows: b.seat_rows, notes: b.notes,
        }),
      );
    }
  }

  async function loadFeatures() {
    const path = join(DATA, 'features.yaml');
    if (!existsSync(path)) { err('data/features.yaml', 'Missing required catalog file'); return; }
    const parsed = FeatureCatalogSchema.safeParse(await readYamlFile(path));
    if (!parsed.success) { reportZod(rel(path), parsed.error); return; }

    const usedBits = new Map<number, string>();
    for (const f of parsed.data.features) {
      const category_code = ENUM_REGISTRY.feature_category.code(f.category);
      if (category_code === null) { err(rel(path), `Unknown feature category "${f.category}"`, f.slug); continue; }
      featureIds.set(
        f.slug,
        insert('feature', {
          slug: f.slug, name: f.name, category_code, description: f.description,
          value_type: f.value_type, value_unit: f.value_unit,
          value_options_json: f.value_options ? JSON.stringify(f.value_options) : null,
          parent_id: null, aliases_json: JSON.stringify(f.aliases ?? []),
          is_common: f.is_common ? 1 : 0, first_seen_year: f.first_seen_year,
        }),
      );
      featureValueTypes.set(f.slug, f.value_type);

      if (f.search_bit !== undefined) {
        const clash = usedBits.get(f.search_bit);
        if (clash) {
          err(rel(path), `search_bit ${f.search_bit} is claimed by both "${clash}" and "${f.slug}". Bits are unique and never reused.`);
        } else {
          usedBits.set(f.search_bit, f.slug);
          featureBits.set(f.slug, f.search_bit);
        }
      }
      stats.features++;
    }

    // Second pass so a parent may be declared after its child.
    const setParent = db.prepare('UPDATE feature SET parent_id = ? WHERE slug = ?');
    for (const f of parsed.data.features) {
      if (!f.parent) continue;
      const pid = featureIds.get(f.parent);
      if (pid === undefined) err(rel(path), `Feature "${f.slug}" references unknown parent "${f.parent}"`);
      else setParent.run(pid, f.slug);
    }
  }

  async function loadMakes() {
    for (const path of await walk(join(DATA, 'makes'))) {
      const parsed = MakeFileSchema.safeParse(await readYamlFile(path));
      if (!parsed.success) { reportZod(rel(path), parsed.error); continue; }
      const m = parsed.data;
      makeIds.set(m.slug, insert('make', {
        slug: m.slug, name: m.name, country_code: m.country_code,
        founded_year: m.founded_year, defunct_year: m.defunct_year,
        wikidata_id: m.wikidata_id, notes: m.notes,
      }));
      stats.makes++;
    }
  }

  // =========================================================================
  // Component row builders
  // =========================================================================

  function reportZod(file: string, error: { issues: { path: (string | number)[]; message: string }[] }) {
    for (const issue of error.issues.slice(0, 25)) {
      err(file, issue.message, issue.path.join('.'));
    }
    if (error.issues.length > 25) err(file, `... and ${error.issues.length - 25} more validation errors`);
  }

  // NOTE: every builder below takes ALREADY-VALIDATED input. Zod has run, and
  // has replaced enum slugs with numeric codes and unit-suffixed strings with
  // canonical numbers. Do not re-parse here -- see Interner.resolve.

  function buildEngineRow(e: Engine): Record<string, unknown> {
    stats.engines++;
    return {
      code: e.code, name: e.name ?? e.code ?? 'Unnamed engine', family: e.family,
      cylinders: e.cylinders, layout_code: e.layout, vee_angle_deg: e.vee_angle_deg,
      // measure('volume') yields litres; engine displacement is stored in cc.
      displacement_cc: e.displacement != null ? Math.round(e.displacement * 1000) : null,
      valves_per_cylinder: e.valves_per_cylinder,
      // Derive total valves when only the per-cylinder count is given -- a
      // trivially inferable field contributors constantly leave blank, and one
      // people filter on directly ("24v flat-6").
      valves_total:
        e.valves_total ??
        (e.valves_per_cylinder != null && e.cylinders != null
          ? e.valves_per_cylinder * e.cylinders
          : null),
      cam_config_code: e.cam_config, cam_count: e.cam_count,
      bore_mm: e.bore, stroke_mm: e.stroke,
      compression_ratio: e.compression_ratio, compression_ratio_max: e.compression_ratio_max,
      aspiration_code: e.aspiration, forced_induction_count: e.forced_induction_count,
      intercooled: bit(e.intercooled), charge_cooling: e.charge_cooling, max_boost_psi: e.max_boost,
      fuel_type_code: e.fuel_type, fuel_delivery_code: e.fuel_delivery, min_octane_ron: e.min_octane_ron,
      block_material: e.block_material, head_material: e.head_material, liner_type: e.liner_type,
      redline_rpm: e.redline_rpm, fuel_cutoff_rpm: e.fuel_cutoff_rpm, firing_order: e.firing_order,
      dry_weight_kg: e.dry_weight, oil_capacity_l: e.oil_capacity,
      variable_valve_timing: bit(e.variable_valve_timing),
      variable_valve_lift: bit(e.variable_valve_lift),
      cylinder_deactivation: bit(e.cylinder_deactivation),
      dry_sump: bit(e.dry_sump), start_stop: bit(e.start_stop),
      individual_throttle_bodies: bit(e.individual_throttle_bodies),
      production_start_year: e.production_start_year, production_end_year: e.production_end_year,
      notes: e.notes,
    };
  }

  function buildTransmissionRow(t: Transmission): Record<string, unknown> {
    return {
      code: t.code, name: t.name ?? t.code ?? 'Unnamed transmission', type_code: t.type,
      forward_gears: t.forward_gears, clutch_type: t.clutch_type,
      paddle_shifters: bit(t.paddle_shifters),
      gear_ratios_json: t.gear_ratios ? JSON.stringify(t.gear_ratios) : null,
      final_drive_ratio: t.final_drive_ratio,
      max_torque_nm: t.max_torque != null ? t.max_torque / 0.73756215 : null,
      weight_kg: t.weight, notes: t.notes,
    };
  }

  function buildDrivetrainRow(d: Drivetrain): Record<string, unknown> {
    return {
      name: d.name ?? 'Unnamed drivetrain', type_code: d.type, marketing_name: d.marketing_name,
      transfer_case: d.transfer_case, has_low_range: bit(d.has_low_range),
      low_range_ratio: d.low_range_ratio, front_diff_type: d.front_diff_type,
      center_diff_type: d.center_diff_type, rear_diff_type: d.rear_diff_type,
      front_locker: bit(d.front_locker), rear_locker: bit(d.rear_locker),
      default_front_torque_pct: d.default_front_torque_pct,
      max_front_torque_pct: d.max_front_torque_pct, max_rear_torque_pct: d.max_rear_torque_pct,
      torque_vectoring: bit(d.torque_vectoring), disconnect_capable: bit(d.disconnect_capable),
      notes: d.notes,
    };
  }

  function buildMotorRow(m: ElectricMotor): Record<string, unknown> {
    return {
      code: m.code, name: m.name ?? 'Electric motor', motor_type_code: m.type,
      peak_power_kw: m.peak_power_kw, continuous_power_kw: m.continuous_power_kw,
      peak_torque_nm: m.peak_torque_nm, max_rpm: m.max_rpm,
      voltage_nominal: m.voltage_nominal, cooling: m.cooling, weight_kg: m.weight,
    };
  }

  function buildBatteryRow(b: Battery): Record<string, unknown> {
    return {
      name: b.name ?? 'Battery pack', chemistry_code: b.chemistry, cell_supplier: b.cell_supplier,
      cell_format: b.cell_format, capacity_gross_kwh: b.capacity_gross_kwh,
      capacity_net_kwh: b.capacity_net_kwh, nominal_voltage: b.nominal_voltage,
      architecture_volts: b.architecture_volts, module_count: b.module_count,
      cell_count: b.cell_count, weight_kg: b.weight, max_dc_charge_kw: b.max_dc_charge_kw,
      max_ac_charge_kw: b.max_ac_charge_kw, thermal_management: b.thermal_management,
      warranty_years: b.warranty_years, warranty_miles: b.warranty_miles,
    };
  }

  /** `pt` is already validated -- see the note on Interner.resolve. */
  function internPowertrain(
    value: string | Powertrain,
    file: string,
    context: string,
  ): number | null {
    if (typeof value === 'string') {
      const id = powertrains.get(value);
      if (id === undefined) { err(file, `Unknown powertrain "${value}" referenced by ${context}`); return null; }
      return id;
    }

    const pt = value;
    const key = pt.slug ?? `powertrain-${hashOf(value)}`;
    const existing = powertrains.get(key);
    if (existing !== undefined) return existing;

    const engineId = pt.engine ? engines.resolve(pt.engine, context, file, buildEngineRow) : null;
    const transId = pt.transmission
      ? transmissions.resolve(pt.transmission, context, file, buildTransmissionRow)
      : null;
    const driveId = drivetrains.resolve(pt.drivetrain, context, file, buildDrivetrainRow);
    if (driveId === null) { err(file, `Powertrain "${context}" needs a valid drivetrain`); return null; }

    const frontMotorId = pt.front_motor ? motors.resolve(pt.front_motor, context, file, buildMotorRow) : null;
    const rearMotorId = pt.rear_motor ? motors.resolve(pt.rear_motor, context, file, buildMotorRow) : null;
    const batteryId = pt.battery ? batteries.resolve(pt.battery, context, file, buildBatteryRow) : null;

    stats.powertrains++;
    return powertrains.define(key, {
      name: pt.name, engine_id: engineId, engine_count: 1, transmission_id: transId,
      drivetrain_id: driveId, placement_code: pt.placement,
      hybrid_type_code: pt.hybrid_type ?? 801,
      front_motor_id: frontMotorId, front_motor_count: pt.front_motor_count ?? (frontMotorId ? 1 : 0),
      rear_motor_id: rearMotorId, rear_motor_count: pt.rear_motor_count ?? (rearMotorId ? 1 : 0),
      battery_pack_id: batteryId,
      combined_hp: pt.horsepower, combined_torque_lbft: pt.torque,
      engine_hp: pt.engine_horsepower, engine_torque_lbft: pt.engine_torque,
      electric_hp: pt.electric_horsepower, electric_torque_lbft: pt.electric_torque,
      power_peak_rpm: pt.power_peak_rpm, power_peak_rpm_high: pt.power_peak_rpm_high,
      torque_peak_rpm: pt.torque_peak_rpm, torque_peak_rpm_high: pt.torque_peak_rpm_high,
      power_standard_code: pt.power_standard, notes: pt.notes,
    });
  }

  // =========================================================================
  // Vehicle loader
  // =========================================================================

  function loadVehicleFile(v: VehicleFile, file: string) {
    const makeId = makeIds.get(v.make);
    if (makeId === undefined) {
      err(file, `Unknown make "${v.make}". Add data/makes/${v.make}.yaml first.`);
      return;
    }

    const marketCode = Market.code(v.market);
    if (marketCode === null) { err(file, `Unknown market "${v.market}"`); return; }

    const modelKey = `${v.make}/${v.model}`;
    let modelId = modelIds.get(modelKey);
    if (modelId === undefined) {
      modelId = insert('model', {
        make_id: makeId, slug: v.model, name: v.model_name ?? titleize(v.model),
        aliases_json: '[]', first_year: v.generation.start_year, last_year: v.generation.end_year,
      });
      modelIds.set(modelKey, modelId);
      stats.models++;
    }

    const genKey = `${modelKey}/${v.generation.slug}`;
    let genId = generationIds.get(genKey);
    if (genId === undefined) {
      genId = insert('generation', {
        model_id: modelId, slug: v.generation.slug, code: v.generation.code,
        name: v.generation.name, ordinal: v.generation.ordinal,
        start_year: v.generation.start_year, end_year: v.generation.end_year,
        platform: v.generation.platform, designer: v.generation.designer,
      });
      generationIds.set(genKey, genId);
      stats.generations++;
    }

    // The year must fall inside the generation it claims -- a cheap check that
    // catches the copy-paste error where someone duplicates last year's file
    // and forgets to bump the generation.
    if (v.year < v.generation.start_year || (v.generation.end_year && v.year > v.generation.end_year)) {
      warn(file, `Model year ${v.year} is outside generation ${v.generation.slug} (${v.generation.start_year}-${v.generation.end_year ?? 'present'})`);
    }

    const modelYearId = insert('model_year', {
      generation_id: genId, year: v.year, market_code: marketCode, release_date: v.release_date,
    });

    for (const t of v.trims) {
      const trimId = insert('trim', {
        model_year_id: modelYearId, slug: t.slug, name: t.name, ordinal: t.ordinal,
        oem_code: t.oem_code, is_special_edition: bit(t.is_special_edition) ?? 0,
        production_count: t.production_count, notes: t.notes,
      });
      stats.trims++;

      const packageIds = new Map<string, number>();
      for (const pkg of t.packages ?? []) {
        packageIds.set(pkg.slug, insert('option_package', {
          trim_id: trimId, code: pkg.code, name: pkg.name,
          price_minor: pkg.price != null ? Math.round(pkg.price * 100) : null,
          currency: pkg.currency ?? 'USD', description: pkg.description,
        }));
      }

      for (const variant of t.variants) {
        const bodyId = bodyStyleIds.get(variant.body);
        if (bodyId === undefined) {
          err(file, `Unknown body style "${variant.body}"`, `${t.slug}/${variant.slug}`);
          continue;
        }
        const ptId = internPowertrain(variant.powertrain, file, `${t.slug}/${variant.slug}`);
        if (ptId === null) continue;

        const variantId = insert('variant', {
          trim_id: trimId,
          spec_key: hashOf({
            make: v.make, model: v.model, gen: v.generation.slug, year: v.year,
            market: v.market, trim: t.slug, variant: variant.slug,
          }),
          slug: variant.slug, name: variant.name, body_style_id: bodyId, powertrain_id: ptId,
          msrp_minor: variant.msrp != null ? Math.round(variant.msrp * 100) : null,
          msrp_currency: variant.currency ?? 'USD',
          destination_minor: variant.destination != null ? Math.round(variant.destination * 100) : null,
          price_as_of: variant.price_as_of, production_count: variant.production_count,
          confidence_code: variant.confidence ?? Confidence.code('community'),
          notes: variant.notes,
        });
        stats.variants++;

        // Trim defaults merge under variant values, one level deep. Deep
        // merging would let a default silently reappear inside a block the
        // variant meant to replace wholesale.
        const d = t.defaults ?? {};
        writeSpec('spec_exterior', variantId, mapExterior({ ...(d.exterior ?? {}), ...(variant.exterior ?? {}) }));
        writeSpec('spec_interior', variantId, mapInterior({ ...(d.interior ?? {}), ...(variant.interior ?? {}) }));
        writeSpec('spec_chassis', variantId, mapChassis({ ...(d.chassis ?? {}), ...(variant.chassis ?? {}) }));
        writeSpec('spec_capacity', variantId, mapCapacity({ ...(d.capacity ?? {}), ...(variant.capacity ?? {}) }));
        if (variant.performance) writeSpec('spec_performance', variantId, mapPerformance(variant.performance));

        for (const eff of variant.efficiency ?? []) {
          insert('spec_efficiency', {
            variant_id: variantId, cycle_code: eff.cycle ?? 1141,
            mpg_city: eff.mpg_city, mpg_highway: eff.mpg_highway, mpg_combined: eff.mpg_combined,
            l_per_100km_combined: eff.l_per_100km_combined,
            mpge_city: eff.mpge_city, mpge_highway: eff.mpge_highway, mpge_combined: eff.mpge_combined,
            kwh_per_100mi: eff.kwh_per_100mi,
            // measure('length') gives mm; range is stored in miles.
            electric_range_mi: eff.electric_range != null ? eff.electric_range / 1_609_344 : null,
            total_range_mi: eff.total_range != null ? eff.total_range / 1_609_344 : null,
            fuel_tank_l: eff.fuel_tank, co2_g_per_km: eff.co2_g_per_km,
            emissions_standard: eff.emissions_standard,
            dc_charge_10_80_min: eff.dc_charge_10_80_min, dc_peak_kw: eff.dc_peak_kw,
            ac_charge_0_100_h: eff.ac_charge_0_100_h, ac_onboard_kw: eff.ac_onboard_kw,
            charge_port: eff.charge_port, v2l_kw: eff.v2l_kw,
          }, 'replace');
        }

        const features = { ...(d.features ?? {}), ...(variant.features ?? {}) };
        for (const [featSlug, raw] of Object.entries(features)) {
          const featureId = featureIds.get(featSlug);
          if (featureId === undefined) {
            err(file, `Unknown feature "${featSlug}". Add it to data/features.yaml first.`, `${t.slug}/${variant.slug}`);
            continue;
          }
          const spec = typeof raw === 'string' ? { availability: raw } : raw;
          const availCode = Availability.code(spec.availability);
          if (availCode === null) {
            err(file, `Unknown availability "${spec.availability}" for "${featSlug}"`, `${t.slug}/${variant.slug}`);
            continue;
          }
          const valueType = featureValueTypes.get(featSlug) ?? 'bool';
          const value = 'value' in spec ? spec.value : undefined;
          insert('variant_feature', {
            variant_id: variantId, feature_id: featureId, availability_code: availCode,
            value_num: valueType === 'number' && typeof value === 'number' ? value : null,
            value_text: valueType !== 'number' && value !== undefined ? String(value) : null,
            package_id: 'package' in spec && spec.package ? packageIds.get(spec.package) ?? null : null,
            price_minor: 'price' in spec && spec.price != null ? Math.round(spec.price * 100) : null,
            currency: ('currency' in spec ? spec.currency : null) ?? 'USD',
            confidence_code: ('confidence' in spec ? spec.confidence : null) ?? null,
          }, 'replace');
        }
      }
    }
  }

  function writeSpec(table: string, variantId: number, values: Record<string, unknown>) {
    insert(table, { ...values, variant_id: variantId }, 'replace');
  }
}

// ---------------------------------------------------------------------------
// Spec mappers: contribution field name -> database column
// ---------------------------------------------------------------------------

const bit = (v: boolean | undefined | null): number | null => (v == null ? null : v ? 1 : 0);
const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function mapExterior(e: Record<string, unknown>): Record<string, unknown> {
  const turning = n(e.turning_circle_curb);
  return {
    length_mm: e.length, width_mm: e.width, width_mirrors_mm: e.width_mirrors,
    height_mm: e.height, wheelbase_mm: e.wheelbase,
    track_front_mm: e.track_front, track_rear_mm: e.track_rear,
    ground_clearance_mm: e.ground_clearance,
    ground_clearance_min_mm: e.ground_clearance_min, ground_clearance_max_mm: e.ground_clearance_max,
    approach_angle_deg: e.approach_angle, departure_angle_deg: e.departure_angle,
    breakover_angle_deg: e.breakover_angle, wading_depth_mm: e.wading_depth,
    curb_weight_kg: e.curb_weight, curb_weight_min_kg: e.curb_weight_min,
    curb_weight_max_kg: e.curb_weight_max, gvwr_kg: e.gvwr,
    weight_dist_front_pct: e.weight_dist_front_pct, drag_coefficient: e.drag_coefficient,
    frontal_area_m2: e.frontal_area_m2, cda_m2: e.cda_m2,
    downforce_at_speed_kg: e.downforce_at_speed, downforce_speed_kph: e.downforce_speed,
    turning_circle_curb_m: turning != null ? turning / 1000 : null,
    notes: e.notes,
  };
}

function mapInterior(i: Record<string, unknown>): Record<string, unknown> {
  return {
    seating_capacity: i.seating_capacity, seating_capacity_max: i.seating_capacity_max,
    seat_rows: i.seat_rows, seating_config: i.seating_config,
    headroom_front_mm: i.headroom_front, headroom_front_sunroof_mm: i.headroom_front_sunroof,
    headroom_second_mm: i.headroom_second, headroom_third_mm: i.headroom_third,
    legroom_front_mm: i.legroom_front, legroom_second_mm: i.legroom_second,
    legroom_third_mm: i.legroom_third,
    shoulder_room_front_mm: i.shoulder_room_front, shoulder_room_second_mm: i.shoulder_room_second,
    hip_room_front_mm: i.hip_room_front, hip_room_second_mm: i.hip_room_second,
    seat_height_front_mm: i.seat_height_front, seat_height_second_mm: i.seat_height_second,
    seat_height_adjust_range_mm: i.seat_height_adjust_range, step_in_height_mm: i.step_in_height,
    passenger_volume_l: i.passenger_volume,
    cargo_behind_first_l: i.cargo_behind_first, cargo_behind_second_l: i.cargo_behind_second,
    cargo_behind_third_l: i.cargo_behind_third, cargo_frunk_l: i.cargo_frunk, cargo_max_l: i.cargo_max,
    cargo_load_length_mm: i.cargo_load_length,
    cargo_width_between_arches_mm: i.cargo_width_between_arches,
    liftover_height_mm: i.liftover_height,
    bed_length_mm: i.bed_length, bed_width_mm: i.bed_width, bed_depth_mm: i.bed_depth,
    bed_volume_l: i.bed_volume, notes: i.notes,
  };
}

function mapPerformance(p: Record<string, unknown>): Record<string, unknown> {
  const trap = n(p.quarter_mile_trap);
  const b60 = n(p.braking_60_0);
  const b70 = n(p.braking_70_0);
  return {
    zero_to_60_mph_s: p.zero_to_60_mph, zero_to_100_kph_s: p.zero_to_100_kph,
    zero_to_100_mph_s: p.zero_to_100_mph, zero_to_60_rollout_s: p.zero_to_60_rollout,
    quarter_mile_s: p.quarter_mile,
    quarter_mile_trap_mph: trap != null ? trap / 1.609344 : null,
    top_speed_kph: p.top_speed, top_speed_limited: bit(p.top_speed_limited as boolean),
    braking_60_0_ft: b60 != null ? b60 / 304.8 : null,
    braking_70_0_ft: b70 != null ? b70 / 304.8 : null,
    lateral_g: p.lateral_g, slalom_mph: p.slalom_mph, figure_eight_s: p.figure_eight,
    nurburgring_date: p.nurburgring_date, is_measured: bit(p.measured as boolean),
    measured_by: p.measured_by, notes: p.notes,
  };
}

function mapCapacity(c: Record<string, unknown>): Record<string, unknown> {
  return {
    payload_kg: c.payload, towing_braked_kg: c.towing_braked,
    towing_unbraked_kg: c.towing_unbraked, towing_max_kg: c.towing_max ?? c.towing_braked,
    tongue_weight_kg: c.tongue_weight, gcwr_kg: c.gcwr, roof_load_kg: c.roof_load,
    hitch_receiver_in: c.hitch_receiver_in,
    fifth_wheel_capable: bit(c.fifth_wheel_capable as boolean),
  };
}

function mapChassis(c: Record<string, unknown>): Record<string, unknown> {
  return {
    suspension_front_code: c.suspension_front, suspension_rear_code: c.suspension_rear,
    spring_type_front: c.spring_type_front, spring_type_rear: c.spring_type_rear,
    adaptive_dampers: bit(c.adaptive_dampers as boolean), damper_brand: c.damper_brand,
    active_anti_roll: bit(c.active_anti_roll as boolean),
    ride_height_adjustable: bit(c.ride_height_adjustable as boolean),
    steering_type_code: c.steering_type, steering_ratio: c.steering_ratio,
    turns_lock_to_lock: c.turns_lock_to_lock,
    rear_wheel_steering: bit(c.rear_wheel_steering as boolean),
    brake_front_code: c.brake_front, brake_rear_code: c.brake_rear,
    brake_front_dia_mm: c.brake_front_dia, brake_rear_dia_mm: c.brake_rear_dia,
    brake_front_pistons: c.brake_front_pistons, brake_rear_pistons: c.brake_rear_pistons,
    brake_caliper_brand: c.brake_caliper_brand,
    wheel_front_dia_in: c.wheel_front_dia_in, wheel_front_width_in: c.wheel_front_width_in,
    wheel_rear_dia_in: c.wheel_rear_dia_in, wheel_rear_width_in: c.wheel_rear_width_in,
    wheel_material: c.wheel_material, tire_front: c.tire_front, tire_rear: c.tire_rear,
    tire_brand_oem: c.tire_brand_oem, spare_type: c.spare_type,
    chassis_construction: c.chassis_construction, body_material: c.body_material,
  };
}

const titleize = (s: string) =>
  s.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

/** Columns scored for the completeness percentage and the help-wanted list. */
const SCORED_COLUMNS = [
  'combined_hp', 'combined_torque_lbft', 'curb_weight_kg', 'length_mm', 'width_mm',
  'height_mm', 'wheelbase_mm', 'seating_capacity', 'cargo_behind_second_l',
  'legroom_front_mm', 'headroom_front_mm', 'zero_to_60_mph_s', 'top_speed_kph',
  'mpg_combined', 'displacement_cc', 'cylinders', 'transmission_type_code',
  'drivetrain_type_code', 'msrp_minor', 'ground_clearance_mm',
];

function buildSearchIndex(db: DatabaseSync, featureBits: Map<string, number>) {
  // A single INSERT..SELECT beats row-by-row by a wide margin and keeps the
  // whole projection readable in one place. Efficiency joins the EPA row
  // specifically -- see the note in 0006_search_index.sql.
  db.exec(`
    INSERT INTO variant_search (
      variant_id, make_id, model_id, generation_id, trim_id, year, market_code,
      body_category_code, roof_code, cab_code, doors, seat_rows, seating_capacity, seating_capacity_max,
      engine_id, cylinders, engine_layout_code, displacement_cc, valves_total, valves_per_cylinder,
      cam_config_code, aspiration_code, fuel_type_code, fuel_delivery_code, compression_ratio, redline_rpm,
      hybrid_type_code, motor_count, battery_net_kwh, battery_architecture_volts,
      transmission_type_code, forward_gears, drivetrain_type_code, has_low_range, rear_locker,
      combined_hp, combined_torque_lbft, power_peak_rpm, hp_per_liter, hp_per_tonne,
      length_mm, width_mm, height_mm, wheelbase_mm, ground_clearance_mm, curb_weight_kg,
      drag_coefficient, approach_angle_deg, departure_angle_deg,
      seat_height_front_mm, headroom_front_mm, legroom_front_mm, legroom_second_mm, legroom_third_mm,
      passenger_volume_l, cargo_behind_first_l, cargo_behind_second_l, cargo_behind_third_l, cargo_frunk_l,
      zero_to_60_mph_s, quarter_mile_s, top_speed_kph, braking_60_0_ft, lateral_g,
      mpg_combined, mpge_combined, electric_range_mi, total_range_mi,
      towing_max_kg, payload_kg, msrp_minor, msrp_currency, confidence_code
    )
    SELECT
      v.id, mk.id, mo.id, g.id, t.id, my.year, my.market_code,
      bs.category_code, bs.roof_code, bs.cab_code, bs.doors,
      COALESCE(si.seat_rows, bs.seat_rows), si.seating_capacity, si.seating_capacity_max,
      e.id, e.cylinders, e.layout_code, e.displacement_cc, e.valves_total, e.valves_per_cylinder,
      e.cam_config_code, e.aspiration_code,
      COALESCE(e.fuel_type_code, CASE WHEN p.hybrid_type_code = 807 THEN 604 END),
      e.fuel_delivery_code, e.compression_ratio, e.redline_rpm,
      p.hybrid_type_code,
      COALESCE(p.front_motor_count,0) + COALESCE(p.rear_motor_count,0),
      bp.capacity_net_kwh, bp.architecture_volts,
      tr.type_code, tr.forward_gears, dt.type_code, dt.has_low_range, dt.rear_locker,
      p.combined_hp, p.combined_torque_lbft, p.power_peak_rpm,
      CASE WHEN e.displacement_cc > 0 AND p.combined_hp IS NOT NULL
           THEN p.combined_hp / (e.displacement_cc / 1000.0) END,
      CASE WHEN se.curb_weight_kg > 0 AND p.combined_hp IS NOT NULL
           THEN p.combined_hp / (se.curb_weight_kg / 1000.0) END,
      se.length_mm, se.width_mm, se.height_mm, se.wheelbase_mm, se.ground_clearance_mm, se.curb_weight_kg,
      se.drag_coefficient, se.approach_angle_deg, se.departure_angle_deg,
      si.seat_height_front_mm, si.headroom_front_mm, si.legroom_front_mm, si.legroom_second_mm, si.legroom_third_mm,
      si.passenger_volume_l, si.cargo_behind_first_l, si.cargo_behind_second_l, si.cargo_behind_third_l, si.cargo_frunk_l,
      sp.zero_to_60_mph_s, sp.quarter_mile_s, sp.top_speed_kph, sp.braking_60_0_ft, sp.lateral_g,
      ef.mpg_combined, ef.mpge_combined, ef.electric_range_mi, ef.total_range_mi,
      sc.towing_max_kg, sc.payload_kg, v.msrp_minor, v.msrp_currency, v.confidence_code
    FROM variant v
    JOIN trim t            ON t.id = v.trim_id
    JOIN model_year my     ON my.id = t.model_year_id
    JOIN generation g      ON g.id = my.generation_id
    JOIN model mo          ON mo.id = g.model_id
    JOIN make mk           ON mk.id = mo.make_id
    JOIN body_style bs     ON bs.id = v.body_style_id
    JOIN powertrain p      ON p.id = v.powertrain_id
    LEFT JOIN engine e            ON e.id = p.engine_id
    LEFT JOIN transmission tr     ON tr.id = p.transmission_id
    LEFT JOIN drivetrain dt       ON dt.id = p.drivetrain_id
    LEFT JOIN battery_pack bp     ON bp.id = p.battery_pack_id
    LEFT JOIN spec_exterior se    ON se.variant_id = v.id
    LEFT JOIN spec_interior si    ON si.variant_id = v.id
    LEFT JOIN spec_performance sp ON sp.variant_id = v.id
    LEFT JOIN spec_capacity sc    ON sc.variant_id = v.id
    LEFT JOIN spec_efficiency ef  ON ef.variant_id = v.id AND ef.cycle_code = 1141
  `);

  buildFeatureBitmask(db, featureBits);

  db.exec(`
    UPDATE variant_search SET completeness = (
      ${SCORED_COLUMNS.map((c) => `(CASE WHEN ${c} IS NOT NULL THEN 1 ELSE 0 END)`).join(' + ')}
    ) * 100 / ${SCORED_COLUMNS.length}
  `);

  buildDisplayProjection(db);

  const FACETS = [
    'body_category_code', 'roof_code', 'engine_layout_code', 'aspiration_code',
    'fuel_type_code', 'hybrid_type_code', 'transmission_type_code',
    'drivetrain_type_code', 'cylinders', 'doors', 'seating_capacity', 'year', 'make_id',
  ];
  for (const f of FACETS) {
    db.exec(`INSERT INTO facet_count (facet, value_code, count)
             SELECT '${f}', ${f}, COUNT(*) FROM variant_search
             WHERE ${f} IS NOT NULL GROUP BY ${f}`);
  }

  for (const col of SCORED_COLUMNS) {
    db.exec(`INSERT OR IGNORE INTO data_gap (variant_id, table_name, column_name, priority)
             SELECT variant_id, 'variant_search', '${col}',
                    CASE WHEN year >= 2015 THEN 100 ELSE 50 END + completeness
             FROM variant_search WHERE ${col} IS NULL`);
  }
}

/**
 * Pack the bit-reserved features into the index.
 *
 * Two accumulations: "available at all" and "standard only", so both "offers
 * massage seats" and "has massage seats as standard" are answerable without a
 * join. SQLite integers are signed 64-bit, so bit 63 lands on the sign bit --
 * harmless, because the query path only ever AND-masks these.
 */
function buildFeatureBitmask(db: DatabaseSync, featureBits: Map<string, number>) {
  if (featureBits.size === 0) return;

  const AVAILABLE = new Set([1121, 1122, 1123, 1124, 1125]); // anything a buyer can get
  const STANDARD = 1121;

  const rows = db.prepare(
    `SELECT vf.variant_id AS vid, f.slug AS slug, vf.availability_code AS avail
       FROM variant_feature vf JOIN feature f ON f.id = vf.feature_id`,
  ).all() as { vid: number; slug: string; avail: number }[];

  const acc = new Map<number, [bigint, bigint, bigint, bigint]>();
  for (const r of rows) {
    const bitPos = featureBits.get(r.slug);
    if (bitPos === undefined || !AVAILABLE.has(r.avail)) continue;
    const hi = bitPos >= 64;
    const mask = 1n << BigInt(hi ? bitPos - 64 : bitPos);
    const cur = acc.get(r.vid) ?? [0n, 0n, 0n, 0n];
    if (hi) cur[1] |= mask; else cur[0] |= mask;
    if (r.avail === STANDARD) { if (hi) cur[3] |= mask; else cur[2] |= mask; }
    acc.set(r.vid, cur);
  }

  const update = db.prepare(
    `UPDATE variant_search
        SET feat_lo = ?, feat_hi = ?, feat_std_lo = ?, feat_std_hi = ?
      WHERE variant_id = ?`,
  );
  transaction(db, () => {
    for (const [vid, [lo, hi, slo, shi]] of acc) {
      update.run(
        BigInt.asIntN(64, lo), BigInt.asIntN(64, hi),
        BigInt.asIntN(64, slo), BigInt.asIntN(64, shi), vid,
      );
    }
  });
}

function buildDisplayProjection(db: DatabaseSync) {
  db.exec(`
    INSERT INTO variant_display (
      variant_id, make_name, make_slug, model_name, model_slug, generation_code,
      year, trim_name, variant_name, full_name, body_name, engine_summary,
      drivetrain_summary, url_path, spec_key
    )
    SELECT
      v.id, mk.name, mk.slug, mo.name, mo.slug, g.code, my.year, t.name, v.name,
      my.year || ' ' || mk.name || ' ' || mo.name ||
        CASE WHEN COALESCE(t.name,'') <> '' THEN ' ' || t.name ELSE '' END ||
        CASE WHEN COALESCE(v.name,'') <> '' THEN ' ' || v.name ELSE '' END,
      bs.name,
      NULLIF(TRIM(
        COALESCE(printf('%.1fL ', e.displacement_cc / 1000.0), '') ||
        COALESCE(COALESCE(ea.short, ea.label) || ' ', '') ||
        COALESCE(COALESCE(el.short, el.label) || '-' || e.cylinders, '') ||
        COALESCE(', ' || e.valves_total || 'v', '')
      ), ''),
      NULLIF(TRIM(
        COALESCE(tr.forward_gears || '-speed ', '') || COALESCE(tt.label, '') ||
        COALESCE(', ' || dl.label, '')
      ), ''),
      '/' || mk.slug || '/' || mo.slug || '/' || my.year || '/' || t.slug || '/' || v.slug,
      v.spec_key
    FROM variant v
    JOIN trim t        ON t.id = v.trim_id
    JOIN model_year my ON my.id = t.model_year_id
    JOIN generation g  ON g.id = my.generation_id
    JOIN model mo      ON mo.id = g.model_id
    JOIN make mk       ON mk.id = mo.make_id
    JOIN body_style bs ON bs.id = v.body_style_id
    JOIN powertrain p  ON p.id = v.powertrain_id
    LEFT JOIN engine e        ON e.id = p.engine_id
    LEFT JOIN transmission tr ON tr.id = p.transmission_id
    LEFT JOIN drivetrain dt   ON dt.id = p.drivetrain_id
    LEFT JOIN enum_label ea ON ea.enum_name = 'aspiration'        AND ea.code = e.aspiration_code
    LEFT JOIN enum_label el ON el.enum_name = 'engine_layout'     AND el.code = e.layout_code
    LEFT JOIN enum_label tt ON tt.enum_name = 'transmission_type' AND tt.code = tr.type_code
    LEFT JOIN enum_label dl ON dl.enum_name = 'drivetrain_type'   AND dl.code = dt.type_code
  `);

  db.exec(`INSERT INTO variant_fts(rowid, full_name, make_name, model_name, trim_name, engine_summary)
           SELECT variant_id, full_name, make_name, model_name,
                  COALESCE(trim_name,''), COALESCE(engine_summary,'')
           FROM variant_display`);
}

// ---------------------------------------------------------------------------
// Diagnostics output
// ---------------------------------------------------------------------------

function printDiagnostics() {
  if (diagnostics.length === 0) return;
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }
  console.error('');
  for (const [file, ds] of byFile) {
    console.error(`  ${file}`);
    for (const d of ds) {
      const marker = d.severity === 'error' ? 'error' : 'warn ';
      console.error(`    ${marker}${d.path ? ` at ${d.path}` : ''}: ${d.message}`);
    }
  }
}

// ---------------------------------------------------------------------------

build({ validateOnly: process.argv.includes('--validate-only') })
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\n  ${(e as Error).message}\n`);
    process.exit(1);
  });
