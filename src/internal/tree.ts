/**
 * The Fugue tree (Weidner & Kleppmann, "The Art of the Fugue", arXiv:2305.00583), stored as a
 * tree of runs.
 *
 * Conceptually every character is a node with a parent and a side (left or right child), and the
 * document is the in-order traversal of the tree: left children (sorted by ID), the node itself,
 * then right children (sorted by ID). Sequential typing produces chains in which every character
 * is the right child of the previous one; a {@link Run} stores such a maximal chain of
 * consecutive counters from one replica as a single object. Element `j + 1` of a run is the
 * "continuation" right child of element `j`; any other children of element `j` are listed in the
 * run's {@link KidSlot}s.
 */

import { compareIds } from './ids.js';
import type { RopeItem } from './rope.js';
import type { Side } from '../types.js';

/** Children of one element of a run, on one side, sorted by ID. */
export interface KidSlot {
  /** Offset of the parent element within its run. */
  readonly offset: number;
  /** Child runs (each attached by its first element), sorted by {@link compareIds}. */
  readonly runs: Run[];
}

/** A maximal chain of tree nodes created by one replica with consecutive counters. */
export class Run {
  /** Creator of the run. */
  readonly replica: string;
  /** Counter of the run's first element. */
  readonly counter: number;
  /** Number of elements; grows when the creator keeps typing at the end of the run. */
  length: number;
  /**
   * Run containing the parent of the first element; `undefined` only for the root (and, briefly,
   * while a decoded state is being linked). Never changes once linked.
   */
  parent: Run | undefined;
  /** Offset of the parent element within `parent`. */
  parentOffset: number;
  /** Side of the first element relative to its parent. */
  readonly side: Side;
  /** Non-continuation left children, by parent offset. */
  leftKids: KidSlot[] | undefined = undefined;
  /** Non-continuation right children, by parent offset. */
  rightKids: KidSlot[] | undefined = undefined;
  /** The list segments covering this run, sorted by offset (empty for the root). */
  readonly segments: Segment[] = [];

  constructor(
    replica: string,
    counter: number,
    length: number,
    parent: Run | undefined,
    parentOffset: number,
    side: Side,
  ) {
    this.replica = replica;
    this.counter = counter;
    this.length = length;
    this.parent = parent;
    this.parentOffset = parentOffset;
    this.side = side;
  }

  /** Creates the virtual root: one element that is never visible and is not part of the list. */
  static root(): Run {
    return new Run('', 0, 1, undefined, 0, 'right');
  }
}

/**
 * A contiguous slice of one run that is also contiguous in document order, stored in the rope.
 * Either fully visible (`text` holds its characters) or fully deleted (`text` is `undefined`).
 */
export class Segment implements RopeItem {
  leaf: unknown = undefined;
  /** The run this segment belongs to. */
  readonly run: Run;
  /** Offset of the first element within the run. */
  offset: number;
  /** Number of elements. */
  length: number;
  /** The characters, or `undefined` for tombstones. */
  text: string | undefined;

  constructor(run: Run, offset: number, length: number, text: string | undefined) {
    this.run = run;
    this.offset = offset;
    this.length = length;
    this.text = text;
  }
}

/** Rope weight of a segment: its number of visible characters. */
export function segmentWeight(segment: Segment): number {
  return segment.text === undefined ? 0 : segment.length;
}

/** One element of the tree, addressed by run and offset. */
export interface Elem {
  /** The run containing the element. */
  readonly run: Run;
  /** The element's offset within the run. */
  readonly offset: number;
}

/** Elements `start` up to `end - 1` of `run`. */
export interface ElemRange {
  /** The run containing the elements. */
  readonly run: Run;
  /** Offset of the first element. */
  readonly start: number;
  /** Offset just past the last element. */
  readonly end: number;
}

/** Index of the first slot whose offset is `>= offset`. */
function lowerBound(slots: readonly KidSlot[], offset: number): number {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((slots[mid] as KidSlot).offset < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The children of element `offset` on the given slot list, or `undefined` if there are none. */
export function kidsAt(slots: readonly KidSlot[] | undefined, offset: number): Run[] | undefined {
  if (slots === undefined) return undefined;
  const slot = slots[lowerBound(slots, offset)];
  return slot?.offset === offset ? slot.runs : undefined;
}

/** Attaches `kid` as a `side` child of element `(parent, offset)`, keeping siblings sorted. */
export function addKid(parent: Run, offset: number, side: Side, kid: Run): void {
  let slots = side === 'left' ? parent.leftKids : parent.rightKids;
  if (slots === undefined) {
    slots = [];
    if (side === 'left') parent.leftKids = slots;
    else parent.rightKids = slots;
  }
  const index = lowerBound(slots, offset);
  const slot = slots[index];
  if (slot?.offset !== offset) {
    slots.splice(index, 0, { offset, runs: [kid] });
    return;
  }
  const runs = slot.runs;
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = runs[mid] as Run;
    if (compareIds(other.replica, other.counter, kid.replica, kid.counter) < 0) lo = mid + 1;
    else hi = mid;
  }
  runs.splice(lo, 0, kid);
}

/** Whether element `(run, offset)` has at least one right child. */
export function hasRightChild(run: Run, offset: number): boolean {
  return offset < run.length - 1 || kidsAt(run.rightKids, offset) !== undefined;
}

/**
 * The smallest `side` child of `(run, offset)` whose ID is greater than `(replica, counter)`,
 * taking the in-run continuation into account; `undefined` if there is none.
 */
export function successorSibling(
  run: Run,
  offset: number,
  side: Side,
  replica: string,
  counter: number,
): Elem | undefined {
  let best: Elem | undefined;
  const kids = kidsAt(side === 'left' ? run.leftKids : run.rightKids, offset);
  if (kids !== undefined) {
    // Few siblings in practice; a linear scan over a sorted array is fine.
    for (const kid of kids) {
      if (compareIds(kid.replica, kid.counter, replica, counter) > 0) {
        best = { run: kid, offset: 0 };
        break;
      }
    }
  }
  if (side === 'right' && offset < run.length - 1) {
    const next = run.counter + offset + 1;
    if (
      compareIds(run.replica, next, replica, counter) > 0 &&
      (best === undefined || compareIds(run.replica, next, best.run.replica, best.run.counter) < 0)
    ) {
      best = { run, offset: offset + 1 };
    }
  }
  return best;
}

/** The first element, in document order, of the subtree rooted at `(run, offset)`. */
export function leftmost(run: Run, offset: number): Elem {
  for (;;) {
    const kids = kidsAt(run.leftKids, offset);
    if (kids === undefined) return { run, offset };
    run = kids[0] as Run;
    offset = 0;
  }
}

/**
 * The last element, in document order, of the subtree rooted at `(run, offset)`. Follows the
 * greatest right child repeatedly, skipping along a run in O(log k) per jump.
 */
export function rightmost(run: Run, offset: number): Elem {
  outer: for (;;) {
    const slots = run.rightKids;
    if (slots !== undefined) {
      const last = run.length - 1;
      for (let i = lowerBound(slots, offset); i < slots.length; i++) {
        const slot = slots[i] as KidSlot;
        const greatest = slot.runs[slot.runs.length - 1] as Run;
        if (
          slot.offset === last ||
          compareIds(
            greatest.replica,
            greatest.counter,
            run.replica,
            run.counter + slot.offset + 1,
          ) > 0
        ) {
          run = greatest;
          offset = 0;
          continue outer;
        }
      }
    }
    return { run, offset: run.length - 1 };
  }
}

interface Frame {
  readonly run: Run;
  readonly offset: number;
  /** Whether the left children of `(run, offset)` were already traversed. */
  readonly leftDone: boolean;
}

/**
 * In-order traversal of the whole tree: yields element ranges of runs in document order
 * (tombstones included, the root excluded). Iterative, so arbitrarily deep trees cannot overflow
 * the call stack.
 */
export function* traverse(root: Run): Generator<ElemRange> {
  const stack: Frame[] = [];
  const pushRuns = (runs: readonly Run[], from: number, to: number): void => {
    for (let i = to - 1; i >= from; i--)
      stack.push({ run: runs[i] as Run, offset: 0, leftDone: false });
  };
  const rootKids = kidsAt(root.rightKids, 0);
  if (rootKids !== undefined) pushRuns(rootKids, 0, rootKids.length);

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { run, offset } = frame;
    if (!frame.leftDone) {
      const leftKids = kidsAt(run.leftKids, offset);
      if (leftKids !== undefined) {
        stack.push({ run, offset, leftDone: true });
        pushRuns(leftKids, 0, leftKids.length);
        continue;
      }
    }
    const nextLeft = nextSlotOffset(run.leftKids, offset + 1);
    const nextRight = nextSlotOffset(run.rightKids, offset);
    if (nextLeft <= nextRight) {
      if (nextLeft === Infinity) {
        yield { run, start: offset, end: run.length };
      } else {
        // Element `nextLeft` has left children: they come right after element `nextLeft - 1`.
        yield { run, start: offset, end: nextLeft };
        stack.push({ run, offset: nextLeft, leftDone: false });
      }
      continue;
    }
    // Element `nextRight` has extra right children, ordered around the continuation.
    yield { run, start: offset, end: nextRight + 1 };
    const kids = kidsAt(run.rightKids, nextRight) as Run[];
    if (nextRight === run.length - 1) {
      pushRuns(kids, 0, kids.length);
      continue;
    }
    const continuation = run.counter + nextRight + 1;
    let split = 0;
    while (
      split < kids.length &&
      compareIds(
        (kids[split] as Run).replica,
        (kids[split] as Run).counter,
        run.replica,
        continuation,
      ) < 0
    ) {
      split++;
    }
    pushRuns(kids, split, kids.length);
    stack.push({ run, offset: nextRight + 1, leftDone: false });
    pushRuns(kids, 0, split);
  }
}

/** Offset of the first slot at or after `offset`, or `Infinity`. */
function nextSlotOffset(slots: readonly KidSlot[] | undefined, offset: number): number {
  if (slots === undefined) return Infinity;
  return slots[lowerBound(slots, offset)]?.offset ?? Infinity;
}
