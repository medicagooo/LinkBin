# 05: First collection — one machine, one changed file, visible in the interface

**What to build:** The spine. A file on a machine is discovered, compared by content, stored, recorded,
and then visible in the interface attributed to the machine and path it came from. Running it twice
with nothing changed stores nothing the second time.

This is the first ticket where the product actually does its job, so it deliberately carries the first
real schema rather than leaving that to a ticket that delivers nothing a user can see.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] A file matching an applicable rule is stored, and its size, content hash and modification time are recorded with the machine and path it came from.
- [ ] The stored file appears in the interface under the machine and path it came from.
- [ ] Running collection again with no change on the machine stores nothing new and reports that nothing changed.
- [ ] Content, not timestamp, decides whether a file is new: touching a file without changing it re-transfers nothing, and an edit is detected even when the modification time did not move.
- [ ] A changed file supersedes its previous version rather than duplicating it, and the previous version stops being counted as the live one.
- [ ] Files matching no rule are not collected, and files matching an exclusion are not collected even when an inclusion also matches them.
- [ ] A file whose size is not reported by the machine is handled without being treated as zero bytes.
- [ ] A stored modification time is in whole seconds, matching the unit the machine reports, so that no mixed-unit timestamps can enter the store.
- [ ] A machine that cannot be reached, or whose credential is refused, produces a recorded failure and does not abort anything else.
- [ ] A file that disappears between discovery and reading is recorded as an issue rather than crashing the run.
- [ ] Every write is independently repeatable, because the database has no transactions; an interrupted run must not leave a half-recorded file that looks complete.
- [ ] Tests cover, through the HTTP edge with a substituted remote: unchanged file, changed file, superseded version, excluded file, missing size, unreachable machine, and a file vanishing mid-run.
