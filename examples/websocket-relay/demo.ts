/**
 * End-to-end demo: starts a relay on a free local port, connects two clients that type
 * concurrently, connects a third client late, and checks that all of them converge.
 *
 * Run with `npm run example:relay`. Exits non-zero if the replicas disagree or time out.
 */

import { connect } from './client.js';
import { startRelay } from './relay.js';

const TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const relay = await startRelay(0);
  const url = `ws://127.0.0.1:${String(relay.port)}`;
  const alice = await connect(url, 'alice');
  const bob = await connect(url, 'bob');

  // Both type at the same spot without waiting for each other: the words must not interleave.
  const greeting = 'Hello from Alice. ';
  const note = 'Bob was here. ';
  for (let i = 0; i < greeting.length; i++) alice.insert(i, greeting.charAt(i));
  for (let i = 0; i < note.length; i++) bob.insert(i, note.charAt(i));
  await Promise.all([alice.waitFor(bob.doc.version), bob.waitFor(alice.doc.version)]);

  alice.delete(0, 6); // "Hello "
  bob.insert(bob.doc.length, '(edited)');
  await Promise.all([alice.waitFor(bob.doc.version), bob.waitFor(alice.doc.version)]);

  // A late joiner receives the relay's state in one message.
  const carol = await connect(url, 'carol');
  await carol.waitFor(alice.doc.version);

  const texts = [alice, bob, carol].map((client) => client.doc.toString());
  console.log(`relay on ${url}`);
  for (const [name, text] of [
    ['alice', texts[0]],
    ['bob', texts[1]],
    ['carol', texts[2]],
  ] as const) {
    console.log(`${name.padEnd(5)}: ${JSON.stringify(text)}`);
  }
  for (const client of [alice, bob, carol]) client.close();
  await relay.close();
  if (new Set(texts).size !== 1) throw new Error('replicas diverged');
  console.log('all replicas converged');
}

const timer = setTimeout(() => {
  console.error(`timed out after ${String(TIMEOUT_MS)} ms`);
  process.exit(1);
}, TIMEOUT_MS);
await main();
clearTimeout(timer);
