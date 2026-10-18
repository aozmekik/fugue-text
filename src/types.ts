/**
 * Public data types shared by the {@link FugueText} API, the operation format and the codecs.
 *
 * Every type here is a plain, JSON-serialisable value: you can `JSON.stringify` an operation, an
 * anchor or a version vector and send it over any transport.
 * @module
 */

/**
 * Identifies one replica (one editing session). Must be 1 to 64 printable ASCII characters
 * (`!` to `~`). Two live instances must never share a replica ID.
 */
export type ReplicaId = string;

/**
 * The globally unique identity of one element (one UTF-16 code unit) of a {@link FugueText}.
 *
 * Every replica numbers what it creates with a private counter, so `(replica, counter)` is unique.
 */
export interface ElementId {
  /** The replica that inserted the element. */
  readonly replica: ReplicaId;
  /** The value of that replica's counter when the element was inserted. */
  readonly counter: number;
}

/** A contiguous range of element IDs from one replica: `counter` up to `counter + length - 1`. */
export interface ElementIdRange {
  /** The replica that inserted the elements. */
  readonly replica: ReplicaId;
  /** Counter of the first element in the range. */
  readonly counter: number;
  /** Number of elements in the range (at least 1). */
  readonly length: number;
}

/** Which side of its parent a node hangs off in the Fugue tree. */
export type Side = 'left' | 'right';

/**
 * Per-replica progress: for each replica, the next counter value this document expects from it.
 * Equivalently, the number of counter values of that replica it has already applied.
 */
export type VersionVector = Readonly<Record<ReplicaId, number>>;

/**
 * Inserts a run of characters as a chain in the Fugue tree.
 *
 * The first character becomes the `side` child of `parent` (or a right child of the root when
 * `parent` is `null`); each further character is the right child of the previous one. The run
 * uses the counters `counter` to `counter + text.length - 1` of `replica`.
 */
export interface InsertOperation {
  /** Discriminant. */
  readonly type: 'insert';
  /** The replica that created the operation. */
  readonly replica: ReplicaId;
  /** Counter of the first inserted character. */
  readonly counter: number;
  /**
   * Causal dependencies that changed since the sender's previous operation: for each listed
   * replica, the version this operation's sender had already applied.
   */
  readonly deps: VersionVector;
  /** The parent element of the first character, or `null` for the root. */
  readonly parent: ElementId | null;
  /** Which side of `parent` the first character is attached to. */
  readonly side: Side;
  /** The inserted characters (non-empty). */
  readonly text: string;
}

/**
 * Marks elements as deleted (tombstones). Consumes one counter value of the sender so that later
 * operations can depend on it causally.
 */
export interface DeleteOperation {
  /** Discriminant. */
  readonly type: 'delete';
  /** The replica that created the operation. */
  readonly replica: ReplicaId;
  /** The counter value this operation consumed. */
  readonly counter: number;
  /** Causal dependencies; see {@link InsertOperation.deps}. */
  readonly deps: VersionVector;
  /** The deleted elements (non-empty). */
  readonly targets: readonly ElementIdRange[];
}

/** An operation produced by a local edit, to be delivered to every other replica. */
export type Operation = InsertOperation | DeleteOperation;

/**
 * What {@link FugueText.apply} did with an operation:
 * - `applied`: it was integrated (and possibly unblocked buffered operations);
 * - `buffered`: a causal dependency is missing, so it waits in the delivery buffer;
 * - `duplicate`: it was already applied or is already buffered, so it was ignored.
 */
export type ApplyResult = 'applied' | 'buffered' | 'duplicate';

/**
 * Which neighbouring character an {@link Anchor} sticks to.
 *
 * - `left`: the anchor stays immediately after the character on its left. Text inserted at the
 *   anchor's position by anyone ends up after the anchor.
 * - `right`: the anchor stays immediately before the character on its right. Text inserted at the
 *   anchor's position ends up before the anchor.
 */
export type AnchorBias = 'left' | 'right';

/**
 * A position between characters that survives concurrent edits, such as a caret or a selection
 * endpoint. Create one with {@link FugueText.createAnchor} and turn it back into an index with
 * {@link FugueText.resolveAnchor}. Anchors are plain JSON and can be shared with other replicas.
 */
export type Anchor =
  | {
      /** The start of the document; always resolves to 0. */
      readonly type: 'start';
    }
  | {
      /** The end of the document; always resolves to the current length. */
      readonly type: 'end';
    }
  | {
      /** Attached to one character. */
      readonly type: 'element';
      /** The character the anchor is attached to. */
      readonly id: ElementId;
      /** Whether the anchor sits after (`left`) or before (`right`) that character. */
      readonly bias: AnchorBias;
    };

/** One step of a {@link ChangeEvent}, expressed in UTF-16 code units. */
export type TextChange =
  | {
      /** Discriminant. */
      readonly type: 'insert';
      /** Index at which `text` was inserted. */
      readonly index: number;
      /** The inserted characters. */
      readonly text: string;
    }
  | {
      /** Discriminant. */
      readonly type: 'delete';
      /** Index of the first deleted character. */
      readonly index: number;
      /** Number of deleted characters. */
      readonly length: number;
    };

/**
 * Describes how the visible text changed. Applying `changes` in order (each index refers to the
 * text after the previous change) to the old string yields the new string.
 */
export interface ChangeEvent {
  /** `local` for edits made through this instance, `remote` for applied operations and merges. */
  readonly origin: 'local' | 'remote';
  /** The individual insertions and deletions, in application order. */
  readonly changes: readonly TextChange[];
}

/** Receives {@link ChangeEvent}s; see {@link FugueText.subscribe}. */
export type ChangeListener = (event: ChangeEvent) => void;

/** Options for creating or loading a {@link FugueText}. */
export interface FugueTextOptions {
  /**
   * This replica's ID. Defaults to a random 12-character ID. Reuse an ID only when loading a state
   * that contains every operation that ID has ever produced.
   */
  readonly replicaId?: ReplicaId;
}

/** One maximal run of the debug JSON state; see {@link TextStateJSON}. */
export interface StateRecordJSON {
  /** Replica that inserted the run. */
  readonly replica: ReplicaId;
  /** Counter of the run's first element. */
  readonly counter: number;
  /** Number of elements in the run. */
  readonly length: number;
  /** Parent of the run's first element (`null` for the root). */
  readonly parent: ElementId | null;
  /** Side of the run's first element relative to `parent`. */
  readonly side: Side;
  /** The run's characters, or absent when the run consists of deleted elements. */
  readonly text?: string;
}

/**
 * Human-readable form of a document state, produced by {@link FugueText.toJSON}. Records are listed in
 * document order and include deleted elements (without their text).
 */
export interface TextStateJSON {
  /** Format marker. */
  readonly format: 'fugue-text/state';
  /** Format version. */
  readonly formatVersion: 1;
  /** The state's version vector. */
  readonly version: VersionVector;
  /** The elements in document order, grouped into runs. */
  readonly records: readonly StateRecordJSON[];
}
