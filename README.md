# LinkBin

Collect designated files from multiple remote hosts into Cloudflare R2, keep their metadata in D1,
and let other devices download them by association.

**Status: probe stage.** The Worker connects to hosts over SSH and can identify them and resolve
collection rules against their real filesystems. Store-verified collection, download links, and the
download-facing UI are **not built yet**. The verdict that gates them is tracked in
[`.scratch/vps-file-hub/STATE.md`](.scratch/vps-file-hub/STATE.md).

## How it fits together

| Piece | Role |
|---|---|
| **Worker** | Serves the UI and API, and is the SSH client. There is nothing to install on the remote hosts. |
| **D1** | Hosts, their credentials (encrypted), collection rules, file metadata, chunked-upload sessions. |
| **R2** | The file bytes. Egress is free. |
| **`SSH_MASTER_KEY`** | The only secret this deployment needs. Everything else sensitive is encrypted in D1. |

Hosts and the directories to collect from are **runtime data**, added through the web UI. Adding a
machine needs no redeploy.

## Deploying

Deployment runs through **Cloudflare Workers Builds** from this GitHub repository. Connecting the
repository is a dashboard step and cannot be done by CLI or API.

1. **Connect the repository.** Cloudflare dashboard → **Workers & Pages** → **Create** →
   **Import a repository** → pick this repository. Keep the production branch (`main`), leave the
   build command empty, keep the deploy command at its default (`npx wrangler deploy`), and leave
   the root directory empty — the Worker is at the repository root.

2. **Resources are created for you.** `wrangler.jsonc` intentionally declares the D1 binding and the
   R2 binding **without ids or names**, so Wrangler provisions them during the deploy and names them
   after the Worker. Deploying from the dashboard creates them but does not write their ids back into
   this file; you can read them in the dashboard. To pin them into the file instead, deploy once
   locally with `wrangler deploy`, which does write them back.

3. **Set the master key.** Open the deployed Worker → **Settings** → **Variables and Secrets** → add
   a **Secret** named `SSH_MASTER_KEY`. Generate a value at `GET /api/master-key` (the UI has a
   button for it) or with `wrangler secret put SSH_MASTER_KEY`. It must be **32 random bytes in
   base64**; anything else is rejected at use with an explicit message.

   > Replacing this key does **not** re-encrypt anything. Every stored credential becomes
   > unreadable, so treat it as a one-time value and keep a copy somewhere safe.

4. **Create the tables.** Open the Worker's URL and press **Apply schema** in the setup panel, or
   `POST /api/admin/apply-schema`. This exists because a Workers-Builds deployment has no CLI
   attached to it. It is idempotent — every statement is `CREATE ... IF NOT EXISTS` — so it is safe
   to run again. Under the hood it applies `migrations/0001_init.sql`, the same file the CLI would
   use, imported into the Worker as a string.

5. **Add a host** in the UI: label, address, port, username, and a password or private key.

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
- Also see [`docs/research/cloudflare-platform-limits.md`](docs/research/cloudflare-platform-limits.md)
  for the cited platform ceilings, and [`AGENTS.md`](AGENTS.md) for repo conventions.
