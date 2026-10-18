import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeOperation, encodeOperation, FugueText, FugueTextError } from '../src/index.js';
import type { Operation, TextStateJSON } from '../src/index.js';
import { MAX_COUNTER } from '../src/internal/guards.js';
import { compareIds } from '../src/internal/ids.js';
import { internalList } from '../src/text.js';
import { checkInvariants } from './support/helpers.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof FugueTextError) return error.code;
    throw error;
  }
  return undefined;
}

const op = (value: Operation | undefined): Operation => {
  if (value === undefined) throw new Error('expected an operation');
  return value;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('edge cases', () => {
  it('extends a remote run that has a concurrent right sibling with a greater ID', () => {
    const c = new FugueText({ replicaId: 'c' });
    const d = new FugueText({ replicaId: 'd' });
    const base = op(c.insert(0, 'xy'));
    d.apply(base);
    const sibling = op(d.insert(2, 'Q')); // d > c, so Q sorts after c's continuation
    const extension = op(c.insert(2, 'z')); // c has not seen Q: extends its own run
    c.apply(sibling);
    d.apply(extension);
    expect(c.toString()).toBe('xyzQ');
    expect(d.toString()).toBe('xyzQ');
    expect(d.save()).toEqual(c.save());
    checkInvariants(c);
    checkInvariants(d);
  });

  it('places a concurrent right child before a run continuation with a greater ID', () => {
    const c = new FugueText({ replicaId: 'c' });
    const b = new FugueText({ replicaId: 'b' });
    b.apply(op(c.insert(0, 'x')));
    const fromB = op(b.insert(1, 'B')); // right child of c:0, b < c
    const continuation = op(c.insert(1, 'y')); // c extends its run with c:1
    c.apply(fromB);
    b.apply(continuation);
    expect(c.toString()).toBe('xBy');
    expect(b.toString()).toBe('xBy');
    checkInvariants(c);
    checkInvariants(b);
  });

  it('rejects a state whose runs have no causal order', () => {
    // A valid tree (a0 -> b1 -> a1 -> b0, each a right child) whose IDs imply a causal cycle:
    // b0 hangs off a1, a1 off b1, and b1 was created after b0.
    const forged: TextStateJSON = {
      format: 'fugue-text/state',
      formatVersion: 1,
      version: { a: 2, b: 2 },
      records: [
        { replica: 'a', counter: 0, length: 1, parent: null, side: 'right', text: '1' },
        {
          replica: 'b',
          counter: 1,
          length: 1,
          parent: { replica: 'a', counter: 0 },
          side: 'right',
          text: '2',
        },
        {
          replica: 'a',
          counter: 1,
          length: 1,
          parent: { replica: 'b', counter: 1 },
          side: 'right',
          text: '3',
        },
        {
          replica: 'b',
          counter: 0,
          length: 1,
          parent: { replica: 'a', counter: 1 },
          side: 'right',
          text: '4',
        },
      ],
    };
    expect(() => FugueText.load(forged)).toThrow(FugueTextError);
    expect(() => {
      new FugueText().merge(forged);
    }).toThrow(/causal order/);
  });

  it('accepts non-canonical but valid states and keeps segments maximal', () => {
    const split: TextStateJSON = {
      format: 'fugue-text/state',
      formatVersion: 1,
      version: { a: 4 },
      records: [
        { replica: 'a', counter: 0, length: 2, parent: null, side: 'right', text: 'ab' },
        {
          replica: 'a',
          counter: 2,
          length: 2,
          parent: { replica: 'a', counter: 1 },
          side: 'right',
          text: 'cd',
        },
      ],
    };
    const text = FugueText.load(split);
    expect(text.toString()).toBe('abcd');
    expect(text.toJSON().records).toHaveLength(1);
    checkInvariants(text);
  });

  it('guards against counter overflow', () => {
    const state: TextStateJSON = {
      format: 'fugue-text/state',
      formatVersion: 1,
      version: { a: MAX_COUNTER },
      records: [],
    };
    const text = FugueText.load(state, { replicaId: 'a' });
    expect(() => text.insert(0, 'x')).toThrow(RangeError);
    expect(() => text.delete(0, 0)).not.toThrow();
    const full = FugueText.load({ ...state, version: { a: MAX_COUNTER - 1 } }, { replicaId: 'a' });
    full.insert(0, 'x');
    expect(() => full.delete(0, 1)).toThrow(RangeError);
    expect(codeOf(() => FugueText.load({ ...state, version: { a: MAX_COUNTER + 1 } }))).toBe(
      'invalid-state',
    );
  });

  it('round-trips states and operations at the largest counters', () => {
    // Zigzag-encoded counter deltas must stay below the varint limit of 2^53 - 1.
    const json: TextStateJSON = {
      format: 'fugue-text/state',
      formatVersion: 1,
      version: { z: MAX_COUNTER, a: 3 },
      records: [
        // Typed before z:0 much later, so the next record's delta is -(2^52 - 1).
        {
          replica: 'z',
          counter: MAX_COUNTER - 2,
          length: 2,
          parent: { replica: 'z', counter: 0 },
          side: 'left',
          text: 'qr',
        },
        { replica: 'z', counter: 0, length: 1, parent: null, side: 'right', text: 'p' },
        {
          replica: 'a',
          counter: 0,
          length: 3,
          parent: { replica: 'z', counter: 0 },
          side: 'right',
        },
      ],
    };
    const text = FugueText.load(json, { replicaId: 'reader' });
    const bytes = text.save();
    const copy = FugueText.load(bytes, { replicaId: 'copy' });
    expect(copy.toString()).toBe('qrp');
    expect(copy.save()).toEqual(bytes);
    expect(copy.toJSON()).toEqual(json);
    const insert = op(copy.insert(1, '!'));
    expect(decodeOperation(encodeOperation(insert))).toEqual(insert);
    const remote: Operation = {
      type: 'insert',
      replica: 'z',
      counter: MAX_COUNTER - 1,
      deps: {},
      parent: null,
      side: 'right',
      text: 'x',
    };
    expect(codeOf(() => decodeOperation(encodeOperation({ ...remote, text: 'xy' })))).toBe(
      'invalid-operation',
    );
    expect(decodeOperation(encodeOperation(remote))).toEqual(remote);
  });

  it('orders element IDs by replica ID, then counter', () => {
    expect(compareIds('a', 9, 'b', 0)).toBeLessThan(0);
    expect(compareIds('ab', 0, 'a', 9)).toBeGreaterThan(0);
    expect(compareIds('a', 2, 'a', 5)).toBeLessThan(0);
    expect(compareIds('a', 5, 'a', 5)).toBe(0);
  });

  it('needs crypto.getRandomValues only for random replica IDs', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => new FugueText()).toThrow(/replicaId/);
    expect(new FugueText({ replicaId: 'fixed' }).replicaId).toBe('fixed');
  });

  it('exposes structure statistics for benchmarks', () => {
    const text = new FugueText({ replicaId: 'a' });
    for (const ch of 'hello') text.insert(text.length, ch);
    text.delete(1, 1);
    const list = internalList(text);
    expect(list.runCount).toBe(1);
    expect(list.segmentCount).toBe(3);
  });

  it('handles very deep trees without recursion', () => {
    // Prepending one character at a time builds a chain of left children 20 000 deep.
    const a = new FugueText({ replicaId: 'a' });
    const ops: Operation[] = [];
    for (let i = 0; i < 20_000; i++) ops.push(op(a.insert(0, String.fromCharCode(97 + (i % 26)))));
    const b = new FugueText({ replicaId: 'b' });
    for (const operation of ops) b.apply(operation);
    expect(b.toString()).toBe(a.toString());
    const copy = FugueText.load(a.save());
    copy.merge(b.save());
    expect(copy.toString()).toBe(a.toString());
    checkInvariants(copy);
  });
});
