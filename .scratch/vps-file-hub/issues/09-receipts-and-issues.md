# 09: Receipts — see what happened and why

**What to build:** The operator can look at a collection run and see when it ran, which machine it
covered, and its outcome, plus a list of every file that was not successfully stored with the reason
for each. "Why is this file not in the store" stops being a guess.

This matters most for the two ways a file legitimately does not arrive — too large, and refused for
capacity — because in both cases the system worked as designed and something the operator expected to
see is nonetheless absent.

**Blocked by:** 05, 08.

**Status:** ready-for-agent

- [ ] Each run is recorded with its machine, start and end, outcome, and counts of stored, skipped and failed files.
- [ ] Each file that was not successfully handled is recorded individually with its machine, path and reason.
- [ ] Capacity refusals appear as issues, so a full store is visible as a reason rather than as silence.
- [ ] Files skipped for being too large appear as issues, with their size.
- [ ] Errors returned by a machine are kept in the machine's own words, so an authentication or permission problem can be diagnosed without guessing.
- [ ] The interface lists runs newest first and shows each run's counts.
- [ ] The interface lists the issues for a run, and the issues can be filtered by machine.
- [ ] A successful file is not recorded as an issue; the issue list stays a list of problems rather than a log of everything.
- [ ] Issue rows are written independently so that a run interrupted partway still leaves the issues it had already produced.
- [ ] The number of issues recorded for one run cannot grow a single stored row without bound, since stored rows have a hard size limit.
- [ ] Tests cover: a run with mixed outcomes, two consecutive runs, a run that never finished, and an issue caused by capacity.
