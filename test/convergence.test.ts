/**
 * Strong eventual consistency: N replicas make random concurrent edits while operations are
 * delivered in random order, duplicated, round-tripped through both codecs, and mixed with
 * state-based merges. Once everything is delivered, all replicas must hold identical state.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeOperation, encodeOperation, Text } from '../src/index.js';
import type { Operation, TextStateJSON } from '../src/index.js';
import { checkInvariants, mirror, numRuns } from './support/helpers.js';

const fraction = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });
const content = fc.string({
  minLength: 1,
  maxLength: 5,
  unit: fc.constantFrom('a', 'b', 'c', ' ', '\n', 'é', '\ud83d', '\ude00'),
});

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
  | {
      readonly kind: 'deliver';
      readonly replica: number;
      readonly pick: number;
      readonly keep: boolean;
      readonly codec: 'object' | 'json' | 'binary';
    }
  | { readonly kind: 'merge'; readonly from: number; readonly to: number; readonly json: boolean };

const action = (replicas: number): fc.Arbitrary<Action> => {
  const replica = fc.nat({ max: replicas - 1 });
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('insert' as const),
        replica,
        at: fraction,
        text: content,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('delete' as const),
        replica,
        at: fraction,
        length: fc.integer({ min: 1, max: 4 }),
      }),
    },
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant('deliver' as const),
        replica,
        pick: fraction,
        keep: fc.boolean(),
        codec: fc.constantFrom('object' as const, 'json' as const, 'binary' as const),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('merge' as const),
        from: replica,
        to: replica,
        json: fc.boolean(),
      }),
    },
  );
};

const scenario = fc.integer({ min: 2, max: 5 }).chain((replicas) =>
  fc.record({
    ids: fc.uniqueArray(fc.stringMatching(/^[a-c]{1,3}$/), {
      minLength: replicas,
      maxLength: replicas,
    }),
    actions: fc.array(action(replicas), { maxLength: 120, size: 'max' }),
    shuffle: fc.integer(),
  }),
);

function transmit(op: Operation, codec: 'object' | 'json' | 'binary'): Operation {
  if (codec === 'json') return JSON.parse(JSON.stringify(op)) as Operation;
  if (codec === 'binary') return decodeOperation(encodeOperation(op));
  return op;
}

/** Deterministic Fisher-Yates shuffle driven by a seed from fast-check. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('convergence', () => {
  it('all replicas converge under random concurrency, reordering and duplication', () => {
    fc.assert(
      fc.property(scenario, ({ ids, actions, shuffle }) => {
        const replicas = ids.map((replicaId) => new Text({ replicaId }));
        const mirrors = replicas.map(mirror);
        const inboxes: Operation[][] = replicas.map(() => []);
        const broadcast = (from: number, op: Operation | undefined): void => {
          if (op === undefined) return;
          inboxes.forEach((inbox, i) => {
            if (i !== from) inbox.push(op);
          });
        };
        for (const step of actions) {
          switch (step.kind) {
            case 'insert': {
              const text = replicas[step.replica] as Text;
              broadcast(
                step.replica,
                text.insert(Math.floor(step.at * (text.length + 1)), step.text),
              );
              break;
            }
            case 'delete': {
              const text = replicas[step.replica] as Text;
              if (text.length === 0) break;
              const index = Math.floor(step.at * text.length);
              broadcast(
                step.replica,
                text.delete(index, Math.min(step.length, text.length - index)),
              );
              break;
            }
            case 'deliver': {
              const inbox = inboxes[step.replica] as Operation[];
              if (inbox.length === 0) break;
              const index = Math.floor(step.pick * inbox.length);
              const op = inbox[index] as Operation;
              if (!step.keep) inbox.splice(index, 1);
              (replicas[step.replica] as Text).apply(transmit(op, step.codec));
              break;
            }
            case 'merge': {
              if (step.from === step.to) break;
              const source = replicas[step.from] as Text;
              const state = step.json
                ? (JSON.parse(JSON.stringify(source)) as TextStateJSON)
                : source.save();
              (replicas[step.to] as Text).merge(state);
              break;
            }
          }
          replicas.forEach((text, i) => {
            expect(mirrors[i]?.value).toBe(text.toString());
          });
        }
        replicas.forEach((text, i) => {
          for (const op of shuffled(inboxes[i] as Operation[], shuffle)) text.apply(op);
        });
        const expected = (replicas[0] as Text).toString();
        const state = (replicas[0] as Text).save();
        for (const [i, text] of replicas.entries()) {
          checkInvariants(text);
          expect(text.pendingCount).toBe(0);
          expect(text.toString()).toBe(expected);
          expect(mirrors[i]?.value).toBe(expected);
          expect(text.version).toEqual((replicas[0] as Text).version);
          // Deterministic encoding: converged replicas serialise to identical bytes.
          expect(text.save()).toEqual(state);
        }
      }),
      { numRuns },
    );
  });
});
