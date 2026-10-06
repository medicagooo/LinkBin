-- LinkBin schema.
--
-- Design constraints that shaped this file (see docs/adr/0001):
--   * D1 is documented as auto-commit. The only atomic unit is a single `db.batch()`. Nothing here
--     may assume that several statements succeed or fail together, so every write is written to be
--     safe to repeat.
--   * Local D1 is function-allowlisted: `PRAGMA` and `BEGIN` are rejected with SQLITE_AUTH, and
--     `sqlite_version()` is not callable. Do not add PRAGMA statements to migrations.
--   * Row limit is 2 MB and there are at most 100 columns, so credentials are stored as short
--     ciphertext strings, never as large blobs.

-- A machine files are collected from. `id` is a slug supplied by the caller and is ALSO the
-- additional-authenticated-data binding for the encrypted credential columns, so it must never be
-- rewritten after a credential is stored: changing it would make that credential undecryptable.
CREATE TABLE IF NOT EXISTS hosts (
    id                  TEXT PRIMARY KEY,
    label               TEXT NOT NULL,
    address             TEXT NOT NULL,
    port                INTEGER NOT NULL DEFAULT 22,
    username            TEXT NOT NULL,
    password_enc        TEXT,
    private_key_enc     TEXT,
    private_key_pass_enc TEXT,
    host_key_fingerprint TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosts_enabled ON hosts (enabled);

-- One collection rule per row. `host_id` NULL means a GLOBAL rule that applies to every host;
-- a non-NULL `host_id` scopes it to that host. That is the whole "configure once, or per host"
-- mechanism — no precedence flags needed, because the two sets are simply unioned at collection
-- time and an explicit per-host rule never has to fight a global one.
CREATE TABLE IF NOT EXISTS source_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id     TEXT REFERENCES hosts (id) ON DELETE CASCADE,
    pattern     TEXT NOT NULL,
    is_exclude  INTEGER NOT NULL DEFAULT 0,
    note        TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_rules_host ON source_rules (host_id);
CREATE INDEX IF NOT EXISTS idx_source_rules_enabled ON source_rules (enabled);

-- One row per stored file. `content_hash` is the SHA-256 of the content and is what makes
-- collection idempotent: re-seeing the same hash is a no-op, so a re-run converges instead of
-- duplicating. Version history is deliberately NOT kept in R2 (see decision D4/D15): a changed file
-- inserts a new row and supersedes the previous one, so the old object can be garbage-collected.
CREATE TABLE IF NOT EXISTS objects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id         TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    object_key      TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    content_hash    TEXT NOT NULL,
    mtime           INTEGER,
    superseded_by   INTEGER REFERENCES objects (id),
    deleted_at      TEXT,
    created_at      TEXT NOT NULL
);

-- The idempotency and lookup spine: one live row per (host, path).
CREATE UNIQUE INDEX IF NOT EXISTS idx_objects_live
    ON objects (host_id, path) WHERE deleted_at IS NULL AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_objects_hash ON objects (content_hash);
CREATE INDEX IF NOT EXISTS idx_objects_host_path ON objects (host_id, path);

-- A chunked upload in progress. This table exists because Cloudflare states plainly that R2
-- multipart state "needs to be kept track of somewhere outside of the Worker" (decision D8), and
-- because a Worker invocation cannot hold a socket open across requests.
--
-- `parts_json` holds the accepted [{partNumber, etag}] list. It is a JSON array rather than a child
-- table on purpose: R2 requires ALL parts to be the same size except the last, so the part list is
-- regular and small, and one row means one write per part instead of a write plus a join.
CREATE TABLE IF NOT EXISTS multipart_sessions (
    id              TEXT PRIMARY KEY,
    host_id         TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    object_key      TEXT NOT NULL,
    upload_id       TEXT NOT NULL,
    total_bytes     INTEGER NOT NULL,
    part_size       INTEGER NOT NULL,
    parts_json      TEXT NOT NULL DEFAULT '[]',
    state           TEXT NOT NULL DEFAULT 'open',
    content_hash    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_multipart_state ON multipart_sessions (state);
CREATE INDEX IF NOT EXISTS idx_multipart_lookup ON multipart_sessions (host_id, path);
