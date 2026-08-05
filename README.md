# AllCarsDB

An open, community-built database of vehicle specifications — every variant, every trim, every option — searchable by any combination of specs.

The kind of question this is built to answer:

> Which cars have a hybrid powertrain, all-wheel drive, at least 65 cu ft of cargo space, a seat height around 28 inches, and massage seats available?

> Which cars have a naturally aspirated flat-six with at least 24 valves and a folding hardtop?

Neither question is answerable on any existing site, because existing sites model a car as one row with a "trim" string, and throw away the distinctions that make the question meaningful.

---

## The core idea

**The data lives in Git as YAML. The database is a build artifact.**

```
data/**/*.yaml  →  validate  →  dist/allcars.sqlite  →  Cloudflare D1  →  API  →  UI
```

Everything else follows from that:

| Problem every community database has | How this avoids it |
|---|---|
| Spam and vandalism | Contributions are pull requests. GitHub already solved review. |
| Accounts, logins, permissions | There is no write path. The API is read-only. |
| Moderation tooling | Code review tooling, which is better and free. |
| "Who changed this and why?" | `git blame` on a YAML file. |
| Rolling back bad data | `git revert`. |
| Data lock-in | Clone the repo. It is all plain text. |
| Hosting costs | Static site + edge Worker + SQLite. Free tier covers it. |

The trade-off is that changes are not instant — they ship on the next build. For a specification database, where correctness matters far more than latency, that is the right trade.

---

## Quick start

```bash
npm install
npm run build:db
```

Then, in two terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open <http://localhost:5173>. No Cloudflare account, no Docker, no native compilation — the ETL and the dev API both use Node's built-in SQLite.

Check that the search engine works end to end:

```bash
npm run verify -w @allcarsdb/etl
```

---

## Repository layout

```
data/                        The actual database, as text
  makes/*.yaml                 One file per make
  body-styles.yaml             Closed vocabulary of body/roof combinations
  features.yaml                Curated equipment catalog
  components/                  Shared engines, transmissions, axles, batteries
    engines/*.yaml
    transmissions/*.yaml
    drivetrains/*.yaml
  vehicles/<make>/<model>/<year>.yaml

packages/
  schema/                    Enums, units, and the contribution file schema (zod)
  db/migrations/*.sql        The SQL schema, heavily commented
  etl/                       YAML → validated → SQLite; plus dump and verify
  query/                     Field registry and the filter → SQL compiler

apps/
  api/                       Hono on Cloudflare Workers over D1
  web/                       Vite + React search interface
```

---

## How the data is modelled

Six levels, narrowing from "who built it" to "the exact thing you could buy":

```
manufacturer   Volkswagen Group
  make         Porsche
    model      911
      generation  992.2
        model_year  2026, US market
          trim        GT3
            variant     coupe / 4.0 flat-6 / 6-speed manual / RWD
```

**`variant` is the unit of search.** Every specification hangs off it.

That last split is the one that matters. A single trim routinely covers several genuinely different cars — a 911 Carrera is sold as a coupe and a cabriolet, with PDK or a manual, and those have different weights, different EPA figures and different 0-60 times. Collapsing them into one row is how every other spec site ends up publishing numbers that are wrong for most of the cars they describe.

Specifications are split by domain — `spec_exterior`, `spec_interior`, `spec_performance`, `spec_efficiency`, `spec_capacity`, `spec_chassis` — rather than kept in one wide table, for three reasons:

1. **Contribution granularity.** Someone with a tape measure can fill in interior dimensions without touching anything else, and the diff is legible.
2. **Sparsity.** A 1968 Alfa has no efficiency row and no driver-assistance data. Splitting means absent data costs nothing.
3. **Provenance.** Sources attach per row, so "the EPA supplied the mpg, *Car and Driver* supplied the 0-60" is representable.

Details, with the reasoning inline, are in [`packages/db/migrations`](packages/db/migrations).

---

## How search stays fast

The hard case is a query with no selective predicate on make or model — six filters across six tables, which normalized is a five-way join that no single index can serve.

**`variant_search`** is a flat, integer-only projection of every commonly filtered attribute. Three properties make it work:

1. **No text.** Enum values are stable numeric codes defined in [`packages/schema/src/enums.ts`](packages/schema/src/enums.ts). Integer comparison beats collated string comparison, and the row stays small — so a scan reads far fewer pages.

2. **A feature bitmask.** The 128 most-requested boolean features are packed into two 64-bit integers. `has massage seats AND has a tow package` becomes an AND-mask evaluated inside the scan, with no join at all. Rarer features fall back to a covering index on `variant_feature`, which is still cheap.

3. **It is disposable.** Every row is derived and rebuilt from scratch, so the shape can change whenever query patterns change, with no data migration.

Confirm the plan yourself:

```bash
npm run verify -w @allcarsdb/etl
```

```
SEARCH variant_search USING COVERING INDEX idx_vs_engine_shape
  (engine_layout_code=? AND cylinders=? AND aspiration_code=?)
```

---

## Units

Every measurement column carries its unit in its name — `length_mm`, `cargo_behind_second_l`, `curb_weight_kg`. No exceptions. Storing a bare `length` and hoping is how spec databases end up listing 4.5-metre cars as 4.5 inches long.

Contributors write whatever their source printed:

```yaml
length: 177.9 in      # or: 4519 mm
cargo_behind_second: 41.8 cuft
curb_weight: 4627 lb
towing_braked: 5000 lb
```

The loader converts to canonical units using exact factors. The API accepts a unit on every numeric filter and converts on the way in, so `cargo_behind_second=gte:65cuft` and `cargo_behind_second=gte:1840l` are the same query.

Unqualified values are checked against plausibility floors, so `length=gte:4.5` — someone thinking in metres and forgetting the unit — is an error rather than a silent match against everything.

---

## Data quality

A community spec database that cannot answer "says who?" is a rumour mill. Three mechanisms, all present from the start because none of them can be retrofitted:

- **Provenance per column.** `fact_source` records which source supports which field of which row, with a confidence level from `manufacturer` down to `unverified`.
- **Confidence is searchable.** `confidence=manufacturer,regulatory` filters to well-sourced data only.
- **Completeness is visible.** Every variant shows what fraction of tracked specs it actually has, and `data_gap` drives a help-wanted list. Hiding gaps trains people to distrust everything; showing them is an invitation to fill them.

Manufacturer claims and independently measured figures are kept in separate columns. EPA and WLTP figures never share a column — they differ by 15–25%, and mixing them silently corrupts every efficiency comparison.

> **The seed data in `data/` is illustrative and uncited.** It exists to exercise the schema. Every block is marked `confidence: unverified`. Do not trust those numbers; do use those files as templates.

---

## Contributing

Adding a car is one YAML file. See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).

```bash
npm run validate      # schema check, no database written
npm run build:db      # full build
```

CI runs the same validation on every pull request, so a malformed contribution fails before review rather than after merge.

---

## Deployment

See [`docs/HOSTING.md`](docs/HOSTING.md). The short version: Cloudflare Pages for the UI, a Worker for the API, D1 for the data. Expected cost at moderate traffic is zero, and the ceiling before it stops being free is high.

---

## Licence

- **Data** (`data/`): CC BY-SA 4.0. Use it, sell it, build on it — keep it open and credit the project.
- **Code**: MIT.

Chosen so the data cannot be enclosed by a commercial aggregator, while the code stays trivially reusable.
