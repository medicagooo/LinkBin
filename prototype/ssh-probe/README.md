# ssh-probe — historical record

**This prototype has been absorbed into the Worker.** The SSH stack it proved now lives in
`src/index.ts` at the repository root, alongside the management API and UI. There is no separate
probe project any more; only the throwaway `/probe*` routes remain.

## What it was for

It answered one question before the main feature was allowed to write a spec (flow manual §2.3,
fork A):

> Can a Cloudflare Worker reach a real VPS over SSH, authenticate, list a directory, and read a
> file's bytes — within the paid-plan CPU budget?

Decision context: [`.scratch/vps-file-hub/STATE.md`](../../.scratch/vps-file-hub/STATE.md) —
decisions **D14** (collection channel) and **D21–D27** (the investigation that reshaped the approach).

## What it established

- **`edgeport` bundles and builds for Workers.** `cloudflare:sockets` resolves under esbuild, and
  nothing in the dependency chain performs a runtime WASM compile at import time.
- **`ssh2` is unusable here, and that is settled rather than suspected.** It compiles poly1305 WASM
  during module initialisation, and runtime WASM compilation is disallowed in workerd, so it dies
  with `CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder`
  ([mscdex/ssh2#1494](https://github.com/mscdex/ssh2/issues/1494), still open). The maintainer has
  declined to support a non-Node socket API
  ([#1401](https://github.com/mscdex/ssh2/issues/1401)).

## What is still unproven

**Any successful SSH connection to a real host from a deployed Worker.** Everything above was
established locally, which is exactly the gap this prototype existed to close. Until a real
connection succeeds, treat the collection channel as unvalidated.

The probe routes now exercise the **same encrypted-credential path the product uses**, which makes
them a better test than the original standalone version: add a host in the UI, then request
`/probe/exec`, `/probe/list?path=/etc`, and `/probe/read?path=/etc/hostname`. Compare the returned
SHA-256 against the same file hashed on the host.

**Delete the `/probe*` routes** once the verdict is recorded in
[`.scratch/vps-file-hub/STATE.md`](../../.scratch/vps-file-hub/STATE.md).
