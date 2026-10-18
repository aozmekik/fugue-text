/**
 * Runtime type guards for values that may come from untrusted sources (the network, storage),
 * where the static types cannot be relied on.
 */

import type { Anchor, ElementId, ElementIdRange } from '../types.js';

const REPLICA_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;

/**
 * The largest counter, length or version-vector entry: 2^52 - 1. The binary state format stores
 * counters as zigzag-encoded differences, which stay below 2^53 (and so exact as JavaScript
 * numbers and within the varint limit) only while every counter is below 2^52.
 */
export const MAX_COUNTER = 2 ** 52 - 1;

/** Whether `value` is a non-array object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a well-formed replica ID (1 to 64 printable ASCII characters). */
export function isReplicaId(value: unknown): value is string {
  return typeof value === 'string' && REPLICA_ID_PATTERN.test(value);
}

/** Whether `value` is an integer in `[0, MAX_COUNTER]`. */
export function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNTER;
}

/** Whether `value` is a well-formed {@link ElementId}. */
export function isElementId(value: unknown): value is ElementId {
  return isObject(value) && isReplicaId(value['replica']) && isCounter(value['counter']);
}

/** Whether `value` is a well-formed, non-empty {@link ElementIdRange}. */
export function isElementIdRange(value: unknown): value is ElementIdRange {
  if (!isElementId(value)) return false;
  const length = (value as unknown as Record<string, unknown>)['length'];
  return isCounter(length) && length > 0 && value.counter + length <= MAX_COUNTER;
}

/** Whether `value` is a well-formed {@link Anchor}. */
export function isAnchor(value: unknown): value is Anchor {
  if (!isObject(value)) return false;
  switch (value['type']) {
    case 'start':
    case 'end':
      return true;
    case 'element':
      return isElementId(value['id']) && (value['bias'] === 'left' || value['bias'] === 'right');
    default:
      return false;
  }
}
