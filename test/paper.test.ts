/**
 * Scenarios from Weidner & Kleppmann, "The Art of the Fugue: Minimizing Interleaving in
 * Collaborative Text Editing" (arXiv:2305.00583), plus property tests of the non-interleaving
 * guarantees they motivate.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Text } from '../src/index.js';
import type { Operation } from '../src/index.js';
import { checkInvariants, codeUnits, numRuns } from './support/helpers.js';

/** Types `word` one keystroke (one operation) at a time, left to right, starting at `index`. */
function typeForward(text: Text, index: number, word: string): Operation[] {
  return codeUnits(word).map((ch, i) => text.insert(index + i, ch) as Operation);
}

/** Types `word` right to left: every keystroke is inserted at `index`, before the previous one. */
function typeBackward(text: Text, index: number, word: string): Operation[] {
  return codeUnits(word)
    .reverse()
    .map((ch) => text.insert(index, ch) as Operation);
}

function deliver(ops: readonly Operation[], ...targets: Text[]): void {
  for (const target of targets) for (const op of ops) target.apply(op);
}

describe('paper scenarios', () => {
  it('Figure 1: concurrent appends to a shopping list do not interleave', () => {
    const alice = new Text({ replicaId: 'alice' });
    const bob = new Text({ replicaId: 'bob' });
    deliver([alice.insert(0, 'milk') as Operation], bob);
    const fromAlice = typeForward(alice, 4, '\neggs');
    const fromBob = typeForward(bob, 4, '\nbread');
    deliver(fromAlice, bob);
    deliver(fromBob, alice);
    expect(alice.toString()).toBe('milk\neggs\nbread');
    expect(bob.toString()).toBe(alice.toString());
  });

  it('Figure 2: prepending items (backward insertion) does not interleave', () => {
    const alice = new Text({ replicaId: 'alice' });
    const bob = new Text({ replicaId: 'bob' });
    const fromAlice = [
      ...typeForward(alice, 0, 'apples\n'),
      ...typeForward(alice, 0, 'bananas\n'),
      ...typeForward(alice, 0, 'Fruit:\n'),
    ];
    const fromBob = [
      ...typeForward(bob, 0, 'bread\n'),
      ...typeForward(bob, 0, 'cake\n'),
      ...typeForward(bob, 0, 'Bakery:\n'),
    ];
    deliver(fromAlice, bob);
    deliver(fromBob, alice);
    expect(alice.toString()).toBe('Fruit:\nbananas\napples\nBakery:\ncake\nbread\n');
    expect(bob.toString()).toBe(alice.toString());
  });

  it('Figure 6: three concurrent inserts at the start, then AXBC', () => {
    const r1 = new Text({ replicaId: 'r1' });
    const r2 = new Text({ replicaId: 'r2' });
    const r3 = new Text({ replicaId: 'r3' });
    const a = r1.insert(0, 'A') as Operation;
    const b = r2.insert(0, 'B') as Operation;
    const c = r3.insert(0, 'C') as Operation;
    deliver([a, b], r3);
    expect(r3.toString()).toBe('ABC'); // same-side siblings are ordered by ID
    deliver([c], r1);
    expect(r1.toString()).toBe('AC');
    const x = r1.insert(1, 'X') as Operation;
    expect(r1.toString()).toBe('AXC');
    deliver([b], r1);
    expect(r1.toString()).toBe('AXBC');
    deliver([a, c, x], r2);
    deliver([x], r3);
    expect(r2.pendingCount + r3.pendingCount).toBe(0);
    expect(r2.toString()).toBe('AXBC');
    expect(r3.toString()).toBe('AXBC');
  });

  it('Figure 7: X and Y share a left origin; Fugue orders them by ID', () => {
    // A, B, C are concurrent inserts at the start by p1 < p2 < p3. Replica `z` has seen A and C
    // and types X after A; replica `m` has seen A and B and types Y after A. X and Y are both
    // right children of A, so Fugue sorts them by replica ID: m < z puts Y first. FugueMax
    // would put X first because X's right origin (C) lies further right than Y's (B); this
    // library implements Fugue, not FugueMax (see docs/adr/0004-fugue-not-fuguemax.md).
    const [p1, p2, p3] = ['p1', 'p2', 'p3'].map((replicaId) => new Text({ replicaId })) as [
      Text,
      Text,
      Text,
    ];
    const z = new Text({ replicaId: 'z' });
    const m = new Text({ replicaId: 'm' });
    const a = p1.insert(0, 'A') as Operation;
    const b = p2.insert(0, 'B') as Operation;
    const c = p3.insert(0, 'C') as Operation;
    deliver([a, c], z);
    deliver([a, b], m);
    const x = z.insert(1, 'X') as Operation;
    const y = m.insert(1, 'Y') as Operation;
    expect(z.toString()).toBe('AXC');
    expect(m.toString()).toBe('AYB');
    deliver([b, y], z);
    deliver([c, x], m);
    expect(z.toString()).toBe('AYXBC');
    expect(m.toString()).toBe('AYXBC');
  });
});

/** A random starting document shared by all replicas, including tombstones. */
const baseDocument = fc.array(
  fc.record({
    insert: fc.boolean(),
    position: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
    text: fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c') }),
  }),
  { maxLength: 30 },
);

interface BaseStep {
  readonly insert: boolean;
  readonly position: number;
  readonly text: string;
}

function buildBase(steps: readonly BaseStep[]): Text {
  const base = new Text({ replicaId: 'base' });
  for (const step of steps) {
    if (step.insert || base.length === 0) {
      base.insert(Math.floor(step.position * (base.length + 1)), step.text);
    } else {
      const index = Math.floor(step.position * base.length);
      base.delete(index, Math.min(step.text.length, base.length - index));
    }
  }
  return base;
}

const word = fc.string({ minLength: 1, maxLength: 6, unit: fc.constantFrom('X', 'Y', 'Z') });

describe('non-interleaving properties', () => {
  for (const [name, type] of [
    ['forward', typeForward],
    ['backward', typeBackward],
  ] as const) {
    it(`concurrent ${name} typing at the same position stays contiguous`, () => {
      fc.assert(
        fc.property(
          baseDocument,
          fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
          fc.array(word, { minLength: 2, maxLength: 3 }),
          (steps, position, words) => {
            const base = buildBase(steps);
            const state = base.save();
            const replicas = words.map((_, i) =>
              Text.load(state, { replicaId: `typist${String(i)}` }),
            );
            const index = Math.floor(position * (base.length + 1));
            const ops = replicas.map((replica, i) => type(replica, index, words[i] as string));
            for (const replica of replicas) for (const batch of ops) deliver(batch, replica);
            const result = (replicas[0] as Text).toString();
            for (const replica of replicas) {
              expect(replica.toString()).toBe(result);
              checkInvariants(replica);
            }
            // The words appear as contiguous blocks, in some order, at `index`.
            const before = base.toString().slice(0, index);
            const after = base.toString().slice(index);
            expect(result.startsWith(before) && result.endsWith(after)).toBe(true);
            let middle = result.slice(before.length, result.length - after.length);
            const remaining = [...words];
            while (middle.length > 0) {
              const next = remaining.findIndex((w) => middle.startsWith(w));
              expect(next).toBeGreaterThanOrEqual(0);
              middle = middle.slice((remaining[next] as string).length);
              remaining.splice(next, 1);
            }
            expect(remaining).toEqual([]);
          },
        ),
        { numRuns },
      );
    });
  }
});
