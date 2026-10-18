import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SortedIndex } from '../src/internal/sorted-index.js';
import { numRuns } from './support/helpers.js';

interface Item {
  readonly key: number;
}

const keyOf = (item: Item): number => item.key;

type Command =
  | { readonly kind: 'insert'; readonly key: number }
  | { readonly kind: 'remove'; readonly pick: number }
  | { readonly kind: 'query'; readonly key: number };

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('insert' as const), key: fc.nat(300) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove' as const), pick: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('query' as const),
      key: fc.integer({ min: -5, max: 305 }),
    }),
  },
);

/** The answers a sorted array gives, for comparison. */
function expectQueries(index: SortedIndex<Item>, model: readonly Item[], key: number): void {
  const atMost = model.filter((item) => item.key <= key);
  expect(index.floor(key)).toBe(atMost[atMost.length - 1]);
  expect(index.ceiling(key)).toBe(model.find((item) => item.key >= key));
  expect(index.after(key)).toBe(model.find((item) => item.key > key));
  expect(index.get(key)).toBe(model.find((item) => item.key === key));
}

describe('SortedIndex', () => {
  it('behaves like a sorted array (model-based)', () => {
    fc.assert(
      fc.property(
        fc.array(command, { maxLength: 300 }),
        fc.constantFrom(2, 3, 4, 64),
        fc.constantFrom(2, 3, 32),
        (commands, leafCapacity, branchCapacity) => {
          const index = new SortedIndex(keyOf, { leafCapacity, branchCapacity });
          let model: Item[] = [];
          for (const step of commands) {
            if (step.kind === 'insert') {
              const item = { key: step.key };
              const fresh = !model.some((other) => other.key === step.key);
              expect(index.insert(item)).toBe(fresh);
              if (fresh) model = [...model, item].sort((x, y) => x.key - y.key);
            } else if (step.kind === 'remove') {
              if (model.length === 0) continue;
              const item = model[step.pick % model.length] as Item;
              index.remove(item);
              model = model.filter((other) => other !== item);
            } else {
              expectQueries(index, model, step.key);
            }
            index.checkInvariants();
            expect(index.size).toBe(model.length);
          }
          expect([...index]).toEqual(model);
        },
      ),
      { numRuns },
    );
  });

  it('handles appends in key order and removal of everything', () => {
    const index = new SortedIndex(keyOf, { leafCapacity: 4, branchCapacity: 3 });
    const items = Array.from({ length: 500 }, (_, i) => ({ key: i * 2 }));
    for (const item of items) index.insert(item);
    index.checkInvariants();
    expect(index.floor(501)?.key).toBe(500);
    expect(index.ceiling(501)?.key).toBe(502);
    expect(index.floor(-1)).toBeUndefined();
    expect(index.after(998)).toBeUndefined();
    for (const item of items.slice().reverse()) index.remove(item);
    index.checkInvariants();
    expect(index.size).toBe(0);
    expect([...index]).toEqual([]);
    index.insert({ key: 7 });
    expect(index.get(7)?.key).toBe(7);
  });

  it('refuses to remove a missing key', () => {
    const index = new SortedIndex(keyOf);
    index.insert({ key: 1 });
    expect(() => {
      index.remove({ key: 2 });
    }).toThrow(/not in index/);
  });
});
