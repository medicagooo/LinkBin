# 12: Derived objects — a declarative merge engine, text first

**What to build:** The operator defines a merge in the interface: which stored files it takes, in what
order, how it combines them, and what to call the result. The result becomes a stored file like any
other — browsable, downloadable, shareable — and the interface records what it was built from.

This ticket deliberately does **text** combination only. Combining documents by their structure is
ticket 13, and both exist because the concrete requirement is a structured merge, which is a different
mechanism from concatenation.

**Blocked by:** 08, 09.

**Status:** part-delivered — see the "What is built" and "What is missing" sections at the end.

**Blocked parts:** everything that stores a result, records its sources, or shows it in the interface needs
the collection pipeline (05/08/09). The engine itself is pure logic and did not need them, so it was built
first rather than waiting.

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

---

## What is built (pure engine, `src/merge.ts`, 45 tests)

Built ahead of its blockers on purpose: the engine is pure logic — no database, no bucket, no machine —
so none of it needed the collection pipeline. What was NOT built is everything that stores a result or
shows it, which genuinely does need 05/08/09.

Established and tested:

- **Content is combination, not code.** `concat` joins sources; `yaml-list-union` parses each source and
  unions its list-valued keys. No supplied code runs anywhere (ADR-0003).
- **Ordering is deterministic.** Sources sort by path unless a stated order is given, an explicit order
  never *drops* an unmentioned source, and the output is byte-identical when the sources are supplied in
  reverse — verified both by test and against the operator's eight real files.
- **Line endings are normalised** to LF before combining, so a Windows-authored source cannot make the
  output mixed.
- **A failed merge produces nothing to store.** No sources, all sources empty, a named source that
  produced nothing, an unparseable source, or output that does not re-parse — each refuses and says why,
  so a previous good result is left in place rather than replaced by an empty or partial one. This is the
  failure mode that matters most, because it is silent.
- **Duplicates are compared structurally, not textually.** Two entries differing only in key order,
  quoting or indentation collapse to one. Entries differing in any field are both kept.
- **A key only some sources set is contributed by the ones that have it.** Losing it because the first
  source did not mention it was a real defect, fixed; absence is not disagreement. A genuine
  disagreement between values is resolved by source order and *reported*.
- **Cycles are refused at definition time**, through any chain length, with the cycle path named.
- **Verification beyond the test suite:** the engine was run against the operator's eight real
  configuration files (read-only, nothing uploaded). 8 sources, 32,742 bytes in, 96 raw entries across
  keys, 68 unique out, output re-parses, byte-identical with the source order reversed. Four deliberate
  mutations of the engine were each caught by the suite, so the tests are not vacuous.

## What is missing, and one question that needs a decision

Not yet built, all needing 05/08/09: storing the derived object, recording its sources and their hashes,
marking it important, the current/stale display, and re-running automatically when a source changes.

**A measured capability gap that needs the operator's judgement.** Running against the real files showed
the engine keeping all 24 `proxy-groups` entries (nothing lost — all 24 differ in content), where the
operator's hand-merged file has 27. The reason is not duplication: every source names its groups
generically (`负载均衡`, `自动选择`, `🌍选择代理节点`), and the operator's manual merge **renamed each
group per source** (`⚖️ByteVirt 负载均衡`, `⚡DartNode 自动选择`, …), which is what produces distinct,
usable groups.

A declarative configuration cannot presently express "name this entry after the source it came from".
Three ways forward, and this is a product decision rather than a technical one:

1. **Add a bounded operator** that tags entries with their source — for example a `nameFromSource` list of
   fields to rewrite, producing `⚖️ByteVirt 负载均衡` from `负载均衡` in `bytevirt.yaml`. Fits the existing
   shape (a named operation with its own tests) and would reproduce the hand-merged file's structure.
2. **Deduplicate by a stated identity**, so entries sharing a name collapse with a reported conflict
   instead of all being kept. Fewer groups, but it discards content the operator wanted.
3. **Leave as is** and require the sources to be authored with distinct group names.

Option 1 is the only one that reproduces what the operator already does by hand, and it stays within
ADR-0003's boundary. It should not be built on a guess.
