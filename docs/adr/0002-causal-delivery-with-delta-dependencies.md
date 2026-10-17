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
- **Idempotence**: an operation whose counters are all below `version[sender]` is a duplicate;
  one already in the buffer is a duplicate too.
- **Buffering**: operations that are not ready wait in a per-sender map and are applied as soon as
  they become ready (including after a state merge, which also drops buffered operations it made
  redundant).
- **Own-ID check**: an operation or state that claims this replica's ID with counters it has not
  produced means the ID is used elsewhere; it is rejected with `replica-conflict`.

## Consequences

- Operations stay small: a keystroke without new dependencies shares one frozen empty `deps`
  object; the trace benchmark measures the encoded size per operation.
- The `pendingCount` buffer is unbounded; an application that never delivers a missing operation
  keeps the dependents buffered. A state merge resolves this.
- Deletions consume a counter, so typing after a deletion elsewhere starts a new run instead of
  extending the previous one. The trace benchmark reports the resulting run count.
- Replica IDs must be unique per live instance. The default random IDs (60 bits) make collisions
  negligible; reusing an ID is only safe when loading a state that contains everything that ID
  produced.
