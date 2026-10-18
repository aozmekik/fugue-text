/**
 * A tiny WebSocket relay for fugue-text.
 *
 * The relay forwards every operation it receives to all other connected clients. It also keeps
 * its own replica of the document, so a client that connects late gets the current state in one
 * message and then only needs live operations. The relay never edits, so it never creates
 * operations; if it restarts, clients can simply reconnect and merge states.
 *
 * Run it standalone with `npx tsx examples/websocket-relay/relay.ts` (PORT defaults to 8080).
 */

import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
// In your own project: import { ... } from 'fugue-text';
import { decodeOperation, FugueTextError, FugueText } from '../../src/index.js';
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

/** Starts a relay on `port` (0 picks a free port). */
export async function startRelay(port = 0): Promise<Relay> {
  const doc = new FugueText({ replicaId: 'relay' });
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  server.on('connection', (socket: WebSocket) => {
    socket.send(frame(STATE, doc.save()));
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const { type, payload } = unframe(new Uint8Array(data));
      if (!isBinary || type !== OPERATION) {
        socket.close(1003, 'expected a binary operation frame');
        return;
      }
      try {
        doc.apply(decodeOperation(payload));
      } catch (error) {
        // Never forward input the relay could not accept.
        if (!(error instanceof FugueTextError)) throw error;
        socket.close(1007, error.message.slice(0, 100));
        return;
      }
      for (const client of server.clients) {
        if (client !== socket && client.readyState === client.OPEN) client.send(data);
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
