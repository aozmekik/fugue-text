/**
 * Codecs for full document states: a compact binary format and a readable JSON format. Both
 * serialise the same {@link DocumentSnapshot}: the version vector plus the document's elements in
 * order, grouped into maximal runs (run-length encoding). Deleted elements are kept as tombstone
 * runs without their text.
 *
 * Binary layout (all integers are LEB128 varints unless noted):
 *
 * ```text
 * "FUGS" (4 bytes)  formatVersion=1
 * replicaCount  replicaId*            (length-prefixed strings, first-appearance order)
 * version*                            (one entry per replica, same order)
 * recordCount
 * record* = head counterDelta length [parentHead [parentCounter]]
 *   head         = replicaIndex * 4 + continuation * 2 + deleted
 *   counterDelta = zigzag(counter - end of the previous record of the same replica)
 *   parentHead   = 0 for the root, else (parentReplicaIndex + 1) * 2 + (side === 'left')
 *                  (omitted for continuations: parent is (replica, counter - 1), side right)
 * text                                (WTF-8, length-prefixed: all visible text, in order)
 * ```
 *
 * The encoding is deterministic: replicas holding the same state produce identical bytes.
 */

import { invalidState } from '../errors.js';
import { isCounter, isReplicaId } from '../internal/ids.js';
import type { SnapshotRecord } from '../internal/list.js';
import type { ElementId, Side, StateRecordJSON, TextStateJSON } from '../types.js';
import { ByteReader, ByteWriter, type FailFn } from './bytes.js';

/** A document state: version vector plus elements in document order. */
export interface DocumentSnapshot {
  /** Next expected counter per replica (only replicas with a non-zero entry). */
  readonly version: ReadonlyMap<string, number>;
  /** Maximal runs in document order. */
  readonly records: readonly SnapshotRecord[];
}

const MAGIC = [0x46, 0x55, 0x47, 0x53]; // "FUGS"
const FORMAT_VERSION = 1;

/** Serialises a snapshot to the binary state format. */
export function encodeSnapshot(snapshot: DocumentSnapshot): Uint8Array {
  const replicas = replicaTable(snapshot);
  const indexOf = new Map(replicas.map((replica, index) => [replica, index]));
  const out = new ByteWriter();
  for (const byte of MAGIC) out.byte(byte);
  out.uint(FORMAT_VERSION);
  out.uint(replicas.length);
  for (const replica of replicas) out.string(replica);
  for (const replica of replicas) out.uint(snapshot.version.get(replica) ?? 0);
  out.uint(snapshot.records.length);
  const expected = new Array<number>(replicas.length).fill(0);
  const text: string[] = [];
  for (const record of snapshot.records) {
    const index = indexOf.get(record.replica) as number;
    const continuation = isContinuation(record);
    out.uint(index * 4 + (continuation ? 2 : 0) + (record.text === undefined ? 1 : 0));
    out.int(record.counter - (expected[index] as number));
    out.uint(record.length);
    expected[index] = record.counter + record.length;
    if (!continuation) {
      const parent = record.parent;
      if (parent === null) {
        out.uint(0);
      } else {
        out.uint(
          ((indexOf.get(parent.replica) as number) + 1) * 2 + (record.side === 'left' ? 1 : 0),
        );
        out.uint(parent.counter);
      }
    }
    if (record.text !== undefined) text.push(record.text);
  }
  out.string(text.join(''));
  return out.finish();
}

/** Parses the binary state format. Throws `invalid-state` on malformed input. */
export function decodeSnapshot(bytes: Uint8Array): DocumentSnapshot {
  const fail: FailFn = (message) => invalidState(`binary state: ${message}`);
  const input = new ByteReader(bytes, fail);
  for (const byte of MAGIC) if (input.byte() !== byte) fail('not a fugue-text state');
  const formatVersion = input.uint();
  if (formatVersion !== FORMAT_VERSION) fail(`unsupported format version ${String(formatVersion)}`);
  const replicaCount = input.uint();
  const replicas: string[] = [];
  for (let i = 0; i < replicaCount; i++) {
    const replica = input.string();
    if (!isReplicaId(replica)) fail('malformed replica ID');
    replicas.push(replica);
  }
  if (new Set(replicas).size !== replicas.length) fail('duplicate replica ID');
  const version = new Map<string, number>();
  for (const replica of replicas) version.set(replica, input.uint());
  const recordCount = input.uint();
  if (recordCount > bytes.length) fail('record count exceeds input size');
  const replicaAt = (index: number): string =>
    replicas[index] ?? fail('replica index out of range');
  const expected = new Array<number>(replicaCount).fill(0);
  const shapes: {
    replica: string;
    counter: number;
    length: number;
    deleted: boolean;
    parent: ElementId | null;
    side: Side;
  }[] = [];
  let visibleLength = 0;
  for (let i = 0; i < recordCount; i++) {
    const head = input.uint();
    const index = Math.floor(head / 4);
    const replica = replicaAt(index);
    const counter = (expected[index] as number) + input.int();
    const length = input.uint();
    if (counter < 0 || length === 0) fail('malformed record');
    expected[index] = counter + length;
    const deleted = head % 2 === 1;
    let parent: ElementId | null;
    let side: Side;
    if ((head & 2) !== 0) {
      parent = { replica, counter: counter - 1 };
      side = 'right';
    } else {
      const parentHead = input.uint();
      if (parentHead === 0) {
        parent = null;
        side = 'right';
      } else {
        parent = { replica: replicaAt(Math.floor(parentHead / 2) - 1), counter: input.uint() };
        side = parentHead % 2 === 1 ? 'left' : 'right';
      }
    }
    if (!deleted) visibleLength += length;
    shapes.push({ replica, counter, length, deleted, parent, side });
  }
  const text = input.string();
  input.end();
  if (text.length !== visibleLength) fail('text length does not match the records');
  const records: SnapshotRecord[] = [];
  let position = 0;
  for (const shape of shapes) {
    let content: string | undefined;
    if (!shape.deleted) {
      content = text.slice(position, position + shape.length);
      position += shape.length;
    }
    records.push({
      replica: shape.replica,
      counter: shape.counter,
      length: shape.length,
      text: content,
      parent: shape.parent,
      side: shape.side,
    });
  }
  return checkSnapshot({ version, records });
}

/** Converts a snapshot to the JSON state format. */
export function snapshotToJSON(snapshot: DocumentSnapshot): TextStateJSON {
  const version = Object.fromEntries(
    replicaTable(snapshot).map((replica) => [replica, snapshot.version.get(replica) ?? 0]),
  );
  const records = snapshot.records.map((record): StateRecordJSON => {
    const base = {
      replica: record.replica,
      counter: record.counter,
      length: record.length,
      parent: record.parent === null ? null : { ...record.parent },
      side: record.side,
    };
    return record.text === undefined ? base : { ...base, text: record.text };
  });
  return { format: 'fugue-text/state', formatVersion: 1, version, records };
}

/** Parses (and validates) the JSON state format. Throws `invalid-state` on malformed input. */
export function snapshotFromJSON(value: unknown): DocumentSnapshot {
  const fail: FailFn = (message) => invalidState(`JSON state: ${message}`);
  if (!isObject(value) || value['format'] !== 'fugue-text/state') fail('not a fugue-text state');
  if (value['formatVersion'] !== FORMAT_VERSION) fail('unsupported format version');
  const versionValue = value['version'];
  if (!isObject(versionValue)) fail('missing version');
  const version = new Map<string, number>();
  for (const [replica, counter] of Object.entries(versionValue)) {
    if (!isReplicaId(replica) || !isCounter(counter)) fail('malformed version entry');
    version.set(replica, counter);
  }
  const recordsValue = value['records'];
  if (!Array.isArray(recordsValue)) fail('missing records');
  const records = (recordsValue as unknown[]).map((item): SnapshotRecord => {
    if (!isObject(item)) fail('malformed record');
    const { replica, counter, length, parent, side, text } = item;
    if (!isReplicaId(replica) || !isCounter(counter) || !isCounter(length) || length === 0) {
      fail('malformed record');
    }
    if (side !== 'left' && side !== 'right') fail('malformed side');
    let parentId: ElementId | null = null;
    if (parent !== null) {
      if (!isObject(parent) || !isReplicaId(parent['replica']) || !isCounter(parent['counter'])) {
        fail('malformed parent');
      }
      parentId = { replica: parent['replica'], counter: parent['counter'] };
    }
    if (text !== undefined && (typeof text !== 'string' || text.length !== length)) {
      fail('text length does not match the record');
    }
    return { replica, counter, length, text, parent: parentId, side };
  });
  return checkSnapshot({ version, records });
}

/** Checks invariants shared by both formats: every element is covered by the version vector. */
function checkSnapshot(snapshot: DocumentSnapshot): DocumentSnapshot {
  for (const [replica, counter] of snapshot.version) {
    if (counter === 0) invalidState(`zero version entry for ${replica}`);
  }
  const covered = (replica: string, counter: number): boolean =>
    counter < (snapshot.version.get(replica) ?? 0);
  for (const record of snapshot.records) {
    if (!covered(record.replica, record.counter + record.length - 1)) {
      invalidState(`elements of ${record.replica} beyond its version`);
    }
    if (record.parent !== null && !covered(record.parent.replica, record.parent.counter)) {
      invalidState(
        `parent ${record.parent.replica}:${String(record.parent.counter)} beyond its version`,
      );
    }
    if (record.parent === null && record.side !== 'right') invalidState('a left child of the root');
  }
  return snapshot;
}

/** Replicas in deterministic order: by first appearance in the records, then the rest sorted. */
function replicaTable(snapshot: DocumentSnapshot): string[] {
  const seen = new Set<string>();
  for (const record of snapshot.records) seen.add(record.replica);
  for (const record of snapshot.records)
    if (record.parent !== null) seen.add(record.parent.replica);
  const rest = [...snapshot.version.keys()].filter((replica) => !seen.has(replica)).sort();
  return [...seen, ...rest];
}

function isContinuation(record: SnapshotRecord): boolean {
  return (
    record.side === 'right' &&
    record.parent?.replica === record.replica &&
    record.parent.counter === record.counter - 1
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
