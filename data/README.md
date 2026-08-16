# The data

Sixteen CSV files. They are the source of truth — the database on the site is
rebuilt from these on every merge, so a fix here is a fix everywhere.

**Full, always-current documentation of every table and column lives on the
site itself: [allcarsdb.pages.dev/tables](https://allcarsdb.pages.dev/tables).**
That page is generated from the same registry the API uses, so it cannot drift
out of date the way a hand-written table can. This file covers the three core
files and the rules that apply to all of them.

## The one rule that explains the shape

Every spec attaches at the coarsest level where it is actually true, and no
coarser. Horsepower belongs to an engine, so it lives in `engine_specs.csv`.
Wheelbase belongs to a body, so it lives in `body_configs.csv`. But towing
capacity is only true of a whole combination — a 2018 Ram 3500 swings about
2,000 lb of tow rating on axle ratio alone — so it lives in `builds.csv` and
nowhere else.

`builds.csv` is deliberately **sparse**. A 2024 Silverado has roughly 1,700
valid configurations; nobody enumerates those, and nothing generates them. If
you know one real configuration, add one row.

Edit them in a spreadsheet (Excel, Google Sheets, Numbers) or a text editor.
Save as CSV, commit, open a pull request. CI checks the files and tells you the
exact line if something is wrong.

---

## `year_make_model.csv`

One row per vehicle-year. A 2026 Porsche 911 is one row no matter how many
trims or engines it came with.

| Column | Type | Notes |
|---|---|---|
| `Make`  | text | `Porsche`, `Ford`, `Volkswagen` |
| `Model` | text | `911`, `F-150`, `Golf GTI` |
| `Year`  | whole number | The model year, 1885–2100 |

```csv
Make,Model,Year
Porsche,911,2026
Ford,F-150,2026
```

Each `Make,Model,Year` combination may appear only once. Capitalisation does
not create a new car: `porsche` and `Porsche` are the same make, and listing
both is an error rather than a quiet duplicate that splits search results.

---

## `engine_specs.csv`

One row per distinct engine. Engines are shared: the same unit fitted to a Golf
and a Jetta is one row referenced twice, not two rows that drift apart when one
of them gets corrected.

| Column | Type | Notes |
|---|---|---|
| `Ref` | text | Your handle for this engine. Used only to reference it from `powertrains.csv` — it is not stored in the database. Must be unique. |
| `Manufacturer` | text | Who actually built the engine — not always the same as the vehicle's `Make`. The BMW-built B58 goes in as `BMW` even under a Toyota GR Supra row. |
| `Code` | text | The manufacturer's own designation for the engine family — `N54`, `L76`, `LQ9`. Not unique by itself: one code covers every variant of an engine. |
| `Named_Variant` | text | A named differentiator appended to `Code` — `B30` for the N54B30, or a tuner name like `Alpina` when that's how the variant is actually known. Most engines don't have one; leave it blank. |
| `Silent_Variant` | whole number | Only for the rare case where an engine has *no* name to tell variants apart — the same N54B30 code covering three different power levels across different cars, say. Number them `1`, `2`, `3`... in whatever order; the number itself is never shown or searchable, it only exists so each power level can be its own row. Leave blank unless you actually need two rows to otherwise-identical Manufacturer/Code/Named_Variant. |
| `Layout` | text | `Inline`, `V`, `Flat`, `W`, `Rotary` |
| `Cylinders` | whole number | |
| `CC_Displacement` | whole number | Cubic centimetres. A 3.0-litre engine is `2981`, or whatever it actually displaces — not `3000` unless that is the real figure. |
| `Aspiration` | text | `Naturally Aspirated`, `Turbocharged`, `Twin-Turbocharged`, `Supercharged` |
| `Fuel_Type` | text | `Gasoline`, `Diesel`, `E85`, `Hydrogen` |
| `Compression_ratio` | text | Written as published: `10.5:1` |
| `Fuel_delivery` | text | `Direct Injection`, `Port Injection`, `Carburettor` |
| `Horsepower` | whole number | SAE net hp, or the manufacturer's official published figure. Not a unit-conversion question — gross vs. net horsepower is a different test standard, so source the right figure rather than converting one you have. |
| `Torque_lbft` | whole number | Same sourcing rule as `Horsepower`. Pound-feet. |

```csv
Ref,Manufacturer,Code,Named_Variant,Silent_Variant,Layout,Cylinders,CC_Displacement,Aspiration,Fuel_Type,Compression_ratio,Fuel_delivery,Horsepower,Torque_lbft
porsche-4.0-na-flat6,Porsche,9A1,,,Flat,6,3996,Naturally Aspirated,Gasoline,13.3:1,Direct Injection,502,346
```

A good `Ref` is readable and specific: `porsche-4.0-na-flat6`, not `engine1`.

Every column except `Ref` may be left blank if you do not know it. Blank means
*unknown*, and a car with an unknown value is excluded from filters on it —
which is why guessing is worse than leaving it empty. `Manufacturer` and `Code`
are worth filling in when you're confident, but a real engine with neither is
still a real, searchable row.

There is **no fixed list** of layouts or fuel types. The site builds its
dropdowns from whatever is actually in the data, so consistency matters: use
the same spelling as the existing rows rather than inventing a new one.

---

## `powertrains.csv` and `ymm_powertrains.csv`

A vehicle is paired to a **powertrain**, not to an engine directly. That extra
step is what lets an electric car be described honestly: a BEV has a battery and
motors and genuinely no engine, which is a different fact from "nobody has
entered the engine yet". The loader rejects a powertrain typed `BEV` that names
an engine, because that is a contradiction rather than a gap.

`powertrains.csv`:

| Column | Type | Notes |
|---|---|---|
| `Ref` | text | Your handle for this powertrain. Must be unique. |
| `Powertrain_Type` | text | `ICE`, `Mild Hybrid`, `Full Hybrid`, `PHEV`, `EREV`, `BEV`, `FCEV` |
| `Engine_Ref` | text | A `Ref` from `engine_specs.csv`. Blank for a BEV. |
| `Battery_Ref` | text | A `Ref` from `batteries.csv`. Blank for a pure combustion car. |
| `Combined_Horsepower` | whole number | System output. For a plain ICE, leave blank — the engine's own figure already says it, and copying it creates a second place to correct. |

`ymm_powertrains.csv` connects them to cars — this is the file that makes
"2026 Porsche 911 with the 3.0 twin-turbo" a searchable thing:

```csv
Make,Model,Year,Powertrain_Ref
Porsche,911,2026,pt-porsche-3.0tt
```

Both sides are checked. A typo produces an error naming the line, not a
phantom car that shows up in searches as a near-duplicate of the real one.

---

## The rest

`transmissions.csv`, `drivetrains.csv`, `suspensions.csv`, `body_configs.csv`,
`seating_configs.csv`, `interior_dimensions.csv`, `trims.csv`, `builds.csv`,
`electric_motors.csv`, `batteries.csv`, `powertrain_motors.csv`,
`ymm_body_configs.csv`.

Every column of every one of these is documented on
**[the data model page](https://allcarsdb.pages.dev/tables)**, which also shows
the current contents. Rather than repeat all of it here and let the two drift
apart, that page is the reference.

Three things worth knowing before you open one:

- **The catalogs are shared.** A transmission, drivetrain or suspension is
  written once and referenced by every build that uses it. Check whether the
  one you need is already there before adding a near-duplicate.
- **`builds.csv` needs the other files first.** A build points at a trim, a
  body, a powertrain and so on; the loader will tell you exactly which
  reference it could not find and on which line.
- **Interior dimensions are per row of seats**, measured to SAE J1100. Leave
  `Seating_Config_Ref` blank unless the figure genuinely differs between, say,
  a bench and captain's chairs — in which case add one row for each.

---

## What about the `Index` column?

The database gives every row a unique `Index`, but you never write one. The
loader assigns them, which is why these files reference rows by name and code
instead of by number — otherwise two people adding a car in separate pull
requests would both claim the same ID.

## Checking your work

```bash
npm run validate
```

Parses everything and reports the first problem with a file and line number.
Nothing is written, so it is safe to run at any time.

---

## Reviewing dropped EPA matches

`data/epa_model_aliases.csv` holds human-confirmed name equivalences between
EPA's fuel-economy dataset and this catalogue.

The importer's automatic rules only ever join two spellings of one name — it
will match `F150` to `F-150`, but not `Sierra 1500` to `Sierra`, because that
second one is a judgement rather than a lookup. Roughly 24,500 EPA rows are
dropped for want of such a judgement.

To rescue them, add a line:

```csv
Make,EPA_Model,Our_Model
GMC,Sierra 1500 2WD,Sierra
Audi,A4 quattro,A4
```

An alias only renames the model. The model year still has to exist on its own,
so confirming a name is not a claim that we hold every year of it.

The dropped rows, each with its closest candidates and the evidence behind the
guess, are listed in the review sheet generated alongside this file. Names
already present here are skipped the next time that sheet is generated, so a
decision is made once.
