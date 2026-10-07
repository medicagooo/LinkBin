# 03: Rules — configure directories, and see them resolve against a real machine

**What to build:** The operator adds directory patterns — some for every machine, some for one machine
only — includes and excludes, and then tests a machine and sees **which files each rule actually
matched**. This turns the existing connection test from "can I reach it" into "is my configuration
right".

**Blocked by:** 02.

**Status:** resolved

**Committed in** `3c6ebf1`. 23 tests for this ticket, 65 across the suite, all offline.

- [x] A rule can be added for one machine only, and a rule can be added that applies to every machine.
- [x] An exclusion beats an inclusion, so a whole directory can be collected while one file inside it is skipped. Verified as an **outcome**, not just as ordering: with the real evaluations in hand, the excluded file is absent from what would be collected. Both directions are covered, per-machine exclusion over global inclusion and the reverse.
- [x] Rules can be listed, and removed, without a collection ever having run.
- [x] Testing a machine reports, per applicable rule, either the files it matched or a clear reason it could not be resolved.
- [x] A rule whose directory part contains a wildcard is reported as needing the collection step, rather than being shown as an empty match — an empty match and an unresolvable rule must not look the same.
- [x] A pattern that is not an absolute path is refused with an explanation.
- [x] A rule referring to a machine that does not exist is refused.
- [x] Adding a rule identical to one that already exists does not create a duplicate.
- [x] Testing remains read-only on the machine: it lists, stats and runs a fixed set of identifying commands, and writes nothing.
- [x] Tests cover: global versus per-machine scope, exclusion winning over inclusion, the wildcard case, the empty-directory case, and a machine that refuses the connection.

## Comments

**A real defect, and it was the dangerous kind.** `rulesForHost` ordered by `is_exclude` **ascending**
while its own comment claimed exclusions are evaluated first. The flag is `1` for an exclusion, so
ascending put inclusions first — precisely the opposite, and the one ordering that makes an exclusion
useless. It is now `DESC`, with a secondary sort on the pattern so the order is deterministic rather
than depending on which row the database happens to return first for two rules created in the same
millisecond.

That comment was the reason to distrust the code rather than the test: a comment asserting a property
the code does not have is worse than no comment, because it stops the next reader from checking.

**A second defect, in configuration rather than code.** `.dev.vars` still held `PROBE_HOST`,
`PROBE_USER`, `PROBE_PORT` and `PROBE_PASSWORD` — credentials for the diagnostic routes that were
deleted. Dead configuration pointing at a removed capability is how a removed capability comes back:
the values were still there for anything that read them, and the endpoint they belong to is exactly the
exposure the project already suffered once. They were replaced with the `SSH_MASTER_KEY` that local
development and tests actually need. The new key is git-ignored and verified absent from the tracked
tree.

**The seam.** Rule resolution now goes through a narrow `RemoteHost` port — `list`, `stat`, `read`, plus
an optional `exec` used only for identification. Tests substitute the machine through a test-only
environment binding that production never sets, and nothing in production constructs a fake. This is
what makes a machine-absent test possible at all, since local development cannot reach one.

**One thing deliberately left undone.** Excluded files are not yet *recorded* as skipped, only omitted.
The criterion asks that an exclusion win, which it now does; reporting skips belongs with the receipts
in ticket 09, where "files deliberately not collected" has to be explainable without re-reading the
rules as they were at the time.
