# 08: Scheduling — unattended runs that resume where they stopped

**What to build:** Collection happens on its own. One run covers one machine's incremental scan under
a wall-clock budget; if it does not finish, the next run continues from where it stopped instead of
starting over; and one machine being unreachable does not stop the others.

Resumability is a premise rather than error handling: the scheduler is weakly delivered and a
scheduled minute may simply be skipped, and 50 machines cannot be scanned within one invocation, so
"did not finish" has to be a normal state that the system can pick up from.

**Blocked by:** 05, 07.

**Status:** ready-for-agent

- [ ] Collection runs on a schedule without any human action, and also on demand from the interface.
- [ ] One run covers one machine's incremental scan, not all machines at once.
- [ ] A run respects a wall-clock budget comfortably below the platform's per-invocation ceiling, and leaves before it is killed.
- [ ] A run that stops early records a cursor naming the machine and the position reached.
- [ ] The next run resumes from that cursor and does not redo work already completed.
- [ ] A run that skipped a scheduled minute simply runs later; no state assumes every scheduled minute happens.
- [ ] A machine that is unreachable is recorded as unreachable and the run moves on to the next machine.
- [ ] Machines are rotated so that one slow machine cannot permanently starve the others.
- [ ] The interface shows when each machine was last collected successfully.
- [ ] The freshness achieved in practice is reported, so the target of a few tens of minutes can be checked rather than assumed.
- [ ] Tests cover: a budget-exhausted run resuming, a skipped trigger, an unreachable machine among reachable ones, and rotation across machines.
