# ssh-probe — the prototype moved to the repository root

The probe Worker now lives at the **repository root** (`src/index.ts`, `wrangler.jsonc`,
`package.json`), because Cloudflare Workers Builds deploys from a root directory and the deployed
Worker is what the experiment needs. This directory keeps only the write-up.

- **[HANDOFF.md](./HANDOFF.md)** — the self-contained execution handoff: the question, scope, what is
  proven versus unproven, the ordered blockers, the exact experiment, pass/fail, and the next action
  at either outcome.
- **[README.md](./README.md)** — the original rationale, the `edgeport`-not-`ssh2` reason, the routes,
  and the pass/fail rule.

Decision context: [`.scratch/vps-file-hub/STATE.md`](../../.scratch/vps-file-hub/STATE.md)
(decisions **D14**, **D21–D27**).

This prototype is still **disposable and never merged as production code**: it is honest scaffolding
that exists to answer one question, and it is kept as a primary source so the implementation tickets
can point back at what was actually proven.

> The earlier note that this branch "never merges to main" is superseded: the probe had to reach
> `main` because Workers Builds deploys from the connected GitHub repository. It remains a probe,
> clearly labelled as such.
