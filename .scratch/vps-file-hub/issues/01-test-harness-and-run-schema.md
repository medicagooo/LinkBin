# 01: Test infrastructure and the schema for runs, issues and importance

**What to build:** The project can be tested offline, and the database is ready to record what a
collection run did and which objects are protected. Nothing changes for a user yet — this is the
prefactoring that makes every later ticket small.

Two things are genuinely shared and belong here rather than being smuggled into a feature ticket:

1. **A test harness that drives the Worker's HTTP edge** against its simulated bindings, with no
   network and no Cloudflare account. The seam is the Worker's own request/response surface, since
   that is already the deployment contract and needs no change to production structure.
2. **A remote host can be substituted in tests.** The remote cannot be reached from a local test —
   local development refuses outbound connections to private addresses, which the prototype
   confirmed — so the substitute is supplied through an environment binding that tests inject and
   production never sets. It must not become a production module.

The schema additions are the run receipts tables and the importance flag, because both are referenced
by more than one later ticket.

**Blocked by:** None (can start immediately).

**Status:** resolved

**Delivered in** `d8344ba`. Tests run offline in the Workers runtime; migration `0003` adds
`collection_runs`, `collection_issues`, `object_flags` and `object_sources`. Two real bugs were found
by tests while doing this — a migration splitter that executed comment prose, and a non-repeatable
`ALTER TABLE` — and both now have guards. The schema has **not yet been applied to the production
database**: deploying uploads code only and does not run migrations, so that is a separate action.

- [x] Tests run fully offline: no network access, no Cloudflare account, no credentials.
- [x] A test can drive the Worker's request/response edge against simulated storage and database bindings.
- [x] A test can substitute the remote host through an environment binding, and production carries no such binding and no fake implementation.
- [x] Schema can be created on a fresh database by re-running the existing schema step, and re-running it changes nothing.
- [x] Tables exist for one row per collection run and one row per file that was not successfully handled.
- [x] A stored object can be marked important and unmarked again.
- [x] Every schema statement remains independently repeatable, because the database has no transactions.
- [x] The existing repository guard still runs before a build.

**Note on the third criterion's first half.** The substitution point is declared (`env` carries no
fake in production) but nothing consumes it yet, because nothing collects yet. Ticket 05 is where it
first gets used; this ticket only guarantees the shape exists and that production cannot accidentally
acquire a fake.
