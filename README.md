# LinkBin

Collect designated files from multiple remote hosts into Cloudflare R2, keep their metadata in D1,
and let other devices download them by association.

**Status: the SSH channel is proven; the product is not built yet.** A deployed Worker connected to a
real remote host over SSH, listed directories, and read files whose SHA-256 matched a hash computed
independently on the host — roughly **1.4 s per file** end to end, at about **one hundredth** of the
paid plan's CPU ceiling. The Worker is live and can already identify hosts and resolve collection
rules against their real filesystems.

**Not built:** collection into R2, the download path, scheduling, and the consumer-facing surface. The
`objects` and `multipart_sessions` tables exist but nothing reads or writes them. See
[`.scratch/vps-file-hub/STATE.md`](.scratch/vps-file-hub/STATE.md) for the current phase and the
locked decisions.

## How it fits together

| Piece | Role |
|---|---|
| **Worker** | Serves the UI and API, and is the SSH client. There is nothing to install on the remote hosts. |
| **D1** | Hosts, their credentials (encrypted), collection rules, file metadata, chunked-upload sessions. |
| **R2** | The file bytes. Egress is free. |
| **`SSH_MASTER_KEY`** | The only secret this deployment needs. Everything else sensitive is encrypted in D1. |

Hosts and the directories to collect from are **runtime data**, added through the web UI. Adding a
machine needs no redeploy.

## Scale it is designed for

At most **50 hosts**, **100 MB** per file, and **10 GB total stored in R2**. The 10 GB figure is a
capacity budget rather than a file-size limit: it means the store has to measure its own total bytes
and have a defined behaviour when it is full. Nothing measures or enforces that today.

## Deploying

Two paths work. **Workers Builds** (GitHub → Cloudflare) is the intended long-term one, because then a
push ships. **`wrangler deploy`** from this repository is the proven one and is how the current
deployment was made. They are not exclusive — the Worker already exists, so the repository can be
connected to it at any time.

### With the CLI (proven)

Authenticate once with `wrangler login`; that is a browser step only a human can perform. Then:

```powershell
pnpm exec wrangler r2 bucket create linkbin-files     # once; this name is pinned in wrangler.jsonc
pnpm exec wrangler deploy --secrets-file .env.deploy  # code and SSH_MASTER_KEY in one step
```

Then apply the schema, below. In practice `wrangler deploy` did **not** write the provisioned
`database_id` back into `wrangler.jsonc`, contrary to the documented automatic-provisioning behaviour.
The database id therefore stays out of this public repository, which is the intent (D38).

### With Workers Builds (the intended path)

Connecting the repository is a **dashboard step and cannot be done by CLI or API**.

1. **Connect the repository.** Cloudflare dashboard → **Workers & Pages** → the existing `linkbin`
   Worker (or **Create** → **Import a repository**). Keep the production branch (`main`), leave the
   build command empty, keep the deploy command at its default (`npx wrangler deploy`), and leave the
   root directory empty — the Worker is at the repository root.

2. **Resources are provisioned for you.** `wrangler.jsonc` pins `bucket_name: "linkbin-files"` and
   `database_name: "linkbin-db"` but carries **no `database_id`**, so no account-specific identifier
   lives in this public repository. Cloudflare states the linkage survives later deploys even without
   the id in the config. Deploying from the dashboard does not write ids back into the repository.

### Both paths need these two things

3. **Set the master key.** Add a **Secret** named `SSH_MASTER_KEY` — dashboard → **Settings** →
   **Variables and Secrets**, or `wrangler secret put`, or `--secrets-file` as above. Generate a value
   at `GET /api/master-key` (the UI has a button for it). It must be **32 random bytes in base64**;
   anything else is rejected at use with an explicit message.

   > Replacing this key does **not** re-encrypt anything. Every stored credential becomes unreadable,
   > so treat it as a one-time value and keep a copy somewhere safe.

4. **Create the tables.** Open the Worker's URL and press **Apply schema** in the setup panel, or
   `POST /api/admin/apply-schema`. This route exists because a Workers-Builds deployment has no CLI
   attached to it. It is idempotent — every statement is `CREATE ... IF NOT EXISTS` — so it is safe to
   run again. It applies `migrations/0001_init.sql`, the same file the CLI uses, imported into the
   Worker as a string, so the schema has exactly one source of truth.

5. **Add a host** in the UI: label, address, port, username, and a password or private key. Up to 50.

## Local development

```powershell
# `node` is not on this machine's PATH. Prepend the bundled runtime for the child process only,
# or wrangler exits with "'node' is not recognized".
$nodeBin = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
$env:PATH = "$nodeBin;$env:PATH"

pnpm install
pnpm exec wrangler deploy --dry-run   # bundle check, no account needed
pnpm exec wrangler dev                # local D1 + R2 are simulated
```

Local development cannot test the SSH path: `wrangler dev` refuses outbound connections to
`localhost` and to private addresses, so a local SSH server cannot stand in for a real host.

`npm` is not installed in this environment. Use `pnpm exec` or `pnpm dlx`.

## Credential handling

- Credentials are encrypted with **AES-GCM** (256-bit, WebCrypto) before they reach D1, with a fresh
  random IV per encryption, and the record's **host id and field name are bound in as additional
  authenticated data** — so a ciphertext cannot be moved to another row or column without failing.
- The API never returns a credential. It returns a short **fingerprint** so the UI can show that one
  is stored and notice when it changes.
- **Honest limit:** an attacker holding both the D1 database *and* `SSH_MASTER_KEY` can recover every
  credential. What this buys is that a database leak on its own — a dump, a replica, a misconfigured
  export — yields nothing usable.
- **The current UI has no authentication.** Anyone who can reach the Worker can manage hosts. Put it
  behind Cloudflare Access, or add an API token, before treating it as anything but a private tool.

  > **This is worse than it sounds, and adding a host makes it concrete.** The `/probe*` routes are
  > also unauthenticated, and they fall back to *the first stored host that has a credential*. So once
  > any host with a credential is stored, anyone on the internet can call
  > `GET /probe/read?path=<anything>` to read arbitrary files from that machine and write them into
  > your R2. Never set `PROBE_HOST` / `PROBE_USER` / `PROBE_PASSWORD`. This was a real exposure on
  > 2026-10-07 and was closed by deleting the stored host, not by fixing the routes.

## Constraints worth knowing before changing code

- **D1 has no transactions.** The only atomic unit is one `db.batch()`. Every write path is written
  to be independently safe to repeat; do not express a multi-step intention as a unit that must
  all-or-nothing. See [`docs/adr/0001`](docs/adr/0001-d1-for-metadata-r2-for-bytes.md).
- **No runtime WebAssembly.** `WebAssembly.instantiate()` only accepts pre-compiled modules, which
  is why `ssh2` cannot be imported here at all. This is settled, not a preference.
- **AES-GCM is asserted, not preferred**, so a host that cannot negotiate
  `aes256-gcm@openssh.com` fails loudly rather than silently falling back to pure-JS
  ChaCha20-Poly1305 and blowing the CPU budget.
- **Local D1 is function-allowlisted**: `PRAGMA`, `BEGIN` and `sqlite_version()` are rejected. Do not
  add them to migrations.
- **SFTP reads are fixed at 32 KiB, strictly serialised.** `sftp.createReadStream()` (edgeport) issues
  one SFTP `READ` at a time and the chunk size is a module constant, so throughput is bounded by
  `32 KiB ÷ round-trip time`, not by bandwidth: 100 MB costs about **3,200 sequential round trips**.
  There is no range-read API and **no timeout or abort signal anywhere in the SSH/SFTP path**, so a
  stalled peer hangs until the session is closed. `readFile`/`getFile` buffer the whole file and peak
  at about twice its size — do not use them for large files. Verify the real throughput on a real
  host before designing around an estimate.
- Also see [`docs/research/cloudflare-platform-limits.md`](docs/research/cloudflare-platform-limits.md)
  for the cited platform ceilings, and [`AGENTS.md`](AGENTS.md) for repo conventions.
