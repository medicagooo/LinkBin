# 05: First collection — one machine, one changed file, visible in the interface

**What to build:** The spine. A file on a machine is discovered, compared by content, stored, recorded,
and then visible in the interface attributed to the machine and path it came from. Running it twice
with nothing changed stores nothing the second time.

This is the first ticket where the product actually does its job, so it deliberately carries the first
real schema rather than leaving that to a ticket that delivers nothing a user can see.

**Blocked by:** 04.

**Status:** 12 of 12 met and tested offline, through the HTTP edge with a substituted remote. Nothing here needs a machine: TEST_REMOTE stands in for the far end of the SSH connection, which is the only part that genuinely cannot be simulated locally. WHAT IS *NOT* VERIFIED: the real SSH path itself. connectRemote is exercised only by the resolution route's own tests against a substituted remote, and the actual socket work has never run - locally because cloudflare:sockets refuses private addresses, and on the deployment because its schema is unapplied. That is ticket 04's territory and it needs a host.

- [x] A file matching an applicable rule is stored, and its size, content hash and modification time are recorded with the machine and path it came from. Asserted through the HTTP edge: the row carries an 11-byte size, a real 64-hex-character SHA-256 of the bytes, and the machine-reported mtime in whole seconds.
- [x] The stored file appears in the interface under the machine and path it came from. Asserted by reading `GET /api/objects` after a collection rather than by inspecting the table.
- [x] Running collection again with no change stores nothing new and reports that nothing changed: the second run reports `stored: 0` and `unchanged: 1`, and writes NO issue — not changing is the normal case for an incremental scan, and recording it would turn the issue list into a log of everything.
- [x] Content, not timestamp, decides whether a file is new. Both directions are asserted at the edge: a touched file with a changed mtime re-transfers nothing, and an edit that leaves the mtime untouched is still detected.
- [x] A changed file supersedes its previous version rather than duplicating it, and the previous version stops being counted as the live one. Asserted through the edge: one live row, holding the newest bytes, with the older row pointing at it through `superseded_by`.
- [x] Files matching no rule are not collected, and files matching an exclusion are not collected even when an inclusion also matches them — the second asserted at the edge, because collecting an explicitly excluded file is the worst thing this configuration can do.
- [x] A file whose size is not reported by the machine is handled without being treated as zero bytes. Asserted with a machine whose `stat` returns no size: the stored row carries the real length read from the stream, and the bytes are intact. A zero would have meant silent data loss.
- [x] A stored modification time is in whole seconds, matching the unit the machine reports, so no mixed-unit timestamps can enter the store. Asserted directly: a machine reporting 1700000123 stores 1700000123.
- [x] A machine that cannot be reached produces a RECORDED failure and does not abort anything else: the connection failure writes an `unreachable` issue, closes the run, and answers 200 with `connected: false` rather than throwing. A rule whose directory cannot be read is likewise recorded in the machine's own words while the rest of the run finishes.
- [x] A file that disappears between discovery and reading is recorded as an issue rather than crashing the run — asserted with a machine that lists a file, stats it, and then fails the read, which is the real sequence for a rotated log. The other file in the same run is still stored.
- [x] Every write is independently repeatable, and the ORDER is chosen so an interruption is recoverable: the run row is opened first so it is visibly unfinished, each issue is written the moment it is known, and an object row is written only after its bytes are durable. The unrecoverable state — a live row with no bytes — is asserted NOT to occur when a read fails: no row, and nothing in the bucket under that key.
- [x] Tests cover all seven through the HTTP edge with a substituted remote, across 15 end-to-end cases plus 11 planning cases in `collect.test.ts`. The substitute is `TEST_REMOTE`, a test-only binding production never sets.
