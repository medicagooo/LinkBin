# HANDOFF — ssh-probe (fork-A prototype)

Written 2026-10-07. Objective: answer **one** question before the main feature is allowed to write a
spec. Self-contained: it assumes no access to the prior conversation.

## The question

> Can a Cloudflare Worker reach a real VPS over SSH, authenticate, list a directory, and read a
> file's bytes — within the paid-plan CPU budget?

Why it is a gate: the whole collection channel of `vps-file-hub` depends on the answer, and unlike
D1/R2 this path **cannot** be verified locally, because `wrangler dev` refuses outbound connections
to `localhost` and private addresses.

## In scope / out of scope

- **In scope**: proving the transport + auth + SFTP read chain against a real host, measuring CPU
  time, recording the verdict.
- **Out of scope**: production code, error-handling polish, metadata modelling, D1, the web UI,
  resumable collection, and anything that is not needed to answer the question.

## Repository state at handoff

| Item | Value |
|---|---|
| Repo | `D:\proj\LinkBin` — https://github.com/medicagooo/LinkBin (**PUBLIC**) |
| `main` | `2b0f80d` (registry only; contains **no** prototype code) |
| `prototype/ssh-probe` | `f46e599` — pushed, never merged, kept as a primary source |
| Working tree | clean |
| Registry | `.branch-records/ssh-probe/{state.json,events.jsonl}`; ledger `BRANCHES.md` |

## What is already proven

- **`edgeport` bundles and builds** for Workers: `wrangler deploy --dry-run` exits 0,
  total upload 209.75 KiB / gzip 48.74 KiB, R2 binding resolved. This establishes that
  `cloudflare:sockets` resolves under esbuild and that nothing in the dependency chain performs a
  runtime WASM compile at import time.
- **`ssh2` is not usable here**, and this is settled, not suspected: it compiles poly1305 WASM at
  module init and workerd forbids runtime WASM compilation
  ([mscdex/ssh2#1494](https://github.com/mscdex/ssh2/issues/1494), open). The maintainer has
  declined to support a non-Node socket API ([#1401](https://github.com/mscdex/ssh2/issues/1401)).
- Toolchain: bundled Node **v24.21.0**, pnpm **11.7.0**, wrangler **4.147.0**. `npm` does **not**
  exist here, so use `pnpm exec` / `pnpm dlx`. `node` is not on `PATH`.

**Not proven: any runtime success against a real host.** That is the entire point of the remaining
work.

## Blockers, in priority order

### 1. `wrangler login` — human, browser, cannot be delegated

Nothing can deploy until this is done. `%APPDATA%\xdg.config\.wrangler\config\default.toml` is
absent, confirming no stored credential.

```powershell
$nodeBin = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
$env:PATH = "$nodeBin;$env:PATH"           # required, or wrangler dies with "'node' is not recognized"
cd D:\proj\LinkBin\prototype\ssh-probe
pnpm exec wrangler login                    # opens a browser; callback is localhost:8976
pnpm exec wrangler whoami                   # must exit 0
```

If the browser callback cannot work, use `pnpm exec wrangler login --device` (prints a code for
`https://dash.cloudflare.com/oauth2/device`). Alternatively skip OAuth entirely and export
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

### 2. Target host details + credential — supplied by the user

`PROBE_HOST`, `PROBE_USER`, `PROBE_PORT` are plain vars in `wrangler.jsonc`. The password must be a
secret and must never be written to a file in this repo:

```powershell
"<password>" | pnpm exec wrangler secret put PROBE_PASSWORD
```

### 3. Deploy — a real but throwaway cloud resource

`pnpm exec wrangler deploy` creates the Worker `linkbin-ssh-probe` and the R2 bucket
`linkbin-ssh-probe`. This is a live account change and should be done deliberately.

## Then: the experiment itself

```powershell
pnpm exec wrangler tail        # in one terminal, to capture CPU time — the actual deliverable
curl "https://linkbin-ssh-probe.<subdomain>.workers.dev/exec"
curl "https://linkbin-ssh-probe.<subdomain>.workers.dev/list?path=/etc"
curl "https://linkbin-ssh-probe.<subdomain>.workers.dev/read?path=/etc/hostname"
```

Verify independently: hash the same remote file on the host and compare with the `sha256` in the
`/read` response.

**PASS** = `/list` returns real entries **and** the SHA-256s match **and** CPU time per invocation is
comfortably under the 30 s paid default.
**FAIL** = `exceededCpu` / error 1102, a cipher/protocol negotiation error (AES-GCM refused), or a
hash mismatch.

## After the result — regardless of outcome

1. Write the verdict into `.scratch/vps-file-hub/STATE.md`, including measured CPU time and the
   exact target (host, not credential).
2. Append an `ssh-probe` event recording the operation and its verified result.
3. If **PASS**: proceed to flow step 1 closure (no open questions left), then `to-spec`. Remove the
   deployed probe Worker and bucket only after the result is recorded.
4. If **FAIL**: do **not** proceed to `to-spec`. The alternatives are a minimal HTTP collector on
   the VPS (still Worker-initiated, and locally testable) or reverse push from the VPS. Record the
   failure as the reason.

## Constraints that remain in force

- Authorization: code, commits, and pushes to the remote are allowed. **Deploying real cloud
  resources and touching the user's VPS are not** without an explicit go-ahead for that step.
- **Read-only** on the target host: list and read only.
- Never commit credentials. `.dev.vars`, `.env`, `.wrangler/` are git-ignored at the repo root.
- The repository is **public**; the probe branch deliberately contains no host or credential.
- Do not assume D1 transactions exist anywhere; see `docs/adr/0001`.
