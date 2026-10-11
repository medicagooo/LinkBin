-- Optional source protocol metadata. Credentials remain encrypted in hosts.password_enc.
-- SMB is intentionally absent: a Worker can expose WebDAV over HTTPS, while an SMB listener
-- needs a native TCP server that this deployment does not have.
CREATE TABLE IF NOT EXISTS source_profiles (
    host_id           TEXT PRIMARY KEY REFERENCES hosts (id) ON DELETE CASCADE,
    protocol          TEXT NOT NULL CHECK (protocol IN ('webdav')),
    endpoint          TEXT NOT NULL,
    root_path         TEXT NOT NULL DEFAULT '/',
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
