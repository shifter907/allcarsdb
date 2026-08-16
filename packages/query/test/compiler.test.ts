/**
 * Tests for the filter -> SQL compiler.
 *
 * The compiler is the only component that turns untrusted input into SQL, so
 * the tests here are weighted towards the two things that would actually hurt:
 * injection, and silently wrong unit conversion. A search that returns the
 * wrong cars because 3.0 litres was read as 3cc is a worse bug than one that
 * crashes, because nobody notices it.
 *
 *   npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compile, QueryError } from '../src/compiler.js';
import { toCanonical, fromCanonical, UnitError } from '../src/units.js';
import { FIELDS, getField } from '../src/fields.js';

describe('injection safety', () => {
  test('rejects an unknown field rather than interpolating it', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'x; DROP TABLE Engine_Specs--', op: 'eq', value: 1 }] }),
      /Unknown field/,
    );
  });

  test('every value reaches SQL as a bound parameter', () => {
    const q = compile({ filters: [{ field: 'cylinders', op: 'gte', value: 8 }] });
    assert.ok(!q.countSql.includes('8'), 'value must not appear in SQL text');
    assert.deepEqual(q.countParams, [8]);
  });

  test('a quote in a text value is bound, never quoted into SQL', () => {
    const q = compile({ filters: [{ field: 'make', op: 'eq', value: "' OR 1=1--" }] });
    assert.ok(!q.countSql.includes('OR 1=1'));
    assert.deepEqual(q.countParams, ["' OR 1=1--"]);
  });

  test('LIKE metacharacters are escaped, not honoured', () => {
    // Someone searching for a model named "100%" means the string. An
    // unescaped % would silently match every model instead.
    const q = compile({ filters: [{ field: 'model', op: 'contains', value: '100%' }] });
    assert.equal(q.countParams[0], '%100\\%%');
    assert.match(q.countSql, /ESCAPE/);
  });

  test('free text is bound, and each token narrows', () => {
    const q = compile({ q: 'porsche 911' });
    assert.deepEqual(q.countParams, ['%porsche%', '%911%']);
    assert.match(q.countSql, /AND/);
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
  test('litres to cc', () => {
    // The whole reason displacement is its own quantity: `volume` is
    // canonically litres, and 3.0 there would mean 3, not 3000.
    assert.equal(toCanonical('displacement', 3.0, 'l'), 3000);
    assert.equal(toCanonical('displacement', 2981, 'cc'), 2981);
  });

  test('cubic inches to cc uses the exact definition', () => {
    // A 350 small block is 5735.5cc. Rounding the factor puts it on the
    // wrong side of a "5.7 litre" filter.
    assert.equal(toCanonical('displacement', 350, 'cuin').toFixed(3), '5735.472');
  });

  test('round trip is stable', () => {
    for (const [unit, v] of [['l', 3.0], ['cuin', 350], ['cc', 1998]] as const) {
      const there = toCanonical('displacement', v, unit);
      assert.equal(Number(fromCanonical('displacement', there, unit).toFixed(6)), v);
    }
  });

  test('an unknown unit is an error, not a silent pass-through', () => {
    assert.throws(() => toCanonical('displacement', 5, 'furlongs'), UnitError);
  });

  test('the filter path converts before binding', () => {
    const q = compile({ filters: [{ field: 'displacement', op: 'gte', value: 3, unit: 'l' }] });
    assert.equal(q.countParams[0], 3000);
  });
});

describe('plausibility guards', () => {
  test('an absurd year is rejected', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'year', op: 'eq', value: 20226 }] }),
      /above the plausible maximum/,
    );
  });

  test('an impossible cylinder count is rejected', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'cylinders', op: 'eq', value: 99 }] }),
      /above the plausible maximum/,
    );
  });

  test('an impossible horsepower figure is rejected', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'horsepower', op: 'eq', value: 9000 }] }),
      /above the plausible maximum/,
    );
  });
});

describe('operators', () => {
  test('eq on displacement becomes a tolerance window', () => {
    // "3.0 litre" is a marketing number. The real swept volume is 2981 or
    // 2995 or 3020 depending on the engine, and an exact match finds none.
    const q = compile({ filters: [{ field: 'displacement', op: 'eq', value: 3, unit: 'l' }] });
    assert.match(q.countSql, /BETWEEN \? AND \?/);
    const [lo, hi] = q.countParams as number[];
    assert.ok(lo! < 2981 && hi! > 2981, 'a 2981cc engine should match "3.0 l"');
    assert.ok(hi! < 3500, 'but a 3.5 should not');
  });

  test('between normalises a reversed range', () => {
    const q = compile({ filters: [{ field: 'year', op: 'between', value: [2020, 2010] }] });
    assert.deepEqual(q.countParams, [2010, 2020]);
  });

  test('negation does not silently match NULL', () => {
    const q = compile({ filters: [{ field: 'cylinders', op: 'ne', value: 4 }] });
    assert.match(q.countSql, /IS NULL OR/);
  });

  test('text eq relies on the column collation rather than lowercasing', () => {
    const q = compile({ filters: [{ field: 'layout', op: 'eq', value: 'Flat' }] });
    assert.deepEqual(q.countParams, ['Flat']);
    assert.match(q.countSql, /`Layout` = \?/);
  });

  test('in accepts several values for one field', () => {
    const q = compile({ filters: [{ field: 'aspiration', op: 'in', value: ['Turbo', 'Supercharged'] }] });
    assert.deepEqual(q.countParams, ['Turbo', 'Supercharged']);
  });

  test('a numeric operator on a text field is refused with a usable message', () => {
    assert.throws(
      () => compile({ filters: [{ field: 'layout', op: 'gte', value: 5 }] }),
      /which is text/,
    );
  });
});

describe('query shape', () => {
  test('predicates are ordered cheapest first', () => {
    const q = compile({
      filters: [
        { field: 'model', op: 'contains', value: 'gt' }, // LIKE, cost 60
        { field: 'cylinders', op: 'eq', value: 6 },      // equality, cost 20
      ],
    });
    assert.ok(
      q.countSql.indexOf('Cylinders') < q.countSql.indexOf('LIKE'),
      'the cheap equality must be evaluated before the scan',
    );
  });

  test('limit is clamped', () => {
    const q = compile({ limit: 100000 });
    assert.equal(q.params[q.params.length - 2], 200);
  });

  test('sort always carries a stable tiebreak, so pages cannot repeat rows', () => {
    const q = compile({ sort: [{ field: 'year', dir: 'desc' }] });
    assert.match(q.sql, /combo_index/);
  });

  test('NULLs sort last by default', () => {
    const q = compile({ sort: [{ field: 'displacement', dir: 'asc' }] });
    assert.match(q.sql, /IS NULL\) ASC/);
  });

  test('a facet excludes its own filter from its counts', () => {
    const q = compile({
      filters: [
        { field: 'aspiration', op: 'eq', value: 'Turbocharged' },
        { field: 'cylinders', op: 'eq', value: 6 },
      ],
      facets: ['aspiration'],
    });
    const facet = q.facetQueries[0]!;
    // The aspiration filter is dropped so the user can still see the others.
    assert.ok(!facet.sql.includes('`Aspiration` ='));
    assert.ok(facet.sql.includes('Cylinders'));
  });

  test('facets exclude rows with no recorded value', () => {
    const q = compile({ facets: ['fuel_type'] });
    assert.match(q.facetQueries[0]!.sql, /HAVING .*IS NOT NULL/);
  });

  test('too many filters is rejected', () => {
    const filters = Array.from({ length: 61 }, () => ({
      field: 'year' as const, op: 'eq' as const, value: 2020,
    }));
    assert.throws(() => compile({ filters }), QueryError);
  });

  test('too many facets is rejected', () => {
    // Every field is requested as a facet on every search now, to drive
    // cascading dropdowns -- this caps how far a caller can push that past
    // the size of the actual field registry.
    const facets = Array.from({ length: 41 }, () => 'year');
    assert.throws(() => compile({ facets }), QueryError);
  });
});

describe('field registry', () => {
  test('field names are unique', () => {
    const names = FIELDS.map((f) => f.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('getField throws on an unknown name', () => {
    assert.throws(() => getField('nope'), /Unknown field/);
  });
});

describe('semi-join sources', () => {
  test('a field on another relation becomes an EXISTS, not a join', () => {
    // Joining these into the base view would multiply rows against the
    // powertrain join; a semi-join filters without changing the row count.
    const q = compile({ filters: [{ field: 'body_style', op: 'eq', value: 'Pickup' }] });
    assert.match(q.countSql, /EXISTS \(SELECT 1 FROM YMM_Body_Configs/);
    assert.match(q.countSql, /ybc\.YMM_Index = Search_View\.ymm_index/);
    assert.deepEqual(q.countParams, ['Pickup']);
  });

  test('several filters on one relation share a single EXISTS', () => {
    // One subquery per predicate would cost N times as much and, worse, would
    // let each be satisfied by a different row of that relation.
    const q = compile({
      filters: [
        { field: 'body_style', op: 'eq', value: 'Pickup' },
        { field: 'cab_config', op: 'eq', value: 'Crew' },
      ],
    });
    assert.equal((q.countSql.match(/EXISTS/g) ?? []).length, 1);
    assert.match(q.countSql, /Body_Style` = \? AND .*Cab_Config` = \?/s);
  });

  test('different relations get their own EXISTS', () => {
    const q = compile({
      filters: [
        { field: 'body_style', op: 'eq', value: 'Pickup' },
        { field: 'drive_layout', op: 'eq', value: '4WD' },
      ],
    });
    assert.equal((q.countSql.match(/EXISTS/g) ?? []).length, 2);
  });

  test('semi-join predicates sort after every base-view predicate', () => {
    // Rule 2: a cheap column test should narrow the scan before any subquery
    // is evaluated.
    const q = compile({
      filters: [
        { field: 'body_style', op: 'eq', value: 'Pickup' },
        { field: 'make', op: 'eq', value: 'Ford' },
      ],
    });
    assert.ok(
      q.countSql.indexOf('`Make`') < q.countSql.indexOf('EXISTS'),
      'the base predicate should be emitted before the subquery',
    );
  });

  test('same_build folds build-rooted filters into one subquery', () => {
    const loose = compile({
      filters: [
        { field: 'axle_ratio', op: 'eq', value: 3.73 },
        { field: 'transmission_type', op: 'eq', value: 'Automatic' },
      ],
    });
    const strict = compile({
      combine: 'same_build',
      filters: [
        { field: 'axle_ratio', op: 'eq', value: 3.73 },
        { field: 'transmission_type', op: 'eq', value: 'Automatic' },
      ],
    });
    // Loose: two subqueries, so two different builds can satisfy them.
    assert.equal((loose.countSql.match(/EXISTS/g) ?? []).length, 2);
    // Strict: one subquery, so one build has to satisfy both.
    assert.equal((strict.countSql.match(/EXISTS/g) ?? []).length, 1);
    assert.match(strict.countSql, /FROM Builds b JOIN Transmissions/);
  });

  test('a facet excludes its own filter from inside a shared EXISTS', () => {
    // The subtle one: dropping the whole wrapper would also drop the sibling
    // constraint, so the two dropdowns would silently stop narrowing each
    // other while still producing plausible-looking counts.
    const q = compile({
      filters: [
        { field: 'body_style', op: 'eq', value: 'Pickup' },
        { field: 'cab_config', op: 'eq', value: 'Crew' },
      ],
      facets: ['cab_config'],
    });
    const facet = q.facetQueries.find((f) => f.facet === 'cab_config')!;
    // Its own constraint is gone...
    assert.doesNotMatch(facet.sql, /Cab_Config` = \?/);
    // ...but the sibling constraint from the same relation survives.
    assert.match(facet.sql, /Body_Style` = \?/);
    assert.deepEqual(facet.params, ['Pickup']);
  });

  test('a semi-join facet counts vehicles, not joined rows', () => {
    const q = compile({ facets: ['cab_config'] });
    const facet = q.facetQueries.find((f) => f.facet === 'cab_config')!;
    assert.match(facet.sql, /COUNT\(DISTINCT Search_View\.combo_index\)/);
  });

  test('sorting by a semi-join field is refused', () => {
    assert.throws(
      () => compile({ sort: [{ field: 'body_style', dir: 'asc' }] }),
      /no single value/,
    );
  });
});

describe('result shape', () => {
  test('result columns are derived from the registry, not hand-listed', () => {
    const q = compile({});
    // Every base-view field must be selectable, or the card renders a blank.
    for (const f of FIELDS) {
      if ((f.source ?? 'view') !== 'view') continue;
      assert.match(q.sql, new RegExp(`\`${f.column}\``), `${f.name} missing from result columns`);
    }
  });

  test('semi-join fields are not selected as result columns', () => {
    // They have no column on the outer row; selecting one would be a SQL error.
    const q = compile({});
    const selectClause = q.sql.slice(0, q.sql.indexOf('FROM'));
    assert.doesNotMatch(selectClause, /Cab_Config/);
    assert.doesNotMatch(selectClause, /Transfer_Case_Type/);
  });
});
