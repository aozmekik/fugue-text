import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Rope, type RopeItem } from '../src/internal/rope.js';
import { numRuns } from './support/helpers.js';

class Item implements RopeItem {
  leaf: unknown = undefined;
  constructor(
    public weight: number,
    public readonly name: number,
  ) {}
}

const weigh = (item: Item): number => item.weight;

type Command =
  | { readonly kind: 'insertAfter'; readonly at: number; readonly weight: number }
  | { readonly kind: 'insertBefore'; readonly at: number; readonly weight: number }
  | { readonly kind: 'adjust'; readonly at: number; readonly weight: number }
  | { readonly kind: 'remove'; readonly at: number };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant('insertAfter' as const),
    at: fc.nat(),
    weight: fc.nat({ max: 5 }),
  }),
  fc.record({
    kind: fc.constant('insertBefore' as const),
    at: fc.nat(),
    weight: fc.nat({ max: 5 }),
  }),
  fc.record({ kind: fc.constant('adjust' as const), at: fc.nat(), weight: fc.nat({ max: 5 }) }),
  fc.record({ kind: fc.constant('remove' as const), at: fc.nat() }),
);

/** Checks the rope against a plain array model. */
function expectSameAs(rope: Rope<Item>, model: Item[]): void {
  rope.checkInvariants();
  expect([...rope]).toEqual(model);
  expect(rope.size).toBe(model.length);
  let total = 0;
  for (let i = 0; i < model.length; i++) {
    const item = model[i] as Item;
    expect(rope.indexOf(item)).toBe(total);
    expect(rope.next(item)).toBe(model[i + 1]);
    expect(rope.prev(item)).toBe(model[i - 1]);
    for (let offset = 0; offset < item.weight; offset++) {
      expect(rope.find(total + offset)).toEqual({ item, offset });
    }
    total += item.weight;
  }
  expect(rope.weight).toBe(total);
  expect(rope.find(total)).toBeUndefined();
  expect(rope.find(-1)).toBeUndefined();
  expect(rope.first()).toBe(model[0]);
}

describe('Rope', () => {
  it('starts empty', () => {
    const rope = new Rope(weigh);
    expect(rope.size).toBe(0);
    expect(rope.weight).toBe(0);
    expect(rope.first()).toBeUndefined();
    expect(rope.find(0)).toBeUndefined();
    rope.checkInvariants();
  });

  it('builds from an array', () => {
    const items = Array.from({ length: 1000 }, (_, i) => new Item(i % 3, i));
    const rope = Rope.from(items, weigh, { leafCapacity: 4, branchCapacity: 3 });
    expectSameAs(rope, items);
    expectSameAs(Rope.from([], weigh), []);
  });

  it('rejects items that are not in a rope', () => {
    const rope = new Rope(weigh);
    expect(() => rope.indexOf(new Item(1, 0))).toThrow(/not in a rope/);
  });

  it('matches an array model under random edits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 2, max: 4 }),
        fc.array(command, { maxLength: 300, size: 'max' }),
        (leafCapacity, branchCapacity, commands) => {
          const rope = new Rope(weigh, { leafCapacity, branchCapacity });
          const model: Item[] = [];
          let name = 0;
          for (const cmd of commands) {
            const at = model.length === 0 ? 0 : cmd.at % model.length;
            const ref = model[at];
            switch (cmd.kind) {
              case 'insertAfter': {
                const item = new Item(cmd.weight, name++);
                if (ref === undefined || cmd.at % 4 === 0) {
                  rope.insertAfter(undefined, item);
                  model.unshift(item);
                } else {
                  rope.insertAfter(ref, item);
                  model.splice(at + 1, 0, item);
                }
                break;
              }
              case 'insertBefore': {
                if (ref === undefined) break;
                const item = new Item(cmd.weight, name++);
                rope.insertBefore(ref, item);
                model.splice(at, 0, item);
                break;
              }
              case 'adjust': {
                if (ref === undefined) break;
                const delta = cmd.weight - ref.weight;
                ref.weight = cmd.weight;
                rope.adjust(ref, delta);
                break;
              }
              case 'remove': {
                if (ref === undefined) break;
                rope.remove(ref);
                model.splice(at, 1);
                break;
              }
            }
            rope.checkInvariants();
          }
          expectSameAs(rope, model);
        },
      ),
      { numRuns },
    );
  });
});
