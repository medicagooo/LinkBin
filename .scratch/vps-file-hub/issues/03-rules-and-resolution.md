# 03: Rules — configure directories, and see them resolve against a real machine

**What to build:** The operator adds directory patterns — some for every machine, some for one machine
only — includes and excludes, and then tests a machine and sees **which files each rule actually
matched**. This turns the existing connection test from "can I reach it" into "is my configuration
right".

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] A rule can be added for one machine only, and a rule can be added that applies to every machine.
- [ ] An exclusion beats an inclusion, so a whole directory can be collected while one file inside it is skipped.
- [ ] Rules can be listed, and removed, without a collection ever having run.
- [ ] Testing a machine reports, per applicable rule, either the files it matched or a clear reason it could not be resolved.
- [ ] A rule whose directory part contains a wildcard is reported as needing the collection step, rather than being shown as an empty match — an empty match and an unresolvable rule must not look the same.
- [ ] A pattern that is not an absolute path is refused with an explanation.
- [ ] A rule referring to a machine that does not exist is refused.
- [ ] Adding a rule identical to one that already exists does not create a duplicate.
- [ ] Testing remains read-only on the machine: it lists and stats, and writes nothing.
- [ ] Tests cover: global versus per-machine scope, exclusion winning over inclusion, the wildcard case, the empty-directory case, and a machine that refuses the connection.
