-- Receipts for collection runs, the importance flag, and the record of what a derived object was
-- built from.
--
-- Why these three together: they are the shared groundwork for three separate later features
-- (scheduled collection, the storage budget, and merging), and none of them belongs to a single
-- feature's vertical slice. Splitting them across tickets would make each of those tickets carry
-- unrelated schema work.
--
-- Constraints observed, as in 0001:
--   * D1 is auto-commit; the only atomic unit is one `db.batch()`. Every statement below is
--     independently repeatable and none of them assumes a surrounding transaction.
--   * Local D1 rejects `PRAGMA` and `BEGIN`, so neither appears.
--   * Rows are capped at 2 MB, which is why a run's problems are rows rather than one long column.

-- One row per collection run. A run covers one machine's incremental scan, so this is where
-- "did it run, did it finish, and what did it do" is answered.
--
-- `cursor_json` holds the resume position. It is JSON rather than columns because the position is
-- internal to the collector and nothing queries into it; the columns that ARE queried (host, state,
-- time) are real columns.
CREATE TABLE IF NOT EXISTS collection_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id       TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    state         TEXT NOT NULL DEFAULT 'running',
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    cursor_json   TEXT,
    stored_count  INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    bytes_stored  INTEGER NOT NULL DEFAULT 0
);

-- Newest-first listing is the primary read; the interface always wants the latest run per machine.
CREATE INDEX IF NOT EXISTS idx_runs_host_started ON collection_runs (host_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_state ON collection_runs (state);

-- One row per file that was NOT successfully handled, with the reason. Successful files are
-- deliberately absent: this is a list of problems, not a log, and a log would grow without bound
-- and bury the thing the operator is looking for.
CREATE TABLE IF NOT EXISTS collection_issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
    host_id     TEXT NOT NULL,
    path        TEXT,
    kind        TEXT NOT NULL,
    reason      TEXT NOT NULL,
    size_bytes  INTEGER,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_run ON collection_issues (run_id);
CREATE INDEX IF NOT EXISTS idx_issues_host ON collection_issues (host_id, created_at DESC);

-- The importance flag, as its own table rather than a column on `objects`.
--
-- Why a table: adding a column is the one change a migration cannot make repeatable. `CREATE ... IF
-- NOT EXISTS` is naturally idempotent, but a repeated `ALTER TABLE ... ADD COLUMN` is an error, and
-- the database offers no `ADD COLUMN IF NOT EXISTS`. That mattered because applying the schema twice
-- must be safe — the bootstrap promises it, and the interface exposes it as a button.
--
-- Presence of a row IS the flag, so nothing needs a default and no backfill is required for objects
-- that already exist. A foreign key with ON DELETE CASCADE means a reclaimed object cannot leave a
-- flag behind.
--
-- The trade is that reading importance joins, where a column would not. That is the right way round:
-- the join happens when the interface lists objects, while the write that must never silently fail is
-- the migration.
CREATE TABLE IF NOT EXISTS object_flags (
    object_id  INTEGER PRIMARY KEY REFERENCES objects (id) ON DELETE CASCADE,
    important  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

-- Eviction needs "the oldest unprotected objects" cheaply, and the budget needs total bytes.
-- Both read this; without it they scan every row. Important objects are excluded by checking
-- object_flags, so this index is ordered by age alone.
CREATE INDEX IF NOT EXISTS idx_objects_eviction ON objects (created_at);

-- What a derived object was built from. A derived object's content is computed from other objects,
-- so without this record there is no way to answer "is this still current" or to rebuild it after a
-- failure — the automatic re-run would have nothing to compare against.
CREATE TABLE IF NOT EXISTS object_sources (
    object_id        INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
    source_object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
    source_hash      TEXT NOT NULL,
    PRIMARY KEY (object_id, source_object_id)
);

CREATE INDEX IF NOT EXISTS idx_object_sources_source ON object_sources (source_object_id);

-- The operator's password, for the single-operator authentication.
--
-- One row, ever: this is a tool for one person, so there is no user table and no roles. The row's
-- presence IS "a password has been set", which is how the first-visit setup path knows to close
-- itself — and closing it is enforced by this row existing rather than by a flag someone could reset.
--
-- Only a salted, deliberately slow hash is kept. The plaintext is never stored, never logged, and
-- never returned, so a database leak does not hand over the interface. `iterations` is stored beside
-- the hash so the cost can be raised later without invalidating existing passwords.
--
-- `changed_at` is what makes "changing the password ends existing sessions" true. Sessions are signed
-- cookies rather than rows, so there is nothing to delete; instead a session carries the moment it
-- was issued, and any session issued before this timestamp is refused.
CREATE TABLE IF NOT EXISTS auth_secret (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    salt                TEXT NOT NULL,
    hash                TEXT NOT NULL,
    iterations          INTEGER NOT NULL,
    changed_at          TEXT NOT NULL,
    sessions_revoked_at TEXT NOT NULL,
    created_at          TEXT NOT NULL
);

-- Raised on failed sign-in attempts, so the one secret standing between the internet and the stored
-- machine credentials cannot be ground down by brute force.
--
-- One row per attempt rather than a counter, because a counter needs updating on both success and
-- failure and a failed update would silently stop limiting anything. A time-windowed count over rows
-- cannot get out of step with what actually happened.
CREATE TABLE IF NOT EXISTS auth_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    succeeded  INTEGER NOT NULL DEFAULT 0,
    remote     TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_at ON auth_attempts (at DESC);

-- Sharing: a link to one stored file, for a limited time, optionally behind a password.
--
-- `token` is the link's secret. It is stored in the clear because it is not a password being verified —
-- it IS the credential, and it has to be looked up. That is acceptable only because of what it does not
-- grant: a leaked database yields tokens for files, not access to the interface or to any stored machine
-- credential. It is the reason a share token must never be usable as a session, and why the two are
-- verified by completely separate code paths.
--
-- The share PASSWORD is different, and is stored only as a salted slow hash: a database leak must not
-- hand over every live share at once, which it would if the password were recoverable.
--
-- `revoked_at` is separate from `expires_at` on purpose, so a cancelled link can be refused distinctly
-- from an expired one. "This link expired" and "this link was cancelled" lead an operator to different
-- conclusions, and collapsing them would make one of those conclusions unavailable.
CREATE TABLE IF NOT EXISTS shares (
    token           TEXT PRIMARY KEY,
    object_id       INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
    password_salt   TEXT,
    password_hash   TEXT,
    password_iterations INTEGER,
    expires_at      TEXT NOT NULL,
    revoked_at      TEXT,
    created_at      TEXT NOT NULL,
    last_used_at    TEXT,
    use_count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shares_object ON shares (object_id);
CREATE INDEX IF NOT EXISTS idx_shares_expiry ON shares (expires_at);
