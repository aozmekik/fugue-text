/**
 * The Fugue tree (Weidner & Kleppmann, "The Art of the Fugue", arXiv:2305.00583), stored as a
 * tree of runs.
 *
 * Conceptually every character is a node with a parent and a side (left or right child), and the
 * document is the in-order traversal of the tree: left children (sorted by ID), the node itself,
 * then right children (sorted by ID). Sequential typing produces chains in which every character
 * is the right child of the previous one; a {@link Run} stores such a maximal chain of
 * consecutive counters from one replica as a single object. Element `j + 1` of a run is the
 * "continuation" right child of element `j`; any other children of element `j` are listed in
 * {@link KidSlot}s.
 *
 * Each replica's runs share one {@link ReplicaIndex}: B+trees, keyed by element counter, of the
 * replica's list segments and child slots. Keeping them per replica rather than per run costs
 * one pointer per run, and still gives O(log n) lookups inside a run that has been cut into many
 * pieces.
 */

import { compareIds } from './ids.js';
import type { RopeItem } from './rope.js';
import { SortedIndex } from './sorted-index.js';
import type { Side } from '../types.js';

/** Non-continuation children of one element, on one side, sorted by ID. */
export interface KidSlot {
  /** Counter of the parent element. */
  readonly counter: number;
  /** Child runs (each attached by its first element), sorted by {@link compareIds}. */
  readonly runs: Run[];
}

const slotCounter = (slot: KidSlot): number => slot.counter;
const segmentCounter = (segment: Segment): number => segment.run.counter + segment.offset;

/** Lookup structures for the elements of one replica, shared by all of its runs. */
export class ReplicaIndex {
  /** The replica's list segments, keyed by the counter of their first element. */
  readonly segments = new SortedIndex<Segment>(segmentCounter);
  /** Left children, keyed by the counter of the parent element. */
  readonly leftKids = new SortedIndex<KidSlot>(slotCounter);
  /** Right children other than run continuations, keyed by the parent's counter. */
  readonly rightKids = new SortedIndex<KidSlot>(slotCounter);
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
  /** The creator's segments and child slots (shared by all of the creator's runs). */
  readonly index: ReplicaIndex;

  constructor(
    replica: string,
    counter: number,
    length: number,
    parent: Run | undefined,
    parentOffset: number,
    side: Side,
    index: ReplicaIndex,
  ) {
    this.replica = replica;
    this.counter = counter;
    this.length = length;
    this.parent = parent;
    this.parentOffset = parentOffset;
    this.side = side;
    this.index = index;
  }

  /** Creates the virtual root: one element that is never visible and is not part of the list. */
  static root(): Run {
    return new Run('', 0, 1, undefined, 0, 'right', new ReplicaIndex());
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
  /** Offset of the first element within the run. Never changes. */
  readonly offset: number;
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

/** The child slots of `run`'s replica on `side`. */
function slotsOf(run: Run, side: Side): SortedIndex<KidSlot> {
  return side === 'left' ? run.index.leftKids : run.index.rightKids;
}

/** The `side` children of element `(run, offset)`, or `undefined` if there are none. */
export function kidsAt(run: Run, offset: number, side: Side): Run[] | undefined {
  return slotsOf(run, side).get(run.counter + offset)?.runs;
}

/** The `side` child slots of `run`'s elements, in offset order. */
export function slotsIn(run: Run, side: Side): KidSlot[] {
  const slots = slotsOf(run, side);
  const end = run.counter + run.length;
  const found: KidSlot[] = [];
  for (
    let slot = slots.ceiling(run.counter);
    slot !== undefined && slot.counter < end;
    slot = slots.after(slot.counter)
  ) {
    found.push(slot);
  }
  return found;
}

/**
 * Offset of the first element of `run`, at or after `offset`, that has `side` children, or
 * `Infinity`.
 */
function nextSlotOffset(run: Run, offset: number, side: Side): number {
  const slot = slotsOf(run, side).ceiling(run.counter + offset);
  return slot !== undefined && slot.counter < run.counter + run.length
    ? slot.counter - run.counter
    : Infinity;
}

/**
 * Index of the first of the sorted `runs` whose first element's ID is greater than
 * `(replica, counter)` (or not less than it, when `inclusive`); `runs.length` if there is none.
 */
function firstAbove(
  runs: readonly Run[],
  replica: string,
  counter: number,
  inclusive = false,
): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const run = runs[mid] as Run;
    const order = compareIds(run.replica, run.counter, replica, counter);
    if (order < 0 || (order === 0 && !inclusive)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Attaches `kid` as a `side` child of element `(parent, offset)`, keeping siblings sorted.
 * O(log k) to find the slot, plus O(s) to insert among s existing siblings (s > 1 only with
 * concurrent insertions at the same place).
 */
export function addKid(parent: Run, offset: number, side: Side, kid: Run): void {
  const slots = slotsOf(parent, side);
  const counter = parent.counter + offset;
  const slot = slots.get(counter);
  if (slot === undefined) {
    slots.insert({ counter, runs: [kid] });
    return;
  }
  slot.runs.splice(firstAbove(slot.runs, kid.replica, kid.counter, true), 0, kid);
}

/** Whether element `(run, offset)` has at least one right child. */
export function hasRightChild(run: Run, offset: number): boolean {
  return offset < run.length - 1 || kidsAt(run, offset, 'right') !== undefined;
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
  const kids = kidsAt(run, offset, side);
  if (kids !== undefined) {
    const kid = kids[firstAbove(kids, replica, counter)];
    if (kid !== undefined) best = { run: kid, offset: 0 };
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
    const kids = kidsAt(run, offset, 'left');
    if (kids === undefined) return { run, offset };
    run = kids[0] as Run;
    offset = 0;
  }
}

/**
 * The last element, in document order, of the subtree rooted at `(run, offset)`. Follows the
 * greatest right child repeatedly. Within a run it finds the first child slot at or after the
 * current offset in O(log k), then checks that run's later slots one by one: a slot whose
 * greatest child sorts before the in-run continuation does not end the subtree.
 */
export function rightmost(run: Run, offset: number): Elem {
  outer: for (;;) {
    const slots = run.index.rightKids;
    const last = run.counter + run.length - 1;
    for (
      let slot = slots.ceiling(run.counter + offset);
      slot !== undefined && slot.counter <= last;
      slot = slots.after(slot.counter)
    ) {
      const greatest = slot.runs[slot.runs.length - 1] as Run;
      if (
        slot.counter === last ||
        compareIds(greatest.replica, greatest.counter, run.replica, slot.counter + 1) > 0
      ) {
        run = greatest;
        offset = 0;
        continue outer;
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
  const rootKids = kidsAt(root, 0, 'right');
  if (rootKids !== undefined) pushRuns(rootKids, 0, rootKids.length);

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { run, offset } = frame;
    if (!frame.leftDone) {
      const leftKids = kidsAt(run, offset, 'left');
      if (leftKids !== undefined) {
        stack.push({ run, offset, leftDone: true });
        pushRuns(leftKids, 0, leftKids.length);
        continue;
      }
    }
    const nextLeft = nextSlotOffset(run, offset + 1, 'left');
    const nextRight = nextSlotOffset(run, offset, 'right');
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
    const kids = kidsAt(run, nextRight, 'right') as Run[];
    if (nextRight === run.length - 1) {
      pushRuns(kids, 0, kids.length);
      continue;
    }
    // Kids that sort before the continuation come before it in document order.
    const split = firstAbove(kids, run.replica, run.counter + nextRight + 1, true);
    pushRuns(kids, split, kids.length);
    stack.push({ run, offset: nextRight + 1, leftDone: false });
    pushRuns(kids, 0, split);
  }
}
