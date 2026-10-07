# 11: Browse and search what is stored

**What to build:** The operator can find a stored file without knowing which machine it came from or
how it got there — searching by machine, path, size or time — and can trace any stored file back to
its origin.

**Blocked by:** nothing for the list itself. Only "when it was last seen on its machine" needs the collection pipeline (05/09) to have a value to show.

**Status:** 10 of 11 met and tested offline. The exception is "when it was last seen on its machine", which cannot be shown because **nothing writes `mtime` yet** — collection is not built (05/09). Every other criterion is done, including a real availability check that currently has no producer either, because eviction (07) is also unbuilt.

- [x] Stored files can be listed, newest first, with their machine and path visible. The default sort is `newest`, and every sort carries a unique tie-break on `id` so the order is defined rather than incidental.
- [x] The list can be filtered by machine, chosen from the machines that exist so the filter cannot offer one that does not.
- [x] The list can be filtered by path, matching a partial path. A search term matches the whole path rather than the last segment, so searching for a directory name — the most likely thing anyone types — finds its contents.
- [x] A search that matches nothing says so plainly, and *differently* from an empty store: "nothing matches that" sends the operator to the filter, "nothing collected yet" sends them to the machines. Showing the wrong one sends them to the wrong place.
- [ ] Each entry shows the size and when it was stored. **"When it was last seen on its machine" is not shown, and cannot be: nothing writes `mtime` yet**, because collection is not built (05/09). The column exists and the field is returned; there is simply no value in it. Recorded rather than faked with the stored time, which would answer a different question.
- [x] Each entry shows whether it is important, and whether it can be downloaded. Availability is a real check against the bucket (`?verify=1`), not an inference from the row — see the eviction note below.
- [x] Copying a file's path, and its id (which is what the share panel and merge sources are configured by), is one click. The clipboard API is unavailable on plain HTTP — which a self-hosted deployment may well be — so there is a fallback rather than a control that silently does nothing.
- [x] Results are bounded and paged. 50 per page, "show more" appends rather than re-rendering so the reader's position survives, and the count says "showing 50 of 214" rather than leaving a truncated list looking like the whole answer.
- [x] Search operates on recorded metadata only. The SQL filters on `path`; no object is read from storage to answer a search.
- [x] A file whose record exists but whose bytes are gone is marked "no longer stored", and its share and importance controls are withheld. Three states rather than two — not checked, present, gone — because marking an unverified file as gone would be a lie about a file that is present. **Note: nothing currently evicts.** `planAdmission` computes what should be reclaimed and nothing performs it, so this state can only arise from a partial failure today. The detection is correct and independently useful; the producer is ticket 07.
- [x] Tests cover all five, and paging beyond the first page is tested by walking every page and asserting each row appears exactly once — a paging bug that duplicates or skips a row in the middle looks correct on page one and on the last page.
