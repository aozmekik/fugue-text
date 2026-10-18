import { describe, expect, it, vi } from 'vitest';
import { FugueText } from '../src/index.js';
import type { ChangeEvent, Operation } from '../src/index.js';
import { checkInvariants, mirror } from './support/helpers.js';

describe('FugueText: local editing', () => {
  it('starts empty', () => {
    const text = new FugueText({ replicaId: 'a' });
    expect(text.toString()).toBe('');
    expect(text.length).toBe(0);
    expect(text.version).toEqual({});
    expect(text.pendingCount).toBe(0);
  });

  it('inserts and deletes like a string', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.insert(0, 'world');
    text.insert(0, 'hello ');
    text.insert(text.length, '!');
    text.insert(5, ',');
    expect(text.toString()).toBe('hello, world!');
    text.delete(5, 1);
    text.delete(0, 6);
    expect(text.toString()).toBe('world!');
    expect(text.length).toBe(6);
    checkInvariants(text);
  });

  it('returns operations that describe the edit', () => {
    const text = new FugueText({ replicaId: 'a' });
    const first = text.insert(0, 'ab');
    expect(first).toEqual({
      type: 'insert',
      replica: 'a',
      counter: 0,
      deps: {},
      parent: null,
      side: 'right',
      text: 'ab',
    });
    const del = text.delete(0, 2);
    expect(del).toEqual({
      type: 'delete',
      replica: 'a',
      counter: 2,
      deps: {},
      targets: [{ replica: 'a', counter: 0, length: 2 }],
    });
    expect(text.version).toEqual({ a: 3 });
  });

  it('returns undefined for empty edits', () => {
    const text = new FugueText({ replicaId: 'a' });
    expect(text.insert(0, '')).toBeUndefined();
    text.insert(0, 'x');
    expect(text.delete(0, 0)).toBeUndefined();
    expect(text.version).toEqual({ a: 1 });
  });

  it('validates arguments', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.insert(0, 'abc');
    expect(() => text.insert(4, 'x')).toThrow(RangeError);
    expect(() => text.insert(-1, 'x')).toThrow(RangeError);
    expect(() => text.insert(1.5, 'x')).toThrow(RangeError);
    expect(() => text.insert(Number.NaN, 'x')).toThrow(RangeError);
    expect(() => text.insert(0, 42 as unknown as string)).toThrow(TypeError);
    expect(() => text.delete(2, 2)).toThrow(RangeError);
    expect(() => text.delete(0, -1)).toThrow(RangeError);
    expect(() => text.delete(3, 0)).not.toThrow();
    expect(() => text.createAnchor(4)).toThrow(RangeError);
    expect(text.toString()).toBe('abc');
  });

  it('validates replica IDs', () => {
    expect(() => new FugueText({ replicaId: '' })).toThrow(TypeError);
    expect(() => new FugueText({ replicaId: 'has space' })).toThrow(TypeError);
    expect(() => new FugueText({ replicaId: 'x'.repeat(65) })).toThrow(TypeError);
    expect(() => new FugueText({ replicaId: 'é' })).toThrow(TypeError);
    expect(new FugueText({ replicaId: 'x'.repeat(64) }).replicaId).toHaveLength(64);
    expect(new FugueText({ replicaId: 'user@example.com#1' }).replicaId).toBe('user@example.com#1');
  });

  it('generates distinct random replica IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => new FugueText().replicaId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{12}$/);
  });

  it('counts UTF-16 code units, including lone surrogates', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.insert(0, 'a😀b');
    expect(text.length).toBe(4);
    text.delete(1, 1); // leaves a lone low surrogate behind
    expect(text.toString()).toBe('a\udE00b');
    const copy = FugueText.load(text.save(), { replicaId: 'b' });
    expect(copy.toString()).toBe('a\udE00b');
  });

  it('compresses sequential typing into one run', () => {
    const text = new FugueText({ replicaId: 'a' });
    for (const ch of 'hello world') text.insert(text.length, ch);
    expect(text.toJSON().records).toHaveLength(1);
    checkInvariants(text);
  });

  it('handles a long document typed at random positions', () => {
    const text = new FugueText({ replicaId: 'a' });
    let model = '';
    let seed = 42;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 5000; i++) {
      if (model.length > 0 && random(4) === 0) {
        const index = random(model.length);
        const length = Math.min(1 + random(5), model.length - index);
        text.delete(index, length);
        model = model.slice(0, index) + model.slice(index + length);
      } else {
        const index = random(model.length + 1);
        const chunk = 'abcdefghij'.slice(0, 1 + random(4));
        text.insert(index, chunk);
        model = model.slice(0, index) + chunk + model.slice(index);
      }
    }
    expect(text.toString()).toBe(model);
    checkInvariants(text);
  });
});

describe('FugueText: change events', () => {
  it('reports local edits', () => {
    const text = new FugueText({ replicaId: 'a' });
    const events: ChangeEvent[] = [];
    text.subscribe((event) => events.push(event));
    text.insert(0, 'abc');
    text.delete(1, 2);
    expect(events).toEqual([
      { origin: 'local', changes: [{ type: 'insert', index: 0, text: 'abc' }] },
      { origin: 'local', changes: [{ type: 'delete', index: 1, length: 2 }] },
    ]);
  });

  it('reports remote edits with indexes valid in order', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    const ops: Operation[] = [];
    const push = (op: Operation | undefined): void => {
      if (op !== undefined) ops.push(op);
    };
    push(a.insert(0, 'hello world'));
    push(a.delete(0, 1));
    push(a.delete(3, 2));
    push(a.insert(2, 'XY'));
    const view = mirror(b);
    const events: ChangeEvent[] = [];
    b.subscribe((event) => events.push(event));
    for (const op of ops.reverse()) b.apply(op);
    expect(b.toString()).toBe(a.toString());
    expect(view.value).toBe(a.toString());
    expect(events).toHaveLength(1); // the last delivery unblocked all buffered operations
    expect(events[0]?.origin).toBe('remote');
  });

  it('stops notifying after unsubscribe', () => {
    const text = new FugueText({ replicaId: 'a' });
    const listener = vi.fn();
    const unsubscribe = text.subscribe(listener);
    text.insert(0, 'a');
    unsubscribe();
    text.insert(0, 'b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates listener failures', async () => {
    const text = new FugueText({ replicaId: 'a' });
    const failure = new Error('listener failed');
    const reported = new Promise<unknown>((resolve) => {
      process.once('uncaughtException', resolve);
    });
    const after = vi.fn();
    text.subscribe(() => {
      throw failure;
    });
    text.subscribe(after);
    const op = text.insert(0, 'x');
    expect(op).toBeDefined();
    expect(after).toHaveBeenCalledTimes(1);
    expect(text.toString()).toBe('x');
    await expect(reported).resolves.toBe(failure);
  });

  it('allows edits from inside a listener', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.subscribe((event) => {
      if (event.changes[0]?.type === 'insert' && text.length === 1) text.insert(1, '!');
    });
    text.insert(0, 'x');
    expect(text.toString()).toBe('x!');
  });

  it('delivers events caused by a listener after the current event reaches every listener', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    const origins: string[] = [];
    b.subscribe((event) => {
      origins.push(`first:${event.origin}`);
      if (event.origin === 'remote') b.insert(0, '>'); // edits synchronously
    });
    const view = mirror(b); // registered after the editing listener
    b.subscribe((event) => origins.push(`third:${event.origin}`));
    b.apply(a.insert(0, 'hello') as Operation);
    expect(b.toString()).toBe('>hello');
    expect(view.value).toBe('>hello');
    expect(origins).toEqual(['first:remote', 'third:remote', 'first:local', 'third:local']);
  });
});

describe('FugueText: anchors', () => {
  it('resolves to the creation index while nothing changes', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.insert(0, 'hello');
    for (let index = 0; index <= text.length; index++) {
      expect(text.resolveAnchor(text.createAnchor(index, 'left'))).toBe(index);
      expect(text.resolveAnchor(text.createAnchor(index, 'right'))).toBe(index);
    }
  });

  it('uses start and end sentinels at the edges', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.insert(0, 'ab');
    const start = text.createAnchor(0, 'left');
    const end = text.createAnchor(2, 'right');
    expect(start).toEqual({ type: 'start' });
    expect(end).toEqual({ type: 'end' });
    text.insert(0, '<');
    text.insert(text.length, '>');
    expect(text.resolveAnchor(start)).toBe(0);
    expect(text.resolveAnchor(end)).toBe(4);
  });

  it('follows its character and honours its bias', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.insert(0, 'ac');
    const left = text.createAnchor(1, 'left'); // sticks to 'a'
    const right = text.createAnchor(1, 'right'); // sticks to 'c'
    text.insert(1, 'b');
    expect(text.resolveAnchor(left)).toBe(1);
    expect(text.resolveAnchor(right)).toBe(2);
    text.insert(0, '__');
    expect(text.resolveAnchor(left)).toBe(3);
    expect(text.resolveAnchor(right)).toBe(4);
  });

  it('keeps its bias for later insertions only while its character is visible', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    b.apply(a.insert(0, 'abc') as Operation);
    const caret = b.createAnchor(2, 'left'); // after 'b'
    b.apply(a.delete(1, 1) as Operation);
    expect(b.resolveAnchor(caret)).toBe(1);
    // Re-creating the anchor attaches it to a visible character again ('a').
    const refreshed = b.createAnchor(b.resolveAnchor(caret) as number, 'left');
    b.apply(a.insert(1, 'XYZ') as Operation);
    expect(b.toString()).toBe('aXYZc');
    // Fugue puts the new text before the tombstone the stale anchor is attached to...
    expect(b.resolveAnchor(caret)).toBe(4);
    // ...while the refreshed anchor keeps its left bias.
    expect(b.resolveAnchor(refreshed)).toBe(1);
  });

  it('collapses to the gap when its character is deleted', () => {
    const text = new FugueText({ replicaId: 'a' });
    text.insert(0, 'abc');
    const anchor = text.createAnchor(2, 'left'); // after 'b'
    text.delete(1, 1);
    expect(text.toString()).toBe('ac');
    expect(text.resolveAnchor(anchor)).toBe(1);
  });

  it('survives concurrent edits on another replica', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    b.apply(a.insert(0, 'hello world') as Operation);
    const caret = b.createAnchor(6, 'right'); // before 'w'
    a.apply(b.insert(11, '!') as Operation);
    const ops = [a.insert(0, '>> '), a.delete(3, 5)];
    for (const op of ops) b.apply(op as Operation);
    expect(b.toString()).toBe('>>  world!');
    expect(b.resolveAnchor(caret)).toBe(4);
    // Anchors are plain JSON and resolve on any replica that knows the character.
    const shared = JSON.parse(JSON.stringify(caret)) as typeof caret;
    expect(a.resolveAnchor(shared)).toBe(4);
  });

  it('returns undefined for characters not received yet and rejects garbage', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    a.insert(0, 'x');
    const anchor = a.createAnchor(1, 'left');
    expect(b.resolveAnchor(anchor)).toBeUndefined();
    expect(() => b.resolveAnchor(null as never)).toThrow(TypeError);
    expect(() => b.resolveAnchor({ type: 'nope' } as never)).toThrow(TypeError);
    expect(() =>
      b.resolveAnchor({ type: 'element', id: { replica: '', counter: 0 }, bias: 'left' }),
    ).toThrow(TypeError);
    expect(() => a.createAnchor(0, 'up' as never)).toThrow(TypeError);
  });
});
