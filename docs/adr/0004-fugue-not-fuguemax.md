# ADR 0004: Implement Fugue, not FugueMax, in v0.1

- Status: accepted
- Date: 2026-10-18

## Context

The paper presents two algorithms with the same tree structure:

- **Fugue** sorts same-side siblings by ID. It is forward non-interleaving, and it also avoids
  backward interleaving in common cases such as two users typing backwards at the same position
  (both are property-tested in `test/paper.test.ts`).
- **FugueMax** additionally records each right child's _right origin_ and sorts right siblings by
  the reverse document order of their right origins (ties by ID). The paper proves that FugueMax
  satisfies its stronger definition of _maximal_ non-interleaving.

The two differ only when two elements share a left origin but have different right origins, the
situation of the paper's Figure 7, where Fugue's order depends on replica IDs.

## Options considered

1. **Ship both**, selectable per document.
2. **Ship FugueMax only.**
3. **Ship Fugue only**, document the difference, keep FugueMax on the roadmap.

## Decision

Option 3. Fugue's semantics are simpler to implement efficiently with runs (ADR 0001): sibling
order depends only on IDs, so a run's continuation is just another right child with a known ID.
FugueMax needs the right origin of every run start in the operation format and in the encoded
state, a sibling order that depends on the document order of other elements, and its own
reference implementation for differential testing. Doing that well is more than v0.1 can carry
without cutting corners.

## Consequences

- `test/paper.test.ts` pins the Figure 7 behaviour: with replica IDs ordered so that Y's ID is
  smaller than X's, Fugue produces `AYXBC`, where FugueMax would produce `AXYBC`.
- Adding FugueMax later changes the operation and state formats (a right origin per run start),
  so it would ship as a new format version and a per-document algorithm choice.
