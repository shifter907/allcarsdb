-- =============================================================================
-- 0004_features.sql -- Feature catalog, options and packages
-- =============================================================================
--
-- Features are the open-ended half of the problem. Dimensions and engines have
-- a bounded set of attributes; equipment does not, and it grows every year
-- (nobody had a "curve speed adaptive cruise" column in 2005).
--
-- The design is a controlled catalog plus a link table -- an EAV, but a
-- disciplined one:
--
--   * `feature` is a curated vocabulary. Adding a row is a reviewed change,
--     which is what stops us accumulating "massaging seats", "massage seat",
--     "Multicontour Seat w/ Massage" as three different things.
--   * `variant_feature` records availability, not just presence. "Massage
--     seats are optional on this trim" and "standard" are different answers
--     to the same question, and a buyer needs both.
--
-- The critical index is (feature_id, availability_code, variant_id). A query
-- for "has massage seats" is then a covering index range scan yielding a
-- sorted variant_id list, and several such lists intersect cheaply. This is
-- why feature filtering stays fast even with thousands of features.
-- =============================================================================

CREATE TABLE feature (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,  -- 'massage-seats-front'
  name          TEXT    NOT NULL,         -- 'Front Massage Seats'
  category_code INTEGER NOT NULL,         -- enums.FeatureCategory
  description   TEXT,

  -- Most features are simply present/absent. Some carry a value:
  -- 'bool' | 'number' | 'text' | 'enum'
  value_type    TEXT    NOT NULL DEFAULT 'bool'
                CHECK (value_type IN ('bool','number','text','enum')),
  value_unit    TEXT,                     -- 'in', 'W', 'speakers'
  -- For value_type='enum', the permitted values as a JSON array.
  value_options_json TEXT,

  -- Features form a shallow tree: 'massage-seats-front' is a child of
  -- 'massage-seats'. Filtering on the parent matches any descendant, which
  -- keeps casual searches from needing to know the taxonomy.
  parent_id     INTEGER REFERENCES feature(id),

  -- Synonyms accepted by the importer and the search box, JSON array.
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  -- Show in the primary filter panel rather than behind "all features".
  is_common     INTEGER NOT NULL DEFAULT 0 CHECK (is_common IN (0,1)),
  first_seen_year INTEGER,
  notes         TEXT
);
CREATE INDEX idx_feature_category ON feature(category_code, is_common);
CREATE INDEX idx_feature_parent   ON feature(parent_id);

-- -----------------------------------------------------------------------------
-- Option packages
-- -----------------------------------------------------------------------------

CREATE TABLE option_package (
  id           INTEGER PRIMARY KEY,
  trim_id      INTEGER NOT NULL REFERENCES trim(id) ON DELETE CASCADE,
  code         TEXT,                      -- OEM order code: '1ZL', 'Z51', 'PDF'
  name         TEXT    NOT NULL,
  price_minor  INTEGER,
  currency     TEXT DEFAULT 'USD',
  description  TEXT,
  -- Some packages require another package first.
  requires_package_id INTEGER REFERENCES option_package(id),
  UNIQUE (trim_id, code)
);
CREATE INDEX idx_package_trim ON option_package(trim_id);

-- Which features a package brings with it.
CREATE TABLE package_feature (
  package_id INTEGER NOT NULL REFERENCES option_package(id) ON DELETE CASCADE,
  feature_id INTEGER NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
  value_num  REAL,
  value_text TEXT,
  PRIMARY KEY (package_id, feature_id)
);

-- -----------------------------------------------------------------------------
-- The link table
-- -----------------------------------------------------------------------------

CREATE TABLE variant_feature (
  variant_id        INTEGER NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
  feature_id        INTEGER NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
  availability_code INTEGER NOT NULL,     -- enums.Availability

  -- Populated when value_type != 'bool'
  value_num         REAL,
  value_text        TEXT,

  -- If availability is 'package', which one.
  package_id        INTEGER REFERENCES option_package(id),
  price_minor       INTEGER,              -- standalone option price
  currency          TEXT DEFAULT 'USD',

  confidence_code   INTEGER,              -- enums.Confidence
  notes             TEXT,
  PRIMARY KEY (variant_id, feature_id)
);

-- The workhorse index. Column order is deliberate: equality on feature_id,
-- then a range/IN on availability_code, then variant_id emitted in sorted
-- order for a merge intersection. Covering, so the table is never touched.
CREATE INDEX idx_vf_lookup ON variant_feature(feature_id, availability_code, variant_id);
-- Reverse direction, for rendering one variant's full equipment list.
CREATE INDEX idx_vf_variant ON variant_feature(variant_id, feature_id);

-- -----------------------------------------------------------------------------
-- Colours and trim materials
-- -----------------------------------------------------------------------------

CREATE TABLE paint_color (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  make_id      INTEGER REFERENCES make(id),
  oem_code     TEXT,
  hex          TEXT,                      -- '#B71C1C'
  finish       TEXT,                      -- 'metallic', 'pearl', 'matte', 'solid'
  is_special_order INTEGER DEFAULT 0 CHECK (is_special_order IN (0,1))
);

CREATE TABLE variant_paint (
  variant_id  INTEGER NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
  color_id    INTEGER NOT NULL REFERENCES paint_color(id) ON DELETE CASCADE,
  price_minor INTEGER,
  PRIMARY KEY (variant_id, color_id)
);

CREATE TABLE interior_trim (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  make_id      INTEGER REFERENCES make(id),
  oem_code     TEXT,
  material     TEXT,                      -- 'nappa leather', 'alcantara', 'cloth', 'vegan'
  color_family TEXT
);

CREATE TABLE variant_interior_trim (
  variant_id  INTEGER NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
  trim_id     INTEGER NOT NULL REFERENCES interior_trim(id) ON DELETE CASCADE,
  price_minor INTEGER,
  PRIMARY KEY (variant_id, trim_id)
);
