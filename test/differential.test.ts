/**
 * Differential testing against the naive reference implementation of the paper's Algorithm 1.
 * Every replica has a twin running the reference; both receive the same edits and the same
 * operations in the same (causal) order. The optimised implementation must make exactly the same
 * tree decisions (parent and side of every character) and show exactly the same text.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FugueText } from '../src/index.js';
import type { Operation } from '../src/index.js';
import {
  checkInvariants,
  codeUnits,
  expandInsert,
  expandTargets,
  numRuns,
} from './support/helpers.js';
import { ReferenceFugue } from './support/reference.js';

const fraction = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

type Action =
  | {
      readonly kind: 'insert';
      readonly replica: number;
      readonly at: number;
      readonly text: string;
    }
  | {
      readonly kind: 'delete';
      readonly replica: number;
      readonly at: number;
      readonly length: number;
    }
  | { readonly kind: 'deliver'; readonly replica: number; readonly pick: number };

const scenario = fc.integer({ min: 1, max: 4 }).chain((count) => {
  const replica = fc.nat({ max: count - 1 });
  const action: fc.Arbitrary<Action> = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant('insert' as const),
        replica,
        at: fraction,
        text: fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c', 'd') }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('delete' as const),
        replica,
        at: fraction,
        length: fc.integer({ min: 1, max: 3 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({ kind: fc.constant('deliver' as const), replica, pick: fraction }),
    },
  );
  return fc.record({
    ids: fc.uniqueArray(fc.stringMatching(/^[a-d]{1,2}$/), { minLength: count, maxLength: count }),
    actions: fc.array(action, { maxLength: 150, size: 'max' }),
  });
});

interface Twin {
  readonly real: FugueText;
  readonly reference: ReferenceFugue;
  readonly inbox: Operation[];
}

function isReady(text: FugueText, op: Operation): boolean {
  const version = text.version;
  if ((version[op.replica] ?? 0) !== op.counter) return false;
  return Object.entries(op.deps).every(([replica, counter]) => (version[replica] ?? 0) >= counter);
}

function applyToReference(reference: ReferenceFugue, op: Operation): void {
  if (op.type === 'insert') for (const insert of expandInsert(op)) reference.insertRemote(insert);
  else for (const id of expandTargets(op)) reference.delete(id);
}

describe('differential: optimised implementation vs the paper algorithm', () => {
  it('makes identical tree decisions and shows identical text', () => {
    fc.assert(
      fc.property(scenario, ({ ids, actions }) => {
        const twins: Twin[] = ids.map((replicaId) => ({
          real: new FugueText({ replicaId }),
          reference: new ReferenceFugue(),
          inbox: [],
        }));
        const broadcast = (from: number, op: Operation): void => {
          twins.forEach((twin, i) => {
            if (i !== from) twin.inbox.push(op);
          });
        };
        for (const step of actions) {
          const twin = twins[step.replica] as Twin;
          const { real, reference } = twin;
          if (step.kind === 'insert') {
            const index = Math.floor(step.at * (real.length + 1));
            const op = real.insert(index, step.text);
            if (op === undefined) throw new Error('unexpected empty insert');
            // The paper inserts one character at a time; each must land exactly where ours did.
            const expected = codeUnits(step.text).map((value, i) =>
              reference.insertLocal(index + i, value, {
                replica: op.replica,
                counter: op.counter + i,
              }),
            );
            expect(expandInsert(op)).toEqual(expected);
            broadcast(step.replica, op);
          } else if (step.kind === 'delete') {
            if (real.length === 0) continue;
            const index = Math.floor(step.at * real.length);
            const length = Math.min(step.length, real.length - index);
            const expected = reference.visibleIds().slice(index, index + length);
            const op = real.delete(index, length);
            if (op === undefined) throw new Error('unexpected empty delete');
            expect(expandTargets(op)).toEqual(expected);
            for (const id of expected) reference.delete(id);
            broadcast(step.replica, op);
          } else {
            const ready = twin.inbox.filter((op) => isReady(real, op));
            if (ready.length === 0) continue;
            const op = ready[Math.floor(step.pick * ready.length)] as Operation;
            twin.inbox.splice(twin.inbox.indexOf(op), 1);
            expect(real.apply(op)).toBe('applied');
            applyToReference(reference, op);
          }
          expect(real.toString()).toBe(reference.toString());
        }
        for (const twin of twins) {
          checkInvariants(twin.real);
          // Anchors map each visible character's ID to its index exactly as the reference does.
          for (const [index, id] of twin.reference.visibleIds().entries()) {
            expect(twin.real.resolveAnchor({ type: 'element', id, bias: 'right' })).toBe(index);
          }
        }
      }),
      { numRuns },
    );
  });
});
