# ADR-0003: Derived objects are configured, not scripted

The operator needs several stored files combined into one — in the concrete case, a set of per-host
configuration documents that should become a single document with the duplicate entries removed.

The obvious implementation is to let the operator supply a script and run it. **We decided not to run
supplied code in this Worker.** The isolate holds every stored machine credential and the master key
used to decrypt them, so the blast radius of a sandbox escape is not "a bad output", it is total
access to every collected machine. This project has already had one temporary diagnostic capability
turn into a live unauthenticated file-read exposure, which is the ordinary fate of capabilities that
are added for a good reason and then outlive it.

Instead the transformation is **configuration**: where the inputs come from, the order they are
combined in, how they are combined, and what the output is called. That covers the stated need, and it
buys two things a script cannot: the result can be **previewed** before anything is stored, and the
rule can be **read and checked** by someone who did not write it.

The cost, stated plainly: a transformation the operator can imagine but the operators cannot express
is not possible. If that happens often, the answer is to add a bounded operator with its own tests,
not to open code execution. Reopening this decision means accepting the blast radius above, and should
be done deliberately rather than by adding "just one" escape hatch.
