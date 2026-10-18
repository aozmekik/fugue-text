/**
 * A minimal fugue-text client for the relay, using the WebSocket client built into Node.js 22+
 * (and every browser).
 */

// In your own project: import { ... } from 'fugue-text';
import { decodeOperation, encodeOperation, FugueText } from '../../src/index.js';
import type { Operation, VersionVector } from '../../src/index.js';
import { frame, OPERATION, STATE, unframe } from './protocol.js';

/** A connected replica. */
export interface Client {
  /** The local replica. */
  readonly doc: FugueText;
  /** Inserts locally and sends the operation (if still connected). */
  insert(index: number, text: string): void;
  /** Deletes locally and sends the operation (if still connected). */
  delete(index: number, length: number): void;
  /** Resolves once the replica's version covers `version` (e.g. another client's). */
  waitFor(version: VersionVector): Promise<void>;
  /** Closes the connection. The document stays usable; pass it to `connect` to reconnect. */
  close(): void;
}

/**
 * Connects `doc` (by default a new, empty replica with a random ID) to a relay. Resolves once the
 * relay's state has been merged, and rejects if the connection fails or the relay's state cannot
 * be merged. To reconnect, pass the same document again: it keeps its own history, so edits made
 * while disconnected reach the others through the state exchange. A new document must not reuse
 * the ID of a replica that has already edited. If it does, the relay's state contains operations
 * of that ID and the merge fails with `replica-conflict`.
 */
export async function connect(url: string, doc: FugueText = new FugueText()): Promise<Client> {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const waiters = new Set<() => void>();
  let settled = false; // whether the promise below has resolved or rejected

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) console.error('fugue-text client: closing the connection:', error);
      else reject(error instanceof Error ? error : new Error(String(error)));
      settled = true;
      socket.close();
    };
    socket.addEventListener('open', () => {
      socket.send(frame(STATE, doc.save()));
    });
    socket.addEventListener('error', () => {
      fail(new Error(`cannot connect to ${url}`));
    });
    socket.addEventListener('close', () => {
      if (!settled) fail(new Error('the relay closed the connection before sending its state'));
    });
    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      const { type, payload } = unframe(new Uint8Array(event.data));
      try {
        if (type === STATE) doc.merge(payload);
        else if (type === OPERATION) doc.apply(decodeOperation(payload));
        else throw new Error(`unknown frame type ${String(type)}`);
      } catch (error) {
        // For example, a relay state with operations of this replica's ID that `doc` lacks.
        fail(error);
        return;
      }
      if (!settled && type === STATE) {
        settled = true;
        resolve();
      }
      for (const check of [...waiters]) check();
    });
  });

  const send = (op: Operation | undefined): void => {
    // While disconnected, edits only change the document; the next connect() sends them along
    // with the document's state.
    if (op !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(frame(OPERATION, encodeOperation(op)));
    }
  };
  const covers = (version: VersionVector): boolean =>
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
