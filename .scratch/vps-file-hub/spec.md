# spec: vps-file-hub — collection, storage and download

`Status: ready-for-agent`
Feature: `.scratch/vps-file-hub/` · Tracker: local markdown · Decisions honoured: D1–D45

> **Revision note.** Three requirements were added by the user after the first publication, and this
> spec is updated rather than superseded: self-service password setup on first visit, share links with
> an expiry and an optional password, and **derived objects** — outputs computed from stored objects
> by a merge rule. The first two sharpen existing stories; the third adds a data source, so it gets its
> own section and its own decisions. Ticket numbers referenced below stay stable; the merge work is
> additive.


---

## Problem Statement

I run several machines that each hold files I care about at known places. Getting a file off one of
them today means remembering which machine it is on, finding the path, opening an SSH session, and
copying it by hand — and doing that again every time one of those files changes.

I want one place where those files simply *are*, kept up to date without me logging in, so that any
of my other devices can fetch a file without knowing which machine it came from or where it lived.
I want to add a machine by typing its address and the directories I care about, not by editing code
or redeploying anything, and I do not want to install or run anything on those machines.

Two things make this harder than it sounds, and both have already bitten me:

- A file that changes must not silently duplicate itself or quietly vanish from the store.
- The store has a hard ceiling (10 GB). I need to know where I stand against it, and I need to
  decide what happens when I get there — not discover it by having writes fail.

## Solution

A single Cloudflare Worker that:

1. **Connects out** to each configured machine over SSH, using nothing but the `sshd` already
   running on it. Nothing is installed on the machines.
2. **Discovers** the files that match rules I configured in the web UI — rules that can apply to all
   machines or to just one.
3. **Reads** each changed file and stores its bytes in R2, with the metadata in D1.
4. **Measures its own size** against the 10 GB budget and manages that budget by evicting files I
   have not marked important.
5. **Serves downloads** from a custom domain with a short-lived link, optionally password-protected.
6. **Reports** what happened: which files moved, which were skipped and why, and what failed.

## User Stories

### Configuring machines

1. As the operator, I want to add a machine by entering its address, port, username and credential, so that I can start collecting from it without touching code or redeploying.
2. As the operator, I want to edit a machine's details without retyping its credential, so that renaming or re-addressing it is cheap.
3. As the operator, I want the stored credential to never be readable back out of the interface, so that a screenshot or a shared screen cannot leak it.
4. As the operator, I want to see that a credential is stored, and to notice when it changes, so that I can tell "no password set" apart from "password set earlier and I forgot".
5. As the operator, I want to pause a machine without deleting it, so that I can stop collecting from it temporarily and keep its configuration.
6. As the operator, I want to delete a machine and have its collection rules go with it, so that I do not leave orphaned configuration behind.
7. As the operator, I want to be refused when I try to add more machines than the design supports, and told the limit and the current count, so that I hit a clear message rather than a slow degradation.
8. As the operator, I want to test a machine's connection and see what it is, how long each step took, and how my rules land against its real filesystem, so that I can tell a wrong path from a wrong password before waiting for a scheduled run.

### Configuring what to collect

9. As the operator, I want to give a directory pattern for one machine only, so that a path that exists on one host does not have to be configured everywhere.
10. As the operator, I want to give a pattern that applies to every machine, so that a common directory like a log folder is configured once.
11. As the operator, I want an exclusion to win over an inclusion, so that I can collect a whole directory but skip the one noisy file in it.
12. As the operator, I want to see which files a rule actually matched on a given machine, so that I can tell a typo from an empty directory.
13. As the operator, I want to be told when a rule cannot be resolved at test time because its directory part contains a wildcard, so that I am not shown an empty result and left to guess.
14. As the operator, I want rules to be stored and listed even before a collection has ever run, so that I can configure everything up front.

### Collecting

15. As the operator, I want collection to run on a schedule without me doing anything, so that the store stays current on its own.
16. As the operator, I want to trigger a collection by hand, so that I can verify a new machine or a new rule immediately instead of waiting for the schedule.
17. As the operator, I want only changed files to be transferred, so that unchanged files do not consume bandwidth or time on every run.
18. As the operator, I want "changed" to mean "the content differs", not "the timestamp moved", so that a touched file is not re-transferred and an edited file whose timestamp did not move still is.
19. As the operator, I want a re-run with nothing changed to produce no new objects, so that I can safely run collection as often as I like.
20. As the operator, I want an interrupted run to resume from where it stopped rather than starting over, so that a run that exceeds its time budget still makes progress overall.
21. As the operator, I want one machine's failure to not stop the others, so that a host I have since decommissioned does not block the rest of the schedule.
22. As the operator, I want a machine that is unreachable to be recorded as unreachable rather than as a crash, so that I can distinguish "host down" from "the collector is broken".
23. As the operator, I want a file larger than the per-file limit to be recorded as skipped with its size, so that I know it exists and why it is not in the store.
24. As the operator, I want the time budget of a single run to be respected even mid-file, so that a large transfer does not blow past the platform's per-invocation ceiling.
25. As the operator, I want interrupted partial uploads to be cleaned up rather than left consuming storage, so that abandoned transfers do not eat the budget.

### Storage and the 10 GB budget

26. As the operator, I want to see how many bytes the store is holding and how that compares to the budget, so that I can act before it is full rather than after.
27. As the operator, I want that number to include superseded and deleted objects, not just live ones, so that the figure matches what I am actually being charged for.
28. As the operator, I want a new file that will not fit to be refused rather than transferred and discarded, so that I do not waste a full transfer on a file that cannot be stored.
29. As the operator, I want a refusal for capacity to be recorded as an issue, so that "why is this file missing" has an answer.
30. As the operator, I want the oldest non-important files to be evicted to make room, so that the store keeps accepting new files instead of filling up permanently.
31. As the operator, I want files I marked important to never be evicted, so that a file I care about cannot disappear because a machine generated something large.
32. As the operator, I want collection to stop accepting new files once only important files remain and the budget is full, so that the system fails closed rather than deleting something I protected.
33. As the operator, I want to mark and unmark files as important from the interface, so that I can control what is protected without editing a database.
34. As the operator, I want to see whether the store is currently refusing new files, so that a stalled schedule is explained in the interface rather than only in logs.

### Downloading

35. As a consumer, I want to get a link for a stored file, so that I can download it on another device.
36. As a consumer, I want that link to work from my own domain, so that I am not handing out a raw account-specific storage hostname.
37. As a consumer, I want the link to stop working after a couple of hours, so that a link that leaks later is not a permanent exposure.
38. As the operator, I want to revoke an issued link before it expires, so that a link sent to the wrong person can be cancelled.
39. As the operator, I want to protect a file with a password so that the link alone is not enough, so that I can send the link and the password through different channels.
40. As the operator, I want the password check to happen at download time, in the same place the file is served, so that the protection cannot be bypassed by going around the interface.
41. As a consumer, I want a wrong or missing password to produce a clear failure rather than a partial file, so that I never end up with an apparently-good truncated download.
42. As a consumer, I want to download large files without the transfer dying partway, so that a 100 MB file actually arrives.
43. As a consumer, I want to see the file's size before downloading, so that I know what I am starting.
44. As the operator, I want an expired or revoked link to say so explicitly, so that "invalid" is distinguishable from "server broken".

### Receipts and visibility

45. As the operator, I want a record of each collection run — which machine, when it started and ended, and its outcome — so that I can tell whether the schedule is actually working.
46. As the operator, I want a per-run count of files stored, skipped and failed, so that I can see the shape of a run without reading every issue.
47. As the operator, I want each skipped or failed file recorded individually with its reason, so that I can act on a specific file rather than a summary count.
48. As the operator, I want to see the errors a machine returned in its own words, so that I can diagnose an authentication or permission problem myself.
49. As the operator, I want to browse what is currently stored and search it, so that I can find a file without knowing which machine it came from.
50. As the operator, I want to see which machine and path a stored object came from, so that I can trace a file back to its origin.
51. As the operator, I want to see when an object was last seen and when it was stored, so that I can tell a stale copy from a fresh one.

### Interface and access

52. As the operator, I want the interface in my own language, so that I am not reading English labels on a tool I use daily.
53. As the operator, I want the interface to follow my device's light or dark setting, so that it is readable in both without configuring anything.
54. As the operator, I want to be able to force a specific appearance and language, so that the choice sticks.
55. As the operator, I want the interface reachable from my phone, so that I can check state without a desktop.
56. As the operator, I want the interface to be legible and usable with a keyboard, so that I am not fighting it to do simple things.
57. As the operator, I want the interface and API to require authentication, so that a stranger who finds the URL cannot add machines, store credentials, or trigger collection.
58. As the operator, I want a collection endpoint to be callable by a scheduler without an interactive login, so that automation does not require me to be present.
59. As the operator, I want to set the password myself on my first visit, so that I do not have to obtain or paste a token from anywhere else.
60. As the operator, I want to be refused clearly if I try to set a weak or empty password, so that the one thing standing between the internet and my credentials is not trivially guessable.
61. As the operator, I want to change the password later and have existing sessions end, so that changing it actually locks out anything already signed in.
62. As the operator, I want the password itself never stored recoverably, so that a database leak does not hand over the interface.

### Sharing files

63. As the operator, I want to choose specific files to share and get a link for them, so that I can hand out exactly what I intend and nothing else.
64. As the operator, I want to set how long a share lasts, so that a link for a one-off handover and a link for a colleague are not forced to the same lifetime.
65. As the operator, I want to set a password on a share, so that the link and the password can travel by different routes.
66. As a recipient, I want to open the link and download the file with the password, so that I do not need an account or any other access.
67. As the operator, I want to see the shares I have issued and cancel one, so that a link I regret sending stops working.
68. As the operator, I want a share that has expired or been cancelled to say which it is, so that a recipient can tell me something useful.

### Combining files into one

69. As the operator, I want to define a merge that takes several stored files and produces one combined file, so that I stop merging them by hand.
70. As the operator, I want the merge to understand the files' structure rather than just gluing them together, so that combining configuration documents produces a valid document rather than a run of stacked blocks.
71. As the operator, I want duplicates across the sources removed, so that the combined file does not repeat the same entry once per source.
72. As the operator, I want to control the order of the sources, so that the combined file is deterministic rather than dependent on timing.
73. As the operator, I want a preview of what a merge will produce before it is stored, so that a wrong rule does not silently create a large wrong file.
74. As the operator, I want the merge to re-run by itself when any of its inputs changes, so that the combined file is never quietly out of date.
75. As the operator, I want to see whether a derived file is current or stale, and what it was built from, so that I can trust it.
76. As the operator, I want the combined file to be downloadable and shareable like any other stored file, so that producing it is the only special thing about it.
77. As the operator, I want the inputs of a merge protected from eviction, so that the combined file can always be rebuilt rather than becoming permanently broken.
78. As the operator, I want a merge that fails to leave the previous combined file in place, so that a bad re-run does not destroy a good result.
79. As the operator, I want to be prevented from defining a merge that depends on itself, so that the system cannot get stuck in a loop.

## Implementation Decisions

### Collection channel

- The Worker is the SSH client. **Nothing is installed on the collected machines** (D14). This was
  verified against a real host: connect + authenticate ≈ 0.29 s, one file end to end ≈ 1.4 s.
- The SSH stack is Workers-native. `ssh2` **cannot** be used: it compiles WebAssembly during module
  initialisation and workerd forbids runtime WASM compilation, so it fails at import. This is settled,
  not a preference.
- Cipher suite is a **preference list** with AES-GCM first and AES-CTR as fallback;
  `chacha20-poly1305` is excluded because it would be assembled in pure JS and is the likeliest way to
  exhaust the CPU budget (D24).

### How bytes leave the remote host — the decision that shapes throughput

SFTP's read path is **fixed 32 KiB chunks, strictly serial**: one request in flight at a time, with no
range-read, no timeout and no abort. A 100 MB file is therefore ≈ 3,200 serial round trips. The
binding constraint is **round-trip count, not bandwidth**.

Two things follow, and they are requirements rather than suggestions:

- **The remote read must be a stream, never a whole-file read.** The whole-file path peaks at roughly
  twice the file size in memory, which for the 100 MB limit is fatal inside a 128 MB isolate.
- **A higher-throughput path must be attempted before falling back to serial SFTP.** The SSH session
  channel is windowed rather than request-response, so streaming a read-only command's stdout moves
  far more data per round trip. The fallback remains serial SFTP, which is proven to work.

The exact throughput of both paths is **not yet measured** and must be, at the 100 MB limit, before
the per-file limit is treated as settled. This is the one remaining unknown that can change the
design.

### Scheduling and resumability

- `cron` and a manual trigger coexist (D42).
- **One run = one machine's incremental scan**, with an explicit wall-clock budget well under the
  platform's 15-minute per-invocation ceiling.
- A run that does not finish writes a **cursor** (machine + position) to D1 and the next invocation
  continues from it. Cron is weakly delivered and a minute may be skipped, so *resumability is a
  premise, not error handling*.
- Target freshness: 15–30 minutes.
- 50 machines cannot be scanned in one invocation, which is why the cursor exists at all.

### Change detection and idempotency

- Identity is **(machine, path)**; version identity is the **content hash**.
- A file is transferred only when its content hash is not already the live version for that
  (machine, path). Timestamps are recorded but never trusted as the change signal, because a touch
  moves a timestamp without changing content and an in-place edit can leave one unchanged.
- Re-running with nothing changed must be a no-op. Every write is expressed as an independently
  repeatable statement: **D1 has no transactions**, and the only atomic unit available is a single
  batched statement sequence.
- Version history is **not** retained in R2. A change inserts a new row and supersedes the previous
  one, so the old object becomes garbage; the budget therefore faces live files rather than
  accumulating versions (D4/D15).

### Storage budget and eviction

- The budget is **10 GB** and is judged on **total bytes held in the bucket**, not on live objects
  only, because that is what is charged. Superseded and soft-deleted rows still occupy R2 until
  collected, so excluding them would let the store grow past the ceiling while every visible number
  looked healthy.
- Per-file limit is **100 MB**; the check happens **before** transferring, so a file that cannot be
  stored is never read off the host.
- Eviction policy (D43): the **oldest non-important** objects are evicted to make room; objects marked
  **important are never evicted**; if only important objects remain and the budget is full, collection
  **stops accepting new files** and says so. Failing closed is deliberate — silently deleting a
  file the operator protected is the worst available outcome.
- Objects larger than the chunking threshold upload in parts, with the part state in D1, because a
  Worker cannot hold multipart state across invocations (D8) and R2 requires equal-sized parts except
  the last.

### Download

- A **Worker-issued token**, not an R2 presigned URL (D44). A presigned URL cannot be used with a
  custom domain, which the requirement needs. The token approach is additionally **revocable** and is
  the only way the password check can be enforced at all — a presigned URL bypasses it entirely,
  because R2 knows nothing about the password.
- Default validity **two hours**; revocation is supported before expiry.
- The object body is streamed to the client directly rather than buffered; response bodies have no
  enforced size limit and R2 egress is free (D9).
- Optional per-file password, checked at download time (D15). Step one is plaintext-at-rest with a
  download-time check; **real at-rest encryption is a separate feature**, deliberately not folded in,
  because getting key management wrong is worse than not doing it.

### Authentication — a prerequisite, not a later task

The deployed Worker currently has **no authentication**, and it will hold real credentials and, once
collection exists, real files. This spec therefore treats **authentication as part of the first
deliverable**, not as hardening to follow: until it exists, a stranger who finds the URL can add
machines, store credentials and trigger collection from them. The machine-callable collection
endpoint needs a separate non-interactive credential from the interactive interface.

### Receipts

- Two tables (D45): one row per run, and one row per file that was not successfully handled.
- Not a JSON column: a run's issue list grows with file count and would run into D1's **2 MB per-row**
  limit, and separate rows are what make "why is this specific file missing" answerable.
- **Capacity refusals are receipts.** A file refused for budget produces a recorded issue, or the
  question "why did this stop syncing" has no answer.

### Derived objects — outputs computed from stored objects

A **derived object** is a stored object whose content is computed from other stored objects rather
than read off a machine. It is a second way for content to enter the store, which is why it gets its
own decisions.

- A **merge rule** names its source objects, how to order them, how to combine them, and the name of
  the output. It is data, configured in the interface, not code.
- **There is no script execution.** The concrete requirement — combining several configuration files
  into one — is a structured merge, and structured merges are expressible as configuration. Executing
  supplied code inside this Worker was considered and rejected: the isolate holds every stored machine
  credential and the master key, so the blast radius of a sandbox escape is total, and an earlier
  diagnostic endpoint in this same project already demonstrated how a temporary capability becomes a
  permanent exposure. A checklist run against that earlier endpoint is what removed it; the same
  reasoning applies with more force here.
- **YAML-aware list merging is supported for the stated case.** Source documents are parsed and their
  list-valued keys are unioned with duplicates removed, producing a normalised document. A
  widely-used pure-JavaScript YAML parser is available with no transitive dependencies, which matters
  because a parser requiring native code or runtime WebAssembly cannot run in this runtime at all —
  the same constraint that rules out the SSH library this project first tried.
- **Protection is the default.** A derived object is marked important when created, because the
  budget policy never evicts an important object. Without this, evicting a source would leave a
  derived object that cannot be recomputed, and the automatic re-run would quietly produce a partial
  or empty result instead of an error.
- **A derived object records what it was built from**, including a content hash per source. That
  record is what makes "re-run when an input changes" decidable, and it is also what lets the
  interface explain why a derived object is stale.
- Derived objects count against the same budget as everything else, and their size is measured the same
  way. A derived object cannot be its own source, directly or transitively.
- **The merge rule is configuration with four parts**, which is what keeps it previewable and
  auditable: where the inputs come from, the order they are combined in, how they are combined, and
  what the output is called. Source selection reuses the same directory-pattern vocabulary as
  collection, so there is one way to describe "which files" in this project rather than two.
- Ordering is explicit rather than incidental. Sources are ordered by a stated rule so that a
  re-run produces byte-identical output; an order that depended on database or filesystem return
  order would make the output change without anything having changed.

### Rules and scope

- A rule with no machine is **global**; a rule with a machine applies only there. The two sets are
  unioned rather than ranked, and **exclusions are evaluated first**, so "collect this directory
  everywhere, except this one file on this one machine" behaves as written.

### Conventions to pin now, because they are expensive to change later

- A file's modification time is stored as **epoch seconds**, not milliseconds. The value arrives from
  the remote host in that unit, and mixing units would silently corrupt every stored timestamp.
- A stat result's size is **optional** in the protocol and may be absent; the size must not be assumed
  present, and a missing size must not be treated as zero.
- A single stored object's identity is its **object key**, but the key is never the lookup path — the
  interface looks objects up by machine and path, with the key as an implementation detail.

## Testing Decisions

**What makes a good test here.** Only externally observable behaviour: a request in, a response out,
and the resulting rows in D1 / objects in R2. Specifically *not* asserted: which internal function was
called, the shape of intermediate objects, or the number of database round trips.

**The seam (one, confirmed).** The Worker's HTTP entry point — the same `fetch(request, env)` surface
the platform invokes. Tests construct a request against simulated D1 and R2 bindings and assert on the
response and the stored state. This is the highest available seam, it already exists as the deployment
contract, and it needs no change to production structure.

**Making the un-local part testable.** The remote host cannot be reached from a local test: local
development refuses outbound connections to private addresses, which the prototype confirmed. The fake
remote therefore lives in the **environment bindings** as a test-only binding, injected by tests and
never set in production. This keeps the fake confined to test files, adds no production module, and
still lets the following be tested deterministically — which real-host testing cannot do, because it
cannot manufacture "the budget is one byte short" or "the run stopped at the 37th file":

- hash-unchanged files are not re-transferred, and a full re-run is a no-op;
- a changed file supersedes its predecessor without duplicating it;
- a file over the per-file limit is recorded as skipped and its bytes are never requested;
- a file that would exceed the budget is refused **before** its bytes are requested;
- eviction takes the oldest non-important object and touches nothing marked important;
- when only important objects remain at the ceiling, new files are refused and the refusal is recorded;
- a run stopped mid-scan resumes from its cursor and does not redo completed work;
- one unreachable machine does not prevent the others from being processed;
- a token past its expiry, a revoked token, and a wrong password each fail distinctly and completely.

**Modules covered.** Everything reachable through the HTTP seam: host and rule management, credential
round-tripping, the schema bootstrap, usage measurement, budget decisions, receipts, and download
authorisation and streaming. Credential encryption is exercised through this seam rather than by
calling it directly, so that a change in storage format cannot pass tests while breaking the
interface.

**What is deliberately not covered by automated tests.** The SSH/SFTP adapters and real-host transfer.
Those were validated against a real machine (three files, hashes matching an independent computation
on the host) and are re-validated that way, because a mock of them would only prove the mock.

**Prior art.** None in this repository — no test infrastructure exists yet, so this spec introduces
it. It should follow the Workers-recommended setup so that tests run fully offline against simulated
bindings; that keeps the loop fast and free of account dependencies.

**Not tests, but part of the verification story.** A repository guard already exists that catches the
two ways the embedded UI document can silently break a build, and it runs before a build. It should
keep running, because both failures it catches report themselves at the wrong place.

## Out of Scope

- **At-rest encryption of stored files.** Download-time password checking is in scope; making objects
  unreadable in R2 without a password is a separate feature with its own key-management problem.
- **Windows and other non-POSIX remote hosts.** The high-throughput read path uses a POSIX shell
  command; serial SFTP remains the fallback but is not optimised for them.
- **Multi-user access.** Roles, sharing between operators, and audit logging are not included. One
  operator, one credential.
- **Version history as a user-facing feature.** Superseded versions are garbage to be collected, not
  something the interface offers to restore.
- **Search across file contents.** Search is over metadata (machine, path, size, time), not inside
  files.
- **Resumable downloads.** The download streams the object; client-side resume via range requests is
  not part of this spec.
- **A public or anonymous sharing mode.** Every link is time-limited and the interface is
  authenticated.
- **Notifications.** Failures are visible in the interface and receipts; they do not push anywhere.

## Further Notes

**The one unknown that could change this design.** Serial 32 KiB SFTP is proven to work but its
throughput at 100 MB has not been measured, and the arithmetic is uncomfortable: ≈ 3,200 round trips
against a 15-minute per-invocation ceiling. If the windowed session-channel path does not beat it
substantially, either the per-file limit has to come down or large files have to be collected across
several invocations. **Measure before treating 100 MB as settled.**

**Two platform facts that shaped the shape of the code**, both verified rather than assumed:

- A Worker cannot hold a TCP session or multipart state across invocations, so all of that state is in
  D1 by necessity, not by preference.
- D1 offers no transactions. Every design here assumes partial failure is normal and makes each step
  individually repeatable. A reviewer looking for a transaction to make something atomic will not
  find one, and should not add it.

**A standing hazard to keep closed.** An earlier diagnostic endpoint that read arbitrary files from a
host over SSH existed and has been removed. The conditions that made it dangerous are structural, not
incidental: an unauthenticated interface, a stored credential, and an endpoint that acts on it. Any
future diagnostic must sit behind the authentication above, never beside it.

**Where the decisions live.** `STATE.md` holds the locked decisions (D1–D45) with their reasons;
`GLOSSARY.md` holds the vocabulary this spec uses; `docs/adr/` holds the decisions that are hard to
reverse; `docs/research/` holds the platform facts with citations. This spec is the synthesis, not a
replacement for them.
