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
  `leftmost`/`rightmost` jump from run to run. Within a run, `rightmost` finds the first child
  slot at or after the current offset with a B+tree query, then checks that run's later slots one
  by one.
- ID to index: find the run by binary search in a per-replica array of runs, find the segment
  with a floor query in the replica's segment index (below), then sum weights up the B-tree via
  back-pointers.

### Locating segments and child slots

Edits cut runs into segments, and children hang off arbitrary elements of a run, so the list
also needs "which segment holds element c?" and "which children does element c have?". Three
layouts were tried during development:

1. **Sorted arrays per run.** Fast for the usual one to three segments per run, but splitting a
   segment and attaching a child call `Array.prototype.splice`, which is O(k) in the number of
   pieces. After a single 1,000,000-character paste, 80,000 random one-character edits raised the
   cost per edit from 6.5 µs (first 10,000 edits) to 292 µs (last 10,000).
2. **A B+tree per run.** O(log k) per operation, and as fast as the arrays on the trace, but every
   run then carries several index objects: 8.5 MB retained after replaying the automerge-paper
   trace, against 4.9 MB for the arrays.
3. **One set of B+trees per replica.** `SortedIndex` (in `src/internal/sorted-index.ts`) is a
   B+tree keyed by integers. Each replica has three: its segments keyed by element counter, and its
   left and right child slots keyed by the parent's counter. Every run points to its replica's
   indexes.

Layout 3 was chosen: 3.5 MB retained on the trace, O(log n) splits, merges and child insertions,
and a cost per edit that stays flat inside long runs. The price is speed: replaying the trace
takes about 20 to 30% longer than with the per-run arrays, because each lookup searches a larger
tree. The leaves store keys next to items, avoid `splice`, and queries start from the leaf that
answered the previous one, which keeps that overhead down. These comparisons come from interleaved
runs of a scratch script (not kept in the repository) on an Apple M1 Pro under a load average of
11 to 17, with each layout replaying the trace about 60 times. Treat them as approximate. The
drift run of `npm run bench:scaling` shows the flat cost per edit of the chosen layout (see the
README).

## Consequences

- Local edits, ID lookups and index lookups take O(log n) time (the B-tree fan-outs are
  constants), including edits inside a run that has been cut into many segments.
- Two cases cost more:
  - Placing a _concurrent_ remote insertion may walk `leftmost`/`rightmost` paths. That costs
    O(d) in the number d of runs on the path, plus the slot scan described above. For
    non-concurrent insertions (the common case) these walks stop immediately, because the
    parent has no other children on that side. Very deep trees (for example 20,000 prepended
    characters) are handled iteratively and are covered by a test.
  - Inserting a child among s siblings that share a parent and a side splices a sorted array,
    which costs O(s). Honest replicas only create s > 1 through concurrent insertions at one
    place, but a malicious peer can send thousands of siblings. Applications that accept
    operations or states from untrusted peers should bound message sizes and rates.
- Two structures must stay consistent. `FugueList.checkInvariants` verifies, among other things,
  that the rope order equals an in-order traversal of the tree, that segments are maximal, that
  runs are maximal chains and that every index is a well-formed B+tree that agrees with the runs.
  The property tests call it after every step.
- Segments are canonical (maximal), which makes the encoded state deterministic (ADR 0003).
- Tombstones are kept forever (no garbage collection yet); deleted segments drop their text but
  keep their length.
