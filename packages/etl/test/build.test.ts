/**
 * End-to-end tests for the CSV loader.
 *
 * These run the real CLI over fixture files rather than importing internals,
 * because the things most likely to break for a contributor are exactly the
 * things a unit test would stub out: how a malformed row is reported, whether
 * a dangling reference is caught, whether the exit code is non-zero so CI
 * actually fails.
 *
 * The production CSVs under data/ are nearly empty, so validating those proves
 * almost nothing -- a loader that accepted no rows at all would pass.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUILD = join(HERE, '..', 'src', 'build.ts');
const FIXTURES = join(HERE, 'fixtures');

/** Run the loader over a data directory. Returns stdout+stderr and exit code. */
function build(dataDir: string): { out: string; code: number } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', BUILD, '--validate-only', `--data=${dataDir}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'allcarsdb-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Copy the good fixtures into a scratch dir, optionally mutating one file. */
function scenario(mutate?: (dir: string) => void): { out: string; code: number } {
  const d = mkdtempSync(join(dir, 'case-'));
  cpSync(FIXTURES, d, { recursive: true });
  mutate?.(d);
  return build(d);
}

describe('a well-formed dataset', () => {
  test('loads and reports what it loaded', () => {
    const { out, code } = scenario();
    assert.equal(code, 0, out);
    assert.match(out, /5 vehicle-years \/ 6 engines \/ 8 pairings/);
    // Eight pairings across five vehicle-years: the junction table is what
    // lets a 911 offer two engines without duplicating the car.
    assert.match(out, /8 searchable combinations/);
  });

  test('a vehicle with no engine paired is still searchable', () => {
    // Search_View is a LEFT JOIN specifically so an incomplete entry stays
    // findable by make/model/year instead of vanishing until someone gets
    // around to recording its engine. This dataset has no such vehicle by
    // default, so the fixture proves the case by adding one.
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Saab,900,1990,\n'),
    );
    assert.equal(code, 0, out);
    assert.match(out, /6 vehicle-years \/ 6 engines \/ 8 pairings/);
    // One more searchable row than pairings: the Saab has no YMM_Engines row
    // at all, yet still produces one row in Search_View with a null engine.
    assert.match(out, /9 searchable combinations/);
  });
});

describe('referential integrity', () => {
  test('a vehicle not in year_make_model.csv is rejected by name', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_engines.csv'), 'Porsche,912,2022,porsche-4.0-na-flat6\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /2022 Porsche 912/);
    assert.match(out, /not in year_make_model\.csv/);
  });

  test('an unknown engine code is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_engines.csv'), 'Ford,F-150,2023,does-not-exist\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /does-not-exist/);
    assert.match(out, /not in engine_specs\.csv/);
  });

  test('the same car and engine listed twice is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_engines.csv'), 'Mazda,MX-5 Miata,2024,mazda-2.0-na-i4\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /already paired/);
  });

  test('a duplicate vehicle-year is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Mazda,MX-5 Miata,2024,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /already listed on line/);
  });

  test('a duplicate engine code is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'engine_specs.csv'),
        'mazda-2.0-na-i4,Inline,4,1998,Naturally Aspirated,Gasoline,13.0:1,Direct Injection\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /already used on line/);
  });

  test('case differences are the same car, not a second one', () => {
    // "porsche" and "Porsche" splitting into two makes would quietly halve
    // every search result, which is worse than an error.
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'porsche,911,2022,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /already listed on line/);
  });
});

describe('malformed input', () => {
  test('a row with too few columns names the file, line and expectation', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_engines.csv'), 'Mazda,MX-5 Miata\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /ymm_engines\.csv:\d+/);
    assert.match(out, /found 2 column\(s\), expected 4/);
  });

  test('a non-numeric year is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Saab,900,nineteen-ninety,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /not a whole number/);
  });

  test('an out-of-range year is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Saab,900,20226,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /above the maximum/);
  });

  test('a renamed column is rejected rather than silently ignored', () => {
    const { out, code } = scenario((d) => {
      const p = join(d, 'year_make_model.csv');
      writeFileSync(p, readFileSync(p, 'utf8').replace('Make,Model,Year', 'Brand,Model,Year'));
    });
    assert.equal(code, 1);
    assert.match(out, /missing column\(s\): Make/);
    assert.match(out, /unexpected column\(s\): Brand/);
  });

  test('a missing file is reported as such', () => {
    const { out, code } = scenario((d) => rmSync(join(d, 'engine_specs.csv')));
    assert.equal(code, 1);
    assert.match(out, /engine_specs\.csv is missing/);
  });
});

describe('spreadsheet quirks', () => {
  test('a UTF-8 BOM does not break the first column', () => {
    // Excel writes one. Left in place it becomes part of the header name, and
    // every row then looks like it is missing a column that is plainly there.
    const { out, code } = scenario((d) => {
      const p = join(d, 'year_make_model.csv');
      writeFileSync(p, '﻿' + readFileSync(p, 'utf8'));
    });
    assert.equal(code, 0, out);
  });

  test('CRLF line endings load cleanly', () => {
    const { out, code } = scenario((d) => {
      for (const f of ['year_make_model.csv', 'engine_specs.csv', 'ymm_engines.csv']) {
        const p = join(d, f);
        writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
      }
    });
    assert.equal(code, 0, out);
  });

  test('a thousands separator in a number is tolerated', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'engine_specs.csv'),
        'test-big-v12,V,12,"6,750",Naturally Aspirated,Gasoline,11.0:1,Port Injection\n',
      ),
    );
    assert.equal(code, 0, out);
    assert.match(out, /7 engines/);
  });

  test('a quoted value containing a comma stays one field', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'engine_specs.csv'),
        'test-quoted,V,8,5000,Supercharged,Gasoline,9.0:1,"Port, then direct"\n',
      ),
    );
    assert.equal(code, 0, out);
    assert.match(out, /7 engines/);
  });
});
