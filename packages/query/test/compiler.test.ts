/**
 * Tests for the filter -> SQL compiler.
 *
 * The compiler is the only component that turns untrusted input into SQL, so
 * the tests here are weighted towards the two things that would actually hurt:
 * injection, and silently wrong unit conversion. A search that returns the
 * wrong cars because 65 cu ft was read as 65 litres is a worse bug than one
 * that crashes, because nobody notices it.
 *
 *   npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compile, QueryError } from '../src/compiler.js';
import { toCanonical, fromCanonical, UnitError } from '../src/units.js';
import { FIELDS, getField } from '../src/fields.js';

const BITS = new Map([['massage-seats-front', 5], ['tow-package', 43], ['high-bit-feature', 70]]);

describe('injection safety', () => {
  test('rejects an unknown field rather than interpolating it', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'x; DROP TABLE variant--', op: 'eq', value: 1 }] }),
      /Unknown field/,
    );
  });

  test('every value reaches SQL as a bound parameter', () => {
    const q = compile({
      filters: [{ field: 'horsepower', op: 'gte', value: 500 }],
    });
    assert.ok(!q.countSql.includes('500'), 'value must not appear in SQL text');
    assert.deepEqual(q.countParams, [500]);
  });

  test('a string payload in an enum slot is rejected, not quoted', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'aspiration', op: 'eq', value: "' OR 1=1--" }] }),
      /is not a valid value/,
    );
  });

  test('free text with FTS operators is neutralised', () => {
    const q = compile({ q: 'gt3" OR make_name:*' });
    assert.equal(q.countParams.length, 1);
    // Every token is quoted, so nothing is interpreted as FTS syntax.
    assert.match(String(q.countParams[0]), /^"/);
  });

  test('only registered columns appear in SQL', () => {
    for (const f of FIELDS) {
      const q = compile({ filters: [{ field: f.name, op: 'exists' }] });
      assert.ok(
        q.countSql.includes(`\`${f.column}\``),
        `${f.name} should compile to its registered column`,
      );
    }
  });
});

describe('unit conversion', () => {
  test('cubic feet to litres, exactly', () => {
    // 65 cu ft = 1840.6 L. Getting this wrong by a factor is the difference
    // between "big SUV" and "handbag".
    assert.equal(toCanonical('volume', 65, 'cuft').toFixed(3), '1840.595');
  });

  test('inches to millimetres uses the exact 1959 definition', () => {
    // 28 * 25.4 is 711.1999999999999 in IEEE 754, not 711.2. The factor is
    // exact; binary floating point is not. This is precisely why `eq` on a
    // measured quantity compiles to a tolerance window rather than an
    // equality -- see the operators suite below.
    assert.ok(Math.abs(toCanonical('length', 28, 'in') - 711.2) < 1e-9);
  });

  test('pounds to kilograms uses the exact definition', () => {
    assert.equal(toCanonical('mass', 3164, 'lb').toFixed(4), '1435.1663');
  });

  test('l/100km inverts rather than scaling', () => {
    // 8 L/100km is about 29.4 mpg. A multiplicative factor would give nonsense.
    assert.equal(toCanonical('economy', 8, 'l/100km').toFixed(2), '29.40');
    assert.equal(fromCanonical('economy', 29.4, 'l/100km').toFixed(2), '8.00');
  });

  test('PS to hp is a real conversion, not a relabel', () => {
    assert.equal(toCanonical('power', 100, 'ps').toFixed(3), '98.632');
  });

  test('round trip is stable', () => {
    for (const [q, unit, v] of [
      ['length', 'in', 177.9],
      ['mass', 'lb', 4627],
      ['volume', 'cuft', 41.8],
      ['power', 'kw', 335],
    ] as const) {
      const there = toCanonical(q, v, unit);
      assert.equal(Number(fromCanonical(q, there, unit).toFixed(6)), v);
    }
  });

  test('an unknown unit is an error, not a silent pass-through', () => {
    assert.throws(() => toCanonical('length', 5, 'furlongs'), UnitError);
  });

  test('the filter path converts before binding', () => {
    const q = compile({
      filters: [{ field: 'cargo_behind_second', op: 'gte', value: 65, unit: 'cuft' }],
    });
    assert.equal(Number(q.countParams[0]).toFixed(3), '1840.595');
  });
});

describe('plausibility guards', () => {
  test('an unqualified metre value for length is rejected', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'length', op: 'gte', value: 4.5 }] }),
      /Did you mean to specify a unit/,
    );
  });

  test('the same value with a unit is accepted', () => {
    const q = compile({ filters: [{ field: 'length', op: 'gte', value: 4.5, unit: 'm' }] });
    assert.equal(q.countParams[0], 4500);
  });

  test('an absurd upper value is rejected', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'horsepower', op: 'gte', value: 99999 }] }),
      /above the plausible maximum/,
    );
  });
});

describe('operators', () => {
  test('eq on a measured quantity becomes a tolerance window', () => {
    // "28 inch seat height" means about 28 inches. Exact float equality
    // against a converted value would match nothing at all.
    const q = compile({
      filters: [{ field: 'seat_height', op: 'eq', value: 28, unit: 'in' }],
    });
    assert.match(q.countSql, /BETWEEN \? AND \?/);
    const [lo, hi] = q.countParams as number[];
    assert.ok(lo! < 711.2 && hi! > 711.2);
  });

  test('between normalises a reversed range', () => {
    const q = compile({ filters: [{ field: 'year', op: 'between', value: [2020, 2010] }] });
    assert.deepEqual(q.countParams, [2010, 2020]);
  });

  test('negation does not silently match NULL', () => {
    const q = compile({ filters: [{ field: 'horsepower', op: 'ne', value: 300 }] });
    assert.match(q.countSql, /IS NULL OR/);
  });

  test('enum aliases resolve to the canonical code', () => {
    const a = compile({ filters: [{ field: 'aspiration', op: 'eq', value: 'turbo' }] });
    const b = compile({ filters: [{ field: 'aspiration', op: 'eq', value: 'turbocharged' }] });
    assert.deepEqual(a.countParams, b.countParams);
  });
});

describe('feature filters', () => {
  test('a bit-reserved feature compiles to a mask test with no join', () => {
    const q = compile({ features: [{ feature: 'massage-seats-front' }] }, BITS);
    assert.match(q.countSql, /\(`feat_lo` & 32\) = 32/);
    assert.ok(!q.countSql.includes('EXISTS'));
  });

  test('bits above 63 land in the high word', () => {
    const q = compile({ features: [{ feature: 'high-bit-feature' }] }, BITS);
    assert.match(q.countSql, /`feat_hi`/);
    assert.equal(q.countParams.length, 0);
  });

  test('standard-only uses the standard mask', () => {
    const q = compile(
      { features: [{ feature: 'massage-seats-front', availability: ['standard'] }] },
      BITS,
    );
    assert.match(q.countSql, /`feat_std_lo`/);
  });

  test('an unreserved feature falls back to the covering index', () => {
    const q = compile({ features: [{ feature: 'night-vision' }] }, BITS);
    assert.match(q.countSql, /EXISTS/);
    assert.equal(q.countParams[0], 'night-vision');
  });

  test('absence is expressible', () => {
    const q = compile({ features: [{ feature: 'massage-seats-front', absent: true }] }, BITS);
    assert.match(q.countSql, /= 0/);
  });
});

describe('query shape', () => {
  test('predicates are ordered cheapest first', () => {
    const q = compile(
      {
        features: [{ feature: 'night-vision' }], // EXISTS, cost 70
        filters: [{ field: 'cylinders', op: 'eq', value: 6 }], // equality, cost 5
      },
      BITS,
    );
    assert.ok(
      q.countSql.indexOf('cylinders') < q.countSql.indexOf('EXISTS'),
      'the cheap equality must be evaluated before the subquery',
    );
  });

  test('limit is clamped', () => {
    const q = compile({ limit: 100000 });
    assert.equal(q.params[q.params.length - 2], 200);
  });

  test('sort always carries a stable tiebreak, so pages cannot repeat rows', () => {
    const q = compile({ sort: [{ field: 'horsepower', dir: 'desc' }] });
    assert.match(q.sql, /variant_id/);
  });

  test('NULLs sort last by default', () => {
    const q = compile({ sort: [{ field: 'zero_to_60', dir: 'asc' }] });
    assert.match(q.sql, /IS NULL\) ASC/);
  });

  test('a facet excludes its own filter from its counts', () => {
    const q = compile({
      filters: [
        { field: 'body_category', op: 'eq', value: 'suv' },
        { field: 'cylinders', op: 'eq', value: 6 },
      ],
      facets: ['body_category'],
    });
    const facet = q.facetQueries[0]!;
    // The body filter is dropped so the user can still see the other options.
    assert.ok(!facet.sql.includes('body_category_code ='));
    assert.ok(facet.sql.includes('cylinders'));
  });

  test('too many filters is rejected', () => {
    const filters = Array.from({ length: 61 }, () => ({
      field: 'year' as const, op: 'eq' as const, value: 2020,
    }));
    assert.throws(() => compile({ filters }), QueryError);
  });
});

describe('field registry', () => {
  test('field names are unique', () => {
    const names = FIELDS.map((f) => f.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('every enum field names a real vocabulary', () => {
    for (const f of FIELDS) {
      if (f.kind === 'enum') assert.ok(f.enumName, `${f.name} is an enum with no enumName`);
    }
  });

  test('getField throws on an unknown name', () => {
    assert.throws(() => getField('nope'), /Unknown field/);
  });
});
