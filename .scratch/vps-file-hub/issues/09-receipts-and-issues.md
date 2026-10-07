# 09: Receipts — see what happened and why

**What to build:** The operator can look at a collection run and see when it ran, which machine it
covered, and its outcome, plus a list of every file that was not successfully stored with the reason
for each. "Why is this file not in the store" stops being a guess.

This matters most for the two ways a file legitimately does not arrive — too large, and refused for
capacity — because in both cases the system worked as designed and something the operator expected to
see is nonetheless absent.

**Blocked by:** 05, 08.

**Status:** 11 of 11 met and tested offline, WITH ONE QUALIFICATION that matters more than the count: **the read side is fully built and the write side does not exist.** Every criterion here is satisfied and asserted, but the assertions run against SEEDED rows. Nothing in the codebase inserts into `collection_runs` or `collection_issues`, because that writer belongs to the collection pipeline (05/08). So the feature is complete and correct as a record of runs, and there are no runs for it to record. The two open tickets that depend on this are 07's capacity-issue criterion and 13's 'reported as an issue' wording, both of which need the same writer.

- [x] Each run is recorded with its machine, start and end, outcome, and counts of stored, skipped and failed files: those are the `collection_runs` columns, and `summarizeRuns` reports them. A run that never finished reports no duration rather than inventing one.
- [x] Each file that was not successfully handled is recorded individually with its machine, path and reason — one `collection_issues` row per file, listed per run and filterable by machine. Asserted through the HTTP edge with seeded rows.
- [x] Capacity refusals appear as issues, with `capacity` listed in `DELIBERATE_KINDS` so a full store reads as a REASON rather than as a failure. Asserted directly: "mark a capacity refusal as deliberate, so a full store reads as a reason not as silence".
- [x] Files skipped for being too large appear as issues with their size, and are deliberately kept distinct from failures — a size skip needs a decision about the limit, a failure needs investigating, and collapsing them would hide which is which.
- [x] Errors returned by a machine are kept in the machine's own words, so a permission or authentication problem can be diagnosed without guessing. Long messages are truncated to a stated bound rather than refused or allowed to grow a row without limit.
- [x] The interface lists runs newest first and shows each run's counts. The order has a deterministic tie-break, so the list does not depend on which row the database returns first.
- [x] The interface lists the issues for a run — expanded in place from the run list — and `/api/issues` filters by machine.
- [x] A successful file is not recorded as an issue. Asserted explicitly through the route ("records nothing for a file that was stored"), because an issue list that quietly includes successes stops being a list of problems.
- [x] Issue rows are written independently, one statement per issue, so a run interrupted partway leaves the issues it had already produced. The read side is built for that case and tested against a run that never finished.
- [x] The number of issues for one run cannot grow a single stored row without bound: each issue is its own row, and the READS are bounded too — `/api/issues` and `/api/runs/detail` cap at 200. An adversarial audit found the detail route unbounded and it was fixed.
- [x] Tests cover all four: a run with mixed outcomes, two consecutive runs, a run that never finished, and an issue caused by capacity. 24 tests in `receipts.test.ts` and 19 through the HTTP edge in `receipt-routes.test.ts`.
