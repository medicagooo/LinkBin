# Cloudflare platform limits — hard facts for a VPS → R2 → downloader system

**Scope.** Platform constraints that shape a system that (a) collects files from designated paths on
multiple VPS hosts, (b) stores them in Cloudflare R2, and (c) lets other devices download them.
Workers + D1 + R2 only. No opinions, no "typical workloads suggest" — every number below is copied
from an official Cloudflare page.

**Research date.** The docs were retrieved latest-first on the "as of" dates shown per source. Many
Cloudflare pages carry a `dateModified` in the future (e.g. `2026-09-05`); those values are reported
verbatim as "page date" and are **not** validated against the wall clock.

## 0. How this was gathered (provenance + a tooling caveat for this repo)

`web_fetch` does not work on this machine: `developers.cloudflare.com` resolves to a non-public TUN
address (`198.18.0.203`), so the harness refuses the request with
`URL hostname resolves to a non-public IP address`. Every page in this note was instead retrieved
with `Invoke-WebRequest` against the **`.md` variant** of the doc page (`<path>/index.md`), which
returns clean Markdown plus a `dateModified`. This is a reproducible workaround, not a guess.

Any claim below that could not be found on an official page is labelled **unverified** and the pages
searched are listed.

### Source key

| Key | URL | Page date |
| --- | --- | --- |
| W-LIM | https://developers.cloudflare.com/workers/platform/limits/ | Last updated Sep 5, 2026 |
| W-PRICE | https://developers.cloudflare.com/workers/platform/pricing/ | (pricing tables; no "Last updated" line shown) |
| W-REQ | https://developers.cloudflare.com/workers/runtime-apis/request/ | (no "Last updated" line shown) |
| W-SOCK | https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ | Last updated Jun 19, 2026 |
| W-FETCH | https://developers.cloudflare.com/workers/runtime-apis/fetch/ | dateModified 2026-07-05 |
| W-CRON | https://developers.cloudflare.com/workers/configuration/cron-triggers/ | Last updated Sep 4, 2026 |
| W-WRANG | https://developers.cloudflare.com/workers/wrangler/configuration/ | (no "Last updated" line shown; `limits` section) |
| W-ACCESS | https://developers.cloudflare.com/workers/configuration/cloudflare-access/ | Last updated Aug 18, 2026 |
| W-CDOM | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ | (no "Last updated" line shown) |
| R2-LIM | https://developers.cloudflare.com/r2/platform/limits/ | Last updated Jun 8, 2026 |
| R2-PRICE | https://developers.cloudflare.com/r2/pricing/ | dateModified 2026-10-01 |
| R2-UP | https://developers.cloudflare.com/r2/objects/upload-objects/ | dateModified 2026-07-29 |
| R2-WAPI | https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ | (no "Last updated" line shown) |
| R2-WUSE | https://developers.cloudflare.com/r2/api/workers/workers-api-usage/ | dateModified 2026-08-25 |
| R2-WMPU | https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/ | Last updated Jul 31, 2026 |
| R2-S3 | https://developers.cloudflare.com/r2/api/s3/api/ | dateModified 2026-07-31 |
| R2-PRE | https://developers.cloudflare.com/r2/api/s3/presigned-urls/ | Last updated Aug 22, 2026 |
| R2-TMP | https://developers.cloudflare.com/r2/api/s3/temporary-credentials/ | Last updated Apr 24, 2026 |
| R2-TOK | https://developers.cloudflare.com/r2/api/tokens/ | Last updated Oct 1, 2026 |
| R2-PUB | https://developers.cloudflare.com/r2/buckets/public-buckets/ | Last updated Sep 25, 2026 |
| R2-LIFE | https://developers.cloudflare.com/r2/buckets/object-lifecycles/ | (no "Last updated" line shown) |
| D1-LIM | https://developers.cloudflare.com/d1/platform/limits/ | Last updated Apr 21, 2026 |
| D1-SQL | https://developers.cloudflare.com/d1/sql-api/sql-statements/ | Last updated Apr 21, 2026 |
| D1-DB | https://developers.cloudflare.com/d1/worker-api/d1-database/ | dateModified 2026-06-22 |
| D1-REPL | https://developers.cloudflare.com/d1/best-practices/read-replication/ | Last updated Aug 10, 2026 |
| D1-FAQ | https://developers.cloudflare.com/d1/reference/faq/ | Last updated Apr 21, 2026 |
| D1-GEN | https://developers.cloudflare.com/d1/reference/generated-columns/ | (no "Last updated" line shown) |
| A-TOK | https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ | Last updated Oct 2, 2026 |
| A-MTLS | https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/ | (no "Last updated" line shown) |
| A-JWT | https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ | Last updated May 6, 2026 |
| A-APP | https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ | (no "Last updated" line shown) |

---

## 1. Workers request body size, CPU, memory, streaming

### 1.1 Request body size depends on the **zone** plan, not the Workers plan

> "Request body size limits depend on your Cloudflare account plan, not your Workers plan. Requests
> exceeding these limits return a `413 Request entity too large` error."

| Cloudflare Plan | Maximum request body size |
| --- | --- |
| Free | 100 MB |
| Pro | 100 MB |
| Business | 200 MB |
| Enterprise | Up to 5 GB (self-serve) |

Enterprise can adjust up to 5 GB from the zone's **Network** page (**Maximum Upload Size**); above
5 GB requires account team / Support. — W-LIM

Other request/response limits from the same page:

| Limit | Value |
| --- | --- |
| URL size | 16 KB |
| Request header size | 128 KB (total) |
| Response header size | 128 KB (total) |
| Response body size | No enforced limit |

> "Cloudflare does not enforce response body size limits. CDN cache limits apply: 512 MB for Free,
> Pro, and Business plans, and 5 GB for Enterprise." — W-LIM

### 1.2 Worker memory is separate from the upload limit

**128 MB per isolate**, and it is per-isolate, not per-invocation:

> "Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly
> allocations. This limit is per-isolate, not per-invocation. A single isolate can handle many
> concurrent requests." — W-LIM

This is the practical ceiling for anything the Worker buffers. Cloudflare's own guidance:

> "You may also see the runtime error `Memory limit would be exceeded before EOF` when attempting to
> buffer a response body that exceeds the limit." … resolve by "Stream request and response bodies —
> Use `TransformStream` or `node:stream` instead of buffering entire payloads in memory." — W-LIM

So: **100 MB accepted at the edge on Free/Pro ≠ 100 MB bufferable in the Worker.** Anything above a
few tens of MB must be streamed, never buffered.

### 1.3 CPU time, subrequests, connections

| Feature | Workers Free | Workers Paid |
| --- | --- | --- |
| Requests | 100,000/day | No limit (Standard: 10M/month included, +$0.30/M) |
| CPU time | 10 ms | 5 min max (default 30 s) |
| Memory | 128 MB | 128 MB |
| Subrequests | 50/request | 10,000/request (up to 10M) |
| Simultaneous outgoing connections/request | 6 | 6 |
| Worker size (uncompressed) | 64 MiB | 64 MiB |
| Cron Triggers per **account** | 5 | 250 |

— W-LIM, W-PRICE

> "CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests
> (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time." — W-LIM

CPU time per Cron Trigger: 10 ms (Free) / 30 s if interval < 1 hour, 15 min if interval ≥ 1 hour
(Paid). CPU limit is configurable via `limits.cpu_ms`, max 300,000 ms. — W-LIM, W-WRANG

**Duration** (wall clock):

| Trigger type | Duration limit |
| --- | --- |
| HTTP request | No limit |
| Cron Trigger | 15 min |
| Durable Object alarm | 15 min |
| Queue consumer | 15 min |

> "There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains
> connected, the Worker can continue processing, making subrequests, and streaming a response body."
> … `waitUntil()` "can extend execution for up to 30 seconds after the response is sent or the client
> disconnects." Runtime updates give in-flight requests a 30-second grace period. — W-LIM

**Simultaneous open connections = 6**, and this is the real fan-out constraint:

> "Each Worker invocation can have up to six connections simultaneously waiting for response headers."
> Once headers arrive the connection stops counting. `connect()` counts. Outbound WebSockets count.
> The 7th attempt is queued. — W-LIM

### 1.4 Streaming request bodies: supported

- The incoming `Request` exposes `body` as a **read-only `ReadableStream`** (`bodyUsed` boolean,
  `arrayBuffer()`, `formData()`, `json()`, `text()` are the buffering alternatives). — W-REQ
- `Content-Length` is set by the runtime from the data source; a manually set value is ignored. Only
  `FixedLengthStream` or a fixed-length value (string/TypedArray) produces a specific
  `Content-Length`; "Using any other type of `ReadableStream` as the body of a request will result in
  Chunked-Encoding being used." — W-REQ
- Buffering caveats: a `Request` body can be read only once; `request.clone()` duplicates it, and
  cloning large bodies can hit the 128 MB limit — "loading particularly large files into a Worker's
  memory multiple times may reach this limit." — R2-WUSE

---

## 2. Can a Worker pull files from a VPS itself? (outbound execution model)

### 2.1 `fetch()` = HTTP(S) only

`fetch()` is the HTTP interface (subrequests, `Accept-Encoding`/compression passthrough, cache
modes `no-store`/`no-cache`). It is not a raw transport. — W-FETCH

### 2.2 `connect()` = real outbound TCP, with TLS

Import `connect` from `cloudflare:sockets`; it returns a socket with `readable`/`writable` streams.

> "Many application-layer protocols are built on top of the Transmission Control Protocol (TCP).
> These application-layer protocols, including **SSH**, MQTT, SMTP, **FTP**, IRC, and most database
> wire protocols including MySQL, PostgreSQL, MongoDB, require an underlying TCP socket API in order
> to work." — W-SOCK

TLS is available on the same socket via `SocketOptions.secureTransport`:

- `off` (default) — no TLS
- `on` — TLS
- `starttls` — plaintext first, then upgrade by calling `startTls()` (returns a new `Socket`); after
  `startTls()` the original socket is closed, existing readers/writers stop working, and `startTls()`
  should be called only once. — W-SOCK

**Answer to "is SFTP over `cloudflare:sockets` possible":** Cloudflare explicitly names **SSH** as a
protocol that requires and is served by `connect()`, and it gives you a full-duplex byte stream with
optional TLS, which is what an SSH/SFTP client needs. However, Cloudflare does **not** document an
SSH or SFTP client, an SSH handshake implementation, or any SFTP example — only a Gopher example and
a raw HTTP example. So "the transport exists" is documented; "SFTP works from a Worker" is
**unverified** and would rest on a userland SSH implementation. FTP is likewise only named in the
protocol list; no FTP example exists. — W-SOCK

### 2.3 Documented restrictions on outbound TCP (these are the blockers)

- "Outbound TCP sockets to **Cloudflare IP ranges** are blocked." — W-SOCK
- "TCP sockets cannot be created in global scope and shared across requests. You should always create
  TCP sockets within a handler." — W-SOCK
- "Each open TCP socket counts towards the maximum number of open connections that can be
  simultaneously open." (i.e. the 6-connection limit) — W-SOCK
- Port **25** outbound is prohibited (SMTP). — W-SOCK
- Disallowed destinations include "Cloudflare IPs, `localhost`, and private network IPs" — the
  troubleshooting entry for `proxy request failed, cannot connect to the specified address` names
  exactly those. — W-SOCK
- "TCP Workers outbound connections are sourced from a prefix that is not part of list of IP ranges."
  — W-SOCK
- Inbound TCP is not possible: "Support for handling inbound TCP connections is coming soon.
  Currently, it is not possible to make an inbound TCP connection to your Worker, for example, by
  using the `CONNECT` HTTP method." — W-SOCK
- `TCP Loop detected` if a Worker connects back to itself. — W-SOCK

### 2.4 The decisive fact for "Worker pulls from VPS" vs "VPS agent pushes"

A Worker **can** open an outbound TCP connection to an arbitrary public VPS on an arbitrary port,
with TLS, and can hold a long-lived stream as long as the client stays connected (HTTP-triggered
Workers have no wall-clock duration limit). What constrains it:

1. **6 simultaneous in-flight connections per invocation** (W-LIM) — pulling from N VPS hosts
   concurrently from one invocation does not scale past 6 handshakes at a time.
2. **No durable scheduling longer than 15 minutes** for Cron-triggered runs (W-LIM) — a long pull
   cannot run in a Cron invocation beyond 15 minutes of wall time.
3. **No documented SFTP/SSH client** — the protocol stack would be userland and unverified (W-SOCK).
4. Only **50 subrequests/request on Free**, and every socket counts as an open connection (W-LIM,
   W-SOCK).
5. Workers cannot reach private-network addresses or `localhost`, so the VPS must be publicly
   reachable (W-SOCK).

Net: the platform makes an outbound pull *transport-wise* legal but leaves the SSH/SFTP protocol
layer to you, while push-from-VPS over HTTPS uses only documented, first-class primitives.

---

## 3. Cron Triggers

- **Count per account**: 5 (Workers Free) / 250 (Workers Paid). The W-LIM table labels this row
  "Number of Cron Triggers per **account**"—the Cron Triggers page itself defers to W-LIM ("Refer to
  Limits to track the maximum number of Cron Triggers per Worker") and gives no separate per-Worker
  number. Treat the account figure as the cited limit. — W-LIM, W-CRON
- **"Cron Triggers execute on UTC time."** — W-CRON
- **Granularity**: five-field cron, minute is the finest field (Minute `0-59`), with Quartz-like
  extensions: Day-of-Month supports `L W`; Weekdays support `L #`. Days of week are **1 = Sunday
  through 7 = Saturday**, which "is different on some other cron systems". Examples given include
  `* * * * *` ("At every minute") and `*/30 * * * *`. — W-CRON
- **Propagation delay**: "Changes such as adding a new Cron Trigger, updating an old Cron Trigger, or
  deleting a Cron Trigger may take several minutes (up to 15 minutes) to propagate to the Cloudflare
  global network." — W-CRON
- **Deploy semantics**: deploying with Wrangler replaces previous Cron Triggers with those in the
  `triggers` array; empty array removes all; `undefined` leaves them in place. — W-CRON
- **Execution history**: "Cron Events stores the 100 most recent invocations of the Cron scheduled
  event." New Worker / rename can take "up to 30 minutes before events are displayed". — W-CRON
- **Wall time / CPU**: 15 min wall time per Cron invocation; CPU 10 ms (Free) or 30 s (< 1 hour
  interval) / 15 min (≥ 1 hour interval) on Paid. — W-LIM
- **Skipped or delayed invocations**: the Cron Triggers page does **not** claim at-least-once or
  exactly-once delivery, and does not document a skip policy. The only scheduling caveats it states
  are the UTC-only rule and the propagation delay. Workers are "scheduled … on underutilized machines
  to make the best use of Cloudflare's capacity". A documented *guarantee* about invocations being
  delayed or skipped: **unverified** (searched W-CRON, W-LIM — not stated).

---

## 4. R2 limits, multipart, pricing

### 4.1 Hard limits (R2-LIM, "Last updated Jun 8, 2026")

| Feature | Limit |
| --- | --- |
| Data storage per bucket | Unlimited |
| Number of objects per bucket | Unlimited |
| Maximum number of buckets per account | 1,000,000 |
| Maximum rate of bucket management operations per bucket | 50 per second |
| Number of custom domains per bucket | 100 |
| Object key length | 1,024 bytes |
| Object metadata size | 8,192 bytes |
| **Object size** | **5 TiB per object** |
| **Maximum upload size** | **5 GiB (single-part) / 4.995 TiB (multi-part)** |
| **Maximum upload parts** | **10,000** |
| **Maximum concurrent writes to the same object name (key)** | **1 per second** (HTTP 429 above) |

Footnote 3 on the max-upload row is directly relevant here:

> "Max upload size applies to uploading a file via one request, uploading a part of a multipart
> upload, or copying into a part of a multipart upload. If you have a Worker, its inbound request
> size is constrained by Workers request limits. The max upload size limit does not apply to
> subrequests." — R2-LIM

Also: managed `r2.dev` public access is **not** for production — "not intended for production usage
and has a variable rate limit"; exceeding "hundreds of requests/second" yields `429` and bandwidth may
be throttled. The Cloudflare REST API for R2 is "rate limited to 1,200 requests per five minutes
across all R2 REST API operations on your account." — R2-LIM

### 4.2 Multipart rules (R2-UP, "Multipart upload details → Part size limits")

- **Minimum part size: 5 MiB (except for the last part)**
- **Maximum part size: 5 GiB**
- **Maximum number of parts: 10,000**
- **"All parts except the last must be the same size"**
- "Each part must be at least 5 MiB (except the last part)." — R2-UP (multipart section)
- Upload-method comparison table: single `PUT` "Best for small to medium files (under ~100 MB)",
  max object 5 GiB; multipart max object "5 TiB (up to 10,000 parts)", part size "5 MiB – 5 GiB",
  resumable, parallel. — R2-UP
- Incomplete multipart uploads: "Uncompleted multipart uploads will be automatically aborted after
  **7 days**." (R2-WAPI) and "Buckets have a default lifecycle rule to expire multipart uploads
  **seven days** after initiation." Configurable via `AbortIncompleteMultipartUpload`
  `DaysAfterInitiation`. — R2-LIFE
- Multipart ETags are not plain MD5s: part ETag = MD5 of that part; completed object ETag = hash of
  the concatenated binary MD5 sums of all parts, then `-` and the part count
  (e.g. `f77dc0eecdebcd774a2a22cb393ad2ff-2`). Single-`PUT` and multipart ETags therefore differ.
  — R2-UP

**Maximum number of multipart uploads in progress: unverified.** Not present on R2-LIM, R2-UP,
R2-S3, R2-WAPI or R2-WMPU. The only adjacent documented rate is "Maximum concurrent writes to the
same object name (key): 1 per second" (R2-LIM). Do not assume a numeric cap exists — treat upload
concurrency as bounded by the 6-connections-per-invocation Worker limit (W-LIM) and by whatever R2
returns under load (undocumented).

### 4.3 Pricing (R2-PRICE, dateModified 2026-10-01)

| | Standard storage | Infrequent Access storage |
| --- | --- | --- |
| Storage | $0.015 / GB-month | $0.01 / GB-month |
| Class A Operations | $4.50 / million requests | $9.00 / million requests |
| Class B Operations | $0.36 / million requests | $0.90 / million requests |
| Data Retrieval (processing) | None | $0.01 / GB |
| **Egress (data transfer to Internet)** | **Free** | **Free** |

Free tier (**Standard storage only**; "The free tier only applies to Standard storage, and does not
apply to Infrequent Access storage"):

| | Free |
| --- | --- |
| Storage | 10 GB-month / month |
| Class A Operations | 1 million requests / month |
| Class B Operations | 10 million requests / month |
| Egress (data transfer to Internet) | Free |

Egress confirmation, footnote 1:

> "Egressing directly from R2, including via the Workers API, S3 API, and `r2.dev` domains does not
> incur data transfer (egress) charges and is free. If you connect other metered services to an R2
> bucket, you may be charged by those services." — R2-PRICE

**Class A operations** (mutate state; more expensive):
`ListBuckets`, `PutBucket`, `ListObjects`, `PutObject`, `CopyObject`, `CompleteMultipartUpload`,
`CreateMultipartUpload`, `LifecycleStorageTierTransition`, `ListMultipartUploads`, `UploadPart`,
`UploadPartCopy`, `ListParts`, `PutBucketEncryption`, `PutBucketCors`,
`PutBucketLifecycleConfiguration`. — R2-PRICE

**Class B operations** (read state):
`HeadBucket`, `HeadObject`, `GetObject`, `UsageSummary`, `GetBucketEncryption`, `GetBucketLocation`,
`GetBucketCors`, `GetBucketLifecycleConfiguration`. — R2-PRICE

**Free operations**: `DeleteObject`, `DeleteBucket`, `AbortMultipartUpload`. — R2-PRICE

Billing note relevant to multipart designs: storage is billed on **peak storage per day averaged over
a 30-day billing period**, rounded up (1.1 GB-month bills as 2 GB-month). Infrequent Access has a
**30-day minimum storage duration**; Standard has none. — R2-PRICE

Also: `PutObject` / `CreateMultipartUpload` accept `x-amz-storage-class` with `STANDARD` or
`STANDARD_IA` only; ACLs, tagging, object lock and `x-amz-server-side-encryption` (SSE-KMS style) are
**not** implemented — SSE-C is. — R2-S3

---

## 5. Workers ↔ R2 bindings: multipart, ranged reads, streaming responses

### 5.1 Yes, there is a full `R2Bucket` multipart API

- `createMultipartUpload(key, options?) => Promise<R2MultipartUpload>` — "Once the multipart upload
  has been created, the multipart upload can be immediately interacted with globally, either through
  the Workers API, or through the S3 API." — R2-WAPI
- `resumeMultipartUpload(key, uploadId) => R2MultipartUpload` — "does not perform any checks to
  ensure the validity of the uploadId, nor does it verify the existence of a corresponding active
  multipart upload. This is done to minimize latency." — R2-WAPI
- `R2MultipartUpload.uploadPart(partNumber, value, options?) => Promise<R2UploadedPart>` where
  `value` is `ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob` — i.e. **a request body
  stream can be written straight to a part** — R2-WAPI
- `R2MultipartUpload.abort()` and `complete(uploadedParts) => Promise<R2Object>` — "Once this
  happens, the object is immediately accessible globally by any subsequent read operation." — R2-WAPI
- Caveat: "An `R2MultipartUpload` object does not guarantee that there is an active underlying
  multipart upload corresponding to that object. A multipart upload can be completed or aborted at
  any time, either through the S3 API, or by a parallel invocation of your Worker." — R2-WAPI

**The documented pattern for size**: a Worker-fronted multipart API "also allows you to use your
Worker to upload files larger than the Workers request body size limit. The uploading of individual
parts is still subject to this limit." — R2-WMPU

**State management** is the design consequence:

> "The stateful nature of multipart uploads does not easily map to the usage model of Workers, which
> are inherently stateless. In a normal multipart upload, the multipart upload is usually performed
> in one continuous execution of the client application. This is different from multipart uploads in
> a Worker, which will often be completed over multiple invocations of that Worker. … the `uploadId`
> and which parts have been uploaded, needs to be kept track of somewhere outside of the Worker."
> Proposed home: the client, or "a Durable Object or other database". — R2-WMPU

### 5.2 Ranged reads: yes

`R2GetOptions.range` accepts `R2Range | Headers`; `R2Range` supports three shapes — `{offset, length}`,
`{length}` (optional offset with a length) and `{suffix}`. "If more bytes are requested than exist in
the object, fewer bytes than this number may be returned." The returned `R2Object.range` reports the
range actually returned. Conditional headers are supported except `If-Range`. — R2-WAPI

### 5.3 Streaming an R2 object back to a client

Yes — return the object body stream as the `Response` body. Cloudflare's binding example passes
`request.headers` straight through as `range` and `onlyIf`, then:

```js
return new Response("body" in object ? object.body : undefined, {
  status: "body" in object ? 200 : 412,
  headers,
});
```

with `object.body` typed as `ReadableStream` on `R2ObjectBody`. — R2-WUSE, R2-WAPI

Does it count against the memory limit? The **unsupported** alternative does; the streaming form is
the documented way to avoid it:

> "Workers have a memory limit of 128 MB per Worker and loading particularly large files into a
> Worker's memory multiple times may reach this limit. To ensure memory usage does not reach this
> limit, consider using Streams." — R2-WUSE

And the memory-error remedy is explicitly "Stream request and response bodies … instead of buffering
entire payloads in memory." — W-LIM

Note the asymmetry: there is **no enforced response body size limit** for Workers (W-LIM), and R2
egress is free via the Workers API (R2-PRICE), so streaming a multi-GB object to a client is
documented-legal; the client must stay connected because duration is only unbounded "as long as the
client remains connected" (W-LIM).

---

## 6. D1 limits and SQLite specifics

### 6.1 Limits (D1-LIM, "Last updated Apr 21, 2026")

| Feature | Limit |
| --- | --- |
| Databases per account | 50,000 (Workers Paid) / 10 (Free) |
| **Maximum database size** | **10 GB (Workers Paid) / 500 MB (Free)** |
| Maximum storage per account | 1 TB (Workers Paid) / 5 GB (Free) |
| Time Travel duration (PITR) | 30 days (Paid) / 7 days (Free) |
| Maximum Time Travel restore operations | 10 restores per 10 minutes (per database) |
| **Queries per Worker invocation** | **1000 (Paid) / 50 (Free)** |
| **Maximum number of columns per table** | **100** |
| Maximum number of rows per table | Unlimited (excluding per-database storage limits) |
| **Maximum string, `BLOB` or table row size** | **2,000,000 bytes (2 MB)** |
| **Maximum SQL statement length** | **100,000 bytes (100 KB)** |
| **Maximum bound parameters per query** | **100** |
| Maximum arguments per SQL function | 32 |
| Maximum characters (bytes) in a `LIKE` or `GLOB` pattern | 50 bytes |
| Maximum bindings per Workers script | Approximately 5,000 |
| Maximum SQL query duration | 30 seconds |
| Maximum file import (`d1 execute`) size | 5 GB |

Caveats printed with that table:

- "Limits for individual queries (listed above) apply to each individual statement contained within
  a batch statement. For example, the maximum SQL statement length of 100 KB applies to each
  statement inside a `db.batch()`." — D1-LIM
- The 10 GB per-database cap **cannot be increased**: "Note that the 10 GB limit of a D1 database
  cannot be further increased." D1 is positioned as "horizontal scale out across multiple, smaller
  (10 GB) databases, such as per-user, per-tenant or per-entity databases." — D1-LIM
- The 30-second query limit is justified by: "Requests to Cloudflare API must resolve in 30 seconds.
  Therefore, this duration limit also applies to the entire batch call." — D1-LIM
- "You can open up to six connections (to D1) simultaneously for each invocation of your Worker." —
  D1-LIM

### 6.2 Engine and SQLite semantics

> "D1 is compatible with most SQLite's SQL convention since it leverages **SQLite's query engine**."
> — D1-SQL

An exact SQLite **version number is not published** on the pages checked (D1-SQL, D1-LIM, D1-FAQ).
Where a version boundary is documented, it is documented indirectly. **SQLite version: unverified.**

**Supported SQLite extensions** (an explicit, short list):

> "D1 supports a subset of SQLite extensions for added functionality, including:
> - FTS5 module for full-text search (including `fts5vocab`).
> - JSON extension for JSON functions and operators.
> - Math functions.
>
> Refer to the source code for the full list of supported functions." — D1-SQL

So **JSON1 is available** (`json_*` functions and operators; D1 has a dedicated
`/d1/sql-api/query-json/` page), **FTS5 is available**, math functions are available. `rtree`,
sessions, and other modules are **not listed** — their availability is **unverified**, not denied.

**PRAGMA support is enumerated** (D1-SQL): `table_list`, `table_info`, `table_xinfo`, `index_list`,
`index_info`, `index_xinfo`, `quick_check`, `foreign_key_check`, `foreign_key_list`,
`case_sensitive_like`, `ignore_check_constraints`, `legacy_alter_table`, `recursive_triggers`,
`reverse_unordered_selects`, `foreign_keys`, `defer_foreign_keys`, `optimize`. Notable:

- `PRAGMA foreign_keys = (on|off)` toggles enforcement — the docs describe both states but do **not**
  state the D1 default. **Default FK enforcement: unverified.**
- `PRAGMA defer_foreign_keys = (on|off)` defers enforcement "until the end of the current
  transaction"; unresolved violations fail with `FOREIGN KEY constraint failed`. `ON DELETE CASCADE`
  still executes while checks are deferred. — D1-SQL
- "D1 PRAGMA statements only apply to the current transaction." — D1-SQL
- "Currently, D1 does not support `PRAGMA optimize(-1)`." — D1-SQL
- `PRAGMA legacy_alter_table` is documented relative to "the legacy version of SQLite (**3.24.0**)",
  implying D1's engine is at or beyond that boundary. — D1-SQL

**`ALTER TABLE ... DROP COLUMN`:** the generated-columns page tells you to drop a column like this:

> "To change how a generated column generates its data, you can use `ALTER TABLE table_name REMOVE
> COLUMN` and then `ADD COLUMN` to re-define the generated column, or `ALTER TABLE table_name RENAME
> COLUMN current_name TO new_name`…" — D1-GEN

**Important:** `REMOVE COLUMN` is **not** SQLite's syntax — SQLite's grammar is
`ALTER TABLE ... DROP COLUMN` (https://sqlite.org/lang_altertable.html, §5), and SQLite notes the
command "only works if the column is not referenced" elsewhere. Whether D1 accepts `DROP COLUMN`,
accepts `REMOVE COLUMN`, or accepts both is **unverified** from the Cloudflare pages checked (D1-SQL
lists no `ALTER TABLE` statement forms at all; D1-GEN shows `REMOVE COLUMN` prose only). Treat any
column-drop migration as needing empirical verification against a real D1 database before relying on
it, and prefer the additive `ADD COLUMN` + new-table-copy pattern.

Other SQLite-specific constraints that matter for schema design:

- Generated columns: "Columns added to an existing table via `ALTER TABLE ... ADD COLUMN` must be
  `VIRTUAL`. You cannot add a `STORED` column to an existing table." Generated column definitions
  "cannot be directly modified". — D1-GEN
- `CREATE TABLE` with `INTEGER PRIMARY KEY`, `VARCHAR(8000)`, `DECIMAL`, `BLOB` etc. all appear in
  Cloudflare's own documented schema examples (`Id INTEGER PRIMARY KEY`, `CustomerId VARCHAR(8000)`),
  i.e. standard SQLite type-affinity declarations. — D1-SQL
- D1's own system tables appear in `PRAGMA table_list`; `sqlite_schema` / `sqlite_master` are
  queryable, and `sqlite_master` "shows all tables, indexes, and the original SQL used to generate
  them". — D1-SQL

### 6.3 Durability / recovery

Time Travel point-in-time recovery covers 30 days (Paid) / 7 days (Free), max 10 restores per 10
minutes per database. — D1-LIM

---

## 7. D1 concurrency, transactions, consistency

### 7.1 Single-threaded per database, queueing, no cross-statement atomicity guarantee

> "Each individual D1 database is **inherently single-threaded, and processes queries one at a
> time**. Your maximum throughput is directly related to the duration of your queries. … A database
> that receives too many concurrent requests will first attempt to **queue** them. If the queue
> becomes full, the database will return an **"overloaded" error**." — D1-LIM (repeated verbatim in D1-FAQ)

> "Each individual D1 database is backed by a single Durable Object. When using D1 read replication
> each replica instance is a different Durable Object and the guidelines apply to each replica
> instance independently." — D1-LIM

Writes are also expensive by design: "Writes need to be durably persisted across several locations" —
D1-LIM. And large mutations must be chunked: "A single query that attempts to modify hundreds of
thousands of rows or hundreds of MBs of data at once will exceed execution limits. Break the work
into smaller chunks (e.g., processing 1,000 rows at a time)." — D1-LIM

### 7.2 Interactive transactions: not documented; auto-commit + `batch()` is the documented unit

> "Sends multiple SQL statements inside a single call to the database. This can have a huge
> performance impact as it reduces latency from network round trips to D1. **D1 operates in
> auto-commit.** Our implementation guarantees that each statement in the list will execute and
> commit, sequentially, non-concurrently.
>
> **Batched statements are SQL transactions. If a statement in the sequence fails, then an error is
> returned for that specific statement, and it aborts or rolls back the entire sequence.**" — D1-DB

What is *not* there: the D1 Database binding page documents `prepare()`, `batch()`, `exec()`,
`withSession()` and no `begin`/`commit`/`rollback` API. The D1 SQL statements page's supported
statement list contains **no** `BEGIN`, `COMMIT`, `ROLLBACK`, `END TRANSACTION` or `SAVEPOINT`
entries (searched explicitly, zero matches — D1-SQL). No Cloudflare page found documents
interactive/client-driven transaction control. **Conclusion: an application must not assume
multi-statement atomicity beyond a single `db.batch()` call, and must not design around interactive
transactions.** (`batch()` atomicity itself is explicitly documented, quoted above.)

### 7.3 Sessions, bookmarks and read-after-write

`withSession()` "Starts a D1 session which maintains **sequential consistency** among queries executed
on the returned `D1DatabaseSession` object." Forms:

- `first-primary` — "Directs the first query in the Session (whether read or write) to the primary
  database instance. Use this option if you need to start the Session with the most up-to-date data
  from the primary database instance." Subsequent queries may use replicas.
- `first-unconstrained` — "Directs the first query in the Session to any database instance… This is
  the default behavior when no parameter is provided."
- `bookmark` — "A `bookmark` from a previous D1 Session. This allows you to start a new Session from
  at least the provided `bookmark`."

`D1DatabaseSession` adds `getBookmark()` → "A `bookmark` which identifies the latest version of the
database seen by the last query executed within the Session. Returns `null` if no query is executed
within a Session." — D1-DB

Cloudflare's own example threads the bookmark over HTTP with the header name **`x-d1-bookmark`**:

```js
const bookmark = request.headers.get("x-d1-bookmark") ?? "first-unconstrained";
const session = env.DB01.withSession(bookmark);
// ...
response.headers.set("x-d1-bookmark", session.getBookmark() ?? "");
```

— D1-REPL

Read replication only helps reads: "All write queries are still forwarded to the primary database
instance." "To use read replication, you must use the D1 Sessions API, otherwise all queries will
continue to be executed only by the primary database." — D1-REPL

### 7.4 Eventual consistency of replicas — the exact wording

> "D1 asynchronously replicates changes from the primary database instance to all read replicas. This
> means that at any given time, **a read replica may be arbitrarily out of date**. The time it takes
> for the latest committed data in the primary database instance to be replicated to the read replica
> is known as the **replica lag**. **Replica lag and non-deterministic routing to individual replicas
> can lead to application data consistency issues.** The D1 Sessions API solves this by ensuring
> sequential consistency." — D1-REPL

> "D1 read replication offers sequential consistency. D1 creates a global order of all operations
> which have taken place on the database, and can identify the latest version of the database that a
> query has seen, using bookmarks. It then serves the query with a database instance that is at least
> as up-to-date as the bookmark passed along with the query to execute. Sequential consistency has
> properties such as: **Monotonic reads**: If you perform two reads one after the other (read-1, then
> read-2), read-2 cannot read a version of the database prior to read-1." — D1-REPL

Observability for this: `served_by_region` and `served_by_primary` in the `D1Result.meta` object
(present for all remote requests regardless of whether replication or Sessions are used;
`undefined` under `wrangler dev`). — D1-REPL

Known limitation: "Sessions API is only available via the D1 Worker Binding and not yet available via
the REST API." Disabling read replication "takes up to 24 hours for replicas to stop processing
requests", and Sessions API remains safe on databases without replication. — D1-REPL

---

## 8. Access / auth options for a Worker API (summary level)

### 8.1 Access in front of a Worker

Documented ways to protect a Worker, with API destination types (W-ACCESS, Last updated Aug 18, 2026):

| Goal | API destination type |
| --- | --- |
| Preview deployments for all Workers | `all_preview_workers` |
| Production + preview for all Workers | `all_workers` |
| Preview for one Worker | `preview_worker` |
| Production + preview for one Worker | `worker` (`worker_id`) |
| A specific hostname — "can be `workers.dev`, a Custom Domain, or a path" | Self-hosted application domain |

Key caveats stated on that page:

- Worker-level Access policies **do not support WebSocket connections**: "WebSocket upgrade requests
  to a Worker protected by a worker-level Access policy will fail with a `403` error." Use
  hostname-based Access instead.
- Access protects the Worker "before your Worker runs".
- `ctx.access.getIdentity()` lets an authenticated Worker read email/groups/device posture without
  parsing JWTs — but "`ctx.access` applies only to the Worker invocation authenticated by Access.
  Cloudflare Access does not propagate `ctx.access` through Service Binding HTTP requests or RPC
  invocations." With Static Assets, "the router does not pass `ctx.access` to the user Worker".
- Requirements: "Zero Trust enabled on your account" and permission to manage Workers + Access apps.
- Manual JWT validation is still required if the Worker is behind Access and you want to trust the
  identity: the request carries `Cf-Access-Jwt-Assertion` (and `CF_Authorization` cookie for
  browsers); Cloudflare's documented Worker example verifies it with `jose`'s `createRemoteJWKSet`
  against `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`, checking `issuer` and
  `audience` (`POLICY_AUD`). "By default, Access rotates the signing key every 6 weeks… Previous keys
  remain valid for 7 days after rotation." — A-JWT

### 8.2 Service Tokens (machine-to-machine) — the documented path for non-browser clients

- Access generates a **Client ID + Client Secret**; send them as
  `CF-Access-Client-Id: <CLIENT_ID>` and `CF-Access-Client-Secret: <CLIENT_SECRET>`. — A-TOK
  (Last updated Oct 2, 2026)
- The policy action must be **Service Auth**, "otherwise, Access will prompt for an identity provider
  login". — A-TOK
- **Duration is configurable at creation** (example uses `"duration": "8760h"` = 1 year); tokens can
  be refreshed (+1 year) or re-dated, rotated, disabled, revoked. Client Secret is shown once only.
  — A-TOK
- Secret format changed: "As of August 26, 2026, new service token Client Secrets use the format
  `cfast_[40 alphanumeric characters][8-character checksum]`. Existing Client Secrets use a
  64-character hexadecimal format." — A-TOK
- **Single-header mode** exists for clients that support only one custom header: set
  `read_service_tokens_from_header` on the application, then send
  `Authorization: {"cf-access-client-id": "...", "cf-access-client-secret": "..."}`. — A-TOK
- **Strict service token authentication** (Zero Trust org setting): failed auth returns `401`/`403`
  instead of a `302` login redirect; "Only Service Auth policies can authorize the request. Access
  ignores Allow policies and any `CF_Authorization` cookie"; no `CF_Authorization` cookie is returned.
  "Zero Trust organizations created on or after `2026-10-05` have strict service token
  authentication turned on by default and cannot turn it off." — A-TOK
- Rotation supports a grace window: "Available grace periods range from one hour to 30 days."
  — A-TOK

### 8.3 Mutual TLS — Enterprise / pay-as-you-go only

> "Access mTLS is available with **Enterprise and pay-as-you-go Zero Trust plans. It is not included
> in the Free plan. Free customers can use service tokens to authenticate automated systems.**" — A-MTLS

Mechanics: upload a root CA (public or self-signed; `Basic Constraints: CA=TRUE`) with the associated
hostnames; policy selectors are **Valid Certificate** or **Common Name**; non-IdP clients use
`Action = Service Auth`. Clients present a certificate; without one the request returns `403`.
Client-certificate forwarding to origin can be done with RFC 9440 `Client-Cert` / `Client-Cert-Chain`
headers built from `cf.tls_client_auth.cert_rfc9440` / `cert_chain_rfc9440`, and **must** be gated on
`cf.tls_client_auth.cert_verified` and `cert_revoked` because "The `cert_rfc9440` and
`cert_chain_rfc9440` fields are populated **regardless of the certificate validation result**" and
clients can inject their own such headers. Size limits: leaf 10 KiB, chain 16 KiB. Legacy
`Cf-Client-Cert-Der-Base64` / `Cf-Client-Cert-Sha256` forwarding is Cloudflare-proprietary. — A-MTLS

Documented mTLS limitation relevant to this system:

> "mTLS does not currently work for: … Cloudflare R2 public bucket served on a custom domain"
> — A-MTLS

Access self-hosted applications require "An active domain on Cloudflare" with a full or partial
(`CNAME`) DNS setup. — A-APP

### 8.4 Cloudflare API tokens (account-scoped, not a caller-auth mechanism for your API)

R2-specific API tokens double as **S3 Access Key ID / Secret Access Key** credentials: "You can
generate an API token to serve as the Access Key for usage with existing S3-compatible SDKs or XML
APIs." Permissions: `Admin Read & Write`, `Admin Read only`, `Object Read & Write`,
`Object Read only`; the object-scoped ones can be restricted to specific buckets and "are only
supported by the S3-compatible API, not the Cloudflare REST API". "You will not be able to access
your Secret Access Key again after this step." — R2-TOK (Last updated Oct 1, 2026)

These authenticate *your* code to Cloudflare, not third parties to your Worker. For authenticating
VPS agents to an ingest endpoint, the documented options are Access Service Tokens (A-TOK) — or a
secret implemented in the Worker itself (**not documented as a platform feature; unverified**).

### 8.5 Rate limiting

Not investigated in depth. The only rate-limit facts captured here are R2-side: managed `r2.dev`
throttles at "hundreds of requests/second" with `429`, and the R2 REST API is capped at 1,200
requests / 5 minutes per account. — R2-LIM

---

## 9. Presigned URLs for R2

### 9.1 Officially documented, with stated parameters

> "To generate a presigned URL, you specify: 1. **Resource identifier**: Account ID, bucket name, and
> object path 2. **Operation**: The S3 API operation permitted (GET, PUT, HEAD, or DELETE) 3.
> **Expiry**: **Timeout from 1 second to 7 days (604,800 seconds)**" — R2-PRE (Last updated Aug 22, 2026)

> "Presigned URLs are generated **server-side with no communication with R2**, requiring only your R2
> API credentials and an implementation of the AWS Signature Version 4 signing algorithm." — R2-PRE

Documented SDK path (prerequisites: Account ID, R2 API token → Access Key ID + Secret Access Key,
"AWS SDK or compatible S3 client library"): `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
`getSignedUrl(...)` with `expiresIn`, or boto3 `generate_presigned_url`, or
`aws s3 presign` — with the explicit CLI limitation "The AWS CLI presign command only supports GET
operations." — R2-PRE

### 9.2 Documented limitations and caveats

- **Supported methods**: GET, HEAD, PUT, DELETE. "`POST` (multipart form uploads via HTML forms) is
  **not currently supported**." — R2-PRE
- **Custom domains are not usable**: "Presigned URLs work with the S3 API domain
  (`<ACCOUNT_ID>.r2.cloudflarestorage.com`) and **cannot be used with custom domains**. If you need
  authentication with R2 buckets accessed via custom domains (public buckets), use the WAF HMAC
  validation feature (requires Pro plan or above)." — R2-PRE
- **Bearer-token semantics, no caller binding documented**: "Treat presigned URLs as bearer tokens.
  Anyone with the URL can perform the specified operation until it expires." The signature covers
  resource, operation and expiry — tampering yields `403/SignatureDoesNotMatch` — but the docs state
  no IP binding, no single-use limit ("The same presigned URL can be reused multiple times until it
  expires"), and no revocation mechanism. — R2-PRE
- **CORS is required for browser use**: "If your presigned URLs will be used from a browser, set up
  CORS rules on your bucket to control which origins can make requests." — R2-PRE
- **Content-Type can be pinned into the signature**: a mismatched `Content-Type` on upload fails with
  `403/SignatureDoesNotMatch`. — R2-PRE

### 9.3 Where presigning must happen, and what the docs recommend for Workers

Cloudflare documents presigning as an S3-SDK operation performed where your credentials live, and
explicitly positions the **binding** as the alternative for server-side access:

> "R2 bindings in Workers — Alternative for server-side R2 access with built-in authentication."
> — R2-PRE (Related resources)

For a Worker that must mint short-lived access **without** shipping an AWS SDK, Cloudflare documents a
different, newer mechanism — **temporary credentials** — and shows `aws4fetch` (a Workers-compatible
SigV4 signer) used from a Worker:

- "Temporary credentials are short-lived, scoped S3 credentials derived from an existing R2 API token.
  They authenticate with AWS Signature Version 4, the same as a long-lived token, but include a
  session token and expire automatically. The session token is sent with every request via the
  `X-Amz-Security-Token` header." — R2-TMP (Last updated Apr 24, 2026)
- Two issuance paths: the **Temporary Credentials API** (Cloudflare signs for you), or **local
  client-side signing** — "signing a JWT with your parent API token's secret access key and using it
  as the session token" (HS256; temporary secret = SHA-256 hex digest of the signed JWT; session token
  = `base64("jwt/" + <signed-jwt>)`; parent Access Key ID reused). — R2-TMP
- Scoping: always exactly one bucket; `scope` presets (`object-read-only`, `object-read-write`,
  `admin-read-only`, `admin-read-write`) or an explicit `actions` list; optional `prefixes` /
  `objects` path restriction. "`actions` is currently supported via local signing only." Permitted
  actions are enumerated, including the multipart set and `ListParts` / `ListMultipartUploads`.
  — R2-TMP
- Explicit placement guidance for the secret: "**Never ship your parent secret access key to a
  client. Local signing must happen in a trusted environment (such as your backend or a Worker).**"
  — R2-TMP
- The documented usage example in a Worker uses `aws4fetch`:

```ts
import { AwsClient } from "aws4fetch";
const client = new AwsClient({
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
  sessionToken: SESSION_TOKEN,
  service: "s3",
});
const response = await client.fetch(`${R2_URL}/my-bucket/image.png`);
```

— R2-TMP

**What is *not* documented:** Cloudflare's presigned-URL page never mentions `aws4fetch` or any
non-AWS-SDK SigV4 implementation, and does not state that presigning can be done inside a Worker
runtime (which lacks Node's `crypto` and the AWS SDK's Node-oriented dependencies by default). The
inference "you can presign inside a Worker with a WebCrypto/`aws4fetch`-style HS256/SigV4 signer" is
therefore supported only indirectly, by the temporary-credentials page's `aws4fetch`-in-a-Worker
example. **Presigning from inside a Worker: officially implied, not explicitly documented.**

**Temporary credentials vs presigned URLs, as Cloudflare draws the line:**

| Pattern | Grants | Good for |
| --- | --- | --- |
| Presigned URLs | "A single S3 operation on a single object" | "Granting direct HTTP access to a single object without an S3 client, such as a browser upload or a shareable download link" |
| Temporary credentials | "Multiple S3 operations, scoped to a bucket and a set of permitted operations, and optionally to specific paths" | "Callers that use a standard S3 client or SDK to perform multiple operations in a scoped session" |

— R2-TMP, R2-PRE (identical wording on both pages)

### 9.4 Public buckets (the no-signing alternative) and its own caveats

- Public buckets are the documented alternative to presigning; two mechanisms: a custom domain under
  your control, or a Cloudflare-managed `r2.dev` subdomain. — R2-PUB (Last updated Sep 25, 2026)
- "`r2.dev` … is intended for non-production traffic", "Public access through `r2.dev` subdomains is
  rate-limited and should only be used for development purposes", and "Avoid creating a CNAME record
  pointing to the `r2.dev` subdomain. This is an **unsupported access path**." — R2-PUB
- To get WAF custom rules, caching, access controls or Bot Management you **must** use a custom
  domain: "These capabilities are not available when using the `r2.dev` development url." — R2-PUB
- "Currently, public buckets do not let you list the bucket contents at the root of your (sub)
  domain." — R2-PUB
- If you put WAF or Access in front of a custom domain, disable `r2.dev`: "If you do not disable
  public access, your bucket will remain publicly available through your `r2.dev` subdomain."
  — R2-PUB

---

## 10. Explicitly unverified items

Stated here so the design doc does not inherit invented numbers:

1. **Maximum number of multipart uploads in progress** — not on R2-LIM, R2-UP, R2-S3, R2-WAPI,
   R2-WMPU.
2. **D1's exact SQLite version** — not published on D1-SQL, D1-LIM, D1-FAQ. Only indirect evidence:
   `legacy_alter_table` references SQLite 3.24.0.
3. **Whether D1 accepts `ALTER TABLE ... DROP COLUMN`** (vs the documented prose `REMOVE COLUMN`) —
   D1-SQL lists no ALTER TABLE forms; D1-GEN uses `REMOVE COLUMN`. Must be verified empirically.
4. **D1 default for `PRAGMA foreign_keys`** — the PRAGMA is documented, its default is not.
5. **Whether D1 supports interactive `BEGIN`/`COMMIT`/`SAVEPOINT`** — not documented anywhere found
   (zero matches on D1-SQL; D1-DB exposes no such API). Treated as unsupported for design purposes.
6. **SFTP/SSH client feasibility from a Worker** — the TCP+TLS transport is documented and SSH is
   named as a motivating protocol (W-SOCK), but no SSH/SFTP client or example is documented.
7. **Cron invocation delay/skip guarantees** — no delivery-semantics statement found on W-CRON or
   W-LIM.
8. **Presigning inside the Workers runtime** — not stated on R2-PRE; only implied by the
   `aws4fetch`-in-a-Worker example on R2-TMP.
9. **Presigned-URL IP binding / single-use / revocation** — R2-PRE documents none of these.
10. **Any documented cap on Worker rate limiting / WAF for a Worker endpoint** — out of scope of the
    pages read; not asserted here.

---

## 11. Design implications

The 10 constraints that most directly shape this architecture, in priority order:

1. **Ingest cannot be one big upload through a Worker.** Inbound body caps at 100 MB (Free/Pro),
   200 MB (Business) — and that cap is set by the **zone** plan, while the Worker only has 128 MB of
   memory per isolate to work with, streamed or not. Anything larger than a small file must be
   chunked, and the documented chunking mechanism is **R2 multipart through the Worker** with
   ≥5 MiB parts, ≤10,000 parts, ≤5 GiB per part, ≤4.995 TiB per object. (W-LIM, R2-LIM, R2-UP,
   R2-WMPU)
2. **Multipart state must live outside the Worker.** Cloudflare states plainly that Workers are
   stateless across invocations and the `uploadId` + uploaded-parts state "needs to be kept track of
   somewhere outside of the Worker" — client-side or in "a Durable Object or other database."
   That is a D1 schema decision made on day one, not a later optimization. (R2-WMPU)
3. **Do not design around transactions.** D1 is documented as **auto-commit**; the only documented
   multi-statement atomic unit is a single `db.batch()`. No `BEGIN`/`COMMIT`/`ROLLBACK` API or SQL
   form is documented. Multi-step ingest state transitions (created → parts uploaded → completed →
   verified) must be idempotent, conditionally written, and resumable, with compensating cleanup —
   not atomic. Reinforces the project's existing "no transactions" rule. (D1-DB, D1-SQL)
4. **A Worker pulling from the VPS is transport-legal but protocol-unsupported and fan-out-limited.**
   `connect()` gives real outbound TCP with optional TLS, and Cloudflare names SSH/FTP as the
   motivating protocols — but no SSH/SFTP client is documented, private IPs and `localhost` are
   refused, port 25 is blocked, only **6** connections may be waiting for headers at once per
   invocation, and a Cron-triggered run is capped at **15 minutes** wall time. A VPS-side agent that
   pushes over HTTPS uses only first-class primitives; the same 6-connection and 15-minute ceilings
   argue for many small, idempotent push requests over one long pull session. (W-SOCK, W-LIM)
5. **Downloads should be streamed from R2, not proxied through Worker memory.** Returning an R2
   object body (`R2ObjectBody.body`, a `ReadableStream`) as the `Response` body is the documented
   pattern, response bodies have **no enforced size limit**, HTTP-triggered Workers have **no wall
   clock limit while the client stays connected**, and R2 egress is **free** — including via the
   Workers API. Ranged reads (`{offset, length}` / `{suffix}`) support resumable downloads. (R2-WUSE,
   W-LIM, R2-PRICE, R2-WAPI)
6. **Presigned URLs are a real option but come with three hard edges:** expiry is capped at
   **7 days**, they **cannot be used with custom domains** (only
   `<ACCOUNT_ID>.r2.cloudflarestorage.com`), and they are unrevocable bearer tokens with no
   documented IP binding or single-use semantics. `POST` form uploads are unsupported. If a
   custom-domain download experience is required, the documented alternative is a public bucket +
   WAF/Access in front, with `r2.dev` explicitly demoted to non-production. (R2-PRE, R2-PUB)
7. **Temporary credentials are the better fit for per-request, scoped, short-lived access** and are
   the newer documented mechanism: bound to exactly one bucket, scope- or action-limited, optionally
   path-limited, with `actions` scoping available via **local JWT signing only**. Local signing must
   happen in a trusted environment — Cloudflare's own words include "such as your backend or a
   Worker" — and the page demonstrates `aws4fetch` from a Worker. (R2-TMP)
8. **Scheduling is minute-granular, UTC-only, and weakly delivered.** Five-field UTC cron, minimum
   interval one minute, **5 Cron Triggers per account on Free** vs 250 on Paid, up to 15 minutes to
   propagate config changes, and 15 minutes maximum wall time per Cron invocation with 10 ms CPU on
   Free. Trigger-driven reconciliation must therefore be resumable across invocations and must not
   assume a missed minute is impossible. (W-CRON, W-LIM)
9. **D1 is small, and the ceiling is immutable.** 10 GB per database (Paid) / 500 MB (Free) and
   "cannot be further increased"; 2 MB max row/string/BLOB; 100 columns; 100 KB SQL; 100 bound
   parameters; **1,000 queries per Worker invocation** (50 on Free); 30 s per query/batch; one write
   at a time per database with an "overloaded" error when the queue fills. Object-level metadata
   belongs in D1; file content belongs in R2. (D1-LIM, D1-FAQ)
10. **Read-after-write consistency requires opting in via sessions/bookmarks.** Replicas "may be
    arbitrarily out of date" and routing is non-deterministic; sequential consistency only holds
    inside a `withSession()` session, threaded across requests with a bookmark (Cloudflare's example
    uses the `x-d1-bookmark` header). A downloader that reads metadata it just wrote must use
    `withSession("first-primary")` or pass a bookmark. (D1-REPL, D1-DB)

Secondary but load-bearing:

- **Auth for machine callers**: Access **Service Tokens** (`CF-Access-Client-Id` /
  `CF-Access-Client-Secret`, policy action **Service Auth**, configurable duration, rotation with a
  1-hour-to-30-day grace window, single-header mode for clients that support only one header) is the
  documented non-browser path; Access **mTLS is Enterprise/pay-as-you-go only** and explicitly does
  not work for an R2 public bucket on a custom domain. Worker-level Access policies break WebSockets
  (`403`). If the Worker must trust identity it still has to validate `Cf-Access-Jwt-Assertion`
  against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, remembering that signing keys
  rotate every 6 weeks with a 7-day overlap. (A-TOK, A-MTLS, W-ACCESS, A-JWT)
- **Concurrency budget**: 6 simultaneous in-flight connections per invocation is the shared ceiling
  for `fetch()`, `connect()`, R2 `get/put/list/delete/head`, KV, Queues send, Cache and outbound
  WebSockets — and D1 connections count against the same notion. Parallelism must be designed around
  that number. (W-LIM, D1-LIM)
- **Cleanup is automatic but delayed**: incomplete multipart uploads expire after **7 days** by
  default, so abandoned ingest sessions do not leak storage indefinitely — but "in progress" is not
  free for 7 days either. (R2-LIFE, R2-WAPI)
