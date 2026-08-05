# Contributing

Adding a car is editing one text file. You do not need to understand the database, the API, or any of the TypeScript.

---

## The 60-second version

1. Fork the repo.
2. Copy `data/vehicles/_template.yaml` to `data/vehicles/<make>/<model>/<year>.yaml`.
3. Fill in what you know. **Leave out what you don't** — a missing field is fine, a guessed field is not.
4. Run `npm run validate`.
5. Open a pull request. Include a link to your source.

---

## What "one file" means

One file covers **one model, one year, one market**:

```
data/vehicles/porsche/911/2026.yaml       ← 2026 Porsche 911, US market
data/vehicles/porsche/911/2026-eu.yaml    ← same car, European market
```

Markets are separate files because the entire lineup differs — Europe gets trims the US never sees, the EPA and WLTP measure different things, and equipment availability rarely matches.

---

## The shape of a file

```yaml
version: 1
make: mazda            # must match a file in data/makes/
model: mx-5
model_name: MX-5 Miata
year: 2025
market: us

generation:
  slug: nd-facelift
  code: ND3
  start_year: 2024

trims:
  - slug: club
    name: Club

    # Specs here apply to every variant below, unless the variant overrides them.
    defaults:
      exterior:
        length: 154.1 in
        wheelbase: 90.9 in
      interior:
        seating_capacity: 2
      features:
        limited-slip-differential: standard
        heated-seats-front: optional

    variants:
      - slug: soft-top-6mt
        name: Soft Top 6MT
        body: convertible-2dr-soft         # from data/body-styles.yaml
        msrp: 33350
        powertrain:
          hybrid_type: none
          horsepower: 181 hp
          torque: 151 lbft
          engine: mazda-pe-vps-20-skyactiv  # from data/components/engines/
          transmission:
            name: 6-speed manual
            type: manual
            forward_gears: 6
          drivetrain:
            name: RWD with LSD
            type: rwd
        exterior:
          curb_weight: 2381 lb
        performance:
          zero_to_60_mph: 5.7
        efficiency:
          - cycle: epa
            mpg_city: 26
            mpg_highway: 34
            mpg_combined: 29
```

---

## Units: write what your source printed

Do not pre-convert. Write the number as it appears in the brochure, with its unit:

```yaml
length: 177.9 in       # US brochure
length: 4519 mm        # European brochure
curb_weight: 4627 lb
curb_weight: 2099 kg
cargo_behind_second: 41.8 cuft
displacement: 1998 cc
horsepower: 181 hp
horsepower: 135 kw
torque: 205 nm
```

The loader converts using exact factors. This matters for review as much as for correctness: a reviewer can hold your source next to the diff and check it digit for digit, which they cannot do if you converted first.

Accepted units: `mm cm m in ft` · `l ml cc cuft galus` · `kg g lb t` · `kph mph` · `hp kw ps` · `lbft nm` · `psi bar` · `deg`

---

## Trims vs variants — the distinction that matters

A **trim** is what the marketing department sells you: "GT3", "XLT", "Long Range AWD".

A **variant** is a specific buildable combination that has its own specifications — a body style, a powertrain, a transmission, a drivetrain.

Split into separate variants whenever any of these differ:

- body style or roof (coupe vs cabriolet vs targa)
- engine
- transmission (a manual and an automatic have different weights and EPA figures)
- drivetrain (RWD vs AWD)

Do **not** create a variant for a paint colour, a wheel choice, or an option package. Those are `features` and `packages`.

Use `defaults:` on the trim for everything shared. Beyond saving typing, it stops the specs of sibling variants drifting apart when someone later corrects only one of them.

---

## Features

Every feature must already exist in [`data/features.yaml`](../data/features.yaml). This is deliberate: a curated vocabulary is the only thing standing between us and forty spellings of "massaging seats".

```yaml
features:
  heated-seats-front: standard
  massage-seats-front:
    availability: package
    package: lounge-package
    price: 1200
  infotainment-screen-size:
    availability: standard
    value: 12.3
```

Availability values: `standard` · `optional` · `package` · `dealer_installed` · `late_availability` · `unavailable`.

The distinction is not pedantry — "massage seats are standard" and "massage seats are a $1,200 option" are different answers to a buyer's question, and both are searchable.

**Adding a new feature** to the catalog is welcome. Add it in the same pull request, in the right category. Only set `search_bit` if it is something people will genuinely filter on; there are only 128 and they are never reused. If you are unsure, leave it out — the feature still works, just via a join instead of a bitmask.

---

## Components: reference, don't retype

Engines, transmissions and axles live in `data/components/` and are shared. If the engine you need already exists, reference it by slug:

```yaml
engine: porsche-9a1-40-gt3
```

If it does not, you may define it inline, and the build will hoist it into the shared catalog automatically:

```yaml
engine:
  slug: mazda-pe-vps-20-skyactiv
  name: 2.0L Skyactiv-G I4
  cylinders: 4
  layout: inline
  displacement: 1998 cc
  valves_per_cylinder: 4      # valves_total is derived: 4 x 4 = 16
  aspiration: naturally_aspirated
```

Prefer adding it to `data/components/engines/<make>.yaml` when you know it is shared across models. One row means one place to fix a typo, and it makes "every car that used the 2JZ-GTE" a single query.

**Power and torque go on the powertrain, not the engine.** The same physical engine is calibrated differently in different cars.

---

## Sourcing

Every pull request should say where the numbers came from. In the PR description is fine; in the file is better:

```yaml
sources:
  - url: https://press.porsche.com/...
    title: 911 GT3 press kit
    publisher: Porsche AG
    document_type: press kit
    published_date: 2025-03-11
    confidence: manufacturer
```

Confidence levels, best to worst: `manufacturer` · `regulatory` · `measured` · `reputable_secondary` · `community` · `inferred` · `unverified` · `disputed`.

If you are contributing from memory or from a forum post, mark it `community`. That is genuinely useful — it is honest, and it is searchable, so people who need certainty can filter it out.

**Do not copy bulk data from a commercial specification site.** Those databases are protected compilations, and ingesting one would put the whole project at risk. Manufacturer press kits, brochures, owner's manuals and regulatory filings are the right sources.

---

## Things that will get a PR sent back

- **Guessed numbers.** Omit rather than estimate. A NULL is honest; a wrong figure is worse than nothing because it looks authoritative.
- **Pre-converted units.** Write what the source said.
- **A new feature slug that duplicates an existing one.** Search `data/features.yaml` first.
- **One PR covering forty cars.** Nobody can review that. One model, or one make's single year, is a good size.
- **Mixed EPA and WLTP figures in one efficiency block.** They are separate entries with different `cycle:` values.
- **Marketing text in `notes`.** Notes are for facts that don't fit a field, not for prose about driving dynamics.

---

## Running the checks

```bash
npm run validate          # schema only, fast, writes nothing
npm run build:db          # full build, writes dist/allcars.sqlite
npm run verify -w @allcarsdb/etl   # run real searches against your build
```

Validation errors point at the file and the path within it:

```
data/vehicles/mazda/mx-5/2025.yaml
  error at trims.0.variants.0.body: Unknown body style "convertible-2door"
  error at trims.0.variants.0.powertrain.engine.layout: "boxer6" is not a valid
    engine_layout. Valid values: inline, v, flat, w, rotary, vr, single, radial, none
```

---

## Where to start if you want to help but have no specific car in mind

The build produces a prioritised list of missing fields for cars already in the database. Once the API is running:

```
GET /v1/gaps
```

These are small, concrete, verifiable gaps in cars that already exist in the dataset — the easiest possible first contribution.
