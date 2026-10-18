/**
 * Wire format shared by the relay and its clients: one binary WebSocket message per frame, whose
 * first byte says what follows.
 */

/** A full document state (`text.save()`), sent by the relay to every client that connects. */
export const STATE = 0x01;
/** One encoded operation (`encodeOperation`). */
export const OPERATION = 0x02;

/** Prefixes a payload with its frame type. */
export function frame(
  type: typeof STATE | typeof OPERATION,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/** Splits a frame into its type and payload. */
export function unframe(data: Uint8Array): { type: number; payload: Uint8Array } {
  return { type: data[0] ?? -1, payload: data.subarray(1) };
}
