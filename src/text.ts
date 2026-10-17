import {
  decodeSnapshot,
  type DocumentSnapshot,
  encodeSnapshot,
  snapshotFromJSON,
  snapshotToJSON,
} from './encoding/state.js';
import { FugueTextError, invalidOperation, invalidState } from './errors.js';
import { isCounter, isReplicaId, randomReplicaId } from './internal/ids.js';
import { FugueList, idOf } from './internal/list.js';
import { reportError } from './internal/platform.js';
import type { Elem } from './internal/tree.js';
import { assertOperation, operationSpan } from './operations.js';
import type {
  Anchor,
  AnchorBias,
  ApplyResult,
  ChangeListener,
  DeleteOperation,
  InsertOperation,
  Operation,
  ReplicaId,
  Side,
  TextChange,
  TextOptions,
  TextStateJSON,
  VersionVector,
} from './types.js';

let listOf: (text: Text) => FugueList;

/** Shared by every operation without new dependencies (the common case while typing). */
const NO_DEPS: VersionVector = Object.freeze({});

/**
 * One replica of a collaboratively edited plain-text document, implemented with the Fugue list
 * CRDT (Weidner & Kleppmann, arXiv:2305.00583).
 *
 * Local edits ({@link Text.insert}, {@link Text.delete}) take effect immediately and return an
 * {@link Operation} to broadcast to the other replicas, which integrate it with
 * {@link Text.apply}. Operations may arrive late, out of order or more than once; they are
 * buffered until their causal dependencies are present and duplicates are ignored. Replicas can
 * also exchange whole states with {@link Text.save} and {@link Text.merge}. Once every replica
 * has seen the same operations, all of them hold the same text, and concurrent insertions at the
 * same place do not interleave character by character.
 *
 * Indexes and lengths count UTF-16 code units, like JavaScript strings and `<textarea>`.
 */
export class Text {
  /** This replica's ID. */
  readonly replicaId: ReplicaId;
  #list = new FugueList();
  #version = new Map<string, number>();
  /** Replicas whose version grew since this replica's previous operation (its next deps). */
  readonly #dirty = new Set<string>();
  readonly #pending = new Map<string, Map<number, Operation>>();
  #pendingCount = 0;
  readonly #listeners = new Set<ChangeListener>();
  #cachedString: string | undefined = '';

  static {
    listOf = (text) => text.#list;
  }

  /** Creates an empty document. */
  constructor(options: TextOptions = {}) {
    const replicaId = options.replicaId ?? randomReplicaId();
    if (!isReplicaId(replicaId)) {
      throw new TypeError('replicaId must be 1 to 64 printable ASCII characters');
    }
    this.replicaId = replicaId;
  }

  /**
   * Creates a replica from a state produced by {@link Text.save} or {@link Text.toJSON}.
   * @throws {FugueTextError} `invalid-state` if the state is malformed.
   */
  static load(state: Uint8Array | TextStateJSON, options: TextOptions = {}): Text {
    const snapshot = decodeState(state);
    const text = new Text(options);
    text.#list = FugueList.fromSnapshot(snapshot.records);
    text.#list.runsInCausalOrder(); // rejects states that no execution can produce
    text.#version = new Map(snapshot.version);
    for (const replica of text.#version.keys()) {
      if (replica !== text.replicaId) text.#dirty.add(replica);
    }
    text.#cachedString = undefined;
    return text;
  }

  /** Number of characters (UTF-16 code units). */
  get length(): number {
    return this.#list.length;
  }

  /** Number of received operations waiting for missing causal dependencies. */
  get pendingCount(): number {
    return this.#pendingCount;
  }

  /** The operations this replica has applied, as a version vector (a fresh copy). */
  get version(): VersionVector {
    return Object.fromEntries(this.#version);
  }

  /** The current text. Cached between changes. */
  toString(): string {
    return (this.#cachedString ??= this.#list.toString());
  }

  /**
   * Inserts `text` before position `index` and returns the operation to send to other replicas,
   * or `undefined` if `text` is empty.
   * @throws {RangeError} if `index` is not an integer in `[0, length]`.
   */
  insert(index: number, text: string): InsertOperation | undefined {
    checkPosition(index, this.length, 'index');
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (text.length === 0) return undefined;
    const counter = this.#version.get(this.replicaId) ?? 0;
    if (!Number.isSafeInteger(counter + text.length)) throw new RangeError('counter overflow');
    const placement = this.#list.insertLocal(index, text, this.replicaId, counter);
    this.#version.set(this.replicaId, counter + text.length);
    this.#cachedString = undefined;
    const op: InsertOperation = {
      type: 'insert',
      replica: this.replicaId,
      counter,
      deps: this.#takeDeps(),
      parent: placement.parent,
      side: placement.side,
      text,
    };
    if (this.#listeners.size > 0) this.#emit('local', [{ type: 'insert', index, text }]);
    return op;
  }

  /**
   * Deletes `length` characters starting at `index` and returns the operation to send to other
   * replicas, or `undefined` if `length` is 0.
   * @throws {RangeError} if the range is not within `[0, length]`.
   */
  delete(index: number, length: number): DeleteOperation | undefined {
    checkPosition(index, this.length, 'index');
    checkPosition(length, this.length - index, 'length');
    if (length === 0) return undefined;
    const counter = this.#version.get(this.replicaId) ?? 0;
    if (!Number.isSafeInteger(counter + 1)) throw new RangeError('counter overflow');
    const targets = this.#list.deleteLocal(index, length);
    this.#version.set(this.replicaId, counter + 1);
    this.#cachedString = undefined;
    const op: DeleteOperation = {
      type: 'delete',
      replica: this.replicaId,
      counter,
      deps: this.#takeDeps(),
      targets,
    };
    if (this.#listeners.size > 0) this.#emit('local', [{ type: 'delete', index, length }]);
    return op;
  }

  /**
   * Integrates an operation from another replica. Operations whose causal dependencies are
   * missing are buffered and applied automatically once the dependencies arrive; operations
   * that were already applied or buffered are ignored, so redelivery is harmless.
   * @throws {FugueTextError} `invalid-operation` if the operation is malformed or inconsistent with
   *   this document, `replica-conflict` if it claims this replica's ID but was not produced here.
   */
  apply(op: Operation): ApplyResult {
    assertOperation(op);
    const applied = this.#version.get(op.replica) ?? 0;
    if (op.counter + operationSpan(op) <= applied) return 'duplicate';
    if (op.counter < applied) {
      invalidOperation(`operation ${op.replica}:${String(op.counter)} overlaps applied operations`);
    }
    if (op.replica === this.replicaId) {
      throw new FugueTextError(
        'replica-conflict',
        `received an unknown operation from this replica's own ID ${op.replica}`,
      );
    }
    let queue = this.#pending.get(op.replica);
    if (queue?.has(op.counter) === true) return 'duplicate';
    if (op.counter !== applied || !this.#depsSatisfied(op)) {
      if (queue === undefined) {
        queue = new Map();
        this.#pending.set(op.replica, queue);
      }
      queue.set(op.counter, op);
      this.#pendingCount++;
      return 'buffered';
    }
    const changes = this.#listeners.size > 0 ? [] : undefined;
    try {
      this.#integrate(op, changes);
      this.#drain(changes);
    } finally {
      if (changes !== undefined) this.#emit('remote', changes);
    }
    return 'applied';
  }

  /** Encodes the full state (without buffered operations) in the compact binary format. */
  save(): Uint8Array {
    return encodeSnapshot(this.#snapshot());
  }

  /** The full state as readable JSON, for debugging; `JSON.stringify(text)` uses it. */
  toJSON(): TextStateJSON {
    return snapshotToJSON(this.#snapshot());
  }

  /**
   * Merges a state produced by another replica's {@link Text.save} or {@link Text.toJSON} into
   * this one (state-based synchronisation). Merging is commutative, associative and idempotent.
   * @throws {FugueTextError} `invalid-state` if the state is malformed or inconsistent with this
   *   document, `replica-conflict` if it contains operations of this replica's ID unknown here.
   */
  merge(state: Uint8Array | TextStateJSON): void {
    const snapshot = decodeState(state);
    const other = FugueList.fromSnapshot(snapshot.records);
    const runs = other.runsInCausalOrder();
    const own = this.#version.get(this.replicaId) ?? 0;
    if ((snapshot.version.get(this.replicaId) ?? 0) > own) {
      throw new FugueTextError(
        'replica-conflict',
        `the state contains operations of this replica's own ID ${this.replicaId} unknown here`,
      );
    }
    const before = new Map(this.#version);
    const list = this.#list;
    const knownPrefix = (replica: string, counter: number, length: number): number =>
      Math.min(Math.max((before.get(replica) ?? 0) - counter, 0), length);

    // Validate first so that a rejected state leaves this document untouched.
    for (const run of runs) {
      const known = knownPrefix(run.replica, run.counter, run.length);
      // Parents are covered too: a parent below `before` belongs to some run's known prefix.
      if (
        known > 0 &&
        !list.hasRange({ replica: run.replica, counter: run.counter, length: known })
      ) {
        invalidState(`elements of ${run.replica} disagree with this document`);
      }
    }

    const changes = this.#listeners.size > 0 ? [] : undefined;
    try {
      for (const run of runs) {
        const known = knownPrefix(run.replica, run.counter, run.length);
        if (known === run.length) continue;
        let parent: Elem;
        let side: Side;
        if (known > 0) {
          parent = list.resolve({ replica: run.replica, counter: run.counter + known - 1 }) as Elem;
          side = 'right';
        } else if (run.parent === other.root) {
          parent = { run: list.root, offset: 0 };
          side = 'right';
        } else {
          parent = list.resolve(
            idOf({ run: run.parent as Elem['run'], offset: run.parentOffset }),
          ) as Elem;
          side = run.side;
        }
        list.integrate(
          run.replica,
          run.counter + known,
          parent,
          side,
          other.piecesOf(run, known),
          changes,
        );
      }
      for (const segment of other.segments()) {
        if (segment.text !== undefined) continue;
        const range = {
          replica: segment.run.replica,
          counter: segment.run.counter + segment.offset,
          length: segment.length,
        };
        list.deleteRange(range, changes);
      }
      for (const [replica, version] of snapshot.version) {
        if (version > (before.get(replica) ?? 0)) {
          this.#version.set(replica, version);
          this.#dirty.add(replica);
        }
      }
      this.#cachedString = undefined;
      this.#dropStalePending();
      this.#drain(changes);
    } finally {
      if (changes !== undefined) this.#emit('remote', changes);
    }
  }

  /**
   * Creates an anchor for the gap before position `index` that keeps pointing at the same place
   * as the text around it changes. See {@link AnchorBias} for what happens when text is inserted
   * exactly at the anchor.
   * @throws {RangeError} if `index` is not an integer in `[0, length]`.
   */
  createAnchor(index: number, bias: AnchorBias = 'left'): Anchor {
    checkPosition(index, this.length, 'index');
    switch (bias) {
      case 'left':
        if (index === 0) return { type: 'start' };
        return { type: 'element', id: idOf(this.#list.elementAt(index - 1)), bias };
      case 'right':
        if (index === this.length) return { type: 'end' };
        return { type: 'element', id: idOf(this.#list.elementAt(index)), bias };
      default:
        throw new TypeError("bias must be 'left' or 'right'");
    }
  }

  /**
   * The current position of an anchor, or `undefined` if it refers to a character this replica
   * has not received yet. Anchors to deleted characters resolve to where the character was.
   */
  resolveAnchor(anchor: Anchor): number | undefined {
    switch (anchor.type) {
      case 'start':
        return 0;
      case 'end':
        return this.length;
      case 'element': {
        const { id, bias } = anchor;
        if (!isReplicaId(id.replica) || !isCounter(id.counter))
          throw new TypeError('malformed anchor');
        const elem = this.#list.resolve(id);
        if (elem === undefined) return undefined;
        const { index, visible } = this.#list.locate(elem);
        return bias === 'left' && visible ? index + 1 : index;
      }
      default:
        throw new TypeError('malformed anchor');
    }
  }

  /**
   * Registers a listener for changes to the visible text, both local and remote. Listeners run
   * synchronously after the document has been updated; an exception thrown by a listener is
   * reported asynchronously and does not affect the document or other listeners.
   * @returns A function that unregisters the listener.
   */
  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #snapshot(): DocumentSnapshot {
    return { version: this.#version, records: this.#list.snapshot() };
  }

  #takeDeps(): VersionVector {
    if (this.#dirty.size === 0) return NO_DEPS;
    const deps: [string, number][] = [];
    // Never contains this replica: its own version only grows through local edits.
    for (const replica of this.#dirty) deps.push([replica, this.#version.get(replica) as number]);
    this.#dirty.clear();
    return Object.fromEntries(deps);
  }

  #depsSatisfied(op: Operation): boolean {
    for (const [replica, version] of Object.entries(op.deps)) {
      if ((this.#version.get(replica) ?? 0) < version) return false;
    }
    return true;
  }

  /** Applies an operation whose dependencies are satisfied. */
  #integrate(op: Operation, changes: TextChange[] | undefined): void {
    const list = this.#list;
    if (op.type === 'insert') {
      const parent = op.parent === null ? { run: list.root, offset: 0 } : list.resolve(op.parent);
      if (parent === undefined) {
        invalidOperation(
          `insert ${op.replica}:${String(op.counter)} has an unknown parent ${op.parent?.replica ?? ''}:${String(op.parent?.counter)}`,
        );
      }
      list.integrate(
        op.replica,
        op.counter,
        parent,
        op.side,
        [{ length: op.text.length, text: op.text }],
        changes,
      );
    } else {
      for (const target of op.targets) {
        if (!list.hasRange(target)) {
          invalidOperation(`delete ${op.replica}:${String(op.counter)} targets unknown elements`);
        }
      }
      for (const target of op.targets) list.deleteRange(target, changes);
    }
    this.#version.set(op.replica, op.counter + operationSpan(op));
    this.#dirty.add(op.replica);
    this.#cachedString = undefined;
  }

  /** Applies buffered operations that have become ready, until none is. */
  #drain(changes: TextChange[] | undefined): void {
    let progressed = true;
    while (progressed && this.#pendingCount > 0) {
      progressed = false;
      for (const [replica, queue] of this.#pending) {
        for (;;) {
          const op = queue.get(this.#version.get(replica) ?? 0);
          if (op === undefined || !this.#depsSatisfied(op)) break;
          queue.delete(op.counter);
          this.#pendingCount--;
          if (queue.size === 0) this.#pending.delete(replica);
          this.#integrate(op, changes);
          progressed = true;
        }
      }
    }
  }

  /** Drops buffered operations that a merge made redundant. */
  #dropStalePending(): void {
    for (const [replica, queue] of this.#pending) {
      const applied = this.#version.get(replica) ?? 0;
      for (const counter of queue.keys()) {
        if (counter < applied) {
          queue.delete(counter);
          this.#pendingCount--;
        }
      }
      if (queue.size === 0) this.#pending.delete(replica);
    }
  }

  #emit(origin: 'local' | 'remote', changes: readonly TextChange[]): void {
    if (changes.length === 0) return;
    const event = { origin, changes };
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        reportError(error);
      }
    }
  }
}

/**
 * Merges two encoded states into one without keeping a live document around. The result is the
 * same whichever order the arguments are given in.
 * @throws {FugueTextError} `invalid-state` if either state is malformed.
 */
export function mergeStates(a: Uint8Array, b: Uint8Array): Uint8Array {
  const text = Text.load(a);
  text.merge(b);
  return text.save();
}

/** @internal Gives tests and benchmarks access to the underlying structure. */
export function internalList(text: Text): FugueList {
  return listOf(text);
}

function decodeState(state: Uint8Array | TextStateJSON): DocumentSnapshot {
  return state instanceof Uint8Array ? decodeSnapshot(state) : snapshotFromJSON(state);
}

function checkPosition(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} ${String(value)} is out of range [0, ${String(max)}]`);
  }
}
