-- Supports the storage-budget measurement.
--
-- Why this exists as a separate migration rather than part of 0001: the budget query is new, and a
-- schema file that has already been applied elsewhere must not change, because the CLI records a
-- migration by filename in `d1_migrations`. Adding statements to 0001 would make two deployments
-- claim the same version with different contents.
--
-- The query it supports aggregates the whole `objects` table to answer "how many bytes is this
-- store holding". `idx_objects_hash` and `idx_objects_host_path` do not help that, and the table is
-- expected to grow to tens of thousands of rows within a 10 GB budget.
--
-- Every statement stays `IF NOT EXISTS` so re-applying the schema is safe. Note that D1 rejects
-- `PRAGMA` and `BEGIN` locally (see docs/research and decision D20), so neither appears here.

CREATE INDEX IF NOT EXISTS idx_objects_usage ON objects (size_bytes, deleted_at, superseded_by);
