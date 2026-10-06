# 04: Measure large-file throughput and settle the per-file limit

**What to build:** A real number for how fast a 100 MB file can actually leave a machine, so that the
collection path is built on a measurement instead of an assumption — and a decision about the
per-file limit that follows from it.

This exists because the arithmetic is uncomfortable and unverified. The proven read path moves data in
fixed 32 KiB pieces, strictly one at a time, so 100 MB is roughly 3,200 serial round trips against a
15-minute ceiling per invocation. A windowed session channel should move far more per round trip, but
"should" is not a measurement. If the windowed path does not clearly win, either the per-file limit
comes down or large files must span several invocations — and both of those change later tickets.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] A 100 MB file is read from a real machine over each candidate path, with wall-clock time, CPU time and peak memory recorded for both.
- [ ] The measurement is taken on the deployed Worker, not locally, because local development cannot reach a remote machine.
- [ ] Both candidate paths are measured: the proven serial read, and the windowed session-channel read.
- [ ] The result identifies whether either path fits a single invocation with margin, and states the margin.
- [ ] A decision is recorded for the per-file limit, and if it changes from 100 MB the affected later tickets are updated rather than left inconsistent.
- [ ] If neither path fits, the fallback is stated: large files collected across several invocations with their progress recorded outside the Worker.
- [ ] **The measurement endpoint is authenticated**, because it reads a file from a machine using a stored credential.
- [ ] **The measurement endpoint is deleted before this ticket is done.** A diagnostic that acts on a stored credential must not outlive the question it answered; the previous one did, and became a live exposure.
- [ ] The measured numbers are written into the state record and the spec's notes, replacing the current "not yet measured" caveat.
- [ ] No production code path is added for this; if any is introduced for the measurement, it is removed here.

