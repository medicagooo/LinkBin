-- Direct links follow the logical file (host/path), while existing shares pin one object version.
-- Revocation is retained as a fact; a new token can be issued for the same identity afterwards.
CREATE TABLE IF NOT EXISTS file_links (
    token TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_links_active ON file_links (host_id, path) WHERE revoked_at IS NULL;
