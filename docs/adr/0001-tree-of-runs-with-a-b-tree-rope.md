# ADR 0001: Store the Fugue tree as runs and the document order in a B-tree rope

- Status: accepted
- Date: 2026-10-18

## Context

Fugue (Weidner & Kleppmann, arXiv:2305.00583) defines the document as the in-order traversal of
a tree in which every character is a node: left children (sorted by ID), the node, then right
children (sorted by ID). A text editor needs two queries to be fast on long documents:

1. **Index to ID**: a local edit at visible index `i` must find the character at `i - 1` (its
   left origin) and whether it has right children.
2. **ID to index**: a remote insertion names its parent by ID, and must be placed relative to the
   subtrees of its siblings; change events and anchors then need the visible index.

Sequential typing produces long chains (each character is the right child of the previous one),
so a naive one-node-per-character tree is deep and large.

## Options considered

1. **One object per character, order statistics in the tree itself.** Each node keeps the visible
   size of its subtree; index lookups walk from the root. Simple and close to the paper, but the
   tree's depth grows with every chain of typing, so lookups are O(depth), not O(log n), and memory
   is one object per character.
2. **A flat list with left/right origins and a YATA-style scan (as in Yjs).** Integration scans
   the list between a new element's origins. Fast in practice, but the scan rules would have to be
   proven equivalent to Fugue's tree order, and a list without an index needs extra position caches
   for index lookups on long documents.
3. **Two structures: a tree of runs for the semantics, plus a balanced sequence for the order.**
   A _run_ stores a maximal chain of consecutive counters from one replica (each character the
   right child of the previous) as one object, with the other children of its characters in
   per-offset slots. The document order lives separately in a B-tree ("rope") of _segments_,
   contiguous slices of runs, weighted by their number of visible characters; every segment has a
   back-pointer to its leaf.

## Decision

Option 3.

- Local insert: find the left origin with an O(log n) descent of the rope; decide left/right child
  exactly as in the paper (the right origin is simply the next rope element); insert the new
  segment right after the left origin. Typing at the end of one's own latest run extends the run
  and its segment in place (run-length encoding).
- Remote insert: the new run goes right before the subtree of its next-greater sibling, or after
  the end of its parent's subtree (`rightmost`), or right before its parent (left children).
  `leftmost`/`rightmost` jump from run to run, and skip along a run with a binary search over the
  run's child slots.
- ID to index: find the run by binary search in a per-replica array, the segment by binary search
  in the run, then sum weights up the B-tree via back-pointers.

## Consequences

- Local edits, ID lookups and index lookups are O(log n). The scaling benchmark measures the cost
  per edit staying in the low microseconds from 1,000 to 1,000,000 characters (see the README).
- Placing a _concurrent_ remote insertion may walk `leftmost`/`rightmost` paths, which costs O(d)
  where d is the number of runs on that path. For non-concurrent insertions (the common case)
  these walks stop immediately, because the parent has no other children on that side. Very deep
  trees (for example 20,000 prepended characters) are handled iteratively and are covered by a
  test.
- Two structures must stay consistent. `FugueList.checkInvariants` verifies, among other things,
  that the rope order equals an in-order traversal of the tree, that segments are maximal and that
  runs are maximal chains; the property tests call it after every step.
- Segments are canonical (maximal), which makes the encoded state deterministic (ADR 0003).
- Tombstones are kept forever (no garbage collection yet); deleted segments drop their text but
  keep their length.
