/**
 * Low-level binary primitives shared by the state and operation codecs: unsigned LEB128 varints,
 * zigzag-encoded signed varints and length-prefixed strings.
 *
 * Strings are encoded as WTF-8 (https://simonsapin.github.io/wtf-8/): identical to UTF-8 for
 * well-formed strings, but able to represent lone UTF-16 surrogates, which JavaScript strings may
 * contain (for example after deleting half of a surrogate pair). That keeps every round trip
 * lossless.
 */

import { utf8Encoder, utf8StrictDecoder } from '../internal/platform.js';

/** Called with a description when input is malformed; must throw. */
export type FailFn = (message: string) => never;

/** An append-only byte buffer. */
export class ByteWriter {
  #buffer = new Uint8Array(256);
  #length = 0;

  /** Appends one byte. */
  byte(value: number): void {
    this.#reserve(1);
    this.#buffer[this.#length++] = value;
  }

  /** Appends a non-negative safe integer as an unsigned LEB128 varint (1 to 8 bytes). */
  uint(value: number): void {
    this.#reserve(8);
    let rest = value;
    while (rest >= 0x80) {
      this.#buffer[this.#length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    this.#buffer[this.#length++] = rest;
  }

  /** Appends a safe integer using zigzag encoding (small magnitudes stay small). */
  int(value: number): void {
    this.uint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  /** Appends raw bytes. */
  bytes(value: Uint8Array): void {
    this.#reserve(value.length);
    this.#buffer.set(value, this.#length);
    this.#length += value.length;
  }

  /** Appends a string as a varint byte length followed by its WTF-8 bytes. */
  string(value: string): void {
    const encoded = encodeWtf8(value);
    this.uint(encoded.length);
    this.bytes(encoded);
  }

  /** Returns a copy of everything written so far. */
  finish(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#buffer.length) return;
    const grown = new Uint8Array(Math.max(needed, this.#buffer.length * 2));
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
  }
}

/** A bounds-checked cursor over bytes produced by {@link ByteWriter}. */
export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #fail: FailFn;
  #position = 0;

  /**
   * @param bytes - The input.
   * @param fail - Throws the caller's error type for malformed input.
   */
  constructor(bytes: Uint8Array, fail: FailFn) {
    this.#bytes = bytes;
    this.#fail = fail;
  }

  /** Whether all input was consumed. */
  get done(): boolean {
    return this.#position === this.#bytes.length;
  }

  /** Reads one byte. */
  byte(): number {
    const value = this.#bytes[this.#position];
    if (value === undefined) this.#fail('unexpected end of input');
    this.#position++;
    return value;
  }

  /** Reads an unsigned varint; rejects overlong encodings and values above 2^53 - 1. */
  uint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; ; i++) {
      const byte = this.byte();
      if (i === 7 && byte > 0x0f) this.#fail('varint exceeds 2^53 - 1');
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (byte === 0 && i > 0) this.#fail('overlong varint');
        return value;
      }
      scale *= 0x80;
    }
  }

  /** Reads a zigzag-encoded signed varint. */
  int(): number {
    const value = this.uint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  /** Reads `length` raw bytes (a view, not a copy). */
  bytes(length: number): Uint8Array {
    if (length > this.#bytes.length - this.#position) this.#fail('unexpected end of input');
    const view = this.#bytes.subarray(this.#position, this.#position + length);
    this.#position += length;
    return view;
  }

  /** Reads a length-prefixed WTF-8 string. */
  string(): string {
    return decodeWtf8(this.bytes(this.uint()), this.#fail);
  }

  /** Fails unless all input was consumed. */
  end(): void {
    if (!this.done) this.#fail('trailing bytes after the end of the data');
  }
}

/** Encodes a string as WTF-8. */
export function encodeWtf8(value: string): Uint8Array {
  if (value.isWellFormed()) return utf8Encoder.encode(value);
  const out = new Uint8Array(value.length * 3);
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out[n++] = code;
    } else if (code < 0x800) {
      out[n++] = 0xc0 | (code >> 6);
      out[n++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[n++] = 0xe0 | (code >> 12);
      out[n++] = 0x80 | ((code >> 6) & 0x3f);
      out[n++] = 0x80 | (code & 0x3f);
    } else {
      out[n++] = 0xf0 | (code >> 18);
      out[n++] = 0x80 | ((code >> 12) & 0x3f);
      out[n++] = 0x80 | ((code >> 6) & 0x3f);
      out[n++] = 0x80 | (code & 0x3f);
    }
  }
  return out.slice(0, n);
}

/**
 * Decodes WTF-8. Fast path: strict UTF-8 via the platform decoder. Slow path, only when the input
 * contains encoded lone surrogates: a strict WTF-8 parser that rejects overlong forms, values
 * above U+10FFFF and surrogate pairs encoded as two separate three-byte sequences.
 */
export function decodeWtf8(bytes: Uint8Array, fail: FailFn): string {
  // Short strings (replica IDs, keystrokes) are usually ASCII; decoding them by hand avoids the
  // platform decoder's per-call overhead, which dominates at this size.
  if (bytes.length <= 32) {
    const ascii = decodeAscii(bytes);
    if (ascii !== undefined) return ascii;
  }
  try {
    return utf8StrictDecoder.decode(bytes);
  } catch {
    return decodeGeneralised(bytes, fail);
  }
}

function decodeAscii(bytes: Uint8Array): string | undefined {
  let result = '';
  for (const byte of bytes) {
    if (byte >= 0x80) return undefined;
    result += String.fromCharCode(byte);
  }
  return result;
}

function decodeGeneralised(bytes: Uint8Array, fail: FailFn): string {
  const units: number[] = [];
  let previousWasHighSurrogate = false;
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++] as number;
    let code: number;
    let min: number;
    let extra: number;
    if (first < 0x80) {
      code = first;
      min = 0;
      extra = 0;
    } else if (first >= 0xc2 && first < 0xe0) {
      code = first & 0x1f;
      min = 0x80;
      extra = 1;
    } else if (first >= 0xe0 && first < 0xf0) {
      code = first & 0x0f;
      min = 0x800;
      extra = 2;
    } else if (first >= 0xf0 && first < 0xf5) {
      code = first & 0x07;
      min = 0x10000;
      extra = 3;
    } else {
      fail('invalid WTF-8 lead byte');
    }
    for (let k = 0; k < extra; k++) {
      const next = bytes[i++];
      if (next === undefined || (next & 0xc0) !== 0x80) fail('truncated WTF-8 sequence');
      code = code * 64 + (next & 0x3f);
    }
    if (code < min || code > 0x10ffff) fail('invalid WTF-8 code point');
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isLow && previousWasHighSurrogate) fail('surrogate pair encoded as two sequences');
    previousWasHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (code >= 0x10000) {
      code -= 0x10000;
      units.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      units.push(code);
    }
  }
  let result = '';
  for (let i = 0; i < units.length; i += 4096) {
    result += String.fromCharCode(...units.slice(i, i + 4096));
  }
  return result;
}
