import { expect } from 'vitest';
import { internalList, type FugueText } from '../../src/text.js';
import type { ChangeEvent, ElementId, InsertOperation, Operation } from '../../src/types.js';
import type { RefInsert } from './reference.js';

/** Asserts every internal invariant of a replica. */
export function checkInvariants(text: FugueText): void {
  internalList(text).checkInvariants();
}

/** Expands a run-length encoded insert into the per-character inserts of the paper. */
export function expandInsert(op: InsertOperation): RefInsert[] {
  const inserts: RefInsert[] = [];
  for (let i = 0; i < op.text.length; i++) {
    inserts.push({
      id: { replica: op.replica, counter: op.counter + i },
      value: op.text.charAt(i),
      parent: i === 0 ? op.parent : { replica: op.replica, counter: op.counter + i - 1 },
      side: i === 0 ? op.side : 'right',
    });
  }
  return inserts;
}

/** The individual element IDs a delete targets. */
export function expandTargets(op: Operation): ElementId[] {
  if (op.type !== 'delete') return [];
  return op.targets.flatMap((target) =>
    Array.from({ length: target.length }, (_, i) => ({
      replica: target.replica,
      counter: target.counter + i,
    })),
  );
}

/** Applies a change event to a mirror string. */
export function applyEvent(mirror: string, event: ChangeEvent): string {
  let result = mirror;
  for (const change of event.changes) {
    if (change.type === 'insert') {
      result = result.slice(0, change.index) + change.text + result.slice(change.index);
    } else {
      expect(change.index + change.length).toBeLessThanOrEqual(result.length);
      result = result.slice(0, change.index) + result.slice(change.index + change.length);
    }
  }
  return result;
}

/** Keeps a string in sync with a replica purely through its change events. */
export function mirror(text: FugueText): { readonly value: string } {
  const state = { value: text.toString() };
  text.subscribe((event) => {
    state.value = applyEvent(state.value, event);
  });
  return state;
}

/** The UTF-16 code units of a string, one string each (what the library calls characters). */
export function codeUnits(value: string): string[] {
  return Array.from({ length: value.length }, (_, i) => value.charAt(i));
}

/** Number of property-test runs; raise with FC_NUM_RUNS for longer local soak runs. */
export const numRuns = Number(process.env['FC_NUM_RUNS'] ?? 200);
