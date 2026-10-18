import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, decodeWtf8, encodeWtf8 } from '../src/encoding/bytes.js';
import { decodeOperation, encodeOperation, FugueTextError, FugueText } from '../src/index.js';
import type { Operation, TextStateJSON, VersionVector } from '../src/index.js';
import { MAX_COUNTER } from '../src/internal/guards.js';
import { checkInvariants, fuzzNumRuns, numRuns } from './support/helpers.js';

const fail = (message: string): never => {
  throw new Error(message);
};

/** Any UTF-16 string, including lone surrogates. */
const anyString = fc.string({
  maxLength: 40,
  unit: fc.integer({ min: 0, max: 0xffff }).map((code) => String.fromCharCode(code)),
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof FugueTextError) return error.code;
    throw error;
  }
  return undefined;
}

describe('varints', () => {
  it('round-trips unsigned and signed integers', () => {
    const values = [
      0,
      1,
      127,
      128,
      255,
      16_383,
      16_384,
      2 ** 31,
      2 ** 32 + 5,
      Number.MAX_SAFE_INTEGER,
    ];
    const out = new ByteWriter();
    for (const value of values) out.uint(value);
    for (const value of values) out.int(value % 2 === 0 ? value / 2 : -(value + 1) / 2);
    const input = new ByteReader(out.finish(), fail);
    for (const value of values) expect(input.uint()).toBe(value);
    for (const value of values)
      expect(input.int()).toBe(value % 2 === 0 ? value / 2 : -(value + 1) / 2);
    input.end();
  });

  it('uses the expected number of bytes', () => {
    const size = (value: number): number => {
      const out = new ByteWriter();
      out.uint(value);
      return out.finish().length;
    };
    expect(size(127)).toBe(1);
    expect(size(128)).toBe(2);
    expect(size(Number.MAX_SAFE_INTEGER)).toBe(8);
  });

  it('rejects overlong, oversized and truncated varints', () => {
    expect(() => new ByteReader(Uint8Array.of(0x80, 0x00), fail).uint()).toThrow(/overlong/);
    expect(() =>
      new ByteReader(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x10), fail).uint(),
    ).toThrow(/2\^53/);
    expect(() => new ByteReader(Uint8Array.of(0x80), fail).uint()).toThrow(/end of input/);
    expect(() => new ByteReader(Uint8Array.of(5, 1), fail).bytes(5)).toThrow(/end of input/);
    expect(() => {
      const input = new ByteReader(Uint8Array.of(1, 2), fail);
      input.byte();
      input.end();
    }).toThrow(/trailing/);
  });

  it('grows the buffer as needed', () => {
    const out = new ByteWriter();
    const big = new Uint8Array(10_000).fill(7);
    out.bytes(big);
    out.byte(1);
    expect(out.finish().length).toBe(10_001);
  });
});

describe('WTF-8 strings', () => {
  it('round-trips every UTF-16 string', () => {
    fc.assert(
      fc.property(anyString, (value) => {
        const out = new ByteWriter();
        out.string(value);
        const input = new ByteReader(out.finish(), fail);
        expect(input.string()).toBe(value);
        input.end();
      }),
      { numRuns },
    );
  });

  it('is plain UTF-8 for well-formed strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (value) => {
        expect(encodeWtf8(value)).toEqual(new TextEncoder().encode(value));
      }),
      { numRuns },
    );
  });

  it('keeps a leading byte order mark', () => {
    expect(decodeWtf8(encodeWtf8('﻿x'), fail)).toBe('﻿x');
  });

  it('encodes lone surrogates as three bytes and pairs as four', () => {
    expect([...encodeWtf8('\ud800')]).toEqual([0xed, 0xa0, 0x80]);
    expect([...encodeWtf8('\u{1F600}')]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect([...encodeWtf8('a\udc00\u{1F600}\ud83d')]).toHaveLength(1 + 3 + 4 + 3);
  });

  it('rejects malformed sequences', () => {
    const bad = [
      [0xc0, 0x80], // overlong NUL
      [0xe0, 0x80, 0x80], // overlong
      [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
      [0xf8], // invalid lead byte
      [0x80], // stray continuation byte
      [0xe2, 0x82], // truncated
      [0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80], // surrogate pair encoded as two sequences (CESU-8)
    ];
    for (const bytes of bad) expect(() => decodeWtf8(Uint8Array.from(bytes), fail)).toThrow();
  });
});

/** Builds a replica with a random editing history. */
const randomDocument = fc
  .array(
    fc.tuple(
      fc.constantFrom('a', 'b', 'c'),
      fc.boolean(),
      fc.nat(),
      fc.string({
        minLength: 1,
        maxLength: 4,
        unit: fc.constantFrom('x', 'y', 'é', '\ud83d', '\ude00', '﻿'),
      }),
    ),
    { maxLength: 40 },
  )
  .map((steps) => {
    const replicas = new Map(['a', 'b', 'c'].map((id) => [id, new FugueText({ replicaId: id })]));
    const all = [...replicas.values()];
    for (const [who, insert, at, chunk] of steps) {
      const text = replicas.get(who) as FugueText;
      const result =
        insert || text.length === 0
          ? text.insert(at % (text.length + 1), chunk)
          : text.delete(at % text.length, Math.min(chunk.length, text.length - (at % text.length)));
      // Deliver to one other replica only, so the replicas genuinely diverge.
      if (result !== undefined && at % 3 === 0) {
        for (const other of all) if (other !== text) other.apply(result);
      }
    }
    for (const text of all.slice(1)) (all[0] as FugueText).merge(text.save());
    return all[0] as FugueText;
  });

describe('version vectors', () => {
  it('have no prototype, so any replica ID can be looked up', () => {
    // A computed key, as an application would use, so inherited members are not type-checked.
    const entry = (vector: VersionVector, replica: string): unknown => vector[replica];
    const a = new FugueText({ replicaId: 'constructor' });
    const b = new FugueText({ replicaId: '__proto__' });
    b.apply(a.insert(0, 'x') as Operation);
    const fromB = b.insert(1, 'y') as Operation;
    expect(entry(fromB.deps, 'constructor')).toBe(1);
    expect(entry(b.version, 'toString')).toBeUndefined();
    expect(entry(b.version, '__proto__')).toBe(1);
    expect(entry(b.toJSON().version, 'hasOwnProperty')).toBeUndefined();
    const decoded = decodeOperation(encodeOperation(fromB));
    expect(entry(decoded.deps, 'constructor')).toBe(1);
    expect(entry(decoded.deps, 'valueOf')).toBeUndefined();
    a.apply(JSON.parse(JSON.stringify(fromB)) as Operation);
    expect(a.toString()).toBe('xy');
    expect(FugueText.load(b.toJSON()).version).toEqual(b.version);
  });
});

describe('state codecs', () => {
  it('round-trips random documents through binary and JSON', () => {
    fc.assert(
      fc.property(randomDocument, (text) => {
        const bytes = text.save();
        const fromBinary = FugueText.load(bytes, { replicaId: 'reader' });
        expect(fromBinary.toString()).toBe(text.toString());
        expect(fromBinary.version).toEqual(text.version);
        expect(fromBinary.save()).toEqual(bytes);
        checkInvariants(fromBinary);
        const json = JSON.parse(JSON.stringify(text.toJSON())) as TextStateJSON;
        const fromJson = FugueText.load(json, { replicaId: 'reader' });
        expect(fromJson.save()).toEqual(bytes);
        expect(fromJson.toJSON()).toEqual(json);
      }),
      { numRuns },
    );
  });

  it('rejects arbitrary bytes with invalid-state', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const withMagic = Uint8Array.from([0x46, 0x55, 0x47, 0x53, 1, ...bytes]);
        for (const input of [bytes, withMagic]) {
          const code = codeOf(() => FugueText.load(input));
          if (code !== undefined) expect(code).toBe('invalid-state');
        }
      }),
      { numRuns: fuzzNumRuns },
    );
  });

  it('either rejects a corrupted state or loads a consistent document', () => {
    fc.assert(
      fc.property(randomDocument, fc.nat(), fc.nat({ max: 255 }), (text, at, value) => {
        const bytes = text.save();
        if (bytes.length === 0) return;
        const corrupted = Uint8Array.from(bytes);
        corrupted[at % corrupted.length] = value;
        let loaded: FugueText | undefined;
        const code = codeOf(() => {
          loaded = FugueText.load(corrupted);
        });
        if (code !== undefined) expect(code).toBe('invalid-state');
        if (loaded !== undefined) checkInvariants(loaded);
      }),
      { numRuns: fuzzNumRuns },
    );
  });

  it('rejects specific malformed states', () => {
    const base = (
      records: TextStateJSON['records'],
      version: TextStateJSON['version'] = { a: 10, b: 10 },
    ): TextStateJSON => ({
      format: 'fugue-text/state',
      formatVersion: 1,
      version,
      records,
    });
    const record = (counter: number, extra: Partial<TextStateJSON['records'][number]> = {}) => ({
      replica: 'a',
      counter,
      length: 1,
      parent: null,
      side: 'right' as const,
      text: 'x',
      ...extra,
    });
    const cases: unknown[] = [
      null,
      { format: 'other' },
      { ...base([]), formatVersion: 2 },
      { ...base([]), version: { a: -1 } },
      { ...base([]), version: { a: 0 } },
      { ...base([]), records: 'nope' },
      base([record(0, { side: 'left' })]),
      base([record(0, { text: 'xy' })]),
      base([record(0, { length: 0, text: '' })]),
      base([record(0), record(0)]), // duplicate element
      base([record(0, { length: 2, text: 'xy' }), record(1)]), // overlapping runs
      base([record(0, { parent: { replica: 'b', counter: 3 } })]), // unknown parent
      base([record(1, { parent: { replica: 'a', counter: 0 } })]), // continuation without predecessor
      base([record(5)], { a: 3 }), // beyond version
      base([record(0, { parent: { replica: 'a', counter: 0 } })]), // its own parent
      // Out of tree order: a right child listed before its parent.
      base([record(1, { parent: { replica: 'b', counter: 0 } }), { ...record(0), replica: 'b' }]),
    ];
    for (const value of cases) {
      expect(codeOf(() => FugueText.load(value as TextStateJSON))).toBe('invalid-state');
    }
    expect(codeOf(() => FugueText.load(Uint8Array.of(1, 2, 3)))).toBe('invalid-state');
  });

  it('names the problem in malformed records and binary headers', () => {
    const state = (records: unknown[], version: unknown = { a: 10 }): unknown => ({
      format: 'fugue-text/state',
      formatVersion: 1,
      version,
      records,
    });
    const record = { replica: 'a', counter: 0, length: 1, parent: null, side: 'right', text: 'x' };
    /** A binary state with the given replica table and version, and no records. */
    const binary = (replicas: readonly string[], counters: readonly number[]): Uint8Array => {
      const out = new ByteWriter();
      for (const byte of [0x46, 0x55, 0x47, 0x53, 1]) out.byte(byte);
      out.uint(replicas.length);
      for (const replica of replicas) out.string(replica);
      for (const counter of counters) out.uint(counter);
      out.uint(0); // records
      out.string(''); // text
      return out.finish();
    };
    expect(binary([], [])).toEqual(new FugueText().save());
    const cases: [unknown, RegExp][] = [
      [state([], null), /JSON state: missing version/],
      [state(['nope']), /JSON state: malformed record$/],
      [state([{ ...record, side: 'up' }]), /JSON state: malformed side/],
      [state([{ ...record, parent: { replica: 7, counter: 0 } }]), /JSON state: malformed parent/],
      [binary(['a', 'a'], [1, 1]), /binary state: duplicate replica ID/],
      [binary(['a'], [MAX_COUNTER + 1]), /binary state: version entry exceeds 2\^52 - 1/],
    ];
    for (const [value, message] of cases) {
      expect(codeOf(() => FugueText.load(value as TextStateJSON))).toBe('invalid-state');
      expect(() => FugueText.load(value as TextStateJSON)).toThrow(message);
    }
  });
});

/** Random valid operations, produced by real edits. */
const randomOperations = fc
  .array(
    fc.tuple(
      fc.boolean(),
      fc.nat(),
      anyString.filter((s) => s.length > 0),
    ),
    { minLength: 1, maxLength: 20 },
  )
  .map((steps) => {
    const a = new FugueText({ replicaId: 'alpha' });
    const b = new FugueText({ replicaId: 'beta' });
    const ops: Operation[] = [];
    for (const [insert, at, chunk] of steps) {
      const text = at % 2 === 0 ? a : b;
      const result =
        insert || text.length === 0
          ? text.insert(at % (text.length + 1), chunk)
          : text.delete(at % text.length, Math.min(chunk.length, text.length - (at % text.length)));
      if (result !== undefined) {
        ops.push(result);
        (text === a ? b : a).apply(result);
      }
    }
    return ops;
  });

describe('operation codec', () => {
  it('round-trips operations', () => {
    fc.assert(
      fc.property(randomOperations, (ops) => {
        for (const op of ops) expect(decodeOperation(encodeOperation(op))).toEqual(op);
      }),
      { numRuns },
    );
  });

  it('is smaller than JSON for typical keystrokes', () => {
    const a = new FugueText({ replicaId: 'k3j8f2la9qpe' });
    const b = new FugueText({ replicaId: 'zz81bc0d2e4f' });
    b.apply(a.insert(0, 'hello') as Operation);
    const keystroke = b.insert(5, '!') as Operation;
    expect(encodeOperation(keystroke).length).toBeLessThan(JSON.stringify(keystroke).length / 2);
  });

  it('rejects arbitrary bytes with invalid-operation', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 48 }), fc.constantFrom(0x11, 0x12), (bytes, tag) => {
        for (const input of [bytes, Uint8Array.from([tag, ...bytes])]) {
          const code = codeOf(() => decodeOperation(input));
          if (code !== undefined) expect(code).toBe('invalid-operation');
        }
      }),
      { numRuns: fuzzNumRuns },
    );
  });

  it('refuses to encode malformed operations', () => {
    const valid: Operation = {
      type: 'insert',
      replica: 'a',
      counter: 0,
      deps: {},
      parent: null,
      side: 'right',
      text: 'x',
    };
    for (const counter of [-1, Number.NaN, 1.5]) {
      expect(codeOf(() => encodeOperation({ ...valid, counter }))).toBe('invalid-operation');
    }
    expect(codeOf(() => encodeOperation({ ...valid, replica: '' }))).toBe('invalid-operation');
  });

  it('rejects duplicate dependencies', () => {
    // tag, 2 replicas ("a", "b"), counter 0, 2 deps both on "b", root parent, text "x"
    const bytes = Uint8Array.of(0x11, 2, 1, 0x61, 1, 0x62, 0, 2, 1, 1, 1, 2, 0, 1, 0x78);
    expect(codeOf(() => decodeOperation(bytes))).toBe('invalid-operation');
    const single = Uint8Array.of(0x11, 2, 1, 0x61, 1, 0x62, 0, 1, 1, 1, 0, 1, 0x78);
    expect(decodeOperation(single)).toEqual({
      type: 'insert',
      replica: 'a',
      counter: 0,
      deps: { b: 1 },
      parent: null,
      side: 'right',
      text: 'x',
    });
  });

  it('rejects malformed replica tables, replica indexes and element counts', () => {
    const cases: [Uint8Array, RegExp][] = [
      [Uint8Array.of(0x11, 0), /malformed replica table/], // no replicas
      [Uint8Array.of(0x11, 9, 1, 0x61), /malformed replica table/], // more replicas than bytes
      // insert by "a", counter 0, claiming 100 dependencies in 6 bytes
      [Uint8Array.of(0x11, 1, 1, 0x61, 0, 100), /dependency count exceeds input size/],
      // insert by "a", counter 0, no deps, parent in replica 5 (2 * (5 + 1)): only 0 exists
      [Uint8Array.of(0x11, 1, 1, 0x61, 0, 0, 12, 0, 1, 0x78), /replica index out of range/],
      // delete by "a", counter 0, no deps, claiming 100 targets in 7 bytes
      [Uint8Array.of(0x12, 1, 1, 0x61, 0, 0, 100), /target count exceeds input size/],
    ];
    for (const [bytes, message] of cases) {
      expect(codeOf(() => decodeOperation(bytes))).toBe('invalid-operation');
      expect(() => decodeOperation(bytes)).toThrow(message);
    }
  });

  it('rejects truncated and padded encodings', () => {
    const a = new FugueText({ replicaId: 'a' });
    const bytes = encodeOperation(a.insert(0, 'hello') as Operation);
    for (let length = 0; length < bytes.length; length++) {
      expect(codeOf(() => decodeOperation(bytes.subarray(0, length)))).toBe('invalid-operation');
    }
    expect(codeOf(() => decodeOperation(Uint8Array.from([...bytes, 0])))).toBe('invalid-operation');
  });
});
