/**
 * Validation and binary encoding of {@link Operation}s.
 *
 * Operations are plain objects, so `JSON.stringify` / `JSON.parse` is their JSON codec. The
 * binary codec below is more compact. Binary layout (integers are LEB128 varints):
 *
 * ```text
 * tag (1 byte: 0x11 insert, 0x12 delete)
 * replicaCount replicaId*      (the sender first, then other replicas by first use)
 * counter
 * depCount (replicaIndex counter)*
 * insert: parentHead [parentCounter] text
 *         parentHead = 0 for the root, else (replicaIndex + 1) * 2 + (side === 'left')
 * delete: targetCount (replicaIndex counter length)*
 * ```
 * @module
 */

import { invalidOperation } from './errors.js';
import { ByteReader, ByteWriter, type FailFn } from './encoding/bytes.js';
import { isCounter, isReplicaId } from './internal/ids.js';
import type {
  DeleteOperation,
  ElementId,
  ElementIdRange,
  InsertOperation,
  Operation,
  Side,
} from './types.js';

const INSERT_TAG = 0x11;
const DELETE_TAG = 0x12;

/**
 * Checks that `value` is a structurally valid {@link Operation} (for example one that was just
 * parsed from JSON) and throws a `FugueTextError` with code `invalid-operation` otherwise.
 * Whether the operation is consistent with a particular document is checked when it is applied.
 */
export function assertOperation(value: unknown): asserts value is Operation {
  if (!isObject(value)) invalidOperation('operation must be an object');
  const { type, replica, counter, deps } = value;
  if (type !== 'insert' && type !== 'delete') invalidOperation('unknown operation type');
  if (!isReplicaId(replica)) invalidOperation('malformed replica ID');
  if (!isCounter(counter)) invalidOperation('malformed counter');
  if (!isObject(deps)) invalidOperation('malformed deps');
  for (const [dep, version] of Object.entries(deps)) {
    if (!isReplicaId(dep) || !isCounter(version)) invalidOperation('malformed deps entry');
  }
  if (type === 'insert') {
    const { parent, side, text } = value;
    if (side !== 'left' && side !== 'right') invalidOperation('malformed side');
    if (parent === null) {
      if (side !== 'right') invalidOperation('the root only has right children');
    } else if (!isElementId(parent)) {
      invalidOperation('malformed parent');
    }
    if (typeof text !== 'string' || text.length === 0) invalidOperation('empty or missing text');
    if (!Number.isSafeInteger(counter + text.length)) invalidOperation('counter overflow');
  } else {
    const { targets } = value;
    if (!Array.isArray(targets) || targets.length === 0) invalidOperation('missing targets');
    for (const target of targets as unknown[]) {
      if (!isElementIdRange(target)) invalidOperation('malformed target');
    }
  }
}

/** Number of counter values an operation consumes. */
export function operationSpan(op: Operation): number {
  return op.type === 'insert' ? op.text.length : 1;
}

/** Encodes an operation in the compact binary format. */
export function encodeOperation(op: Operation): Uint8Array {
  const replicas = [op.replica];
  const indexOf = new Map([[op.replica, 0]]);
  const ref = (replica: string): number => {
    let index = indexOf.get(replica);
    if (index === undefined) {
      index = replicas.length;
      replicas.push(replica);
      indexOf.set(replica, index);
    }
    return index;
  };
  const depEntries = Object.entries(op.deps).map(([replica, version]) => [ref(replica), version]);
  const body = new ByteWriter();
  body.uint(op.counter);
  body.uint(depEntries.length);
  for (const [index, version] of depEntries) {
    body.uint(index as number);
    body.uint(version as number);
  }
  if (op.type === 'insert') {
    if (op.parent === null) {
      body.uint(0);
    } else {
      body.uint((ref(op.parent.replica) + 1) * 2 + (op.side === 'left' ? 1 : 0));
      body.uint(op.parent.counter);
    }
    body.string(op.text);
  } else {
    body.uint(op.targets.length);
    for (const target of op.targets) {
      body.uint(ref(target.replica));
      body.uint(target.counter);
      body.uint(target.length);
    }
  }
  const out = new ByteWriter();
  out.byte(op.type === 'insert' ? INSERT_TAG : DELETE_TAG);
  out.uint(replicas.length);
  for (const replica of replicas) out.string(replica);
  out.bytes(body.finish());
  return out.finish();
}

/**
 * Decodes an operation produced by {@link encodeOperation}. Throws a `FugueTextError` with code
 * `invalid-operation` on malformed input.
 */
export function decodeOperation(bytes: Uint8Array): Operation {
  const fail: FailFn = (message) => invalidOperation(`binary operation: ${message}`);
  const input = new ByteReader(bytes, fail);
  const tag = input.byte();
  if (tag !== INSERT_TAG && tag !== DELETE_TAG) fail('unknown tag');
  const replicaCount = input.uint();
  if (replicaCount === 0 || replicaCount > bytes.length) fail('malformed replica table');
  const replicas: string[] = [];
  for (let i = 0; i < replicaCount; i++) replicas.push(input.string());
  const replicaAt = (index: number): string =>
    replicas[index] ?? fail('replica index out of range');
  const replica = replicaAt(0);
  const counter = input.uint();
  const depCount = input.uint();
  const deps: [string, number][] = [];
  for (let i = 0; i < depCount; i++) deps.push([replicaAt(input.uint()), input.uint()]);
  let op: Operation;
  if (tag === INSERT_TAG) {
    const parentHead = input.uint();
    let parent: ElementId | null = null;
    let side: Side = 'right';
    if (parentHead !== 0) {
      parent = { replica: replicaAt(Math.floor(parentHead / 2) - 1), counter: input.uint() };
      side = parentHead % 2 === 1 ? 'left' : 'right';
    }
    const text = input.string();
    op = {
      type: 'insert',
      replica,
      counter,
      deps: Object.fromEntries(deps),
      parent,
      side,
      text,
    } satisfies InsertOperation;
  } else {
    const targetCount = input.uint();
    if (targetCount > bytes.length) fail('target count exceeds input size');
    const targets: ElementIdRange[] = [];
    for (let i = 0; i < targetCount; i++) {
      targets.push({
        replica: replicaAt(input.uint()),
        counter: input.uint(),
        length: input.uint(),
      });
    }
    op = {
      type: 'delete',
      replica,
      counter,
      deps: Object.fromEntries(deps),
      targets,
    } satisfies DeleteOperation;
  }
  input.end();
  assertOperation(op);
  return op;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isElementId(value: unknown): value is ElementId {
  return isObject(value) && isReplicaId(value['replica']) && isCounter(value['counter']);
}

function isElementIdRange(value: unknown): value is ElementIdRange {
  if (!isElementId(value)) return false;
  const length = (value as unknown as Record<string, unknown>)['length'];
  return isCounter(length) && length > 0 && Number.isSafeInteger(value.counter + length);
}
