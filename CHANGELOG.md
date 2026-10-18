# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, minor versions may
contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-10-18

### Added

- `FugueText`: a replica of a plain-text document implementing the Fugue list CRDT
  (Weidner & Kleppmann, arXiv:2305.00583), with `insert`, `delete`, `toString` and `length`
  in UTF-16 code units.
- Run-length encoding of sequential typing, a B-tree rope for O(log n) mapping between visible
  indexes and element IDs, and per-replica B+tree indexes so that edits inside long runs stay
  O(log n).
- Operation-based sync: `apply` with causal delivery, a delivery buffer with wake lists for early
  operations, and idempotent redelivery. `apply` and `merge` throw only for their own argument;
  buffered operations that turn out to be invalid are dropped and passed to the `onReject` option.
- State-based sync: `save`, `FugueText.load`, `merge` and `mergeStates`.
- Deterministic binary state encoding (varints, run-length records, WTF-8 text), JSON state
  encoding (`toJSON`), and binary operation encoding (`encodeOperation`, `decodeOperation`).
  Counters are limited to 2^52 - 1 so that every encoded state round-trips.
- Anchors (`createAnchor`, `resolveAnchor`) that survive concurrent edits.
- Change events for local and remote edits (`subscribe`), delivered in the order the changes
  happened even when a listener edits the document.
- Examples: a two-tab collaborative textarea over BroadcastChannel, and a Node WebSocket relay
  whose clients recover from disconnections and relay restarts by exchanging states.
- Benchmarks on the automerge-paper editing trace and on synthetic workloads (typing bursts, one
  large paste, and drift over many edits), with Yjs for context.

[Unreleased]: https://github.com/aozmekik/fugue-text/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aozmekik/fugue-text/releases/tag/v0.1.0
