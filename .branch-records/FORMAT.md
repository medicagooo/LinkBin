# Branch registry format (this repository)

This repository maintains the branch/business registry described in the global agent instructions.

## Files

| File | Role |
|---|---|
| `BRANCHES.md` | JSON business ledger. Compact metadata plus one entry per **business adjustment** under `changes`. Searched selectively by keyword/id/date. |
| `.branch-records/<task>/state.json` | Current task state only: `purpose`, `requirements`, `constraints`, `acceptance`, `status`, `integration`, `evidence`, `next`. Superseded decisions do not accumulate here. |
| `.branch-records/<task>/events.jsonl` | One JSON object per line. Append-only history of `user_request`, `requirements_changed`, and `operation` events. |

## Enumerations

- `status`: `active` | `blocked` | `complete` | `unknown`
- `integration`: `unmerged` | `verified` | `unknown` | `not_applicable`
  - `verified` requires evidence (a merge commit, a patch-equivalence check, or equivalent). Never
    infer it from intent.
- `operation.status`: `predeclared` | `executed` | `failed` | `removed`

## Operation discipline

1. Register the task in `state.json` **before** creating a branch or worktree.
2. Append a `predeclared` operation event with the exact ref, base, and path, and list its id in the
   ledger's `pending` array.
3. For any action that **transfers repository content** (branch/worktree creation, merge, rebase,
   cherry-pick, push, delete), commit the registry files **first** and include that commit in the
   transferred content.
4. On success, keep the event and update its status to `executed`; live results are verified and
   reported in the handoff. On failure, remove the failed provisional event and revert the intended
   registry state, then report any partial external effects.
5. Clear resolved `pending` pointers at the next otherwise-required registry update. Never create a
   commit or push solely to backfill a success record.

**Bootstrap exception.** The very first commit, which creates the registry, is itself the required
pre-action commit. A registry commit cannot precede the registry's existence. This exception is
recorded explicitly in the initial `operation` event.

## Date fields

- `at` / `created_at` / `updated_at` are ISO-8601 timestamps in **+08:00** (China Standard Time).
- For date-range business-change summaries, the default basis is the **implementation date**.
  Boundaries are inclusive. Requirement-record dates without implementation evidence must be
  reported separately and never counted as verified completed changes.

## Validation

New or changed registry files must:

- parse as JSON (`BRANCHES.md`) and JSONL (`events.jsonl`, one object per line);
- resolve every referenced `.branch-records/<task>/...` path;
- keep event ids unique within a task;
- state pending operation intent explicitly, with no `predeclared` event left dangling after a
  success or an abandoned attempt.

## Known failure mode: stray NUL bytes

A tooling edit once appended a single `0x00` byte to the end of an `events.jsonl` line. `git` then
reported the file as **binary** (`Bin 2979 -> 3774 bytes`), which silently disables diffing,
`code-review`, and any line-based parsing — the whole registry becomes unreadable while still
looking fine in an editor.

Guard before every commit that touches the registry:

```powershell
# no NUL bytes, no BOM, LF-only, one parsable JSON object per line, unique ids
$p = '.branch-records/<task>/events.jsonl'
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $p))
if ([Array]::IndexOf($bytes, [byte]0) -ge 0) { throw "stray NUL byte in $p" }
if ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { throw "BOM in $p" }
if (($bytes | Where-Object { $_ -eq 13 }).Count -gt 0) { throw "CR in $p (must be LF-only)" }
$lines = [System.IO.File]::ReadAllLines($p)
$ids = foreach ($l in $lines) { ($l | ConvertFrom-Json).id }
if (($ids | Group-Object | Where-Object Count -gt 1)) { throw "duplicate event id" }
```

`.gitattributes` pins `*.jsonl`, `*.json`, and `*.md` to `eol=lf` in the working tree so that
`core.autocrlf` cannot reintroduce CRLF into the machine-parsed files.

