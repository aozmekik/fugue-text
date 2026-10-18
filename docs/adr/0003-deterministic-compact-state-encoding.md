# ADR 0003: A deterministic, dependency-free binary state format, plus JSON for debugging

- Status: accepted
- Date: 2026-10-18

## Context

State-based sync (saving, loading, merging whole documents) needs an encoding that is compact,
fast to decode, safe to decode from untrusted input, and representable without runtime
dependencies. A debugging format that humans can read is also useful.

## Options considered

1. **JSON only.** Readable, but much larger: on the trace benchmark the JSON state is 8.7 times
   the size of the binary state (1,539,776 vs 176,415 bytes; see the README).
2. **A general-purpose binary format (Protocol Buffers, CBOR, MessagePack).** Well specified, but
   each needs a library or a hand-written subset, and none knows about run-length encoding.
3. **A custom format in document order.** Records are maximal slices of runs in document order;
   integers are LEB128 varints, counters are zigzag deltas from the previous record of the same
   replica, replica IDs are interned in a table, and all visible text is one length-prefixed
   string at the end.

## Decision

Option 3 for the binary format (`FugueText.save`), and a JSON rendering of the same records
(`FugueText.toJSON`). Details are documented at the top of `src/encoding/state.ts`. In addition:

- **Deterministic output.** Replicas holding the same state produce byte-identical encodings: the
  replica table is ordered by first appearance (then sorted), and records are canonical because
  in-memory segments and runs are kept maximal (ADR 0001). The convergence property test checks
  this after every scenario.
- **Lossless text.** Strings are WTF-8: plain UTF-8 for well-formed text, but lone UTF-16
  surrogates (which can appear in a JavaScript string, for example after deleting half of an emoji)
  are preserved instead of being replaced with U+FFFD.
- **Strict decoding.** Decoders reject overlong varints, malformed WTF-8, out-of-range indexes,
  duplicate elements, unknown parents, elements beyond the version vector, records that are not in
  the tree's traversal order, and states that have no causal order. Malformed input raises
  `FugueTextError` with code `invalid-state`; fuzz tests check that no other exception escapes.
- **Counter limit.** Counters, lengths and version entries are integers up to 2^52 - 1, in every
  format and in the API. Zigzag-encoded differences of such counters stay below 2^53, the varint
  reader's limit, so every state that loads also saves and loads again. Without the cap, JSON
  could carry counters up to 2^53 - 1, whose binary encoding the reader rejects. Encoding the
  sign separately from the magnitude would also have worked, but 2^52 counters per replica is
  more than any document needs.
- **Operations** use a similar binary layout (`encodeOperation`, which validates its input); their
  JSON form is the operation object itself.

## Consequences

- No runtime dependencies, and a format small enough to read in one sitting.
- The format is versioned (`formatVersion` 1); future changes must keep a decoder for version 1.
- Tombstones are part of the state (without text), so state size grows with the editing history
  until tombstone garbage collection exists.
- Decoding validates the whole structure, which costs time on load; the trace benchmark reports
  load time alongside save time.
