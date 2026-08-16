# Importers

Scripts that turn public source data into the CSVs in `data/`. They are run by
hand, not on a schedule, and every file they write is reviewed in a pull request
like any other change.

Everything here follows one rule: **when a source is unclear, drop the row.** A
blank field means "we don't know yet" and is expected. A wrong field is worse
than no field, because nothing downstream can tell it apart from a real one.

## Sources

| Script | Source | Produces |
|---|---|---|
| `vpic-pull.mjs` | NHTSA vPIC `GetModelsForMakeYear` | the make/model/year catalogue |
| `nhtsa-bodies-pull.mjs` | NHTSA `GetCanadianVehicleSpecifications` | raw dimension records |
| `nhtsa-bodies-import.mjs` | ↑ the pull's output | `body_configs.csv`, `ymm_body_configs.csv` |
| `epa-import.mjs` | EPA fueleconomy.gov bulk CSV | `builds.csv`, `transmissions.csv`, `drivetrains.csv` |
| `epa-candidates.mjs` | ↑ the rows EPA import dropped | a review sheet for `epa_model_aliases.csv` |

Downloaded source data lives in `cache/` and is gitignored — it is large, it
isn't ours, and the pull scripts regenerate it.

## The series rename

`series-map.mjs` holds the rules that decide a model's name, and it is where most
of the accumulated knowledge in this directory lives.

The catalogue originally inherited vPIC's model list, which spelled the same
real-world distinction three different ways: Ford fully series-numbered (`F-150`,
`F-250`), GM not at all (one `Silverado` row covering 1500 through 3500), and
Dodge both at once. That is not cosmetic. A `Silverado 2500HD` and a `Silverado
1500` are different trucks, and merging them attached heavy-duty dimensions and
engines to a half-ton.

The governing rule:

> A word belongs in the model name if it names a **different vehicle**. If it
> names a spec stored elsewhere — drivetrain, cab, box, engine — it comes out.

So `SILVERADO 2500HD CREW CAB L/BOX 4X4` is the model `Silverado 2500HD`; the
cab, box and drive layout go to `Body_Configs` and `Drivetrains`. Drivetrain
letters come out for the same reason — GM's `C1500`/`K1500` and Dodge's
`D150`/`W150` encode 2WD versus 4WD in the name, so the model is `C/K 1500` and
the drive layout is recorded where it can be filtered.

A series number is only used **when the nameplate offered more than one series
that year**. GM badged Suburban 1500 alongside Suburban 2500 through 2013, then
dropped the number when only the light-duty one remained; the same happened to
Yukon XL. That falls out of the data rather than being hardcoded.

### Guards worth knowing about

Each of these exists because it caught something real:

- **Multi-series strings are refused.** Both sources publish combined rows
  (`G1500 G2500 G3500`, `Express 1500 2500`). First-match-wins would file them
  all under 1500, inventing a light-duty van for years only heavier ones sold.
- **Retroactive names are rejected by year.** NHTSA labels 1982 trucks with GM's
  later designations — a 1982 C10 filed as `C1500 OR C10`, a 1982 G30 van as
  `G3500`. The 1500/2500/3500 names arrive for MY1988 and Express/Savana for
  MY1996, so anything earlier is refused. The correctly-named records survive
  alongside, so almost no coverage is lost.
- **Nameplates beat bare prefixes.** GM prefixed every body with the same
  chassis letter: `K15` is a pickup, `K15 JIMMY` is an SUV, `K15 SUBURBAN` is a
  wagon. Without this, all three became pickups.
- **Short gaps are bridged, long ones are not.** Neither source is a complete
  census, so a model attested in 1994 and 1996 was sold in 1995. But a `Classic`
  badge marks a run-out model sold beside its replacement and is genuinely
  discontinuous — GMC sold Sierra Classic in 1999–2000 and again in 2007 — so
  those gaps are never bridged.
- **Wheelbase and length must agree.** Two records contradict themselves (a 1985
  Suburban at a 52-inch wheelbase against a correct 219-inch length). Which
  field is wrong differs between them, so the record's dimensions are dropped
  rather than guessed.

## Re-running

```bash
node tools/import/series-propose.mjs
```

Prints the canonical model list with the year spans each source attests, and
flags production gaps it declined to bridge. Read this before trusting a rename.

```bash
node tools/import/migrate-series.mjs          # dry run
node tools/import/migrate-series.mjs --write  # apply
```

Rewrites `year_make_model.csv` and `ymm_powertrains.csv`. Both are idempotent —
re-running on migrated data reports no changes.

`migrate-series.mjs` is the one place a judgement call could not be avoided:
splitting `Silverado` into series means deciding which series each engine
belongs to, and displacement does not settle it. The 6.0L LQ4 is a heavy-duty
engine (1500HD/2500/2500HD/3500); the 6.0L LQ9 is a light-duty one, because it
is the Silverado SS unit. `HEAVY_ENGINES` lists them individually for that
reason.

Body configs and builds are **generated**, not migrated — re-run their importers
after any rename and they resolve correctly on their own.
