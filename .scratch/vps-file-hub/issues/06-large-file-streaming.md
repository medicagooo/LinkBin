# 06: Large files — stream to storage within the invocation's budget

**What to build:** A file at the per-file limit is collected without exhausting memory and without
overshooting the time a single invocation is allowed, using the faster path measured in 04. If 04
showed that no single invocation can carry a file that size, this ticket implements the fallback
instead: the file is collected across several invocations with its progress recorded so the next one
continues.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] A file at the per-file limit is stored intact, and its content hash matches a hash computed independently on the machine.
- [ ] Peak memory stays well inside the isolate limit: the file is never held whole in memory, on either the read or the write side.
- [ ] Reading uses whichever path 04 measured as viable, with the serial path retained as a fallback rather than deleted.
- [ ] A file above the per-file limit is recorded as skipped, with its size, and **its bytes are never requested** — a file that cannot be stored must not be transferred.
- [ ] Uploads above the chunking threshold are sent in parts, with the part state recorded outside the Worker, because no invocation can hold it.
- [ ] All parts except the last are the same size, as storage requires.
- [ ] An abandoned upload is cleaned up rather than left consuming the budget indefinitely.
- [ ] A transfer that exceeds the run's remaining time is stopped at a recorded point rather than being killed mid-write.
- [ ] If the invocation budget is exceeded, the file is left in a state the next run can resume, not in a state that looks complete.
- [ ] Tests cover: a file exactly at the limit, one byte over it, a multi-part upload, a resumed upload, and an interrupted transfer.
