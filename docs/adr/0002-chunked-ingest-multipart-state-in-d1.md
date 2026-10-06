# Chunked ingest, with Multipart Session state held outside the Worker

Files up to 100 MB cannot be pushed through a Worker in one request and buffered: the inbound request
body cap is set by the **zone** plan (Free and Pro 100 MB, Business 200 MB), while a Worker isolate has
only **128 MB** of memory. Accepting a body at the edge and holding it are different things.

So ingest is chunked, and Cloudflare states plainly that the multipart state — the `uploadId` and the
parts already accepted — "needs to be kept track of somewhere outside of the Worker", because Workers
are stateless across invocations. That state therefore lives in **D1** as a Multipart Session, which is
a day-one schema decision rather than a later optimisation.

Two consequences that are easy to get wrong:

- `resumeMultipartUpload` performs **no validation** and does not guarantee an underlying upload still
  exists — Cloudflare explicitly names "a parallel invocation of your Worker" as a way it can vanish.
  Every operation on the handle needs error handling, and the Session record is the source of truth.
- **Per-part checksums are not available on the multipart path.** `md5`/`sha*` exist only on `put()`
  options; `R2MultipartOptions` has no checksum field. Integrity therefore has to be verified by
  content hash at the Object Version level, not per chunk.

Abandoned Multipart Sessions are not free forever: R2 aborts incomplete multipart uploads after 7 days.
