import { describe, expect, it } from 'vitest';
import { FugueTextError, Text } from '../src/index.js';
import type { InsertOperation, Operation } from '../src/index.js';
import { checkInvariants } from './support/helpers.js';

const op = (value: Operation | undefined): Operation => {
  if (value === undefined) throw new Error('expected an operation');
  return value;
};

function rejects(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FugueTextError);
    expect((error as FugueTextError).code).toBe(code);
    return;
  }
  throw new Error('expected a FugueTextError');
}

describe('operation-based sync', () => {
  it('applies operations in order', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    expect(b.apply(op(a.insert(0, 'hi')))).toBe('applied');
    expect(b.toString()).toBe('hi');
    expect(b.version).toEqual({ a: 2 });
  });

  it('ignores redelivered operations', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    const insert = op(a.insert(0, 'hi'));
    const remove = op(a.delete(0, 1));
    expect(b.apply(insert)).toBe('applied');
    expect(b.apply(insert)).toBe('duplicate');
    expect(b.apply(remove)).toBe('applied');
    expect(b.apply(remove)).toBe('duplicate');
    expect(b.toString()).toBe('i');
  });

  it('ignores its own operations echoed back by a relay', () => {
    const a = new Text({ replicaId: 'a' });
    const insert = op(a.insert(0, 'hi'));
    expect(a.apply(insert)).toBe('duplicate');
    expect(a.toString()).toBe('hi');
  });

  it('buffers operations until their predecessor from the same replica arrives', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    const first = op(a.insert(0, 'ab'));
    const second = op(a.insert(2, 'cd'));
    const third = op(a.delete(0, 1));
    expect(b.apply(third)).toBe('buffered');
    expect(b.apply(second)).toBe('buffered');
    expect(b.apply(second)).toBe('duplicate');
    expect(b.pendingCount).toBe(2);
    expect(b.toString()).toBe('');
    expect(b.apply(first)).toBe('applied');
    expect(b.pendingCount).toBe(0);
    expect(b.toString()).toBe('bcd');
    checkInvariants(b);
  });

  it('buffers operations until causal dependencies from other replicas arrive', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    const c = new Text({ replicaId: 'c' });
    const fromA = op(a.insert(0, 'hello'));
    b.apply(fromA);
    const fromB = op(b.delete(0, 5)); // depends on a's insert
    expect(fromB.deps).toEqual({ a: 5 });
    expect(c.apply(fromB)).toBe('buffered');
    expect(c.apply(fromA)).toBe('applied');
    expect(c.toString()).toBe('');
    expect(c.version).toEqual({ a: 5, b: 1 });
  });

  it('respects causality that does not involve the referenced elements', () => {
    // b sees a's insert and then inserts somewhere unrelated; c must still apply them in order.
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    const c = new Text({ replicaId: 'c' });
    const base = op(a.insert(0, 'xy'));
    b.apply(base);
    c.apply(base);
    const fromA = op(a.insert(2, '!'));
    b.apply(fromA);
    const fromB = op(b.insert(0, '>'));
    expect(fromB.deps).toEqual({ a: 3 });
    expect(c.apply(fromB)).toBe('buffered');
    expect(c.apply(fromA)).toBe('applied');
    expect(c.toString()).toBe('>xy!');
  });

  it('sends only dependencies that changed since its previous operation', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    b.apply(op(a.insert(0, 'a')));
    expect(op(b.insert(1, 'b')).deps).toEqual({ a: 1 });
    expect(op(b.insert(2, 'b')).deps).toEqual({});
    b.apply(op(a.insert(0, 'a')));
    expect(op(b.delete(0, 1)).deps).toEqual({ a: 2 });
  });

  it('declares full dependencies after loading a state', () => {
    const a = new Text({ replicaId: 'a' });
    a.insert(0, 'abc');
    const b = Text.load(a.save(), { replicaId: 'b' });
    expect(op(b.insert(3, '!')).deps).toEqual({ a: 3 });
  });

  it('rejects malformed operations without changing the document', () => {
    const b = new Text({ replicaId: 'b' });
    b.insert(0, 'base');
    const valid: InsertOperation = {
      type: 'insert',
      replica: 'a',
      counter: 0,
      deps: {},
      parent: null,
      side: 'right',
      text: 'x',
    };
    const malformed: unknown[] = [
      null,
      'insert',
      { ...valid, type: 'move' },
      { ...valid, replica: '' },
      { ...valid, counter: -1 },
      { ...valid, counter: 1.5 },
      { ...valid, deps: null },
      { ...valid, deps: { a: -1 } },
      { ...valid, deps: { 'bad id': 1 } },
      { ...valid, side: 'up' },
      { ...valid, side: 'left' }, // the root has no left children
      { ...valid, parent: { replica: 'a' } },
      { ...valid, text: '' },
      { ...valid, text: 7 },
      { ...valid, counter: Number.MAX_SAFE_INTEGER },
      { type: 'delete', replica: 'a', counter: 0, deps: {}, targets: [] },
      {
        type: 'delete',
        replica: 'a',
        counter: 0,
        deps: {},
        targets: [{ replica: 'a', counter: 0 }],
      },
      {
        type: 'delete',
        replica: 'a',
        counter: 0,
        deps: {},
        targets: [{ replica: 'a', counter: 0, length: 0 }],
      },
    ];
    for (const value of malformed) rejects(() => b.apply(value as Operation), 'invalid-operation');
    expect(b.toString()).toBe('base');
  });

  it('rejects operations that reference unknown elements', () => {
    const b = new Text({ replicaId: 'b' });
    const orphan: Operation = {
      type: 'insert',
      replica: 'a',
      counter: 0,
      deps: {},
      parent: { replica: 'z', counter: 0 },
      side: 'right',
      text: 'x',
    };
    rejects(() => b.apply(orphan), 'invalid-operation');
    const badDelete: Operation = {
      type: 'delete',
      replica: 'a',
      counter: 0,
      deps: {},
      targets: [{ replica: 'z', counter: 0, length: 1 }],
    };
    rejects(() => b.apply(badDelete), 'invalid-operation');
    expect(b.version).toEqual({});
  });

  it('rejects operations overlapping ones already applied', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    b.apply(op(a.insert(0, 'abc')));
    const overlapping: Operation = {
      type: 'insert',
      replica: 'a',
      counter: 2,
      deps: {},
      parent: null,
      side: 'right',
      text: 'xy',
    };
    rejects(() => b.apply(overlapping), 'invalid-operation');
  });

  it('detects another instance using the same replica ID', () => {
    const a1 = new Text({ replicaId: 'a' });
    const a2 = new Text({ replicaId: 'a' });
    const foreign = op(a2.insert(0, 'x'));
    rejects(() => a1.apply(foreign), 'replica-conflict');
  });

  it('keeps operations applied before a buffered operation turned out to be invalid', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    const first = op(a.insert(0, 'ok'));
    const broken: Operation = {
      type: 'insert',
      replica: 'a',
      counter: 2,
      deps: {},
      parent: { replica: 'nobody', counter: 0 },
      side: 'right',
      text: 'x',
    };
    expect(b.apply(broken)).toBe('buffered');
    rejects(() => b.apply(first), 'invalid-operation');
    expect(b.toString()).toBe('ok');
    expect(b.pendingCount).toBe(0);
  });

  it('round-trips operations through JSON', () => {
    const a = new Text({ replicaId: 'a' });
    const b = new Text({ replicaId: 'b' });
    for (const value of [a.insert(0, 'héllo'), a.delete(1, 2), a.insert(1, '\u{1F600}')]) {
      b.apply(JSON.parse(JSON.stringify(value)) as Operation);
    }
    expect(b.toString()).toBe(a.toString());
  });
});
