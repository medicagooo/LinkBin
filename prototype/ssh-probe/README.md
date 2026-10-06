# ssh-probe — disposable prototype

**Answers one question:** can a Cloudflare Worker reach a real VPS over SSH, authenticate, list a
directory, and read a file's bytes — within the paid-plan CPU budget?

This is the fork-A prototype required by `D:\proj\idea-to-ship-flow.md` §2.3 before the main
feature may write a spec. It is **not production code and is never merged to `main`.** It is kept
on branch `prototype/ssh-probe` as a *primary source* so the implementation tickets can point
back at what was actually proven.

Context and the decisions it serves: [`.scratch/vps-file-hub/STATE.md`](../../.scratch/vps-file-hub/STATE.md)
(decisions **D14**, **D21–D27**).

## Why it must be deployed rather than run locally

`wrangler dev` refuses outbound connections to `localhost` and private addresses, so no local SSH
server can stand in for the real target. **The real answer requires a deployed Worker.** Local
development is only useful as a syntax/bundle check.

## Why `edgeport` and not `ssh2`

`ssh2` cannot even be imported in `workerd`: it compiles poly1305 WASM during module
initialisation, and runtime WASM compilation is disallowed there, so it dies with
`CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder`
([mscdex/ssh2#1494](https://github.com/mscdex/ssh2/issues/1494), still open). The maintainer has
declined to support a non-Node socket API
([#1401](https://github.com/mscdex/ssh2/issues/1401)). `edgeport` is a Workers-native pure-TS stack
built directly on `cloudflare:sockets`.

## Deliberate limits, so a failure is informative

- **Read-only against the target host.** It only lists and reads. It never writes, deletes, renames
  or changes permissions, and it opens no interactive shell or port forward.
- **AES-GCM only.** The cipher is asserted to `aes256-gcm@openssh.com` (WebCrypto-backed) rather
  than offered as a preference. If the server refuses, the probe fails loudly instead of silently
  falling back to pure-JS `chacha20-poly1305@openssh.com` and reporting a CPU number that measures
  something else.
- **Per-stage timings.** Every stage reports its own milliseconds, so a failure names the stage.

## Routes

| Route | What it establishes |
|---|---|
| `/` | Config sanity. Opens no connection. Confirms a credential is present. |
| `/exec` | TCP connect + key exchange + password auth + channel exec (`uname -a`, `whoami`, `hostname`). |
| `/list?path=/etc` | The SFTP subsystem: open, list, attributes. |
| `/read?path=/etc/hostname` | The real experiment: read bytes, SHA-256 them, and persist them to R2. |

`/read` returns the object's SHA-256, its byte count, the first bytes as UTF-8 and as hex, and the
R2 key it wrote. The independent check is to hash the same file on the host yourself and compare.

## Running it

Requires a Cloudflare account with **Workers Paid** (the free plan's 10 ms CPU ceiling is very
unlikely to survive an SSH handshake).

```powershell
# 1. Authenticate (human, browser). Alternative: set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
#    NOTE: node and wrangler are NOT on this machine's PATH. Prepend the bundled Node bin dir for
#    the child process only, or `pnpm dlx wrangler` fails with "'node' is not recognized".
$nodeBin = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
$env:PATH = "$nodeBin;$env:PATH"

# 2. Set the target. Host and user are plain vars; the password must be a secret.
#    Edit PROBE_HOST / PROBE_USER / PROBE_PORT in wrangler.jsonc, then:
"<password>" | pnpm exec wrangler secret put PROBE_PASSWORD

# 3. Deploy the throwaway Worker and its throwaway R2 bucket.
pnpm exec wrangler deploy

# 4. Drive it (replace with the deployed URL).
curl "https://linkbin-ssh-probe.<subdomain>.workers.dev/"
curl "https://linkbin-ssh-probe.<subdomain>.workers.dev/exec"
curl "https://linkbin-ssh-probe.<subdomain>.workers.dev/list?path=/etc"
curl "https://linkbin-ssh-probe.<subdomain>.workers.dev/read?path=/etc/hostname"

# 5. Read CPU time and wall time from the invocation log, which is the actual deliverable.
pnpm exec wrangler tail
```

**The credential never belongs in a file in this repo.** `.dev.vars`, `.env` and `.wrangler/` are
git-ignored at the repository root.

## Pass / fail

- **PASS**: `/list` returns real entries **and** `/read`'s SHA-256 matches the file hashed
  independently on the host **and** CPU time per invocation stays comfortably under the paid
  default of 30 s.
- **FAIL**: `exceededCpu` / error 1102 (CPU budget), a cipher or protocol negotiation error
  (AES-GCM refused), or a hash mismatch (bytes are wrong).

Either outcome is a valid result. Both must be written back into
[`.scratch/vps-file-hub/STATE.md`](../../.scratch/vps-file-hub/STATE.md) before the main feature
proceeds to `to-spec`.

## Cleanup

Once the result is recorded, the deployed Worker and its R2 bucket are disposable:

```powershell
pnpm exec wrangler delete
pnpm exec wrangler r2 bucket delete linkbin-ssh-probe
```

This **deletes real cloud resources**. Do it deliberately, and only after the result is written
down. The branch itself stays.
