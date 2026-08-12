-- AllCarsDB schema.
--
-- Three source-of-truth tables, authored as CSV under data/ and loaded by
-- packages/etl. Column names are kept verbatim as specified for this project,
-- including `Index` -- which is a SQL keyword, so every reference to it has to
-- be quoted (`"Index"` or backticks). SQLite is case-insensitive about
-- identifiers, so `Compression_ratio` and `compression_RATIO` address the same
-- column; the casing here is the canonical spelling used in the CSV headers
-- and the JSON the API returns.
--
-- `Index` is declared INTEGER PRIMARY KEY, which in SQLite aliases the internal
-- rowid: values are assigned automatically and are unique. They never appear in
-- the source CSVs. Contributors reference rows by natural key -- (Make, Model,
-- Year) for a vehicle and a short code for an engine -- and the loader resolves
-- those to indices at build time.
--
-- Because indices are assigned rather than authored, they are stable for a
-- given dataset but NOT guaranteed to survive data being added: inserting an
-- engine renumbers the ones sorted after it. Anything that needs to outlive a
-- rebuild (links, citations) should key on Make/Model/Year, not on an index.

-- Every distinct vehicle-year. One row for "2026 Porsche 911", regardless of
-- how many engines or trims that car was offered with.
CREATE TABLE Year_Make_Model (
  "Index"    INTEGER PRIMARY KEY,
  Make       TEXT    NOT NULL COLLATE NOCASE,
  Model      TEXT    NOT NULL COLLATE NOCASE,
  Year       INTEGER NOT NULL,
  -- The manufacturer's platform/chassis code for this model year -- "992",
  -- "Mk7", "E46" -- not a marketing trim. Optional: most contributors will
  -- not know it, and a car is still a real, searchable row without it.
  Generation TEXT    COLLATE NOCASE,

  -- NOCASE on the text columns means this constraint also catches "porsche"
  -- vs "Porsche" as the same car rather than silently creating a second make
  -- that splits every search result in half. Generation is descriptive, not
  -- part of the key: it does not distinguish two rows the way Make/Model/Year
  -- does, so it stays out of the UNIQUE constraint.
  UNIQUE (Make, Model, Year)
);

CREATE INDEX idx_ymm_year  ON Year_Make_Model (Year);
CREATE INDEX idx_ymm_model ON Year_Make_Model (Model);

-- Every distinct engine. Shared across vehicles: the same engine fitted to a
-- Golf and a Jetta is one row referenced twice, not two near-identical rows
-- that drift apart when one of them gets corrected.
CREATE TABLE Engine_Specs (
  "Index"           INTEGER PRIMARY KEY,
  Layout            TEXT COLLATE NOCASE,
  Cylinders         INTEGER,
  CC_Displacement   INTEGER,
  Aspiration        TEXT COLLATE NOCASE,
  Fuel_Type         TEXT COLLATE NOCASE,
  Compression_ratio TEXT COLLATE NOCASE,
  Fuel_delivery     TEXT COLLATE NOCASE
);

CREATE INDEX idx_engine_shape ON Engine_Specs (Cylinders, Layout, Aspiration);
CREATE INDEX idx_engine_disp  ON Engine_Specs (CC_Displacement);
CREATE INDEX idx_engine_fuel  ON Engine_Specs (Fuel_Type);

-- Which engines were available in which vehicle-year. This is the many-to-many
-- join, and it is the row a search actually returns: "2026 Porsche 911 with the
-- 3.0 twin-turbo flat-6" is one row here.
CREATE TABLE YMM_Engines (
  "Index"      INTEGER PRIMARY KEY,
  YMM_Index    INTEGER NOT NULL REFERENCES Year_Make_Model("Index") ON DELETE CASCADE,
  Engine_Index INTEGER NOT NULL REFERENCES Engine_Specs("Index")    ON DELETE CASCADE,

  UNIQUE (YMM_Index, Engine_Index)
);

-- The UNIQUE above indexes (YMM_Index, Engine_Index), which serves lookups
-- starting from a vehicle. This one serves the reverse -- "what else used this
-- engine" -- which is the more interesting question of the two.
CREATE INDEX idx_ymm_engines_engine ON YMM_Engines (Engine_Index, YMM_Index);

-- Flattened query surface. A view rather than a materialised table: at this
-- shape the joins are index lookups, and a view cannot go stale between a data
-- change and a rebuild the way a copied table can.
--
-- Search_Text exists so free-text queries ("2026 porsche 911") can match across
-- all three identity columns without the caller knowing which is which.
-- LEFT JOIN, deliberately. A vehicle with no engine paired yet must still be
-- searchable by make, model or year -- this data will always contain
-- incomplete entries, and hiding a car entirely because one fact is missing
-- is a worse failure than showing it with a gap. combo_index falls back to
-- the negative of the vehicle's own index when there is no YMM_Engines row to
-- number it, which stays unique because a real pairing's index is always
-- positive; ymm_index and engine_index tell a caller which case it is
-- (engine_index is NULL exactly when nothing is recorded yet).
CREATE VIEW Search_View AS
SELECT
  COALESCE(ye."Index", -ymm."Index") AS combo_index,
  ymm."Index"           AS ymm_index,
  eng."Index"           AS engine_index,
  ymm.Make              AS Make,
  ymm.Model             AS Model,
  ymm.Year              AS Year,
  ymm.Generation        AS Generation,
  eng.Layout            AS Layout,
  eng.Cylinders         AS Cylinders,
  eng.CC_Displacement   AS CC_Displacement,
  eng.Aspiration        AS Aspiration,
  eng.Fuel_Type         AS Fuel_Type,
  eng.Compression_ratio AS Compression_ratio,
  eng.Fuel_delivery     AS Fuel_delivery,
  ymm.Year || ' ' || ymm.Make || ' ' || ymm.Model AS Search_Text
FROM Year_Make_Model ymm
LEFT JOIN YMM_Engines ye  ON ye.YMM_Index = ymm."Index"
LEFT JOIN Engine_Specs eng ON eng."Index" = ye.Engine_Index;

-- Build metadata, so the API can report what it is serving without needing the
-- repository it was built from.
CREATE TABLE build_info (
  key   TEXT PRIMARY KEY,
  value TEXT
);
