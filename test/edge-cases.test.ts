import { afterEach, describe, expect, it, vi } from 'vitest';
import { FugueTextError, Text } from '../src/index.js';
import type { Operation, TextStateJSON } from '../src/index.js';
import { internalList } from '../src/text.js';
import { checkInvariants } from './support/helpers.js';

const op = (value: Operation | undefined): Operation => {
  if (value === undefined) throw new Error('expected an operation');
  return value;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('edge cases', () => {
  it('extends a remote run that has a concurrent right sibling with a greater ID', () => {
    const c = new Text({ replicaId: 'c' });
    const d = new Text({ replicaId: 'd' });
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
    expect(() => Text.load(forged)).toThrow(FugueTextError);
    expect(() => {
      new Text().merge(forged);
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
    const text = Text.load(split);
    expect(text.toString()).toBe('abcd');
    expect(text.toJSON().records).toHaveLength(1);
    checkInvariants(text);
  });

  it('guards against counter overflow', () => {
    const state: TextStateJSON = {
      format: 'fugue-text/state',
      formatVersion: 1,
      version: { a: Number.MAX_SAFE_INTEGER },
      records: [],
    };
    const text = Text.load(state, { replicaId: 'a' });
    expect(() => text.insert(0, 'xy')).toThrow(RangeError);
    const full = Text.load(
      { ...state, version: { a: Number.MAX_SAFE_INTEGER - 1 } },
      { replicaId: 'a' },
    );
    full.insert(0, 'x');
    expect(() => full.delete(0, 1)).toThrow(RangeError);
  });

  it('needs crypto.getRandomValues only for random replica IDs', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => new Text()).toThrow(/replicaId/);
    expect(new Text({ replicaId: 'fixed' }).replicaId).toBe('fixed');
  });

  it('exposes structure statistics for benchmarks', () => {
    const text = new Text({ replicaId: 'a' });
    for (const ch of 'hello') text.insert(text.length, ch);
    text.delete(1, 1);
    const list = internalList(text);
    expect(list.runCount).toBe(1);
    expect(list.segmentCount).toBe(3);
  });

  it('handles very deep trees without recursion', () => {
    // Prepending one character at a time builds a chain of left children 20 000 deep.
    const a = new Text({ replicaId: 'a' });
    const ops: Operation[] = [];
    for (let i = 0; i < 20_000; i++) ops.push(op(a.insert(0, String.fromCharCode(97 + (i % 26)))));
    const b = new Text({ replicaId: 'b' });
    for (const operation of ops) b.apply(operation);
    expect(b.toString()).toBe(a.toString());
    const copy = Text.load(a.save());
    copy.merge(b.save());
    expect(copy.toString()).toBe(a.toString());
    checkInvariants(copy);
  });
});
