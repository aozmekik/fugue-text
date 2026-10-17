/**
 * Machine-readable reason for a {@link FugueTextError}:
 * - `invalid-operation`: an operation is malformed or inconsistent with this document;
 * - `invalid-state`: an encoded state (binary or JSON) is malformed or inconsistent;
 * - `replica-conflict`: input claims to come from this instance's own replica ID but was not
 *   produced by it, which means the ID is in use elsewhere.
 */
export type FugueTextErrorCode = 'invalid-operation' | 'invalid-state' | 'replica-conflict';

/**
 * Thrown when input received from another replica (an operation or an encoded state) cannot be
 * accepted. The document is left unchanged by the rejected operation. Programming errors such as
 * an out-of-range index throw the built-in `RangeError` or `TypeError` instead.
 */
export class FugueTextError extends Error {
  /** Why the input was rejected. */
  readonly code: FugueTextErrorCode;

  /**
   * @param code - Why the input was rejected.
   * @param message - Human-readable details.
   */
  constructor(code: FugueTextErrorCode, message: string) {
    super(message);
    this.name = 'FugueTextError';
    this.code = code;
  }
}

/** @internal Shorthand for throwing an `invalid-operation` error. */
export function invalidOperation(message: string): never {
  throw new FugueTextError('invalid-operation', message);
}

/** @internal Shorthand for throwing an `invalid-state` error. */
export function invalidState(message: string): never {
  throw new FugueTextError('invalid-state', message);
}
