# 13: Structured merge — combine documents by their shape, not by concatenation

**What to build:** Merging several configuration documents produces **one valid document** whose
list-valued sections are the union of the sources with duplicates removed, instead of a stack of
whole documents glued end to end. This is the case the operator actually has: several per-host
configuration files that should become one.

Concatenation is not good enough here. Stacking whole documents produces something that is either
invalid or silently last-one-wins, and repeating the same entry once per source is the specific
thing the operator wants removed.

**Blocked by:** 12.

**Status:** ready-for-agent

- [ ] Several documents are parsed and their list-valued sections are combined into one section, not appended as repeated blocks.
- [ ] Entries that are equivalent across sources appear **once** in the output, with the comparison being structural rather than a text match on formatting.
- [ ] The output is a single valid document that re-parses cleanly, verified by parsing the output rather than by inspecting it.
- [ ] The parser used is pure JavaScript with no native code and no runtime WebAssembly, because this runtime cannot compile WebAssembly at runtime — the constraint that ruled out the first SSH library this project tried.
- [ ] A source that cannot be parsed is reported as an issue naming the file, and **the previous derived object is left in place** rather than replaced with a partial result.
- [ ] Duplicate keys that cannot be merged as a list are handled by a stated rule rather than by whichever source happened to be read last.
- [ ] Ordering within a merged section is deterministic across runs.
- [ ] The preview for a structured merge reports how many entries came from each source and how many duplicates were removed, so the operator can tell a working rule from one that silently did nothing.
- [ ] The existing derived-object protections still apply: the result is important, records its sources and their hashes, and cannot participate in a cycle.
- [ ] Tests cover: disjoint sources, overlapping sources with duplicates, one unparseable source, a merged output that re-parses, and determinism across two runs.
