# LinkBin

A system that reaches designated locations on remote hosts, stores the files it collects in
Cloudflare R2 with metadata in D1, and lets other devices download them by association.

## Language

### Collection

**Host**:
A remote machine whose files LinkBin collects from. Identified by a stable id and an address.
_Avoid_: server, node, box, VPS (the deployment shape, not the role)

**Source Rule**:
A statement of which files on a Host are in scope, expressed as a glob pattern plus exclusion
patterns, scoped to one Host.
_Avoid_: path list, filter, selector

**Collection**:
One execution of the process of discovering files matching the Source Rules and getting their bytes
into storage. A Collection is expected to be re-runnable and to converge on the same stored result.
_Avoid_: sync, backup, job, crawl

**Collector**:
The single program this project ships that performs Collection against Hosts. It is a fixed program,
not an AI agent and not a component installed on the Hosts.
_Avoid_: agent, daemon, crawler

### Storage

**Object**:
One file's bytes as stored in R2, addressed by an object key.
_Avoid_: blob, file (a file is the thing on a Host; an Object is its stored form)

**Derived Object**:
An Object whose content is computed from other stored Objects by a Merge Rule, rather than read off a
Host. It is a second source of content, alongside Collection.
_Avoid_: generated file, output, artifact, bundle

**Merge Rule**:
The configuration that produces a Derived Object: which Objects are its sources, the order they are
combined in, how they are combined, and the name of the result. It is data, not code.
_Avoid_: script, transform, pipeline

**Object Version**:
The stored form of one file's content as identified by its content hash. Content change produces a
new Object Version; it is never an in-place edit.
_Avoid_: revision, generation, snapshot

**Multipart Session**:
The resumable record of a chunked upload in progress — the upload id plus the parts already accepted.
Its state lives in D1, never in the Worker.
_Avoid_: upload job, chunk state, transfer

### Consumption

**Consumer**:
A device or person downloading an Object. Distinct from a Host.
_Avoid_: client, user, downloader

**Download Link**:
A URL handed to a Consumer that yields an Object.
_Avoid_: share link, permalink

**Protected Object**:
An Object whose download additionally requires a secret, independent of the download authorization.
_Avoid_: encrypted file, password file, secure file

### Terms deliberately retired

**"Non-relational database"**: the project's original wording for its storage. No longer accurate and
no longer used — metadata lives in D1, which is SQLite-based and therefore relational, while file
bytes live in R2 object storage. See `docs/adr/0001`.
