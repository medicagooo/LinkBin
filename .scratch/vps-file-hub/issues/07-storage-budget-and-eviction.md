# 07: The 10 GB budget — measure it, refuse when full, evict what is not protected

**What to build:** The operator can see how full the store is, collection refuses a file that will not
fit instead of transferring it and throwing it away, and when the store fills up the oldest
unprotected files are evicted to make room — while files marked important are never touched, and if
only important files remain the system stops accepting new ones and says so.

Failing closed is the deliberate choice here: silently deleting a file the operator protected is the
worst outcome this system can produce, worse than refusing new files.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] The interface shows bytes held and the share of the budget used.
- [ ] The figure counts **everything the bucket holds**, including superseded and soft-deleted objects, because that is what is charged — a figure that counted only live objects could exceed the ceiling while looking healthy.
- [ ] A file that would exceed the budget is refused **before** its bytes are requested, not after.
- [ ] Each refusal is recorded as an issue naming capacity as the reason, so "why did this stop syncing" has an answer.
- [ ] When room is needed, the oldest unprotected objects are evicted, and eviction reclaims both the record and the stored bytes.
- [ ] An object marked important is never evicted, under any condition.
- [ ] When only important objects remain and the budget is full, collection stops accepting new files and the interface says the store is refusing new files rather than silently doing nothing.
- [ ] An object can be marked important and unmarked from the interface.
- [ ] Marking a file important is reflected immediately in what would and would not be evicted.
- [ ] The budget and the per-file limit are both stated in the interface rather than only enforced invisibly.
- [ ] Tests cover: exactly at the ceiling, one byte over, eviction order, an important object surviving eviction, and the only-important-remains case refusing rather than deleting.
