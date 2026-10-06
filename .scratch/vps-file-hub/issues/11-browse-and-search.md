# 11: Browse and search what is stored

**What to build:** The operator can find a stored file without knowing which machine it came from or
how it got there — searching by machine, path, size or time — and can trace any stored file back to
its origin.

**Blocked by:** 09.

**Status:** ready-for-agent

- [ ] Stored files can be listed, newest first, with their machine and path visible.
- [ ] The list can be filtered by machine.
- [ ] The list can be filtered by path, matching a partial path rather than requiring an exact one.
- [ ] A search that matches nothing says so plainly rather than appearing broken or empty by accident.
- [ ] Each entry shows the file's size, when it was stored, and when it was last seen on its machine.
- [ ] Each entry shows whether it is marked important and whether it can currently be downloaded.
- [ ] Copying a file's path or its download link from the list is possible without retyping either.
- [ ] Results are bounded and paged rather than rendering an unbounded list, so that a large store does not produce an unusable page.
- [ ] Search operates on recorded metadata only; file contents are not searched.
- [ ] A file whose record exists but whose stored bytes were evicted is shown as no longer available rather than as downloadable.
- [ ] Tests cover: filtering by machine, partial path matching, no matches, an evicted file, and paging beyond the first page.
