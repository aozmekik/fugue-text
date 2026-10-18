/**
 * End-to-end demo: starts a relay on a free local port and connects two clients that type
 * concurrently. One client then goes offline, edits, and reconnects. The relay restarts and the
 * clients rebuild its document. Finally a third client connects late. All replicas must converge.
 *
 * Run with `npm run example:relay`. Exits non-zero if the replicas disagree or time out.
 */

import { FugueText } from '../../src/index.js';
import { connect } from './client.js';
import { startRelay } from './relay.js';

const TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  let relay = await startRelay(0);
  let url = `ws://127.0.0.1:${String(relay.port)}`;
  let alice = await connect(url, new FugueText({ replicaId: 'alice' }));
  let bob = await connect(url, new FugueText({ replicaId: 'bob' }));

  // Both type at the same spot without waiting for each other: the words must not interleave.
  const greeting = 'Hello from Alice. ';
  const note = 'Bob was here. ';
  for (let i = 0; i < greeting.length; i++) alice.insert(i, greeting.charAt(i));
  for (let i = 0; i < note.length; i++) bob.insert(i, note.charAt(i));
  await Promise.all([alice.waitFor(bob.doc.version), bob.waitFor(alice.doc.version)]);
  console.log(`relay on ${url}`);
  console.log(`after concurrent typing: ${JSON.stringify(alice.doc.toString())}`);

  // Alice goes offline and keeps editing; reconnecting sends her edits along with her state.
  alice.close();
  alice.delete(0, 6); // "Hello "
  bob.insert(bob.doc.length, '(edited)');
  alice = await connect(url, alice.doc);
  await Promise.all([alice.waitFor(bob.doc.version), bob.waitFor(alice.doc.version)]);
  console.log(`after an offline edit:   ${JSON.stringify(alice.doc.toString())}`);

  // The relay restarts with an empty document; the clients' states rebuild it.
  await relay.close();
  relay = await startRelay(0);
  url = `ws://127.0.0.1:${String(relay.port)}`;
  [alice, bob] = await Promise.all([connect(url, alice.doc), connect(url, bob.doc)]);
  // A late joiner receives the new relay's state in one message.
  const carol = await connect(url, new FugueText({ replicaId: 'carol' }));
  await carol.waitFor(alice.doc.version);
  await carol.waitFor(bob.doc.version);

  const texts = [alice, bob, carol].map((client) => client.doc.toString());
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
