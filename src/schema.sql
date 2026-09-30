-- Local design registry schema (SQLite + FTS5)
-- Applied by src/db.ts at startup. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,             -- Format: "author/slug"
    name TEXT NOT NULL,
    author TEXT NOT NULL,
    slug TEXT NOT NULL,
    category TEXT,                   -- 'components', 'blocks', 'themes', 'apps'
    description TEXT,
    dependencies TEXT,              -- JSON stringified array of npm packages
    registry_dependencies TEXT,     -- JSON stringified array of other shadcn components
    files TEXT,                     -- JSON stringified array of { name, content, type }
    tailwind_config TEXT,           -- JSON stringified custom tailwind rules if present
    css_vars TEXT,                  -- JSON stringified CSS variables if present
    raw_json TEXT NOT NULL,         -- Complete raw registry payload
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_components_author ON components(author);
CREATE INDEX IF NOT EXISTS idx_components_category ON components(category);
CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);

-- FTS5 full-text index over the components table.
--
-- NOTE: this build of SQLite (bundled with better-sqlite3 11.10.0) does NOT
-- support FTS5 external-content special commands — the 'delete' and 'rebuild'
-- command forms fail to parse ("near '.'"). So we use a NON-external FTS5
-- table that stores its own copy of the indexed columns (id, name, author,
-- description) and keeps it in sync with the components table via plain-SQL
-- triggers. The FTS table is the search index; `components` remains the
-- source of truth for full records (files, dependencies, raw_json, etc.).
CREATE VIRTUAL TABLE IF NOT EXISTS components_fts USING fts5(
    id,
    name,
    author,
    description
);

-- Keep the FTS index in sync with every row change using plain SQL (no FTS5
-- special commands), so search is always current without a manual rebuild.
CREATE TRIGGER IF NOT EXISTS components_ai AFTER INSERT ON components BEGIN
    INSERT INTO components_fts(rowid, id, name, author, description)
    VALUES (new.rowid, new.id, new.name, new.author, new.description);
END;

CREATE TRIGGER IF NOT EXISTS components_ad AFTER DELETE ON components BEGIN
    DELETE FROM components_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS components_au AFTER UPDATE ON components BEGIN
    DELETE FROM components_fts WHERE rowid = old.rowid;
    INSERT INTO components_fts(rowid, id, name, author, description)
    VALUES (new.rowid, new.id, new.name, new.author, new.description);
END;
