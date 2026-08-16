/**
 * End-to-end tests for the CSV loader.
 *
 * These run the real CLI over fixture files rather than importing internals,
 * because the things most likely to break for a contributor are exactly the
 * things a unit test would stub out: how a malformed row is reported, whether
 * a dangling reference is caught, whether the exit code is non-zero so CI
 * actually fails.
 *
 * The production CSVs under data/ are mostly empty for the newer tables, so
 * validating those proves almost nothing -- a loader that accepted no rows at
 * all would pass just as well.
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
    assert.match(out, /7 vehicle-years \/ 8 powertrains/);
    assert.match(out, /7 engines, 2 motors, 2 batteries/);
    assert.match(out, /10 pairings/);
    assert.match(out, /4 trims \/ 4 builds/);
  });

  test('a vehicle with no powertrain paired is still searchable', () => {
    // Search_View is a LEFT JOIN specifically so an incomplete entry stays
    // findable by make/model/year instead of vanishing until someone gets
    // around to recording its powertrain.
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Saab,900,1990,,,,\n'),
    );
    assert.equal(code, 0, out);
    assert.match(out, /8 vehicle-years/);
    // One more searchable row than pairings: the Saab has no YMM_Powertrains
    // row at all, yet still produces one row in Search_View.
    assert.match(out, /11 searchable combinations/);
  });

  test('builds roll up into per-vehicle capability ranges', () => {
    // Three of the four fixture builds are F-150s, so exactly two vehicles
    // (F-150 and 911) should have a rollup row.
    const { out, code } = scenario();
    assert.equal(code, 0, out);
    assert.match(out, /4 builds \(2 rolled up\)/);
  });
});

describe('referential integrity', () => {
  test('a vehicle not in year_make_model.csv is rejected by name', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_powertrains.csv'), 'Porsche,912,2022,pt-porsche-4.0\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /2022 Porsche 912/);
    assert.match(out, /not in year_make_model\.csv/);
  });

  test('an unknown powertrain ref is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_powertrains.csv'), 'Ford,F-150,2023,does-not-exist\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /does-not-exist/);
    assert.match(out, /not in data\/powertrains\.csv/);
  });

  test('a powertrain naming an unknown engine is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'powertrains.csv'), 'pt-ghost,ICE,no-such-engine,,,,,,,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /no-such-engine/);
    assert.match(out, /not in data\/engine_specs\.csv/);
  });

  test('the same car and powertrain listed twice is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_powertrains.csv'), 'Mazda,MX-5 Miata,2024,pt-mazda-2.0\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /already paired/);
  });

  test('a duplicate vehicle-year is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Mazda,MX-5 Miata,2024,,,,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /already listed on line/);
  });

  test('a duplicate engine ref is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'engine_specs.csv'),
        'mazda-2.0-na-i4,Mazda,PE-VPS,,,Inline,4,1998,Naturally Aspirated,Gasoline,13.0:1,Direct Injection,181,151,,,,,,,\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /already used on line/);
  });

  test('the same engine under a different ref is rejected', () => {
    // Ref uniqueness alone would let the same real engine be entered twice
    // under two different build handles. Manufacturer+Code+Named_Variant+
    // Silent_Variant matching an existing row catches that even though the
    // Refs themselves differ.
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'engine_specs.csv'),
        'mazda-2.0-na-i4-again,Mazda,PE-VPS,,,Inline,4,1998,Naturally Aspirated,Gasoline,13.0:1,Direct Injection,181,151,,,,,,,\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /looks like the same engine as line/);
  });

  test('a build naming a trim the vehicle does not have is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'builds.csv'),
        'b-ghost,Ford,F-150,2023,Platinum,,pt-ford-5.0,,,,,,,,,,,,,,,,,,,,\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /no "Platinum" trim/);
  });

  test('case differences are the same car, not a second one', () => {
    // "porsche" and "Porsche" splitting into two makes would quietly halve
    // every search result, which is worse than an error.
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'porsche,911,2022,,,,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /already listed on line/);
  });
});

describe('facts that contradict themselves', () => {
  test('a BEV powertrain with an engine is rejected', () => {
    // The whole point of the powertrain layer is that a missing engine on an
    // EV is meaningful rather than absent data. A BEV carrying an engine would
    // undo that distinction silently.
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'powertrains.csv'), 'pt-impossible,BEV,ford-5.0-na-v8,,,,,,,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /typed BEV but names an engine/);
  });

  test('usable battery capacity above gross is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'batteries.csv'), 'bat-wrong,NMC,50,60,400,Liquid,Pouch\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /larger than Gross_kWh/);
  });

  test('GVWR below curb weight is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'builds.csv'),
        'b-heavy,Ford,F-150,2023,XL,,pt-ford-5.0,,,,,,,6000,5000,,,,,,,,,,,,\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /below Curb_Weight_lb/);
  });

  test('seats-folded cargo volume below seats-up is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'body_configs.csv'),
        'body-wrong,SUV,4,,,,,110,190,75,70,,,,,,,,40,20,18,2\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /smaller than/);
  });
});

describe('malformed input', () => {
  test('a row with too few columns names the file, line and expectation', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'ymm_powertrains.csv'), 'Mazda,MX-5 Miata\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /ymm_powertrains\.csv:\d+/);
    assert.match(out, /found 2 column\(s\), expected 4/);
  });

  test('a non-numeric year is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Saab,900,nineteen-ninety,,,,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /not a whole number/);
  });

  test('an out-of-range year is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Saab,900,20226,,,,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /above the maximum/);
  });

  test('a non-numeric generation is rejected', () => {
    // Generation is an ordinal ("4"), not the chassis code -- "E46" belongs in
    // Dev_Chassis_Code and must not be accepted here instead.
    const { out, code } = scenario((d) =>
      appendFileSync(join(d, 'year_make_model.csv'), 'Saab,900,1990,E46,,,\n'),
    );
    assert.equal(code, 1);
    assert.match(out, /not a whole number/);
  });

  test('a decimal in a decimal column is accepted', () => {
    // Axle ratios and gear ratios are genuinely fractional; rejecting them the
    // way an integer column would is the bug this guards against.
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'transmissions.csv'),
        'tx-test,ZF,8HP,Automatic,8,4.71,0.67\n',
      ),
    );
    assert.equal(code, 0, out);
  });

  test('a non-numeric decimal is rejected', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'transmissions.csv'),
        'tx-bad,ZF,8HP,Automatic,8,four-point-seven,0.67\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /not a number/);
  });

  test('an unrecognised boolean is rejected with the accepted spellings', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'suspensions.csv'),
        'sus-bad,MacPherson,Multi-link,Coil,Coil,Passive,sometimes\n',
      ),
    );
    assert.equal(code, 1);
    assert.match(out, /Use TRUE or FALSE/);
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
      for (const f of ['year_make_model.csv', 'engine_specs.csv', 'ymm_powertrains.csv']) {
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
        'test-big-v12,Test,V12,,,V,12,"6,750",Naturally Aspirated,Gasoline,11.0:1,Port Injection,700,650,,,,,,,\n',
      ),
    );
    assert.equal(code, 0, out);
    assert.match(out, /8 engines/);
  });

  test('a quoted value containing a comma stays one field', () => {
    const { out, code } = scenario((d) =>
      appendFileSync(
        join(d, 'engine_specs.csv'),
        'test-quoted,Test,QT,,,V,8,5000,Supercharged,Gasoline,9.0:1,"Port, then direct",400,400,,,,,,,\n',
      ),
    );
    assert.equal(code, 0, out);
    assert.match(out, /8 engines/);
  });
});
