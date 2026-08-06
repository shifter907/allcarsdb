# AllCarsDB

An open, community-built database of vehicle specifications, searchable by any
combination of them.

**[allcarsdb.com](https://allcarsdb.com)** · [API](https://api.allcarsdb.com/v1/fields) · [contribute](docs/CONTRIBUTING.md)

Ask things like *"naturally aspirated flat-six, six cylinders"* or *"turbocharged
four under 2.0 litres"* and get an answer, rather than a list of dealer
inventory.

---

## How it works

**The data lives in Git as CSV. The database is a build artifact.**

```
data/*.csv  →  validate  →  dist/allcars.sqlite  →  Cloudflare D1  →  API  →  UI
```

Nothing is edited in a production database. A change is a pull request against
a CSV file; CI validates it; merging rebuilds and redeploys everything.

| Question | Answer |
|---|---|
| "Who changed this and why?" | `git blame` on a CSV row. |
| "Can I have all of it?" | [`allcars.sqlite`](https://github.com/shifter907/allcarsdb) is published on every build. |
| "This number is wrong." | Open a pull request. It ships when it merges. |
| "Can I run my own?" | Fork it. The whole pipeline runs locally with `npm install`. |

---

## The data model

Three tables.

```
Year_Make_Model          Engine_Specs
  Index                    Index
  Make                     Layout, Cylinders, CC_Displacement
  Model                    Aspiration, Fuel_Type
  Year                     Compression_ratio, Fuel_delivery
       \                  /
        \                /
         YMM_Engines  (Index, YMM_Index, Engine_Index)
```

`YMM_Engines` is the searchable unit: one row is *a vehicle-year together with
one engine it was offered with*. A 911 sold with two engines is two rows there
and still one row in `Year_Make_Model`.

Engines are shared rather than copied. The same unit fitted to a Golf and a
Jetta is one row referenced twice — so correcting its displacement corrects
every car that used it, instead of fixing one copy and leaving the rest wrong.

Searches run against `Search_View`, a flat join of all three. See
[`packages/db/migrations/0000_schema.sql`](packages/db/migrations/0000_schema.sql).

---

## Repository layout

```
data/
  year_make_model.csv    Every vehicle-year
  engine_specs.csv       Every distinct engine
  ymm_engines.csv        Which engines went in which cars
  README.md              The format, in detail

packages/
  db/migrations/         The schema
  schema/                Unit definitions and conversions
  query/                 Search request → parameterized SQL
  etl/                   CSV → SQLite; plus dump and verify

apps/
  api/                   Cloudflare Worker (Hono) over D1
  web/                   React search interface
```

---

## Design notes

**Unknown is not zero.** A blank cell means nobody has recorded that value. A
car with no listed displacement is excluded from a displacement filter rather
than treated as a 0cc engine. Guessing a value is worse than leaving it blank,
because a wrong number is indistinguishable from a right one once it is in the
database.

**Units convert on the way in.** Storage is canonical — displacement in cubic
centimetres — and the API accepts whatever the user typed. `displacement=lt:2l`
and `displacement=lt:2000cc` are the same query. Equality on a measured
quantity compiles to a tolerance window, because "3.0 litres" is a marketing
number and the engine actually displaces 2981cc.

**No string interpolation of user input.** Column names come from a fixed
registry and every value is a bound parameter, so a request body has no path
into the SQL text. Field names that are not in the registry are rejected rather
than escaped.

**Vocabularies come from the data.** `Layout` and `Aspiration` are free text
with no fixed list, and the UI builds its dropdowns from the distinct values
actually present. That avoids inventing a taxonomy up front and then fighting
it — at the cost of needing contributors to match existing spelling.

**Indices are assigned, never authored.** Contributors reference rows by name
and engine code. Two people adding a car in separate pull requests would
otherwise both claim ID 501.

---

## Running it locally

Node 22 or newer. No native modules, no build tools, no database server —
`node:sqlite` is built in.

```bash
npm install
npm run build:db     # data/*.csv -> dist/allcars.sqlite
npm run dev:api      # http://localhost:8787
npm run dev:web      # http://localhost:5173
```

Other commands:

```bash
npm run validate     # check the CSVs, write nothing
npm test             # compiler and loader tests
npm run verify       # run real searches against the built database
```

---

## Licence

Data is [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Code is
MIT. Use the data for anything, including commercially; if you publish a
modified version of the dataset, publish it under the same terms.
