# The data

Three CSV files. They are the source of truth — the database on the site is
rebuilt from these on every merge, so a fix here is a fix everywhere.

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
| `Code` | text | Your handle for this engine. Used only to reference it from `ymm_engines.csv` — it is not stored in the database. Must be unique. |
| `Layout` | text | `Inline`, `V`, `Flat`, `W`, `Rotary` |
| `Cylinders` | whole number | |
| `CC_Displacement` | whole number | Cubic centimetres. A 3.0-litre engine is `2981`, or whatever it actually displaces — not `3000` unless that is the real figure. |
| `Aspiration` | text | `Naturally Aspirated`, `Turbocharged`, `Twin-Turbocharged`, `Supercharged` |
| `Fuel_Type` | text | `Gasoline`, `Diesel`, `E85`, `Hydrogen` |
| `Compression_ratio` | text | Written as published: `10.5:1` |
| `Fuel_delivery` | text | `Direct Injection`, `Port Injection`, `Carburettor` |

```csv
Code,Layout,Cylinders,CC_Displacement,Aspiration,Fuel_Type,Compression_ratio,Fuel_delivery
porsche-4.0-na-flat6,Flat,6,3996,Naturally Aspirated,Gasoline,13.3:1,Direct Injection
```

A good `Code` is readable and specific: `porsche-4.0-na-flat6`, not `engine1`.

Every column except `Code` may be left blank if you do not know it. Blank means
*unknown*, and a car with an unknown value is excluded from filters on it —
which is why guessing is worse than leaving it empty.

There is **no fixed list** of layouts or fuel types. The site builds its
dropdowns from whatever is actually in the data, so consistency matters: use
the same spelling as the existing rows rather than inventing a new one.

---

## `ymm_engines.csv`

Which engines were available in which vehicle-year. This is the file that does
the real work — it is what makes "2026 Porsche 911 with the 3.0 twin-turbo" a
searchable thing.

| Column | Type | Notes |
|---|---|---|
| `Make`, `Model`, `Year` | | Must already exist in `year_make_model.csv` |
| `Engine_Code` | text | Must match a `Code` in `engine_specs.csv` |

```csv
Make,Model,Year,Engine_Code
Porsche,911,2026,porsche-4.0-na-flat6
Porsche,911,2026,porsche-3.0-tt-flat6
```

Both sides are checked. A typo produces an error naming the line, not a
phantom car that shows up in searches as a near-duplicate of the real one.

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
