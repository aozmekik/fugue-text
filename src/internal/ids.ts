import { randomBytes } from './platform.js';

const REPLICA_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;
const RANDOM_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const RANDOM_ID_LENGTH = 12;

/** Returns whether `value` is a well-formed replica ID (1 to 64 printable ASCII characters). */
export function isReplicaId(value: unknown): value is string {
  return typeof value === 'string' && REPLICA_ID_PATTERN.test(value);
}

/** Generates a random 12-character replica ID (60 bits of entropy). */
export function randomReplicaId(): string {
  const bytes = randomBytes(RANDOM_ID_LENGTH);
  let id = '';
  for (const byte of bytes) id += RANDOM_ID_ALPHABET.charAt(byte & 31);
  return id;
}

/**
 * Total order on element IDs used to sort same-side siblings in the Fugue tree: by replica ID
 * (UTF-16 code unit order, which equals byte order for ASCII IDs), then by counter.
 */
export function compareIds(
  replicaA: string,
  counterA: number,
  replicaB: string,
  counterB: number,
): number {
  if (replicaA !== replicaB) return replicaA < replicaB ? -1 : 1;
  return counterA - counterB;
}

/** Returns whether `value` is a non-negative safe integer. */
export function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
