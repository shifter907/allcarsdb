/**
 * Tests for the browsable-table registry.
 *
 * This registry is the second place (after the field registry) where a name
 * from a request decides a SQL identifier, so it gets the same treatment: prove
 * an unknown name is rejected rather than interpolated, and prove the
 * documentation the site renders actually matches the columns it selects.
 *
 *   npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, getTable } from '../src/tables.js';

describe('table registry', () => {
  test('rejects an unknown table rather than passing it through', () => {
    assert.throws(() => getTable('Users'), /Unknown table/);
    assert.throws(() => getTable('Year_Make_Model; DROP TABLE x'), /Unknown table/);
  });

  test('resolves a known table case-insensitively', () => {
    // The URL carries whatever case someone typed; SQLite does not care about
    // identifier case, so neither should the lookup.
    assert.equal(getTable('year_make_model').name, 'Year_Make_Model');
    assert.equal(getTable('Year_Make_Model').name, 'Year_Make_Model');
  });

  test('table names are unique', () => {
    const names = TABLES.map((t) => t.name.toLowerCase());
    assert.equal(new Set(names).size, names.length);
  });

  test('every table has at least one column and a real orderBy', () => {
    // orderBy is interpolated into an ORDER BY clause, so it has to name a
    // column of that same table -- a typo here would be a runtime SQL error on
    // a page rather than a caught mistake.
    for (const t of TABLES) {
      assert.ok(t.columns.length > 0, `${t.name} has no columns`);
      const columnNames = t.columns.map((c) => c.name);
      assert.ok(
        columnNames.includes(t.orderBy),
        `${t.name}.orderBy "${t.orderBy}" is not one of its columns`,
      );
    }
  });

  test('column names within a table are unique', () => {
    for (const t of TABLES) {
      const names = t.columns.map((c) => c.name.toLowerCase());
      assert.equal(new Set(names).size, names.length, `${t.name} has duplicate columns`);
    }
  });

  test('identifiers are plain -- nothing that would need escaping', () => {
    // Every table and column name reaches SQL inside backticks. Keeping them to
    // word characters means the backticks are belt-and-braces rather than the
    // only thing standing between the registry and a broken query.
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const t of TABLES) {
      assert.match(t.name, plain, `table ${t.name}`);
      for (const c of t.columns) {
        assert.match(c.name, plain, `${t.name}.${c.name}`);
      }
    }
  });

  test('every foreign key points at a table that exists', () => {
    const known = new Set(TABLES.map((t) => t.name));
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (c.key === 'fk') {
          assert.ok(c.references, `${t.name}.${c.name} is a foreign key with no target`);
          assert.ok(
            known.has(c.references!),
            `${t.name}.${c.name} references unknown table ${c.references}`,
          );
        }
      }
    }
  });

  test('every column carries a description', () => {
    // The description is what the site renders on the data-model page -- an
    // empty one is a blank cell in the docs, not a harmless omission.
    for (const t of TABLES) {
      assert.ok(t.role.length > 0, `${t.name} has no role`);
      assert.ok(t.description.length > 0, `${t.name} has no description`);
      for (const c of t.columns) {
        assert.ok(c.description.length > 0, `${t.name}.${c.name} has no description`);
      }
    }
  });
});
