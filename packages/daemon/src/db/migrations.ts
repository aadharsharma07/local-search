// Ordered schema migrations. Migration N moves the database from user_version N to N+1.
// Never edit a migration that has shipped; append a new one instead.
//
// Design notes (see docs/ARCHITECTURE.md):
// - Text, chunks and vectors are keyed by content hash, so duplicates and renames are free.
// - files.state is the lifecycle state; every file is in exactly one state.
// - The vector table is created separately (ensureVectorTable) because its dimension depends
//   on the embedding model chosen in spike S3.

export const FILE_STATES = [
  "discovered",
  "skipped",
  "queued",
  "extracting",
  "failed",
  "indexed",
  "enriched",
  "stale",
  "tombstoned",
] as const;
export type FileState = (typeof FILE_STATES)[number];

const stateCheck = FILE_STATES.map((s) => `'${s}'`).join(", ");

export const MIGRATIONS: readonly string[] = [
  /* 0 -> 1: core schema */ `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE contents (
    hash         TEXT PRIMARY KEY,           -- sha256 hex of the file bytes
    text         TEXT NOT NULL,
    extractor    TEXT NOT NULL,              -- handler name and version
    content_date INTEGER,                    -- unix ms, a date found inside the content
    extracted_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE files (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,       -- absolute, normalized (NFC)
    content_hash TEXT REFERENCES contents(hash),
    size         INTEGER NOT NULL,
    mtime        INTEGER NOT NULL,           -- unix ms
    ctime        INTEGER,
    ext          TEXT NOT NULL,
    kind         TEXT NOT NULL,              -- document, image, code, text, other
    origin_url   TEXT,                       -- download source (Zone.Identifier / WhereFroms)
    state        TEXT NOT NULL DEFAULT 'discovered' CHECK (state IN (${stateCheck})),
    error        TEXT,
    skip_reason  TEXT,
    first_seen   INTEGER NOT NULL,
    deleted_at   INTEGER                     -- tombstone time; NULL while present
  ) STRICT;
  CREATE INDEX files_state ON files(state);
  CREATE INDEX files_hash ON files(content_hash);

  CREATE TABLE chunks (
    id           INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL REFERENCES contents(hash) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    pos          INTEGER NOT NULL,           -- char offset into contents.text
    page         INTEGER,
    text         TEXT NOT NULL,
    UNIQUE (content_hash, seq)
  ) STRICT;

  -- Keyword index over chunk text. Filename and title live on files and are joined at query time.
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='id',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE facet_values (
    id          INTEGER PRIMARY KEY,
    facet       TEXT NOT NULL CHECK (facet IN ('type', 'time', 'origin', 'content')),
    parent_id   INTEGER REFERENCES facet_values(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',    -- what the facet means (used to embed categories)
    UNIQUE (facet, parent_id, label)
  ) STRICT;

  CREATE TABLE file_facets (
    file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    facet_value_id INTEGER NOT NULL REFERENCES facet_values(id) ON DELETE CASCADE,
    confidence     REAL NOT NULL DEFAULT 1.0,
    source         TEXT NOT NULL CHECK (source IN ('rule', 'cluster', 'user')),
    PRIMARY KEY (file_id, facet_value_id)
  ) STRICT;

  CREATE TABLE records (
    content_hash TEXT PRIMARY KEY REFERENCES contents(hash) ON DELETE CASCADE,
    type         TEXT NOT NULL,              -- Receipt, TaxDoc, Invoice, ...
    fields_json  TEXT NOT NULL,
    model        TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE contexts (
    path_prefix TEXT PRIMARY KEY,            -- folder the description applies to
    description TEXT NOT NULL
  ) STRICT;

  CREATE TABLE jobs (
    id         INTEGER PRIMARY KEY,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,                -- extract, embed, record, ...
    priority   INTEGER NOT NULL DEFAULT 0,
    attempts   INTEGER NOT NULL DEFAULT 0,
    state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'failed')),
    error      TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (file_id, kind)
  ) STRICT;
  CREATE INDEX jobs_pending ON jobs(state, priority DESC, id);

  CREATE TABLE queries (
    id        INTEGER PRIMARY KEY,
    text      TEXT NOT NULL,
    plan_json TEXT,
    ts        INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE feedback (
    query_id INTEGER NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
    file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    action   TEXT NOT NULL CHECK (action IN ('open', 'open_folder', 'chip_remove', 'chip_swap', 'none')),
    rank     INTEGER,
    ts       INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX feedback_file ON feedback(file_id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
