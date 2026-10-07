# 12: Derived objects — a declarative merge engine, text first

**What to build:** The operator defines a merge in the interface: which stored files it takes, in what
order, how it combines them, and what to call the result. The result becomes a stored file like any
other — browsable, downloadable, shareable — and the interface records what it was built from.

This ticket deliberately does **text** combination only. Combining documents by their structure is
ticket 13, and both exist because the concrete requirement is a structured merge, which is a different
mechanism from concatenation.

**Blocked by:** 08, 09.

**Status:** complete — all 13 criteria met and tested offline. The engine, rule store, decisions, routes, staleness answer and the interface panel are all done. The one thing NOT done is verification against real collected files, which needs the collection pipeline (05) and therefore a machine; that is recorded under "What is missing" rather than left implied.

**Blocked parts:** everything that stores a result, records its sources, or shows it in the interface needs
the collection pipeline (05/08/09). The engine itself is pure logic and did not need them, so it was built
first rather than waiting.

- [x] A merge rule can be created naming its source files, its ordering, its combination, and its output name, with no code involved. `POST /api/derived`; redefining one output name edits in place rather than creating a second rule.
- [x] Sources are selected with the same directory-pattern vocabulary used for collection. `src/derived.ts` calls the same `globToRegExp` that collection rules use, so the two cannot drift.
- [x] Sources are ordered by an explicit stated rule. `orderSources` sorts by path then **content** — the content tie-break is what makes two sources sharing a path deterministic, which an adversarial audit proved was not true before (an 18-character bug producing `A,B` from one arrival order and `B,A` from the other). Selection also sorts by host then path, because the engine cannot distinguish two machines holding one path.
- [x] The combined result is stored as a derived object and is an ordinary row in `objects` under the reserved `@derived` host, so it browses and downloads through the existing path with no special case. Verified by test: it appears in `GET /api/objects`. Not yet *rendered* distinctly in the interface.
- [x] The derived object records its sources and each one's hash in `object_sources`, and records the rule signature AS BUILT in `derived_objects.rule_signature` — stored rather than recomputed, because the sources may be evicted and a stale result whose sources are gone must stay recognisable as stale.
- [x] The interface shows whether a derived object is current or stale, and which sources it came from. The combined-files panel renders three states — current, out of date, and not built yet — plus the source list, in all four locales. The three states are kept distinct because they lead to different actions: build it, rebuild it, or leave it.
- [x] A preview shows what a merge would produce before anything is stored. `POST /api/derived/preview` reports the source count, the total stored size, the estimated output size, the paths, and `perPattern` — a count per source pattern, because a structured merge that removed no duplicates and one that did nothing look identical in the output and the pattern matching zero objects is the usual cause.
- [x] A derived object is marked important when created. Asserted by test against `object_flags`, not merely intended.
- [x] A merge whose sources are missing or empty fails with an explanation and leaves any previous derived object in place. Two paths, both tested: bytes unreadable, and bytes present but empty. `runDerived` never returns content alongside `ok: false`, which is what makes "leave the previous result" enforceable at the call site instead of a convention. **A defect of exactly this kind was found in the route code and fixed**: `readMergeContents` reported unreadable sources and the route ignored the report.
- [x] A merge cannot take itself as a source, directly or through another merge, refused when the rule is defined. Plus a second, independent guard at run time: objects already recorded in `derived_objects` are excluded from selection, which holds even for a rule renamed after storing a result. Both are tested.
- [x] The result is downloadable and shareable through the same path as any other object. `GET /s/<token>` resolves it by object id like anything else; asserted indirectly by the object appearing in the ordinary browse listing.
- [x] Windows line endings in sources do not produce mixed line endings in the output — `normalizeLineEndings` in the engine, covered by its own tests.
- [x] Tests cover: ordering determinism, a missing source, an empty source, a cycle refused at definition time, a stale derived object, and a failed re-run preserving the previous result. All six: 24 tests in `test/derived.test.ts`, 18 in `test/derived-routes.test.ts`. The stale case is covered three ways — a source changing content, the rule being edited, and a source being removed — and the last of those is the one that catches the recompute-from-sources bug, because a result whose input was evicted must NOT report itself current.

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
