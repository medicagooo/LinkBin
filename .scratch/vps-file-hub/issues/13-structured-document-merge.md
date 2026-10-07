# 13: Structured merge — combine documents by their shape, not by concatenation

**What to build:** Merging several configuration documents produces **one valid document** whose
list-valued sections are the union of the sources with duplicates removed, instead of a stack of
whole documents glued end to end. This is the case the operator actually has: several per-host
configuration files that should become one.

Concatenation is not good enough here. Stacking whole documents produces something that is either
invalid or silently last-one-wins, and repeating the same entry once per source is the specific
thing the operator wants removed.

**Blocked by:** 12.

**Status:** 10 of 10 met and tested offline. The engine, the rule store, the routes and the preview all handle structured merges; only the literal "issue" delivery for an unparseable source is unavailable, because issues belong to a collection run.

- [x] Several documents are parsed and their list-valued sections combined into one, not appended as repeated blocks. Asserted both ways: a test that the union keeps every entry, and a test that the output is NOT the documents stacked.
- [x] Entries that are equivalent across sources appear once, with the comparison structural rather than textual — entries differing only in key order, quoting or indentation collapse to one, and entries differing in any field are both kept.
- [x] The output is a single valid document that re-parses cleanly, verified by PARSING it rather than by inspecting it — the test is named for that distinction, because reading YAML to check YAML is how a subtly broken document passes review.
- [x] The parser is the `yaml` package: pure JavaScript, no native code and no runtime WebAssembly. That constraint is not theoretical here — it is what ruled out the first SSH library this project tried.
- [x] A source that cannot be parsed is refused, the file is NAMED, and the previous derived object is left in place. The naming is asserted for both an unparseable document and a valid document of the wrong shape. **One wording difference, recorded rather than glossed:** the criterion says "reported as an issue", and issues are `collection_issues` rows, which require a `run_id` and so cannot exist until the collection pipeline does. The report is returned to the caller instead, and the property that matters — the operator can tell WHICH file, and a good previous result survives — holds.
- [x] Duplicate keys that cannot be merged as a list are resolved by source order — a stated rule — and the conflict is REPORTED, naming the key and which source won. Absence is deliberately not treated as disagreement: a key only some sources set is contributed by the ones that have it, which was a real defect found against the operator's own files.
- [x] Ordering within a merged section is deterministic across runs, asserted three ways: byte-identical output across two runs, byte-identical output when the sources arrive in a different order, and entries not ordered by which source was read first.
- [x] The preview reports the counts needed to tell a working rule from an inert one: how many entries came from each source and how many duplicates were removed. A structured merge that removed nothing and one that did nothing look identical in the output, so the counts are the only way to distinguish them.
- [x] The derived-object protections apply to a structured result unchanged: it is marked important, records its sources and their hashes in `object_sources`, and cannot participate in a cycle — checked when the rule is defined and again at run time by excluding objects already recorded as derived.
- [x] Tests cover all five: disjoint sources, overlapping sources with duplicates, one unparseable source, output that re-parses (checked by parsing), and determinism across two runs.
