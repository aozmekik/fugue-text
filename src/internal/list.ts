/**
 * The replicated list itself: the Fugue tree of runs plus a rope of segments that holds the tree's
 * in-order traversal, so visible indexes and element IDs can be mapped to each other in
 * O(log n). This layer knows nothing about replicas' versions, causality or encodings; see
 * `Text` for those.
 */

import { invalidState } from '../errors.js';
import type { ElementId, ElementIdRange, Side, TextChange } from '../types.js';
import { compareIds } from './ids.js';
import { Rope, type RopeOptions, type RopePosition } from './rope.js';
import {
  addKid,
  type Elem,
  hasRightChild,
  kidsAt,
  leftmost,
  rightmost,
  Run,
  Segment,
  segmentWeight,
  successorSibling,
  traverse,
} from './tree.js';

/** A slice of run content to integrate: `length` elements, visible iff `text` is defined. */
export interface Piece {
  /** Number of elements. */
  readonly length: number;
  /** Their characters, or `undefined` for deleted elements. */
  readonly text: string | undefined;
}

/**
 * One maximal run of consecutive elements in document order, as stored in encoded states.
 * Continuation records (whose parent is the previous counter of the same replica, on the right)
 * extend the run that contains their parent.
 */
export interface SnapshotRecord {
  /** Replica that inserted the elements. */
  readonly replica: string;
  /** Counter of the first element. */
  readonly counter: number;
  /** Number of elements. */
  readonly length: number;
  /** The characters, or `undefined` if the elements are deleted. */
  readonly text: string | undefined;
  /** Parent of the first element (`null` for the root). */
  readonly parent: ElementId | null;
  /** Side of the first element relative to `parent`. */
  readonly side: Side;
}

/** The result of {@link FugueList.insertLocal}: where the new run hangs in the tree. */
export interface LocalInsert {
  /** Parent of the first new element (`null` for the root). */
  readonly parent: ElementId | null;
  /** Side of the first new element relative to `parent`. */
  readonly side: Side;
}

/** See the module documentation. */
export class FugueList {
  /** The virtual root of the Fugue tree. */
  readonly root: Run = Run.root();
  #rope: Rope<Segment>;
  readonly #runs = new Map<string, Run[]>();

  /** @param options - Rope fan-out, overridable for tests. */
  constructor(options: RopeOptions = {}) {
    this.#rope = new Rope(segmentWeight, options);
  }

  /** Number of visible characters. */
  get length(): number {
    return this.#rope.weight;
  }

  /** Number of segments (visible and deleted) in the rope. */
  get segmentCount(): number {
    return this.#rope.size;
  }

  /** Number of runs (tree nodes after run-length compression). */
  get runCount(): number {
    let count = 0;
    for (const runs of this.#runs.values()) count += runs.length;
    return count;
  }

  /** The visible text. O(n). */
  toString(): string {
    const parts: string[] = [];
    for (const segment of this.#rope) if (segment.text !== undefined) parts.push(segment.text);
    return parts.join('');
  }

  /** The run containing element `(replica, counter)`, if known. O(log runs). */
  findRun(replica: string, counter: number): Run | undefined {
    const runs = this.#runs.get(replica);
    if (runs === undefined) return undefined;
    let lo = 0;
    let hi = runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((runs[mid] as Run).counter <= counter) lo = mid + 1;
      else hi = mid;
    }
    const run = runs[lo - 1];
    return run !== undefined && counter < run.counter + run.length ? run : undefined;
  }

  /** The element with the given ID, if known. */
  resolve(id: ElementId): Elem | undefined {
    const run = this.findRun(id.replica, id.counter);
    return run === undefined ? undefined : { run, offset: id.counter - run.counter };
  }

  /** Whether every element of `range` is known. */
  hasRange(range: ElementIdRange): boolean {
    const end = range.counter + range.length;
    for (let counter = range.counter; counter < end;) {
      const run = this.findRun(range.replica, counter);
      if (run === undefined) return false;
      counter = run.counter + run.length;
    }
    return true;
  }

  /** The visible element at `index` (`0 <= index < length`). */
  elementAt(index: number): Elem {
    const position = this.#find(index);
    return { run: position.item.run, offset: position.item.offset + position.offset };
  }

  /**
   * The visible index of `elem` and whether it is visible. For a deleted element, `index` is the
   * number of visible characters before it.
   */
  locate(elem: Elem): { index: number; visible: boolean } {
    const segment = this.#segmentAt(elem.run, elem.offset);
    const base = this.#rope.indexOf(segment);
    const visible = segment.text !== undefined;
    return { index: visible ? base + elem.offset - segment.offset : base, visible };
  }

  /**
   * Inserts `text` at visible `index` as a new run `(replica, counter...)`, following Fugue's
   * local insertion rule, and reports where it was attached.
   *
   * Let L be the character at `index - 1` (or the root). If L has no right child, the new run
   * becomes L's right child; otherwise it becomes the left child of R, the element right after L
   * in document order (tombstones included). Either way it lands immediately after L. When L is
   * the last character this replica typed, the existing run is simply extended.
   */
  insertLocal(index: number, text: string, replica: string, counter: number): LocalInsert {
    const length = text.length;
    let parent: Elem;
    let side: Side;
    let after: Segment | undefined;
    if (index === 0) {
      const first = this.#rope.first();
      if (first === undefined) {
        parent = { run: this.root, offset: 0 };
        side = 'right';
      } else {
        parent = { run: first.run, offset: first.offset };
        side = 'left';
      }
    } else {
      const position = this.#find(index - 1);
      const segment = position.item;
      const left: Elem = { run: segment.run, offset: segment.offset + position.offset };
      if (!hasRightChild(left.run, left.offset)) {
        const run = left.run;
        if (
          run.replica === replica &&
          run.counter + run.length === counter &&
          left.offset === run.length - 1
        ) {
          // Run-length encoding: the new characters continue this replica's latest run. `left`
          // is the last element of its run, hence of `segment`, which is visible.
          run.length += length;
          segment.length += length;
          segment.text = (segment.text as string) + text;
          this.#rope.adjust(segment, length);
          return { parent: idOf(left), side: 'right' };
        }
        parent = left;
        side = 'right';
      } else if (position.offset + 1 < segment.length) {
        parent = { run: segment.run, offset: left.offset + 1 };
        side = 'left';
      } else {
        const next = this.#rope.next(segment) as Segment;
        parent = { run: next.run, offset: next.offset };
        side = 'left';
      }
      after = this.#splitAfter(left);
    }
    const run = new Run(replica, counter, length, parent.run, parent.offset, side);
    addKid(parent.run, parent.offset, side, run);
    this.#register(run);
    const segment = new Segment(run, 0, length, text);
    run.segments.push(segment);
    this.#rope.insertAfter(after, segment);
    return { parent: parent.run === this.root ? null : idOf(parent), side };
  }

  /** Deletes the visible characters `[index, index + length)` and returns their IDs. */
  deleteLocal(index: number, length: number): ElementIdRange[] {
    const targets: ElementIdRange[] = [];
    const position = this.#find(index);
    let segment = this.#splitAt(position.item, position.offset);
    let remaining = length;
    while (remaining > 0) {
      if (segment.text !== undefined) {
        if (segment.length > remaining) this.#split(segment, remaining);
        remaining -= segment.length;
        pushRange(
          targets,
          segment.run.replica,
          segment.run.counter + segment.offset,
          segment.length,
        );
        segment = this.#markDeleted(segment);
      }
      if (remaining > 0) segment = this.#rope.next(segment) as Segment;
    }
    return targets;
  }

  /**
   * Marks every element of `range` as deleted (all must be known; see {@link hasRange}) and
   * appends the visible changes to `changes`.
   */
  deleteRange(range: ElementIdRange, changes?: TextChange[]): void {
    const end = range.counter + range.length;
    for (let counter = range.counter; counter < end;) {
      const run = this.findRun(range.replica, counter) as Run;
      const stop = Math.min(end, run.counter + run.length) - run.counter;
      for (let offset = counter - run.counter; offset < stop;) {
        let segment = this.#segmentAt(run, offset);
        if (segment.text === undefined) {
          offset = segment.offset + segment.length;
          continue;
        }
        segment = this.#splitAt(segment, offset - segment.offset);
        if (segment.offset + segment.length > stop) this.#split(segment, stop - segment.offset);
        changes?.push({
          type: 'delete',
          index: this.#rope.indexOf(segment),
          length: segment.length,
        });
        offset = segment.offset + segment.length;
        this.#markDeleted(segment);
      }
      counter = run.counter + stop;
    }
  }

  /**
   * Integrates a run created elsewhere: elements `(replica, counter...)` whose first element is
   * the `side` child of `parent`. None of the new elements may have children yet (guaranteed by
   * causal delivery). Appends the visible change to `changes`.
   *
   * Placement follows the tree order: a new right child goes right before the subtree of its
   * next-greater right sibling, or after the end of the parent's subtree if there is none; a new
   * left child goes right before the subtree of its next-greater left sibling, or right before
   * the parent.
   */
  integrate(
    replica: string,
    counter: number,
    parent: Elem,
    side: Side,
    pieces: readonly Piece[],
    changes?: TextChange[],
  ): void {
    let total = 0;
    for (const piece of pieces) total += piece.length;

    // 1. Where the run goes in document order, decided before it joins the tree.
    let after: Segment | undefined;
    let before: Segment | undefined;
    const successor = successorSibling(parent.run, parent.offset, side, replica, counter);
    if (successor !== undefined) {
      before = this.#splitBefore(leftmost(successor.run, successor.offset));
    } else if (side === 'left') {
      before = this.#splitBefore(parent);
    } else {
      const last = rightmost(parent.run, parent.offset);
      if (last.run !== this.root) after = this.#splitAfter(last);
    }

    // 2. Attach it to the tree, extending the parent's run when it is a continuation.
    let run: Run;
    let offset: number;
    if (
      side === 'right' &&
      parent.run !== this.root &&
      parent.run.replica === replica &&
      parent.offset === parent.run.length - 1 &&
      parent.run.counter + parent.run.length === counter
    ) {
      run = parent.run;
      offset = run.length;
      run.length += total;
    } else {
      run = new Run(replica, counter, total, parent.run, parent.offset, side);
      addKid(parent.run, parent.offset, side, run);
      this.#register(run);
      offset = 0;
    }

    // 3. Insert the segments into the rope right after `previous` (`undefined`: at the start),
    //    growing `previous` instead when it is the contiguous, equally visible part of the run.
    let previous = before !== undefined ? this.#rope.prev(before) : after;
    const index =
      changes !== undefined && previous !== undefined
        ? this.#rope.indexOf(previous) + segmentWeight(previous)
        : 0;
    let visibleText = '';
    for (const piece of pieces) {
      if (piece.text !== undefined) visibleText += piece.text;
      if (previous !== undefined && mergeable(previous, { run, offset, text: piece.text })) {
        previous.length += piece.length;
        if (piece.text !== undefined) {
          previous.text = (previous.text as string) + piece.text;
          this.#rope.adjust(previous, piece.length);
        }
      } else {
        const segment = new Segment(run, offset, piece.length, piece.text);
        run.segments.push(segment);
        this.#rope.insertAfter(previous, segment);
        previous = segment;
      }
      offset += piece.length;
    }
    if (changes !== undefined && visibleText.length > 0) {
      changes.push({ type: 'insert', index, text: visibleText });
    }
  }

  /** The content of `run` from `from` onwards, as pieces of uniform visibility. */
  piecesOf(run: Run, from: number): Piece[] {
    const pieces: Piece[] = [];
    for (const segment of run.segments) {
      const end = segment.offset + segment.length;
      if (end <= from) continue;
      const start = Math.max(segment.offset, from);
      pieces.push({ length: end - start, text: segment.text?.slice(start - segment.offset) });
    }
    return pieces;
  }

  /** Every segment in document order. */
  segments(): IterableIterator<Segment> {
    return this.#rope[Symbol.iterator]();
  }

  /**
   * The document as records in document order, one per segment. Segments are maximal (see
   * {@link checkInvariants}), so equal states produce equal records.
   */
  snapshot(): SnapshotRecord[] {
    const records: SnapshotRecord[] = [];
    for (const segment of this.#rope) {
      const { run, offset } = segment;
      let parent: ElementId | null;
      let side: Side;
      if (offset > 0) {
        parent = { replica: run.replica, counter: run.counter + offset - 1 };
        side = 'right';
      } else {
        const parentRun = run.parent as Run;
        parent =
          parentRun === this.root
            ? null
            : { replica: parentRun.replica, counter: parentRun.counter + run.parentOffset };
        side = run.side;
      }
      records.push({
        replica: run.replica,
        counter: run.counter + offset,
        length: segment.length,
        text: segment.text,
        parent,
        side,
      });
    }
    return records;
  }

  /**
   * Every run (root excluded) in a causal order: each run comes after the run containing its
   * parent and after the previous run (by counter) of the same replica. Integrating runs in this
   * order appends to the per-replica index instead of inserting into its middle. Throws
   * `invalid-state` if no such order exists, which no real execution can produce.
   */
  runsInCausalOrder(): Run[] {
    const pending = new Map<Run, number>();
    const nextOfReplica = new Map<Run, Run>();
    const ready: Run[] = [];
    let total = 0;
    for (const runs of this.#runs.values()) {
      total += runs.length;
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i] as Run;
        const next = runs[i + 1];
        if (next !== undefined) nextOfReplica.set(run, next);
        const blockers = (run.parent === this.root ? 0 : 1) + (i > 0 ? 1 : 0);
        if (blockers === 0) ready.push(run);
        else pending.set(run, blockers);
      }
    }
    const order: Run[] = [];
    const release = (run: Run): void => {
      const blockers = (pending.get(run) as number) - 1;
      if (blockers === 0) {
        pending.delete(run);
        ready.push(run);
      } else {
        pending.set(run, blockers);
      }
    };
    for (let run = ready.pop(); run !== undefined; run = ready.pop()) {
      order.push(run);
      for (const slots of [run.leftKids, run.rightKids]) {
        if (slots === undefined) continue;
        for (const slot of slots) for (const kid of slot.runs) release(kid);
      }
      const next = nextOfReplica.get(run);
      if (next !== undefined) release(next);
    }
    if (order.length !== total) invalidState('the state has no causal order');
    return order;
  }

  /**
   * Rebuilds a list from records in document order, validating that they describe a well-formed
   * Fugue tree whose traversal is exactly that order. Throws `invalid-state` otherwise.
   */
  static fromSnapshot(records: Iterable<SnapshotRecord>, options: RopeOptions = {}): FugueList {
    const list = new FugueList(options);
    const segments: Segment[] = [];
    const links: { run: Run; parent: ElementId | null }[] = [];
    // Runs that a continuation record may extend, keyed by replica and next counter.
    const openEnds = new Map<string, Map<number, Run>>();
    for (const record of records) {
      const { replica, counter, length, parent, side } = record;
      let ends = openEnds.get(replica);
      if (ends === undefined) {
        ends = new Map();
        openEnds.set(replica, ends);
      }
      let run: Run;
      if (side === 'right' && parent?.replica === replica && parent.counter === counter - 1) {
        const previous = ends.get(counter);
        if (previous === undefined) {
          invalidState(`element ${replica}:${String(counter)} does not follow its parent`);
        }
        ends.delete(counter);
        run = previous;
        run.length += length;
      } else {
        run = new Run(replica, counter, length, undefined, 0, side);
        links.push({ run, parent });
      }
      ends.set(counter + length, run);
      const offset = counter - run.counter;
      const last = segments[segments.length - 1];
      if (last !== undefined && mergeable(last, { run, offset, text: record.text })) {
        // A non-canonical but valid input: keep segments maximal.
        last.length += length;
        if (record.text !== undefined) last.text = (last.text as string) + record.text;
        continue;
      }
      const segment = new Segment(run, offset, length, record.text);
      run.segments.push(segment);
      segments.push(segment);
    }
    for (const { run } of links) {
      let runs = list.#runs.get(run.replica);
      if (runs === undefined) {
        runs = [];
        list.#runs.set(run.replica, runs);
      }
      runs.push(run);
    }
    for (const [replica, runs] of list.#runs) {
      runs.sort((a, b) => a.counter - b.counter);
      for (let i = 1; i < runs.length; i++) {
        const previous = runs[i - 1] as Run;
        if (previous.counter + previous.length > (runs[i] as Run).counter) {
          invalidState(`element ${replica}:${String((runs[i] as Run).counter)} appears twice`);
        }
      }
    }
    for (const { run, parent } of links) {
      if (parent === null) {
        // The decoders already rejected left children of the root.
        run.parent = list.root;
        run.parentOffset = 0;
        addKid(list.root, 0, 'right', run);
        continue;
      }
      const elem = list.resolve(parent);
      if (elem === undefined) {
        invalidState(`unknown parent ${parent.replica}:${String(parent.counter)}`);
      }
      run.parent = elem.run;
      run.parentOffset = elem.offset;
      addKid(elem.run, elem.offset, run.side, run);
    }
    list.#rope = Rope.from(segments, segmentWeight, options);
    if (!list.#matchesTreeOrder()) invalidState('records are not in Fugue tree order');
    return list;
  }

  /**
   * Verifies every invariant of the structure and throws on the first violation. O(n); intended
   * for tests.
   */
  checkInvariants(): void {
    this.#rope.checkInvariants();
    const check = (condition: boolean, what: string): void => {
      /* v8 ignore next */
      if (!condition) throw new Error(`list invariant violated: ${what}`);
    };
    let segmentTotal = 0;
    for (const [replica, runs] of this.#runs) {
      let end = -1;
      for (const run of runs) {
        check(run.replica === replica && run.counter > end, 'runs sorted and disjoint');
        end = run.counter + run.length - 1;
        let offset = 0;
        for (const segment of run.segments) {
          check(segment.run === run && segment.offset === offset, 'segments tile their run');
          check(segment.length > 0, 'non-empty segment');
          check(segment.text === undefined || segment.text.length === segment.length, 'text size');
          offset += segment.length;
        }
        check(offset === run.length, 'segments cover their run');
        segmentTotal += run.segments.length;
        for (const [slots, side] of [
          [run.leftKids, 'left'],
          [run.rightKids, 'right'],
        ] as const) {
          if (slots === undefined) continue;
          let previousOffset = -1;
          for (const slot of slots) {
            check(slot.offset > previousOffset && slot.offset < run.length, 'slots sorted');
            previousOffset = slot.offset;
            check(slot.runs.length > 0, 'non-empty slot');
            for (let i = 0; i < slot.runs.length; i++) {
              const kid = slot.runs[i] as Run;
              check(kid.parent === run && kid.parentOffset === slot.offset, 'kid parent');
              check(kid.side === side, 'kid side');
              const prev = slot.runs[i - 1];
              check(
                prev === undefined ||
                  compareIds(prev.replica, prev.counter, kid.replica, kid.counter) < 0,
                'siblings sorted',
              );
            }
          }
        }
      }
    }
    check(segmentTotal === this.#rope.size, 'every segment is in the rope');
    let previous: Segment | undefined;
    for (const segment of this.#rope) {
      check(previous === undefined || !mergeable(previous, segment), 'segments are maximal');
      previous = segment;
      const { run } = segment;
      const parent = run.parent as Run;
      check(
        segment.offset > 0 ||
          parent === this.root ||
          run.side === 'left' ||
          parent.replica !== run.replica ||
          parent.counter + run.parentOffset !== run.counter - 1,
        'runs are maximal chains',
      );
    }
    check(kidsAt(this.root.leftKids, 0) === undefined, 'root has no left children');
    check(this.#matchesTreeOrder(), 'rope order equals tree traversal');
  }

  /** Whether the rope lists exactly the tree's in-order traversal. */
  #matchesTreeOrder(): boolean {
    const segments = this.#rope[Symbol.iterator]();
    let current = segments.next();
    let consumed = 0; // elements of the current segment already matched
    for (const { run, start, end } of traverse(this.root)) {
      for (let offset = start; offset < end;) {
        /* v8 ignore next */
        if (current.done === true) return false;
        const segment = current.value;
        if (segment.run !== run || segment.offset + consumed !== offset) return false;
        const take = Math.min(end - offset, segment.length - consumed);
        offset += take;
        consumed += take;
        if (consumed === segment.length) {
          current = segments.next();
          consumed = 0;
        }
      }
    }
    return current.done === true;
  }

  /**
   * Registers a new run in the per-replica index. Runs of one replica always arrive in counter
   * order (local edits, causal delivery, merges in causal order), so this is an append.
   */
  #register(run: Run): void {
    let runs = this.#runs.get(run.replica);
    if (runs === undefined) {
      runs = [];
      this.#runs.set(run.replica, runs);
    }
    const last = runs[runs.length - 1];
    /* v8 ignore next 3 */
    if (last !== undefined && last.counter + last.length > run.counter) {
      throw new Error('internal error: runs registered out of counter order');
    }
    runs.push(run);
  }

  /** The visible position `index`; callers have validated the range. */
  #find(index: number): RopePosition<Segment> {
    const position = this.#rope.find(index);
    /* v8 ignore next */
    if (position === undefined) throw new RangeError(`index ${String(index)} out of range`);
    return position;
  }

  /** The segment containing element `offset` of `run`. */
  #segmentAt(run: Run, offset: number): Segment {
    const segments = run.segments;
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((segments[mid] as Segment).offset <= offset) lo = mid + 1;
      else hi = mid;
    }
    return segments[lo - 1] as Segment;
  }

  /** Position of `segment` within its run's segment list. */
  #segmentIndex(segment: Segment): number {
    const segments = segment.run.segments;
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((segments[mid] as Segment).offset < segment.offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Splits `segment` so that its first `at` elements stay; returns the new tail segment. */
  #split(segment: Segment, at: number): Segment {
    const tail = new Segment(
      segment.run,
      segment.offset + at,
      segment.length - at,
      segment.text?.slice(at),
    );
    if (segment.text !== undefined) {
      segment.text = segment.text.slice(0, at);
      this.#rope.adjust(segment, -tail.length);
    }
    segment.length = at;
    this.#rope.insertAfter(segment, tail);
    segment.run.segments.splice(this.#segmentIndex(segment) + 1, 0, tail);
    return tail;
  }

  /** Returns a segment that starts at element `at` of `segment`, splitting if needed. */
  #splitAt(segment: Segment, at: number): Segment {
    return at === 0 ? segment : this.#split(segment, at);
  }

  /** Returns a segment that starts with `elem`, splitting if needed. */
  #splitBefore(elem: Elem): Segment {
    const segment = this.#segmentAt(elem.run, elem.offset);
    return this.#splitAt(segment, elem.offset - segment.offset);
  }

  /** Returns a segment that ends with `elem`, splitting if needed. */
  #splitAfter(elem: Elem): Segment {
    const segment = this.#segmentAt(elem.run, elem.offset);
    const at = elem.offset - segment.offset + 1;
    if (at < segment.length) this.#split(segment, at);
    return segment;
  }

  /** Turns a visible segment into a tombstone, merging it with adjacent tombstones of its run. */
  #markDeleted(segment: Segment): Segment {
    const length = segment.length;
    segment.text = undefined;
    this.#rope.adjust(segment, -length);
    let survivor = segment;
    const previous = this.#rope.prev(segment);
    if (previous !== undefined && mergeable(previous, segment)) {
      previous.length += segment.length;
      this.#removeSegment(segment);
      survivor = previous;
    }
    const next = this.#rope.next(survivor);
    if (next !== undefined && mergeable(survivor, next)) {
      survivor.length += next.length;
      this.#removeSegment(next);
    }
    return survivor;
  }

  #removeSegment(segment: Segment): void {
    this.#rope.remove(segment);
    segment.run.segments.splice(this.#segmentIndex(segment), 1);
  }
}

/** The ID of an element (never the root). */
export function idOf(elem: Elem): ElementId {
  return { replica: elem.run.replica, counter: elem.run.counter + elem.offset };
}

/** Whether `b` directly continues `a` within one run with the same visibility. */
function mergeable(a: Segment, b: { run: Run; offset: number; text: string | undefined }): boolean {
  return (
    a.run === b.run &&
    a.offset + a.length === b.offset &&
    (a.text === undefined) === (b.text === undefined)
  );
}

function pushRange(
  ranges: ElementIdRange[],
  replica: string,
  counter: number,
  length: number,
): void {
  const last = ranges[ranges.length - 1];
  if (last?.replica === replica && last.counter + last.length === counter) {
    ranges[ranges.length - 1] = { replica, counter: last.counter, length: last.length + length };
  } else {
    ranges.push({ replica, counter, length });
  }
}
