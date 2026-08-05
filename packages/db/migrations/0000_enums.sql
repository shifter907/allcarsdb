-- =============================================================================
-- 0000_enums.sql -- Controlled vocabularies, materialized
-- =============================================================================
--
-- packages/schema/src/enums.ts is the source of truth. This table is a copy of
-- it inside the database, populated by the ETL on every build.
--
-- It exists so that:
--   * raw SQL against the artifact is readable ("what is aspiration 503?")
--   * the display projection can build "4.0L Naturally Aspirated flat-6"
--     entirely in SQL, without a round trip per row
--   * anyone who downloads the .sqlite dump gets a self-describing file, with
--     no need to read our TypeScript to decode it
--
-- Nothing writes to it except the build. Never join it on a hot query path --
-- the search index stores codes precisely so it does not have to.
-- =============================================================================

CREATE TABLE enum_label (
  enum_name  TEXT    NOT NULL,
  code       INTEGER NOT NULL,
  slug       TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  -- Compact form for composing into longer strings ("NA flat-6").
  short      TEXT,
  note       TEXT,
  deprecated INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0,1)),
  PRIMARY KEY (enum_name, code)
);
CREATE INDEX idx_enum_label_slug ON enum_label(enum_name, slug);

-- Build metadata, so a downloaded dump can be traced back to the commit that
-- produced it.
CREATE TABLE build_info (
  key   TEXT PRIMARY KEY,
  value TEXT
);
