/**
 * The handful of web-platform globals the library uses, typed minimally so that the library
 * compiles without DOM or Node type definitions. All of them exist in Node.js >= 22, Deno, Bun and
 * every current browser.
 */

interface Utf8Encoder {
  encode(input: string): Uint8Array;
}

interface Utf8Decoder {
  decode(input: Uint8Array): string;
}

interface PlatformGlobals {
  readonly TextEncoder: new () => Utf8Encoder;
  readonly TextDecoder: new (
    label: 'utf-8',
    options: { fatal: boolean; ignoreBOM: boolean },
  ) => Utf8Decoder;
  readonly crypto?: { getRandomValues<T extends Uint8Array>(array: T): T };
  readonly queueMicrotask: (callback: () => void) => void;
}

const platform = globalThis as unknown as PlatformGlobals;

/** Shared UTF-8 encoder. */
export const utf8Encoder: Utf8Encoder = new platform.TextEncoder();

/**
 * Shared strict UTF-8 decoder: throws on malformed input instead of inserting U+FFFD, and keeps a
 * leading U+FEFF (byte order mark) as content instead of stripping it.
 */
export const utf8StrictDecoder: Utf8Decoder = new platform.TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

/** Returns `length` cryptographically strong random bytes. */
export function randomBytes(length: number): Uint8Array {
  const crypto = platform.crypto;
  if (crypto === undefined) {
    throw new Error(
      'globalThis.crypto.getRandomValues is unavailable; pass an explicit replicaId instead',
    );
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Reports an error without interrupting the caller, like an uncaught exception in a callback. */
export function reportError(error: unknown): void {
  platform.queueMicrotask(() => {
    throw error;
  });
}
