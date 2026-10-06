# LinkBin — agent instructions

Project root: `D:\proj\LinkBin`. Flow manual (authoritative for process): `D:\proj\idea-to-ship-flow.md`.

## What this project is

Collect files from designated paths on multiple VPS hosts, store them durably, and let other
devices download them. See `.scratch/vps-file-hub/STATE.md` for the current phase and locked
decisions, and `GLOSSARY.md` / `docs/adr/` for vocabulary and decisions once they exist.

## Agent skills

### Issue tracker

Issues and specs are tracked as **local markdown** under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label string equal to role name, written on each ticket's `Status:` line. See `docs/agents/triage-labels.md`.

### Domain docs

**Single-context**: root `GLOSSARY.md` plus root `docs/adr/`, created lazily. See `docs/agents/domain.md`.

## Startup / resume procedure

Follow `D:\proj\idea-to-ship-flow.md` **§0.2**. In short: read §1/§5/§6/§7 → confirm the project
root → mechanically scan the artifacts listed in §5.1 → reconcile with `.scratch/<feature>/STATE.md`
→ report current phase and next action in three lines → **wait for confirmation before acting**.

Hard rule: `STATE.md` is *intent*, on-disk artifacts are *fact*. On conflict, trust the artifacts
and correct `STATE.md`.

## Repo-specific constraints

- **Branch registry.** `BRANCHES.md` is a JSON ledger of business changes; `.branch-records/<task>/`
  holds `state.json` + `events.jsonl`. Register and predeclare an operation before transferring
  repository content. Bootstrap exception: the commit that first creates the registry is itself the
  pre-action commit.
- **Toolchain.** Node, pnpm, and Python are **not on `PATH`** on this machine. Use the harness-bundled
  runtimes reported by `load_workspace_dependencies`, or install none and avoid them. `git` 2.56 and
  `gh` (account `medicagooo`, `repo` scope, SSH protocol) are on `PATH`. Docker is absent.
- **Network.** The harness `web_fetch` tool **cannot be used** on this machine: public hostnames resolve
  to a non-public TUN address (observed `198.18.0.203`), so it is rejected before any request is made.
  This is *not* a lack of connectivity. **Proven workaround:** fetch the **`.md` variant** of a
  documentation page with `Invoke-WebRequest` (e.g. `https://developers.cloudflare.com/d1/platform/limits/index.md`),
  which returns clean Markdown plus a `dateModified`. `web_search` also works, but returns only
  sources and snippets. Therefore **never state a platform limit from memory** — cite it, or label it
  "unverified". Cited platform facts live in `docs/research/`.
- **No transactions.** D1 is SQLite-based and the project must not assume multi-statement atomicity.
  Use object-level atomicity, idempotent writes, and compensating actions.
- **Deployment is not VPS-side.** Nothing is installed on the collected hosts; the Worker reaches
  them over SSH itself (decision D14, verified against a real host on 2026-10-07). Do not reintroduce
  a "VPS-side agent" design: it was explicitly rejected. The old note about keeping an ingest API
  backward compatible for deployed agents therefore no longer applies — there are no deployed agents.
- **The Worker is already live.** `linkbin` is deployed with a provisioned D1 database and an R2
  bucket. `wrangler deploy` from this repository works and has been used; Workers Builds from the
  connected GitHub repository is the intended long-term path but is a dashboard step only a human can
  perform. See `README.md` for both. Never commit account-specific resource ids: `wrangler.jsonc`
  pins `bucket_name` and `database_name` and deliberately omits `database_id` (D38).
- **The deployed Worker has no authentication** (D35). Anyone who can reach it can manage hosts and
  their stored credentials. Worse, `/probe*` are unauthenticated remote-command and arbitrary-file-read
  endpoints that act on the first stored host with a credential, so **adding any host re-creates a
  real exposure** (D41). Do not set `PROBE_*` variables. Treat fixing the auth gap as a prerequisite
  for anything beyond private use.
- **Scale limits are fixed.** At most **50 hosts**, **100 MB** per file, and **10 GB total in R2**.
  The 10 GB figure is a capacity budget, so the system must measure and bound its own total bytes.
- **Single secret.** `SSH_MASTER_KEY` is the only deployment secret (D32); hosts and their credentials
  are runtime data encrypted into D1. It is write-once: replacing it makes every stored credential
  undecryptable. Adding a second deployment secret (for example an R2 API token for presigning) breaks
  this architecture on purpose — do not do it without reopening the decision.

## Concurrent sessions

More than one agent session may work in this repository at the same time, and that has already caused
a real incident: two sessions drew the same branch-registry event ids from their own counters, and the
de-duplication pass deleted two genuine records. Follow `.branch-records/FORMAT.md`: take the next id
**from the file**, treat a duplicate id as a hard error, never resolve a collision by preferring one
writer, and verify unique-id count after every write. The same applies to decision ids (`D<n>`) in
`STATE.md`. Uncommitted changes you did not make are another session's work — preserve them and stage
explicitly rather than using `git add -A`.

## Process notes

- Phase boundaries: keep steps 1–3 (grill → spec → tickets) in one unbroken context. Do not
  compact before `to-tickets`.
- Update `STATE.md` at the end of every step. Not doing so is the most expensive error in the flow.
