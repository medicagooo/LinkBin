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
- **Backward compatibility.** The VPS-side agents are deployed on machines this repo does not
  control. Once an ingest API ships, changes must stay backward compatible for older agents, and
  both old and new integration paths must be verified.

## Process notes

- Phase boundaries: keep steps 1–3 (grill → spec → tickets) in one unbroken context. Do not
  compact before `to-tickets`.
- Update `STATE.md` at the end of every step. Not doing so is the most expensive error in the flow.
