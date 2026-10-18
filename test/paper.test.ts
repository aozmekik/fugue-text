/**
 * Scenarios from Weidner & Kleppmann, "The Art of the Fugue: Minimizing Interleaving in
 * Collaborative Text Editing" (arXiv:2305.00583), plus property tests of the non-interleaving
 * guarantees they motivate.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FugueText } from '../src/index.js';
import type { Operation } from '../src/index.js';
import { checkInvariants, codeUnits, numRuns } from './support/helpers.js';

/** Types `word` one keystroke (one operation) at a time, left to right, starting at `index`. */
function typeForward(text: FugueText, index: number, word: string): Operation[] {
  return codeUnits(word).map((ch, i) => text.insert(index + i, ch) as Operation);
}

/** Types `word` right to left: every keystroke is inserted at `index`, before the previous one. */
function typeBackward(text: FugueText, index: number, word: string): Operation[] {
  return codeUnits(word)
    .reverse()
    .map((ch) => text.insert(index, ch) as Operation);
}

function deliver(ops: readonly Operation[], ...targets: FugueText[]): void {
  for (const target of targets) for (const op of ops) target.apply(op);
}

describe('paper scenarios', () => {
  it('Figure 1: concurrent appends to a shopping list do not interleave', () => {
    const alice = new FugueText({ replicaId: 'alice' });
    const bob = new FugueText({ replicaId: 'bob' });
    deliver([alice.insert(0, 'milk') as Operation], bob);
    const fromAlice = typeForward(alice, 4, '\neggs');
    const fromBob = typeForward(bob, 4, '\nbread');
    deliver(fromAlice, bob);
    deliver(fromBob, alice);
    expect(alice.toString()).toBe('milk\neggs\nbread');
    expect(bob.toString()).toBe(alice.toString());
  });

  it('Figure 2: prepending items (backward insertion) does not interleave', () => {
    const alice = new FugueText({ replicaId: 'alice' });
    const bob = new FugueText({ replicaId: 'bob' });
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
    const r1 = new FugueText({ replicaId: 'r1' });
    const r2 = new FugueText({ replicaId: 'r2' });
    const r3 = new FugueText({ replicaId: 'r3' });
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
    const [p1, p2, p3] = ['p1', 'p2', 'p3'].map((replicaId) => new FugueText({ replicaId })) as [
      FugueText,
      FugueText,
      FugueText,
    ];
    const z = new FugueText({ replicaId: 'z' });
    const m = new FugueText({ replicaId: 'm' });
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

function buildBase(steps: readonly BaseStep[]): FugueText {
  const base = new FugueText({ replicaId: 'base' });
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

/** Each typist types from its own alphabet, so every character reveals who typed it. */
const ALPHABETS = ['ABC', 'DEF', 'GHI'] as const;

const typists = fc.integer({ min: 2, max: 3 }).chain((count) =>
  fc.record({
    words: fc.tuple(
      ...ALPHABETS.slice(0, count).map((alphabet) =>
        fc.string({ minLength: 1, maxLength: 6, unit: fc.constantFrom(...codeUnits(alphabet)) }),
      ),
    ),
    // Replica IDs in random order relative to the alphabets.
    ids: fc.uniqueArray(fc.stringMatching(/^[a-z]{1,3}$/), {
      minLength: count,
      maxLength: count,
    }),
  }),
);

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
          typists,
          (steps, position, { words, ids }) => {
            const base = buildBase(steps);
            const state = base.save();
            const replicas = ids.map((replicaId) => FugueText.load(state, { replicaId }));
            const index = Math.floor(position * (base.length + 1));
            const ops = replicas.map((replica, i) => type(replica, index, words[i] as string));
            for (const replica of replicas) for (const batch of ops) deliver(batch, replica);
            const result = (replicas[0] as FugueText).toString();
            for (const replica of replicas) {
              expect(replica.toString()).toBe(result);
              checkInvariants(replica);
            }
            // The base text is untouched around the insertion point...
            const before = base.toString().slice(0, index);
            const after = base.toString().slice(index);
            expect(result.startsWith(before) && result.endsWith(after)).toBe(true);
            const middle = result.slice(before.length, result.length - after.length);
            expect(middle.length).toBe(words.join('').length);
            // ...and each typist's characters form one block that spells that typist's word.
            words.forEach((word, i) => {
              const alphabet = ALPHABETS[i] as string;
              const positions = codeUnits(middle).flatMap((ch, j) =>
                alphabet.includes(ch) ? [j] : [],
              );
              const first = positions[0] as number;
              expect(positions).toEqual(Array.from({ length: word.length }, (_, k) => first + k));
              expect(middle.slice(first, first + word.length)).toBe(word);
            });
          },
        ),
        { numRuns },
      );
    });
  }
});
