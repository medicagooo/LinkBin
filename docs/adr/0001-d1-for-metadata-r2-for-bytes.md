# Metadata in D1, file bytes in R2 — and D1 transactions are not assumed

The project was originally described as storing files "in a non-relational database". That wording is
retired: metadata lives in **D1**, which Cloudflare documents as SQLite-based and therefore
relational, and file bytes live in **R2** object storage. Splitting them this way is what makes ranged
reads, resumable downloads and free egress available, and it keeps D1's hard ceilings (10 GB per
database, 2 MB per row, 100 columns) from being spent on file content.

The second half of this decision is a constraint, not a preference: **D1 must be treated as having no
transactions.** Cloudflare's own wording is "D1 operates in auto-commit"; the only documented atomic
unit is a single `db.batch()` call, and `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` appear nowhere
in the D1 documentation. Probing local D1 confirms it — `BEGIN` is rejected outright with
`D1_EXEC_ERROR ... not authorized`, while a failing `db.batch()` genuinely rolls back every statement
in it.

Consequence: every multi-step state transition in this system (a Collection, a Multipart Session)
must be **idempotent, conditionally written, resumable, and cleaned up by compensating actions**. No
design may assume that several statements succeed or fail as one unit.

See `docs/research/cloudflare-platform-limits.md` §6–7, §11.3, §11.9 for the cited limits.
