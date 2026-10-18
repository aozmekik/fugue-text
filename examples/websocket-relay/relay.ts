/**
 * A tiny WebSocket relay for fugue-text.
 *
 * The relay forwards every new operation it receives to all other connected clients. It also
 * keeps its own replica of the document, so a client that connects late gets the current state in
 * one message and then only needs live operations. The relay never edits, so it never creates
 * operations of its own.
 *
 * The relay keeps its document in memory only. If it restarts, clients reconnect with their
 * documents and send their states (see protocol.ts), and the new relay rebuilds the document
 * from them.
 *
 * Run it standalone with `npx tsx examples/websocket-relay/relay.ts` (PORT defaults to 8080).
 */

import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
// In your own project: import { ... } from 'fugue-text';
import { decodeOperation, FugueText, FugueTextError } from '../../src/index.js';
import type { VersionVector } from '../../src/index.js';
import { frame, OPERATION, STATE, unframe } from './protocol.js';

/** A running relay. */
export interface Relay {
  /** The TCP port it listens on. */
  readonly port: number;
  /** The relay's own replica of the document. */
  readonly doc: FugueText;
  /** Disconnects every client and stops listening. */
  close(): Promise<void>;
}

/** Whether `after` has an entry greater than in `before`. */
function grew(before: VersionVector, after: VersionVector): boolean {
  return Object.entries(after).some(([replica, counter]) => counter > (before[replica] ?? 0));
}

/** Starts a relay on `port` (0 picks a free port), listening on 127.0.0.1 only. */
export async function startRelay(port = 0): Promise<Relay> {
  const doc = new FugueText({
    // Every client checks what it applies too, so this only explains a discarded operation.
    onReject: (error, op) => {
      console.warn(
        `relay: discarded buffered operation ${op.replica}:${String(op.counter)}`,
        error,
      );
    },
  });
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const broadcast = (from: WebSocket, data: Buffer): void => {
    for (const client of server.clients) {
      if (client !== from && client.readyState === client.OPEN) client.send(data);
    }
  };

  server.on('connection', (socket: WebSocket) => {
    socket.send(frame(STATE, doc.save()));
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const { type, payload } = unframe(new Uint8Array(data));
      if (!isBinary || (type !== OPERATION && type !== STATE)) {
        socket.close(1003, 'expected a binary operation or state frame');
        return;
      }
      try {
        if (type === STATE) {
          const before = doc.version;
          doc.merge(payload);
          if (grew(before, doc.version)) broadcast(socket, data);
        } else if (doc.apply(decodeOperation(payload)) !== 'duplicate') {
          // A buffered operation is forwarded before the relay can check it against the
          // document, because its dependencies have not arrived yet. Clients buffer and check it
          // the same way, and discard it if it turns out to be invalid.
          broadcast(socket, data);
        }
      } catch (error) {
        // Never forward input the relay rejected.
        if (!(error instanceof FugueTextError)) throw error;
        socket.close(1007, error.message.slice(0, 100));
      }
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('unexpected address');
  return {
    port: address.port,
    doc,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of server.clients) client.terminate();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const relay = await startRelay(Number(process.env['PORT'] ?? 8080));
  console.log(`fugue-text relay listening on ws://127.0.0.1:${String(relay.port)}`);
}
