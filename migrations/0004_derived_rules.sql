-- Merge rules, and the record of which object a rule produced.
--
-- Why a rule is stored at all, rather than being a request parameter: a derived object's whole value is that it
-- can be REPRODUCED. "Which files, in what order, combined how" is the definition of the result, so if it lived
-- only in the request that created the object, the object could never be rebuilt, checked for staleness, or
-- explained to anyone — and the ticket's requirement that the interface record what a result was built from
-- would have nowhere to record it.
--
-- The rule is stored as one JSON document rather than exploded into columns. It is written and read as a unit,
-- it is never queried by its inner fields, and the shape is the merge engine's `MergeRule` — so columns would
-- duplicate that shape, drift from it, and need a migration every time the engine gains an option. The columns
-- that ARE separate are the ones something queries: the output name, which has to be unique, and the
-- timestamps.
--
-- `signature` is the rule's own definition plus nothing else. It deliberately does NOT include the sources:
-- see the second table.
CREATE TABLE IF NOT EXISTS derived_rules (
    id           TEXT PRIMARY KEY,
    output_name  TEXT NOT NULL,
    rule_json    TEXT NOT NULL,
    signature    TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- One live rule per output name. Two rules writing the same name would produce two objects claiming the same
-- identity, and "which one is current" would have no answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_derived_rules_name ON derived_rules (output_name);

-- Which rule produced which object.
--
-- A separate table, and the reason is the migration rule this project follows: migrations use only `CREATE`,
-- because `ALTER TABLE ADD COLUMN` cannot be applied twice and applying the schema twice is a promise the
-- interface makes. A column on `objects` would therefore be a one-way change that a future revision could not
-- undo, while this table expresses the same fact and can be dropped and recreated.
--
-- `rule_signature` is the rule's definition AND the hashes of the sources it was built from, captured when the
-- result was produced. Comparing it against a freshly computed value is what makes "is this derived object
-- current" a question with an answer rather than a guess: it changes when the rule changes, when a source's
-- content changes, and when a source appears or disappears, which is every way a derived object can go stale.
-- It is stored rather than recomputed because the sources may be evicted, and a stale result whose sources are
-- gone must still be recognisable as stale rather than indistinguishable from current.
CREATE TABLE IF NOT EXISTS derived_objects (
    object_id      INTEGER PRIMARY KEY REFERENCES objects (id) ON DELETE CASCADE,
    rule_id        TEXT NOT NULL REFERENCES derived_rules (id) ON DELETE CASCADE,
    rule_signature TEXT NOT NULL,
    built_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_derived_objects_rule ON derived_objects (rule_id);
