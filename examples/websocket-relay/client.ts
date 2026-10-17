/**
 * A minimal fugue-text client for the relay, using the WebSocket client built into Node.js 22+
 * (and every browser).
 */

// In your own project: import { ... } from 'fugue-text';
import { decodeOperation, encodeOperation, Text } from '../../src/index.js';
import type { Operation } from '../../src/index.js';
import { frame, OPERATION, STATE, unframe } from './protocol.js';

/** A connected replica. */
export interface Client {
  /** The local replica. */
  readonly doc: Text;
  /** Inserts locally and sends the operation. */
  insert(index: number, text: string): void;
  /** Deletes locally and sends the operation. */
  delete(index: number, length: number): void;
  /** Resolves once the replica's version covers `version` (e.g. another client's). */
  waitFor(version: Readonly<Record<string, number>>): Promise<void>;
  /** Closes the connection. */
  close(): void;
}

/** Connects to a relay and resolves once the initial state has been received. */
export async function connect(url: string, replicaId?: string): Promise<Client> {
  const doc = new Text(replicaId === undefined ? {} : { replicaId });
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const waiters = new Set<() => void>();

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('error', () => {
      reject(new Error(`cannot connect to ${url}`));
    });
    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      const { type, payload } = unframe(new Uint8Array(event.data));
      if (type === STATE) {
        doc.merge(payload);
        resolve();
      } else if (type === OPERATION) {
        doc.apply(decodeOperation(payload));
      }
      for (const check of [...waiters]) check();
    });
  });
  await ready;

  const send = (op: Operation | undefined): void => {
    if (op !== undefined) socket.send(frame(OPERATION, encodeOperation(op)));
  };
  const covers = (version: Readonly<Record<string, number>>): boolean =>
    Object.entries(version).every(([replica, counter]) => (doc.version[replica] ?? 0) >= counter);

  return {
    doc,
    insert: (index, text) => {
      send(doc.insert(index, text));
    },
    delete: (index, length) => {
      send(doc.delete(index, length));
    },
    waitFor: (version) =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (!covers(version)) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      }),
    close: () => {
      socket.close();
    },
  };
}
