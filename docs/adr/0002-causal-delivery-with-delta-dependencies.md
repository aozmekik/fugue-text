# ADR 0002: Causal delivery with one counter space and per-operation delta dependencies

- Status: accepted
- Date: 2026-10-18

## Context

The paper assumes causal broadcast: every replica applies an operation only after all operations
that happened before it. Real transports (a relay, BroadcastChannel, peer-to-peer gossip) may
reorder, delay or duplicate messages, and replicas also exchange whole states. The library must
make operation-based sync safe on its own:

- an insertion must not be applied before its parent exists;
- a deletion must not be applied before its targets exist;
- redelivery must be harmless;
- ideally the visible history respects causality (no replica sees an effect before its cause).

## Options considered

1. **Dependency-only delivery.** Apply an operation as soon as the elements it references exist.
   Enough for convergence, but not causal: a replica can see B's edit before the A edit that B had
   seen when typing it.
2. **Full vector clock on every operation.** Simple and causal, but every keystroke carries one
   entry per replica that ever edited the document, which grows without bound in long-lived
   documents with many sessions.
3. **One counter space per replica plus delta dependencies.** Insertions consume one counter per
   character and deletions consume one counter each, so a replica's operations form a gap-free
   sequence and the version vector "next expected counter per replica" describes exactly what a
   replica has applied. Each operation lists only the version-vector entries that changed since
   its sender's previous operation.

## Decision

Option 3.

- **FIFO per sender** falls out of the counters: an operation is ready only when
  `version[sender] === op.counter`.
- **Causality**: an operation is also ready only when `version[r] >= deps[r]` for each listed `r`.
  Unlisted entries are implied: the sender's previous operation was applied first (FIFO), and by
  induction the receiver already covers that operation's full dependencies. A replica loaded from a
  state starts by declaring its full version vector.
- **Idempotence**: an operation whose counters are all below `version[sender]` is a duplicate, and
  so is a second copy of a buffered operation. A _different_ operation with the ID of a buffered
  one is rejected rather than treated as a duplicate.
- **Buffering with wake lists**: an operation that is not ready waits in a min-heap for the first
  condition it lacks, `version[r] >= v`. When a replica's version grows, only the operations
  waiting for that replica are checked again, and each is either applied or filed under its next
  missing condition. Draining therefore costs O(P · d log P) for P buffered operations with d
  dependencies each. An earlier version rescanned every per-sender queue on every pass, which is
  quadratic. In a one-off measurement on an Apple M1 Pro (load average 23 to 29), a chain of
  16,000 operations from different replicas, each depending on the previous one and delivered in
  reverse, took 20.8 s to drain with the rescans and 118 ms with wake lists. The test suite
  drains a 3,000-operation chain. A merge re-files all buffered operations, drops those it made
  redundant, and applies those it unblocked.
- **Errors**: `apply` and `merge` throw only for their own argument, and then leave the document
  unchanged. A buffered operation that turns out to be invalid once its dependencies arrive (for
  example, its parent does not exist, or it overlaps applied operations) is dropped. It is passed
  to the `onReject` option, and draining continues. Throwing at that point would blame the
  caller's valid operation, which has already been applied, and would leave other ready
  operations stuck.
- **Own-ID checks**: an operation or state that claims this replica's ID with counters it has not
  produced means the ID is used elsewhere, and is rejected with `replica-conflict`. So is an
  operation whose `deps` claim that this replica is further ahead than it is.

## Consequences

- Operations stay small: a keystroke without new dependencies shares one frozen empty `deps`
  object; the trace benchmark measures the encoded size per operation.
- The buffer is unbounded. An application that never delivers a missing operation keeps the
  dependents buffered (`pendingCount`), and so does one whose missing operation was rejected,
  until a valid operation with that ID or a state that covers it arrives. A state merge resolves
  both.
- Deletions consume a counter, so typing after a deletion elsewhere starts a new run instead of
  extending the previous one. The trace benchmark reports the resulting run count.
- Replica IDs must be unique per live instance. The default random IDs (60 bits) make collisions
  negligible; reusing an ID is only safe when loading a state that contains everything that ID
  produced. Collisions between two _other_ replicas are only detected when their operations
  conflict with buffered ones; operations already applied are not compared.
