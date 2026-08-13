# Contributing

The database is three CSV files. Adding a car means adding rows to them.

You do not need to know TypeScript, SQL, or how the site is built. If you can
edit a spreadsheet and open a pull request, you can contribute.

---

## The short version

1. Fork the repository
2. Add your rows to the files in [`data/`](../data/) — the format is documented
   in [`data/README.md`](../data/README.md)
3. Open a pull request

CI checks the files automatically and comments with the exact line if anything
is wrong. Nothing you can do in a pull request can break the live site: it only
rebuilds after a maintainer merges.

---

## Adding a car, worked through

Say you want to add the 2026 Mazda MX-5, which comes with one engine.

**1. Is the car already listed?** Look in `data/year_make_model.csv`. If not,
add a row:

```csv
Mazda,MX-5 Miata,2026
```

Match the spelling of the existing rows. `Mazda` and `MAZDA` are treated as the
same make — listing both is an error, not a second make — but consistent
spelling keeps the dropdowns tidy.

**2. Is the engine already listed?** Look in `data/engine_specs.csv`. Engines
are shared between cars, so check before adding: if the same engine is already
there under some ref, reuse that ref and skip to step 3.

If it is new, add it with a readable, unique ref:

```csv
mazda-2.0-na-i4,Mazda,PE-VPS,,,Inline,4,1998,Naturally Aspirated,Gasoline,13.0:1,Direct Injection,181,151
```

**3. Connect them** in `data/ymm_engines.csv`:

```csv
Mazda,MX-5 Miata,2026,mazda-2.0-na-i4
```

If the car offered three engines, that is three rows here — one per engine —
and still one row in `year_make_model.csv`.

**4. Check it:**

```bash
npm run validate
```

---

## What counts as good data

**Leave it blank if you do not know it.** Blank means unknown, and an unknown
value is excluded from filters on it. A guessed compression ratio is worse than
an empty cell, because once it is in the database nobody can tell it apart from
a real one.

**Use the manufacturer's own figure** where there is one. Press releases, the
official spec sheet, and the owner's manual are all good. A number copied from
another aggregator inherits whatever mistake that aggregator made.

**Displacement is the real swept volume**, not the marketing name. A "3.0
litre" engine goes in as `2981` if that is what it displaces. The search knows
that people ask for 3.0 litres and matches within a tolerance, so the precise
number costs nothing and is worth having.

**One engine, one row.** If two cars use the same engine, reference the same
ref rather than adding a near-identical second row. Duplicates drift: someone
corrects one and the other stays wrong.

**`Manufacturer` is who built it, not who sold the car.** The BMW-designed B58
goes in as `Manufacturer: BMW` even on a Toyota GR Supra row — that's the
whole reason the column exists separately from the vehicle's own `Make`.

**`Named_Variant` is for real, known differentiators** — a factory suffix like
`B30`, or a tuner name like `Alpina`. If an engine genuinely has several
unnamed power levels and nothing else distinguishes them, use
`Silent_Variant` (`1`, `2`, `3`...) instead — it exists purely so those rows
can coexist and never appears in search results or filters. Leave both blank
for the common case of an engine with no variants at all.

**`Horsepower` and `Torque_lbft` are SAE net, not gross.** Pre-1972 US cars
are often quoted in gross horsepower, which runs meaningfully higher than the
net figure for the same engine — if a source doesn't say which one it's
giving, that's a reason to leave the cell blank rather than guess. This isn't
something the site can fix with a unit conversion: gross and net are different
test procedures, not different units for the same measurement.

---

## If CI fails

The error names the file, the line, and usually the fix. Common ones:

| Message | Cause |
|---|---|
| `is not in year_make_model.csv` | The make/model/year in `ymm_engines.csv` does not match a row in `year_make_model.csv`. Usually a typo or a different spelling. |
| `is not in engine_specs.csv` | The engine ref does not match any `Ref`. |
| `found 3 column(s), expected 4` | A value contains a comma. Wrap it in quotes: `"Port, then direct"`. |
| `is already listed on line N` | Duplicate row. |
| `missing column(s): Make` | A header was renamed or the file was saved in the wrong format. |

Run `npm run validate` locally to see the same errors before pushing.

---

## Changing the code

The same pull request process applies. Before opening one:

```bash
npm test          # compiler and loader tests
npm run typecheck
npm run verify    # real searches against a built database
```

The parts most worth understanding before changing them:

- **`packages/query/src/fields.ts`** — the field registry. It is the only place
  a public field name maps to a database column, which is what makes the query
  compiler injection-safe by construction. Adding a searchable field starts here.
- **`packages/query/src/compiler.ts`** — request to SQL. Every value is a bound
  parameter; no user input reaches the SQL text.
- **`packages/etl/src/build.ts`** — the loader. Its error messages are a user
  interface for contributors; treat a confusing one as a bug.

Adding a column to a table means changing the migration, the loader, the field
registry, and the UI's result card. The tests in `packages/etl/test` will tell
you if the loader half is wrong.

---

## Licence

Contributions are published under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
(data) and MIT (code). Only contribute data you are free to share — figures from
a manufacturer's public spec sheet are facts and are fine; a bulk copy of
another database's proprietary compilation is not.
