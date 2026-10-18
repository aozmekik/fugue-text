/**
 * Wire format shared by the relay and its clients: one binary WebSocket message per frame, whose
 * first byte says what follows.
 *
 * Both sides start with a STATE frame. The relay sends its state to every client that connects,
 * and each client sends its own state to the relay. The client thereby passes on whatever the
 * relay lacks: edits made while offline, or everything after the relay restarted. The relay
 * forwards a client state that taught it something to the other clients. After that, both sides
 * exchange OPERATION frames.
 */

/** A full document state (`doc.save()`). */
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
