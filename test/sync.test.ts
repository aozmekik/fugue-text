import { describe, expect, it } from 'vitest';
import { FugueTextError, FugueText } from '../src/index.js';
import type { InsertOperation, Operation } from '../src/index.js';
import { checkInvariants } from './support/helpers.js';

const op = <T extends Operation>(value: T | undefined): T => {
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
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    expect(b.apply(op(a.insert(0, 'hi')))).toBe('applied');
    expect(b.toString()).toBe('hi');
    expect(b.version).toEqual({ a: 2 });
  });

  it('ignores redelivered operations', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    const insert = op(a.insert(0, 'hi'));
    const remove = op(a.delete(0, 1));
    expect(b.apply(insert)).toBe('applied');
    expect(b.apply(insert)).toBe('duplicate');
    expect(b.apply(remove)).toBe('applied');
    expect(b.apply(remove)).toBe('duplicate');
    expect(b.toString()).toBe('i');
  });

  it('ignores its own operations echoed back by a relay', () => {
    const a = new FugueText({ replicaId: 'a' });
    const insert = op(a.insert(0, 'hi'));
    expect(a.apply(insert)).toBe('duplicate');
    expect(a.toString()).toBe('hi');
  });

  it('buffers operations until their predecessor from the same replica arrives', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
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
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    const c = new FugueText({ replicaId: 'c' });
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
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    const c = new FugueText({ replicaId: 'c' });
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
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    b.apply(op(a.insert(0, 'a')));
    expect(op(b.insert(1, 'b')).deps).toEqual({ a: 1 });
    expect(op(b.insert(2, 'b')).deps).toEqual({});
    b.apply(op(a.insert(0, 'a')));
    expect(op(b.delete(0, 1)).deps).toEqual({ a: 2 });
  });

  it('declares full dependencies after loading a state', () => {
    const a = new FugueText({ replicaId: 'a' });
    a.insert(0, 'abc');
    const b = FugueText.load(a.save(), { replicaId: 'b' });
    expect(op(b.insert(3, '!')).deps).toEqual({ a: 3 });
  });

  it('rejects malformed operations without changing the document', () => {
    const b = new FugueText({ replicaId: 'b' });
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
    const b = new FugueText({ replicaId: 'b' });
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
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
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
    const a1 = new FugueText({ replicaId: 'a' });
    const a2 = new FugueText({ replicaId: 'a' });
    const foreign = op(a2.insert(0, 'x'));
    rejects(() => a1.apply(foreign), 'replica-conflict');
  });

  it('rejects an operation that differs from a buffered one with the same ID', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    a.insert(0, 'x');
    const second = op(a.insert(1, 'y'));
    expect(b.apply({ ...second, text: 'EVIL' })).toBe('buffered');
    rejects(() => b.apply(second), 'invalid-operation');
    expect(b.pendingCount).toBe(1);
  });

  it('compares buffered operations field by field, ignoring the order of deps', () => {
    const c = new FugueText({ replicaId: 'c' });
    const a = new FugueText({ replicaId: 'a' });
    a.insert(0, 'abc');
    c.apply(op(new FugueText({ replicaId: 'x' }).insert(0, 'x')));
    c.apply(op(new FugueText({ replicaId: 'y' }).insert(0, 'y')));
    c.insert(0, 'c'); // c now has counter 1
    const removal = op(a.delete(0, 2));
    const insertion: InsertOperation = {
      type: 'insert',
      replica: 'c',
      counter: 1,
      deps: { x: 1, y: 1 },
      parent: null,
      side: 'right',
      text: 'q',
    };
    const b = new FugueText({ replicaId: 'b' });
    expect(b.apply(removal)).toBe('buffered');
    expect(b.apply(insertion)).toBe('buffered');
    expect(b.apply({ ...insertion, deps: { y: 1, x: 1 } })).toBe('duplicate');
    const variants: Operation[] = [
      { ...insertion, deps: { x: 1 } },
      { ...insertion, deps: { x: 1, z: 1 } },
      { ...insertion, deps: { x: 1, y: 2 } },
      { ...insertion, side: 'left', parent: { replica: 'x', counter: 0 } },
      { ...insertion, parent: { replica: 'x', counter: 0 } },
      { ...removal, targets: [{ replica: 'a', counter: 0, length: 1 }] },
      { ...removal, targets: [{ replica: 'a', counter: 1, length: 2 }] },
      { ...removal, deps: { q: 1 } },
      {
        type: 'insert',
        replica: 'a',
        counter: 3,
        deps: {},
        parent: null,
        side: 'right',
        text: 'z',
      },
    ];
    for (const variant of variants) rejects(() => b.apply(variant), 'invalid-operation');
    expect(b.pendingCount).toBe(2);
  });

  it('rejects dependencies on operations this replica never produced', () => {
    const b = new FugueText({ replicaId: 'b' });
    b.insert(0, 'own');
    const forged: Operation = {
      type: 'insert',
      replica: 'a',
      counter: 0,
      deps: { b: 4 }, // b has only produced counters 0..2
      parent: null,
      side: 'right',
      text: 'x',
    };
    rejects(() => b.apply(forged), 'replica-conflict');
    expect(b.apply({ ...forged, deps: { b: 3 } })).toBe('applied');
  });

  it('rejects operations that claim to depend on their own later operations', () => {
    const b = new FugueText({ replicaId: 'b' });
    const forged: Operation = {
      type: 'insert',
      replica: 'a',
      counter: 0,
      deps: { a: 1 },
      parent: null,
      side: 'right',
      text: 'x',
    };
    rejects(() => b.apply(forged), 'invalid-operation');
    expect(b.pendingCount).toBe(0);
  });

  it('applies long dependency chains delivered in reverse', () => {
    // Replica i depends on replica i - 1, so only the last delivery makes anything ready.
    const count = 3000;
    const ops = Array.from({ length: count }, (_, i): Operation => ({
      type: 'insert',
      replica: `r${String(i)}`,
      counter: 0,
      deps: i === 0 ? {} : { [`r${String(i - 1)}`]: 1 },
      parent: null,
      side: 'right',
      text: 'x',
    }));
    const target = new FugueText({ replicaId: 'target' });
    for (const operation of ops.slice(1).reverse())
      expect(target.apply(operation)).toBe('buffered');
    expect(target.apply(ops[0] as Operation)).toBe('applied');
    expect(target.pendingCount).toBe(0);
    expect(target.length).toBe(count);
  });

  it('round-trips operations through JSON', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    for (const value of [a.insert(0, 'héllo'), a.delete(1, 2), a.insert(1, '\u{1F600}')]) {
      b.apply(JSON.parse(JSON.stringify(value)) as Operation);
    }
    expect(b.toString()).toBe(a.toString());
  });
});

describe('invalid buffered operations', () => {
  /** `a` types "ok"; `broken` is a forged next operation of `a` with an unknown parent. */
  function setup(onReject?: (error: FugueTextError, rejected: Operation) => void) {
    const a = new FugueText({ replicaId: 'a' });
    const c = new FugueText({ replicaId: 'c' });
    const r = new FugueText(
      onReject === undefined ? { replicaId: 'r' } : { replicaId: 'r', onReject },
    );
    const first = op(a.insert(0, 'ok'));
    const genuine = op(a.insert(2, '!'));
    const broken: Operation = { ...genuine, parent: { replica: 'nobody', counter: 0 } };
    c.apply(first);
    const fromC = op(c.insert(0, '>')); // depends on `first` only
    return { a, r, first, genuine, broken, fromC };
  }

  it('are discarded and reported while other buffered operations keep draining', () => {
    const reported: [string, Operation][] = [];
    const { r, first, broken, fromC } = setup((error, rejected) => {
      reported.push([error.code, rejected]);
    });
    expect(r.apply(broken)).toBe('buffered');
    expect(r.apply(fromC)).toBe('buffered');
    expect(r.apply(first)).toBe('applied'); // the caller's own operation is fine
    expect(r.toString()).toBe('>ok');
    expect(r.version).toEqual({ a: 2, c: 1 });
    expect(r.pendingCount).toBe(0);
    expect(reported).toEqual([['invalid-operation', broken]]);
  });

  it('do not block a valid operation with the same ID that arrives later', () => {
    const { a, r, first, genuine, broken } = setup();
    const after = op(a.insert(3, '?')); // waits for a:2
    r.apply(broken);
    r.apply(after);
    r.apply(first);
    expect(r.toString()).toBe('ok');
    expect(r.pendingCount).toBe(1); // `after` still waits for a:2
    expect(r.apply(genuine)).toBe('applied');
    expect(r.toString()).toBe('ok!?');
    expect(r.pendingCount).toBe(0);
  });

  it('are reported, not thrown, when a merge unblocks them', () => {
    const reported: Operation[] = [];
    const { r, first, broken } = setup((_error, rejected) => reported.push(rejected));
    r.apply(broken);
    const peer = new FugueText({ replicaId: 'peer' });
    peer.apply(first);
    r.merge(peer.save()); // covers a:0..1, so `broken` (a:2) becomes ready and fails
    expect(r.toString()).toBe('ok');
    expect(r.pendingCount).toBe(0);
    expect(reported).toEqual([broken]);
  });

  it('are dropped without a report when a merge already covers them', () => {
    const reported: Operation[] = [];
    const { a, r, genuine } = setup((_error, rejected) => reported.push(rejected));
    expect(r.apply(genuine)).toBe('buffered');
    r.merge(a.save()); // contains a:0..2, including `genuine`
    expect(r.toString()).toBe('ok!');
    expect(r.pendingCount).toBe(0);
    expect(reported).toEqual([]);
  });

  it('are rejected when they overlap an operation applied before them', () => {
    const reported: Operation[] = [];
    const { r, first, genuine } = setup((_error, rejected) => reported.push(rejected));
    const overlapping: Operation = { ...genuine, counter: 3, text: 'qq' }; // a:3..4 overlaps a:2..3
    const wide: Operation = { ...genuine, text: '!!' }; // a:2..3
    r.apply(overlapping);
    r.apply(wide);
    r.apply(first);
    expect(r.toString()).toBe('ok!!');
    expect(r.pendingCount).toBe(0);
    expect(reported).toEqual([overlapping]);
  });

  it('report exceptions thrown by onReject asynchronously', async () => {
    const failure = new Error('handler failed');
    const reported = new Promise<unknown>((resolve) => {
      process.once('uncaughtException', resolve);
    });
    const { r, first, broken } = setup(() => {
      throw failure;
    });
    r.apply(broken);
    expect(r.apply(first)).toBe('applied');
    await expect(reported).resolves.toBe(failure);
  });
});
