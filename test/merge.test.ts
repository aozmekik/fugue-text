import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FugueTextError, mergeStates, FugueText } from '../src/index.js';
import type { Operation, TextStateJSON } from '../src/index.js';
import { checkInvariants, mirror, numRuns } from './support/helpers.js';

const op = (value: Operation | undefined): Operation => {
  if (value === undefined) throw new Error('expected an operation');
  return value;
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof FugueTextError) return error.code;
    throw error;
  }
  return undefined;
}

describe('state-based sync', () => {
  it('loads a saved state', () => {
    const a = new FugueText({ replicaId: 'a' });
    a.insert(0, 'hello world');
    a.delete(0, 6);
    const b = FugueText.load(a.save(), { replicaId: 'b' });
    expect(b.toString()).toBe('world');
    expect(b.version).toEqual(a.version);
    checkInvariants(b);
    const c = FugueText.load(JSON.parse(JSON.stringify(a)) as TextStateJSON, { replicaId: 'c' });
    expect(c.toString()).toBe('world');
    expect(c.save()).toEqual(a.save());
  });

  it('resumes counters when a replica reloads its own state', () => {
    const a = new FugueText({ replicaId: 'a' });
    a.insert(0, 'abc');
    const again = FugueText.load(a.save(), { replicaId: 'a' });
    expect(op(again.insert(3, 'd')).counter).toBe(3);
  });

  it('merges concurrent edits in both directions', () => {
    const a = new FugueText({ replicaId: 'a' });
    a.insert(0, 'shared ');
    const b = FugueText.load(a.save(), { replicaId: 'b' });
    a.insert(7, 'alpha');
    a.delete(0, 1);
    b.insert(7, 'beta');
    b.delete(6, 1);
    const aView = mirror(a);
    const bView = mirror(b);
    const aState = a.save();
    a.merge(b.save());
    b.merge(aState);
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe('haredalphabeta');
    expect(aView.value).toBe(a.toString());
    expect(bView.value).toBe(b.toString());
    expect(a.save()).toEqual(b.save());
    checkInvariants(a);
    checkInvariants(b);
  });

  it('is idempotent', () => {
    const a = new FugueText({ replicaId: 'a' });
    a.insert(0, 'abc');
    const state = a.save();
    const events: unknown[] = [];
    a.subscribe((event) => events.push(event));
    a.merge(state);
    a.merge(state);
    expect(a.toString()).toBe('abc');
    expect(a.save()).toEqual(state);
    expect(events).toEqual([]);
  });

  it('applies buffered operations that a merge unblocks and drops redundant ones', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    const first = op(a.insert(0, 'x'));
    const second = op(a.insert(1, 'y'));
    const snapshot = a.save();
    const third = op(a.insert(2, 'z'));
    expect(b.apply(second)).toBe('buffered');
    expect(b.apply(third)).toBe('buffered');
    b.merge(snapshot); // contains first and second
    expect(b.pendingCount).toBe(0);
    expect(b.toString()).toBe('xyz');
    expect(b.apply(first)).toBe('duplicate');
  });

  it('refuses a state that contains unknown operations of its own replica ID', () => {
    const a1 = new FugueText({ replicaId: 'a' });
    const a2 = new FugueText({ replicaId: 'a' });
    a2.insert(0, 'x');
    expect(
      codeOf(() => {
        a1.merge(a2.save());
      }),
    ).toBe('replica-conflict');
  });

  it('refuses inconsistent states without changing the document', () => {
    const a = new FugueText({ replicaId: 'a' });
    a.insert(0, 'abc');
    a.delete(1, 1); // counter 3 is a delete, not an element
    const before = a.save();
    const forged: TextStateJSON = {
      format: 'fugue-text/state',
      formatVersion: 1,
      version: { a: 4, b: 1 },
      records: [
        { replica: 'a', counter: 3, length: 1, parent: null, side: 'right', text: '!' },
        {
          replica: 'b',
          counter: 0,
          length: 1,
          parent: { replica: 'a', counter: 3 },
          side: 'right',
          text: '?',
        },
      ],
    };
    expect(
      codeOf(() => {
        a.merge(forged);
      }),
    ).toBe('invalid-state');
    expect(a.save()).toEqual(before);
  });

  it('mergeStates merges without a live document', () => {
    const a = new FugueText({ replicaId: 'a' });
    const b = new FugueText({ replicaId: 'b' });
    a.insert(0, 'left');
    b.insert(0, 'right');
    const merged = FugueText.load(mergeStates(a.save(), b.save()), { replicaId: 'c' });
    expect(merged.toString()).toBe('leftright');
  });
});

/** Random replicas that share some history and then diverge. */
const divergentStates = fc
  .record({
    shared: fc.array(fc.tuple(fc.boolean(), fc.nat(), fc.string({ minLength: 1, maxLength: 3 })), {
      maxLength: 15,
    }),
    edits: fc.array(
      fc.array(fc.tuple(fc.boolean(), fc.nat(), fc.string({ minLength: 1, maxLength: 3 })), {
        maxLength: 15,
      }),
      { minLength: 3, maxLength: 3 },
    ),
  })
  .map(({ shared, edits }) => {
    const apply = (text: FugueText, steps: readonly [boolean, number, string][]): void => {
      for (const [insert, at, chunk] of steps) {
        if (insert || text.length === 0) text.insert(at % (text.length + 1), chunk);
        else {
          const index = at % text.length;
          text.delete(index, Math.min(chunk.length, text.length - index));
        }
      }
    };
    const origin = new FugueText({ replicaId: 'origin' });
    apply(origin, shared);
    return edits.map((steps, i) => {
      const replica = FugueText.load(origin.save(), { replicaId: `r${String(i)}` });
      apply(replica, steps);
      return replica.save();
    });
  });

describe('merge properties', () => {
  it('is commutative, associative and idempotent on encoded states', () => {
    fc.assert(
      fc.property(divergentStates, (states) => {
        const [a, b, c] = states as [Uint8Array, Uint8Array, Uint8Array];
        expect(mergeStates(a, b)).toEqual(mergeStates(b, a));
        expect(mergeStates(mergeStates(a, b), c)).toEqual(mergeStates(a, mergeStates(b, c)));
        expect(mergeStates(a, a)).toEqual(a);
        const ab = mergeStates(a, b);
        expect(mergeStates(ab, a)).toEqual(ab);
      }),
      { numRuns },
    );
  });

  it('agrees with operation-based sync', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.nat({ max: 1 }),
            fc.boolean(),
            fc.nat(),
            fc.string({ minLength: 1, maxLength: 3 }),
          ),
          {
            maxLength: 40,
          },
        ),
        (steps) => {
          const replicas = [new FugueText({ replicaId: 'x' }), new FugueText({ replicaId: 'y' })];
          const ops: Operation[] = [];
          for (const [who, insert, at, chunk] of steps) {
            const text = replicas[who] as FugueText;
            const result =
              insert || text.length === 0
                ? text.insert(at % (text.length + 1), chunk)
                : text.delete(
                    at % text.length,
                    Math.min(chunk.length, text.length - (at % text.length)),
                  );
            if (result !== undefined) ops.push(result);
          }
          const viaOps = new FugueText({ replicaId: 'z' });
          for (const operation of ops) viaOps.apply(operation);
          const viaMerge = new FugueText({ replicaId: 'w' });
          for (const replica of replicas) viaMerge.merge(replica.save());
          expect(viaMerge.toString()).toBe(viaOps.toString());
          expect(viaMerge.save()).toEqual(viaOps.save());
        },
      ),
      { numRuns },
    );
  });
});
