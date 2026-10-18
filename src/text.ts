import {
  decodeSnapshot,
  type DocumentSnapshot,
  encodeSnapshot,
  snapshotFromJSON,
  snapshotToJSON,
} from './encoding/state.js';
import { FugueTextError, invalidOperation } from './errors.js';
import { isAnchor, isReplicaId, MAX_COUNTER } from './internal/guards.js';
import { MinHeap } from './internal/heap.js';
import { randomReplicaId, versionVector } from './internal/ids.js';
import { FugueList, idOf } from './internal/list.js';
import { reportError } from './internal/platform.js';
import { assertOperation, operationSpan, sameOperation } from './operations.js';
import type {
  Anchor,
  AnchorBias,
  ApplyResult,
  ChangeEvent,
  ChangeListener,
  DeleteOperation,
  FugueTextOptions,
  InsertOperation,
  Operation,
  RejectListener,
  ReplicaId,
  TextChange,
  TextStateJSON,
  VersionVector,
} from './types.js';

let listOf: (text: FugueText) => FugueList;

/** Shared by every operation without new dependencies (the common case while typing). */
const NO_DEPS: VersionVector = Object.freeze(versionVector([]));

/**
 * What a buffered operation waits for: `version[replica] >= counter`. For the operation's own
 * replica the version must then equal its counter exactly (per-sender FIFO order).
 */
interface Blocker {
  readonly replica: string;
  readonly counter: number;
}

/** The outcome of checking a buffered operation against the current version vector. */
type Readiness = Blocker | 'ready' | 'duplicate' | 'overlap';

/**
 * One replica of a collaboratively edited plain-text document, implemented with the Fugue list
 * CRDT (Weidner & Kleppmann, arXiv:2305.00583).
 *
 * Local edits ({@link FugueText.insert}, {@link FugueText.delete}) take effect immediately and
 * return an {@link Operation} to broadcast to the other replicas, which integrate it with
 * {@link FugueText.apply}. Operations may arrive late, out of order or more than once; they are
 * buffered until their causal dependencies are present and duplicates are ignored. Replicas can
 * also exchange whole states with {@link FugueText.save} and {@link FugueText.merge}. Once every
 * replica has seen the same operations, all of them hold the same text, and concurrent insertions
 * at the same place do not interleave character by character.
 *
 * Indexes and lengths count UTF-16 code units, like JavaScript strings and `<textarea>`.
 */
export class FugueText {
  /** This replica's ID. */
  readonly replicaId: ReplicaId;
  #list = new FugueList();
  #version = new Map<string, number>();
  /** Replicas whose version grew since this replica's previous operation (its next deps). */
  readonly #dirty = new Set<string>();
  /** Buffered operations by sender and counter, for duplicate detection. */
  readonly #pending = new Map<string, Map<number, Operation>>();
  #pendingCount = 0;
  /**
   * Wake lists: buffered operations keyed by the replica they wait for, ordered by the version
   * they need. When a replica's version grows, only the operations waiting for it are checked.
   */
  readonly #waiting = new Map<string, MinHeap<Operation>>();
  /** Buffered operations to check again, filled by {@link FugueText.#wake}. */
  readonly #woken: Operation[] = [];
  readonly #onReject: RejectListener | undefined;
  readonly #listeners = new Set<ChangeListener>();
  /** Events waiting to be delivered (see {@link FugueText.#emit}). */
  readonly #events: ChangeEvent[] = [];
  #dispatching = false;
  #cachedString: string | undefined = '';

  static {
    listOf = (text) => text.#list;
  }

  /** Creates an empty document. */
  constructor(options: FugueTextOptions = {}) {
    const replicaId = options.replicaId ?? randomReplicaId();
    if (!isReplicaId(replicaId)) {
      throw new TypeError('replicaId must be 1 to 64 printable ASCII characters');
    }
    this.replicaId = replicaId;
    this.#onReject = options.onReject;
  }

  /**
   * Creates a replica from a state produced by {@link FugueText.save} or {@link FugueText.toJSON}.
   * @throws {FugueTextError} `invalid-state` if the state is malformed.
   */
  static load(state: Uint8Array | TextStateJSON, options: FugueTextOptions = {}): FugueText {
    const snapshot = decodeState(state);
    const text = new FugueText(options);
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
    return versionVector(this.#version);
  }

  /** The current text. Cached between changes. */
  toString(): string {
    return (this.#cachedString ??= this.#list.toString());
  }

  /**
   * Inserts `text` before position `index` and returns the operation to send to other replicas,
   * or `undefined` if `text` is empty.
   * @throws {RangeError} if `index` is not an integer in `[0, length]`, or if this replica has
   *   used up its counters (2^52 - 1 of them).
   */
  insert(index: number, text: string): InsertOperation | undefined {
    checkPosition(index, this.length, 'index');
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (text.length === 0) return undefined;
    const counter = this.#versionOf(this.replicaId);
    if (counter + text.length > MAX_COUNTER) throw new RangeError('counter overflow');
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
   * @throws {RangeError} if the range is not within `[0, length]`, or if this replica has used up
   *   its counters.
   */
  delete(index: number, length: number): DeleteOperation | undefined {
    checkPosition(index, this.length, 'index');
    checkPosition(length, this.length - index, 'length');
    if (length === 0) return undefined;
    const counter = this.#versionOf(this.replicaId);
    if (counter + 1 > MAX_COUNTER) throw new RangeError('counter overflow');
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
   *
   * Only `op` itself can make this method throw, and then the document is unchanged. A buffered
   * operation that this call unblocks and that turns out to be invalid is discarded and reported
   * to {@link FugueTextOptions.onReject} instead.
   * @throws {FugueTextError} `invalid-operation` if `op` is malformed, inconsistent with this
   *   document, or differs from a buffered operation with the same ID; `replica-conflict` if it
   *   claims this replica's ID, or depends on operations of this replica's ID that were not
   *   produced here.
   */
  apply(op: Operation): ApplyResult {
    assertOperation(op);
    const applied = this.#versionOf(op.replica);
    if (op.counter + operationSpan(op) <= applied) return 'duplicate';
    if (op.counter < applied) {
      invalidOperation(`operation ${opName(op)} overlaps applied operations`);
    }
    if (op.replica === this.replicaId) {
      throw new FugueTextError(
        'replica-conflict',
        `received an unknown operation from this replica's own ID ${op.replica}`,
      );
    }
    if (
      Object.hasOwn(op.deps, this.replicaId) &&
      (op.deps[this.replicaId] as number) > this.#versionOf(this.replicaId)
    ) {
      throw new FugueTextError(
        'replica-conflict',
        `operation ${opName(op)} depends on operations of this replica's own ID that it never produced`,
      );
    }
    const buffered = this.#pending.get(op.replica)?.get(op.counter);
    if (buffered !== undefined) {
      if (sameOperation(buffered, op)) return 'duplicate';
      invalidOperation(`operation ${opName(op)} differs from the buffered operation with that ID`);
    }
    const readiness = this.#readiness(op); // `ready` or a blocker: `op` is not applied yet
    if (typeof readiness === 'object') {
      this.#buffer(op, readiness);
      return 'buffered';
    }
    const changes = this.#listeners.size > 0 ? [] : undefined;
    this.#integrate(op, changes); // throws, without side effects, if `op` is inconsistent
    this.#wake(op.replica);
    this.#settle(changes);
    return 'applied';
  }

  /** Encodes the full state (without buffered operations) in the compact binary format. */
  save(): Uint8Array<ArrayBuffer> {
    return encodeSnapshot(this.#snapshot());
  }

  /** The full state as readable JSON, for debugging; `JSON.stringify(text)` uses it. */
  toJSON(): TextStateJSON {
    return snapshotToJSON(this.#snapshot());
  }

  /**
   * Merges a state produced by another replica's {@link FugueText.save} or
   * {@link FugueText.toJSON} into this one (state-based synchronisation). Merging is commutative,
   * associative and idempotent. Buffered operations that the merge makes redundant are dropped,
   * and those it unblocks are applied (see {@link FugueTextOptions.onReject}).
   * @throws {FugueTextError} `invalid-state` if the state is malformed or inconsistent with this
   *   document, `replica-conflict` if it contains operations of this replica's ID unknown here.
   *   The document is unchanged when the merge throws.
   */
  merge(state: Uint8Array | TextStateJSON): void {
    const snapshot = decodeState(state);
    const other = FugueList.fromSnapshot(snapshot.records);
    const runs = other.runsInCausalOrder();
    if ((snapshot.version.get(this.replicaId) ?? 0) > this.#versionOf(this.replicaId)) {
      throw new FugueTextError(
        'replica-conflict',
        `the state contains operations of this replica's own ID ${this.replicaId} unknown here`,
      );
    }
    const before = new Map(this.#version);
    const known = (replica: string): number => before.get(replica) ?? 0;
    this.#list.checkMergeable(runs, known); // a rejected state leaves this document untouched
    const changes = this.#listeners.size > 0 ? [] : undefined;
    this.#list.mergeFrom(other, runs, known, changes);
    let grew = false;
    for (const [replica, version] of snapshot.version) {
      if (version > known(replica)) {
        this.#version.set(replica, version);
        this.#dirty.add(replica);
        grew = true;
      }
    }
    this.#cachedString = undefined;
    if (grew) this.#recheckPending();
    this.#settle(changes);
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
    // Anchors often arrive over the network, so check them at runtime.
    if (!isAnchor(anchor)) throw new TypeError('malformed anchor');
    switch (anchor.type) {
      case 'start':
        return 0;
      case 'end':
        return this.length;
      case 'element': {
        const { id, bias } = anchor;
        const elem = this.#list.resolve(id);
        if (elem === undefined) return undefined;
        const { index, visible } = this.#list.locate(elem);
        return bias === 'left' && visible ? index + 1 : index;
      }
    }
  }

  /**
   * Registers a listener for changes to the visible text, both local and remote. Listeners run
   * synchronously after the document has been updated; an exception thrown by a listener is
   * reported asynchronously and does not affect the document or other listeners.
   *
   * Events are delivered in the order the changes happened. If a listener edits the document,
   * the resulting event is queued and delivered once the current event has reached every
   * listener, so applying events in the order received always reproduces the text. A listener may
   * therefore observe, through {@link FugueText.toString}, changes whose events it has not
   * received yet.
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

  #versionOf(replica: string): number {
    return this.#version.get(replica) ?? 0;
  }

  #takeDeps(): VersionVector {
    if (this.#dirty.size === 0) return NO_DEPS;
    const deps: [string, number][] = [];
    // Never contains this replica: its own version only grows through local edits.
    for (const replica of this.#dirty) deps.push([replica, this.#versionOf(replica)]);
    this.#dirty.clear();
    return versionVector(deps);
  }

  /** Whether `op` can be applied now, and if not, the first condition it waits for. */
  #readiness(op: Operation): Readiness {
    const applied = this.#versionOf(op.replica);
    if (applied > op.counter) {
      return op.counter + operationSpan(op) <= applied ? 'duplicate' : 'overlap';
    }
    if (applied < op.counter) return { replica: op.replica, counter: op.counter };
    const deps = op.deps;
    // for...in avoids allocating entry arrays on this hot path; skip inherited keys.
    for (const replica in deps) {
      if (!Object.hasOwn(deps, replica)) continue;
      const version = deps[replica] as number;
      if (this.#versionOf(replica) < version) return { replica, counter: version };
    }
    return 'ready';
  }

  #buffer(op: Operation, blocker: Blocker): void {
    let queue = this.#pending.get(op.replica);
    if (queue === undefined) {
      queue = new Map();
      this.#pending.set(op.replica, queue);
    }
    queue.set(op.counter, op);
    this.#pendingCount++;
    this.#await(op, blocker);
  }

  #await(op: Operation, blocker: Blocker): void {
    let heap = this.#waiting.get(blocker.replica);
    if (heap === undefined) {
      heap = new MinHeap();
      this.#waiting.set(blocker.replica, heap);
    }
    heap.push(blocker.counter, op);
  }

  #unbuffer(op: Operation): void {
    const queue = this.#pending.get(op.replica) as Map<number, Operation>;
    queue.delete(op.counter);
    if (queue.size === 0) this.#pending.delete(op.replica);
    this.#pendingCount--;
  }

  /** Moves the operations waiting for `replica`'s current version to the woken list. */
  #wake(replica: string): void {
    const heap = this.#waiting.get(replica);
    if (heap === undefined) return;
    const version = this.#versionOf(replica);
    while (heap.peekPriority() <= version) this.#woken.push(heap.pop() as Operation);
    if (heap.size === 0) this.#waiting.delete(replica);
  }

  /** After a merge: drops redundant buffered operations and re-files the others. */
  #recheckPending(): void {
    this.#waiting.clear();
    this.#woken.length = 0;
    for (const queue of this.#pending.values()) {
      for (const op of queue.values()) this.#woken.push(op);
    }
  }

  /**
   * Applies the woken buffered operations that are ready, and the ones those unblock in turn,
   * then delivers change events and reports discarded operations. Never throws for a buffered
   * operation: an invalid one is dropped and reported.
   */
  #settle(changes: TextChange[] | undefined): void {
    let rejected: { error: FugueTextError; op: Operation }[] | undefined;
    for (let op = this.#woken.pop(); op !== undefined; op = this.#woken.pop()) {
      if (this.#pending.get(op.replica)?.get(op.counter) !== op) continue; // dropped meanwhile
      const readiness = this.#readiness(op);
      if (typeof readiness === 'object') {
        this.#await(op, readiness);
        continue;
      }
      this.#unbuffer(op);
      if (readiness === 'duplicate') continue; // covered by a merged state
      try {
        if (readiness === 'overlap') {
          invalidOperation(`operation ${opName(op)} overlaps applied operations`);
        }
        this.#integrate(op, changes);
      } catch (error) {
        if (!(error instanceof FugueTextError)) throw error;
        (rejected ??= []).push({ error, op });
        continue;
      }
      this.#wake(op.replica);
    }
    if (changes !== undefined) this.#emit('remote', changes);
    if (rejected !== undefined) {
      for (const { error, op } of rejected) this.#reject(error, op);
    }
  }

  /**
   * Applies an operation whose dependencies are satisfied. Validates it first, so a rejected
   * operation leaves the document unchanged.
   */
  #integrate(op: Operation, changes: TextChange[] | undefined): void {
    const list = this.#list;
    if (op.type === 'insert') {
      const parent = op.parent === null ? list.rootElem : list.resolve(op.parent);
      if (parent === undefined) {
        invalidOperation(
          `insert ${opName(op)} has an unknown parent ${op.parent?.replica ?? ''}:${String(op.parent?.counter)}`,
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
          invalidOperation(`delete ${opName(op)} targets unknown elements`);
        }
      }
      for (const target of op.targets) list.deleteRange(target, changes);
    }
    this.#version.set(op.replica, op.counter + operationSpan(op));
    this.#dirty.add(op.replica);
    this.#cachedString = undefined;
  }

  #reject(error: FugueTextError, op: Operation): void {
    if (this.#onReject === undefined) return;
    try {
      this.#onReject(error, op);
    } catch (failure) {
      reportError(failure);
    }
  }

  /**
   * Delivers an event to every listener. An event raised while another is being delivered (a
   * listener edited the document) waits until the current one has reached every listener.
   */
  #emit(origin: 'local' | 'remote', changes: readonly TextChange[]): void {
    if (changes.length === 0) return;
    this.#events.push({ origin, changes });
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      // The array iterator also visits events that listeners append while this loop runs.
      for (const event of this.#events) {
        for (const listener of [...this.#listeners]) {
          try {
            listener(event);
          } catch (error) {
            reportError(error);
          }
        }
      }
    } finally {
      this.#events.length = 0;
      this.#dispatching = false;
    }
  }
}

/**
 * Merges two encoded states into one without keeping a live document around. The result is the
 * same whichever order the arguments are given in.
 * @throws {FugueTextError} `invalid-state` if either state is malformed or they are inconsistent.
 */
export function mergeStates(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const text = FugueText.load(a);
  text.merge(b);
  return text.save();
}

/** @internal Gives tests and benchmarks access to the underlying structure. */
export function internalList(text: FugueText): FugueList {
  return listOf(text);
}

function decodeState(state: Uint8Array | TextStateJSON): DocumentSnapshot {
  return state instanceof Uint8Array ? decodeSnapshot(state) : snapshotFromJSON(state);
}

function opName(op: Operation): string {
  return `${op.replica}:${String(op.counter)}`;
}

function checkPosition(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} ${String(value)} is out of range [0, ${String(max)}]`);
  }
}
