# 12: Derived objects — a declarative merge engine, text first

**What to build:** The operator defines a merge in the interface: which stored files it takes, in what
order, how it combines them, and what to call the result. The result becomes a stored file like any
other — browsable, downloadable, shareable — and the interface records what it was built from.

This ticket deliberately does **text** combination only. Combining documents by their structure is
ticket 13, and both exist because the concrete requirement is a structured merge, which is a different
mechanism from concatenation.

**Blocked by:** 08, 09.

**Status:** ready-for-agent

- [ ] A merge rule can be created naming its source files, its ordering, its combination, and its output name, with no code involved.
- [ ] Sources are selected with the same directory-pattern vocabulary used for collection, so "which files" has one description in this product rather than two.
- [ ] Sources are ordered by an explicit stated rule, so that re-running an unchanged merge produces byte-identical output.
- [ ] The combined result is stored as a derived object and appears in the interface like any collected file.
- [ ] The derived object records the sources it was built from and a content hash of each, so that "is this current" is decidable rather than guessed.
- [ ] The interface shows whether a derived object is current or stale, and which sources it came from.
- [ ] A preview shows what a merge would produce — at minimum the source count and total size — **before** anything is stored.
- [ ] A derived object is marked important when created, because the budget policy never evicts an important object and a derived object whose sources were evicted could never be rebuilt.
- [ ] A merge whose sources are missing or empty fails with an explanation and **leaves any previous derived object in place** rather than replacing it with an empty or partial result.
- [ ] A merge cannot take itself as a source, directly or through another merge; a cycle is refused when the rule is defined rather than when it runs.
- [ ] The result is downloadable and shareable through the same path as any other object, with no special case.
- [ ] Windows line endings in sources do not produce mixed line endings in the output, so the result is usable by tools that care.
- [ ] Tests cover: ordering determinism, a missing source, an empty source, a cycle refused at definition time, a stale derived object, and a failed re-run preserving the previous result.
